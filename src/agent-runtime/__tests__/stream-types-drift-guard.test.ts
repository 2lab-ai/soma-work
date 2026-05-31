/**
 * Cross-package drift guard for the neutral streaming event contract
 * (epic #1023 P4, ADR 0002 §3.9 contract 1).
 *
 * The seam type is declared TWICE on purpose: the producer side lives in
 * `src/agent-runtime/stream-types.ts` and the consumer side in
 * `packages/slack/src/agent-stream-types.ts`. They are physically separate
 * because contract 1 forbids `packages/slack` from importing `src/agent-runtime`
 * (the `slack-sdk-boundary` test enforces that), so the producer's events stay
 * assignable to the consumer contract only as long as the two declarations stay
 * structurally identical.
 *
 * A direct cross-package `import` would either re-introduce the forbidden
 * dependency or break `tsc`'s `rootDir` (TS6059). So instead this guard reads
 * both files from disk, strips comments + whitespace, and asserts the SHARED
 * type block (`AgentStopReason` … `AgentStreamEventOf`) is byte-identical. Any
 * future edit to one side that isn't mirrored on the other fails this test —
 * which is exactly the drift that would silently break the swappability seam.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const PRODUCER = path.join(__dirname, '..', 'stream-types.ts');
const CONSUMER = path.join(__dirname, '..', '..', '..', 'packages', 'slack', 'src', 'agent-stream-types.ts');

const FIRST_TYPE = 'export type AgentStopReason';
const LAST_TYPE = 'export type AgentStreamEventOf';

/**
 * Extract the shared neutral-type block (`AgentStopReason` through
 * `AgentStreamEventOf`), then normalize away comments and whitespace so only the
 * structural type shapes are compared. The consumer file's extra
 * `AgentStreamRunnerLike` declaration sits AFTER `AgentStreamEventOf` and is
 * deliberately excluded.
 */
function extractSharedTypeBlock(src: string): string {
  const start = src.indexOf(FIRST_TYPE);
  const lastIdx = src.indexOf(LAST_TYPE);
  if (start === -1 || lastIdx === -1) {
    throw new Error('drift-guard: could not locate the shared type block anchors');
  }
  const lineEnd = src.indexOf('\n', lastIdx + LAST_TYPE.length);
  const block = src.slice(start, lineEnd === -1 ? undefined : lineEnd);
  return block
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/.*$/gm, '') // line comments
    .replace(/\s+/g, ' ') // collapse all whitespace
    .trim();
}

describe('AgentStreamEvent producer/consumer drift guard (epic #1023 P4)', () => {
  const producerSrc = fs.readFileSync(PRODUCER, 'utf8');
  const consumerSrc = fs.readFileSync(CONSUMER, 'utf8');

  it('both declarations exist and expose the anchor types', () => {
    for (const src of [producerSrc, consumerSrc]) {
      expect(src).toContain(FIRST_TYPE);
      expect(src).toContain(LAST_TYPE);
      expect(src).toContain('export type AgentStreamEvent =');
      expect(src).toContain('export interface AgentUsage');
    }
  });

  it('the shared neutral-type block is structurally identical across packages', () => {
    const producerBlock = extractSharedTypeBlock(producerSrc);
    const consumerBlock = extractSharedTypeBlock(consumerSrc);
    // Sanity: the block is non-trivial (the extractor actually captured types).
    expect(producerBlock.length).toBeGreaterThan(500);
    expect(consumerBlock).toBe(producerBlock);
  });

  it('the consumer additionally declares the DI contract (AgentStreamRunnerLike)', () => {
    // The consumer is a superset: it carries the injection interface the
    // producer does not. Guards against accidentally deleting the seam contract.
    expect(consumerSrc).toContain('AgentStreamRunnerLike');
    expect(producerSrc).not.toContain('AgentStreamRunnerLike');
  });
});
