import { beforeEach, describe, expect, it, vi } from 'vitest';

import { belongsToCurrentPage, installSubtitles, mediaIdentity } from './controller';
import type { Settings } from '../settings';

function goTo(url: string): void {
  window.happyDOM?.setURL?.(url);
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
