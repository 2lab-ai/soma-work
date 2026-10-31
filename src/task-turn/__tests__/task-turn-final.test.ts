/**
 * E2 ⑤ — the answer a task turn's result notice quotes (.prd/18 D8, §6.3):
 * that turn's own main-agent `final`, never an earlier turn's or a subagent's.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkLogEntry } from '../../conversation/work-log';
import { readTurnFinal } from '../task-turn-final';

let seq = 0;
const entry = (over: Partial<WorkLogEntry>): WorkLogEntry =>
  ({ seq: ++seq, ts: seq, kind: 'narration', text: '', ...over }) as WorkLogEntry;

/** A work log read like readWorkLog: the latest `limit`, or the `limit` before `beforeSeq`, oldest first. */
function log(entries: WorkLogEntry[]) {
  return vi.fn(async (_id: string, o: { beforeSeq?: number; limit?: number }) => {
    const older = o.beforeSeq === undefined ? entries : entries.filter((e) => e.seq < o.beforeSeq!);
    const limit = o.limit ?? 50;
    return { entries: older.slice(-limit), hasMore: older.length > limit };
  });
}

describe('readTurnFinal (E2 ⑤)', () => {
  it('is the main agent’s last final of that turn — not a subagent’s, not another turn’s', async () => {
    const read = log([
      entry({ kind: 'final', turnId: 't0', text: 'earlier answer' }),
      entry({ kind: 'final', turnId: 't1', text: 'first draft' }),
      entry({ kind: 'final', turnId: 't1', text: 'the answer' }),
      entry({ kind: 'final', turnId: 't1', text: 'a subagent’s', agentId: 'toolu_1' }),
      entry({ kind: 'narration', turnId: 't1', text: 'thinking' }),
      entry({ kind: 'final', turnId: 't2', text: 'later answer' }),
    ]);
    expect(await readTurnFinal(read, 'c', 't1')).toEqual({ text: 'the answer', clipped: false });
  });

  it('a turn with no final of its own has none — an earlier turn’s is not reused', async () => {
    const read = log([
      entry({ kind: 'final', turnId: 't0', text: 'earlier answer' }),
      entry({ kind: 'tool', turnId: 't1' }),
    ]);
    expect(await readTurnFinal(read, 'c', 't1')).toBeUndefined();
  });

  it('an answer longer than the work log keeps is clipped', async () => {
    const read = log([entry({ kind: 'final', turnId: 't1', text: 'x'.repeat(4000), rawBytes: 9000 })]);
    expect(await readTurnFinal(read, 'c', 't1')).toEqual({ text: 'x'.repeat(4000), clipped: true });
  });

  it('pages back past a busy tail to find it', async () => {
    const many = [entry({ kind: 'final', turnId: 't1', text: 'found' })];
    for (let i = 0; i < 450; i++) many.push(entry({ kind: 'tool', turnId: 't2' }));
    const read = log(many);
    expect(await readTurnFinal(read, 'c', 't1')).toEqual({ text: 'found', clipped: false });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
