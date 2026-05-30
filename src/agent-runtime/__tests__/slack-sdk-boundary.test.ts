/**
 * Acceptance gate #1 (epic #1023, ADR 0002 §3.9 contract 1): `packages/slack`
 * must NOT import the Claude SDK — **neither as a runtime value NOR as
 * `import type`** (stricter than the pass-1 boundary test's transitional
 * `import type` tolerance). After P4 the Slack streaming pipeline consumes the
 * neutral `AgentStreamEvent` stream via DI, so the SDK type leak at
 * `stream-processor.ts:6` (`import type { SDKMessage }`) is gone.
 *
 * This guard scans every `.ts` under `packages/slack/src` (production AND test
 * files — a test importing the SDK would re-introduce the coupling) and fails
 * if any references the SDK package in an import/export statement.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SLACK_SRC = path.join(__dirname, '..', '..', '..', 'packages', 'slack', 'src');
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Any `import`/`export ... from '@anthropic-ai/claude-agent-sdk'` — including a
 * pure `import type {…}` — is a violation here. Matches multi-line statements by
 * anchoring on the `from '…'` tail.
 */
function findSdkImports(src: string): string[] {
  const escaped = SDK_PKG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stmtRe = new RegExp(`(^|\\n)\\s*(import|export)\\b[\\s\\S]*?from\\s+['"]${escaped}['"]`, 'g');
  return [...src.matchAll(stmtRe)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

describe('packages/slack ⟂ Claude SDK boundary (epic #1023 P4, acceptance gate #1)', () => {
  const files = walk(SLACK_SRC);

  it('scans a non-trivial number of files (guard is actually running)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no packages/slack source imports the Claude SDK (not even import type)', () => {
    const offenders: Array<{ file: string; statements: string[] }> = [];
    for (const file of files) {
      const statements = findSdkImports(fs.readFileSync(file, 'utf8'));
      if (statements.length > 0) {
        offenders.push({ file: path.relative(SLACK_SRC, file), statements });
      }
    }
    expect(offenders, `SDK import(s) found in packages/slack:\n${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it('stream-processor.ts specifically is SDK-free (the load-bearing former offender)', () => {
    const src = fs.readFileSync(path.join(SLACK_SRC, 'stream-processor.ts'), 'utf8');
    expect(findSdkImports(src)).toEqual([]);
  });
});
