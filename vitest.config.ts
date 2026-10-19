import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Strip deployment env (SOMA_CONFIG_DIR, DATA_DIR, AUTH_MODE, credentials)
    // and pin config/data to a scratch dir, so a run on a host that also runs
    // soma-work can neither read its .env nor write into its data dir.
    globalSetup: ['./src/test-utils/vitest-global-setup.ts'],
    setupFiles: ['./src/test-utils/vitest-setup.ts'],
    include: [
      'src/**/*.test.ts',
      'somalib/**/*.test.ts',
      'packages/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      // Do not quarantine test files here: an excluded file silently drops out
      // of CI (`test:release` uses this config). Fix a failing test, or delete
      // it with evidence that it is a duplicate or tests dead code.
    ],
  },
});
