import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      exclude: ['src/generated/**', 'build/**', 'vitest.config.ts'],
    },
  },
});
