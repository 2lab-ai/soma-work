#!/usr/bin/env node
/**
 * E4 dev measurement (.prd/19 §5 ⑩) — read-only over a soma-work data dir and its logs.
 *
 *   node scripts/e4-epic-measure.mjs [dataDir] [logDir] [--json]
 *
 * Defaults: /opt/soma-work/dev/data and its sibling logs/. It never writes.
 *
 * Per epic (live in sessions.json, or archived): its nodes and verdicts, done, its children
 * and how many each node spawned, its events by state and outcome, the wake chains that
 * consumed them, and each wake turn read from the epic's own conversation.
 *
 * The §5 ⑩ counters, each of which must be 0:
 *   - wrongStarts: a live child off its epic's plan or of another owner;
 *   - duplicateChildren: a node that spawned more than one child, or two live children on one node;
 *   - missedWakes: pending chain ends on a live, idle epic that is not done;
 *   - extraWakeTurns: wake turns beyond the chains that consumed events — each one must be a
 *     restart's released wake (compare with the restarts you made);
 *   - slackCalls: "A Slack-less task turn tried to call Slack" log lines (T9).
 *
 * A done epic may keep late chain ends pending: a done epic is never woken, by design. So
 * "nothing pending" is not a target.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The events a chain end leaves (approvals and closes never wake). */
const isChainEnd = (e) => e && e.outcome !== 'closed' && e.approvalId === undefined;
const WAKE_LINE = /Epic wake: \d+ events? — (.*?)\. Read details/;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Live records, then archived ones (an archive file holds one record) not already live. */
function loadRecords(dataDir) {
  const live = readJson(path.join(dataDir, 'sessions.json'), []);
  const records = (Array.isArray(live) ? live : []).filter((r) => r && typeof r === 'object');
  const seen = new Set(records.map((r) => r.taskId).filter(Boolean));
  const archDir = path.join(dataDir, 'archives');
  let files = [];
  try {
    files = fs.readdirSync(archDir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  for (const f of files) {
    const r = readJson(path.join(archDir, f), undefined);
    if (!r || typeof r !== 'object' || !r.taskId || seen.has(r.taskId)) continue;
    if (r.kind !== 'epic' && !r.parentTaskId) continue;
    seen.add(r.taskId);
    records.push({ ...r, archived: true });
  }
  return records;
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

function countLogLines(logPaths) {
  const counts = { slackCalls: 0, wakeNotStarted: 0, wakeFailed: 0, eventsDropped: 0 };
  for (const p of logPaths) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
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
    const perNode = new Map();
    for (const c of live) perNode.set(c.planNodeId, (perNode.get(c.planNodeId) ?? 0) + 1);

    const wrong = live.filter((c) => !nodeIds.has(c.planNodeId) || c.ownerId !== epic.ownerId).length;
    const dup =
      nodes.reduce((n, node) => n + Math.max(0, (node.spawned?.length ?? 0) - 1), 0) +
      [...perNode.values()].reduce((n, k) => n + Math.max(0, k - 1), 0);
    const pending = ends.filter((e) => e.state === 'pending');
    const idle = (epic.activityState ?? 'idle') === 'idle';
    const missed = !epic.archived && !epic.terminated && idle && !done ? pending.length : 0;
    const extra = Math.max(0, wakes.length - consumedBy.size);
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
      wakes,
      counters: { wrongStarts: wrong, duplicateChildren: dup, missedWakes: missed, extraWakeTurns: extra },
    });
  }
  const logs = countLogLines(logPaths);
  counters.slackCalls = logs.slackCalls;
  return { epics, counters, logs };
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
    out.push(`  wake turns=${e.wakes.length} consuming chains=${e.consumingChains}`);
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
  out.push(
    `logs: wake not started=${report.logs.wakeNotStarted} wake failed=${report.logs.wakeFailed} events dropped=${report.logs.eventsDropped}`,
  );
  out.push(`counters (each must be 0): ${JSON.stringify(report.counters)}`);
  out.push('extraWakeTurns counts released wakes too: each must match a restart you made.');
  return out.join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const [dataDir = '/opt/soma-work/dev/data', logDir = path.join(dataDir, '..', 'logs')] = argv.filter(
    (a) => a !== '--json',
  );
  const logs = ['stdout.log', 'stdout.log.1', 'stderr.log', 'stderr.log.1'].map((f) => path.join(logDir, f));
  const report = measure(dataDir, logs);
  process.stdout.write(`${json ? JSON.stringify(report) : format(report)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
