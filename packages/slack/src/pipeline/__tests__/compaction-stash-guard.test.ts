/**
 * Compact re-loop fix — a message must never abort an in-flight compaction.
 * `shouldStashForCompaction` is the atomic guard session-initializer applies
 * before concurrency control: when the active request is a running /compact
 * turn (open compact cycle), the incoming message is stashed for post-compact
 * re-dispatch instead of displacing (and thereby killing) the compaction.
 *
 * Root cause this protects against (work-m64 dev, 2026-07-08, session f4ee1a3f):
 * the CLI flushes the compacted transcript a few seconds AFTER the
 * PostCompact hook fires; aborting the process in that window loses the
 * compaction, the session resumes uncompacted at 82–93% usage, and the
 * threshold immediately re-trips — an endless compact→abort→compact loop.
 */

import { describe, expect, it } from 'vitest';
import { shouldStashForCompaction } from '../session-initializer';

function openCompactCycle(startedAgoMs = 30_000) {
  return {
    compactEpoch: 2,
    compactPostedByEpoch: { 2: { pre: true, post: false } },
    compactStartedAtMs: Date.now() - startedAgoMs,
  };
}

describe('shouldStashForCompaction', () => {
  it('stashes when a request is active and a compact cycle is open', () => {
    expect(shouldStashForCompaction(openCompactCycle(), true)).toBe(true);
  });

  it('does not stash when the session is idle (compaction hooks may lag stream end)', () => {
    expect(shouldStashForCompaction(openCompactCycle(), false)).toBe(false);
  });

  it('does not stash when no compaction is running (normal busy turn keeps supersede semantics)', () => {
    expect(shouldStashForCompaction({}, true)).toBe(false);
    expect(
      shouldStashForCompaction(
        { compactEpoch: 2, compactPostedByEpoch: { 2: { pre: true, post: true } }, compactStartedAtMs: Date.now() },
        true,
      ),
    ).toBe(false);
  });

  it('does not stash when the open cycle is stale (10-minute safety ceiling)', () => {
    expect(shouldStashForCompaction(openCompactCycle(11 * 60 * 1000), true)).toBe(false);
  });
});
