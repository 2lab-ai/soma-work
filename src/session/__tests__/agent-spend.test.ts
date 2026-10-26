/**
 * RED — each subagent's own spend: tokens and API-equivalent cost (SSOT T2).
 *
 * The number the dashboard showed for a subagent was the SDK's
 * `task_notification.usage.total_tokens` — the size of its last context, not
 * what it spent (dev 2026-10-26: 194 subagents showed Σ 23.9M tokens, their
 * transcripts spent Σ 389.6M; a grok panelist showed 134 tokens, spent 10.0M).
 * The host never sees a subagent's text-only calls (`forwardSubagentText` is
 * off), so the spend is read from the subagent's own transcript:
 * `<config>/projects/<cwd>/<sdkSessionId>/subagents/agent-<taskId>.jsonl`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentRegistry,
  applyAgentEvent,
  sanitizeAgentRegistry,
  stampWorkLogAgent,
  subagentSpendOf,
} from '../agent-registry';
import { backfillAgentSpend, createAgentSpendReader } from '../agent-spend';

const SID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-10-26T00:00:00Z');

let configDir: string;
let subDir: string;

function assistant(id: string, model: string, u: [number, number, number, number]) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: {
      id,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: u[0],
        output_tokens: u[1],
        cache_read_input_tokens: u[2],
        cache_creation_input_tokens: u[3],
      },
    },
  });
}

function writeAgent(taskId: string, lines: string[], append = false) {
  const f = path.join(subDir, `agent-${taskId}.jsonl`);
  const body = `${lines.join('\n')}\n`;
  if (append) fs.appendFileSync(f, body);
  else fs.writeFileSync(f, body);
  return f;
}

/** $1 per million tokens of any kind, $2 for output — so the test can see the per-model price applied. */
const price = (
  model: string | undefined,
  t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
) =>
  ((model === 'claude-opus-5-5' ? 1 : 10) *
    (t.inputTokens + 2 * t.outputTokens + t.cacheReadTokens + t.cacheCreateTokens)) /
  1_000_000;
const isPriced = (model: string) => model.startsWith('claude-');

function holder(): { sessionId: string; agents?: AgentRegistry } {
  const h: { sessionId: string; agents?: AgentRegistry } = { sessionId: SID };
  applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_a', agentType: 'Explore', background: true, ts: T0 });
  applyAgentEvent(h, {
    kind: 'lifecycle',
    agentId: 'toolu_a',
    taskId: 'aaaa1111',
    phase: 'started',
    taskType: 'local_agent',
    ts: T0 + 1,
  } as any);
  return h;
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-spend-'));
  const projectDir = path.join(configDir, 'projects', '-tmp-session-x');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${SID}.jsonl`), '');
  subDir = path.join(projectDir, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('agent spend — read from the subagent transcript (T2)', () => {
  it('sums each API call once (the last line of a message wins), skips synthetic lines, prices per model', async () => {
    writeAgent('aaaa1111', [
      assistant('msg_1', 'claude-opus-5-5', [10, 5, 1000, 100]), // partial frame of msg_1
      assistant('msg_1', 'claude-opus-5-5', [10, 50, 1000, 100]), // final frame of msg_1
      '{"type":"user","message":{"role":"user","content":"tool result"}}',
      assistant('msg_2', 'claude-opus-5-5', [20, 30, 2000, 0]),
      assistant('err', '<synthetic>', [999, 999, 999, 999]),
      'not json at all',
    ]);
    const h = holder();
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0 });
    expect(await reader.refresh(h)).toBe(true);
    const a = h.agents!.agents[0];
    expect(a.spend).toMatchObject({
      inputTokens: 30,
      outputTokens: 80,
      cacheReadTokens: 3000,
      cacheCreateTokens: 100,
      calls: 2,
    });
    expect(a.spend!.costUsd).toBeCloseTo((30 + 160 + 3000 + 100) / 1_000_000);
    expect(a.spend!.unpricedModels).toBeUndefined();
    // The SDK session the agent ran in is remembered (a later /new must not lose the file).
    expect(a.sdkSessionId).toBe(SID);
  });

  it('reads only what was appended since the last read, and a half-written line waits for its end', async () => {
    const f = writeAgent('aaaa1111', [assistant('msg_1', 'claude-opus-5-5', [1, 1, 100, 0])]);
    const h = holder();
    let now = T0;
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => now, minIntervalMs: 0 });
    await reader.refresh(h);
    expect(h.agents!.agents[0].spend!.calls).toBe(1);
    const next = assistant('msg_2', 'claude-opus-5-5', [2, 2, 200, 0]);
    fs.appendFileSync(f, next.slice(0, 40));
    now += 1;
    await reader.refresh(h);
    expect(h.agents!.agents[0].spend!.calls).toBe(1);
    fs.appendFileSync(f, `${next.slice(40)}\n`);
    now += 1;
    expect(await reader.refresh(h)).toBe(true);
    expect(h.agents!.agents[0].spend).toMatchObject({ calls: 2, inputTokens: 3, cacheReadTokens: 300 });
  });

  it('a transcript bigger than one read chunk is read to its end before it is sealed (review r1)', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => assistant(`m${i}`, 'claude-opus-5-5', [1, 1, 1, 1]));
    writeAgent('aaaa1111', lines);
    const h = holder();
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_a', ok: true, ack: false, ts: T0 + 5 });
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0, chunkBytes: 97 });
    await reader.refresh(h, { force: true });
    const a = h.agents!.agents[0];
    expect(a.spend!.calls).toBe(20);
    expect(a.spendFinal).toBe(true);
  });

  it('review r1 — the SDK session is taken when the agent is first seen, before its transcript exists', async () => {
    const h = holder();
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0 });
    await reader.refresh(h);
    expect(h.agents!.agents[0].sdkSessionId).toBe(SID);
    // A later /new moves the session on; the agent's file is still found under its own SDK session.
    h.sessionId = '99999999-2222-4333-8444-555555555555';
    writeAgent('aaaa1111', [assistant('m1', 'claude-opus-5-5', [1, 1, 1, 1])]);
    await reader.refresh(h, { force: true });
    expect(h.agents!.agents[0].spend!.calls).toBe(1);
  });

  it('review r1 — a half-written last line is never sealed away', async () => {
    const f = writeAgent('aaaa1111', [assistant('m1', 'claude-opus-5-5', [1, 1, 1, 1])]);
    const tail = assistant('m2', 'claude-opus-5-5', [2, 2, 2, 2]);
    fs.appendFileSync(f, tail.slice(0, 30));
    const h = holder();
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_a', ok: true, ack: false, ts: T0 + 5 });
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0 });
    await reader.refresh(h, { force: true });
    expect(h.agents!.agents[0].spendFinal).toBeUndefined();
    fs.appendFileSync(f, `${tail.slice(30)}\n`);
    await reader.refresh(h, { force: true });
    expect(h.agents!.agents[0].spend!.calls).toBe(2);
    expect(h.agents!.agents[0].spendFinal).toBe(true);
  });

  it('review r1 — a multi-byte character split across read chunks is decoded whole', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '한글한글한글' }],
        usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    writeAgent('aaaa1111', [line, assistant('m2', 'claude-opus-5-5', [1, 0, 0, 0])]);
    const h = holder();
    for (const chunkBytes of [7, 11, 13]) {
      const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0, chunkBytes });
      delete h.agents!.agents[0].spend;
      await reader.refresh(h, { force: true });
      expect(h.agents!.agents[0].spend).toMatchObject({ calls: 2, inputTokens: 4, outputTokens: 4 });
    }
  });

  it('review r1 — an agent we lost sight of is sealed at turn end, and any later activity unseals it', async () => {
    const f = writeAgent('aaaa1111', [assistant('m1', 'claude-opus-5-5', [1, 0, 0, 0])]);
    const h = holder();
    applyAgentEvent(h, { kind: 'turn_end', ts: T0 + 5 });
    h.agents!.agents[0].status = 'unknown';
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0, minIntervalMs: 0 });
    await reader.refresh(h, { force: true });
    expect(h.agents!.agents[0].spendFinal).toBe(true);
    // Resumed (SendMessage) or alive again: its new calls count.
    fs.appendFileSync(f, `${assistant('m2', 'claude-opus-5-5', [1, 0, 0, 0])}\n`);
    applyAgentEvent(h, { kind: 'lifecycle', agentId: 'toolu_a', taskId: 'aaaa1111', phase: 'progress', ts: T0 + 9 });
    expect(h.agents!.agents[0].spendFinal).toBeUndefined();
    await reader.refresh(h);
    expect(h.agents!.agents[0].spend!.calls).toBe(2);
  });

  it('review r2 — a transcript that grew while it was being read is not sealed', async () => {
    const f = writeAgent('aaaa1111', [assistant('m1', 'claude-opus-5-5', [1, 0, 0, 0])]);
    const h = holder();
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_a', ok: true, ack: false, ts: T0 + 5 });
    let appended = false;
    const growing = (model: string | undefined, t: Parameters<typeof price>[1]) => {
      // The agent writes another call while the read is being priced.
      if (!appended) {
        appended = true;
        fs.appendFileSync(f, `${assistant('m2', 'claude-opus-5-5', [1, 0, 0, 0])}\n`);
      }
      return price(model, t);
    };
    const reader = createAgentSpendReader({ configDir, price: growing, isPriced, now: () => T0 });
    await reader.refresh(h, { force: true });
    expect(h.agents!.agents[0].spendFinal).toBeUndefined();
    await reader.refresh(h, { force: true });
    expect(h.agents!.agents[0].spend!.calls).toBe(2);
    expect(h.agents!.agents[0].spendFinal).toBe(true);
  });

  it('a model the price table does not know is still priced, and named so the UI can say it is an estimate', async () => {
    writeAgent('aaaa1111', [
      assistant('m1', 'grok-4.7-build', [100, 10, 0, 0]),
      assistant('m2', 'claude-opus-5-5', [100, 10, 0, 0]),
    ]);
    const h = holder();
    await createAgentSpendReader({ configDir, price, isPriced, now: () => T0 }).refresh(h);
    const s = h.agents!.agents[0].spend!;
    expect(s.costUsd).toBeCloseTo((10 * 120 + 120) / 1_000_000);
    expect(s.unpricedModels).toEqual(['grok-4.7-build']);
  });

  it('a running agent is re-read at most once per interval; turn_end (force) re-reads and seals a finished one', async () => {
    const f = writeAgent('aaaa1111', [assistant('m1', 'claude-opus-5-5', [1, 0, 0, 0])]);
    const h = holder();
    let now = T0;
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => now, minIntervalMs: 10_000 });
    await reader.refresh(h);
    fs.appendFileSync(f, `${assistant('m2', 'claude-opus-5-5', [1, 0, 0, 0])}\n`);
    now += 1000;
    expect(await reader.refresh(h)).toBe(false);
    expect(h.agents!.agents[0].spend!.calls).toBe(1);
    now += 10_000;
    expect(await reader.refresh(h)).toBe(true);
    expect(h.agents!.agents[0].spend!.calls).toBe(2);

    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_a', ok: true, ack: false, ts: now });
    fs.appendFileSync(f, `${assistant('m3', 'claude-opus-5-5', [1, 0, 0, 0])}\n`);
    now += 1;
    await reader.refresh(h, { force: true });
    const a = h.agents!.agents[0];
    expect(a.spend!.calls).toBe(3);
    expect(a.spendFinal).toBe(true);
    // Sealed: nothing reads it again.
    fs.appendFileSync(f, `${assistant('m4', 'claude-opus-5-5', [1, 0, 0, 0])}\n`);
    now += 60_000;
    expect(await reader.refresh(h, { force: true })).toBe(false);
    expect(a.spend!.calls).toBe(3);
  });

  it('never reads outside the subagents directory: a hostile task id or a symlinked transcript is refused', async () => {
    const outside = path.join(configDir, 'secret.jsonl');
    fs.writeFileSync(outside, `${assistant('s', 'claude-opus-5-5', [5, 5, 5, 5])}\n`);
    fs.symlinkSync(outside, path.join(subDir, 'agent-bbbb2222.jsonl'));
    const h = holder();
    h.agents!.agents[0].taskId = '../../secret';
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_b', ts: T0 + 2 });
    h.agents!.agents[1].taskId = 'bbbb2222';
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0 });
    expect(await reader.refresh(h, { force: true })).toBe(false);
    expect(h.agents!.agents.map((a) => a.spend)).toEqual([undefined, undefined]);
  });

  it('an agent without a transcript yet, or without an SDK session, keeps no spend and does not throw', async () => {
    const h = holder();
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0 });
    expect(await reader.refresh(h)).toBe(false);
    expect(await reader.refresh({ agents: h.agents })).toBe(false);
    expect(h.agents!.agents[0].spend).toBeUndefined();
  });
});

describe('agent spend — registry: persisted, and the subagent sum survives the record cap', () => {
  const spend = (n: number) => ({
    inputTokens: n,
    outputTokens: n,
    cacheReadTokens: 10 * n,
    cacheCreateTokens: 0,
    costUsd: n / 100,
    calls: 1,
  });

  it('round-trips spend, the SDK session and the seal through sanitizeAgentRegistry', () => {
    const h = holder();
    const a = h.agents!.agents[0];
    a.spend = { ...spend(7), unpricedModels: ['grok-4.7-build'] };
    a.sdkSessionId = SID;
    a.spendFinal = true;
    const { calls: _calls, ...pruned } = spend(3);
    h.agents!.prunedSpend = { ...pruned, agents: 2 };
    const back = sanitizeAgentRegistry(JSON.parse(JSON.stringify(h.agents)))!;
    expect(back.agents[0].spend).toEqual(a.spend);
    expect(back.agents[0].sdkSessionId).toBe(SID);
    expect(back.agents[0].spendFinal).toBe(true);
    expect(back.prunedSpend).toEqual(h.agents!.prunedSpend);
    // Garbage is dropped, never trusted.
    const bad = sanitizeAgentRegistry({
      nextN: 2,
      agents: [{ id: 'x', n: 1, status: 'completed', startedAt: T0, toolCalls: 0, spend: { inputTokens: 'lots' } }],
      prunedSpend: { costUsd: -1 },
    })!;
    expect(bad.agents[0].spend).toBeUndefined();
    expect(bad.prunedSpend).toBeUndefined();
  });

  // The cap reads the wall clock (an unread record goes a day after it ended):
  // these tests pin it, so they do not depend on the day they run (review r3).
  function capRegistry(now: number): { agents?: AgentRegistry } {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    return {};
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  it('review r1 — the cap drops sealed records first, never one whose spend is still being read', () => {
    const h = capRegistry(T0 + 60_000);
    applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_unread', ts: T0 });
    h.agents!.agents[0].taskId = 'unread1';
    applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_unread', ok: true, ack: false, ts: T0 + 1 });
    for (let i = 0; i < 100; i++) {
      applyAgentEvent(h, { kind: 'spawn', agentId: `toolu_${i}`, ts: T0 + 10 + i });
      const rec = h.agents!.agents[h.agents!.agents.length - 1];
      rec.spend = spend(1);
      rec.spendFinal = true;
      applyAgentEvent(h, { kind: 'returned', agentId: `toolu_${i}`, ok: true, ack: false, ts: T0 + 11 + i });
    }
    expect(h.agents!.agents.some((a) => a.id === 'toolu_unread')).toBe(true);
    expect(subagentSpendOf(h.agents)!.agents).toBe(100);
  });

  it('review r2 — with no settled record to drop, an unread one is kept over the cap (its spend is not lost)', () => {
    const h = capRegistry(T0 + 60_000);
    for (let i = 0; i < 101; i++) {
      applyAgentEvent(h, { kind: 'spawn', agentId: `toolu_u${i}`, ts: T0 + i });
      h.agents!.agents[h.agents!.agents.length - 1].taskId = `task${i}`;
      applyAgentEvent(h, { kind: 'returned', agentId: `toolu_u${i}`, ok: true, ack: false, ts: T0 + i });
    }
    expect(h.agents!.agents).toHaveLength(101);
    expect(h.agents!.agents[0].id).toBe('toolu_u0');
  });

  it('review r3 — an unread record a day after it ended no longer holds the cap', () => {
    const h = capRegistry(T0 + 25 * 60 * 60 * 1000);
    for (let i = 0; i < 101; i++) {
      applyAgentEvent(h, { kind: 'spawn', agentId: `toolu_u${i}`, ts: T0 + i });
      h.agents!.agents[h.agents!.agents.length - 1].taskId = `task${i}`;
      applyAgentEvent(h, { kind: 'returned', agentId: `toolu_u${i}`, ok: true, ack: false, ts: T0 + i });
    }
    expect(h.agents!.agents).toHaveLength(100);
    expect(h.agents!.agents[0].id).toBe('toolu_u1');
  });

  it('review r1 — work-log activity of a sealed agent unseals it', () => {
    const h = holder();
    h.agents!.agents[0].spendFinal = true;
    stampWorkLogAgent(h, { kind: 'tool', tool: 'Read', agentId: 'toolu_a' }, T0 + 9);
    expect(h.agents!.agents[0].spendFinal).toBeUndefined();
  });

  it('subagentSpendOf sums every subagent — including those the 100-record cap dropped', () => {
    const h: { agents?: AgentRegistry } = {};
    for (let i = 0; i < 105; i++) {
      applyAgentEvent(h, { kind: 'spawn', agentId: `toolu_${i}`, ts: T0 + i });
      h.agents!.agents[h.agents!.agents.length - 1].spend = spend(1);
      applyAgentEvent(h, { kind: 'returned', agentId: `toolu_${i}`, ok: true, ack: false, ts: T0 + i + 1 });
    }
    expect(h.agents!.agents.length).toBeLessThanOrEqual(100);
    const sum = subagentSpendOf(h.agents)!;
    expect(sum.agents).toBe(105);
    expect(sum.inputTokens).toBe(105);
    expect(sum.cacheReadTokens).toBe(1050);
    expect(sum.costUsd).toBeCloseTo(1.05);
    expect(subagentSpendOf({ nextN: 1, agents: [] })).toBeUndefined();
  });
});

describe('agent spend — startup backfill (subagents that ended before this process)', () => {
  it('reads every loaded session once, seals what ended, and names the sessions that changed', async () => {
    writeAgent('aaaa1111', [assistant('m1', 'claude-opus-5-5', [1, 2, 3, 4])]);
    const done = holder();
    // Loaded after a restart: what was running is out of sight now.
    done.agents!.agents[0].status = 'unknown';
    const empty = { sessionId: SID, agents: undefined };
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0 });
    const changed: string[] = [];
    await backfillAgentSpend(
      [
        ['C1:t1', done],
        ['C1:t2', empty],
      ],
      reader,
      (key) => changed.push(key),
    );
    expect(done.agents!.agents[0].spend).toMatchObject({ calls: 1, inputTokens: 1, outputTokens: 2 });
    expect(done.agents!.agents[0].spendFinal).toBe(true);
    expect(changed).toEqual(['C1:t1']);
  });

  it('one session that fails to read does not stop the others', async () => {
    writeAgent('aaaa1111', [assistant('m1', 'claude-opus-5-5', [1, 0, 0, 0])]);
    const ok = holder();
    const broken = {
      sessionId: SID,
      get agents(): AgentRegistry {
        throw new Error('boom');
      },
    };
    const reader = createAgentSpendReader({ configDir, price, isPriced, now: () => T0 });
    const changed: string[] = [];
    await backfillAgentSpend(
      [
        ['C1:bad', broken as never],
        ['C1:ok', ok],
      ],
      reader,
      (key) => changed.push(key),
    );
    expect(changed).toEqual(['C1:ok']);
  });
});
