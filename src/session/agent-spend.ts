/**
 * What each subagent spent — its own API calls, tokens and API-equivalent cost
 * (SSOT 2026-10-26 T2).
 *
 * The SDK reports a subagent's `total_tokens`, which is the size of its last
 * context, not its spend, and with `forwardSubagentText` off the host never
 * sees a subagent's text-only calls (its final report among them). The
 * subagent's own transcript has every call:
 *
 *   <config>/projects/<cwd>/<sdkSessionId>/subagents/agent-<taskId>.jsonl
 *
 * (`taskId` = the SDK task id `task_started` names = the transcript's agent
 * id). One API call is one `message.id`; the CLI writes a line per content
 * block, and the last line of a message carries its final usage. The reader
 * keeps, per file, how far it has read and the usage of every call seen, so a
 * running agent is re-read from where it stopped. Lines with model
 * `<synthetic>` (local error stand-ins) are not calls.
 *
 * File access stays inside the subagents directory of a session the SDK wrote:
 * the session id must be a UUID (`findTranscriptPath`), the task id a plain
 * token, and neither the session directory, the subagents directory nor the
 * transcript may be a symlink.
 *
 * Runtime state only; the result lands on the agent record (`spend`), which
 * the session persists.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findTranscriptPath, resolveClaudeConfigDir } from '@soma/slack/pipeline/transcript-sanitizer';
import type { AgentRecord, AgentRegistry, AgentSpend } from './agent-registry';

/** Tokens of a set of calls, before pricing. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface AgentSpendReaderOptions {
  /** API-equivalent cost of `t` tokens of `model` (the host's price table). */
  price: (model: string | undefined, t: TokenCounts) => number;
  /** Whether the price table knows `model` (otherwise the cost is an estimate at the fallback rate). */
  isPriced?: (model: string) => boolean;
  /** The SDK config dir (default: `CLAUDE_CONFIG_DIR` or `~/.claude`). */
  configDir?: string;
  now?: () => number;
  /** A running agent is re-read at most this often (default 10 s). */
  minIntervalMs?: number;
  /** Read chunk size (default 8 MiB); a read always continues to the file's end. */
  chunkBytes?: number;
}

export interface AgentSpendHolder {
  /** The SDK session the session runs now. */
  sessionId?: string;
  agents?: AgentRegistry;
}

export interface AgentSpendReader {
  /**
   * Bring the session's subagents' spend up to date. `force` (turn end) reads
   * every agent not sealed yet and seals the ones that have ended. Returns
   * whether any record changed. Never throws.
   */
  refresh(holder: AgentSpendHolder, opts?: { force?: boolean }): Promise<boolean>;
}

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SYNTHETIC_MODEL = '<synthetic>';
const DEFAULT_MIN_INTERVAL_MS = 10_000;
/** One read chunk — a big transcript is read in pieces, never held whole in memory. */
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

interface CallUsage extends TokenCounts {
  model?: string;
}

interface FileState {
  offset: number;
  /** Bytes after the last newline — a line still being written (kept as bytes: a chunk may split a character). */
  carry: Buffer;
  calls: Map<string, CallUsage>;
}

const ENDED = new Set<AgentRecord['status']>(['completed', 'failed', 'stopped']);
/**
 * Sealed at a turn end: ended, or out of sight (`unknown` — its turn or the
 * process ended). Any later activity unseals it (`agent-registry.ts`).
 */
const SEALABLE = new Set<AgentRecord['status']>(['completed', 'failed', 'stopped', 'unknown']);

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Fold complete JSONL lines into the per-call map (the last line of a message wins). */
function collectCalls(text: string, calls: Map<string, CallUsage>): void {
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j?.type !== 'assistant') continue;
    const m = j.message as Record<string, unknown> | undefined;
    const u = m?.usage as Record<string, unknown> | undefined;
    if (!m || !u || typeof u !== 'object') continue;
    const model = typeof m.model === 'string' ? m.model : undefined;
    if (model === SYNTHETIC_MODEL) continue;
    const id = typeof m.id === 'string' && m.id ? m.id : typeof j.uuid === 'string' ? j.uuid : undefined;
    if (!id) continue;
    calls.set(id, {
      model,
      inputTokens: count(u.input_tokens),
      outputTokens: count(u.output_tokens),
      cacheReadTokens: count(u.cache_read_input_tokens),
      cacheCreateTokens: count(u.cache_creation_input_tokens),
    });
  }
}

function priceCalls(calls: Map<string, CallUsage>, opts: AgentSpendReaderOptions): AgentSpend {
  const byModel = new Map<string, TokenCounts>();
  for (const c of calls.values()) {
    const key = c.model ?? '';
    const t = byModel.get(key) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    t.inputTokens += c.inputTokens;
    t.outputTokens += c.outputTokens;
    t.cacheReadTokens += c.cacheReadTokens;
    t.cacheCreateTokens += c.cacheCreateTokens;
    byModel.set(key, t);
  }
  const spend: AgentSpend = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    calls: calls.size,
  };
  const unpriced: string[] = [];
  for (const [model, t] of byModel) {
    spend.inputTokens += t.inputTokens;
    spend.outputTokens += t.outputTokens;
    spend.cacheReadTokens += t.cacheReadTokens;
    spend.cacheCreateTokens += t.cacheCreateTokens;
    let cost = 0;
    try {
      cost = opts.price(model || undefined, t);
    } catch {
      cost = 0;
    }
    if (Number.isFinite(cost) && cost > 0) spend.costUsd += cost;
    if (opts.isPriced && !opts.isPriced(model)) unpriced.push(model || 'unknown');
  }
  if (unpriced.length) spend.unpricedModels = unpriced.sort();
  return spend;
}

function sameSpend(a: AgentSpend | undefined, b: AgentSpend): boolean {
  if (!a) return false;
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreateTokens === b.cacheCreateTokens &&
    a.costUsd === b.costUsd &&
    a.calls === b.calls &&
    (a.unpricedModels ?? []).join('\n') === (b.unpricedModels ?? []).join('\n')
  );
}

/** The transcript still ends where the read stopped — nothing was appended after it. */
async function unchangedSince(file: string, size: number): Promise<boolean> {
  try {
    return (await fs.promises.lstat(file)).size === size;
  } catch {
    return false;
  }
}

async function isRealDir(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

export function createAgentSpendReader(opts: AgentSpendReaderOptions): AgentSpendReader {
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const chunkBytes = Math.max(1, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  /** sdkSessionId → its subagents directory (scanning the projects dir is not free). */
  const dirs = new Map<string, string>();
  const files = new Map<string, FileState>();
  /** agent id → when its transcript was last read. */
  const readAt = new Map<string, number>();
  const inFlight = new WeakMap<AgentSpendHolder, { running: Promise<boolean>; again: boolean; force: boolean }>();

  async function subagentsDir(sid: string): Promise<string | null> {
    const cached = dirs.get(sid);
    if (cached && (await isRealDir(cached))) return cached;
    const main = findTranscriptPath(sid, opts.configDir ?? resolveClaudeConfigDir());
    if (!main) return null;
    const sessionDir = path.join(path.dirname(main), sid);
    const dir = path.join(sessionDir, 'subagents');
    if (!(await isRealDir(sessionDir)) || !(await isRealDir(dir))) return null;
    dirs.set(sid, dir);
    return dir;
  }

  /**
   * The agent's spend from its transcript, or undefined when there is nothing
   * (safe) to read. `complete` = no half-written line is pending.
   */
  async function read(
    sid: string,
    taskId: string,
  ): Promise<{ spend: AgentSpend; file: string; complete: boolean; size: number } | undefined> {
    if (!TASK_ID_RE.test(taskId)) return undefined;
    const dir = await subagentsDir(sid);
    if (!dir) return undefined;
    const file = path.join(dir, `agent-${taskId}.jsonl`);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(file);
    } catch {
      return undefined;
    }
    if (!st.isFile() || st.isSymbolicLink()) return undefined;
    let state = files.get(file);
    if (!state || st.size < state.offset) {
      state = { offset: 0, carry: Buffer.alloc(0), calls: new Map() };
      files.set(file, state);
    }
    if (st.size > state.offset) {
      // Read to the size seen now, chunk by chunk — a sealed spend must hold every call.
      const fh = await fs.promises.open(file, 'r');
      try {
        while (state.offset < st.size) {
          const length = Math.min(st.size - state.offset, chunkBytes);
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fh.read(buf, 0, length, state.offset);
          if (bytesRead === 0) break;
          // Only whole lines are parsed; a half-written line waits (in `carry`) for its end.
          const bytes = Buffer.concat([state.carry, buf.subarray(0, bytesRead)]);
          const cut = bytes.lastIndexOf(0x0a);
          state.offset += bytesRead;
          state.carry = cut >= 0 ? Buffer.from(bytes.subarray(cut + 1)) : bytes;
          if (cut >= 0) collectCalls(bytes.subarray(0, cut).toString('utf8'), state.calls);
        }
      } finally {
        await fh.close();
      }
    }
    return { spend: priceCalls(state.calls, opts), file, complete: state.carry.length === 0, size: state.offset };
  }

  async function run(holder: AgentSpendHolder, force: boolean): Promise<boolean> {
    let changed = false;
    const ids = (holder.agents?.agents ?? [])
      .filter((a) => a.taskId && !a.spendFinal)
      .map((a) => ({ id: a.id, taskId: a.taskId as string, sid: a.sdkSessionId ?? holder.sessionId }));
    for (const { id, taskId, sid } of ids) {
      if (!sid) continue;
      // Re-resolve after every await: a reset may have swapped the registry.
      const before = holder.agents?.agents.find((a) => a.id === id);
      if (!before) continue;
      const ended = ENDED.has(before.status);
      const last = readAt.get(id);
      if (!force && !ended && last !== undefined && now() - last < minInterval) continue;
      readAt.set(id, now());
      let got: { spend: AgentSpend; file: string; complete: boolean; size: number } | undefined;
      try {
        got = await read(sid, taskId);
      } catch {
        got = undefined;
      }
      if (!got) continue;
      const agent = holder.agents?.agents.find((a) => a.id === id);
      if (!agent) continue;
      if (!agent.sdkSessionId) {
        agent.sdkSessionId = sid;
        changed = true;
      }
      if (!sameSpend(agent.spend, got.spend)) {
        agent.spend = got.spend;
        changed = true;
      }
      // Sealed only at a turn end, after the agent ended or went out of sight,
      // and only on a whole transcript (no half-written last line).
      if (force && SEALABLE.has(agent.status) && got.complete && (await unchangedSince(got.file, got.size))) {
        agent.spendFinal = true;
        files.delete(got.file);
        readAt.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  return {
    async refresh(holder, refreshOpts) {
      const force = refreshOpts?.force === true;
      // The SDK session an agent runs in is the session's current one while it
      // runs — taken now, before its transcript exists, so a later /new cannot
      // send the search to the wrong session.
      if (holder.sessionId) {
        for (const a of holder.agents?.agents ?? []) {
          if (!a.sdkSessionId && a.status === 'running') a.sdkSessionId = holder.sessionId;
        }
      }
      const busy = inFlight.get(holder);
      if (busy) {
        // One more pass after the current one, with the strongest request seen.
        busy.again = true;
        busy.force = busy.force || force;
        return busy.running.then(() => false);
      }
      const slot = { running: Promise.resolve(false), again: false, force: false };
      slot.running = (async () => {
        let changed = false;
        let pass = force;
        try {
          for (;;) {
            changed = (await run(holder, pass)) || changed;
            if (!slot.again) break;
            pass = slot.force;
            slot.again = false;
            slot.force = false;
          }
        } catch {
          // Never throws: spend is a display number, never a reason to fail a turn.
        } finally {
          inFlight.delete(holder);
        }
        return changed;
      })();
      inFlight.set(holder, slot);
      return slot.running;
    },
  };
}
