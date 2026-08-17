# How Immersive Translate works, and what this project took from it

Notes from reading the shipped Chrome extension (`1.32.1`, id
`bpoadfkcbjbfhfodiogcnhhhpibjhbnh`) to understand the mechanics of in-place
bilingual translation.

**Nothing here is copied code.** The bundle is minified and its
`default_config.json` is a proprietary data asset. What was taken is
*mechanism* — the shape of the problem and the approaches that solve it — which
was then implemented from scratch. Where a fact is simply true of HTML (a
`<span>` is inline), it is stated directly; where their specific tuning was
instructive, it is noted as such and our own value chosen independently.

## Anatomy of the extension

| Path | Size | What it is |
|---|---:|---|
| `default_config.json` | 491 KB | The real asset: 774 site rules + a 166-key `generalRule` |
| `content_main.js` | 3.4 MB | Minified content script |
| `styles/inject.css` | 18 KB | Translation styling, ~12 themes |
| `video-subtitle/inject.js` | 11 KB | MAIN-world network hook |
| `wasm/`, `tesseract/`, `aifw/` | ~19 MB | On-device OCR and image translation |

Total ≈ 40 MB. Ours is 81 KB, because it does one thing.

## 1. Paragraph splitting

The interesting problem: a paragraph is not a DOM node. `<p>Some <a>link</a>
text</p>` is one paragraph across three nodes, and `<div>intro<p>body</p></div>`
is two paragraphs in one container.

Their `generalRule` classifies tags into sets — `allBlockTags` (53 entries),
`inlineTags` (47), `stayOriginalTags` (`CODE`, `IMG`, `SUP`, math elements),
`excludeTags` (`SCRIPT`, `STYLE`, `PRE`, `TEXTAREA`) — plus length gates
(`paragraphMinTextCount: 2`, `blockMinTextCount: 24`) and a `noTranslateRegexp`
list that discards "3 min ago" and lone glyphs.

**What we do:** the same classification idea in `src/core/dom-rules.ts`, with
the walk in `src/core/paragraph.ts` descending to the deepest block whose
children are all inline. Mixed containers emit one unit per inline run, so the
bare `intro` text is not lost — a case worth having tests for, and it has them.

## 2. Inline markup survival

A paragraph handed to a model as raw HTML comes back with mangled attributes and
occasionally with the contents of a `<code>` span helpfully "translated".

Their approach is visible in the config: `enableRichTranslate`, and telling
entries in `noTranslateRegexp` like `<img id=0>` and `<canvas id=0>` — inline
elements are replaced by numbered placeholders before the request.

**What we do:** every inline element becomes `<b0>…</b0>`, and anything opaque
(code, images, math) collapses to a self-closing `<b0/>` whose contents the
model never sees. This is strictly better than sending real HTML: fewer tokens,
nothing to mangle, and a guarantee that code spans come back byte-identical.
`deserialize()` re-attaches any opaque marker the model dropped, because a
silently deleted image is worse than a clumsy translation.

## 3. Batching over the wire

From `translationServices.ai`:

- `translationTextSeparator: "\n\n%%\n\n"` — paragraphs are concatenated into
  one request and split back out of one reply
- `maxTextGroupLengthPerRequest: 4`
- A system prompt carrying `{{title_prompt}}` / `{{summary_prompt}}`, i.e. page
  metadata is fed in as context
- `ignoreResRegexs` — a list of refusal phrases ("抱歉…我无法", "I'm sorry, but
  I cannot") to detect a model that declined

**What we do:** the same `%%` protocol (`src/core/llm.ts`), defaulting to 6
paragraphs per request, with the page title as context. Two additions:

- A segment-count mismatch **throws** rather than being patched up. The
  background then retries the batch one paragraph at a time. Guessing at
  alignment risks putting paragraph 3's translation under paragraph 2, which is
  the one failure a reader is guaranteed to notice.
- Reasoning is explicitly disabled per model family. Their config does this too
  (`thinking: {type: disabled}` for `deepseek-v4-*`, `reasoning_effort` for GPT-5).

## 4. Rendering

`targetWrapperTag: "font"` — a detail worth stealing. `<font>` is obsolete,
carries no default styling, and essentially no site stylesheet targets it, so
the injected translation inherits the paragraph's typography instead of
fighting it.

Display state lives in one attribute on `<html>` (`imt-state="dual" |
"translation" | "original"`), so toggling views is one attribute write. Their
`inject.css` has ~12 themes; `dividingLine` draws a short dashed rule above the
translation via `::before`.

**What we do:** the same `<font>` wrapper and the same attribute-driven state
(`aetm-state`), with five themes. One deliberate divergence: their CSS has no
rule for hiding the source in translation-only mode, so they appear to remove or
replace source nodes in JS. We instead blank text nodes (stashing the values)
and class element nodes — the DOM keeps its shape, so site CSS like `p > a`
keeps matching.

## 5. Lazy translation

`deferredRenderRootMargin: "0% 0px 35% 0px"`, `visibleObserverScreens: [0,0,2,0]`
— an IntersectionObserver translates ahead of the scroll position rather than
translating the whole page or only what is on screen.

**What we do:** the same, defaulting to 1.5 screens of lookahead, with the queue
drained in document order so each request's paragraphs are adjacent and the
model gets genuine context.

## 6. Deciding whether a `<pre>` is code

`<pre>` means "preformatted", not "source code". Judges set their input/output
specifications in one, docs use it for ASCII tables, and pseudocode written in
English lives there too — all of it worth translating. Real source code is not.

Their answer is a hand-maintained table. `PRE` sits in the global
`excludeTags`, and **44 site rules** take it back out with
`excludeTags.remove`. Two supporting knobs appear alongside it:

- `likePreSelectors` (21 sites) marks elements that must keep their whitespace
  even when they are not `<pre>` — Twitter lists `[data-testid=tweetText]`,
  because tweet line breaks are meaningful.
- `isTransformPreTagNewLine` (31 sites) converts newlines to `<br>` so the
  layout survives translation.

**What we do:** a rule table is not reproducible here, so the decision is made
from the content (`src/core/code-detect.ts`): classify each line as code or
prose and let the majority win. Code lines are recognised by statement
terminators, braces doing structural work, declarations, preprocessor
directives, shell prompts, and operators that essentially never occur in prose;
prose lines by carrying three or more plain words. Ties go to "code", because
translating a listing is a visible corruption whereas leaving prose
untranslated is only a missed opportunity.

Line breaks need no `<br>` transform in our case: the translation is rendered
*inside* the `<pre>`, so it inherits `white-space: pre` and the newlines in the
model's reply lay themselves out. The system prompt asks for line structure to
be preserved.

## 7. Video subtitles

The nicest trick in the extension, in `video-subtitle/inject.js`.

Subtitle tracks are fetched by the player, often only once captions are enabled,
from URLs carrying short-lived signed parameters. Refetching them from the
extension would mean reproducing that signing. So they inject a MAIN-world
script that wraps `XMLHttpRequest.prototype.open/send` and `globalThis.fetch`,
matches subtitle URLs against a per-site `subtitleUrlRegExp` (YouTube:
`/api/timedtext`), and — this is the clever part — **rewrites the response**:

```js
Object.defineProperty(xhr, 'responseText', { value: translatedSubtitles })
```

The player then renders bilingual subtitles believing they came from the server.
For sites needing more control they instead hide the native caption layer
(`.ytp-caption-window-container { display: none }`) and draw their own.

**What we do:** the same MAIN-world hook, read-only — the response is forwarded
to the isolated world, never modified. We always draw our own overlay rather
than rewriting the track, because the bilingual two-line layout should not be at
the mercy of each player's line-wrapping.

One thing worth copying from their config: auto-generated tracks repeat each
line as it builds up word by word. Deduplicating by start time (keeping the
longest) is what makes the translation cost sane — otherwise every line is
translated five times.

## What was deliberately left out

Machine-translation engines (Google/Bing/DeepL/…), accounts and quotas, PDF and
EPUB translation, OCR image translation, the AI writing assistant, the side
panel, and the 774 per-site rules. The site rules are the part that would take
real time to rebuild; the generic splitter handles ordinary article pages well,
and per-site tuning can be added when a specific site misbehaves.
