/**
 * #617 followup v2 — "Compaction completed" rich message + live "starting"
 * message with elapsed-time ticker.
 *
 * Replaces the v1 regression guard (which asserted the flat `· was ~X% → now
 * ~Y%` shape). The new format is a 2-line block with every SDK-reported
 * field plus a context-window snapshot, and the starting message shows
 * elapsed seconds MCP-style.
 *
 * These tests cover `buildCompactCompleteMessage` and
 * `buildCompactStartingMessage` directly. Hook integration (post → update →
 * complete) is covered separately in compact-hooks.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { ConversationSession } from '../../../types';
import { buildCompactCompleteMessage, buildCompactStartingMessage } from '../compact-hooks';

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
    // No `model` → resolveContextWindow falls back to 200k, exercised in tests below.
  } as ConversationSession as ConversationSession & typeof overrides;
}

function withOverrides(overrides: Partial<ConversationSession>): ConversationSession {
  return { ...baseSession(), ...overrides } as ConversationSession;
}

describe('buildCompactStartingMessage — live "Compaction starting" indicator', () => {
  it('initial post (no elapsed) with auto trigger', () => {
    expect(buildCompactStartingMessage({ trigger: 'auto' })).toBe('⏳ 🗜️ Compaction starting · trigger=auto');
  });

  it('initial post with manual trigger', () => {
    expect(buildCompactStartingMessage({ trigger: 'manual' })).toBe('⏳ 🗜️ Compaction starting · trigger=manual');
  });

  it('initial post with UNKNOWN trigger (fallback path) — omits trigger segment entirely', () => {
    // Regression: AS-IS used to show `trigger=unknown (fallback)` which the
    // user called noise. We now drop the segment rather than print a lie.
    expect(buildCompactStartingMessage({ trigger: null })).toBe('⏳ 🗜️ Compaction starting');
  });

  it('ticker update appends elapsed seconds (sub-minute)', () => {
    expect(buildCompactStartingMessage({ trigger: 'auto', elapsedMs: 5_000 })).toBe(
      '⏳ 🗜️ Compaction starting · trigger=auto — 5s',
    );
  });

  it('ticker update renders minute-scale elapsed as `Xm Ys`', () => {
    expect(buildCompactStartingMessage({ trigger: 'auto', elapsedMs: 65_000 })).toBe(
      '⏳ 🗜️ Compaction starting · trigger=auto — 1m 5s',
    );
  });

  it('ticker update renders whole-minute elapsed as `Xm` (no trailing 0s)', () => {
    expect(buildCompactStartingMessage({ trigger: 'auto', elapsedMs: 180_000 })).toBe(
      '⏳ 🗜️ Compaction starting · trigger=auto — 3m',
    );
  });

  it('elapsedMs=0 on first tick → does NOT append `— 0s` (noise)', () => {
    expect(buildCompactStartingMessage({ trigger: 'auto', elapsedMs: 0 })).toBe(
      '⏳ 🗜️ Compaction starting · trigger=auto',
    );
  });

  it('unknown trigger + elapsed → elapsed still appended', () => {
    expect(buildCompactStartingMessage({ trigger: null, elapsedMs: 7_000 })).toBe('⏳ 🗜️ Compaction starting — 7s');
  });
});

describe('buildCompactCompleteMessage — SDK-authoritative 2-line complete message', () => {
  it('full SDK data → header with trigger+duration, Context line with compact token counts', () => {
    const session = withOverrides({
      preCompactUsagePct: 80,
      lastKnownUsagePct: 16,
      compactPreTokens: 160_000,
      compactPostTokens: 35_000,
      compactTrigger: 'auto',
      compactDurationMs: 5_200,
      compactionCount: 3,
    });
    // Default model → 200k context window fallback.
    expect(buildCompactCompleteMessage(session)).toBe(
      '🟢 🗜️ Compaction completed · trigger=auto (5.2s)\n' +
        'Context: now 16% (35k/200k) ← was 80% (160k/200k) · compaction #3',
    );
  });

  it('manual trigger + sub-second duration renders as `Nms` in header', () => {
    const session = withOverrides({
      preCompactUsagePct: 85,
      lastKnownUsagePct: 40,
      compactPreTokens: 170_000,
      compactPostTokens: 80_000,
      compactTrigger: 'manual',
      compactDurationMs: 250,
      compactionCount: 1,
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '🟢 🗜️ Compaction completed · trigger=manual (250ms)\n' +
        'Context: now 40% (80k/200k) ← was 85% (170k/200k) · compaction #1',
    );
  });

  it('no trigger / no duration / no compactionCount → header collapses, Context only has tokens', () => {
    const session = withOverrides({
      preCompactUsagePct: 90,
      lastKnownUsagePct: 20,
      compactPreTokens: 180_000,
      compactPostTokens: 40_000,
      compactionCount: 0, // zero treated as "not yet populated" per impl
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '🟢 🗜️ Compaction completed\n' + 'Context: now 20% (40k/200k) ← was 90% (180k/200k)',
    );
  });

  it('legacy path — no token data, only pct snapshots → `~X%` fallback for both sides', () => {
    const session = withOverrides({ preCompactUsagePct: 83, lastKnownUsagePct: 45, compactionCount: 2 });
    expect(buildCompactCompleteMessage(session)).toBe(
      '🟢 🗜️ Compaction completed\n' + 'Context: now ~45% ← was ~83% · compaction #2',
    );
  });

  it('completely absent data → `?` fallback on both sides', () => {
    const session = baseSession();
    expect(buildCompactCompleteMessage(session)).toBe('🟢 🗜️ Compaction completed\n' + 'Context: now ~?% ← was ~?%');
  });

  it('only post_tokens present → post side shows compact tokens, pre side falls back', () => {
    const session = withOverrides({
      preCompactUsagePct: null,
      lastKnownUsagePct: 12,
      compactPreTokens: null,
      compactPostTokens: 24_000,
      compactTrigger: 'auto',
    });
    expect(buildCompactCompleteMessage(session)).toBe(
      '🟢 🗜️ Compaction completed · trigger=auto\n' + 'Context: now 12% (24k/200k) ← was ~?%',
    );
  });

  it('mega-scale tokens render as `1.5M` / `300k`', () => {
    const session = withOverrides({
      preCompactUsagePct: 50,
      lastKnownUsagePct: 10,
      compactPreTokens: 1_500_000,
      compactPostTokens: 300_500,
      model: 'claude-opus-4-7', // 1M context window
    });
    const msg = buildCompactCompleteMessage(session);
    // Sanity: header + Context line shape
    expect(msg).toContain('🟢 🗜️ Compaction completed');
    expect(msg).toContain('Context: now 10%');
    expect(msg).toContain('was 50%');
    // Mega formatting
    expect(msg).toContain('1.5M/');
    expect(msg).toContain('301k/');
  });

  it('sub-1000 tokens (defensive edge case) render as plain integer', () => {
    const session = withOverrides({
      preCompactUsagePct: 0,
      lastKnownUsagePct: 0,
      compactPreTokens: 500,
      compactPostTokens: 10,
    });
    const msg = buildCompactCompleteMessage(session);
    expect(msg).toContain('(500/200k)');
    expect(msg).toContain('(10/200k)');
  });
});
