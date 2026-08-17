/**
 * Bilingual subtitle rendering.
 *
 * The track arrives from the MAIN-world hook, gets translated in batches, and
 * is drawn into our own overlay while the player's native caption layer is
 * hidden. Drawing rather than rewriting the player's track buys control over
 * the two-line bilingual layout, which is the whole point — a rewritten track
 * would be at the mercy of each player's line-wrapping.
 *
 * Translation is deliberately eager: the reader cannot pause to wait for a
 * line, so cues are translated ahead of playback and only the ones near the
 * playhead are prioritised.
 */

import { parseSubtitle, type Cue } from './parse';
import { looksLikeLanguage } from '../paragraph';
import type { Settings } from '../settings';
import { sendToBackground, type TranslateResponse } from '../../shared/messages';

const CHANNEL = 'aetm-subtitle';
const BATCH = 8;
/** Cues to keep translated ahead of the playhead. */
const LOOKAHEAD = 60;

/** Selectors for native caption layers we replace, by host. */
const NATIVE_CAPTIONS: { match: RegExp; selectors: string[]; container?: string }[] = [
  {
    match: /(^|\.)youtube\.com$/,
    selectors: ['.ytp-caption-window-container', '.caption-window'],
    container: '#movie_player, .html5-video-player',
  },
  { match: /(^|\.)bilibili\.com$/, selectors: ['.bpx-player-subtitle-wrap', '.bilibili-player-video-subtitle'] },
  { match: /(^|\.)ted\.com$/, selectors: ['.player-captions'] },
];

let installed = false;

export function installSubtitles(getSettings: () => Settings): void {
  if (installed) return;
  installed = true;
  const controller = new SubtitleController(getSettings);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; url?: string; body?: string } | null;
    if (data?.source !== CHANNEL || !data.body || !data.url) return;
    if (!getSettings().subtitleEnabled) return;
    controller.ingest(data.body, data.url);
  });
}

class SubtitleController {
  private cues: Cue[] = [];
  private layer?: HTMLElement;
  private video?: HTMLVideoElement;
  private raf?: number;
  private translating = false;
  private hiddenStyle?: HTMLStyleElement;
  private lastKey = '';

  constructor(private getSettings: () => Settings) {}

  ingest(body: string, url: string): void {
    const cues = parseSubtitle(body, url);
    if (cues.length < 2) return;

    // The same track often arrives more than once (retries, quality switches).
    const key = `${cues.length}:${cues[0]!.text}:${cues[cues.length - 1]!.text}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const settings = this.getSettings();
    const sample = cues.slice(0, 12).map((c) => c.text).join(' ');
    if (settings.skipSameLanguage && looksLikeLanguage(sample, settings.targetLang)) return;

    this.cues = cues;
    this.attach();
    void this.translateAhead();
  }

  private attach(): void {
    const video = pickVideo();
    if (!video) {
      // The player may not exist yet on a fresh navigation.
      setTimeout(() => this.attach(), 500);
      return;
    }
    if (this.video === video && this.layer?.isConnected) return;

    this.video = video;
    this.hideNativeCaptions();

    const host = positionedAncestor(video);
    this.layer?.remove();
    const layer = document.createElement('div');
    layer.className = 'aetm-caption-layer';
    layer.dataset.order = 'source-first';
    host.appendChild(layer);
    this.layer = layer;

    this.tick();
  }

  /**
   * Hides the player's own captions via CSS instead of turning them off, so
   * the player keeps fetching the track — that fetch is our only source.
   */
  private hideNativeCaptions(): void {
    const rule = NATIVE_CAPTIONS.find((r) => r.match.test(location.hostname));
    const selectors = rule?.selectors ?? ['::cue'];
    if (this.hiddenStyle?.isConnected) return;
    const style = document.createElement('style');
    style.textContent = `${selectors.join(',')} { display: none !important; }
      video::cue { opacity: 0 !important; }`;
    document.head.appendChild(style);
    this.hiddenStyle = style;
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const video = this.video;
    const layer = this.layer;
    if (!video || !layer?.isConnected) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = undefined;
      // The player was re-created (fullscreen, SPA nav); re-attach to it.
      if (this.cues.length) setTimeout(() => this.attach(), 300);
      return;
    }

    const t = video.currentTime;
    const cue = this.cues.find((c) => t >= c.start && t < c.end);
    this.paint(layer, cue);

    // Keep the translation frontier ahead of playback.
    if (cue && !this.translating) void this.translateAhead(t);
  };

  private paint(layer: HTMLElement, cue: Cue | undefined): void {
    if (!cue) {
      if (layer.childNodes.length) layer.textContent = '';
      return;
    }
    if (layer.dataset.cue === String(cue.start) && layer.dataset.tr === (cue.translation ?? '')) return;
    layer.dataset.cue = String(cue.start);
    layer.dataset.tr = cue.translation ?? '';

    layer.textContent = '';
    const source = document.createElement('div');
    source.className = 'aetm-caption-line aetm-caption-source';
    source.textContent = cue.text;
    layer.appendChild(source);

    if (cue.translation) {
      const target = document.createElement('div');
      target.className = 'aetm-caption-line aetm-caption-target';
      target.textContent = cue.translation;
      layer.appendChild(target);
    }
  }

  private async translateAhead(from = 0): Promise<void> {
    if (this.translating) return;
    const settings = this.getSettings();
    const pending = this.cues.filter(
      (c) => c.translation === undefined && c.end >= from && c.start <= from + LOOKAHEAD,
    );
    if (!pending.length) return;

    this.translating = true;
    try {
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        const res = await sendToBackground<TranslateResponse>({
          type: 'translate',
          job: {
            texts: batch.map((c) => c.text),
            targetLang: settings.targetLang,
            title: document.title,
            subtitle: true,
          },
        });
        if (!res?.ok || !res.translations) {
          // Mark them handled so a failing key does not spin the loop.
          for (const cue of batch) cue.translation = '';
          return;
        }
        batch.forEach((cue, k) => {
          cue.translation = res.translations?.[k] ?? '';
        });
      }
    } finally {
      this.translating = false;
    }
  }
}

function pickVideo(): HTMLVideoElement | undefined {
  const videos = Array.from(document.querySelectorAll('video'));
  if (!videos.length) return undefined;
  // The largest playing video is the one being watched.
  return videos
    .filter((v) => v.readyState > 0)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? videos[0];
}

/**
 * The overlay is absolutely positioned, so it must land in an ancestor that
 * establishes a containing block — otherwise it anchors to the page and drifts
 * away from the video on scroll or in fullscreen.
 */
function positionedAncestor(video: HTMLVideoElement): HTMLElement {
  const rule = NATIVE_CAPTIONS.find((r) => r.match.test(location.hostname));
  if (rule?.container) {
    const named = document.querySelector<HTMLElement>(rule.container);
    if (named) return named;
  }
  let el: HTMLElement | null = video.parentElement;
  while (el && el !== document.body) {
    if (getComputedStyle(el).position !== 'static') return el;
    el = el.parentElement;
  }
  // Nothing positioned: make the immediate parent the anchor.
  const parent = video.parentElement ?? document.body;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  return parent;
}
