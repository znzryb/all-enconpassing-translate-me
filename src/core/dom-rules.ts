/**
 * Tag / selector classification used by the paragraph splitter.
 *
 * The sets below were derived by studying how Immersive Translate's
 * `generalRule` classifies nodes (see docs/reference-immersive.md). The values
 * are facts about HTML semantics rather than borrowed code — a `<span>` is
 * inline and a `<section>` is a block no matter who writes the splitter.
 */

/** Elements that establish their own block; a paragraph never spans across them. */
export const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'BUTTON', 'CANVAS',
  'CONTENT', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'NOSCRIPT', 'OL', 'OPTION', 'P',
  'PICTURE', 'PRE', 'SECTION', 'SELECT', 'SOURCE', 'SUMMARY', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'TR', 'UL', 'VIDEO',
]);

/** Elements that flow inside a paragraph and are sent to the model as inline HTML. */
export const INLINE_TAGS = new Set([
  'A', 'ABBR', 'ACRONYM', 'B', 'BDO', 'BIG', 'CITE', 'CODE', 'DEL', 'DFN', 'EM',
  'FONT', 'I', 'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'NOBR', 'Q', 'RB', 'RP',
  'RT', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U',
  'VAR', 'WBR',
]);

/**
 * Elements whose content must survive the round-trip byte-for-byte.
 *
 * These are swapped for `<b{n}/>` placeholders before the request and restored
 * afterwards, so the model never sees — and so can never mangle — their
 * content. Critically, an opaque element does *not* end the paragraph it sits
 * in: an inline formula or code span is part of the sentence around it.
 */
export const OPAQUE_TAGS = new Set([
  'CODE', 'IMG', 'KBD', 'SAMP', 'SUB', 'SUP', 'TT', 'VAR', 'MATH', 'SVG',
  'CANVAS', 'MJX-CONTAINER', 'D-MATH', 'PRE', 'IFRAME', 'VIDEO', 'AUDIO',
  'OBJECT', 'DATETIME',
]);

/**
 * Elements dropped outright — they hold no prose, so they neither translate
 * nor belong in a placeholder.
 */
export const DROP_TAGS = new Set([
  'BASE', 'HEAD', 'INPUT', 'LINK', 'MAP', 'META', 'NOSCRIPT', 'OPTION',
  'SCRIPT', 'SELECT', 'STYLE', 'TEMPLATE', 'TEXTAREA', 'TITLE', 'TRACK',
]);

/**
 * Content treated as opaque by selector rather than tag name.
 *
 * Rendered maths is the important case: MathJax 2 emits
 * `<span class="MathJax_SVG"><svg>`, MathJax 3 emits `<mjx-container>`, and
 * KaTeX emits `<span class="katex">`. All three sit *inside* a sentence, so
 * they must be placeholders rather than paragraph boundaries.
 */
export const SKIP_SELECTORS = [
  '.notranslate',
  '.no-translate',
  '[translate="no"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[aria-hidden="true"]',
  '[role="code"]',
  '[data-aetm-skip]',
  'code',
  'pre',
  // maths, across every renderer in common use
  '.katex',
  '.katex-display',
  '[class^="MathJax"]',
  '[class*=" MathJax"]',
  '[id^="MathJax-Element"]',
  'mjx-container',
  '.math-block',
  '.math-inline',
  '.mwe-math-element',
  '.ltx_Math',
  // code blocks
  '.highlight',
  '.prism-code',
  '.hljs',
  '[class*="codeBlock"]',
  '[class*="code-block"]',
  // icon fonts
  '.material-icons',
  '.material-symbols-outlined',
  '[class^="material-symbols-"]',
  'i.fa',
  'i[class^="fa-"]',
].join(',');

/**
 * Selectors worth translating even though the generic scan skips their
 * container (nav/header/footer are excluded by default, titles are not).
 */
export const EXTRA_SELECTORS = [
  'h1', 'h2', 'h3', 'h4',
  '.article-title', '.article__title', '.articleTitle',
  '.headline', '.summary', '.subtitle',
];

/** Text that is structurally uninteresting: timestamps, counters, glyphs. */
export const NO_TRANSLATE_PATTERNS: RegExp[] = [
  /^\d+\s*\S*\s*ago$/i,
  /^\d+\s+MIN\s+READ$/i,
  /^[​‌‍⁠﻿]+$/,
  /^[a-zA-Z]$/,
  /^[\d\s.,:;/+\-–—%$€£¥()[\]{}]*$/,
  /^[•·↓↑←→※★☆…]+$/,
  /^#\w+$/,
];

/** Minimum size for a node to be worth a request. */
export const MIN_TEXT_LENGTH = 4;
export const MIN_BLOCK_TEXT_LENGTH = 12;

/**
 * Threshold separating prose from interface text.
 *
 * Prose gets its translation on its own line. Interface text — buttons, labels,
 * nav items, badges — gets it appended on the same line, because those sit in
 * containers sized to their contents: a second line makes the box grow
 * vertically and collide with whatever is laid out beneath it, whereas growing
 * horizontally is what such a container already expects to do.
 */
export const BLOCK_MIN_TEXT_COUNT = 24;
export const BLOCK_MIN_WORD_COUNT = 4;
/** CJK packs far more meaning per character, so its threshold is lower. */
export const CJK_MIN_TEXT_COUNT = 12;

/**
 * Headings always get their own line regardless of length.
 *
 * A heading is content, not a control: it sits on a line of its own already,
 * and appending the translation beside it reads as one run-on title.
 */
export const HEADING_SELECTORS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  '[role="heading"]',
  '.title',
  '.headline',
  '.article-title',
  '.post-title',
].join(',');

/** Wrapper tag: `<font>` carries no default styling and is rarely targeted by site CSS. */
export const WRAPPER_TAG = 'font';

export const CLS = {
  wrapper: 'aetm-target-wrapper',
  block: 'aetm-target-block',
  inline: 'aetm-target-inline',
  inner: 'aetm-target-inner',
  loading: 'aetm-loading',
  error: 'aetm-error',
  /** Marks a source node that already owns a translation. */
  translated: 'aetm-translated',
  /** Applied to source elements while translation-only mode is active. */
  sourceHidden: 'aetm-source-hidden',
} as const;

/** Attribute on `<html>` driving the three display states via CSS alone. */
export const STATE_ATTR = 'aetm-state';
export type DisplayState = 'dual' | 'translation' | 'original';
