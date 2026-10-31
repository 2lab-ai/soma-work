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
 *   M5 (grok #712 R1) a restart's released wake, not yet run again, is not a missed wake; an
 *      open approval is no chain end; an epic with every node accepted is done without
 *      `plan.done`; a Slack call in a rotated .gz log since `--since` counts, an older one is not read.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
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
function run(...extra: string[]): {
  epics: any[];
  counters: Record<string, number>;
  logs: Record<string, number>;
  logFiles: string[];
} {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, data, logs, ...extra, '--json'], { encoding: 'utf8' }));
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
    // login spawned again over a live child, and has two live children: one fault, counted once.
    // The other owner's child on api and the off-plan one are wrong starts, not duplicates.
    expect(r.counters.duplicateChildren).toBe(1);
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
    // Real archive files: `<key>_<ms>.json`, `finalActivityState`, append-only (the newest wins).
    const archive = (r: Record<string, unknown>) => {
      const { activityState, lastTurnOutcome: _drop, ...rest } = r;
      return JSON.stringify({ ...rest, finalActivityState: activityState });
    };
    fs.writeFileSync(
      path.join(data, 'archives', 'task-E1_1730000000000.json'),
      archive(epicRecord({ activityState: 'working' })),
    );
    fs.writeFileSync(path.join(data, 'archives', 'task-E1_1730000009999.json'), archive(epicRecord()));
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(
        path.join(data, 'archives', `task-c${n}_1730000005000.json`),
        archive(child(n, n === 2 ? { activityState: 'waiting' } : {})),
      );
    }
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
    expect(r.epics[0].state).toBe('idle');
    expect(r.epics[0].children.map((c: any) => [c.taskId, c.archived, c.state])).toEqual([
      ['c1', true, 'idle'],
      ['c2', true, 'waiting'],
      ['c3', true, 'idle'],
    ]);
    expect(r.counters).toEqual(ZERO);
  });

  it('M5a — a restart’s released wake, not run again yet: not a missed wake; counted once as extra', () => {
    // The docs wake turn was cut: its event is pending again with consumedBy cleared (releaseEpicEvents).
    const events = epicRecord().epicEvents;
    const docs = events[1] as Record<string, unknown>;
    docs.state = 'pending';
    delete docs.consumedBy;
    const plan = epicRecord().plan;
    delete (plan as any).done;
    delete (plan.nodes[1] as any).accepted;
    delete (plan.nodes[2] as any).accepted;
    write(
      [epicRecord({ plan, epicEvents: events.slice(0, 2) }), child(1), child(2), child(3)],
      [['login:finished'], ['docs:finished']],
    );
    const r = run();
    expect(r.counters.missedWakes).toBe(0);
    expect(r.counters.extraWakeTurns).toBe(1);
    expect(r.epics[0].releasedPending).toBe(1);
    // A second pending end on docs that no wake named is still missed.
    const more = [...events.slice(0, 2), { ...docs, id: 'c2:ch9', at: 9 }];
    write(
      [epicRecord({ plan, epicEvents: more }), child(1), child(2), child(3)],
      [['login:finished'], ['docs:finished']],
    );
    expect(run().counters.missedWakes).toBe(1);

    // A node woken once and consumed, then ending again unwoken: the old wake does not cover the new end.
    const again = [
      ...epicRecord().epicEvents.slice(0, 2),
      { id: 'c2:ch7', childTaskId: 'c2', planNodeId: 'docs', outcome: 'completed', state: 'pending', at: 7 },
    ];
    write(
      [epicRecord({ plan, epicEvents: again }), child(1), child(2), child(3)],
      [['login:finished'], ['docs:finished']],
    );
    expect(run().counters.missedWakes).toBe(1);
  });

  it('M5b — an open approval never wakes: not a missed wake; every node accepted is done without plan.done', () => {
    const plan = epicRecord().plan;
    delete (plan as any).done;
    delete (plan.nodes[2] as any).accepted;
    const approval = {
      id: 'c3:ap-1',
      childTaskId: 'c3',
      planNodeId: 'api',
      outcome: 'needs-input',
      approvalId: 'ap-1',
      chainId: 'ch3',
      state: 'pending',
      at: 7,
    };
    write(
      [
        epicRecord({ plan, epicEvents: [...epicRecord().epicEvents.slice(0, 2), approval] }),
        child(1),
        child(2),
        child(3),
      ],
      [['login:finished'], ['docs:finished']],
    );
    expect(run().counters.missedWakes).toBe(0);
    // A child's close is recorded delivered and never wakes: it is no chain end either.
    const closed = {
      id: 'c3:closed',
      childTaskId: 'c3',
      planNodeId: 'api',
      outcome: 'closed',
      state: 'delivered',
      at: 9,
    };
    write(
      [
        epicRecord({ plan, epicEvents: [...epicRecord().epicEvents.slice(0, 2), closed] }),
        child(1),
        child(2),
        child(3),
      ],
      [['login:finished'], ['docs:finished']],
    );
    expect(run().epics[0].events.byOutcome).toEqual({ completed: 2 });

    // Every node accepted, no plan.done: done, so a late pending end is not missed.
    const accepted = epicRecord().plan;
    delete (accepted as any).done;
    const late = {
      id: 'c1:ch8',
      childTaskId: 'c1',
      planNodeId: 'login',
      outcome: 'completed',
      state: 'pending',
      at: 8,
    };
    write(
      [epicRecord({ plan: accepted, epicEvents: [...epicRecord().epicEvents, late] }), child(1), child(2), child(3)],
      ONE_WAKE_EACH,
    );
    const r = run();
    expect(r.epics[0].done).toBe(true);
    expect(r.counters.missedWakes).toBe(0);
  });

  it('M5c — a Slack call in a rotated .gz log since --since counts; a rotated log older than that is not read', () => {
    write([], []);
    const seam =
      '[2026-11-01T00:00:00.000Z] [ERROR] [TaskTurnExecutor] A Slack-less task turn tried to call Slack — a missed seam';
    const recent = path.join(logs, '20261101-0900-01-stderr.log.gz');
    const old = path.join(logs, 'stdout.log.1');
    fs.writeFileSync(recent, zlib.gzipSync(`${seam}\n`));
    fs.writeFileSync(old, `${seam}\n${seam}\n`);
    const t = (iso: string) => new Date(iso);
    fs.utimesSync(recent, t('2026-11-01T09:00:00Z'), t('2026-11-01T09:00:00Z'));
    fs.utimesSync(old, t('2026-05-07T11:10:00Z'), t('2026-05-07T11:10:00Z'));
    const r = run('--since', '2026-11-01T08:00:00Z');
    expect(r.counters.slackCalls).toBe(1);
    expect(r.logFiles.map((f) => path.basename(f))).toEqual(['20261101-0900-01-stderr.log.gz', 'stdout.log']);
    // Since May, the old rotation is read too.
    expect(run('--since', '2026-05-01T00:00:00Z').counters.slackCalls).toBe(3);
    // A bad --since is refused.
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, data, logs, '--since', 'yesterday'], { stdio: 'pipe' }),
    ).toThrow();
  });

  it('M6 (fable #712 R1) — the branches each counter turns on', () => {
    // A working epic with a pending end is not a missed wake: it reads the end in its turn.
    const openPlan = epicRecord().plan;
    delete (openPlan as any).done;
    delete (openPlan.nodes[2] as any).accepted;
    const open = epicRecord({ activityState: 'working', plan: openPlan });
    (open.epicEvents[2] as Record<string, unknown>).state = 'pending';
    delete (open.epicEvents[2] as Record<string, unknown>).consumedBy;
    write([open, child(1), child(2), child(3)], [['login:finished'], ['docs:finished']]);
    expect(run().counters.missedWakes).toBe(0);
    // The same epic idle: missed.
    write([{ ...open, activityState: 'idle' }, child(1), child(2), child(3)], [['login:finished'], ['docs:finished']]);
    expect(run().counters.missedWakes).toBe(1);

    // One wake that consumed two events is one wake, not an extra.
    const two = epicRecord();
    (two.epicEvents[1] as Record<string, unknown>).consumedBy = 'w1';
    (two.epicEvents[2] as Record<string, unknown>).consumedBy = 'w2';
    write([two, child(1), child(2), child(3)], [['login:finished', 'docs:finished'], ['api:finished']]);
    let r = run();
    expect(r.counters.extraWakeTurns).toBe(0);
    expect(r.epics[0].consumingChains).toBe(2);

    // An owner instruction that consumed events cannot hide a duplicate wake turn.
    const owner = epicRecord();
    (owner.epicEvents[2] as Record<string, unknown>).consumedBy = 'owner-chain';
    write([owner, child(1), child(2), child(3)], [['login:finished'], ['docs:finished'], ['docs:finished']]);
    r = run();
    expect(r.counters.extraWakeTurns).toBe(1);
    expect(r.epics[0].chainsWithoutWakeTurn).toBe(1);

    // A released wake is released even when an owner instruction consumed the same node earlier
    // (fable #712 R2 P3-1): only unmatched wake turns name released events.
    const released = epicRecord();
    const ev = released.epicEvents as Array<Record<string, unknown>>;
    ev[1].consumedBy = 'owner-chain';
    ev[2].consumedBy = 'owner-chain';
    ev.push({ id: 'c2:ch9', childTaskId: 'c2', planNodeId: 'docs', outcome: 'completed', state: 'pending', at: 9 });
    delete (released.plan as any).done;
    delete (released.plan.nodes[1] as any).accepted;
    write([released, child(1), child(2), child(3)], [['login:finished'], ['docs:finished']]);
    r = run();
    expect(r.counters.missedWakes).toBe(0);
    expect(r.epics[0].releasedPending).toBe(1);
    expect(r.counters.extraWakeTurns).toBe(1);

    // Only the owner's (user) turns are wake turns: an assistant quoting one is not.
    write([epicRecord(), child(1), child(2), child(3)], ONE_WAKE_EACH);
    const conv = path.join(data, 'conversations', 'conv-e1.json');
    const withQuote = JSON.parse(fs.readFileSync(conv, 'utf8'));
    withQuote.turns.push({
      role: 'assistant',
      rawContent: 'I got "Epic wake: 1 event — docs:finished. Read details with child_status."',
    });
    fs.writeFileSync(conv, JSON.stringify(withQuote));
    expect(run().epics[0].wakes).toHaveLength(3);

    // A wake refusal line alone is no Slack call.
    write([epicRecord(), child(1), child(2), child(3)], ONE_WAKE_EACH, [
      '[2026-11-01T00:00:01.000Z] [INFO ] [EpicWaker] Epic wake not started — its events stay pending {"status":429}',
    ]);
    r = run();
    expect(r.counters.slackCalls).toBe(0);
    expect(r.logs.wakeNotStarted).toBe(1);
  });

  it('M7 (fable #712 R1) — a node may spawn again after its child closed; again over a live child is a duplicate', () => {
    const plan = epicRecord().plan;
    plan.nodes[0].spawned = ['c0', 'c1'];
    const epic = epicRecord({ plan, childTaskIds: ['c0', 'c1', 'c2', 'c3'] });
    // c0 was closed by the owner: archived, gone from sessions.json.
    fs.writeFileSync(
      path.join(data, 'archives', 'task-c0_1730000000000.json'),
      JSON.stringify({ ...child(1, { taskId: 'c0' }) }),
    );
    write([epic, child(1), child(2), child(3)], ONE_WAKE_EACH);
    expect(run().counters.duplicateChildren).toBe(0);
    // c0 closed by its parent's close, still on file: closed too.
    write(
      [epic, child(1, { taskId: 'c0', closedBy: { by: 'parent', at: 1 } }), child(1), child(2), child(3)],
      ONE_WAKE_EACH,
    );
    expect(run().counters.duplicateChildren).toBe(1); // two records on login, one of them live and open
    // c0 still live and open when c1 was made: a duplicate, counted once.
    write([epic, child(1, { taskId: 'c0' }), child(1), child(2), child(3)], ONE_WAKE_EACH);
    expect(run().counters.duplicateChildren).toBe(1);
    // …even once c1 is gone: the spawn over a live, open c0 was the fault.
    fs.writeFileSync(path.join(data, 'archives', 'task-c1_1730000000001.json'), JSON.stringify(child(1)));
    write([epic, child(1, { taskId: 'c0' }), child(2), child(3)], ONE_WAKE_EACH);
    expect(run().counters.duplicateChildren).toBe(1);
    // A c0 its parent's close cancelled is closed: spawning c1 after it is no duplicate.
    write([epic, child(1, { taskId: 'c0', closedBy: { by: 'parent', at: 1 } }), child(2), child(3)], ONE_WAKE_EACH);
    expect(run().counters.duplicateChildren).toBe(0);
  });

  it('no data at all: no epics, every counter 0', () => {
    const r = run();
    expect(r.epics).toEqual([]);
    expect(r.counters).toEqual(ZERO);
  });
});
