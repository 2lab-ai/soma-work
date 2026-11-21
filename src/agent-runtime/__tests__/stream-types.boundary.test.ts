/**
 * `stream-types.ts` SDK-boundary guard (ADR 0002 pass 2, epic #1023 P2).
 *
 * The neutral `AgentStreamEvent` union is the seam contract: it is the
 * SDK-agnostic vocabulary the P4 processor consumes instead of `SDKMessage`.
 * If it imported the SDK — even as `import type` — the seam would leak the
 * SDK's shape and the swappability goal would be defeated. This guard is
 * therefore STRICTER than the pass-1 boundary test (which tolerates
 * `import type`): the types module must reference the SDK package zero times.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const STREAM_TYPES = path.join(__dirname, '..', 'stream-types.ts');

describe('agent-runtime stream-types boundary (epic #1023 P2)', () => {
  it('stream-types.ts does not reference the Claude SDK package at all (not even import type)', () => {
    const src = fs.readFileSync(STREAM_TYPES, 'utf8');
    // Strip the file's own doc-comment mentions of the package name so a
    // comment explaining the rule does not trip the rule.
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toContain(SDK_PKG);
  });
});
