/**
 * OpenAI-compatible chat-completions client and the batching protocol.
 *
 * DeepSeek, OpenAI, and most self-hosted gateways expose the same
 * `/chat/completions` shape, so one client covers every provider — only the
 * base URL and model name change.
 *
 * Batching: several paragraphs go out in one request separated by `%%`, and the
 * reply is split back on the same marker. Fewer, larger requests both cut
 * latency and give the model neighbouring paragraphs as context, which visibly
 * improves pronoun and terminology choices. The cost is a format contract the
 * model can break, so a segment-count mismatch is reported rather than guessed
 * at, letting the caller retry one paragraph at a time.
 */

import type { ProviderConfig } from './settings';

export const SEPARATOR = '\n\n%%\n\n';
const SPLIT_RE = /\n*\s*%%\s*\n*/;

export interface TranslateContext {
  title?: string;
  /** Free-form user instructions appended to the system prompt. */
  extra?: string;
}

export interface TranslateOptions {
  provider: ProviderConfig;
  targetLang: string;
  context?: TranslateContext;
  signal?: AbortSignal;
  /** Subtitles are short, spoken, and must not gain explanatory text. */
  subtitle?: boolean;
}

export class TranslateError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = 'TranslateError';
  }
}

/** Signals that the reply did not follow the `%%` contract. */
export class SegmentMismatchError extends TranslateError {
  constructor(readonly expected: number, readonly received: number) {
    super(`expected ${expected} segments, got ${received}`, false);
    this.name = 'SegmentMismatchError';
  }
}

export const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
  ar: 'Arabic',
  vi: 'Vietnamese',
  th: 'Thai',
};

export function langName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

function systemPrompt(opts: TranslateOptions, count: number): string {
  const to = langName(opts.targetLang);
  const lines = [
    `You are a professional translator. Translate the user's text into ${to}.`,
    '',
    'Rules:',
    `1. Output the translation only. Never add notes, explanations, or preambles.`,
    `2. Write natural, idiomatic ${to} — translate the meaning, not the word order.`,
    '3. Keep proper nouns, product names, code identifiers, URLs, and numbers as they are.',
    '4. The text may contain markers like <b0>, <b1>, or <b2/>. They mark inline formatting and untranslatable content.',
    '   Reproduce every marker exactly, with the same numbers, wrapping the corresponding part of your translation.',
    '   Never translate, renumber, drop, or invent a marker.',
    // Preformatted blocks are rendered where line breaks carry the layout, so
    // a translation that reflows into one paragraph destroys the formatting.
    '5. Preserve line structure. If a segment spans several lines or contains blank lines,',
    '   the translation must use the same line breaks in the same places.',
  ];

  if (opts.subtitle) {
    lines.push(
      '6. This is a video subtitle: keep each line short and spoken in register. Do not merge or split lines.',
    );
  }

  if (count > 1) {
    lines.push(
      '',
      `The input contains ${count} segments separated by a line containing only %%.`,
      `Return exactly ${count} translated segments separated the same way, in the same order.`,
      'Never merge, split, reorder, drop, or add a segment — the count must match exactly.',
      'If a segment needs no translation, repeat it unchanged rather than omitting it.',
      '',
      'Example input:',
      'Segment one',
      '',
      '%%',
      '',
      'Segment two',
      '',
      'Example output:',
      'Translation one',
      '',
      '%%',
      '',
      'Translation two',
    );
  }

  if (opts.context?.title) {
    lines.push('', `Page title, for context only — do not translate it: "${opts.context.title}"`);
  }
  if (opts.context?.extra?.trim()) {
    lines.push('', 'Additional instructions from the user:', opts.context.extra.trim());
  }

  return lines.join('\n');
}

/** Refusals and stray scaffolding that occasionally survive into a reply. */
const JUNK_PATTERNS: RegExp[] = [
  /^(抱歉|很抱歉|对不起)[，,].{0,40}(无法|不能|不适合)/,
  /^I'm sorry,? but I (cannot|can't)/i,
  /^(Sure|Certainly|Here('s| is) the translation)[:：]?\s*/i,
  /^(译文|翻译)(如下)?[:：]\s*/,
];

function cleanSegment(text: string): string {
  let out = text.trim();
  // Models sometimes fence the whole reply even when told not to.
  const fence = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1] !== undefined) out = fence[1].trim();
  // Reasoning models leak their scratchpad; some omit the opening tag entirely,
  // so the closing tag is what the cut is anchored on.
  const thinkEnd = out.lastIndexOf('</think>');
  if (thinkEnd !== -1) out = out.slice(thinkEnd + '</think>'.length).trim();
  for (const re of JUNK_PATTERNS) {
    if (re.test(out)) out = out.replace(re, '').trim();
  }
  return out;
}

export async function translateBatch(texts: string[], opts: TranslateOptions): Promise<string[]> {
  if (!texts.length) return [];

  const payload = texts.join(SEPARATOR);
  const reply = await chat(
    [
      { role: 'system', content: systemPrompt(opts, texts.length) },
      { role: 'user', content: payload },
    ],
    opts,
  );

  if (texts.length === 1) return [cleanSegment(reply)];

  const parts = reply.split(SPLIT_RE).map(cleanSegment).filter((s, i, arr) => {
    // A leading or trailing empty part is a formatting artefact, not a segment.
    if (s) return true;
    return i !== 0 && i !== arr.length - 1;
  });

  if (parts.length !== texts.length) throw new SegmentMismatchError(texts.length, parts.length);
  return parts;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** Per-model request-body quirks, kept in one place. */
function bodyOverrides(model: string): Record<string, unknown> {
  const m = model.toLowerCase();
  // Reasoning burns tokens and latency on a task that needs none, so it is
  // switched off wherever the family exposes a knob for it.
  if (/^(o[1-4]|gpt-5)/.test(m)) return { reasoning_effort: 'minimal' };
  // DeepSeek V4 thinks by default; `temperature` is still honoured.
  if (/^deepseek-v4/.test(m)) return { temperature: 0.3, thinking: { type: 'disabled' } };
  // Reasoner has no off switch and rejects temperature.
  if (/deepseek-(reasoner|r1)/.test(m)) return {};
  if (/^qwen3/.test(m)) return { temperature: 0.3, enable_thinking: false };
  return { temperature: 0.3 };
}

async function chat(messages: ChatMessage[], opts: TranslateOptions): Promise<string> {
  const { apiKey, baseUrl, model } = opts.provider;
  if (!apiKey) throw new TranslateError('No API key configured', false);
  if (!baseUrl) throw new TranslateError('No API base URL configured', false);
  if (!model) throw new TranslateError('No model configured', false);

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = { model, messages, stream: false, ...bodyOverrides(model) };

  const MAX_ATTEMPTS = 3;
  let lastError: TranslateError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await once(url, apiKey, body, opts.signal);
    } catch (err) {
      const e = err instanceof TranslateError ? err : new TranslateError(String(err), true);
      if (!e.retryable || attempt === MAX_ATTEMPTS) throw e;
      lastError = e;
      // Exponential backoff; rate limits in particular need real breathing room.
      await sleep(attempt * (e.status === 429 ? 2500 : 900));
    }
  }
  throw lastError ?? new TranslateError('Translation failed', false);
}

async function once(
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 90_000);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new TranslateError(describeHttp(res.status, detail), isRetryableStatus(res.status), res.status);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (json.error?.message) throw new TranslateError(json.error.message, false);

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new TranslateError('Empty response from the model', true);
    }
    return content;
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    if (signal?.aborted) throw new TranslateError('Cancelled', false);
    if ((err as Error)?.name === 'AbortError') throw new TranslateError('Request timed out', true);
    throw new TranslateError(`Network error: ${(err as Error).message}`, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function describeHttp(status: number, detail: string): string {
  const trimmed = detail.slice(0, 300);
  switch (status) {
    case 401: return 'Invalid API key (401) — check the key in options';
    case 402: return 'Insufficient balance (402) — top up your account';
    case 403: return 'Access denied (403) — the key may lack permission for this model';
    case 404: return `Endpoint or model not found (404) — check the base URL and model name. ${trimmed}`;
    case 429: return 'Rate limited (429)';
    default: return `HTTP ${status}${trimmed ? ` — ${trimmed}` : ''}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
