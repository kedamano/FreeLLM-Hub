import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'tests/e2e'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/core/**/*.ts', 'src/scheduler/**/*.ts', 'src/usage/**/*.ts', 'src/renderer/**/*.{ts,tsx}'],
      exclude: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**', '**/index.ts'],
    },
  },
});
