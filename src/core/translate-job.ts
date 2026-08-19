/**
 * Resolving a translation request, independent of the worker that receives it.
 *
 * Kept out of the background entrypoint so the cache-versus-model logic can be
 * exercised directly: which results are trusted, which are cached, and what a
 * caller is handed when the model cannot deliver.
 */

import { cacheGet, cacheSet } from './cache';
import { SegmentMismatchError, TranslateError, translateBatch, type TranslateOptions } from './llm';
import { activeProvider, loadSettings } from './settings';
import type { TranslateJob, TranslateResponse } from '../shared/messages';

/**
 * Resolves a batch: cache first, model for the remainder. When the model
 * breaks the `%%` segment contract the batch is retried one paragraph at a
 * time — slower, but it always terminates and never misaligns a translation
 * onto the wrong paragraph, which is the one failure a reader would notice.
 *
 * A paragraph that fails even then resolves to `undefined` rather than to its
 * own source text. The reply still carries the source so the caller has
 * something to show, but nothing is written to the cache: an echoed source
 * stored as a translation would be indistinguishable from a real one, and the
 * paragraph would stay untranslated on every future visit.
 */
export async function handleTranslate(job: TranslateJob): Promise<TranslateResponse> {
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
    const hit = settings.cacheEnabled
      ? cacheGet(text, job.targetLang, provider.model, job.scope)
      : undefined;
    if (hit !== undefined) results[i] = hit;
    else pending.push(i);
  }

  if (pending.length) {
    const inputs = pending.map((i) => job.texts[i]!);
    let translations: (string | undefined)[];
    try {
      translations = await translateBatch(inputs, opts);
    } catch (err) {
      if (!(err instanceof SegmentMismatchError)) {
        return { ok: false, error: errorText(err) };
      }
      const settled = await Promise.allSettled(
        inputs.map((text) => translateBatch([text], opts).then((r) => r[0])),
      );
      if (settled.every((r) => r.status === 'rejected')) {
        const first = settled[0];
        return {
          ok: false,
          mismatch: true,
          error: first?.status === 'rejected' ? errorText(first.reason) : 'Translation failed',
        };
      }
      translations = settled.map((r) => (r.status === 'fulfilled' ? r.value : undefined));
    }

    for (let k = 0; k < pending.length; k++) {
      const index = pending[k]!;
      const value = translations[k];
      // Blank covers both a failed line and a placeholder the model used to pad
      // the segment count. Leaving the slot empty falls back to the source and
      // keeps the cache clean, so the line is retried rather than frozen.
      if (value === undefined || !value.trim()) continue;
      results[index] = value;
      if (settings.cacheEnabled) {
        cacheSet(job.texts[index]!, job.targetLang, provider.model, value, job.scope);
      }
    }
  }

  return { ok: true, translations: results.map((r, i) => r ?? job.texts[i]!) };
}

export async function testConnection(): Promise<{ ok: boolean; error?: string; sample?: string }> {
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

export function errorText(err: unknown): string {
  if (err instanceof TranslateError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
