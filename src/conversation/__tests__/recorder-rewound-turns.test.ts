/**
 * 되돌리기 (SSOT 2026-11-25: "해당 프롬프트까지 히스토리에서 삭제") — once a rollback runs, the turns it dropped
 * are stamped on the conversation record (`rewoundAt`), so they stay out of the dashboard chat after the session's
 * own list of dropped spans (the latest 10, cleared by new/renew) has forgotten them. Nothing is deleted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ data: '' }));
vi.mock('../../env-paths', async () => {
  const nodeFs = await import('node:fs');
  dirs.data = nodeFs.mkdtempSync('/tmp/recorder-rewound-data-');
  return { IS_DEV: true, DATA_DIR: dirs.data };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createConversation,
  getConversation,
  markRewoundTurns,
  recordAssistantTurn,
  recordUserTurn,
  setOnTurnRecordedCallback,
} from '../recorder';
import { ConversationStorage } from '../storage';

/** Record a turn of `cid` at `ms` and wait until it is recorded (a turn of another conversation does not count). */
async function at(ms: number, cid: string, record: () => void): Promise<void> {
  vi.setSystemTime(ms);
  const seen = new Promise<void>((resolve) =>
    setOnTurnRecordedCallback((id) => {
      if (id === cid) resolve();
    }),
  );
  record();
  await seen;
}

/** The record as saved on disk (not the recorder's cached copy). */
function onDisk(cid: string): { turns: Array<{ rewoundAt?: number }> } {
  return JSON.parse(readFileSync(join(dirs.data, 'conversations', `${cid}.json`), 'utf8'));
}

afterEach(() => vi.useRealTimers());

describe('markRewoundTurns — a rollback that ran stamps what it dropped', () => {
  it('an input rollback: the instruction and every turn after it; what came before is left alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cid = createConversation('C1', '1700000000.000900', 'U1', 'Zhuge');
    await at(100, cid, () => recordUserTurn(cid, '먼저', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    await at(150, cid, () => recordAssistantTurn(cid, '네'));
    await at(200, cid, () => recordUserTurn(cid, '배포해', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    await at(300, cid, () => recordAssistantTurn(cid, '배포했어요'));
    // The instruction sent again after the rollback is recorded before the CLI opens its turn: not in the span.
    await at(425, cid, () => recordUserTurn(cid, '고친 지시', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));

    expect(await markRewoundTurns(cid, { from: 199, to: 400, at: 450 })).toBe(2);
    const rec = await getConversation(cid);
    expect(rec?.turns.map((t) => t.rewoundAt ?? null)).toEqual([null, null, 450, 450, null]);
    // Saved, not only cached: the stamp survives a restart.
    expect(onDisk(cid).turns.map((t) => t.rewoundAt ?? null)).toEqual([null, null, 450, 450, null]);
    // Once per turn: a later rollback stamps only turns not stamped yet; a stamped turn keeps its first time.
    expect(await markRewoundTurns(cid, { from: 0, to: 400, at: 999 })).toBe(2);
    expect((await getConversation(cid))?.turns.map((t) => t.rewoundAt ?? null)).toEqual([999, 999, 450, 450, null]);
  });

  it('every turn by its own time: a work-log point inside an answer’s turn drops that answer; its recorded time keeps it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const turns = async (thread: string) => {
      const cid = createConversation('C1', thread, 'U1', 'Zhuge');
      await at(100, cid, () => recordUserTurn(cid, '배포해', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
      // The answer is recorded at teardown (180), after its final work-log entry (170).
      await at(180, cid, () => recordAssistantTurn(cid, '배포했어요'));
      await at(200, cid, () => recordUserTurn(cid, '다음', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
      await at(260, cid, () => recordAssistantTurn(cid, '네'));
      return cid;
    };
    // A tool result mid-turn (140): the SDK resumes before the final reply, so the answer leaves.
    const mid = await turns('1700000000.000910');
    expect(await markRewoundTurns(mid, { from: 140, to: 400, at: 450 })).toBe(3);
    expect(onDisk(mid).turns.map((t) => t.rewoundAt ?? null)).toEqual([null, 450, 450, 450]);
    // The final reply (its point carries the answer's recorded time, 180): the answer stays.
    const fin = await turns('1700000000.000911');
    expect(await markRewoundTurns(fin, { from: 180, to: 400, at: 450 })).toBe(2);
    expect(onDisk(fin).turns.map((t) => t.rewoundAt ?? null)).toEqual([null, null, 450, 450]);
  });

  it('a final-reply span from before 2026-11-25 (kept up to the reply’s work-log entry) still keeps its answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cid = createConversation('C1', '1700000000.000920', 'U1', 'Zhuge');
    await at(100, cid, () => recordUserTurn(cid, '배포해', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    await at(180, cid, () => recordAssistantTurn(cid, '배포했어요'));
    await at(200, cid, () => recordUserTurn(cid, '다음', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    expect(await markRewoundTurns(cid, { from: 170, to: 400, at: 450, keepsFinalReply: true })).toBe(1);
    expect(onDisk(cid).turns.map((t) => t.rewoundAt ?? null)).toEqual([null, null, 450]);
  });

  it('a save that fails leaves nothing stamped, so the next try saves again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cid = createConversation('C1', '1700000000.000930', 'U1', 'Zhuge');
    await at(100, cid, () => recordUserTurn(cid, '배포해', 'Zhuge', 'U1', undefined, { origin: { by: 'user' } }));
    // The turn's own save has landed (nothing of this conversation is in flight).
    await vi.waitFor(() => expect(onDisk(cid).turns).toHaveLength(1));
    // Only this conversation's save that carries the stamp fails (other saves — an earlier test's summary — may
    // land meanwhile).
    const realSave = ConversationStorage.prototype.save;
    let failed = false;
    const spy = vi.spyOn(ConversationStorage.prototype, 'save').mockImplementation(async function (
      this: ConversationStorage,
      record,
    ) {
      if (!failed && record.id === cid && record.turns.some((t) => t.rewoundAt !== undefined)) {
        failed = true;
        throw new Error('disk full');
      }
      return realSave.call(this, record);
    });
    await expect(markRewoundTurns(cid, { from: 50, to: 400, at: 450 })).rejects.toThrow('disk full');
    spy.mockRestore();
    expect((await getConversation(cid))?.turns.map((t) => t.rewoundAt ?? null)).toEqual([null]);
    expect(await markRewoundTurns(cid, { from: 50, to: 400, at: 460 })).toBe(1);
    expect(onDisk(cid).turns.map((t) => t.rewoundAt ?? null)).toEqual([460]);
  });

  it('an unknown conversation, or a span with nothing in it, stamps nothing', async () => {
    expect(await markRewoundTurns('nope', { from: 0, to: 1, at: 2 })).toBe(0);
    const cid = createConversation('C1', '1700000000.000920', 'U1', 'Zhuge');
    expect(await markRewoundTurns(cid, { from: 0, to: 1, at: 2 })).toBe(0);
  });
});
