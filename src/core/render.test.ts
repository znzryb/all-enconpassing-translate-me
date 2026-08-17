import { beforeEach, describe, expect, it } from 'vitest';
import { collectUnits } from './paragraph';
import { removeAll, renderPending, renderTranslation, setDisplayState } from './render';

/** Scans, then renders `translated` for the first unit found. */
function roundTrip(html: string, translated: string) {
  document.body.innerHTML = html;
  const unit = collectUnits(document.body)[0]!;
  renderPending(unit, 'plain');
  renderTranslation(unit, translated);
  return { unit, wrapper: document.querySelector('.aetm-target-wrapper')! };
}

beforeEach(() => {
  removeAll();
  document.documentElement.removeAttribute('aetm-state');
  document.body.innerHTML = '';
});

describe('opaque content survives into the page', () => {
  // Regression: restored placeholders went through the model-output sanitiser,
  // whose tag whitelist unwrapped them — an <svg> formula vanished and a code
  // listing collapsed onto one line. Page content is cloned in instead.
  it('clones an SVG formula back verbatim', () => {
    const { wrapper } = roundTrip(
      '<p>For each <span class="MathJax_SVG"><svg><g id="mi-k"></g></svg></span> find it.</p>',
      '对于每个 <b0/> 找到它。',
    );
    expect(wrapper.querySelector('svg')).not.toBeNull();
    expect(wrapper.querySelector('#mi-k')).not.toBeNull();
    expect(wrapper.textContent).toContain('对于每个');
  });

  it('preserves inline code exactly, including its markup', () => {
    const { wrapper } = roundTrip(
      '<p>Run <code class="lang-sh">npm  install</code> before starting.</p>',
      '开始前先运行 <b0/>。',
    );
    const code = wrapper.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.className).toBe('lang-sh');
    // Whitespace inside the original must not be renormalised.
    expect(code!.textContent).toBe('npm  install');
  });

  it('keeps an image with all of its attributes', () => {
    const { wrapper } = roundTrip(
      '<p>See the <img src="/chart.png" alt="chart" width="40"> above.</p>',
      '见上方 <b0/>。',
    );
    const img = wrapper.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/chart.png');
    expect(img.getAttribute('width')).toBe('40');
  });

  it('re-attaches a placeholder the model dropped rather than losing it', () => {
    const { wrapper } = roundTrip(
      '<p>See the <img src="/chart.png" alt="chart"> above.</p>',
      '见上方图表。',
    );
    expect(wrapper.querySelector('img')).not.toBeNull();
  });

  it('leaves no slot elements behind', () => {
    const { wrapper } = roundTrip(
      '<p>Run <code>fn()</code> and read <code>docs</code> now.</p>',
      '运行 <b0/> 并阅读 <b1/>。',
    );
    expect(wrapper.querySelector('aetm-slot')).toBeNull();
    expect(wrapper.querySelectorAll('code')).toHaveLength(2);
  });
});

describe('model output is still sanitised', () => {
  it('strips a script the model emitted', () => {
    const { wrapper } = roundTrip(
      '<p>A perfectly ordinary sentence here.</p>',
      '译文<script>alert(1)</script>结束。',
    );
    expect(wrapper.querySelector('script')).toBeNull();
    expect(wrapper.textContent).toContain('译文');
  });

  it('strips event handlers and javascript: URLs', () => {
    const { wrapper } = roundTrip(
      '<p>Read the <a href="/docs">documentation</a> first.</p>',
      '先阅读<b0 onclick="steal()">文档</b0>。',
    );
    const link = wrapper.querySelector('a')!;
    expect(link.getAttribute('onclick')).toBeNull();
    expect(link.getAttribute('href')).toBe('/docs');
  });
});

describe('display state', () => {
  it('hides the source in translation-only mode and restores it', () => {
    const { unit } = roundTrip('<p>An ordinary English sentence.</p>', '一句普通的英文句子。');
    const source = unit.nodes[0] as Text;

    setDisplayState('translation');
    expect(source.nodeValue).toBe('');

    setDisplayState('dual');
    expect(source.nodeValue).toBe('An ordinary English sentence.');
  });

  it('removeAll takes every wrapper back out', () => {
    roundTrip('<p>An ordinary English sentence.</p>', '一句普通的英文句子。');
    expect(document.querySelectorAll('.aetm-target-wrapper')).toHaveLength(1);
    removeAll();
    expect(document.querySelectorAll('.aetm-target-wrapper')).toHaveLength(0);
    expect(document.body.textContent).toContain('An ordinary English sentence.');
  });
});

describe('translations inside a preformatted block', () => {
  const SPEC =
    'Output the answer for each test case in order.\n\n' +
    'If no valid construction exists, output -1 on a single line.';

  it('renders the translation inside the pre, keeping its line breaks', () => {
    const { wrapper } = roundTrip(
      `<pre>${SPEC}</pre>`,
      '按顺序输出每个测试用例的答案。\n\n如果不存在有效的构造，则单独一行输出 -1。',
    );
    // Living inside the <pre> is what makes the newlines render as line
    // breaks, since it inherits white-space: pre.
    expect(wrapper.closest('pre')).not.toBeNull();
    expect(wrapper.textContent).toContain('\n\n');
    expect(wrapper.textContent).toContain('按顺序输出');
  });

  it('gives the translation its own line rather than appending inline', () => {
    const { wrapper } = roundTrip(`<pre>${SPEC}</pre>`, '译文内容在这里，足够长可以独立成块。');
    expect(wrapper.classList.contains('aetm-target-block')).toBe(true);
  });
});
