import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web-unit',
    root: import.meta.dirname,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
});
