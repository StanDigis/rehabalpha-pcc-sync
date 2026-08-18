import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env['CI'],
    env: {
      ...process.env,
      NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
      OPS_CONSOLE_DEV_BYPASS: '1',
      FIRESTORE_EMULATOR_HOST: process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099',
      GCLOUD_PROJECT: process.env['GCLOUD_PROJECT'] ?? 'rehabalpha-pcc-sync-demo',
    },
  },
});
