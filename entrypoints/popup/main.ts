import { LANG_NAMES } from '../../src/core/llm';
import {
  PROVIDER_PRESETS, isConfigured, loadSettings, saveSettings,
  type ProviderId, type Settings,
} from '../../src/core/settings';
import { sendToTab, type Message, type StatusResponse } from '../../src/shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  host: $<HTMLSpanElement>('host'),
  setup: $<HTMLDivElement>('setup'),
  setupBtn: $<HTMLButtonElement>('setup-btn'),
  main: $<HTMLElement>('main'),
  toggle: $<HTMLButtonElement>('toggle'),
  toggleLabel: $<HTMLSpanElement>('toggle-label'),
  lang: $<HTMLSelectElement>('lang'),
  provider: $<HTMLSelectElement>('provider'),
  subtitles: $<HTMLInputElement>('subtitles'),
  auto: $<HTMLInputElement>('auto'),
  blocked: $<HTMLInputElement>('blocked'),
  status: $<HTMLSpanElement>('status'),
  settings: $<HTMLButtonElement>('settings'),
};

let settings: Settings;
let tabId: number | undefined;
let host = '';

void init();

async function init(): Promise<void> {
  settings = await loadSettings();

  for (const [code, name] of Object.entries(LANG_NAMES)) {
    els.lang.append(new Option(name, code));
  }
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    els.provider.append(new Option(preset.label, id));
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  host = safeHost(tab?.url);
  els.host.textContent = host || 'This page';

  wire();
  render(await status());
}

async function status(): Promise<StatusResponse | undefined> {
  if (tabId == null) return undefined;
  return sendToTab<StatusResponse>(tabId, { type: 'get-status' });
}

async function send(message: Message): Promise<void> {
  if (tabId == null) return;
  const res = await sendToTab<StatusResponse>(tabId, message);
  render(res);
}

function wire(): void {
  els.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.setupBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  els.toggle.addEventListener('click', () => void send({ type: 'toggle-translate' }));

  for (const button of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
    button.addEventListener('click', () => {
      const state = button.dataset.state as 'dual' | 'translation' | 'original';
      void send({ type: 'set-state', state });
    });
  }

  els.lang.addEventListener('change', async () => {
    settings = await saveSettings({ targetLang: els.lang.value });
  });

  els.provider.addEventListener('change', async () => {
    settings = await saveSettings({ provider: els.provider.value as ProviderId });
    render(await status());
  });

  // Applies to the video already playing: the controller watches this setting
  // and hands the player's own captions back when it goes off.
  els.subtitles.addEventListener('change', async () => {
    settings = await saveSettings({ subtitleEnabled: els.subtitles.checked });
  });

  els.auto.addEventListener('change', async () => {
    settings = await saveSettings({
      autoTranslateHosts: toggleHost(settings.autoTranslateHosts, host, els.auto.checked),
      // The two lists are mutually exclusive; enabling one clears the other.
      blockedHosts: els.auto.checked
        ? toggleHost(settings.blockedHosts, host, false)
        : settings.blockedHosts,
    });
    els.blocked.checked = settings.blockedHosts.includes(host);
  });

  els.blocked.addEventListener('change', async () => {
    settings = await saveSettings({
      blockedHosts: toggleHost(settings.blockedHosts, host, els.blocked.checked),
      autoTranslateHosts: els.blocked.checked
        ? toggleHost(settings.autoTranslateHosts, host, false)
        : settings.autoTranslateHosts,
    });
    els.auto.checked = settings.autoTranslateHosts.includes(host);
  });
}

function render(s: StatusResponse | undefined): void {
  const configured = s?.configured ?? isConfigured(settings);
  els.setup.classList.toggle('hidden', configured);
  els.main.classList.toggle('hidden', !configured);

  els.lang.value = settings.targetLang;
  els.provider.value = settings.provider;
  els.subtitles.checked = settings.subtitleEnabled;
  els.auto.checked = settings.autoTranslateHosts.includes(host);
  els.blocked.checked = settings.blockedHosts.includes(host);

  const active = s?.active ?? false;
  els.toggle.classList.toggle('on', active);
  els.toggleLabel.textContent = active ? 'Stop and restore original' : 'Translate this page';

  const state = s?.state ?? 'original';
  for (const button of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
    button.setAttribute('aria-pressed', String(button.dataset.state === state));
  }

  if (!s) {
    els.status.textContent = 'Not available on this page';
    els.status.classList.remove('err');
    return;
  }
  if (s.lastError) {
    els.status.textContent = s.lastError.slice(0, 60);
    els.status.classList.add('err');
    return;
  }
  els.status.classList.remove('err');
  els.status.textContent = active
    ? `${s.translated} translated${s.pending ? ` · ${s.pending} pending` : ''}`
    : 'Idle';

  // Keep the counters live while a translation is streaming in.
  if (active && s.pending > 0) setTimeout(async () => render(await status()), 700);
}

function toggleHost(list: string[], value: string, on: boolean): string[] {
  const without = list.filter((h) => h !== value);
  return on && value ? [...without, value] : without;
}

function safeHost(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith('http') ? parsed.hostname : '';
  } catch {
    return '';
  }
}
