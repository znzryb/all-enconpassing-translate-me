import { clearCache } from '../../src/core/cache';
import { LANG_NAMES } from '../../src/core/llm';
import {
  PROVIDER_PRESETS, loadSettings, saveSettings,
  type ProviderId, type Settings, type ThemeId,
} from '../../src/core/settings';
import { sendToBackground } from '../../src/shared/messages';

/** Suggestions only — any model the endpoint accepts can be typed in. */
const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-4o-mini', 'gpt-5-mini'],
  custom: [],
};

const KEY_HINTS: Record<ProviderId, string> = {
  deepseek: 'Create one at platform.deepseek.com → API keys.',
  openai: 'Create one at platform.openai.com → API keys.',
  custom: 'Any endpoint that implements POST /chat/completions.',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  tabs: $<HTMLDivElement>('provider-tabs'),
  apiKey: $<HTMLInputElement>('api-key'),
  reveal: $<HTMLButtonElement>('reveal'),
  keyHint: $<HTMLElement>('key-hint'),
  baseUrl: $<HTMLInputElement>('base-url'),
  model: $<HTMLInputElement>('model'),
  suggestions: $<HTMLDataListElement>('model-suggestions'),
  test: $<HTMLButtonElement>('test'),
  testResult: $<HTMLSpanElement>('test-result'),
  lang: $<HTMLSelectElement>('lang'),
  theme: $<HTMLSelectElement>('theme'),
  skipSame: $<HTMLInputElement>('skip-same'),
  subtitles: $<HTMLInputElement>('subtitles'),
  extraPrompt: $<HTMLTextAreaElement>('extra-prompt'),
  autoHosts: $<HTMLTextAreaElement>('auto-hosts'),
  blockedHosts: $<HTMLTextAreaElement>('blocked-hosts'),
  batch: $<HTMLInputElement>('batch'),
  batchOut: $<HTMLOutputElement>('batch-out'),
  concurrency: $<HTMLInputElement>('concurrency'),
  concOut: $<HTMLOutputElement>('conc-out'),
  lookahead: $<HTMLInputElement>('lookahead'),
  lookOut: $<HTMLOutputElement>('look-out'),
  cache: $<HTMLInputElement>('cache'),
  clearCache: $<HTMLButtonElement>('clear-cache'),
  saved: $<HTMLSpanElement>('saved'),
};

let settings: Settings;
/** Which provider's credentials the form is currently editing. */
let editing: ProviderId;

void init();

async function init(): Promise<void> {
  settings = await loadSettings();
  editing = settings.provider;

  for (const [code, name] of Object.entries(LANG_NAMES)) {
    els.lang.append(new Option(name, code));
  }

  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.textContent = preset.label;
    button.dataset.id = id;
    button.addEventListener('click', () => void selectProvider(id as ProviderId));
    els.tabs.append(button);
  }

  fillForm();
  wire();
}

function fillForm(): void {
  const provider = settings.providers[editing];
  els.apiKey.value = provider.apiKey;
  els.baseUrl.value = provider.baseUrl;
  els.baseUrl.placeholder = PROVIDER_PRESETS[editing].baseUrl || 'https://…/v1';
  els.model.value = provider.model;
  els.model.placeholder = PROVIDER_PRESETS[editing].model || 'model-name';
  els.keyHint.textContent = KEY_HINTS[editing];

  els.suggestions.textContent = '';
  for (const model of MODEL_SUGGESTIONS[editing]) {
    els.suggestions.append(new Option(model));
  }

  for (const tab of els.tabs.querySelectorAll('button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.id === editing));
  }

  els.lang.value = settings.targetLang;
  els.theme.value = settings.theme;
  els.skipSame.checked = settings.skipSameLanguage;
  els.subtitles.checked = settings.subtitleEnabled;
  els.extraPrompt.value = settings.extraPrompt;
  els.autoHosts.value = settings.autoTranslateHosts.join('\n');
  els.blockedHosts.value = settings.blockedHosts.join('\n');
  els.batch.value = String(settings.batchSize);
  els.concurrency.value = String(settings.concurrency);
  els.lookahead.value = String(settings.lookaheadScreens);
  els.cache.checked = settings.cacheEnabled;
  renderRangeLabels();
}

function renderRangeLabels(): void {
  els.batchOut.textContent = els.batch.value;
  els.concOut.textContent = els.concurrency.value;
  els.lookOut.textContent = `${els.lookahead.value} screens`;
}

/**
 * Switching tabs also makes that provider the active one, so the tab strip
 * doubles as the engine picker rather than needing a separate control.
 */
async function selectProvider(id: ProviderId): Promise<void> {
  editing = id;
  await update({ provider: id });
  fillForm();
  els.testResult.textContent = '';
}

async function update(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  flashSaved();
}

async function updateProvider(patch: Partial<Settings['providers'][ProviderId]>): Promise<void> {
  await update({
    providers: {
      ...settings.providers,
      [editing]: { ...settings.providers[editing], ...patch },
    },
  });
}

function wire(): void {
  els.apiKey.addEventListener('change', () => void updateProvider({ apiKey: els.apiKey.value.trim() }));
  els.baseUrl.addEventListener('change', () =>
    void updateProvider({ baseUrl: els.baseUrl.value.trim().replace(/\/+$/, '') }),
  );
  els.model.addEventListener('change', () => void updateProvider({ model: els.model.value.trim() }));

  els.reveal.addEventListener('click', () => {
    const shown = els.apiKey.type === 'text';
    els.apiKey.type = shown ? 'password' : 'text';
    els.reveal.textContent = shown ? 'Show' : 'Hide';
  });

  els.test.addEventListener('click', async () => {
    els.test.disabled = true;
    els.testResult.className = '';
    els.testResult.textContent = 'Testing…';
    const res = await sendToBackground<{ ok: boolean; error?: string; sample?: string }>({
      type: 'test-connection',
    });
    els.test.disabled = false;
    if (res.ok) {
      els.testResult.className = 'ok';
      els.testResult.textContent = `Works — "Hello, world!" → "${res.sample}"`;
    } else {
      els.testResult.className = 'err';
      els.testResult.textContent = res.error ?? 'Failed';
    }
  });

  els.lang.addEventListener('change', () => void update({ targetLang: els.lang.value }));
  els.theme.addEventListener('change', () => void update({ theme: els.theme.value as ThemeId }));
  els.skipSame.addEventListener('change', () => void update({ skipSameLanguage: els.skipSame.checked }));
  els.subtitles.addEventListener('change', () => void update({ subtitleEnabled: els.subtitles.checked }));
  els.extraPrompt.addEventListener('change', () => void update({ extraPrompt: els.extraPrompt.value }));

  els.autoHosts.addEventListener('change', () =>
    void update({ autoTranslateHosts: parseHosts(els.autoHosts.value) }),
  );
  els.blockedHosts.addEventListener('change', () =>
    void update({ blockedHosts: parseHosts(els.blockedHosts.value) }),
  );

  for (const input of [els.batch, els.concurrency, els.lookahead]) {
    input.addEventListener('input', renderRangeLabels);
  }
  els.batch.addEventListener('change', () => void update({ batchSize: Number(els.batch.value) }));
  els.concurrency.addEventListener('change', () =>
    void update({ concurrency: Number(els.concurrency.value) }),
  );
  els.lookahead.addEventListener('change', () =>
    void update({ lookaheadScreens: Number(els.lookahead.value) }),
  );

  els.cache.addEventListener('change', () => void update({ cacheEnabled: els.cache.checked }));
  els.clearCache.addEventListener('click', async (event) => {
    event.preventDefault();
    await clearCache();
    els.saved.textContent = 'Cache cleared.';
    setTimeout(() => (els.saved.textContent = 'Changes save automatically.'), 2000);
  });
}

function parseHosts(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
}

let savedTimer: ReturnType<typeof setTimeout> | undefined;
function flashSaved(): void {
  els.saved.textContent = 'Saved.';
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (els.saved.textContent = 'Changes save automatically.'), 1500);
}
