import {defineConfig, devices} from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  webServer: {
    command: 'LINGGO_DB_PATH=:memory: LINGGO_FAKE_KATAGO=1 pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {baseURL: 'http://127.0.0.1:5173', trace: 'on-first-retry'},
  projects: [
    {name: 'desktop', use: {...devices['Desktop Chrome']}},
    {name: 'mobile', use: {...devices['iPhone 13'], browserName: 'chromium'}},
  ],
})
