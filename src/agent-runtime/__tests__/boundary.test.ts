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
 *
 * Matches multi-line imports too:
 *   import {
 *     type Options,
 *     query,
 *   } from '@anthropic-ai/claude-agent-sdk';
 * by anchoring on the `from '...'` end of the statement and walking back
 * to the preceding `import` / `export` keyword.
 */
function findRuntimeSdkImports(src: string): string[] {
  // Greedy match: an `import` or `export` keyword, then any chars (including
  // newlines) up to `from '@anthropic-ai/claude-agent-sdk'`. `[\s\S]*?` is
  // non-greedy so adjacent statements don't collapse.
  const stmtRe = new RegExp(
    `(^|\\n)\\s*(import|export)\\b([\\s\\S]*?)from\\s+['"]${SDK_PKG.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['"]`,
    'g',
  );
  const offenders: string[] = [];
  for (const m of src.matchAll(stmtRe)) {
    // Capture the keyword and the bindings-block in between.
    const keyword = m[2];
    const bindings = m[3] ?? '';
    // Pure `import type {...}` / `export type {...}` is a type-only import →
    // erased at runtime, not a boundary violation. Anything else (including
    // `import { type X, runtimeSymbol }`) is a runtime import.
    const isPureTypeOnly = /^\s*type\b/.test(bindings);
    if (isPureTypeOnly) continue;
    offenders.push(`${keyword}${bindings}from '${SDK_PKG}'`.replace(/\s+/g, ' ').trim());
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

  // Inline fixture coverage for the matcher itself — guards against
  // reformatting false-positives (e.g. someone runs Prettier and the SDK
  // import wraps onto three lines).
  describe('findRuntimeSdkImports (matcher)', () => {
    it('treats a multi-line `import type {…}` block as type-only (no offender)', () => {
      const src = ['import type {', '  Options,', '  SDKMessage,', "} from '@anthropic-ai/claude-agent-sdk';"].join(
        '\n',
      );
      expect(findRuntimeSdkImports(src)).toEqual([]);
    });

    it('flags a multi-line mixed import (runtime + type)', () => {
      const src = ['import {', '  type Options,', '  query,', "} from '@anthropic-ai/claude-agent-sdk';"].join('\n');
      expect(findRuntimeSdkImports(src).length).toBe(1);
    });

    it('flags a single-line mixed `import { type X, runtimeY }`', () => {
      const src = "import { type Options, query } from '@anthropic-ai/claude-agent-sdk';";
      expect(findRuntimeSdkImports(src).length).toBe(1);
    });

    it('treats `import type {…}` (single-line) as type-only', () => {
      const src = "import type { Options } from '@anthropic-ai/claude-agent-sdk';";
      expect(findRuntimeSdkImports(src)).toEqual([]);
    });
  });
});
