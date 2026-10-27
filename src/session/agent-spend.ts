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
 * A subagent can start subagents of its own. One started in the background
 * gets a record of its own (the host sees its frames); one started in the
 * foreground does not — its meta (`agent-<taskId>.meta.json`) has no
 * `toolUseId`, only `parentAgentId`, and the host never sees it. Its calls are
 * in the task total (the SDK counts every call) but would be in no subagent:
 * dev 2026-10-27, 5 of this task's 27 transcripts, ~14M tokens. Each such
 * transcript is counted on the nearest registered agent above it
 * (`nestedAgents` says how many), so the subagents' sum covers every call.
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
import { type AgentRecord, type AgentRegistry, type AgentSpend, SPEND_CALC_VERSION } from './agent-registry';

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
/** A missing SDK session dir is searched again after this long. */
const MISSING_RETRY_MS = 60_000;
/** One read chunk — a big transcript is read in pieces, never held whole in memory. */
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
/** A transcript's meta file holds a few short fields; anything bigger is not one. */
const META_MAX_BYTES = 64 * 1024;
const META_RE = /^agent-([A-Za-z0-9_-]{1,128})\.meta\.json$/;
/** How far up a chain of record-less subagents is followed to find a registered one. */
const MAX_NEST_DEPTH = 16;
/** A meta file this young that does not parse may still be being written: no seal until it settles. */
const META_SETTLE_MS = 60_000;

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

function isZero(c: TokenCounts): boolean {
  return c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreateTokens === 0;
}

/**
 * Some providers leave a call's usage all-zero in the transcript: through
 * llmux, gpt-6-astra and grok-4.7-build do so for over half their calls
 * (dev 2026-10-27; claude models: none), while the proxy records a real usage
 * for each. Counting those as nothing showed such subagents 2-20x too low.
 * A zero-usage call is estimated from the calls around it: its context size
 * (input + cache read + cache write) is interpolated between the nearest
 * reported calls before and after it (one side only at either end), and split
 * into input / cache write / cache read by the agent's median shares — a cache
 * miss next to it is one call's spike, not spread over the run; output is the
 * agent's mean reported output. Checked against the SDK's exact per-turn usage
 * of the same calls (dev 2026-10-27, 27 transcripts): tokens -1%, cost -1%.
 * An agent with no reported call at all is left at zero ("unreported").
 * Returns the calls with estimates filled in, and how many were estimated.
 */
function fillZeroUsage(calls: CallUsage[]): { calls: CallUsage[]; estimated: number } {
  const reported = calls.map((c) => !isZero(c));
  const known = calls.filter((_, i) => reported[i]);
  if (known.length === 0 || known.length === calls.length) return { calls, estimated: 0 };
  const meanOut = known.reduce((a, c) => a + c.outputTokens, 0) / known.length;
  const context = (c: TokenCounts) => c.inputTokens + c.cacheReadTokens + c.cacheCreateTokens;
  const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
  const share = (f: 'inputTokens' | 'cacheCreateTokens') => median(known.map((c) => c[f] / Math.max(1, context(c))));
  const inShare = share('inputTokens');
  const writeShare = share('cacheCreateTokens');
  // The nearest reported call before and after each index, in two linear passes.
  const prev = new Array<number>(calls.length);
  const next = new Array<number>(calls.length);
  for (let k = 0, last = -1; k < calls.length; k++) {
    prev[k] = last;
    if (reported[k]) last = k;
  }
  for (let k = calls.length - 1, last = calls.length; k >= 0; k--) {
    next[k] = last;
    if (reported[k]) last = k;
  }
  let estimated = 0;
  const out = calls.map((c, k) => {
    if (reported[k]) return c;
    const i = prev[k];
    const j = next[k];
    const a = i >= 0 ? calls[i] : undefined;
    const b = j < calls.length ? calls[j] : undefined;
    const ctx = Math.round(
      a && b ? context(a) + ((context(b) - context(a)) * (k - i)) / (j - i) : context((a ?? b) as CallUsage),
    );
    const inputTokens = Math.round(ctx * inShare);
    const cacheCreateTokens = Math.min(ctx - inputTokens, Math.round(ctx * writeShare));
    estimated++;
    return {
      model: c.model,
      inputTokens,
      cacheCreateTokens,
      cacheReadTokens: ctx - inputTokens - cacheCreateTokens,
      outputTokens: Math.round(meanOut),
    };
  });
  return { calls: out, estimated };
}

function priceCalls(calls: Map<string, CallUsage>, opts: AgentSpendReaderOptions): AgentSpend {
  const filled = fillZeroUsage([...calls.values()]);
  const byModel = new Map<string, TokenCounts>();
  for (const c of filled.calls) {
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
  if (filled.estimated) spend.estimatedCalls = filled.estimated;
  spend.version = SPEND_CALC_VERSION;
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

/** An agent's own spend plus that of the record-less subagents counted on it. */
function mergeSpend(own: AgentSpend, nested: AgentSpend[]): AgentSpend {
  if (!nested.length) return own;
  const out: AgentSpend = { ...own };
  const unpriced = new Set(own.unpricedModels ?? []);
  let estimated = own.estimatedCalls ?? 0;
  for (const n of nested) {
    out.inputTokens += n.inputTokens;
    out.outputTokens += n.outputTokens;
    out.cacheReadTokens += n.cacheReadTokens;
    out.cacheCreateTokens += n.cacheCreateTokens;
    out.costUsd += n.costUsd;
    out.calls += n.calls;
    estimated += n.estimatedCalls ?? 0;
    for (const m of n.unpricedModels ?? []) unpriced.add(m);
  }
  if (estimated) out.estimatedCalls = estimated;
  if (unpriced.size) out.unpricedModels = [...unpriced].sort();
  out.nestedAgents = nested.length;
  return out;
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
    a.estimatedCalls === b.estimatedCalls &&
    a.version === b.version &&
    a.nestedAgents === b.nestedAgents &&
    (a.unpricedModels ?? []).join('\n') === (b.unpricedModels ?? []).join('\n')
  );
}

/** Every transcript still ends where its read stopped. */
async function allUnchanged(reads: Array<{ file: string; size: number }>): Promise<boolean> {
  for (const r of reads) if (!(await unchangedSince(r.file, r.size))) return false;
  return true;
}

/** The transcript still ends where the read stopped — nothing was appended after it. */
async function unchangedSince(file: string, size: number): Promise<boolean> {
  try {
    return (await fs.promises.lstat(file)).size === size;
  } catch {
    return false;
  }
}

interface MetaInfo {
  parent?: string;
  toolUse: boolean;
}

/**
 * A meta file's parent task id and whether it names a tool use. `settling` =
 * a young regular file that does not parse yet (still being written); any
 * other file that is not a (safe) meta reads as nothing.
 */
async function readMeta(file: string): Promise<MetaInfo | 'settling' | undefined> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(file);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > META_MAX_BYTES) return undefined;
  try {
    const j = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown> | null;
    if (!j || typeof j !== 'object') return undefined;
    const parent =
      typeof j.parentAgentId === 'string' && TASK_ID_RE.test(j.parentAgentId) ? j.parentAgentId : undefined;
    return { parent, toolUse: typeof j.toolUseId === 'string' && j.toolUseId.length > 0 };
  } catch {
    // File time against the wall clock (not the reader's injectable clock).
    return Date.now() - st.mtimeMs < META_SETTLE_MS ? 'settling' : undefined;
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
  /** sdkSessionId → when its missing transcript dir may be searched again. */
  const missing = new Map<string, number>();
  const files = new Map<string, FileState>();
  /** agent id → when its transcript was last read. */
  const readAt = new Map<string, number>();
  /** meta file → what it says (a meta is written once, at spawn). */
  const metas = new Map<string, MetaInfo>();
  /**
   * sdkSessionId → its record-less subagents (task id → parent task id), when
   * the dir was listed, and whether the listing was whole (no failed listing,
   * no meta still being written) — only a whole one lets an agent be sealed.
   */
  const scans = new Map<string, { at: number; children: Map<string, string>; whole: boolean }>();
  const inFlight = new WeakMap<AgentSpendHolder, { running: Promise<boolean>; again: boolean; force: boolean }>();

  async function subagentsDir(sid: string): Promise<string | null> {
    const cached = dirs.get(sid);
    if (cached && (await isRealDir(cached))) return cached;
    // The lookup scans every project dir synchronously: an SDK session that is
    // not there (reset, cleaned config) is not searched again for a minute.
    const retryAt = missing.get(sid);
    if (retryAt !== undefined && now() < retryAt) return null;
    const main = findTranscriptPath(sid, opts.configDir ?? resolveClaudeConfigDir());
    const sessionDir = main ? path.join(path.dirname(main), sid) : '';
    const dir = sessionDir ? path.join(sessionDir, 'subagents') : '';
    if (!main || !(await isRealDir(sessionDir)) || !(await isRealDir(dir))) {
      missing.set(sid, now() + MISSING_RETRY_MS);
      return null;
    }
    missing.delete(sid);
    dirs.set(sid, dir);
    return dir;
  }

  /**
   * The session's subagents that cannot have a record of their own (meta with
   * a parent and no tool use id): task id → parent task id. The directory is
   * listed again at most once per interval, or on a forced read.
   */
  async function foregroundChildren(
    sid: string,
    force: boolean,
  ): Promise<{ children: Map<string, string>; whole: boolean }> {
    const cached = scans.get(sid);
    if (cached && !force && now() - cached.at < minInterval) return cached;
    const dir = await subagentsDir(sid);
    if (!dir) return { children: new Map(), whole: true };
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return { children: cached?.children ?? new Map(), whole: false };
    }
    const children = new Map<string, string>();
    let whole = true;
    for (const name of names) {
      const m = META_RE.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      let meta = metas.get(file);
      if (!meta) {
        const got = await readMeta(file);
        // Not a whole meta: looked at again on the next listing; one still being written holds every seal.
        if (got === 'settling') whole = false;
        if (!got || got === 'settling') continue;
        meta = got;
        metas.set(file, meta);
      }
      if (!meta.toolUse && meta.parent) children.set(m[1], meta.parent);
    }
    const scan = { at: now(), children, whole };
    scans.set(sid, scan);
    return scan;
  }

  /**
   * Registered task id → the record-less subagents counted on it: each child
   * goes to the nearest registered agent up its parent chain (a chain that
   * loops or ends without one counts nowhere).
   */
  function attribute(children: Map<string, string>, registered: Set<string>): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [child, parent] of children) {
      if (registered.has(child)) continue;
      let p: string | undefined = parent;
      for (let steps = 0; p && !registered.has(p) && steps < MAX_NEST_DEPTH; steps++) p = children.get(p);
      if (!p || !registered.has(p)) continue;
      const list = out.get(p) ?? [];
      list.push(child);
      out.set(p, list);
    }
    return out;
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
    const all = holder.agents?.agents ?? [];
    const registered = new Set(all.map((a) => a.taskId).filter((t): t is string => !!t));
    const ids = all
      .filter((a) => a.taskId && !a.spendFinal)
      .map((a) => ({ id: a.id, taskId: a.taskId as string, sid: a.sdkSessionId ?? holder.sessionId }));
    // Per SDK session, listed once per pass and only when an agent of it is read.
    const nestedBySid = new Map<string, { of: Map<string, string[]>; whole: boolean }>();
    const nestedOf = async (sid: string, taskId: string): Promise<{ list: string[]; whole: boolean }> => {
      let m = nestedBySid.get(sid);
      if (!m) {
        const scan = await foregroundChildren(sid, force);
        m = { of: attribute(scan.children, registered), whole: scan.whole };
        nestedBySid.set(sid, m);
      }
      return { list: m.of.get(taskId) ?? [], whole: m.whole };
    };
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
      // Its record-less subagents. One that fails to read, or whose transcript
      // is not there yet (its meta is written at spawn), is left out of the
      // number and keeps the agent from being sealed — a later read adds it.
      const nested: Array<{ spend: AgentSpend; file: string; complete: boolean; size: number }> = [];
      let nestedWhole = true;
      let children: string[] = [];
      try {
        const n = await nestedOf(sid, taskId);
        children = n.list;
        nestedWhole = n.whole;
      } catch {
        nestedWhole = false;
      }
      for (const child of children) {
        try {
          const n = await read(sid, child);
          if (n) nested.push(n);
          else nestedWhole = false;
        } catch {
          nestedWhole = false;
        }
      }
      const spend = mergeSpend(
        got.spend,
        nested.map((n) => n.spend),
      );
      const agent = holder.agents?.agents.find((a) => a.id === id);
      if (!agent) continue;
      if (!agent.sdkSessionId) {
        agent.sdkSessionId = sid;
        changed = true;
      }
      if (!sameSpend(agent.spend, spend)) {
        agent.spend = spend;
        changed = true;
      }
      // Sealed only at a turn end, after the agent ended or went out of sight,
      // and only on whole transcripts — its own and those counted on it (no
      // half-written last line, nothing appended while they were read).
      const reads = [got, ...nested];
      if (
        force &&
        nestedWhole &&
        SEALABLE.has(agent.status) &&
        reads.every((r) => r.complete) &&
        (await allUnchanged(reads))
      ) {
        agent.spendFinal = true;
        for (const r of reads) {
          files.delete(r.file);
          metas.delete(r.file.replace(/\.jsonl$/, '.meta.json'));
        }
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

/**
 * Startup backfill: subagents that ended before this process started never
 * fire another event, so nothing would read their spend. Read every loaded
 * session once, one at a time (bounded disk load), as a turn end would —
 * ended and out-of-sight agents are sealed. `onChanged` names each session
 * whose records changed (to push its card). A session that fails to read is
 * skipped; it never stops the rest.
 */
export async function backfillAgentSpend(
  sessions: Iterable<[string, AgentSpendHolder]>,
  reader: AgentSpendReader,
  onChanged: (sessionKey: string) => void,
): Promise<void> {
  for (const [key, session] of sessions) {
    try {
      if (!session.agents?.agents.length) continue;
      if (await reader.refresh(session, { force: true })) onChanged(key);
    } catch {
      // Spend is a display number: one unreadable session never blocks the rest.
    }
  }
}
