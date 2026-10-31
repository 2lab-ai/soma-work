#!/usr/bin/env node
/**
 * E4 dev measurement (.prd/19 §5 ⑩) — read-only over a soma-work data dir and its logs.
 *
 *   node scripts/e4-epic-measure.mjs [dataDir] [logDir] [--since <ISO time>] [--json]
 *
 * Defaults: /opt/soma-work/dev/data and its sibling logs/; logs since 24 hours ago (the live
 * stdout.log and stderr.log always, rotated files — plain or .gz — modified since then). It never writes.
 *
 * Per epic (live in sessions.json, or archived): its nodes and verdicts, done, its children
 * and how many each node spawned, its events by state and outcome, the wake chains that
 * consumed them, and each wake turn read from the epic's own conversation.
 *
 * The §5 ⑩ counters, each of which must be 0:
 *   - wrongStarts: a live child off its epic's plan or of another owner;
 *   - duplicateChildren: two live children on one node, or a node that spawned again while its
 *     child was still live (spawning again after the child closed is allowed, D9 a);
 *   - missedWakes: pending chain ends on a live, idle epic that is not done, other than the
 *     ones a recorded wake turn already named (a restart's released wake, waiting to run again);
 *   - extraWakeTurns: wake turns that no consuming chain matches — each one must be a restart's
 *     released wake (compare with the restarts that cut an epic turn holding events);
 *   - slackCalls: "A Slack-less task turn tried to call Slack" log lines (T9) — at most one per
 *     process, so read it as "did any task turn call Slack".
 *
 * Read missedWakes with the `Epic wake not started` count: an epic refused with 429 (window,
 * slots, cost limit) keeps its events pending by design until a new event wakes it.
 *
 * A done epic may keep late chain ends pending: a done epic is never woken, by design. So
 * "nothing pending" is not a target.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/** The events a chain end leaves (approvals and closes never wake). */
const isChainEnd = (e) => e && e.outcome !== 'closed' && e.approvalId === undefined;
const WAKE_LINE = /Epic wake: \d+ events? — (.*?)\. Read details/;
/** The word a wake turn says for each chain end (src/task-turn/epic-plan.ts WAKE_WORD). */
const WAKE_WORD = { completed: 'finished', failed: 'failed', cancelled: 'cancelled', waiting: 'needs-input', interrupted: 'interrupted' };
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/; // src/task-turn/epic-plan.ts EPIC_NODE_ID
const wakeItem = (e) => `${NODE_ID.test(e.planNodeId ?? '') ? e.planNodeId : 'node'}:${WAKE_WORD[e.outcome]}`;
/** The live log files, and the rotated ones (`stdout.log.1`, `20261031-2054-01-stdout.log.gz`, …). */
const LOG_FILE = /(^|-)(stdout|stderr)\.log(\.\d+)?(\.gz)?$/;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Live records, then archived ones not already live. An archive file (`<key>_<ms>.json`) holds one
 * record and is append-only: the same task can have several, and the newest one wins. An archive
 * says `finalActivityState` where a live record says `activityState`.
 */
function loadRecords(dataDir) {
  const live = readJson(path.join(dataDir, 'sessions.json'), []);
  const records = (Array.isArray(live) ? live : []).filter((r) => r && typeof r === 'object');
  const liveIds = new Set(records.map((r) => r.taskId).filter(Boolean));
  const archDir = path.join(dataDir, 'archives');
  let files = [];
  try {
    files = fs.readdirSync(archDir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const stamp = (f) => Number(/_(\d+)\.json$/.exec(f)?.[1] ?? 0);
  const archived = new Map();
  for (const f of files.sort((a, b) => stamp(a) - stamp(b) || a.localeCompare(b))) {
    const r = readJson(path.join(archDir, f), undefined);
    if (!r || typeof r !== 'object' || !r.taskId || liveIds.has(r.taskId)) continue;
    if (r.kind !== 'epic' && !r.parentTaskId) continue;
    archived.set(r.taskId, { ...r, activityState: r.finalActivityState ?? r.activityState, archived: true });
  }
  return [...records, ...archived.values()];
}

/** The node:word items of each wake turn in the epic's conversation, in order. */
function wakeTurns(dataDir, epic) {
  if (!epic.conversationId) return [];
  const conv = readJson(path.join(dataDir, 'conversations', `${epic.conversationId}.json`), undefined);
  const turns = [];
  for (const t of conv?.turns ?? []) {
    if (t?.role !== 'user') continue;
    const m = WAKE_LINE.exec(String(t.rawContent ?? ''));
    if (m) turns.push(m[1].split(', '));
  }
  return turns;
}

/** The live stdout.log and stderr.log, and every rotated log file modified at or after `sinceMs`. */
export function logFiles(logDir, sinceMs) {
  let names = [];
  try {
    names = fs.readdirSync(logDir).filter((f) => LOG_FILE.test(f));
  } catch {
    return [];
  }
  return names
    .filter((f) => f === 'stdout.log' || f === 'stderr.log' || fs.statSync(path.join(logDir, f)).mtimeMs >= sinceMs)
    .sort()
    .map((f) => path.join(logDir, f));
}

function countLogLines(logPaths) {
  const counts = { slackCalls: 0, wakeNotStarted: 0, wakeFailed: 0, eventsDropped: 0 };
  for (const p of logPaths) {
    let text;
    try {
      const raw = fs.readFileSync(p);
      text = (p.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.includes('A Slack-less task turn tried to call Slack')) counts.slackCalls++;
      if (line.includes('Epic wake not started')) counts.wakeNotStarted++;
      if (line.includes('Epic wake failed')) counts.wakeFailed++;
      if (line.includes('Epic event dropped')) counts.eventsDropped++;
    }
  }
  return counts;
}

export function measure(dataDir, logPaths) {
  const records = loadRecords(dataDir);
  const byTask = new Map(records.filter((r) => r.taskId).map((r) => [r.taskId, r]));
  const counters = { wrongStarts: 0, duplicateChildren: 0, missedWakes: 0, extraWakeTurns: 0, slackCalls: 0 };
  const epics = [];
  for (const epic of records.filter((r) => r.kind === 'epic')) {
    const nodes = epic.plan?.nodes ?? [];
    const nodeIds = new Set(nodes.map((n) => n.id));
    const children = (epic.childTaskIds ?? []).map((id) => byTask.get(id)).filter(Boolean);
    const live = children.filter((c) => !c.archived && !c.terminated);
    const ends = (epic.epicEvents ?? []).filter(isChainEnd);
    const consumedBy = new Map();
    for (const e of ends) if (e.consumedBy) consumedBy.set(e.consumedBy, (consumedBy.get(e.consumedBy) ?? 0) + 1);
    const wakes = wakeTurns(dataDir, epic);
    const done = Boolean(epic.plan?.done) || (nodes.length > 0 && nodes.every((n) => n.accepted));

    const offPlan = (c) => !nodeIds.has(c.planNodeId) || c.ownerId !== epic.ownerId;
    const wrong = live.filter(offPlan).length;
    // One live child per node. A node may spawn again once its child closed (D9 a): a second spawn
    // is a duplicate only while the child before it is still live and not closed by its parent.
    const isLive = (id) => {
      const c = byTask.get(id);
      return Boolean(c && !c.archived && !c.terminated && !c.closedBy);
    };
    const dup = nodes.reduce((n, node) => {
      const spawned = node.spawned ?? [];
      const respawnedOverLive = spawned.slice(1).filter((_, i) => isLive(spawned[i])).length;
      const liveHere = live.filter((c) => !offPlan(c) && c.planNodeId === node.id).length;
      return n + Math.max(respawnedOverLive, liveHere - 1, 0);
    }, 0);
    const pending = ends.filter((e) => e.state === 'pending');
    // A restart that cut a wake turn put its events back to pending (and cleared consumedBy); the
    // boot scan wakes the epic for them again. Until it has, a pending end that a recorded wake
    // turn named beyond what the consumed ends account for is that released wake, not a missed one.
    const named = new Map();
    for (const item of wakes.flat()) named.set(item, (named.get(item) ?? 0) + 1);
    for (const e of ends) if (e.consumedBy) named.set(wakeItem(e), (named.get(wakeItem(e)) ?? 0) - 1);
    let released = 0;
    const unnamed = pending.filter((e) => {
      const left = named.get(wakeItem(e)) ?? 0;
      if (left <= 0) return true;
      named.set(wakeItem(e), left - 1);
      released++;
      return false;
    });
    const idle = (epic.activityState ?? 'idle') === 'idle';
    const missed = !epic.archived && !epic.terminated && idle && !done ? unnamed.length : 0;
    // Each committed wake turn names exactly the events its chain consumed. Match turns to chains by
    // those items: a turn with no chain is a restart's released wake, or a duplicate. An owner's
    // instruction also consumes events (D9 e), but it is no wake turn, so it cannot hide one.
    const chainItems = new Map();
    for (const e of ends) if (e.consumedBy) chainItems.set(e.consumedBy, [...(chainItems.get(e.consumedBy) ?? []), wakeItem(e)]);
    const keyOf = (items) => [...items].sort().join(',');
    const chains = new Map();
    for (const items of chainItems.values()) chains.set(keyOf(items), (chains.get(keyOf(items)) ?? 0) + 1);
    let extra = 0;
    for (const items of wakes) {
      const left = chains.get(keyOf(items)) ?? 0;
      if (left > 0) chains.set(keyOf(items), left - 1);
      else extra++;
    }
    const unwokenChains = [...chains.values()].reduce((n, k) => n + k, 0);
    counters.wrongStarts += wrong;
    counters.duplicateChildren += dup;
    counters.missedWakes += missed;
    counters.extraWakeTurns += extra;

    const tally = (key) => ends.reduce((acc, e) => ({ ...acc, [e[key]]: (acc[e[key]] ?? 0) + 1 }), {});
    epics.push({
      taskId: epic.taskId,
      ownerId: epic.ownerId,
      archived: epic.archived === true,
      state: epic.activityState ?? 'idle',
      done,
      nodes: nodes.map((n) => ({ id: n.id, accepted: Boolean(n.accepted), spawned: n.spawned?.length ?? 0 })),
      children: children.map((c) => ({
        taskId: c.taskId,
        node: c.planNodeId,
        state: c.activityState ?? 'idle',
        last: c.lastTurnOutcome?.outcome,
        closedBy: c.closedBy?.by,
        archived: c.archived === true,
      })),
      events: { byState: tally('state'), byOutcome: tally('outcome') },
      consumingChains: consumedBy.size,
      chainsWithoutWakeTurn: unwokenChains,
      releasedPending: released,
      wakes,
      counters: { wrongStarts: wrong, duplicateChildren: dup, missedWakes: missed, extraWakeTurns: extra },
    });
  }
  const logs = countLogLines(logPaths);
  counters.slackCalls = logs.slackCalls;
  return { epics, counters, logs, logFiles: logPaths };
}

export function format(report) {
  const out = [`epics: ${report.epics.length}`];
  for (const e of report.epics) {
    out.push('');
    out.push(`epic ${e.taskId} owner=${e.ownerId} state=${e.state} done=${e.done}${e.archived ? ' (archived)' : ''}`);
    const accepted = e.nodes.filter((n) => n.accepted).length;
    out.push(`  nodes=${e.nodes.length} accepted=${accepted} children=${e.children.length}`);
    out.push(`  spawned per node: ${e.nodes.map((n) => `${n.id}=${n.spawned}`).join(' ')}`);
    out.push(`  events: ${JSON.stringify(e.events.byState)} ${JSON.stringify(e.events.byOutcome)}`);
    out.push(
      `  wake turns=${e.wakes.length} consuming chains=${e.consumingChains} (owner instructions, no wake turn: ${e.chainsWithoutWakeTurn}) released, waiting to wake=${e.releasedPending}`,
    );
    e.wakes.forEach((items, i) => {
      out.push(`    wake ${i + 1}: ${items.join(', ')}`);
    });
    for (const c of e.children) {
      out.push(
        `    child ${c.taskId} node=${c.node} state=${c.state} last=${c.last ?? '-'}${c.closedBy ? ` closedBy=${c.closedBy}` : ''}${c.archived ? ' (archived)' : ''}`,
      );
    }
  }
  out.push('');
  out.push(`logs read: ${report.logFiles.map((f) => path.basename(f)).join(' ') || '(none)'}`);
  out.push(
    `logs: wake not started=${report.logs.wakeNotStarted} wake failed=${report.logs.wakeFailed} events dropped=${report.logs.eventsDropped}`,
  );
  out.push(`counters (each must be 0): ${JSON.stringify(report.counters)}`);
  out.push('extraWakeTurns counts released wakes too: each must match a restart you made.');
  return out.join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const at = argv.indexOf('--since');
  const since = at >= 0 ? Date.parse(argv[at + 1] ?? '') : Date.now() - 24 * 60 * 60 * 1000;
  if (Number.isNaN(since)) {
    process.stderr.write('--since needs an ISO time, for example 2026-11-01T09:00:00Z\n');
    process.exit(2);
  }
  const positional = argv.filter((a, i) => a !== '--json' && (at < 0 || (i !== at && i !== at + 1)));
  const [dataDir = '/opt/soma-work/dev/data', logDir = path.join(dataDir, '..', 'logs')] = positional;
  const report = measure(dataDir, logFiles(logDir, since));
  process.stdout.write(`${json ? JSON.stringify(report) : format(report)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
