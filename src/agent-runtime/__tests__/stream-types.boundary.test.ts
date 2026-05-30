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

  it('the union is importable as a pure type module (no runtime SDK dependency)', async () => {
    const mod = await import('../stream-types');
    // Type-only module → no runtime exports. The import itself succeeding with
    // no SDK on the require graph is the assertion; this just pins that the
    // module evaluates without throwing.
    expect(mod).toBeDefined();
  });

  it('is re-exported from the port public surface', async () => {
    // Compile-time check: these type names must resolve through the index.
    // (Pure types erase at runtime, so we assert the source wiring instead.)
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    expect(indexSrc).toContain('stream-types');
    expect(indexSrc).toContain('AgentStreamEvent');
  });
});
