/**
 * Renders translations into the page.
 *
 * Every translation lives in a `<font>` wrapper: `<font>` has no default
 * styling and virtually no site stylesheet targets it, so the injected node
 * inherits the paragraph's typography instead of fighting it. Show/hide is
 * driven entirely by an attribute on `<html>`, which means toggling between
 * bilingual, translation-only, and original costs one attribute write rather
 * than a DOM walk.
 */

import { CLS, STATE_ATTR, WRAPPER_TAG, type DisplayState } from './dom-rules';
import { SLOT_TAG, deserialize, type Mark, type Unit } from './paragraph';
import type { ThemeId } from './settings';

const wrappers = new Map<number, HTMLElement>();
const rendered = new Map<number, Unit>();
/** Original text-node values, stashed while translation-only mode is active. */
const stashed = new Map<Text, string>();

export function setDisplayState(state: DisplayState): void {
  document.documentElement.setAttribute(STATE_ATTR, state);
  if (state === 'translation') hideSources();
  else restoreSources();
}

export function getDisplayState(): DisplayState {
  return (document.documentElement.getAttribute(STATE_ATTR) as DisplayState) ?? 'original';
}

/**
 * Translation-only mode hides the source in place rather than unwrapping it:
 * element nodes get a class, text nodes have their value stashed and blanked.
 * Wrapping them in a container instead would change the DOM shape and quietly
 * break site CSS like `p > a`.
 */
function hideSources(): void {
  for (const unit of rendered.values()) {
    if (!unit.done) continue;
    for (const node of unit.nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node as Text;
        if (!stashed.has(text)) {
          stashed.set(text, text.nodeValue ?? '');
          text.nodeValue = '';
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        (node as Element).classList.add(CLS.sourceHidden);
      }
    }
  }
}

function restoreSources(): void {
  for (const [text, value] of stashed) text.nodeValue = value;
  stashed.clear();
  for (const el of document.querySelectorAll(`.${CLS.sourceHidden}`)) {
    el.classList.remove(CLS.sourceHidden);
  }
}

/** Inserts a placeholder so the reader sees progress while the request is out. */
export function renderPending(unit: Unit, theme: ThemeId): void {
  if (wrappers.has(unit.id)) return;
  const wrapper = createWrapper(unit, theme);
  wrapper.classList.add(CLS.loading);
  wrapper.appendChild(dots());
  insert(unit, wrapper);
  wrappers.set(unit.id, wrapper);
  rendered.set(unit.id, unit);
}

export function renderTranslation(unit: Unit, translated: string): void {
  const wrapper = wrappers.get(unit.id);
  if (!wrapper) return;
  const html = deserialize(translated, unit.marks);

  wrapper.classList.remove(CLS.loading, CLS.error);
  wrapper.textContent = '';

  const inner = document.createElement(WRAPPER_TAG);
  inner.className = CLS.inner;
  // Parsed in an inert document so no script or handler in the model's output
  // can execute, then imported node-by-node after a tag/attribute filter.
  inner.append(...sanitize(html));
  fillSlots(inner, unit.marks);
  wrapper.appendChild(inner);

  unit.done = true;
  (unit.container as HTMLElement).classList.add(CLS.translated);
  // A unit finishing while translation-only is already active still needs its
  // source hidden, otherwise it renders bilingual until the next toggle.
  if (getDisplayState() === 'translation') hideSources();
}

export function renderError(unit: Unit, message: string): void {
  const wrapper = wrappers.get(unit.id);
  if (!wrapper) return;
  wrapper.classList.remove(CLS.loading);
  wrapper.classList.add(CLS.error);
  wrapper.textContent = message;
  wrapper.title = message;
}

/** Drops a pending placeholder, e.g. when a paragraph turns out to be skippable. */
export function discard(unit: Unit): void {
  wrappers.get(unit.id)?.remove();
  wrappers.delete(unit.id);
  rendered.delete(unit.id);
}

export function removeAll(): void {
  restoreSources();
  for (const w of wrappers.values()) w.remove();
  wrappers.clear();
  rendered.clear();
  for (const el of document.querySelectorAll(`.${CLS.translated}`)) el.classList.remove(CLS.translated);
  // Catch wrappers left behind by a previous page state (bfcache, SPA nav).
  for (const el of document.querySelectorAll(`.${CLS.wrapper}`)) el.remove();
}

export function hasTranslations(): boolean {
  return wrappers.size > 0;
}

function createWrapper(unit: Unit, theme: ThemeId): HTMLElement {
  const wrapper = document.createElement(WRAPPER_TAG);
  // Layout follows the text, not the DOM: `block` is decided by how much prose
  // the unit holds, while `whole` only decides where the node is inserted.
  wrapper.className = `${CLS.wrapper} ${unit.block ? CLS.block : CLS.inline} aetm-theme-${theme}`;
  wrapper.dataset.aetmId = String(unit.id);
  wrapper.setAttribute('translate', 'no');
  wrapper.setAttribute('dir', 'auto');
  return wrapper;
}

function insert(unit: Unit, wrapper: HTMLElement): void {
  const last = unit.nodes[unit.nodes.length - 1]!;
  if (unit.whole) {
    unit.container.appendChild(wrapper);
  } else {
    last.parentNode?.insertBefore(wrapper, last.nextSibling);
  }
}

function dots(): HTMLElement {
  const el = document.createElement(WRAPPER_TAG);
  el.className = 'aetm-dots';
  el.innerHTML = '<i></i><i></i><i></i>';
  return el;
}

/**
 * Restores opaque content by cloning the original nodes into their slots.
 *
 * Page-authored content deliberately bypasses the sanitiser: it came from the
 * page, so it needs no policing, and running it through a tag whitelist would
 * strip exactly the markup that makes it worth preserving — an `<svg>` formula
 * flattened to nothing, a `<pre>` listing unwrapped into one unbroken line.
 */
function fillSlots(root: Element, marks: Mark[]): void {
  for (const slot of Array.from(root.querySelectorAll(SLOT_TAG))) {
    const index = Number((slot as HTMLElement).dataset.n);
    const original = marks[index]?.node;
    if (original) slot.replaceWith(original.cloneNode(true));
    else slot.remove();
  }
}

/** Tags the model is allowed to emit. Anything else is unwrapped to its text. */
const ALLOWED = new Set([
  'A', 'ABBR', 'B', 'BR', 'CITE', 'CODE', 'DEL', 'EM', 'I', 'IMG', 'INS', 'KBD',
  'MARK', 'Q', 'RB', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG',
  'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'FONT',
  SLOT_TAG.toUpperCase(),
]);
const ALLOWED_ATTRS = new Set(['href', 'title', 'src', 'alt', 'class', 'dir', 'lang', 'width', 'height']);

function sanitize(html: string): Node[] {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;
  clean(doc.body);
  return Array.from(doc.body.childNodes).map((n) => document.importNode(n, true));
}

function clean(root: Element): void {
  for (const el of Array.from(root.children)) {
    clean(el);
    if (!ALLOWED.has(el.tagName)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    // The slot's data-n is how it finds its node; it never reaches the page.
    if (el.tagName === SLOT_TAG.toUpperCase()) continue;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const bad = !ALLOWED_ATTRS.has(name) || /^javascript:/i.test(attr.value.trim());
      if (bad) el.removeAttribute(attr.name);
    }
  }
}
