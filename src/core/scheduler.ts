/**
 * Viewport-driven translation scheduler.
 *
 * Translating a whole page up front burns tokens on content nobody scrolls to,
 * and translating strictly on-screen makes text visibly pop in late. So work is
 * triggered by an IntersectionObserver with a generous `rootMargin`: paragraphs
 * are translated roughly a screen and a half ahead of the reader, arriving
 * before they are looked at.
 *
 * Units are queued in document order and drained in batches, which keeps each
 * request's paragraphs adjacent — the model gets real context instead of a
 * random sample of the page.
 */

import { looksLikeLanguage, type Unit } from './paragraph';
import { discard, renderError, renderPending, renderTranslation } from './render';
import type { Settings } from './settings';
import { sendToBackground } from '../shared/messages';
import type { TranslateResponse } from '../shared/messages';

export interface Progress {
  translated: number;
  pending: number;
  failed: number;
  lastError?: string;
}

export class Scheduler {
  private observer: IntersectionObserver;
  private byContainer = new Map<Element, Unit[]>();
  private queue: Unit[] = [];
  private queued = new Set<number>();
  private inflight = 0;
  private stopped = false;
  private drainScheduled = false;

  private stats: Progress = { translated: 0, pending: 0, failed: 0 };

  constructor(
    private settings: Settings,
    private onProgress: (p: Progress) => void,
  ) {
    const margin = `${Math.round(settings.lookaheadScreens * 100)}%`;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer.unobserve(entry.target);
          for (const unit of this.byContainer.get(entry.target) ?? []) this.enqueue(unit);
        }
        this.scheduleDrain();
      },
      { rootMargin: `${margin} 0px ${margin} 0px`, threshold: 0 },
    );
  }

  add(units: Unit[]): void {
    for (const unit of units) {
      const list = this.byContainer.get(unit.container);
      if (list) {
        list.push(unit);
        continue;
      }
      this.byContainer.set(unit.container, [unit]);
      // A detached or zero-size container never intersects; translate it now
      // rather than leaving it silently pending forever.
      if (unit.container.isConnected) this.observer.observe(unit.container);
      else this.enqueue(unit);
    }
    this.scheduleDrain();
  }

  stop(): void {
    this.stopped = true;
    this.observer.disconnect();
    this.queue = [];
    this.queued.clear();
    this.byContainer.clear();
  }

  get progress(): Progress {
    return { ...this.stats, pending: this.queue.length + this.inflight };
  }

  private enqueue(unit: Unit): void {
    if (this.stopped || unit.done || this.queued.has(unit.id)) return;
    if (this.settings.skipSameLanguage && looksLikeLanguage(unit.text, this.settings.targetLang)) {
      return;
    }
    this.queued.add(unit.id);
    this.queue.push(unit);
  }

  /** Coalesces the burst of observer callbacks that a single scroll produces. */
  private scheduleDrain(): void {
    if (this.drainScheduled || this.stopped) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (!this.stopped && this.inflight < this.settings.concurrency && this.queue.length) {
      const batch = this.queue.splice(0, this.settings.batchSize);
      void this.run(batch);
    }
    this.report();
  }

  private async run(batch: Unit[]): Promise<void> {
    this.inflight++;
    for (const unit of batch) renderPending(unit, this.settings.theme);
    this.report();

    try {
      const res = await sendToBackground<TranslateResponse>({
        type: 'translate',
        job: {
          texts: batch.map((u) => u.html),
          targetLang: this.settings.targetLang,
          title: document.title,
        },
      });

      if (this.stopped) return;

      if (!res?.ok || !res.translations) {
        const message = res?.error ?? 'Translation failed';
        this.stats.lastError = message;
        for (const unit of batch) {
          this.stats.failed++;
          renderError(unit, message);
        }
        return;
      }

      for (let i = 0; i < batch.length; i++) {
        const unit = batch[i]!;
        const translation = res.translations[i];
        // An unchanged reply means the model judged it already in the target
        // language; showing the same sentence twice is worse than showing none.
        if (translation === undefined || normalize(translation) === normalize(unit.html)) {
          discard(unit);
          continue;
        }
        renderTranslation(unit, translation);
        this.stats.translated++;
      }
    } catch (err) {
      if (this.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      this.stats.lastError = message;
      for (const unit of batch) {
        this.stats.failed++;
        renderError(unit, message);
      }
    } finally {
      this.inflight--;
      this.report();
      if (!this.stopped && this.queue.length) this.scheduleDrain();
    }
  }

  private report(): void {
    this.onProgress(this.progress);
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
