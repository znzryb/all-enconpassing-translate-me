/**
 * MAIN-world network hook for video subtitles.
 *
 * Subtitle tracks are fetched by the player itself, usually only once the
 * viewer turns captions on, and the URL carries short-lived signed parameters.
 * Refetching it from the extension would mean reproducing that signing, so
 * instead both `XMLHttpRequest` and `fetch` are wrapped here and the response
 * body is forwarded — read-only, never modified — to the isolated world.
 *
 * This runs in MAIN because the page's own `fetch` must be the one wrapped;
 * an isolated-world script sees a different global. It has no extension APIs,
 * so `postMessage` is the only channel back.
 */

const CHANNEL = 'aetm-subtitle';

/** Track URLs across the players we understand. */
const SUBTITLE_URL_RE = /\/api\/timedtext|\.vtt(\?|$)|\/subtitles?\/|caption|\.ttml(\?|$)|\.srt(\?|$)/i;

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    const post = (url: string, body: string) => {
      if (!body || body.length > 4_000_000) return;
      window.postMessage({ source: CHANNEL, url, body }, '*');
    };

    const isSubtitle = (url: string) => {
      try {
        return SUBTITLE_URL_RE.test(url);
      } catch {
        return false;
      }
    };

    // --- XMLHttpRequest ----------------------------------------------------
    const openOriginal = XMLHttpRequest.prototype.open;
    const sendOriginal = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      const url = args[1];
      (this as XMLHttpRequest & { __aetmUrl?: string }).__aetmUrl =
        typeof url === 'string' ? url : (url as URL | undefined)?.href;
      return openOriginal.apply(this, args as Parameters<typeof openOriginal>);
    };

    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      const url = (this as XMLHttpRequest & { __aetmUrl?: string }).__aetmUrl;
      if (url && isSubtitle(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status === 200 && typeof this.responseText === 'string') {
              post(absolute(url), this.responseText);
            }
          } catch {
            // responseType was arraybuffer/blob: nothing readable for us here.
          }
        });
      }
      return sendOriginal.apply(this, args as Parameters<typeof sendOriginal>);
    };

    // --- fetch -------------------------------------------------------------
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await fetchOriginal.call(this, input as RequestInfo, init);
      if (url && isSubtitle(url) && response.ok) {
        // Clone so the player still gets an unread body.
        response
          .clone()
          .text()
          .then((text) => post(absolute(url), text))
          .catch(() => {});
      }
      return response;
    };

    function absolute(url: string): string {
      try {
        return new URL(url, location.href).href;
      } catch {
        return url;
      }
    }
  },
});
