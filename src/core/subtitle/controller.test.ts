import { beforeEach, describe, expect, it, vi } from 'vitest';

import { belongsToCurrentPage, installSubtitles, mediaIdentity } from './controller';
import type { Settings } from '../settings';

/** happy-dom exposes navigation on its own handle; assigning href is the fallback. */
function goTo(url: string): void {
  (window as unknown as { happyDOM?: { setURL?: (u: string) => void } }).happyDOM?.setURL?.(url);
  if (location.href !== url) location.href = url;
}

describe('mediaIdentity', () => {
  it('distinguishes two watch pages that differ only by id', () => {
    goTo('https://www.youtube.com/watch?v=AAA');
    const first = mediaIdentity();
    goTo('https://www.youtube.com/watch?v=BBB');
    expect(mediaIdentity()).not.toBe(first);
  });

  it('treats a new timestamp on the same video as the same video', () => {
    goTo('https://www.youtube.com/watch?v=AAA');
    const plain = mediaIdentity();
    goTo('https://www.youtube.com/watch?v=AAA&t=120s');
    expect(mediaIdentity()).toBe(plain);
  });

  it('reads the id out of the path where there is no query', () => {
    goTo('https://www.youtube.com/shorts/XYZ');
    expect(mediaIdentity()).toBe('www.youtube.com/XYZ');
    goTo('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(mediaIdentity()).toBe('www.bilibili.com/BV1xx411c7mD');
  });

  it('falls back to the path when no id is recognisable', () => {
    goTo('https://example.com/lecture/one');
    expect(mediaIdentity()).toBe('example.com/lecture/one');
  });
});

describe('belongsToCurrentPage', () => {
  beforeEach(() => goTo('https://www.youtube.com/watch?v=AAA'));

  it('accepts a track for the video on screen', () => {
    expect(belongsToCurrentPage('https://www.youtube.com/api/timedtext?v=AAA&lang=en')).toBe(true);
  });

  it('rejects a track fetched for a different video', () => {
    expect(belongsToCurrentPage('https://www.youtube.com/api/timedtext?v=BBB&lang=en')).toBe(false);
  });

  it('accepts tracks that name no video, since most players do not', () => {
    expect(belongsToCurrentPage('https://cdn.example.com/subs/en.vtt')).toBe(true);
  });
});

/**
 * The bug this guards: players that navigate without a reload keep the same
 * `<video>` element, so nothing about the element says the video changed. The
 * overlay used to keep painting the previous video's lines over the new one.
 */
describe('changing video', () => {
  interface Harness {
    frame: () => void;
    deliver: (url: string, body: string) => Promise<void>;
    layer: () => HTMLElement | null;
    seek: (seconds: number) => void;
    requests: { texts: string[]; scope?: string }[];
  }

  const track = (lines: [number, string][]) =>
    JSON.stringify({
      events: lines.map(([tStartMs, text]) => ({
        tStartMs,
        dDurationMs: 3000,
        segs: [{ utf8: text }],
      })),
    });

  const LECTURE = track([
    [0, 'welcome to CS233'],
    [3000, 'today we cover pipelining'],
    [6000, 'lets begin'],
  ]);

  async function harness(): Promise<Harness> {
    vi.resetModules();
    document.head.innerHTML = '';
    document.body.innerHTML = '<div id="movie_player"><video></video></div>';
    const video = document.querySelector('video')!;
    let currentTime = 0;
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      configurable: true,
    });

    let queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const requests: { texts: string[]; scope?: string }[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: (message: { job: { texts: string[]; scope?: string } }) => {
          requests.push({ texts: message.job.texts, scope: message.job.scope });
          return Promise.resolve({
            ok: true,
            translations: message.job.texts.map((t) => `[${t}]`),
          });
        },
      },
    });

    const { installSubtitles: install } = await import('./controller');
    install(() =>
      ({ subtitleEnabled: true, targetLang: 'zh-CN', skipSameLanguage: false }) as Settings,
    );

    return {
      frame: () => {
        const due = queue;
        queue = [];
        for (const cb of due) cb(0);
      },
      deliver: async (url, body) => {
        const event = new MessageEvent('message', {
          data: { source: 'aetm-subtitle', url, body },
        });
        Object.defineProperty(event, 'source', { value: window });
        window.dispatchEvent(event);
        await new Promise((r) => setTimeout(r, 0));
      },
      layer: () => document.querySelector<HTMLElement>('.aetm-caption-layer'),
      seek: (seconds) => {
        currentTime = seconds;
      },
      requests,
    };
  }

  it('stops painting the old video once the page navigates', async () => {
    goTo('https://www.youtube.com/watch?v=AAA');
    const h = await harness();
    await h.deliver('https://www.youtube.com/api/timedtext?v=AAA', LECTURE);

    h.seek(1);
    h.frame();
    expect(h.layer()?.textContent).toContain('CS233');

    goTo('https://www.youtube.com/watch?v=BBB');
    h.frame();
    expect(h.layer()?.textContent).toBe('');

    // Gone, not merely unpainted: a later timestamp must not resurrect a line.
    h.seek(4);
    h.frame();
    expect(h.layer()?.textContent).toBe('');
  });

  it('ignores a track that arrives late for the video just left', async () => {
    goTo('https://www.youtube.com/watch?v=AAA');
    const h = await harness();

    goTo('https://www.youtube.com/watch?v=BBB');
    h.frame();
    await h.deliver('https://www.youtube.com/api/timedtext?v=AAA', LECTURE);

    h.seek(1);
    h.frame();
    expect(h.layer()?.textContent ?? '').toBe('');
  });

  it('keeps the cues when only the timestamp in the URL changes', async () => {
    goTo('https://www.youtube.com/watch?v=AAA');
    const h = await harness();
    await h.deliver('https://www.youtube.com/api/timedtext?v=AAA', LECTURE);

    goTo('https://www.youtube.com/watch?v=AAA&t=42s');
    h.seek(1);
    h.frame();
    expect(h.layer()?.textContent).toContain('CS233');
  });

  it('scopes the cache to the video, so no other video can reuse a line', async () => {
    goTo('https://www.youtube.com/watch?v=AAA');
    const h = await harness();
    await h.deliver('https://www.youtube.com/api/timedtext?v=AAA', LECTURE);

    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.requests[0]!.scope).toBe('www.youtube.com/AAA');
  });
});
