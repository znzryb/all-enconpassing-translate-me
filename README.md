<div align="center">
  <img src="assets/icon.svg" width="88" alt="">
  <h1>All-Encompassing Translate Me</h1>
  <p><em>Bilingual web translation, powered by your own AI key.</em></p>
</div>

An Immersive-Translate-style browser extension that does one thing: translate
web pages in place with an LLM you pay for directly. No account, no quota, no
subscription tier, no telemetry — you paste a DeepSeek or OpenAI key and it
works.

The whole extension is 81 KB.

## What it does

- **Bilingual pages.** Translations are inserted under each paragraph, keeping
  the original for comparison. Toggle to translation-only or back to the
  original at any time.
- **Translates as you scroll.** Paragraphs are translated about a screen and a
  half ahead of where you are reading, so text is there before you look at it —
  and content you never scroll to costs nothing.
- **Video subtitles.** Turn captions on in the player and get a bilingual
  overlay. Works on YouTube and anything else serving WebVTT, TTML, or SRT.
- **Keeps code and formatting intact.** Links, emphasis, code spans, and math
  are shielded from the model and restored afterwards, byte for byte.
- **Knows prose from code.** A `<pre>` holding an input/output specification or
  English pseudocode is translated; an actual source listing or a block of
  sample data is left alone.
- **Caches.** A revisit or a scroll back up costs no tokens.

## Install

Requires [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `.output/chrome-mv3`.

On macOS, `pnpm install-local` builds and copies to
`~/chrome-extensions/all-encompassing-translate-me` first, which gives Chrome a
stable path to reload from across rebuilds.

## Setup

Open the extension's settings and paste an API key:

| Engine | Get a key | Default model |
|---|---|---|
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | `deepseek-v4-flash` |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-4.1-mini` |
| Custom | any OpenAI-compatible endpoint | — |

Hit **Test connection** to confirm before browsing. The key is stored in
`chrome.storage.local` and is sent only to the endpoint you configured.

## Use

| | |
|---|---|
| <kbd>⌥</kbd><kbd>A</kbd> | Translate the page / restore the original |
| <kbd>⌥</kbd><kbd>W</kbd> | Cycle bilingual → translation-only → original |
| Toolbar icon | Same, plus per-site settings |

Add a site to **Always translate** and it starts on load.

## Settings worth knowing

- **Style** — optional decoration on the translation: none (default), dimmed,
  a dashed box, or a highlighter. Layout is automatic and separate from this:
  prose gets its own line, while short interface text such as a button label is
  appended on the same line so its container widens instead of growing taller
  into whatever sits below it.
- **Extra instructions** — appended to the system prompt. Use it for tone
  ("keep it casual") or terminology ("translate *transformer* as 变换器").
- **Paragraphs per request** — bigger batches mean fewer requests and better
  context, at the cost of a coarser retry when one fails. Default 6.
- **Translate ahead** — how far past the viewport to work, in screen heights.
  Raise it for smoother reading, lower it to spend fewer tokens.

## Development

```bash
pnpm dev       # load .output/chrome-mv3-dev, hot reloads
pnpm test      # 87 tests, no network
pnpm compile   # typecheck
pnpm icons     # re-render assets/icon.svg into PNGs
```

Layout:

```
entrypoints/
  background.ts          model calls, cache, commands
  content.ts             per-page controller
  subtitle-hook.content.ts   MAIN-world network hook
  popup/  options/
src/core/
  paragraph.ts           DOM → translation units
  render.ts              translation units → DOM
  scheduler.ts           viewport-driven queueing
  llm.ts                 chat-completions client, %% batching
  code-detect.ts         tells a code listing from prose in a <pre>
  cache.ts  settings.ts  dom-rules.ts  inject.css
  subtitle/              parsers + bilingual overlay
```

[`docs/reference-immersive.md`](docs/reference-immersive.md) documents how
Immersive Translate solves each of these problems and where this project
deliberately diverges.

## Limitations

- Video subtitles need captions switched on in the player — that fetch is what
  the extension listens for.
- No per-site rules yet. The generic splitter handles article-shaped pages well;
  a heavily custom app may translate too much or too little.
- Telling a prose `<pre>` from a code one is a heuristic over line shape. It is
  deliberately biased towards leaving code alone, so an unusual listing may go
  untranslated rather than risk mangling one.
- Chrome/Edge (MV3) only so far; Firefox support is a WXT config change plus
  testing.
- PDFs, images, and EPUBs are out of scope.

## License

MIT
