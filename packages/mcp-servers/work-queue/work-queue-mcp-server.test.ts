/**
 * The work-queue MCP server (.prd/36 §4.1, .prd/37 §3): four tools over the shared ledger, answered on the spot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkQueueStore } from '@soma/process-shared/work-queue/store.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkQueueTools, readWorkQueuesFromConfigFile, WORK_QUEUE_TOOLS } from './work-queue-mcp-server';

let dir: string;
let store: WorkQueueStore;
const QUEUES = [
  { id: 'qa:dev2', lane: 'qa', env: 'dev2' },
  { id: 'deploy:dev2', lane: 'deploy', env: 'dev2' },
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-queue-mcp-'));
  store = new WorkQueueStore(path.join(dir, 'work-queues.sqlite3'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function tools(threadTs: string, queues = QUEUES, now = 1_000) {
  return createWorkQueueTools({
    store,
    queues: () => queues,
    context: { user: `U-${threadTs}`, channel: 'C1', threadTs },
    now: () => now,
  });
}

describe('work-queue MCP tools', () => {
  it('defines queue_list, queue_enter, queue_done, queue_cancel', () => {
    expect(WORK_QUEUE_TOOLS.map((t) => t.name)).toEqual(['queue_list', 'queue_enter', 'queue_done', 'queue_cancel']);
    const enter = WORK_QUEUE_TOOLS.find((t) => t.name === 'queue_enter');
    expect(enter?.inputSchema.required).toEqual(['queue', 'keys']);
    expect(enter?.description).toMatch(/cron/i);
    expect(enter?.description).toMatch(/Jira/);
  });

  it('enter on an empty queue runs now and says to start', () => {
    const r = tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['abc-1'] });
    expect(r).toMatchObject({
      ok: true,
      status: 'running',
      entry: { id: 'wq-1', keys: ['ABC-1'], holder: { channel: 'C1', threadTs: '1.1' } },
    });
    expect(r.next).toMatch(/queue_done/);
  });

  it('enter behind a running entry waits and says to end the turn — no polling, no cron, no question', () => {
    tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    const r = tools('2.2').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-2'] });
    expect(r).toMatchObject({ ok: true, status: 'queued', position: 1, ahead: [{ id: 'wq-1', state: 'running' }] });
    expect(r.next).toMatch(/end (this|your) turn/i);
    expect(r.next).toMatch(/cron/i);
  });

  it('a conflict names the taken keys and tells the model to drop them and enter again', () => {
    tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    const r = tools('2.2').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1', 'ABC-2'] });
    expect(r).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      conflicts: [{ key: 'ABC-1', entry: 'wq-1', state: 'running' }],
    });
    expect(r.next).toMatch(/drop/i);
  });

  it('done hands over to the next entry and names it; only the holder thread may end its entry', () => {
    tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    tools('2.2').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-2'] });
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
    tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    tools('2.2').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-2'] });
    expect(tools('2.2').call('queue_cancel', { entry: 'wq-2', reason: 'not needed' })).toMatchObject({
      ok: true,
      ended: { id: 'wq-2', end: 'cancelled', reason: 'not needed' },
    });
  });

  it('list shows every configured queue with what runs, waits and recently ended, and marks this thread', () => {
    tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    tools('2.2').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-2'] });
    const r = tools('2.2').call('queue_list', {});
    expect(r).toMatchObject({
      ok: true,
      queues: [
        { queue: 'qa:dev2', running: { id: 'wq-1' }, queued: [{ id: 'wq-2' }] },
        { queue: 'deploy:dev2', queued: [] },
      ],
      mine: [{ id: 'wq-2', position: 1 }],
    });
    expect(tools('2.2').call('queue_list', { queue: 'deploy:dev2' })).toMatchObject({
      queues: [{ queue: 'deploy:dev2' }],
    });
  });

  it('list shows what recently ended, newest first, with its outcome and reason', () => {
    tools('1.1').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    tools('1.1').call('queue_done', { entry: 'wq-1' });
    tools('2.2').call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-2'] });
    tools('2.2').call('queue_cancel', { entry: 'wq-2', reason: 'not needed' });
    tools('3.3').call('queue_enter', { queue: 'deploy:dev2', keys: ['2lab-ai/soma-work#9'] });
    tools('3.3').call('queue_done', { entry: 'wq-3' });
    const r = tools('9.9').call('queue_list', {}) as any;
    expect(r.queues[0].recent.map((e: any) => [e.id, e.end, e.reason])).toEqual([
      ['wq-2', 'cancelled', 'not needed'],
      ['wq-1', 'done', undefined],
    ]);
    expect(r.queues[1].recent.map((e: any) => [e.id, e.end])).toEqual([['wq-3', 'done']]);
  });

  it('a host with no queues says so on every tool — work goes on without a line', () => {
    const r = tools('1.1', []).call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    expect(r).toMatchObject({ ok: false, code: 'NO_QUEUES' });
    expect(r.next).toMatch(/without/i);
    expect(tools('1.1', []).call('queue_list', {})).toMatchObject({ ok: false, code: 'NO_QUEUES' });
  });

  it('bad arguments are refused before the ledger is touched', () => {
    expect(tools('1.1').call('queue_done', {})).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(tools('1.1').call('queue_enter', { keys: ['ABC-1'] })).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(fs.existsSync(path.join(dir, 'work-queues.sqlite3'))).toBe(false);
  });

  it('a call from no thread is refused (the host gives every session its thread)', () => {
    const t = createWorkQueueTools({ store, queues: () => QUEUES, context: undefined, now: () => 1 });
    expect(t.call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] })).toMatchObject({
      ok: false,
      code: 'NO_THREAD',
    });
  });
});

describe('readWorkQueuesFromConfigFile', () => {
  it('reads workQueues from config.json and re-reads it when the file changes', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ workQueues: { deploy: ['dev'] } }));
    const read = readWorkQueuesFromConfigFile(file);
    expect(read().map((q) => q.id)).toEqual(['deploy:dev']);
    fs.writeFileSync(file, JSON.stringify({ workQueues: { deploy: ['dev'], qa: ['dev'] } }));
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    expect(read().map((q) => q.id)).toEqual(['deploy:dev', 'qa:dev']);
  });

  it('a missing config is no queues', () => {
    expect(readWorkQueuesFromConfigFile(path.join(dir, 'none.json'))()).toEqual([]);
  });

  it('an unreadable config keeps the last good queues; with none it throws (never "no queues")', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ workQueues: { deploy: ['dev'] } }));
    const read = readWorkQueuesFromConfigFile(file);
    expect(read().map((q) => q.id)).toEqual(['deploy:dev']);
    fs.writeFileSync(file, '{ torn');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    expect(read().map((q) => q.id)).toEqual(['deploy:dev']);
    // Fixed again without a new mtime: read again, not cached as broken.
    fs.writeFileSync(file, JSON.stringify({ workQueues: { qa: ['dev'] } }));
    fs.utimesSync(file, later, later);
    expect(read().map((q) => q.id)).toEqual(['qa:dev']);
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{');
    expect(() => readWorkQueuesFromConfigFile(broken)()).toThrow(/config/i);
  });

  it('a workQueues key with no valid queue is not "no queues": it keeps the last good queues or throws', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ workQueues: { deploy: ['dev'] } }));
    const read = readWorkQueuesFromConfigFile(file);
    expect(read().map((q) => q.id)).toEqual(['deploy:dev']);
    fs.writeFileSync(file, JSON.stringify({ workQueues: 'deploy' }));
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    expect(read().map((q) => q.id)).toEqual(['deploy:dev']);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ workQueues: { deploy: 'dev2' } }));
    expect(() => readWorkQueuesFromConfigFile(bad)()).toThrow(/workQueues/);
    // A config root that is not an object (null, an array) is broken, not "no workQueues key".
    const rootless = path.join(dir, 'rootless.json');
    fs.writeFileSync(rootless, 'null');
    expect(() => readWorkQueuesFromConfigFile(rootless)()).toThrow(/config/i);
    // The #726 opt-out `[]` still reads as no queues (no error).
    const optOut = path.join(dir, 'opt-out.json');
    fs.writeFileSync(optOut, JSON.stringify({ workQueues: [] }));
    expect(readWorkQueuesFromConfigFile(optOut)()).toEqual([]);
    // An explicit empty map is a host that queues nothing — that is not an error.
    const none = path.join(dir, 'none-on-purpose.json');
    fs.writeFileSync(none, JSON.stringify({ workQueues: {} }));
    expect(readWorkQueuesFromConfigFile(none)()).toEqual([]);
  });

  it('a config that cannot be read answers CONFIG_UNREADABLE — retry, never go on without a line', () => {
    const t = createWorkQueueTools({
      store,
      queues: () => {
        throw new Error('config.json unreadable');
      },
      context: { user: 'U1', channel: 'C1', threadTs: '1.1' },
      now: () => 1,
    });
    const r = t.call('queue_enter', { queue: 'qa:dev2', keys: ['ABC-1'] });
    expect(r).toMatchObject({ ok: false, code: 'CONFIG_UNREADABLE' });
    expect(r.next).not.toMatch(/without a line/i);
  });
});
