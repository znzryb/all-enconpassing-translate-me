/** User settings: shape, defaults, and storage access. */

export type ProviderId = 'deepseek' | 'openai' | 'custom';

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ThemeId = 'dividingLine' | 'plain' | 'dashedBorder' | 'marker' | 'weakened';

export interface Settings {
  provider: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  targetLang: string;
  /** Skip a paragraph when it already reads as the target language. */
  skipSameLanguage: boolean;
  theme: ThemeId;
  /** Paragraphs bundled into a single chat completion. */
  batchSize: number;
  /** In-flight requests per tab. */
  concurrency: number;
  /** Extra viewport heights pre-translated ahead of the scroll position. */
  lookaheadScreens: number;
  /** Appended to the system prompt — tone, glossary, house style. */
  extraPrompt: string;
  /** Hosts translated automatically on load. */
  autoTranslateHosts: string[];
  /** Hosts where the extension stays dormant. */
  blockedHosts: string[];
  subtitleEnabled: boolean;
  /** Persist translations so a revisit costs no tokens. */
  cacheEnabled: boolean;
}

/**
 * DeepSeek and OpenAI both speak the OpenAI chat-completions dialect, so a
 * single client covers all three entries — only baseUrl/model differ.
 */
export const PROVIDER_PRESETS: Record<ProviderId, { label: string; baseUrl: string; model: string; docs: string }> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    docs: 'https://platform.deepseek.com/api_keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    docs: 'https://platform.openai.com/api-keys',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: '',
    docs: '',
  },
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'deepseek',
  providers: {
    deepseek: { apiKey: '', ...pick('deepseek') },
    openai: { apiKey: '', ...pick('openai') },
    custom: { apiKey: '', ...pick('custom') },
  },
  targetLang: 'zh-CN',
  skipSameLanguage: true,
  theme: 'dividingLine',
  batchSize: 6,
  concurrency: 3,
  lookaheadScreens: 1.5,
  extraPrompt: '',
  autoTranslateHosts: [],
  blockedHosts: [],
  subtitleEnabled: true,
  cacheEnabled: true,
};

function pick(id: ProviderId): { baseUrl: string; model: string } {
  const preset = PROVIDER_PRESETS[id];
  return { baseUrl: preset.baseUrl, model: preset.model };
}

const STORAGE_KEY = 'aetm:settings';

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return mergeSettings(raw[STORAGE_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && STORAGE_KEY in changes) fn(mergeSettings(changes[STORAGE_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Deep-merges stored values over defaults so new fields appear after an upgrade. */
function mergeSettings(stored: unknown): Settings {
  if (!stored || typeof stored !== 'object') return structuredClone(DEFAULT_SETTINGS);
  const s = stored as Partial<Settings>;
  const providers = {} as Record<ProviderId, ProviderConfig>;
  for (const id of Object.keys(DEFAULT_SETTINGS.providers) as ProviderId[]) {
    providers[id] = { ...DEFAULT_SETTINGS.providers[id], ...(s.providers?.[id] ?? {}) };
  }
  return { ...DEFAULT_SETTINGS, ...s, providers };
}

export function activeProvider(s: Settings): ProviderConfig {
  return s.providers[s.provider];
}

export function isConfigured(s: Settings): boolean {
  const p = activeProvider(s);
  return Boolean(p.apiKey && p.baseUrl && p.model);
}

/** `*.example.com` matches subdomains; anything else is an exact host match. */
export function hostMatches(patterns: string[], host: string): boolean {
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) {
      const bare = p.slice(2);
      return host === bare || host.endsWith(`.${bare}`);
    }
    return host === p;
  });
}
