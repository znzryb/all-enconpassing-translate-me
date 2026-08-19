import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheGet, cacheSet, pruneEchoedSources } from './cache';

const MODEL = 'test-model';

let removed: string[];

beforeEach(() => {
  vi.useFakeTimers();
  removed = [];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async (keys: string[]) => {
          removed.push(...keys);
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Clears entries left by the version that cached a failed translation as its
 * own source. An entry holds no copy of its input, so the only evidence left
 * is whether the stored text is written in the target's script at all.
 */
describe('pruning echoed sources', () => {
  it('drops an entry holding no character of its target script', async () => {
    cacheSet('hola que tal', 'zh-CN', MODEL, '这是真正的译文');
    cacheSet('vamos a ver eso', 'zh-CN', MODEL, 'vamos a ver eso');

    expect(await pruneEchoedSources()).toBe(1);

    expect(cacheGet('hola que tal', 'zh-CN', MODEL)).toBe('这是真正的译文');
    expect(cacheGet('vamos a ver eso', 'zh-CN', MODEL)).toBeUndefined();
    expect(removed).toHaveLength(1);
  });

  /**
   * The reason the test is presence-of-script rather than proportion-of-script:
   * a translation about code is mostly identifiers, and a proportional test
   * throws away perfectly good work.
   */
  it('keeps a technical translation that runs heavy on Latin identifiers', async () => {
    const mixed = '所以我们有这个恢复函数（Recovery()），它会处理 "Panic Conditions"';
    cacheSet('entonces tenemos esta función', 'zh-CN', MODEL, mixed);

    expect(await pruneEchoedSources()).toBe(0);
    expect(cacheGet('entonces tenemos esta función', 'zh-CN', MODEL)).toBe(mixed);
  });

  it('judges each entry against the language in its own key', async () => {
    cacheSet('hello', 'ru', MODEL, 'привет');
    cacheSet('hello', 'ko', MODEL, 'hello');
    cacheSet('hello', 'ja', MODEL, 'こんにちは');

    expect(await pruneEchoedSources()).toBe(1);

    expect(cacheGet('hello', 'ru', MODEL)).toBe('привет');
    expect(cacheGet('hello', 'ja', MODEL)).toBe('こんにちは');
    expect(cacheGet('hello', 'ko', MODEL)).toBeUndefined();
  });

  /**
   * Two Latin-script languages cannot be told apart this way — an untranslated
   * Spanish line and a French translation look alike — so those are left alone
   * rather than guessed at.
   */
  it('leaves Latin-script targets untouched', async () => {
    cacheSet('hola', 'es', MODEL, 'hola');
    cacheSet('hello', 'fr', MODEL, 'bonjour');

    expect(await pruneEchoedSources()).toBe(0);
    expect(cacheGet('hola', 'es', MODEL)).toBe('hola');
  });

  it('respects the video scope when pruning subtitle entries', async () => {
    cacheSet('okay so', 'zh-CN', MODEL, 'okay so', 'www.youtube.com/AAA');
    cacheSet('okay so', 'zh-CN', MODEL, '好的那么', 'www.youtube.com/BBB');

    expect(await pruneEchoedSources()).toBe(1);

    expect(cacheGet('okay so', 'zh-CN', MODEL, 'www.youtube.com/AAA')).toBeUndefined();
    expect(cacheGet('okay so', 'zh-CN', MODEL, 'www.youtube.com/BBB')).toBe('好的那么');
  });
});
