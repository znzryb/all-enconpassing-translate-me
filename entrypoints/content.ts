import '../src/core/inject.css';
import { PageTranslator } from '../src/core/page';
import { hostMatches, isConfigured, loadSettings, onSettingsChanged, type Settings } from '../src/core/settings';
import { installSubtitles } from '../src/core/subtitle/controller';
import type { Message, StatusResponse } from '../src/shared/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  cssInjectionMode: 'manifest',

  async main() {
    // Content scripts default to the top frame only, which is what we want:
    // ad and widget iframes are not worth translating, and a single instance
    // per tab keeps the popup's status readout unambiguous.
    const settings = await loadSettings();
    const host = location.hostname;

    if (hostMatches(settings.blockedHosts, host)) return;

    let current: Settings = settings;
    const page = new PageTranslator(current, () => {});

    onSettingsChanged((next) => {
      current = next;
      page.updateSettings(next);
    });

    if (window.top === window) {
      installSubtitles(() => current);
    }

    chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
      switch (message.type) {
        case 'toggle-translate':
          page.toggle();
          break;
        case 'cycle-state':
          page.cycleState();
          break;
        case 'set-state':
          page.setState(message.state);
          break;
        case 'get-status':
          break;
        default:
          return false;
      }
      sendResponse(status());
      return false;
    });

    function status(): StatusResponse {
      const stats = page.stats;
      return {
        active: page.active,
        state: page.state,
        translated: stats.translated,
        pending: stats.pending,
        failed: stats.failed,
        lastError: stats.lastError,
        configured: isConfigured(current),
        host,
        autoTranslate: hostMatches(current.autoTranslateHosts, host),
        blocked: hostMatches(current.blockedHosts, host),
      };
    }

    if (hostMatches(current.autoTranslateHosts, host) && isConfigured(current)) {
      page.start();
    }
  },
});
