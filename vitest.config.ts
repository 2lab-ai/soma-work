import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
      // The model-commands tests below were quarantined in an earlier cleanup
      // PR because they appeared to assert behavior the validator didn't
      // implement (e.g. MANAGE_SKILL `rename`). The real root cause was stale
      // compiled `*.js`/`*.d.ts` artifacts accidentally committed into
      // `packages/process-shared/src/model-commands/`, which shadowed the
      // up-to-date `*.ts` during module resolution. Those artifacts are now
      // removed (and git-ignored), so these tests run against the real source.
      'packages/mcp-servers/server-tools/server-tools-mcp-server.test.ts',
      'packages/mcp-servers/slack-mcp/slack-mcp-contract.test.ts',
      'packages/mcp-servers/slack-mcp/slack-mcp-cross-thread.test.ts',
    ],
  },
});
