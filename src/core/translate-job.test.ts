import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheGet } from './cache';
import { handleTranslate } from './translate-job';
import { DEFAULT_SETTINGS } from './settings';

const MODEL = 'test-model';

const settings = {
  ...DEFAULT_SETTINGS,
  providers: {
    ...DEFAULT_SETTINGS.providers,
    deepseek: { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: MODEL },
  },
};

function ok(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  } as unknown as Response;
}

/** 401 is not retryable, so a stubbed failure fails immediately. */
function denied() {
  return {
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => 'bad key',
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({ 'aetm:settings': settings }),
        set: async () => {},
        remove: async () => {},
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * The failure this guards: a line whose translation never arrived used to
 * resolve to its own source text, which was then cached. Nothing in an entry
 * records what its input was, so that line read as already-translated forever.
 */
describe('a translation that fails', () => {
  /** Breaks the %% contract once, then answers each retried line separately. */
  function stubFetch(perLine: (text: string) => Response) {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: { content: string }[] };
      const user = body.messages[1]!.content;
      // The batched request: reply with one segment where several were asked for.
      if (user.includes('%%')) return ok('只有一段');
      return perLine(user);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('is never written to the cache, while its neighbours still are', async () => {
    stubFetch((text) => (text === 'One' ? ok('第一段') : denied()));

    const res = await handleTranslate({
      texts: ['One', 'Two', 'Three'],
      targetLang: 'zh-CN',
    });

    // The caller still gets something to show for the lines that failed.
    expect(res.ok).toBe(true);
    expect(res.translations).toEqual(['第一段', 'Two', 'Three']);

    expect(cacheGet('One', 'zh-CN', MODEL)).toBe('第一段');
    expect(cacheGet('Two', 'zh-CN', MODEL)).toBeUndefined();
    expect(cacheGet('Three', 'zh-CN', MODEL)).toBeUndefined();
  });

  it('reports an outright failure rather than echoing every line back', async () => {
    stubFetch(() => denied());

    const res = await handleTranslate({ texts: ['Four', 'Five'], targetLang: 'zh-CN' });

    expect(res.ok).toBe(false);
    expect(res.mismatch).toBe(true);
    expect(cacheGet('Four', 'zh-CN', MODEL)).toBeUndefined();
  });

  it('keeps a subtitle failure out of that video’s scope too', async () => {
    stubFetch((text) => (text === 'hola' ? ok('你好') : denied()));

    const res = await handleTranslate({
      texts: ['hola', 'que tal'],
      targetLang: 'zh-CN',
      subtitle: true,
      scope: 'www.youtube.com/AAA',
    });

    expect(res.translations).toEqual(['你好', 'que tal']);
    expect(cacheGet('hola', 'zh-CN', MODEL, 'www.youtube.com/AAA')).toBe('你好');
    expect(cacheGet('que tal', 'zh-CN', MODEL, 'www.youtube.com/AAA')).toBeUndefined();
  });
});

/**
 * A placeholder reduces to an empty segment, which must not reach the cache:
 * stored, it is indistinguishable from a real translation and the line would
 * never be attempted again.
 */
describe('a segment the model padded', () => {
  it('falls back to the source and is not cached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok('真正的译文\n\n%%\n\n<blank>')),
    );

    const res = await handleTranslate({ texts: ['Uno', 'Dos'], targetLang: 'zh-CN' });

    expect(res.ok).toBe(true);
    expect(res.translations).toEqual(['真正的译文', 'Dos']);
    expect(cacheGet('Uno', 'zh-CN', MODEL)).toBe('真正的译文');
    expect(cacheGet('Dos', 'zh-CN', MODEL)).toBeUndefined();
  });
});
