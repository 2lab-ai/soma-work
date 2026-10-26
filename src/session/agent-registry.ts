/**
 * Per-session agent registry (spec 12, `.prd/12-dashboard-agent-tree-spec.md`).
 *
 * The main agent is the session; every subagent it (or another subagent)
 * starts gets one record here, keyed by the id of the tool call that started
 * it — the id the SDK stamps on every frame of that subagent as
 * `parent_tool_use_id`. A record carries the agent's own task ledger (its
 * TodoWrite lists — never the main agent's), its tool-call count, and its
 * status.
 *
 * Status rules:
 *   - the SDK's settle (`task_notification`, terminal `task_updated`) is
 *     authoritative and may correct an earlier inferred end;
 *   - a foreground agent's tool result ends it (`ok` → completed, else failed);
 *     a background acknowledgement does not;
 *   - a running agent nobody can see any more — its turn ended without its
 *     result, the process restarted — is `unknown`, not `stopped`: we lost
 *     sight of it, we did not see it stop;
 *   - a progress frame of an `unknown` agent proves it alive again; nothing
 *     moves a finished agent back to running.
 *
 * Records are created only by a spawn (the `Agent` / `Task` call, or the first
 * frame of an agent not seen before) — never by SDK task lifecycle, which also
 * fires for background Bash commands; lifecycle of a non-agent task type is
 * ignored outright.
 *
 * Bounds: at most {@link AGENT_REGISTRY_MAX} records — the oldest finished
 * agents go first, and an agent that is running, or is an ancestor of a kept
 * agent, is never dropped (the bound may then be exceeded). Only the newest
 * {@link AGENT_LEDGER_KEEP} finished agents keep their task ledgers.
 *
 * Pure functions over plain data; the session owns the object and persists it.
 */

import { type AgentTreeEvent, normalizeAgentId } from '@soma/slack/agent-tree';
import { applyTodoList, sanitizeTaskLedger, stampWorkLogTask, type TaskLedger, type TodoInput } from './task-ledger';

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

/** Tokens and API-equivalent cost of a set of API calls. */
export interface SpendTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
}

/**
 * What one subagent spent: its own API calls, read from its transcript
 * (`agent-spend.ts`) — a nested subagent's calls are its own record's.
 */
export interface AgentSpend extends SpendTotals {
  /** API calls counted (one per message id). */
  calls: number;
  /** Models the price table does not know — priced at the fallback rate, so the cost is an estimate. */
  unpricedModels?: string[];
  /** Calls whose usage the transcript left all-zero, estimated from the calls around them (`agent-spend.ts`). */
  estimatedCalls?: number;
}

/** The subagents' spend added up (records still kept plus those the cap dropped). */
export interface SubagentSpendSum extends SpendTotals {
  /** Subagents counted. */
  agents: number;
  /** Some of it was priced at the fallback rate. */
  unpriced?: true;
  /** Some of it was estimated (calls recorded without usage). */
  estimated?: true;
}

export interface AgentRecord {
  /** The id of the tool call that started the agent. */
  id: string;
  /** Spawn order in the session, 1-based (`A1`, `A2`, …); never reused. */
  n: number;
  /** The agent that started it; absent = the main agent. */
  parentId?: string;
  /** `subagent_type` (or the spawning tool's name for a non-Agent spawner). */
  type?: string;
  description?: string;
  background?: boolean;
  status: AgentStatus;
  startedAt: number;
  /** When it ended — or, for `unknown`, when we lost sight of it. */
  endedAt?: number;
  /** Tool calls the agent made: the larger of the two counts below (never their sum). */
  toolCalls: number;
  /** Its `tool` work-log entries seen so far. */
  loggedTools?: number;
  /** The SDK's own cumulative count (task_progress / settle / Agent outcome). */
  reportedTools?: number;
  lastTool?: string;
  /**
   * The SDK's `total_tokens` for the run — the size of its last context, NOT
   * what it spent (see `spend`). Kept as the SDK sent it; never shown as spend.
   */
  tokens?: number;
  /** What it spent — its own API calls, from its transcript. */
  spend?: AgentSpend;
  /** The SDK session it ran in (where its transcript lives). */
  sdkSessionId?: string;
  /** `spend` is final: read after the agent ended and its turn closed. */
  spendFinal?: true;
  /** Run time the SDK reported. */
  durationMs?: number;
  /** The SDK's one-line summary (progress summary, or the settle's). */
  summary?: string;
  /** The SDK task id, once `task_started` named it. */
  taskId?: string;
  /** The status came from the SDK's settle (not inferred). */
  settled?: true;
  /** Its own TodoWrite lists. */
  ledger?: TaskLedger;
}

/**
 * The main agent's own counts — the root node of the session's agent tree.
 * Same rule as a subagent's logged tools: one per `tool` work-log entry it made.
 */
export interface AgentRootStats {
  toolCalls: number;
  lastTool?: string;
}

export interface AgentRegistry {
  /** The number the next new agent gets. */
  nextN: number;
  /** Oldest first. */
  agents: AgentRecord[];
  /** The main agent (absent until it calls a tool). */
  root?: AgentRootStats;
  /** The spend of the records {@link AGENT_REGISTRY_MAX} dropped — so the subagents' sum never shrinks. */
  prunedSpend?: SubagentSpendSum;
}

export const AGENT_REGISTRY_MAX = 100;
export const AGENT_LEDGER_KEEP = 40;
/** How long an ended record whose spend was never read is kept over the cap. */
const UNREAD_KEEP_MS = 24 * 60 * 60 * 1000;
const TEXT_MAX = 300;
const TYPE_MAX = 80;
const STATUSES = new Set<AgentStatus>(['running', 'completed', 'failed', 'stopped', 'unknown']);

const clip = (v: string, max: number) => (v.length > max ? v.slice(0, max) : v);

/** The holder the registry lives on: a session (or a test double). */
export interface AgentHolder {
  agents?: AgentRegistry;
  taskLedger?: TaskLedger;
}

export function agentById(reg: AgentRegistry | undefined, rawId: string | undefined): AgentRecord | undefined {
  if (!reg || !rawId) return undefined;
  const id = normalizeAgentId(rawId);
  for (const a of reg.agents) if (a.id === id) return a;
  return undefined;
}

function agentByTaskId(reg: AgentRegistry, taskId: string): AgentRecord | undefined {
  for (const a of reg.agents) if (a.taskId === taskId) return a;
  return undefined;
}

function ensureRegistry(h: AgentHolder): AgentRegistry {
  if (!h.agents) h.agents = { nextN: 1, agents: [] };
  return h.agents;
}

function isFinished(a: AgentRecord): boolean {
  return a.status !== 'running';
}

/** Create the agent `id` if it is new. Returns it and whether it was created. */
function ensureAgent(h: AgentHolder, rawId: string, ts: number): { agent: AgentRecord; created: boolean } {
  const id = normalizeAgentId(rawId);
  const reg = ensureRegistry(h);
  const known = agentById(reg, id);
  if (known) return { agent: known, created: false };
  const agent: AgentRecord = { id, n: reg.nextN++, status: 'running', startedAt: ts, toolCalls: 0 };
  reg.agents.push(agent);
  return { agent, created: true };
}

/** Fill a field only when it is still empty (a later, thinner report never erases what we know). */
function fill<K extends 'type' | 'description' | 'parentId'>(a: AgentRecord, key: K, v: unknown, max: number): boolean {
  if (a[key] !== undefined || typeof v !== 'string' || !v) return false;
  a[key] = clip(v, max) as AgentRecord[K];
  return true;
}

/** Two observations of one count (our log, the SDK's report): show the larger, never the sum (review R4). */
function setTools(a: AgentRecord, logged: number | undefined, reported: number | undefined): boolean {
  if (logged !== undefined) a.loggedTools = logged;
  if (reported !== undefined) a.reportedTools = Math.max(a.reportedTools ?? 0, reported);
  const next = Math.max(a.loggedTools ?? 0, a.reportedTools ?? 0);
  if (next === a.toolCalls) return false;
  a.toolCalls = next;
  return true;
}

function finish(a: AgentRecord, status: AgentStatus, ts: number): boolean {
  if (a.status === status && a.endedAt !== undefined) return false;
  a.status = status;
  a.endedAt = ts;
  return true;
}

/**
 * Fold one event into the holder's registry (in place). Returns whether
 * anything changed (the host pushes the card only then).
 */
export function applyAgentEvent(h: AgentHolder, event: AgentTreeEvent): boolean {
  const changed = applyOne(h, event);
  // Bounds after the record is complete (parent known) and after every end (review R5).
  if (changed && h.agents) enforceBounds(h.agents);
  return changed;
}

/**
 * The agent is active again (resumed by SendMessage, alive after we lost
 * sight of it, or reporting late): its transcript may grow, so a sealed spend
 * is read again (`agent-spend.ts`).
 */
function unseal(agent: AgentRecord): boolean {
  if (!agent.spendFinal) return false;
  delete agent.spendFinal;
  return true;
}

function applyOne(h: AgentHolder, event: AgentTreeEvent): boolean {
  if (event.kind !== 'turn_end' && h.agents) {
    const seen =
      agentById(h.agents, event.agentId) ??
      (event.kind === 'lifecycle' && event.taskId ? agentByTaskId(h.agents, event.taskId) : undefined);
    if (seen) unseal(seen);
  }
  switch (event.kind) {
    case 'spawn': {
      const { agent, created } = ensureAgent(h, event.agentId, event.ts);
      let changed = created;
      changed =
        fill(agent, 'parentId', event.parentAgentId ? normalizeAgentId(event.parentAgentId) : undefined, TEXT_MAX) ||
        changed;
      changed = fill(agent, 'type', event.agentType, TYPE_MAX) || changed;
      changed = fill(agent, 'description', event.description, TEXT_MAX) || changed;
      if (event.background === true && agent.background !== true) {
        agent.background = true;
        changed = true;
      } else if (event.background === false && agent.background === undefined) {
        agent.background = false;
        changed = true;
      }
      return changed;
    }
    case 'todos': {
      if (!Array.isArray(event.todos)) return false;
      const { agent } = ensureAgent(h, event.agentId, event.ts);
      agent.ledger = applyTodoList(agent.ledger, event.todos as TodoInput[], event.ts);
      return true;
    }
    case 'returned': {
      const agent = agentById(h.agents, event.agentId);
      if (!agent) return false;
      if (event.ack) {
        if (agent.background === true) return false;
        agent.background = true;
        return true;
      }
      let changed = event.toolUses !== undefined ? setTools(agent, undefined, event.toolUses) : false;
      if (event.durationMs !== undefined && agent.durationMs !== event.durationMs) {
        agent.durationMs = event.durationMs;
        changed = true;
      }
      // The SDK's settle outranks a tool result.
      if (agent.settled) return changed;
      if (agent.status === 'running' || agent.status === 'unknown') {
        changed = finish(agent, event.ok ? 'completed' : 'failed', event.ts) || changed;
      }
      return changed;
    }
    case 'lifecycle': {
      if (event.taskType && event.taskType !== 'local_agent') return false;
      const reg = h.agents;
      if (!reg) return false;
      const agent = agentById(reg, event.agentId) ?? agentByTaskId(reg, event.taskId);
      if (!agent) return false;
      let changed = false;
      if (!agent.taskId && event.taskId) {
        agent.taskId = event.taskId;
        changed = true;
      }
      changed = fill(agent, 'type', event.agentType, TYPE_MAX) || changed;
      changed = fill(agent, 'description', event.description, TEXT_MAX) || changed;
      if (event.background === true && agent.background !== true) {
        agent.background = true;
        changed = true;
      }
      if (event.summary) {
        const summary = clip(event.summary, TEXT_MAX);
        if (agent.summary !== summary) {
          agent.summary = summary;
          changed = true;
        }
      }
      if (event.lastTool && agent.lastTool !== event.lastTool) {
        agent.lastTool = clip(event.lastTool, TYPE_MAX);
        changed = true;
      }
      if (event.usage) {
        if (event.usage.totalTokens > 0 && agent.tokens !== event.usage.totalTokens) {
          agent.tokens = event.usage.totalTokens;
          changed = true;
        }
        if (event.usage.durationMs > 0 && agent.durationMs !== event.usage.durationMs) {
          agent.durationMs = event.usage.durationMs;
          changed = true;
        }
        if (event.usage.toolUses > 0) changed = setTools(agent, undefined, event.usage.toolUses) || changed;
      }
      if (event.phase === 'settled' && event.status) {
        agent.settled = true;
        changed = finish(agent, event.status, event.ts) || changed;
      } else if (agent.status === 'unknown' && !agent.settled) {
        // Seen again: it is alive.
        agent.status = 'running';
        agent.endedAt = undefined;
        changed = true;
      }
      return changed;
    }
    case 'turn_end': {
      let changed = false;
      for (const a of h.agents?.agents ?? []) {
        if (a.status === 'running' && a.background !== true) changed = finish(a, 'unknown', event.ts) || changed;
      }
      return changed;
    }
  }
}

/**
 * Stamp a work-log entry with the task in progress of the agent that made it
 * (the main agent's ledger when it has no `agentId`) and count a `tool` entry
 * on that agent. An entry of an agent the registry has never seen creates a
 * placeholder record, so its log stays reachable. Returns the stamped copy.
 */
export function stampWorkLogAgent<E extends { kind: string; tool?: string; agentId?: string }>(
  h: AgentHolder,
  entry: E,
  now: number,
): E & { taskId?: string; taskTitle?: string } {
  if (!entry.agentId) {
    if (entry.kind === 'tool') {
      const reg = ensureRegistry(h);
      const root: AgentRootStats = reg.root ?? { toolCalls: 0 };
      root.toolCalls += 1;
      if (entry.tool) root.lastTool = clip(String(entry.tool), TYPE_MAX);
      reg.root = root;
    }
    return stampWorkLogTask(h.taskLedger, entry);
  }
  const { agent, created } = ensureAgent(h, entry.agentId, now);
  unseal(agent);
  if (entry.kind === 'tool') {
    setTools(agent, (agent.loggedTools ?? 0) + 1, undefined);
    if (entry.tool) agent.lastTool = clip(String(entry.tool), TYPE_MAX);
  }
  if (created && h.agents) enforceBounds(h.agents);
  return stampWorkLogTask(agent.ledger, entry);
}

/** After a restart: every agent still marked running is out of sight. Returns a copy. */
export function loseRunningAgents(reg: AgentRegistry | undefined, now: number): AgentRegistry | undefined {
  if (!reg) return undefined;
  const out: AgentRegistry = {
    nextN: reg.nextN,
    agents: reg.agents.map((a) => (a.status === 'running' ? { ...a, status: 'unknown', endedAt: now } : a)),
  };
  if (reg.root) out.root = { ...reg.root };
  if (reg.prunedSpend) out.prunedSpend = { ...reg.prunedSpend };
  // Nothing runs now: an excess the running agents held is released.
  enforceBounds(out);
  return out;
}

function enforceBounds(reg: AgentRegistry): void {
  // Ledgers: only the newest AGENT_LEDGER_KEEP finished agents keep theirs.
  let finishedSeen = 0;
  for (let i = reg.agents.length - 1; i >= 0; i--) {
    const a = reg.agents[i];
    if (!isFinished(a)) continue;
    finishedSeen++;
    if (finishedSeen > AGENT_LEDGER_KEEP && a.ledger) a.ledger = undefined;
  }
  if (reg.agents.length <= AGENT_REGISTRY_MAX) return;
  const byId = new Map(reg.agents.map((a) => [a.id, a]));
  const pinned = new Set<string>();
  for (const a of reg.agents) {
    if (isFinished(a)) continue;
    // A running agent and every ancestor it hangs from.
    let cur: AgentRecord | undefined = a;
    while (cur && !pinned.has(cur.id)) {
      pinned.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  // Oldest first, and only a record whose spend is settled (sealed, or never
  // had a transcript): one whose final spend is still to be read stays until
  // the turn end seals it — dropping it would lose that spend for good. A
  // record unread a day after it ended (its transcript cannot be read) goes.
  const now = Date.now();
  const settled = (a: AgentRecord) =>
    a.spendFinal === true || !a.taskId || (a.endedAt !== undefined && now - a.endedAt > UNREAD_KEEP_MS);
  const drop = new Set<string>();
  let excess = reg.agents.length - AGENT_REGISTRY_MAX;
  for (const a of reg.agents) {
    if (excess <= 0) break;
    if (pinned.has(a.id) || !settled(a)) continue;
    drop.add(a.id);
    excess--;
  }
  if (!drop.size) return;
  reg.agents = reg.agents.filter((a) => {
    if (!drop.has(a.id)) return true;
    if (a.spend) reg.prunedSpend = addSpend(reg.prunedSpend, a.spend, a.spend.unpricedModels?.length ? 1 : 0);
    return false;
  });
}

function addSpend(
  sum: SubagentSpendSum | undefined,
  s: SpendTotals & { estimatedCalls?: number },
  unpriced: number,
): SubagentSpendSum {
  const out: SubagentSpendSum = sum
    ? { ...sum }
    : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0, agents: 0 };
  out.inputTokens += s.inputTokens;
  out.outputTokens += s.outputTokens;
  out.cacheReadTokens += s.cacheReadTokens;
  out.cacheCreateTokens += s.cacheCreateTokens;
  out.costUsd += s.costUsd;
  out.agents += 1;
  if (unpriced) out.unpriced = true;
  if (s.estimatedCalls) out.estimated = true;
  return out;
}

/**
 * The subagents' spend added up — every record that has one, plus what the
 * record cap dropped. Undefined when no subagent spend is known. A sum of
 * disjoint spends (each record holds only its own calls), so nothing is
 * counted twice.
 */
export function subagentSpendOf(reg: AgentRegistry | undefined): SubagentSpendSum | undefined {
  if (!reg) return undefined;
  let sum: SubagentSpendSum | undefined = reg.prunedSpend ? { ...reg.prunedSpend } : undefined;
  for (const a of reg.agents) if (a.spend) sum = addSpend(sum, a.spend, a.spend.unpricedModels?.length ? 1 : 0);
  return sum;
}

function finitePositive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Restore a persisted registry. Anything that is not one reads as none; bad records are dropped. */
export function sanitizeAgentRegistry(raw: unknown): AgentRegistry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const nextN = finitePositive(r.nextN);
  if (!nextN || !Array.isArray(r.agents)) return undefined;
  const agents: AgentRecord[] = [];
  const seen = new Set<string>();
  for (const item of r.agents) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const n = finitePositive(a.n);
    const startedAt = finitePositive(a.startedAt);
    if (typeof a.id !== 'string' || !a.id || seen.has(a.id) || !n || !startedAt) continue;
    seen.add(a.id);
    const rec: AgentRecord = {
      id: normalizeAgentId(a.id),
      n: Math.floor(n),
      status: STATUSES.has(a.status as AgentStatus) ? (a.status as AgentStatus) : 'unknown',
      startedAt,
      toolCalls: Math.floor(finitePositive(a.toolCalls) ?? 0),
    };
    if (typeof a.parentId === 'string' && a.parentId) rec.parentId = normalizeAgentId(a.parentId);
    if (typeof a.type === 'string' && a.type) rec.type = clip(a.type, TYPE_MAX);
    if (typeof a.description === 'string' && a.description) rec.description = clip(a.description, TEXT_MAX);
    if (typeof a.background === 'boolean') rec.background = a.background;
    const endedAt = finitePositive(a.endedAt);
    if (endedAt) rec.endedAt = endedAt;
    if (typeof a.lastTool === 'string' && a.lastTool) rec.lastTool = clip(a.lastTool, TYPE_MAX);
    const tokens = finitePositive(a.tokens);
    if (tokens) rec.tokens = tokens;
    const durationMs = finitePositive(a.durationMs);
    if (durationMs) rec.durationMs = durationMs;
    if (typeof a.summary === 'string' && a.summary) rec.summary = clip(a.summary, TEXT_MAX);
    if (typeof a.taskId === 'string' && a.taskId) rec.taskId = clip(a.taskId, TYPE_MAX);
    if (a.settled === true) rec.settled = true;
    const logged = finitePositive(a.loggedTools);
    if (logged) rec.loggedTools = Math.floor(logged);
    const reported = finitePositive(a.reportedTools);
    if (reported) rec.reportedTools = Math.floor(reported);
    // A record from before the two counts were kept: its count was the log's.
    if (rec.loggedTools === undefined && rec.reportedTools === undefined && rec.toolCalls > 0)
      rec.loggedTools = rec.toolCalls;
    const spend = sanitizeSpend(a.spend);
    if (spend) {
      const calls = finiteNonNegative((a.spend as Record<string, unknown>).calls);
      rec.spend = { ...spend, calls: Math.floor(calls ?? 0) };
      const est = finiteNonNegative((a.spend as Record<string, unknown>).estimatedCalls);
      if (est) rec.spend.estimatedCalls = Math.floor(est);
      const unpriced = (a.spend as Record<string, unknown>).unpricedModels;
      if (Array.isArray(unpriced)) {
        const names = unpriced.filter((m): m is string => typeof m === 'string' && m.length > 0).slice(0, 10);
        if (names.length) rec.spend.unpricedModels = names.map((m) => clip(m, TYPE_MAX));
      }
    }
    if (typeof a.sdkSessionId === 'string' && a.sdkSessionId) rec.sdkSessionId = clip(a.sdkSessionId, TYPE_MAX);
    if (a.spendFinal === true && rec.spend) rec.spendFinal = true;
    const ledger = sanitizeTaskLedger(a.ledger);
    if (ledger) rec.ledger = ledger;
    agents.push(rec);
  }
  // Never hand out a spawn number that is already taken.
  const highest = agents.reduce((m, a) => Math.max(m, a.n), 0);
  const reg: AgentRegistry = { nextN: Math.max(Math.floor(nextN), highest + 1), agents };
  const root = sanitizeRootStats(r.root);
  if (root) reg.root = root;
  const pruned = sanitizeSpend(r.prunedSpend);
  const prunedAgents = r.prunedSpend ? finitePositive((r.prunedSpend as Record<string, unknown>).agents) : undefined;
  if (pruned && prunedAgents) {
    reg.prunedSpend = { ...pruned, agents: Math.floor(prunedAgents) };
    if ((r.prunedSpend as Record<string, unknown>).unpriced === true) reg.prunedSpend.unpriced = true;
    if ((r.prunedSpend as Record<string, unknown>).estimated === true) reg.prunedSpend.estimated = true;
  }
  enforceBounds(reg);
  return reg;
}

function finiteNonNegative(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** The five spend counters, all finite and ≥ 0 — or nothing. */
function sanitizeSpend(raw: unknown): SpendTotals | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'costUsd'] as const;
  const out = {} as SpendTotals;
  for (const f of fields) {
    const v = finiteNonNegative(r[f]);
    if (v === undefined) return undefined;
    out[f] = v;
  }
  return out;
}

function sanitizeRootStats(raw: unknown): AgentRootStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const toolCalls = finitePositive(r.toolCalls);
  if (!toolCalls) return undefined;
  const out: AgentRootStats = { toolCalls: Math.floor(toolCalls) };
  if (typeof r.lastTool === 'string' && r.lastTool) out.lastTool = clip(r.lastTool, TYPE_MAX);
  return out;
}
