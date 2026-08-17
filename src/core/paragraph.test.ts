import { beforeEach, describe, expect, it } from 'vitest';
import { collectUnits, deserialize, looksLikeLanguage } from './paragraph';

function scan(html: string) {
  document.body.innerHTML = html;
  return collectUnits(document.body);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('unit boundaries', () => {
  it('treats each block as its own paragraph', () => {
    const units = scan('<p>The first paragraph here.</p><p>The second paragraph here.</p>');
    expect(units).toHaveLength(2);
    expect(units[0]!.text).toBe('The first paragraph here.');
    expect(units[1]!.text).toBe('The second paragraph here.');
  });

  it('keeps inline children inside one paragraph', () => {
    const units = scan('<p>Some <strong>bold</strong> and <em>italic</em> words here.</p>');
    expect(units).toHaveLength(1);
    expect(units[0]!.text).toBe('Some bold and italic words here.');
    expect(units[0]!.whole).toBe(true);
  });

  it('splits bare text away from block siblings', () => {
    const units = scan('<div>Intro text before it.<p>The nested paragraph.</p></div>');
    expect(units.map((u) => u.text)).toEqual(['Intro text before it.', 'The nested paragraph.']);
    // The intro is a partial run, so its translation is inserted after the run
    // rather than at the end of the container (which would land after the <p>).
    expect(units[0]!.whole).toBe(false);
    expect(units[1]!.whole).toBe(true);
  });

  it('descends to the deepest block, not the outermost', () => {
    const units = scan('<div><section><article><p>Deeply nested text.</p></article></section></div>');
    expect(units).toHaveLength(1);
    expect(units[0]!.container.tagName).toBe('P');
  });

  it('handles list items separately', () => {
    const units = scan('<ul><li>First list entry.</li><li>Second list entry.</li></ul>');
    expect(units.map((u) => u.text)).toEqual(['First list entry.', 'Second list entry.']);
  });
});

describe('exclusions', () => {
  it('skips script, style, and pre', () => {
    const units = scan(
      '<p>Real prose to translate.</p><script>var x = "not prose at all";</script>' +
        '<style>.a { color: red; }</style><pre>preformatted block here</pre>',
    );
    expect(units.map((u) => u.text)).toEqual(['Real prose to translate.']);
  });

  it('honours notranslate and translate="no"', () => {
    const units = scan(
      '<p class="notranslate">Do not translate this.</p><p translate="no">Nor this one.</p>' +
        '<p>But translate this one.</p>',
    );
    expect(units.map((u) => u.text)).toEqual(['But translate this one.']);
  });

  it('skips contenteditable regions', () => {
    const units = scan('<div contenteditable="true"><p>User is typing here.</p></div>');
    expect(units).toHaveLength(0);
  });

  it('drops numeric and glyph-only nodes', () => {
    const units = scan('<p>1,234</p><p>•</p><p>2024-01-01</p><p>Actual prose here.</p>');
    expect(units.map((u) => u.text)).toEqual(['Actual prose here.']);
  });

  it('ignores an already-translated paragraph on rescan', () => {
    document.body.innerHTML = '<p>Original sentence here.</p>';
    const first = collectUnits(document.body);
    expect(first).toHaveLength(1);
    // Simulate a rendered translation, then rescan the same tree.
    const wrapper = document.createElement('font');
    wrapper.className = 'aetm-target-wrapper';
    wrapper.textContent = '原文句子。';
    document.querySelector('p')!.appendChild(wrapper);
    const second = collectUnits(document.body);
    expect(second[0]!.text).toBe('Original sentence here.');
    expect(second[0]!.html).not.toContain('原文句子');
  });
});

describe('inline marker round-trip', () => {
  it('numbers inline elements and restores them', () => {
    const units = scan('<p>Read the <a href="/docs">documentation</a> first.</p>');
    const unit = units[0]!;
    expect(unit.html).toBe('Read the <b0>documentation</b0> first.');

    const restored = deserialize('先阅读<b0>文档</b0>。', unit.marks);
    expect(restored).toBe('先阅读<a href="/docs">文档</a>。');
  });

  it('hides opaque content behind a self-closing marker', () => {
    const units = scan('<p>Run <code>npm install</code> to begin now.</p>');
    const unit = units[0]!;
    expect(unit.html).toBe('Run <b0/> to begin now.');
    expect(unit.html).not.toContain('npm install');

    const restored = deserialize('运行 <b0/> 开始。', unit.marks);
    expect(restored).toBe('运行 <code>npm install</code> 开始。');
  });

  it('re-attaches an opaque marker the model dropped', () => {
    const units = scan('<p>See the <img src="/a.png" alt="chart"> above here.</p>');
    const restored = deserialize('见上方图表。', units[0]!.marks);
    expect(restored).toContain('<img src="/a.png"');
  });

  it('strips markers the model invented', () => {
    const units = scan('<p>Plain sentence with no markup.</p>');
    const restored = deserialize('普通句子<b7>无</b7>标记。', units[0]!.marks);
    expect(restored).toBe('普通句子无标记。');
  });

  it('collapses an empty inline element instead of asking for a translation', () => {
    const units = scan('<p>Text with <span class="icon"></span> an icon here.</p>');
    expect(units[0]!.html).toBe('Text with <b0/> an icon here.');
  });

  it('escapes angle brackets in source text', () => {
    const units = scan('<p>Compare a &lt; b in the code.</p>');
    expect(units[0]!.html).toBe('Compare a &lt; b in the code.');
  });
});

describe('language detection', () => {
  it('recognises text already in the target language', () => {
    expect(looksLikeLanguage('这是一段中文文本内容', 'zh-CN')).toBe(true);
    expect(looksLikeLanguage('This is English text', 'zh-CN')).toBe(false);
    expect(looksLikeLanguage('This is English text', 'en')).toBe(true);
    expect(looksLikeLanguage('これは日本語です', 'ja')).toBe(true);
  });

  it('does not mistake Japanese for Chinese', () => {
    expect(looksLikeLanguage('これは日本語のテキストです', 'zh-CN')).toBe(false);
  });
});
