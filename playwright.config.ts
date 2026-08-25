import {defineConfig, devices} from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  webServer: {
    command:
      'PORT=4190 LINGGO_API_PORT=4190 LINGGO_CLIENT_PORT=5190 LINGGO_DB_PATH=:memory: LINGGO_FAKE_KATAGO=1 pnpm dev',
    url: 'http://127.0.0.1:5190',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {baseURL: 'http://127.0.0.1:5190', trace: 'on-first-retry'},
  projects: [
    {name: 'desktop', use: {...devices['Desktop Chrome']}},
    {name: 'mobile', use: {...devices['iPhone 13'], browserName: 'chromium'}},
  ],
})
