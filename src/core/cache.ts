/**
 * Persistent translation cache.
 *
 * Revisiting a page — or scrolling back up — should cost nothing, so results
 * are keyed by (source text, target language, model) and kept in
 * `chrome.storage.local`. Writes are batched on an idle timer because storage
 * round-trips are far more expensive than the map lookup they back.
 *
 * `scope` narrows that key when the translation depends on context the source
 * text does not carry. Subtitles need it: a line as thin as "okay so" is
 * translated against the video's title, so a cache shared across videos would
 * replay one video's wording over another's. Prose passes no scope and keeps
 * sharing entries across pages.
 */

const PREFIX = 'aetm:tr:';
const MAX_ENTRIES = 8000;
const FLUSH_DELAY_MS = 2000;

interface Entry {
  v: string;
  /** Last-access time, used to decide what to evict. */
  t: number;
}

const memory = new Map<string, Entry>();
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let loaded = false;

/** FNV-1a: short, stable, and collision-safe enough for a local cache key. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function keyFor(text: string, lang: string, model: string, scope = ''): string {
  // NUL cannot occur in any of the parts, so it separates them unambiguously.
  // An empty scope reproduces the pre-scope key exactly, keeping old entries.
  const salt = scope ? `${model}\u0000${scope}` : model;
  return `${PREFIX}${lang}:${hash(`${salt}\u0000${text}`)}`;
}

export async function initCache(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(PREFIX) && v && typeof (v as Entry).v === 'string') {
      memory.set(k, v as Entry);
    }
  }
  await evictIfNeeded();
}

export function cacheGet(
  text: string,
  lang: string,
  model: string,
  scope = '',
): string | undefined {
  const key = keyFor(text, lang, model, scope);
  const hit = memory.get(key);
  if (!hit) return undefined;
  hit.t = Date.now();
  dirty.add(key);
  scheduleFlush();
  return hit.v;
}

export function cacheSet(
  text: string,
  lang: string,
  model: string,
  translation: string,
  scope = '',
): void {
  const key = keyFor(text, lang, model, scope);
  memory.set(key, { v: translation, t: Date.now() });
  dirty.add(key);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  if (!dirty.size) return;
  const patch: Record<string, Entry> = {};
  for (const key of dirty) {
    const entry = memory.get(key);
    if (entry) patch[key] = entry;
  }
  dirty.clear();
  try {
    await chrome.storage.local.set(patch);
    await evictIfNeeded();
  } catch {
    // Quota exhausted or the context went away: drop the oldest half and let
    // the next write try again rather than failing a translation over it.
    await evictIfNeeded(true);
  }
}

async function evictIfNeeded(force = false): Promise<void> {
  if (!force && memory.size <= MAX_ENTRIES) return;
  const sorted = [...memory.entries()].sort((a, b) => a[1].t - b[1].t);
  const target = force ? Math.floor(memory.size / 2) : memory.size - MAX_ENTRIES;
  const doomed = sorted.slice(0, Math.max(0, target)).map(([k]) => k);
  if (!doomed.length) return;
  for (const k of doomed) memory.delete(k);
  await chrome.storage.local.remove(doomed);
}

export async function clearCache(): Promise<void> {
  const keys = [...memory.keys()];
  memory.clear();
  dirty.clear();
  if (keys.length) await chrome.storage.local.remove(keys);
}

export function cacheSize(): number {
  return memory.size;
}

/**
 * Scripts distinctive enough that their absence in a translation proves the
 * translation never happened. Latin-script targets are deliberately absent:
 * a Spanish source echoed as a French "translation" is indistinguishable by
 * script, so entries for those languages are left alone rather than guessed at.
 */
const TARGET_SCRIPT: Record<string, RegExp> = {
  zh: /[\u4e00-\u9fff\u3400-\u4dbf]/,
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  ru: /[\u0400-\u04ff]/,
  ar: /[\u0600-\u06ff]/,
  th: /[\u0e00-\u0e7f]/,
  he: /[\u0590-\u05ff]/,
  hi: /[\u0900-\u097f]/,
};

/**
 * Drops entries that hold a source echoed back as its own translation.
 *
 * Failed requests used to be stored as the untranslated source, which is
 * indistinguishable from a real result once written — the entry only holds the
 * translation, never the input — so those lines stayed untranslated forever.
 * The test is deliberately blunt: not one character of the target script. A
 * proportional test would delete good work, since a technical translation runs
 * heavy on Latin identifiers ("Recovery()", "Panic") around its Chinese.
 *
 * Each entry is judged against the language in its own key, so a cache holding
 * several target languages prunes correctly.
 */
export async function pruneEchoedSources(): Promise<number> {
  const doomed: string[] = [];
  for (const [key, entry] of memory) {
    const lang = key.slice(PREFIX.length).split(':')[0];
    const script = lang ? TARGET_SCRIPT[lang.split('-')[0]!] : undefined;
    if (!script) continue;
    if (!script.test(entry.v)) doomed.push(key);
  }
  if (!doomed.length) return 0;
  for (const key of doomed) {
    memory.delete(key);
    dirty.delete(key);
  }
  await chrome.storage.local.remove(doomed);
  return doomed.length;
}
