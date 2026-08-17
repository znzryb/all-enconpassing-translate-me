import { initCache, cacheGet, cacheSet } from '../src/core/cache';
import {
  SegmentMismatchError, TranslateError, translateBatch, type TranslateOptions,
} from '../src/core/llm';
import { activeProvider, loadSettings } from '../src/core/settings';
import type { Message, TranslateResponse } from '../src/shared/messages';

export default defineBackground(() => {
  void initCache();

  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    if (message.type === 'translate') {
      handleTranslate(message.job).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: errorText(err) } satisfies TranslateResponse),
      );
      return true; // response is async
    }
    if (message.type === 'test-connection') {
      testConnection().then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: errorText(err) }),
      );
      return true;
    }
    if (message.type === 'open-options') {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  chrome.commands.onCommand.addListener(async (command) => {
    const tabId = (await activeTab())?.id;
    if (tabId == null) return;
    const type = command === 'toggle-translate' ? 'toggle-translate' : 'cycle-state';
    await chrome.tabs.sendMessage(tabId, { type } satisfies Message).catch(() => {});
  });

  chrome.runtime.onInstalled.addListener(async () => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'aetm-translate-page',
        title: 'Translate this page',
        contexts: ['page', 'selection'],
      });
      chrome.contextMenus.create({
        id: 'aetm-options',
        title: 'Translation settings…',
        contexts: ['action'],
      });
    });

    // A fresh install is useless without a key, so go straight to options.
    const settings = await loadSettings();
    if (!activeProvider(settings).apiKey) chrome.runtime.openOptionsPage();
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'aetm-options') {
      chrome.runtime.openOptionsPage();
      return;
    }
    if (info.menuItemId === 'aetm-translate-page' && tab?.id != null) {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-translate' } satisfies Message).catch(() => {});
    }
  });
});

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Resolves a batch: cache first, model for the remainder. When the model
 * breaks the `%%` segment contract the batch is retried one paragraph at a
 * time — slower, but it always terminates and never misaligns a translation
 * onto the wrong paragraph, which is the one failure a reader would notice.
 */
async function handleTranslate(job: {
  texts: string[];
  targetLang: string;
  title?: string;
  subtitle?: boolean;
}): Promise<TranslateResponse> {
  const settings = await loadSettings();
  const provider = activeProvider(settings);
  if (!provider.apiKey) return { ok: false, error: 'No API key configured' };

  const opts: TranslateOptions = {
    provider,
    targetLang: job.targetLang,
    subtitle: job.subtitle,
    context: { title: job.title, extra: settings.extraPrompt },
  };

  const results: (string | undefined)[] = new Array(job.texts.length).fill(undefined);
  const pending: number[] = [];

  for (let i = 0; i < job.texts.length; i++) {
    const text = job.texts[i]!;
    const hit = settings.cacheEnabled ? cacheGet(text, job.targetLang, provider.model) : undefined;
    if (hit !== undefined) results[i] = hit;
    else pending.push(i);
  }

  if (pending.length) {
    const inputs = pending.map((i) => job.texts[i]!);
    let translations: string[];
    try {
      translations = await translateBatch(inputs, opts);
    } catch (err) {
      if (!(err instanceof SegmentMismatchError)) {
        return { ok: false, error: errorText(err) };
      }
      const settled = await Promise.allSettled(
        inputs.map((text) => translateBatch([text], opts).then((r) => r[0] ?? text)),
      );
      if (settled.every((r) => r.status === 'rejected')) {
        const first = settled[0];
        return {
          ok: false,
          mismatch: true,
          error: first?.status === 'rejected' ? errorText(first.reason) : 'Translation failed',
        };
      }
      translations = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : inputs[i]!));
    }

    for (let k = 0; k < pending.length; k++) {
      const index = pending[k]!;
      const value = translations[k];
      if (value === undefined) continue;
      results[index] = value;
      if (settings.cacheEnabled) cacheSet(job.texts[index]!, job.targetLang, provider.model, value);
    }
  }

  return { ok: true, translations: results.map((r, i) => r ?? job.texts[i]!) };
}

async function testConnection(): Promise<{ ok: boolean; error?: string; sample?: string }> {
  const settings = await loadSettings();
  try {
    const [out] = await translateBatch(['Hello, world!'], {
      provider: activeProvider(settings),
      targetLang: settings.targetLang,
      context: { extra: settings.extraPrompt },
    });
    return { ok: true, sample: out };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

function errorText(err: unknown): string {
  if (err instanceof TranslateError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
