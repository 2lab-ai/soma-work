/**
 * E4 ⑩ — the dev measurement script (`scripts/e4-epic-measure.mjs`, .prd/19 §5 ⑩) run as the
 * runbook runs it, on scratch data dirs:
 *
 *   M1 a clean epic (3 nodes, 3 children, a wake per child, done): every counter 0;
 *   M2 each fault moves its own counter — a second child on a node, a child off the plan or of
 *      another owner, a pending end on an idle epic not done, a task turn's Slack call (T9);
 *   M3 a done epic's late pending ends are not missed wakes; a wake turn beyond the consuming
 *      chains (a restart's release) is counted apart;
 *   M4 an archived epic and its archived children are read; the script writes nothing.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', 'e4-epic-measure.mjs');
let root: string;
let data: string;
let logs: string;

const NODES = ['login', 'docs', 'api'];
function epicRecord(extra: Record<string, unknown> = {}) {
  return {
    taskId: 'E1',
    kind: 'epic',
    slackless: true,
    ownerId: 'U1',
    conversationId: 'conv-e1',
    activityState: 'idle',
    childTaskIds: ['c1', 'c2', 'c3'],
    plan: {
      nodes: NODES.map((id, i) => ({
        id,
        title: id,
        kind: 'issue',
        spawned: [`c${i + 1}`],
        accepted: { by: 'epic', at: 1 },
      })),
      done: { by: 'epic', at: 2 },
    },
    epicEvents: NODES.map((id, i) => ({
      id: `c${i + 1}:ch${i + 1}`,
      childTaskId: `c${i + 1}`,
      planNodeId: id,
      outcome: 'completed',
      state: 'delivered',
      consumedBy: `w${i + 1}`,
      at: i,
    })),
    ...extra,
  };
}
const child = (n: number, extra: Record<string, unknown> = {}) => ({
  taskId: `c${n}`,
  slackless: true,
  ownerId: 'U1',
  parentTaskId: 'E1',
  planNodeId: NODES[n - 1],
  activityState: 'idle',
  lastTurnOutcome: { outcome: 'completed', at: 5 },
  ...extra,
});
const wakeTurn = (items: string[]) => ({
  role: 'user',
  rawContent: `Epic wake: ${items.length} event${items.length === 1 ? '' : 's'} — ${items.join(', ')}. Read details with child_status.`,
});

function write(sessions: unknown[], wakes: string[][], logLines: string[] = []) {
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify(sessions));
  fs.writeFileSync(
    path.join(data, 'conversations', 'conv-e1.json'),
    JSON.stringify({ turns: [{ role: 'user', rawContent: 'do three things' }, ...wakes.map(wakeTurn)] }),
  );
  fs.writeFileSync(path.join(logs, 'stdout.log'), logLines.join('\n'));
}
function run(): { epics: any[]; counters: Record<string, number>; logs: Record<string, number> } {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, data, logs, '--json'], { encoding: 'utf8' }));
}
const ZERO = { wrongStarts: 0, duplicateChildren: 0, missedWakes: 0, extraWakeTurns: 0, slackCalls: 0 };
const ONE_WAKE_EACH = [['login:finished'], ['docs:finished'], ['api:finished']];

describe('scripts/e4-epic-measure.mjs (E4 ⑩, .prd/19 §5 ⑩)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-measure-'));
    data = path.join(root, 'data');
    logs = path.join(root, 'logs');
    fs.mkdirSync(path.join(data, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(data, 'archives'));
    fs.mkdirSync(logs);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('M1 — a clean epic: 3 nodes accepted, 3 children, one wake each, done; every counter 0', () => {
    write([epicRecord(), child(1), child(2), child(3)], ONE_WAKE_EACH);
    const r = run();
    expect(r.counters).toEqual(ZERO);
    expect(r.epics).toHaveLength(1);
    const e = r.epics[0];
    expect(e.done).toBe(true);
    expect(e.nodes.map((n: any) => [n.id, n.accepted, n.spawned])).toEqual([
      ['login', true, 1],
      ['docs', true, 1],
      ['api', true, 1],
    ]);
    expect(e.consumingChains).toBe(3);
    expect(e.wakes).toEqual(ONE_WAKE_EACH);
    // The text report says the same, ending with the counters.
    const text = execFileSync(process.execPath, [SCRIPT, data, logs], { encoding: 'utf8' });
    expect(text).toContain('wake 2: docs:finished');
    expect(text).toContain(`counters (each must be 0): ${JSON.stringify(ZERO)}`);
  });

  it('M2 — each fault moves its own counter', () => {
    const plan = epicRecord().plan;
    plan.nodes[0].spawned = ['c1', 'c9'];
    delete (plan as any).done;
    delete (plan.nodes[2] as any).accepted;
    const epic = epicRecord({
      plan,
      childTaskIds: ['c1', 'c2', 'c3', 'c9', 'c8', 'c7'],
      epicEvents: [
        ...epicRecord().epicEvents,
        { id: 'c3:ch9', childTaskId: 'c3', planNodeId: 'api', outcome: 'failed', state: 'pending', at: 9 },
      ],
    });
    write(
      [
        epic,
        child(1),
        child(2),
        child(3),
        child(1, { taskId: 'c9' }), // a second live child on login
        child(2, { taskId: 'c8', planNodeId: 'nope' }), // off the plan
        child(3, { taskId: 'c7', ownerId: 'U2' }), // another owner's
      ],
      ONE_WAKE_EACH,
      [
        '[2026-11-01T00:00:00.000Z] [ERROR] [TaskTurnExecutor] A Slack-less task turn tried to call Slack — a missed seam {"method":"chat.postMessage"}',
        '[2026-11-01T00:00:01.000Z] [INFO ] [EpicWaker] Epic wake not started — its events stay pending {"status":429}',
      ],
    );
    const r = run();
    // login spawned twice (1) + two live children on login (1) + two on api counting the other owner's (1).
    expect(r.counters.duplicateChildren).toBe(3);
    expect(r.counters.wrongStarts).toBe(2);
    expect(r.counters.missedWakes).toBe(1);
    expect(r.counters.slackCalls).toBe(1);
    expect(r.counters.extraWakeTurns).toBe(0);
    expect(r.logs.wakeNotStarted).toBe(1);
  });

  it('M3 — a done epic’s late pending ends are not missed; a wake beyond the consuming chains is counted apart', () => {
    const epic = epicRecord({
      epicEvents: [
        ...epicRecord().epicEvents,
        { id: 'c2:ch8', childTaskId: 'c2', planNodeId: 'docs', outcome: 'completed', state: 'pending', at: 8 },
      ],
    });
    // A restart released the docs wake: it ran twice, one chain kept the consumption.
    write(
      [epic, child(1), child(2), child(3)],
      [['login:finished'], ['docs:finished'], ['docs:finished'], ['api:finished']],
    );
    const r = run();
    expect(r.counters.missedWakes).toBe(0);
    expect(r.counters.extraWakeTurns).toBe(1);
    expect(r.epics[0].events.byState).toEqual({ delivered: 3, pending: 1 });
  });

  it('M4 — an archived epic and its children are read; nothing is written', () => {
    fs.writeFileSync(path.join(data, 'archives', 'E1.json'), JSON.stringify(epicRecord()));
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(data, 'archives', `c${n}.json`), JSON.stringify(child(n)));
    fs.writeFileSync(path.join(data, 'archives', 'other.json'), JSON.stringify({ taskId: 'X', slackless: true }));
    write([], ONE_WAKE_EACH);
    const snapshot = () =>
      fs
        .readdirSync(root, { recursive: true })
        .map(String)
        .sort()
        .map((f) => {
          const p = path.join(root, f);
          return fs.statSync(p).isFile() ? `${f}:${fs.statSync(p).mtimeMs}` : f;
        });
    const before = snapshot();
    const r = run();
    expect(snapshot()).toEqual(before);
    expect(r.epics).toHaveLength(1);
    expect(r.epics[0].archived).toBe(true);
    expect(r.epics[0].children.map((c: any) => [c.taskId, c.archived])).toEqual([
      ['c1', true],
      ['c2', true],
      ['c3', true],
    ]);
    expect(r.counters).toEqual(ZERO);
  });

  it('no data at all: no epics, every counter 0', () => {
    const r = run();
    expect(r.epics).toEqual([]);
    expect(r.counters).toEqual(ZERO);
  });
});
