/**
 * #617 followup — "Compaction complete" rich message.
 *
 * Regression guard for the user-reported bug where the completion message
 * always showed `was ~?% → now ~?%`. Root cause: the SDK compact_metadata
 * (`pre_tokens`, `post_tokens`, `trigger`, `duration_ms`) was never captured
 * on the session, so the message had no data to display.
 *
 * These tests cover `buildCompactCompleteMessage` directly to prove the
 * message emits every field available on the session and falls back cleanly
 * when fields are missing. Callsite (compact-hooks.ts::postCompactCompleteIfNeeded)
 * goes through `slackApi.postSystemMessage` — the AC5 coverage in
 * compact-hooks.test.ts already asserts the call path.
 */

import { describe, expect, it } from 'vitest';
import type { ConversationSession } from '../../types';
import { buildCompactCompleteMessage } from './compact-hooks';

function baseSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    compactionCount: 0,
    compactEpoch: 1,
    compactPostedByEpoch: {},
    compactionRehydratedByEpoch: {},
    preCompactUsagePct: null,
    lastKnownUsagePct: null,
    compactPreTokens: null,
    compactPostTokens: null,
    compactTrigger: null,
    compactDurationMs: null,
    autoCompactPending: false,
    pendingUserText: null,
    pendingEventContext: null,
    ...overrides,
  } as ConversationSession;
}

describe('buildCompactCompleteMessage — SDK-authoritative fields (#617 followup)', () => {
  it('AC5 followup: all fields present → full message with tokens + trigger + duration', () => {
    const session = baseSession({
      preCompactUsagePct: 83,
      lastKnownUsagePct: 12,
      compactPreTokens: 166_000,
      compactPostTokens: 24_000,
      compactTrigger: 'auto',
      compactDurationMs: 1234,
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '✅ Compaction complete · was ~83% (166,000 tok) → now ~12% (24,000 tok) · trigger=auto · 1.2s',
    );
  });

  it('AC5 followup: manual trigger + sub-second duration renders as `Nms`', () => {
    const session = baseSession({
      preCompactUsagePct: 85,
      lastKnownUsagePct: 40,
      compactPreTokens: 170_000,
      compactPostTokens: 80_000,
      compactTrigger: 'manual',
      compactDurationMs: 250,
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '✅ Compaction complete · was ~85% (170,000 tok) → now ~40% (80,000 tok) · trigger=manual · 250ms',
    );
  });

  it('AC5 followup: tokens present, no trigger/duration → only tokens appended', () => {
    const session = baseSession({
      preCompactUsagePct: 90,
      lastKnownUsagePct: 20,
      compactPreTokens: 180_000,
      compactPostTokens: 40_000,
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '✅ Compaction complete · was ~90% (180,000 tok) → now ~20% (40,000 tok)',
    );
  });

  it('AC5 followup: legacy path — no token data → unchanged from prior format', () => {
    // Ensures backward compatibility with sessions that were compacted by an
    // older SDK that didn't emit compact_metadata.
    const session = baseSession({ preCompactUsagePct: 83, lastKnownUsagePct: 45 });
    expect(buildCompactCompleteMessage(session)).toBe('✅ Compaction complete · was ~83% → now ~45%');
  });

  it('AC5 followup: completely absent data → `?` fallback for both sides', () => {
    const session = baseSession();
    expect(buildCompactCompleteMessage(session)).toBe('✅ Compaction complete · was ~?% → now ~?%');
  });

  it('AC5 followup: only post_tokens available → post side shows tokens, pre side does not', () => {
    // Defensive: SDK type marks post_tokens optional. If only post_tokens is
    // delivered we should still enrich the `now` side without lying about `was`.
    const session = baseSession({
      preCompactUsagePct: null,
      lastKnownUsagePct: 12,
      compactPreTokens: null,
      compactPostTokens: 24_000,
      compactTrigger: 'auto',
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '✅ Compaction complete · was ~?% → now ~12% (24,000 tok) · trigger=auto',
    );
  });

  it('AC5 followup: token counts with thousand-separators render en-US locale', () => {
    const session = baseSession({
      preCompactUsagePct: 50,
      lastKnownUsagePct: 10,
      compactPreTokens: 1_500_000,
      compactPostTokens: 300_500,
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '✅ Compaction complete · was ~50% (1,500,000 tok) → now ~10% (300,500 tok)',
    );
  });
});
