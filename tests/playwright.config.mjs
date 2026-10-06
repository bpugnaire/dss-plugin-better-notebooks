import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'reliability.browser.spec.mjs', workers: 1,
  use: { headless: true, baseURL: 'http://127.0.0.1:4178', viewport: { width: 1440, height: 1000 } },
  webServer: { command: 'node tests/preview-server.mjs', cwd: new URL('..', import.meta.url).pathname, url: 'http://127.0.0.1:4178', reuseExistingServer: false },
  reporter: 'list', outputDir: '../test-results',
});
