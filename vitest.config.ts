import { defineConfig } from 'vitest/config';

/**
 * Test suites are split by the infrastructure they need, because that determines
 * where they can run and how fast the feedback loop is:
 *
 *   core, pcc-client, web-unit  pure/mocked, no emulator, run on every save
 *   sync, functions, rules      require the Firebase emulator suite (and a JDK 21+)
 *
 * `npm test` runs only the first group so the inner loop stays sub-second.
 * `npm run test:emulator` boots the emulators once and runs the second group.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'pcc-client',
          root: './packages/pcc-client',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          // Transformers and policy glue: pure functions over recorded PCC payloads, no emulator.
          name: 'sync-unit',
          root: './packages/sync',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'sync-emulator',
          root: './packages/sync',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'functions',
          root: './apps/functions',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'rules',
          root: './tests/rules',
          environment: 'node',
          include: ['**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      './apps/web/vitest.config.mts',
    ],
  },
});
