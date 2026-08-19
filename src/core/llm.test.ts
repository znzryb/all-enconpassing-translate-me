import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentMismatchError, TranslateError, translateBatch, type TranslateOptions } from './llm';

const provider = { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: 'test-model' };
const opts: TranslateOptions = { provider, targetLang: 'zh-CN' };

/** Stubs one chat-completions reply. */
function reply(content: string, init: Partial<Response> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
    ...init,
  } as unknown as Response);
}

afterEach(() => vi.unstubAllGlobals());

describe('batching', () => {
  it('splits a multi-segment reply back into paragraphs', async () => {
    vi.stubGlobal('fetch', reply('第一段\n\n%%\n\n第二段\n\n%%\n\n第三段'));
    const out = await translateBatch(['One', 'Two', 'Three'], opts);
    expect(out).toEqual(['第一段', '第二段', '第三段']);
  });

  it('tolerates loose separator spacing', async () => {
    vi.stubGlobal('fetch', reply('第一段\n%%\n第二段'));
    expect(await translateBatch(['One', 'Two'], opts)).toEqual(['第一段', '第二段']);
  });

  it('reports a segment-count mismatch instead of misaligning', async () => {
    vi.stubGlobal('fetch', reply('只有一段'));
    await expect(translateBatch(['One', 'Two', 'Three'], opts)).rejects.toBeInstanceOf(
      SegmentMismatchError,
    );
  });

  it('sends a single paragraph without separator handling', async () => {
    const fetchMock = reply('一段文字');
    vi.stubGlobal('fetch', fetchMock);
    expect(await translateBatch(['One'], opts)).toEqual(['一段文字']);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).not.toContain('%%');
  });
});

describe('reply cleaning', () => {
  it('strips a reasoning scratchpad', async () => {
    vi.stubGlobal('fetch', reply('<think>Let me consider this.</think>实际译文'));
    expect(await translateBatch(['x'], opts)).toEqual(['实际译文']);
  });

  it('strips a scratchpad with no opening tag', async () => {
    vi.stubGlobal('fetch', reply('musing about the sentence</think>实际译文'));
    expect(await translateBatch(['x'], opts)).toEqual(['实际译文']);
  });

  it('unwraps a fenced reply', async () => {
    vi.stubGlobal('fetch', reply('```\n实际译文\n```'));
    expect(await translateBatch(['x'], opts)).toEqual(['实际译文']);
  });

  it('drops a conversational preamble', async () => {
    vi.stubGlobal('fetch', reply('Here is the translation: 实际译文'));
    expect(await translateBatch(['x'], opts)).toEqual(['实际译文']);
  });
});

describe('request shape', () => {
  it('appends /chat/completions and authorises', async () => {
    const fetchMock = reply('译文');
    vi.stubGlobal('fetch', fetchMock);
    await translateBatch(['x'], opts);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('disables thinking for DeepSeek V4', async () => {
    const fetchMock = reply('译文');
    vi.stubGlobal('fetch', fetchMock);
    await translateBatch(['x'], {
      ...opts,
      provider: { ...provider, model: 'deepseek-v4-flash' },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('omits temperature for reasoning models', async () => {
    const fetchMock = reply('译文');
    vi.stubGlobal('fetch', fetchMock);
    await translateBatch(['x'], { ...opts, provider: { ...provider, model: 'gpt-5-mini' } });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning_effort).toBe('minimal');
  });

  it('puts the page title in the system prompt as context', async () => {
    const fetchMock = reply('译文');
    vi.stubGlobal('fetch', fetchMock);
    await translateBatch(['x'], { ...opts, context: { title: 'Rust Ownership' } });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).toContain('Rust Ownership');
  });
});

describe('errors', () => {
  it('explains an auth failure without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(translateBatch(['x'], opts)).rejects.toThrow(/Invalid API key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when no key is set', async () => {
    const fetchMock = reply('译文');
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      translateBatch(['x'], { ...opts, provider: { ...provider, apiKey: '' } }),
    ).rejects.toBeInstanceOf(TranslateError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty completion', async () => {
    vi.stubGlobal('fetch', reply('   '));
    await expect(translateBatch(['x'], opts)).rejects.toThrow(/Empty response/);
  });
});

/**
 * Requesting an exact segment count invites a model that merged two captions
 * to invent a filler segment so the arithmetic works out. The count check
 * cannot see it — only the content is wrong — so the filler is recognised.
 */
describe('padding placeholders', () => {
  const cases = ['<blank>', '(empty)', '[no translation]', 'N/A', 'blank', '无内容'];

  for (const filler of cases) {
    it(`treats ${filler} as no translation`, async () => {
      vi.stubGlobal('fetch', reply(`真正的译文\n\n%%\n\n${filler}`));
      expect(await translateBatch(['One', 'Two'], opts)).toEqual(['真正的译文', '']);
    });
  }

  it('keeps a translation that merely contains the word', async () => {
    vi.stubGlobal('fetch', reply('这一段是空白的说明'));
    expect(await translateBatch(['A blank line'], opts)).toEqual(['这一段是空白的说明']);
  });

  it('tells the model not to pad the count', async () => {
    const fetchMock = reply('一\n\n%%\n\n二');
    vi.stubGlobal('fetch', fetchMock);
    await translateBatch(['One', 'Two'], opts);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).toContain('Never emit a placeholder');
  });
});

describe('rules by mode', () => {
  async function promptFor(options: TranslateOptions) {
    const fetchMock = reply('译文');
    vi.stubGlobal('fetch', fetchMock);
    await translateBatch(['One'], options);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    return body.messages[0].content as string;
  }

  /** Captions are plain text; describing markers invites the model to mint one. */
  it('does not mention inline markers to a subtitle', async () => {
    const prompt = await promptFor({ ...opts, subtitle: true });
    expect(prompt).not.toContain('<b0>');
    expect(prompt).toContain('video subtitle');
  });

  it('still explains inline markers for prose', async () => {
    const prompt = await promptFor(opts);
    expect(prompt).toContain('<b0>');
  });

  it('numbers the rules contiguously in either mode', async () => {
    for (const options of [opts, { ...opts, subtitle: true }]) {
      const prompt = await promptFor(options);
      const numbers = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });
});
