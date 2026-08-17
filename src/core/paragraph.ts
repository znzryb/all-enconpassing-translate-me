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
  BLOCK_TAGS, INLINE_TAGS, OPAQUE_TAGS, SKIP_TAGS, SKIP_SELECTORS,
  NO_TRANSLATE_PATTERNS, MIN_TEXT_LENGTH, MIN_BLOCK_TEXT_LENGTH, CLS,
} from './dom-rules';

export interface Unit {
  id: number;
  /** Element the translation is appended to. */
  container: Element;
  /** The inline nodes forming this paragraph, in document order. */
  nodes: Node[];
  /** True when `nodes` covers every child of `container`. */
  whole: boolean;
  /** Markup handed to the model, with inline tags reduced to `<b0>` markers. */
  html: string;
  /** Plain text, for length gates and language detection. */
  text: string;
  marks: Mark[];
  /** Set once a translation has been rendered. */
  done?: boolean;
}

interface Mark {
  /** Self-closing marks stand in for opaque content the model must not see. */
  selfClosing: boolean;
  /** Verbatim markup restored for a self-closing mark. */
  html?: string;
  open?: string;
  close?: string;
}

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
  if (!isTranslatableText(text, container)) return null;

  const { html, marks } = serialize(trimmed);
  if (!html.trim()) return null;

  return { id: nextUnitId++, container, nodes: trimmed, whole, html, text, marks };
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
      marks.push({ selfClosing: true, html: el.outerHTML });
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
      marks[index] = { selfClosing: true, html: el.outerHTML };
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
    .replace(/<b(\d+)\s*\/>/g, (m, n: string) => {
      const mark = marks[Number(n)];
      if (!mark?.selfClosing) return m;
      used.add(Number(n));
      return mark.html ?? '';
    })
    .replace(/<b(\d+)>/g, (m, n: string) => {
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
    .map((mark, i) => (mark.selfClosing && !used.has(i) ? mark.html ?? '' : ''))
    .filter(Boolean);
  if (dropped.length) html += dropped.join('');

  // Strip any marker the model invented or mangled beyond repair.
  return html.replace(/<\/?b\d+\s*\/?>/g, '');
}

function shouldSkipElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.classList.contains(CLS.wrapper) || el.closest(`.${CLS.wrapper}`)) return true;
  if (el.matches(SKIP_SELECTORS)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

function isInline(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return false;
  if (INLINE_TAGS.has(el.tagName)) return true;
  if (BLOCK_TAGS.has(el.tagName)) return false;
  // Unknown tag (a web component): trust the computed display.
  const display = getComputedStyle(el).display;
  return display.startsWith('inline') || display === 'contents' || display === 'ruby';
}

function hasBlockDescendant(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (!isInline(child) || hasBlockDescendant(child)) return true;
  }
  return false;
}

function isOpaque(el: Element): boolean {
  if (OPAQUE_TAGS.has(el.tagName)) return true;
  return el.matches(SKIP_SELECTORS);
}

function isBlank(node: Node): boolean {
  return !node.textContent?.trim();
}

function isTranslatableText(text: string, container: Element): boolean {
  if (text.length < MIN_TEXT_LENGTH) return false;
  if (NO_TRANSLATE_PATTERNS.some((re) => re.test(text))) return false;
  // Chrome ships block-level defaults for these; short strings inside them are
  // usually chrome (buttons, badges) rather than prose.
  const tag = container.tagName;
  if ((tag === 'BUTTON' || tag === 'OPTION' || tag === 'LABEL') && text.length < MIN_BLOCK_TEXT_LENGTH) {
    return false;
  }
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
