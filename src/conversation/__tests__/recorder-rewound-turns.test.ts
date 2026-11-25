/**
 * 되돌리기 (SSOT 2026-11-25: "해당 프롬프트까지 히스토리에서 삭제") — once a rollback runs, the turns it dropped
 * are stamped on the conversation record (`rewoundAt`), so they stay out of the dashboard chat after the session's
 * own list of dropped spans (the latest 10, cleared by new/renew) has forgotten them. Nothing is deleted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  return { IS_DEV: true, DATA_DIR: nodeFs.mkdtempSync('/tmp/recorder-rewound-data-') };
});

import {
  createConversation,
  getConversation,
  markRewoundTurns,
  recordAssistantTurn,
  recordUserTurn,
  setOnTurnRecordedCallback,
} from '../recorder';

function nextTurn(): Promise<{ id: string; timestamp: number }> {
  return new Promise((resolve) => setOnTurnRecordedCallback((_id, turn) => resolve(turn)));
}

async function at<T>(ms: number, record: () => void): Promise<T> {
  vi.setSystemTime(ms);
  const seen = nextTurn();
  record();
  return (await seen) as T;
}

afterEach(() => vi.useRealTimers());

describe('markRewoundTurns — a rollback that ran stamps what it dropped', () => {
  it('an input rollback: the instruction and every turn after it; what came before is left alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cid = createConversation('C1', '1700000000.000900', 'U1', 'Zhuge');
    await at(100, () => recordUserTurn(cid, '먼저', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    await at(150, () => recordAssistantTurn(cid, '네'));
    await at(200, () => recordUserTurn(cid, '배포해', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    await at(300, () => recordAssistantTurn(cid, '배포했어요'));

    expect(await markRewoundTurns(cid, { from: 199, to: 400, at: 450 })).toBe(2);
    const rec = await getConversation(cid);
    expect(rec?.turns.map((t) => t.rewoundAt ?? null)).toEqual([null, null, 450, 450]);
    // Once per turn: a later rollback stamps only turns not stamped yet; a stamped turn keeps its first time.
    expect(await markRewoundTurns(cid, { from: 0, to: 400, at: 999 })).toBe(2);
    expect((await getConversation(cid))?.turns.map((t) => t.rewoundAt ?? null)).toEqual([999, 999, 450, 450]);
  });

  it('a work-log rollback that keeps up to a point inside an answer’s turn keeps that answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cid = createConversation('C1', '1700000000.000910', 'U1', 'Zhuge');
    await at(100, () => recordUserTurn(cid, '배포해', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    // The answer is recorded at teardown (180), after the final work-log entry the rollback keeps (170).
    await at(180, () => recordAssistantTurn(cid, '배포했어요'));
    await at(200, () => recordUserTurn(cid, '다음', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    await at(260, () => recordAssistantTurn(cid, '네'));

    expect(await markRewoundTurns(cid, { from: 170, to: 400, at: 450 })).toBe(2);
    expect((await getConversation(cid))?.turns.map((t) => t.rewoundAt ?? null)).toEqual([null, null, 450, 450]);
  });

  it('an unknown conversation, or a span with nothing in it, stamps nothing', async () => {
    expect(await markRewoundTurns('nope', { from: 0, to: 1, at: 2 })).toBe(0);
    const cid = createConversation('C1', '1700000000.000920', 'U1', 'Zhuge');
    expect(await markRewoundTurns(cid, { from: 0, to: 1, at: 2 })).toBe(0);
  });
});
