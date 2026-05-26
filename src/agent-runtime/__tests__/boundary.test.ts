/**
 * Agent-runtime boundary guard (ADR 0002, pass 1).
 *
 * Pass 1 establishes the dependency direction:
 *   • One-shot caller helpers MUST go through `src/agent-runtime/` and MUST
 *     NOT import `@anthropic-ai/claude-agent-sdk` runtime values directly.
 *   • The Claude Code adapter is the *only* file under `src/agent-runtime/`
 *     that imports the SDK runtime.
 *   • `type`-only imports of the SDK are tolerated as a transitional
 *     concession — they are erased at runtime and don't violate the
 *     dependency boundary. They will be removed in a later pass.
 *
 * If this test fails, a new one-shot call site has been wired straight to
 * the SDK and bypassed the port. Route it through `runOneShotText` instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

const ONE_SHOT_HELPERS = [
  'src/conversation/summarizer.ts',
  'src/conversation/title-generator.ts',
  'src/conversation/instructions-summarizer.ts',
  'src/slack/z/topics/memory-improve.ts',
] as const;

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/**
 * Match any `import ... from '@anthropic-ai/claude-agent-sdk'` that is NOT a
 * pure `import type` statement. Mixed-mode imports like
 * `import { type Options, query } from '...'` are runtime imports (the
 * `query` symbol is brought in at runtime) and therefore count as
 * boundary violations.
 */
function findRuntimeSdkImports(src: string): string[] {
  const lines = src.split('\n');
  const offenders: string[] = [];
  for (const line of lines) {
    if (!line.includes(SDK_PKG)) continue;
    // Skip pure `import type ... from '...'` and `export type ... from '...'`.
    if (/^\s*import\s+type\b/.test(line)) continue;
    if (/^\s*export\s+type\b/.test(line)) continue;
    if (/from\s+['"]@anthropic-ai\/claude-agent-sdk['"]/.test(line)) {
      offenders.push(line.trim());
    }
  }
  return offenders;
}

describe('agent-runtime boundary (ADR 0002, pass 1)', () => {
  it('exposes runOneShotText from the public surface', async () => {
    const mod = await import('../index');
    expect(typeof mod.runOneShotText).toBe('function');
  });

  it.each(ONE_SHOT_HELPERS)('%s does not import the Claude Code SDK runtime', (relPath) => {
    const src = readRepoFile(relPath);
    const offenders = findRuntimeSdkImports(src);
    expect(offenders, `runtime SDK import in ${relPath}`).toEqual([]);
  });

  it('the Claude Code adapter is allowed to import the SDK (it is the adapter)', () => {
    const src = readRepoFile('src/agent-runtime/claude-code-runner.ts');
    const offenders = findRuntimeSdkImports(src);
    expect(offenders.length).toBeGreaterThan(0);
  });
});
