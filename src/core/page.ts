/**
 * Per-page controller: owns the scan → schedule → render lifecycle and keeps
 * up with pages that grow after load.
 *
 * Two things make a page move under us. Infinite scroll and lazy-loaded
 * comments append new nodes, which a debounced MutationObserver picks up. And
 * single-page apps swap the whole view without a navigation, which is detected
 * by watching for URL changes — on a real navigation the old translations are
 * meaningless and everything restarts.
 */

import { CLS, type DisplayState } from './dom-rules';
import { collectUnits, type Unit } from './paragraph';
import { getDisplayState, hasTranslations, removeAll, setDisplayState } from './render';
import { Scheduler, type Progress } from './scheduler';
import type { Settings } from './settings';

const RESCAN_DEBOUNCE_MS = 400;

export class PageTranslator {
  private scheduler?: Scheduler;
  private mutation?: MutationObserver;
  private rescanTimer?: ReturnType<typeof setTimeout>;
  private urlTimer?: ReturnType<typeof setInterval>;
  private lastUrl = location.href;
  private progress: Progress = { translated: 0, pending: 0, failed: 0 };
  private pendingRoots = new Set<Element>();

  constructor(
    private settings: Settings,
    private onProgress: (p: Progress) => void = () => {},
  ) {}

  get active(): boolean {
    return this.scheduler !== undefined;
  }

  get stats(): Progress {
    return this.progress;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  start(): void {
    if (this.scheduler) return;
    this.scheduler = new Scheduler(this.settings, (p) => {
      this.progress = p;
      this.onProgress(p);
    });
    setDisplayState('dual');
    this.scan(document.body);
    this.watchMutations();
    this.watchUrl();
  }

  stop(): void {
    this.scheduler?.stop();
    this.scheduler = undefined;
    this.mutation?.disconnect();
    this.mutation = undefined;
    if (this.urlTimer) clearInterval(this.urlTimer);
    this.urlTimer = undefined;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = undefined;
    this.pendingRoots.clear();
    removeAll();
    setDisplayState('original');
    this.progress = { translated: 0, pending: 0, failed: 0 };
    this.onProgress(this.progress);
  }

  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  setState(state: DisplayState): void {
    if (state !== 'original' && !this.active) {
      this.start();
      return;
    }
    if (state === 'original' && !hasTranslations()) return;
    setDisplayState(state);
  }

  cycleState(): void {
    if (!this.active) {
      this.start();
      return;
    }
    const order: DisplayState[] = ['dual', 'translation', 'original'];
    const next = order[(order.indexOf(getDisplayState()) + 1) % order.length]!;
    setDisplayState(next);
  }

  get state(): DisplayState {
    return getDisplayState();
  }

  private scan(root: Element): void {
    if (!this.scheduler) return;
    const units = collectUnits(root).filter(isFresh);
    if (units.length) this.scheduler.add(units);
  }

  private watchMutations(): void {
    this.mutation = new MutationObserver((records) => {
      if (!this.scheduler) return;
      for (const record of records) {
        // Our own insertions must not feed back into the scan.
        if (isOurs(record.target)) continue;
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !isOurs(node)) {
            this.pendingRoots.add(node as Element);
          } else if (node.nodeType === Node.TEXT_NODE && node.parentElement && !isOurs(node)) {
            this.pendingRoots.add(node.parentElement);
          }
        }
      }
      if (this.pendingRoots.size) this.scheduleRescan();
    });
    this.mutation.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Debounced so a hundred nodes streaming in produce one scan, and scoped to
   * the highest added ancestors so nested insertions are not scanned twice.
   */
  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      const roots = topMost([...this.pendingRoots].filter((el) => el.isConnected));
      this.pendingRoots.clear();
      for (const root of roots) this.scan(root);
    }, RESCAN_DEBOUNCE_MS);
  }

  private watchUrl(): void {
    this.urlTimer = setInterval(() => {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      // The view was replaced: previous translations belong to a page that is
      // no longer here. Restart rather than layer new ones over stale ones.
      const wasActive = this.active;
      this.stop();
      if (wasActive) setTimeout(() => this.start(), 300);
    }, 500);
  }
}

function isOurs(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(el?.closest(`.${CLS.wrapper}`));
}

/**
 * A rescan re-collects paragraphs that are already translated, because the
 * source nodes are still there — only our wrapper is skipped. The check is per
 * insertion point rather than per container, since one container can hold
 * several inline runs and only some of them may be done.
 */
function isFresh(unit: Unit): boolean {
  const last = unit.nodes[unit.nodes.length - 1];
  if (!last) return false;
  const neighbour = unit.whole ? unit.container.lastElementChild : last.nextSibling;
  if (!neighbour || neighbour.nodeType !== Node.ELEMENT_NODE) return true;
  return !(neighbour as Element).classList.contains(CLS.wrapper);
}

/** Drops elements that are descendants of another element in the list. */
function topMost(elements: Element[]): Element[] {
  return elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)));
}
