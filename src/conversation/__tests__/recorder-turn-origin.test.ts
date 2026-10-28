/**
 * Dashboard SSOT 2026-10-27 — the recorder half of "a turn the user did not
 * type reads as one line".
 *
 *   T1.1  a user turn keeps who put it there (`origin.by`)
 *   T2.1  a `/compact` turn carries the conversation's previous compaction
 *         time as its estimate, and its own result once the compaction ends —
 *         written onto that turn and pushed to the dashboard again
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/recorder-origin-data-') };
});

import {
  createConversation,
  getConversation,
  recordCompactResult,
  recordUserTurn,
  setOnTurnRecordedCallback,
} from '../recorder';

function nextTurn(): Promise<any> {
  return new Promise((resolve) => setOnTurnRecordedCallback((_id, turn) => resolve(turn)));
}

describe('T1.1 — who put the turn there', () => {
  it('keeps origin.by on the recorded turn', async () => {
    const cid = createConversation('C1', '1700000000.000300', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordUserTurn(cid, '[goal-continuation] Continue working', 'Zhuge', 'U1', undefined, {
      origin: { by: 'system' },
    });
    expect((await seen).origin).toEqual({ by: 'system' });
  });

  it('a turn recorded without one has none (older callers)', async () => {
    const cid = createConversation('C1', '1700000000.000400', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordUserTurn(cid, 'hello', 'Zhuge', 'U1');
    expect((await seen).origin).toBeUndefined();
  });
});

describe('T2.1 — a /compact turn records its compaction', () => {
  it('the result lands on the running /compact turn and is pushed again', async () => {
    const cid = createConversation('C1', '1700000000.000500', 'U1', 'Zhuge');
    let seen = nextTurn();
    recordUserTurn(cid, '/compact', 'Zhuge', 'U1', undefined, { origin: { by: 'system' }, compact: true });
    const compactTurn = await seen;
    // The first compaction of a conversation has nothing to estimate from — the
    // empty record still marks the turn as a compaction.
    expect(compactTurn.compact).toEqual({});

    seen = nextTurn();
    const ok = await recordCompactResult(cid, {
      endedAt: compactTurn.timestamp + 134_000,
      durationMs: 134_000,
      preTokens: 182_340,
      postTokens: 31_020,
      trigger: 'manual',
    });
    expect(ok).toBe(true);
    const pushed = await seen;
    expect(pushed.id).toBe(compactTurn.id);
    expect(pushed.compact).toEqual({
      endedAt: compactTurn.timestamp + 134_000,
      durationMs: 134_000,
      preTokens: 182_340,
      postTokens: 31_020,
      trigger: 'manual',
    });
    const record = await getConversation(cid);
    expect(record?.turns.find((t) => t.id === compactTurn.id)?.compact?.durationMs).toBe(134_000);
  });

  it('the next /compact expects the previous compaction time', async () => {
    const cid = createConversation('C1', '1700000000.000600', 'U1', 'Zhuge');
    let seen = nextTurn();
    recordUserTurn(cid, '/compact', 'Zhuge', 'U1', undefined, { compact: true });
    const first = await seen;
    await recordCompactResult(cid, { endedAt: first.timestamp + 90_000, durationMs: 90_000 });

    seen = nextTurn();
    recordUserTurn(cid, 'next instruction', 'Zhuge', 'U1');
    expect((await seen).compact).toBeUndefined(); // only a /compact turn carries one

    seen = nextTurn();
    recordUserTurn(cid, '/compact', 'Zhuge', 'U1', undefined, { compact: true });
    expect((await seen).compact).toEqual({ estimateMs: 90_000 });
  });

  it('no /compact turn waiting for a result → nothing is written', async () => {
    const cid = createConversation('C1', '1700000000.000700', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordUserTurn(cid, 'plain instruction', 'Zhuge', 'U1');
    const plain = await seen;
    // A compaction inside an ordinary turn (the SDK's own) has no /compact turn.
    expect(await recordCompactResult(cid, { endedAt: plain.timestamp + 1000, durationMs: 1000 })).toBe(false);

    let s2 = nextTurn();
    recordUserTurn(cid, '/compact', 'Zhuge', 'U1', undefined, { compact: true });
    const c = await s2;
    await recordCompactResult(cid, { endedAt: c.timestamp + 5000, durationMs: 5000 });
    // Already sealed: a second END of the same cycle does not overwrite it.
    s2 = nextTurn();
    expect(await recordCompactResult(cid, { endedAt: c.timestamp + 9000, durationMs: 9000 })).toBe(false);
    const record = await getConversation(cid);
    expect(record?.turns.find((t) => t.id === c.id)?.compact?.durationMs).toBe(5000);
    void s2;
  });

  it('a goal objective that starts with /compact is not a /compact turn', async () => {
    const cid = createConversation('C1', '1700000000.000900', 'U1', 'Zhuge');
    let seen = nextTurn();
    recordUserTurn(cid, '/compact', 'Zhuge', 'U1', undefined, { compact: true });
    const first = await seen;
    await recordCompactResult(cid, { endedAt: first.timestamp + 60_000, durationMs: 60_000 });
    seen = nextTurn();
    // The executor does not flag a goal objective (literalPrompt) as a compaction.
    recordUserTurn(cid, '/compact 명령의 버그를 고쳐라', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } });
    const goal = await seen;
    expect(goal.compact).toBeUndefined();
    // The SDK compacting inside that turn writes nothing onto it.
    expect(await recordCompactResult(cid, { endedAt: goal.timestamp + 1000, durationMs: 1000 })).toBe(false);
  });

  it('/compact with instructions is a compaction when the executor says so (the SDK runs it)', async () => {
    const cid = createConversation('C1', '1700000000.001100', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordUserTurn(cid, '/compact 인증 쪽 위주로', 'Zhuge', 'U1', undefined, { origin: { by: 'user' }, compact: true });
    const c = await seen;
    expect(c.compact).toEqual({});
    expect(await recordCompactResult(cid, { endedAt: c.timestamp + 3000, durationMs: 3000 })).toBe(true);
  });

  it('numbers that arrive after the result was written fill the gaps, never overwrite', async () => {
    const cid = createConversation('C1', '1700000000.001000', 'U1', 'Zhuge');
    let seen = nextTurn();
    recordUserTurn(cid, '/compact', 'Zhuge', 'U1', undefined, { compact: true });
    const c = await seen;
    await recordCompactResult(cid, { endedAt: c.timestamp + 5000, durationMs: 5000 });
    seen = nextTurn();
    expect(
      await recordCompactResult(cid, {
        endedAt: c.timestamp + 7000,
        durationMs: 9999,
        preTokens: 160_000,
        postTokens: 35_000,
        trigger: 'auto',
      }),
    ).toBe(true);
    expect((await seen).compact).toEqual({
      endedAt: c.timestamp + 5000,
      durationMs: 5000,
      preTokens: 160_000,
      postTokens: 35_000,
      trigger: 'auto',
    });
    // Nothing missing any more → nothing written.
    expect(await recordCompactResult(cid, { endedAt: c.timestamp + 8000, preTokens: 1 })).toBe(false);
  });

  it('a /compact turn older than a compaction can run is not the one that ended', async () => {
    const cid = createConversation('C1', '1700000000.000800', 'U1', 'Zhuge');
    const seen = nextTurn();
    recordUserTurn(cid, '/compact', 'Zhuge', 'U1', undefined, { compact: true });
    const stale = await seen;
    expect(await recordCompactResult(cid, { endedAt: stale.timestamp + 60 * 60_000, durationMs: 1000 })).toBe(false);
  });
});
