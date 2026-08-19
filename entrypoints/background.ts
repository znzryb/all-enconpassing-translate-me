import { initCache, pruneEchoedSources } from '../src/core/cache';
import { activeProvider, loadSettings } from '../src/core/settings';
import { errorText, handleTranslate, testConnection } from '../src/core/translate-job';
import type { Message, TranslateResponse } from '../src/shared/messages';

/**
 * Marks the one-off cleanup of pre-fix cache entries as done.
 *
 * Bumped when a new way of storing a non-translation is found, so the sweep
 * runs again: v2 clears the literal "<blank>" segments a model emitted to pad
 * a batch to the requested count.
 */
const PRUNE_FLAG = 'aetm:pruned:v2';

export default defineBackground(() => {
  void initCache().then(pruneStaleEchoes);

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

/**
 * Clears entries left behind by the version that cached failed translations as
 * their own source. Runs once per installation rather than on every startup,
 * since it walks the whole cache.
 */
async function pruneStaleEchoes(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(PRUNE_FLAG);
    if (stored[PRUNE_FLAG]) return;
    await pruneEchoedSources();
    await chrome.storage.local.set({ [PRUNE_FLAG]: true });
  } catch {
    // Storage unavailable: leave the flag unset so a later start retries.
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
