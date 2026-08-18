/** Typed message protocol between content scripts, popup, and the background worker. */

import type { DisplayState } from '../core/dom-rules';

export interface TranslateJob {
  texts: string[];
  targetLang: string;
  title?: string;
  subtitle?: boolean;
  /**
   * Narrows the cache key. Set where the same source text translates
   * differently depending on surrounding context — subtitles pass the video's
   * identity so one video's wording is never replayed over another's.
   */
  scope?: string;
}

export type Message =
  /** content/popup → background: run one batch through the model. */
  | { type: 'translate'; job: TranslateJob }
  /** popup → content: start or stop translating this page. */
  | { type: 'toggle-translate' }
  | { type: 'set-state'; state: DisplayState }
  | { type: 'cycle-state' }
  /** popup → content: report what is happening on this tab. */
  | { type: 'get-status' }
  /** content → background: verify credentials from the options page. */
  | { type: 'test-connection' }
  | { type: 'open-options' };

export interface TranslateResponse {
  ok: boolean;
  translations?: string[];
  error?: string;
  /** True when the model broke the `%%` contract and one-by-one retry is worth it. */
  mismatch?: boolean;
}

export interface StatusResponse {
  active: boolean;
  state: DisplayState;
  translated: number;
  pending: number;
  failed: number;
  configured: boolean;
  host: string;
  autoTranslate: boolean;
  blocked: boolean;
  lastError?: string;
}

export function sendToBackground<T>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export async function sendToTab<T>(tabId: number, message: Message): Promise<T | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch {
    // No content script on this tab (chrome:// pages, the web store, a tab that
    // has not finished loading). Callers treat undefined as "not available".
    return undefined;
  }
}
