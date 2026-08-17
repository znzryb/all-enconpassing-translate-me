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
 * Inline elements whose content must survive the round-trip byte-for-byte.
 * They are swapped for `<b{n}>` placeholders before the request and restored
 * afterwards, so the model never sees (and so can never mangle) their text.
 */
export const OPAQUE_TAGS = new Set([
  'CODE', 'IMG', 'KBD', 'SAMP', 'SUB', 'SUP', 'TT', 'VAR', 'MATH', 'SVG',
  'MJX-CONTAINER', 'D-MATH',
]);

/** Never descend into these — no translatable prose lives inside. */
export const SKIP_TAGS = new Set([
  'AUDIO', 'BASE', 'CANVAS', 'DATETIME', 'HEAD', 'IFRAME', 'INPUT', 'LINK',
  'MAP', 'META', 'NOSCRIPT', 'OBJECT', 'PRE', 'SCRIPT', 'STYLE', 'SVG',
  'TEMPLATE', 'TEXTAREA', 'TITLE', 'TRACK', 'VIDEO',
]);

/** Structural opt-outs honoured by convention across the web. */
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
  '.katex',
  '.MathJax',
  '.MathJax_Display',
  '.math-block',
  '.mwe-math-element',
  '.highlight',
  '.prism-code',
  '.hljs',
  '[class*="codeBlock"]',
  '[class*="code-block"]',
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

/** Minimum size for a node to be worth a request, mirroring the upstream gates. */
export const MIN_TEXT_LENGTH = 4;
export const MIN_BLOCK_TEXT_LENGTH = 12;

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
