import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  manifest: {
    name: 'All-Encompassing Translate Me',
    short_name: 'AETM',
    description:
      'AI-only bilingual web translation. Bring your own DeepSeek / OpenAI key — no accounts, no quotas, no telemetry.',
    permissions: ['storage', 'contextMenus', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'All-Encompassing Translate Me',
    },
    commands: {
      'toggle-translate': {
        suggested_key: { default: 'Alt+A' },
        description: 'Translate / restore this page',
      },
      'cycle-display': {
        suggested_key: { default: 'Alt+W' },
        description: 'Cycle bilingual / translation-only / original',
      },
    },
  },
});
