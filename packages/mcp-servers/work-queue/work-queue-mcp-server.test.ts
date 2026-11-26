/**
 * The work-queue MCP server (.prd/36 v2 §4.1, .prd/37 §3): five tools over the shared ledger, answered on the spot.
 * Lanes need no configuration; the config only pins lanes to list while empty.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPinnedQueuesFromConfigFile } from '@soma/process-shared/work-queue/config.js';
import { MemoryWorkQueueStore } from '@soma/process-shared/work-queue/memory-store.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkQueueTools, WORK_QUEUE_TOOLS } from './work-queue-mcp-server';

let dir: string;
// The tools run on the in-process store (same contract as the SQLite one), so they are checked on every runtime.
let store: MemoryWorkQueueStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-queue-mcp-'));
  store = new MemoryWorkQueueStore();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function tools(threadTs: string, pinned: string[] = [], now = 1_000) {
  return createWorkQueueTools({
    store,
    pinned: () => pinned,
    context: { user: `U-${threadTs}`, channel: 'C1', threadTs },
    now: () => now,
  });
}

describe('work-queue MCP tools', () => {
  it('defines queue_list, queue_try, queue_enter, queue_done, queue_cancel', () => {
    expect(WORK_QUEUE_TOOLS.map((t) => t.name)).toEqual([
      'queue_list',
      'queue_try',
      'queue_enter',
      'queue_done',
      'queue_cancel',
    ]);
    const enter = WORK_QUEUE_TOOLS.find((t) => t.name === 'queue_enter');
    expect(enter?.inputSchema.required).toEqual(['queue', 'keys']);
    expect(enter?.description).toMatch(/cron/i);
    expect(enter?.description).toMatch(/Jira/);
    // A skill's own lock for the lane is replaced by the line: busy is a wait, never a stop or a question.
    expect(enter?.description).toMatch(/lock/i);
  });

  it('a lane needs no configuration: the first enter makes it and runs now', () => {
    const r = tools('1.1').call('queue_enter', { queue: 'qa-dev2', keys: ['abc-1'] });
    expect(r).toMatchObject({
      ok: true,
      status: 'running',
      created: true,
      entry: { id: 'wq-1', queue: 'qa-dev2', keys: ['ABC-1'], holder: { channel: 'C1', threadTs: '1.1' } },
    });
    expect(r.next).toMatch(/queue_done/);
    expect(r.next).toMatch(/new lane/);
  });

  it('the v1 name `qa:dev2` is the same lane as `qa-dev2`', () => {
    tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    expect(tools('2.2').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-2'] })).toMatchObject({
      status: 'queued',
      position: 1,
    });
  });

  it('enter behind a running entry waits and says to end the turn — no polling, no cron, no question', () => {
    tools('1.1').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] });
    const r = tools('2.2').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-2'] });
    expect(r).toMatchObject({ ok: true, status: 'queued', position: 1, ahead: [{ id: 'wq-1', state: 'running' }] });
    expect(r.created).toBeUndefined();
    expect(r.next).toMatch(/end (this|your) turn/i);
    expect(r.next).toMatch(/cron/i);
  });

  it('try takes a free lane, and on a busy one adds nothing and says what is ahead', () => {
    expect(tools('1.1').call('queue_try', { queue: 'qa-dev2', keys: ['ABC-1'] })).toMatchObject({
      ok: true,
      status: 'running',
      entry: { id: 'wq-1' },
    });
    const busy = tools('2.2').call('queue_try', { queue: 'qa-dev2', keys: ['ABC-2'] });
    expect(busy).toMatchObject({ ok: true, status: 'busy', queue: 'qa-dev2', position: 1, ahead: [{ id: 'wq-1' }] });
    expect(busy.next).toMatch(/queue_enter/);
    expect(store.read().entries).toHaveLength(1);
  });

  it('a conflict names the claimed keys and the free ones to enter again with; none free → not needed', () => {
    tools('1.1').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] });
    const r = tools('2.2').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1', 'ABC-2'] });
    expect(r).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      free: ['ABC-2'],
      conflicts: [{ key: 'ABC-1', entry: 'wq-1', state: 'running' }],
    });
    expect(r.next).toMatch(/ABC-2/);
    const all = tools('3.3').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] });
    expect(all).toMatchObject({ ok: false, code: 'CONFLICT', free: [] });
    expect(all.next).toMatch(/not needed/);
  });

  it('done hands over to the next entry and names it; only the holder thread may end its entry', () => {
    tools('1.1').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] });
    tools('2.2').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-2'] });
    expect(tools('2.2').call('queue_done', { entry: 'wq-1' })).toMatchObject({ ok: false, code: 'NOT_HOLDER' });
    const r = tools('1.1').call('queue_done', { entry: 'wq-1' });
    expect(r).toMatchObject({
      ok: true,
      ended: { id: 'wq-1', end: 'done' },
      next_entry: { id: 'wq-2', state: 'running' },
    });
    expect(store.read().entries.map((e) => [e.id, e.state])).toEqual([['wq-2', 'running']]);
  });

  it('cancel leaves the line (or gives the turn back) with a reason', () => {
    tools('1.1').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] });
    tools('2.2').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-2'] });
    expect(tools('2.2').call('queue_cancel', { entry: 'wq-2', reason: 'not needed' })).toMatchObject({
      ok: true,
      ended: { id: 'wq-2', end: 'cancelled', reason: 'not needed' },
    });
  });

  it('list shows pinned lanes (even empty) and every lane in use, with what runs, waits and left; marks this thread', () => {
    tools('1.1').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] });
    tools('2.2').call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-2'] });
    tools('3.3').call('queue_enter', { queue: 'build-x', keys: ['ABC-3'] });
    tools('3.3').call('queue_done', { entry: 'wq-3' });
    const r = tools('2.2', ['deploy-dev2']).call('queue_list', {}) as any;
    expect(r.queues.map((q: any) => [q.id, q.running.map((e: any) => e.id), q.waiting.map((e: any) => e.id)])).toEqual([
      ['deploy-dev2', [], []],
      ['build-x', [], []],
      ['qa-dev2', ['wq-1'], ['wq-2']],
    ]);
    expect(r.queues[1].recent.map((e: any) => [e.id, e.end])).toEqual([['wq-3', 'done']]);
    expect(r.mine).toEqual([expect.objectContaining({ id: 'wq-2', position: 1 })]);
    expect(tools('2.2').call('queue_list', { queue: 'QA:dev2' })).toMatchObject({ queues: [{ id: 'qa-dev2' }] });
  });

  it('a thread-less session can list but not enter', () => {
    const t = createWorkQueueTools({ store, pinned: () => [], context: undefined, now: () => 1 });
    expect(t.call('queue_list', {})).toMatchObject({ ok: true });
    expect(t.call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] })).toMatchObject({
      ok: false,
      code: 'NO_THREAD',
    });
  });

  it('a runtime without node:sqlite says so and the model goes on without a line', () => {
    const t = createWorkQueueTools({
      store,
      pinned: () => [],
      context: { user: 'U', channel: 'C', threadTs: '1' },
      now: () => 1,
      available: () => false,
    });
    expect(t.call('queue_enter', { queue: 'qa-dev2', keys: ['ABC-1'] })).toMatchObject({
      ok: false,
      code: 'QUEUE_UNAVAILABLE',
    });
  });

  it('a bad lane name or bad keys are refused with what to fix', () => {
    expect(tools('1.1').call('queue_enter', { queue: 'qa dev2', keys: ['ABC-1'] })).toMatchObject({
      ok: false,
      code: 'INVALID_QUEUE',
    });
    expect(tools('1.1').call('queue_enter', { queue: 'qa-dev2', keys: ['nope'] })).toMatchObject({
      ok: false,
      code: 'INVALID_KEYS',
    });
    expect(tools('1.1').call('queue_done', { entry: 'x' })).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
  });
});

describe('readPinnedQueuesFromConfigFile', () => {
  it('pins `config.json#workQueues` and re-reads it when the file changes', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ workQueues: { qa: ['dev2'] } }));
    const pinned = readPinnedQueuesFromConfigFile(file);
    expect(pinned()).toEqual(['qa-dev2']);
    fs.writeFileSync(file, JSON.stringify({ workQueues: { qa: ['dev2'], deploy: ['dev2'] } }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(pinned()).toEqual(['qa-dev2', 'deploy-dev2']);
  });

  it('a missing or broken config pins nothing (or keeps the last good list) — lanes work either way', () => {
    expect(readPinnedQueuesFromConfigFile(path.join(dir, 'none.json'))()).toEqual([]);
    expect(readPinnedQueuesFromConfigFile(undefined)()).toEqual([]);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ workQueues: { qa: ['dev2'] } }));
    const pinned = readPinnedQueuesFromConfigFile(file);
    expect(pinned()).toEqual(['qa-dev2']);
    fs.writeFileSync(file, '{ broken');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(pinned()).toEqual(['qa-dev2']);
  });
});
