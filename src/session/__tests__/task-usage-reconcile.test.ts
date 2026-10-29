/**
 * 2026-10-29 T5, live follow-up — measured on dev host work-m64 (v0.2.1205) with a real
 * 3-step task: a task's output tokens were the few counted at each call's
 * start (T1: 48 credited, 652 produced over its two calls) because the SDK's
 * assistant frame carries the call's `message_start` usage. The final usage is
 * on the call's transcript line; these tests pin that the ledger takes it —
 * on the task the call was credited to — and that nothing else moves.
 *
 * Also from the same run: the model ran the same three steps twice (two
 * lists, identical texts); the finished first list's tasks were reopened by
 * the second and each record spanned both runs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTodoList,
  creditTaskUsage,
  emptyTaskLedger,
  ledgerTasks,
  recordToolCall,
  recreditTaskUsage,
  type TaskLedger,
} from '../task-ledger';
import { collectTranscriptCalls, createMainCallReader, reconcileTaskCalls } from '../task-usage-reconcile';

const SID = '5a1c0d2e-7b3f-4c8a-9e61-2f4d8b0c9a17';
let configDir: string;
let file: string;

type Status = 'pending' | 'in_progress' | 'completed';
const list = (statuses: Status[]) =>
  ['date -u 실행', 'ls | wc -l 실행', '두 결과 한 줄 보고'].map((content, i) => ({ content, status: statuses[i] }));

function line(id: string, u: [number, number, number, number], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    ...extra,
    message: {
      id,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'TodoWrite' }],
      usage: {
        input_tokens: u[0],
        output_tokens: u[1],
        cache_read_input_tokens: u[2],
        cache_creation_input_tokens: u[3],
      },
    },
  });
}

const append = (...lines: string[]) => fs.appendFileSync(file, `${lines.join('\n')}\n`);
type Counts = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number };
const price = (c: Counts) =>
  (c.inputTokens + 5 * c.outputTokens + c.cacheReadTokens / 10 + c.cacheCreateTokens) / 1_000_000;
const call = (u: [number, number, number, number]): Counts => ({
  inputTokens: u[0],
  outputTokens: u[1],
  cacheReadTokens: u[2],
  cacheCreateTokens: u[3],
});

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-usage-'));
  const dir = path.join(configDir, 'projects', '-private-tmp-session-x');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, '');
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

/** The work-m64 run's list: T1 running, then T2 — each credited live with its call's start usage. */
function liveRun(): TaskLedger {
  const t0 = Date.parse('2026-10-29T14:52:28Z');
  let l = applyTodoList(emptyTaskLedger(t0 - 5000), list(['in_progress', 'pending', 'pending']), t0);
  // The call that runs while T1 is in progress — live frame: output 24 (counted at its start).
  const c1 = call([2, 24, 136683, 469]);
  creditTaskUsage(l, 'm:msg_7zy1', c1, price(c1));
  recordToolCall(l);
  l = applyTodoList(l, list(['completed', 'in_progress', 'pending']), t0 + 5000);
  const c2 = call([2, 24, 137152, 433]);
  creditTaskUsage(l, 'm:msg_GNhj', c2, price(c2));
  return l;
}

describe('final usage from the transcript (T5 live follow-up)', () => {
  it('a call credited live is re-credited with its final usage, on the task it was credited to', () => {
    const l = liveRun();
    expect(ledgerTasks(l).current[0].tokens?.output).toBe(24);
    // T1 completed meanwhile; its call's final usage still lands on T1, not on T2 (running now).
    expect(recreditTaskUsage(l, 'm:msg_7zy1', call([2, 326, 136683, 469]), 0.5)).toBe(true);
    const after = ledgerTasks(l).current;
    expect(after[0].tokens).toMatchObject({ input: 2, output: 326, cacheRead: 136683, cacheCreate: 469, costUsd: 0.5 });
    expect(after[1].tokens?.output).toBe(24);
    // Idempotent: the same usage again changes nothing.
    expect(recreditTaskUsage(l, 'm:msg_7zy1', call([2, 326, 136683, 469]), 0.5)).toBe(false);
  });

  it('a call the ledger never saw live is never credited to whatever runs now', () => {
    const l = liveRun();
    expect(recreditTaskUsage(l, 'm:msg_from_before_restart', { inputTokens: 9, outputTokens: 999 }, 1)).toBe(false);
    expect(ledgerTasks(l).current[1].tokens?.output).toBe(24);
  });

  it('the reader returns the main agent calls written since its last read; the last line of a call wins', async () => {
    const reader = createMainCallReader({ configDir });
    append(
      line('msg_7zy1', [2, 24, 136683, 469]),
      line('msg_7zy1', [2, 326, 136683, 469]),
      '{"type":"user","message":{"role":"user","content":"tool result"}}',
      line('msg_sub', [5, 500, 5, 5], { isSidechain: true }),
      JSON.stringify({ type: 'assistant', message: { id: 'err', model: '<synthetic>', usage: { input_tokens: 9 } } }),
    );
    const first = await reader.read(SID);
    expect([...first.keys()]).toEqual(['msg_7zy1']);
    expect(first.get('msg_7zy1')).toMatchObject({ outputTokens: 326, model: 'claude-opus-5-5' });
    // Only what was appended since — and a half-written line waits for its end.
    const last = line('msg_Ubmv', [2, 362, 137585, 701]);
    fs.appendFileSync(file, `${line('msg_GNhj', [2, 547, 137152, 433])}\n${last.slice(0, 40)}`);
    expect([...(await reader.read(SID)).keys()]).toEqual(['msg_GNhj']);
    fs.appendFileSync(file, `${last.slice(40)}\n`);
    expect([...(await reader.read(SID)).keys()]).toEqual(['msg_Ubmv']);
    expect((await reader.read(SID)).size).toBe(0);
  });

  it('a first read starts near the end of a long transcript and skips the cut line', async () => {
    append(line('old_1', [1, 1, 1, 1]), line('old_2', [1, 1, 1, 1]), line('new_1', [1, 7, 1, 1]));
    const size = fs.statSync(file).size;
    const lastLine = line('new_1', [1, 7, 1, 1]).length + 1;
    // The tail window cuts into the middle of old_2's line: it is skipped, new_1 is read whole.
    const reader = createMainCallReader({ configDir, tailBytes: lastLine + 10 });
    const got = await reader.read(SID);
    expect(size).toBeGreaterThan(lastLine + 10);
    expect([...got.keys()]).toEqual(['new_1']);
  });

  it('reads of one session never hand out the same lines twice, even when they overlap', async () => {
    append(line('a', [1, 2, 3, 4]));
    const reader = createMainCallReader({ configDir });
    const [x, y] = await Promise.all([reader.read(SID), reader.read(SID)]);
    expect(x.size + y.size).toBe(1);
  });

  it('a missing transcript reads as no calls (and is looked for again later, not on every call)', async () => {
    let t = 0;
    const reader = createMainCallReader({ configDir, now: () => t });
    const other = '00000000-1111-4222-8333-444444444444';
    expect((await reader.read(other)).size).toBe(0);
    fs.writeFileSync(path.join(path.dirname(file), `${other}.jsonl`), `${line('late', [1, 1, 1, 1])}\n`);
    expect((await reader.read(other)).size).toBe(0);
    t = 61_000;
    expect([...(await reader.read(other)).keys()]).toEqual(['late']);
  });

  it('reconcileTaskCalls moves each known call to its final usage and reports whether anything changed', () => {
    const l = liveRun();
    const calls = new Map();
    collectTranscriptCalls(
      [
        line('msg_7zy1', [2, 326, 136683, 469]),
        line('msg_GNhj', [2, 547, 137152, 433]),
        line('msg_other', [1, 1, 1, 1]),
      ].join('\n'),
      calls,
      true,
    );
    expect(reconcileTaskCalls(l, calls, 'm:', price)).toBe(true);
    const v = ledgerTasks(l).current;
    expect(v[0].tokens?.output).toBe(326);
    expect(v[1].tokens?.output).toBe(547);
    expect(v[0].tokens?.costUsd).toBeCloseTo(price(call([2, 326, 136683, 469])));
    // Subagent keys are separate: the same ids under `s:` are unknown here.
    expect(reconcileTaskCalls(l, calls, 's:', price)).toBe(false);
    expect(reconcileTaskCalls(l, calls, 'm:', price)).toBe(false);
  });
});

describe('a finished list is not reopened by the next one (live 2026-10-29)', () => {
  it('the same three steps run again are new tasks; the first run keeps its own times', () => {
    const t0 = Date.parse('2026-10-29T14:51:29Z');
    let l = applyTodoList(undefined, list(['in_progress', 'pending', 'pending']), t0);
    l = applyTodoList(l, list(['completed', 'in_progress', 'pending']), t0 + 10_000);
    l = applyTodoList(l, list(['completed', 'completed', 'completed']), t0 + 16_000);
    // A later turn: the same list again, from the start.
    l = applyTodoList(l, list(['in_progress', 'pending', 'pending']), t0 + 59_000);
    l = applyTodoList(l, list(['completed', 'in_progress', 'pending']), t0 + 65_000);
    const v = ledgerTasks(l);
    expect(v.current.map((t) => t.id)).toEqual(['T4', 'T5', 'T6']);
    expect(v.current[0]).toMatchObject({ status: 'completed', startedAt: t0 + 59_000, completedAt: t0 + 65_000 });
    expect(v.earlier.find((t) => t.id === 'T1')).toMatchObject({
      status: 'completed',
      startedAt: t0,
      completedAt: t0 + 10_000,
    });
  });

  it('a finished list sent again as finished still matches (no new tasks)', () => {
    let l = applyTodoList(undefined, list(['completed', 'completed', 'completed']), 1_000);
    l = applyTodoList(l, list(['completed', 'completed', 'completed']), 2_000);
    expect(ledgerTasks(l).current.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('within a list still under way, the exact text reopens a completed task (unchanged)', () => {
    let l = applyTodoList(undefined, list(['in_progress', 'pending', 'pending']), 1_000);
    l = applyTodoList(l, list(['completed', 'in_progress', 'pending']), 2_000);
    l = applyTodoList(l, list(['in_progress', 'completed', 'pending']), 3_000);
    const v = ledgerTasks(l).current;
    expect(v.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
    expect(v[0]).toMatchObject({ status: 'in_progress', startedAt: 1_000 });
  });
});
