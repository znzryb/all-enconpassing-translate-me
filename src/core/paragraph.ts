/**
 * Splits a document into translation units.
 *
 * A unit is a run of inline content that reads as one paragraph to a human.
 * The walk descends through block containers and stops at the deepest block
 * whose children are all inline — that node owns the paragraph. Where a
 * container mixes bare text with block children (`<div>intro<p>…</p></div>`),
 * each inline run becomes its own unit so the intro text is not lost.
 */

import {
  BLOCK_TAGS, INLINE_TAGS, OPAQUE_TAGS, BLOCK_OPAQUE_TAGS, DROP_TAGS, SKIP_SELECTORS,
  NO_TRANSLATE_PATTERNS, MIN_TEXT_LENGTH,
  BLOCK_MIN_TEXT_COUNT, BLOCK_MIN_WORD_COUNT, CJK_MIN_TEXT_COUNT,
  HEADING_SELECTORS, CLS,
} from './dom-rules';
import { looksLikeCode } from './code-detect';

export interface Unit {
  id: number;
  /** Element the translation is appended to. */
  container: Element;
  /** The inline nodes forming this paragraph, in document order. */
  nodes: Node[];
  /** True when `nodes` covers every child of `container`. */
  whole: boolean;
  /** Prose gets its own line; interface text is appended on the same line. */
  block: boolean;
  /** Markup handed to the model, with inline tags reduced to `<b0>` markers. */
  html: string;
  /** Plain text, for length gates and language detection. */
  text: string;
  marks: Mark[];
  /** Set once a translation has been rendered. */
  done?: boolean;
}

export interface Mark {
  /** Self-closing marks stand in for opaque content the model must not see. */
  selfClosing: boolean;
  /**
   * The original element, restored by cloning rather than by re-parsing
   * markup. Cloning keeps the node exactly as the page built it — an SVG
   * formula, a highlighted code span — and keeps page-authored content out of
   * the sanitiser, which only needs to police what the model wrote.
   */
  node?: Element;
  open?: string;
  close?: string;
}

/** Stands in for an opaque node until the real one is cloned back into place. */
export const SLOT_TAG = 'aetm-slot';

let nextUnitId = 1;

export function collectUnits(root: Element): Unit[] {
  const out: Unit[] = [];
  walk(root, out);
  return out;
}

function walk(el: Element, out: Unit[]): void {
  if (shouldSkipElement(el)) return;

  let run: Node[] = [];
  const flush = () => {
    if (run.length) {
      const unit = buildUnit(el, run, false);
      if (unit) out.push(unit);
      run = [];
    }
  };

  let sawBlockChild = false;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Whitespace between two blocks is layout, not content.
      if (child.textContent?.trim()) run.push(child);
      else if (run.length) run.push(child);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const child_ = child as Element;

    // Our own wrappers are inline <font> elements sitting right beside the
    // source. Without this guard a rescan would collect the translation as
    // source text and translate it again on every mutation.
    if (child_.classList.contains(CLS.wrapper)) continue;

    if (DROP_TAGS.has(child_.tagName)) continue;

    // Untranslatable *block* content ends the paragraph just as any block
    // would. A code listing is not part of the sentence next to it.
    if (BLOCK_OPAQUE_TAGS.has(child_.tagName)) {
      sawBlockChild = true;
      flush();
      // A <pre> holding prose rather than code — an input/output spec, English
      // pseudocode — is content, so it is walked into like any other container.
      if (!isUntranslatableBlock(child_)) walk(child_, out);
      continue;
    }

    // Opaque *inline* content joins the run as a placeholder and is never
    // descended into. Checking this before asking whether the element is a
    // block is what keeps an inline formula from cutting its sentence in half:
    // a rendered formula is a <span> wrapping an <svg>, and treating that
    // <svg> as a block boundary splits the paragraph at every formula.
    if (isOpaque(child_)) {
      run.push(child_);
      continue;
    }

    if (isInline(child_) && !hasBlockDescendant(child_)) {
      run.push(child_);
    } else {
      sawBlockChild = true;
      flush();
      walk(child_, out);
    }
  }

  if (!sawBlockChild && run.length) {
    // Every child is inline: the element itself is the paragraph, which lets
    // the translation sit inside it and inherit its styling.
    const unit = buildUnit(el, run, true);
    if (unit) out.push(unit);
    return;
  }
  flush();
}

function buildUnit(container: Element, nodes: Node[], whole: boolean): Unit | null {
  // Trim whitespace-only nodes from both ends so the insertion point is tight.
  let start = 0;
  let end = nodes.length - 1;
  while (start <= end && isBlank(nodes[start]!)) start++;
  while (end >= start && isBlank(nodes[end]!)) end--;
  if (start > end) return null;
  const trimmed = nodes.slice(start, end + 1);

  const text = trimmed.map((n) => n.textContent ?? '').join('').trim();
  if (!isTranslatableText(text)) return null;

  const { html, marks } = serialize(trimmed);
  if (!html.trim()) return null;

  // A run of nothing but placeholders — a standalone formula, a lone image —
  // has no prose to translate, and asking would only invite the model to
  // invent some.
  const prose = html.replace(/<\/?b\d+\s*\/?>/g, '').trim();
  if (!/\p{L}/u.test(prose) || prose.length < MIN_TEXT_LENGTH) return null;

  return {
    id: nextUnitId++,
    container,
    nodes: trimmed,
    whole,
    block: isProse(prose) || (whole && safeMatches(container, HEADING_SELECTORS)),
    html,
    text,
    marks,
  };
}

/**
 * Prose earns its own line; interface text is appended inline.
 *
 * The distinction is length, not markup: a `<div>` holding "Submit" is a
 * button no matter how it is built, and a translation stacked under it grows
 * the box downward into whatever sits below. Appending on the same line grows
 * it sideways instead, which is the direction such a container already flexes.
 */
function isProse(text: string): boolean {
  // CJK writes no spaces, so word counting would call any sentence one word,
  // and a dozen characters is already a full sentence rather than a label.
  if (/[一-鿿぀-ヿ가-힯]/.test(text)) return text.length >= CJK_MIN_TEXT_COUNT;
  if (text.length < BLOCK_MIN_TEXT_COUNT) return false;
  return text.split(/\s+/).filter(Boolean).length >= BLOCK_MIN_WORD_COUNT;
}

/**
 * Serializes inline nodes into compact markup: every element becomes a
 * numbered `<bN>` marker. Opaque elements collapse to `<bN/>` so their content
 * never reaches the model, which is what keeps code spans and math intact.
 */
function serialize(nodes: Node[]): { html: string; marks: Mark[] } {
  const marks: Mark[] = [];

  const emit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node as Element;
    const index = marks.length;

    if (isOpaque(el)) {
      marks.push({ selfClosing: true, node: el });
      return `<b${index}/>`;
    }

    const attrs = Array.from(el.attributes)
      .map((a) => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`)
      .join('');
    const tag = el.tagName.toLowerCase();
    marks.push({ selfClosing: false, open: `<${tag}${attrs}>`, close: `</${tag}>` });

    const inner = Array.from(el.childNodes).map(emit).join('');
    if (!inner.trim()) {
      // An element with no text (a spacer, an icon) carries no meaning for the
      // model; keep it verbatim rather than asking for a translation of "".
      marks[index] = { selfClosing: true, node: el };
      return `<b${index}/>`;
    }
    return `<b${index}>${inner}</b${index}>`;
  };

  return { html: nodes.map(emit).join('').trim(), marks };
}

/** Rebuilds real markup from a translated string containing `<bN>` markers. */
export function deserialize(translated: string, marks: Mark[]): string {
  const used = new Set<number>();

  let html = translated
    // Attributes are tolerated but discarded: a model that decorates a marker
    // should not break it, and anything it invents there is untrusted — the
    // real attributes live in `mark.open`.
    .replace(/<b(\d+)(?:\s[^>]*?)?\s*\/>/g, (m, n: string) => {
      const mark = marks[Number(n)];
      if (!mark?.selfClosing) return m;
      used.add(Number(n));
      return `<${SLOT_TAG} data-n="${n}"></${SLOT_TAG}>`;
    })
    .replace(/<b(\d+)(?:\s[^>]*?)?>/g, (m, n: string) => {
      const mark = marks[Number(n)];
      if (!mark || mark.selfClosing) return m;
      used.add(Number(n));
      return mark.open ?? '';
    })
    .replace(/<\/b(\d+)>/g, (m, n: string) => {
      const mark = marks[Number(n)];
      if (!mark || mark.selfClosing) return m;
      return mark.close ?? '';
    });

  // A model that dropped an opaque marker would silently delete an image or a
  // code span, so anything unused is appended rather than lost.
  const dropped = marks
    .map((mark, i) =>
      mark.selfClosing && !used.has(i) ? `<${SLOT_TAG} data-n="${i}"></${SLOT_TAG}>` : '',
    )
    .filter(Boolean);
  if (dropped.length) html += dropped.join('');

  // Strip any marker the model invented or mangled beyond repair.
  return html.replace(/<\/?b\d+(?:\s[^>]*?)?\s*\/?>/g, '');
}

/**
 * Whether a block-level element holds content no one should translate.
 *
 * Every tag in `BLOCK_OPAQUE_TAGS` qualifies except `<pre>`, which is decided
 * by what is inside it: "preformatted" is a typographic claim, not a statement
 * that the content is source code.
 */
function isUntranslatableBlock(el: Element): boolean {
  if (!BLOCK_OPAQUE_TAGS.has(el.tagName)) return false;
  if (el.tagName !== 'PRE') return true;
  // A syntax-highlighted listing announces itself; no need to read it.
  if (safeMatches(el, SKIP_SELECTORS)) return true;
  return looksLikeCode(el.textContent ?? '');
}

function shouldSkipElement(el: Element): boolean {
  if (DROP_TAGS.has(el.tagName) || OPAQUE_TAGS.has(el.tagName)) return true;
  if (isUntranslatableBlock(el)) return true;
  if (el.classList.contains(CLS.wrapper) || el.closest(`.${CLS.wrapper}`)) return true;
  if (safeMatches(el, SKIP_SELECTORS)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

function isInline(el: Element): boolean {
  if (INLINE_TAGS.has(el.tagName)) return true;
  if (BLOCK_TAGS.has(el.tagName)) return false;
  // Unknown tag (a web component, a custom element): trust the computed style.
  const display = getComputedStyle(el).display;
  return display.startsWith('inline') || display === 'contents' || display === 'ruby';
}

/**
 * Whether descending into this element would cross a real block boundary.
 *
 * Opaque and dropped descendants are invisible to this question — they are
 * already handled as placeholders or discarded, so letting them count as
 * blocks would fragment sentences that merely contain a formula or an icon.
 */
function hasBlockDescendant(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (DROP_TAGS.has(child.tagName) || isOpaque(child)) continue;
    if (BLOCK_OPAQUE_TAGS.has(child.tagName)) return true;
    if (!isInline(child) || hasBlockDescendant(child)) return true;
  }
  return false;
}

function isOpaque(el: Element): boolean {
  if (OPAQUE_TAGS.has(el.tagName)) return true;
  return safeMatches(el, SKIP_SELECTORS);
}

/** `matches` throws on a malformed selector in some engines; never let it. */
function safeMatches(el: Element, selectors: string): boolean {
  try {
    return el.matches(selectors);
  } catch {
    return false;
  }
}

function isBlank(node: Node): boolean {
  return !node.textContent?.trim();
}

function isTranslatableText(text: string): boolean {
  if (text.length < MIN_TEXT_LENGTH) return false;
  if (NO_TRANSLATE_PATTERNS.some((re) => re.test(text))) return false;
  return /\p{L}/u.test(text);
}

function escapeText(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Cheap script-ratio language guess. Enough to answer "is this already the
 * target language?" without shipping a detection model.
 */
export function looksLikeLanguage(text: string, lang: string): boolean {
  const letters = text.match(/\p{L}/gu);
  if (!letters?.length) return false;
  const cjk = text.match(/[一-鿿㐀-䶿]/g)?.length ?? 0;
  const kana = text.match(/[぀-ヿ]/g)?.length ?? 0;
  const hangul = text.match(/[가-힯]/g)?.length ?? 0;
  const cyrillic = text.match(/[Ѐ-ӿ]/g)?.length ?? 0;
  const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
  const total = letters.length;
  const base = lang.split('-')[0];

  switch (base) {
    case 'zh': return cjk / total > 0.5 && kana / total < 0.1;
    case 'ja': return (kana + cjk) / total > 0.5 && kana > 0;
    case 'ko': return hangul / total > 0.4;
    case 'ru': return cyrillic / total > 0.5;
    case 'en': return latin / total > 0.85 && cjk === 0 && kana === 0 && hangul === 0;
    default: return latin / total > 0.8 && cjk === 0;
  }
}
