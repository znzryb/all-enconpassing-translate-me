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

    // The opaque node is restored by cloning at render time, so deserialize
    // leaves a slot behind rather than re-parsed markup. See render.test.ts.
    const restored = deserialize('运行 <b0/> 开始。', unit.marks);
    expect(restored).toBe('运行 <aetm-slot data-n="0"></aetm-slot> 开始。');
    expect(unit.marks[0]!.node!.textContent).toBe('npm install');
  });

  it('re-attaches an opaque marker the model dropped', () => {
    const units = scan('<p>See the <img src="/a.png" alt="chart"> above here.</p>');
    const restored = deserialize('见上方图表。', units[0]!.marks);
    expect(restored).toContain('aetm-slot data-n="0"');
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

describe('inline formulas must not break a paragraph', () => {
  // Regression: Codeforces renders $$$x$$$ as <span class="MathJax_SVG"><svg>.
  // Because SVG was in the skip set, the wrapping span read as "has a block
  // descendant" and split the sentence at every formula, producing
  // "You are given an array ¦给你一个数组 a of length ¦，长度为 n. For each ¦…".
  it('keeps a MathJax 2 SVG formula inside the sentence', () => {
    const units = scan(
      '<p>You are given an array <span class="MathJax_SVG"><svg><g></g></svg></span>' +
        ' of length <span class="MathJax_SVG"><svg><g></g></svg></span>. For each ' +
        '<span class="MathJax_SVG"><svg><g></g></svg></span> find the maximum distance.</p>',
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.html).toBe(
      'You are given an array <b0/> of length <b1/>. For each <b2/> find the maximum distance.',
    );
  });

  it('keeps a MathJax 3 container inside the sentence', () => {
    const units = scan(
      '<p>For each <mjx-container class="MathJax"><mjx-math></mjx-math></mjx-container>' +
        ' we want to find the answer.</p>',
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.html).toBe('For each <b0/> we want to find the answer.');
  });

  it('keeps a KaTeX formula inside the sentence', () => {
    const units = scan(
      '<p>The value <span class="katex"><span class="katex-mathml">x</span></span>' +
        ' is bounded above.</p>',
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.html).toBe('The value <b0/> is bounded above.');
  });

  it('keeps inline code and images inside the sentence', () => {
    const units = scan(
      '<p>Call <code>fn()</code> then check <img src="/a.png"> before the retry.</p>',
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.html).toBe('Call <b0/> then check <b1/> before the retry.');
  });

  it('still splits on a genuine block element', () => {
    const units = scan('<div>Intro sentence here.<p>Body sentence here.</p></div>');
    expect(units.map((u) => u.text)).toEqual(['Intro sentence here.', 'Body sentence here.']);
  });

  it('drops a run that is nothing but opaque placeholders', () => {
    const units = scan('<p><code>npm install</code></p><p>Real prose follows here.</p>');
    expect(units.map((u) => u.text)).toEqual(['Real prose follows here.']);
  });
});

describe('layout: own line vs same line', () => {
  // Regression: a translation stacked under a content-sized button grew the box
  // downward and collided with the element below it. Short interface text has
  // to continue on the same line so the container widens instead.
  it('appends short button text on the same line', () => {
    const units = scan('<a class="btn">Jump to VJudge</a>');
    expect(units).toHaveLength(1);
    expect(units[0]!.block).toBe(false);
  });

  it('keeps nav and label text on the same line', () => {
    expect(scan('<button>Submit</button>')[0]!.block).toBe(false);
    expect(scan('<div class="badge">Finished</div>')[0]!.block).toBe(false);
    expect(scan('<span>time limit per test</span>')[0]!.block).toBe(false);
  });

  it('gives a real sentence its own line', () => {
    const units = scan('<p>You are given an array of length n and a target value.</p>');
    expect(units[0]!.block).toBe(true);
  });

  it('gives a long heading its own line', () => {
    const units = scan('<h1>National Taiwan University Class Preliminary 2026</h1>');
    expect(units[0]!.block).toBe(true);
  });

  it('counts CJK source text by length, not by words', () => {
    // No spaces to split on, so word counting would call this one word.
    const units = scan('<p>这是一段足够长的中文句子用来测试分块行为。</p>');
    expect(units[0]!.block).toBe(true);
  });

  it('measures prose length excluding placeholders', () => {
    // The formula contributes no prose, so this stays interface-sized.
    const units = scan('<div>Jump to <span class="katex"><span>x</span></span></div>');
    expect(units[0]!.block).toBe(false);
  });
});

describe('headings always take their own line', () => {
  it('gives a short heading its own line despite the length gate', () => {
    // "D. Distinct Numbers" is 19 chars / 3 words — interface-sized by length,
    // but appending beside it reads as one run-on title.
    expect(scan('<h2>D. Distinct Numbers</h2>')[0]!.block).toBe(true);
    expect(scan('<div class="title">D. Distinct Numbers</div>')[0]!.block).toBe(true);
    expect(scan('<h1>Input</h1>')[0]!.block).toBe(true);
  });

  it('does not promote a short label that merely sits inside a heading', () => {
    // The run here is partial (a block sibling follows), so it is not the
    // heading itself and stays inline.
    const units = scan('<h2>Tag<div class="sub">Nested block</div></h2>');
    expect(units[0]!.block).toBe(false);
  });
});

describe('code blocks are boundaries, not inline content', () => {
  // Regression (nowcoder): <pre> was classed as opaque *inline* content, so a
  // pseudocode block merged into the sentence after it as "<b0/>Note that…".
  // The translation then expanded that placeholder back into the whole code
  // block, flattened onto one line ahead of the Chinese text.
  it('does not merge a pre block into the following text', () => {
    const units = scan(
      '<div><pre>dp():\n  Let q be an empty queue\n  Return counter</pre>' +
        'Note that the same vertex may be pushed into the queue multiple times.</div>',
    );
    const note = units.find((u) => u.text.startsWith('Note that'))!;
    expect(note).toBeDefined();
    expect(note.container.tagName).not.toBe('PRE');
    // The listing must not be carried along inside the sentence's unit.
    expect(note.html).toBe(
      'Note that the same vertex may be pushed into the queue multiple times.',
    );
  });

  it('does not merge a pre block into the preceding text', () => {
    const units = scan(
      '<div>The algorithm works as follows.<pre>while true:\n  step()</pre></div>',
    );
    expect(units.map((u) => u.text)).toEqual(['The algorithm works as follows.']);
  });

  it('leaves a standalone code block entirely alone', () => {
    expect(scan('<pre>int main() { return 0; }</pre>')).toHaveLength(0);
    expect(scan('<pre><code>npm install</code></pre>')).toHaveLength(0);
  });

  it('still treats other block media as boundaries', () => {
    const units = scan(
      '<div>Watch this demonstration.<video src="/a.mp4"></video>Then read the notes below.</div>',
    );
    expect(units.map((u) => u.text)).toEqual([
      'Watch this demonstration.',
      'Then read the notes below.',
    ]);
  });

  it('keeps inline code inside the sentence, unlike a pre block', () => {
    const units = scan('<p>Call <code>fn()</code> before the retry begins.</p>');
    expect(units).toHaveLength(1);
    expect(units[0]!.html).toBe('Call <b0/> before the retry begins.');
  });
});

describe('marker robustness', () => {
  it('tolerates a marker the model decorated with attributes', () => {
    const units = scan('<p>Read the <a href="/docs">documentation</a> first.</p>');
    const restored = deserialize('先阅读<b0 class="x">文档</b0>。', units[0]!.marks);
    // The original attributes win; anything the model added is discarded.
    expect(restored).toBe('先阅读<a href="/docs">文档</a>。');
  });

  it('tolerates a decorated self-closing marker', () => {
    const units = scan('<p>Run <code>fn()</code> before the retry.</p>');
    const restored = deserialize('先运行 <b0 lang="en"/>。', units[0]!.marks);
    expect(restored).toContain('aetm-slot data-n="0"');
  });
});

describe('a <pre> holding prose is translated', () => {
  // <pre> means "preformatted", not "source code". Judges set their input and
  // output specifications in one, and those are written for a human to read.
  const SPEC =
    'Output the answer for each test case in order.\n\n' +
    'If no valid construction exists, output a single line containing the integer -1.\n\n' +
    'Otherwise, first output a line containing two integers n and m, the number of\n' +
    'vertices and edges in the constructed graph, respectively.';

  it('translates an output specification set in a pre', () => {
    const units = scan(`<pre>${SPEC}</pre>`);
    expect(units.length).toBeGreaterThan(0);
    expect(units[0]!.text).toContain('Output the answer for each test case');
    expect(units[0]!.container.tagName).toBe('PRE');
  });

  it('keeps line structure in the text handed to the model', () => {
    const units = scan(`<pre>${SPEC}</pre>`);
    // Newlines must survive: the translation is rendered inside the <pre>,
    // where they are what preserves the layout.
    expect(units[0]!.html).toContain('\n');
  });

  it('still leaves real source code alone', () => {
    const cpp =
      '#include <iostream>\nusing namespace std;\n\nvoid solve() {\n    long long k;\n    cin >> k;\n}';
    expect(scan(`<pre>${cpp}</pre>`)).toHaveLength(0);
    expect(scan(`<pre><code>${cpp}</code></pre>`)).toHaveLength(0);
  });

  it('leaves a syntax-highlighted listing alone without reading it', () => {
    const units = scan(
      '<pre class="highlight">Let this look like ordinary English prose here.</pre>',
    );
    expect(units).toHaveLength(0);
  });

  it('does not translate sample input data', () => {
    expect(scan('<pre>3\n1 2\n2 3\n1 3</pre>')).toHaveLength(0);
  });

  it('handles formulas inside a prose pre', () => {
    const units = scan(
      '<pre>The first line contains an integer <span class="katex">t</span>, ' +
        'the number of test cases in this file.</pre>',
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.html).toContain('<b0/>');
  });
});
