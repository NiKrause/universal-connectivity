import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 30_000 },
  webServer: {
    command: 'npm run dev:e2e',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEXT_PUBLIC_E2E_RELAY_MODE: 'isolated',
      NEXT_PUBLIC_ALEPH_DOMAIN: 'connect.nicokrause.com',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
