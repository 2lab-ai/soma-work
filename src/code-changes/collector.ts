/**
 * The code-changes collector (.prd/27 §1, §4): one session's checkouts and own PRs → one document, stored, summarised.
 * Callers get what changed since the stored copy (new merges, new commits) for the metrics (.prd/26 §5).
 *
 * `createCodeChangesScheduler` runs it per session the way the PR reconcile does (#833): one run at a time per session,
 * a minimum interval between runs (a trigger inside it runs once, later, with the latest arguments), a short delay first
 * so the turn's PR links land, and a cap on runs across sessions. Never throws.
 */

import path from 'node:path';
import { listCheckoutDirs } from '../session-pr-reconciler';
import {
  CHANGED_DURING_READ,
  checkoutChanges,
  GIT_FAILED,
  type SessionCommit,
  UNREAD_CHECKOUT,
} from './checkout-changes';
import { type PrDeps, type PullAsk, sessionPrChanges } from './pr-changes';
import { type CodeChangesStore, MAX_COUNTED_COMMITS } from './store';
import { summarizeCodeChanges } from './summary';
import type { ChangedFile, CheckoutChanges, CodeChangesDoc, CodeChangesSummary, PrChanges } from './types';

export const MAX_CHECKOUTS = 20;
/** The patches one document keeps, all layers together; past it the later files keep their counts only. */
export const MAX_DOC_PATCH_BYTES = 6 * 1024 * 1024;

export interface CollectInput {
  conversationId: string;
  owner: { id: string; name: string };
  /** The session's own folder (labels are relative to it). */
  sessionRoot?: string;
  /** Every folder the session works in (`sessionDirs`). */
  dirs: string[];
  startedAt?: number;
  /** Commits made before this are not counted (the host's counting start — CodeChangesStore.countingSince). */
  commitsSince?: number;
  /** The PR links on the session's card (current first, then history). */
  prUrls: string[];
}

export interface CollectDeps extends PrDeps {
  store: CodeChangesStore;
  listCheckoutDirs?: (dirs: string[], max: number) => Promise<{ dirs: string[] }>;
  checkoutChanges?: typeof checkoutChanges;
}

export interface CollectResult {
  doc: CodeChangesDoc;
  summary: CodeChangesSummary;
  /** Merged PRs the metrics have not taken yet (`counted.merges`) — marked like `newCommits`. */
  newMerges: PrChanges[];
  /**
   * Commits made in the session's checkouts that the metrics do not hold yet. Handed on until the caller marks them
   * counted (`CodeChangesStore.markCounted`) — a delivery that failed is tried again on the next collect.
   */
  newCommits: Array<SessionCommit & { repo: string }>;
}

const hasChanges = (c: CheckoutChanges) =>
  c.uncommitted.files.length > 0 || c.committed.files.length > 0 || !!c.uncommitted.skipped || !!c.committed.skipped;

/** Reasons a layer was not read this time though it can be: the last layer read stands, with the reason. */
const RETRY_LATER = new Set(['git-diff-failed', 'git-config-unreadable', CHANGED_DURING_READ, GIT_FAILED]);
/**
 * Reasons nothing of the checkout was read this time (not even its name) and the next read may succeed: the last read
 * stands whole. A refusal (the config runs commands, another object store, links) is not one — that checkout shows why.
 */
const KEEP_WHOLE = new Set(['git-config-unreadable', CHANGED_DURING_READ, GIT_FAILED]);

/**
 * A checkout read against the stored one: a layer that could not be read this time (git failed, the git dir changed
 * during the read) keeps what was read last, marked with the reason — a failure is not "no changes".
 */
export function keepLastRead(c: CheckoutChanges, old: CheckoutChanges | undefined): CheckoutChanges {
  if (!old) return c;
  const u = c.uncommitted.skipped;
  const k = c.committed.skipped;
  if (!RETRY_LATER.has(u ?? '') && !RETRY_LATER.has(k ?? '')) return c;
  // Nothing of a checkout changed during the read (or that git did not answer for) is kept, not even its name.
  const base = KEEP_WHOLE.has(u ?? '') ? old : c;
  const out: CheckoutChanges = { ...base };
  if (RETRY_LATER.has(u ?? '')) out.uncommitted = { ...old.uncommitted, skipped: u };
  if (RETRY_LATER.has(k ?? '')) out.committed = { ...old.committed, skipped: k };
  return out;
}

/** A running patch budget: bytes kept so far, and the most a document keeps. */
export interface PatchBudget {
  used: number;
  max: number;
}

/** Keep each file's patch while the budget holds it; past it, the patch goes and the file is marked. True if any went. */
export function trimPatches(files: ChangedFile[], budget: PatchBudget): boolean {
  let dropped = false;
  for (const f of files) {
    if (typeof f.patch !== 'string' || !f.patch) continue;
    const bytes = Buffer.byteLength(f.patch, 'utf8');
    if (budget.used + bytes > budget.max) {
      delete f.patch;
      f.patchTruncated = true;
      dropped = true;
    } else {
      budget.used += bytes;
    }
  }
  return dropped;
}

/** Drop patches past the document budget, in layer order (uncommitted, committed, then PRs). */
export function applyPatchBudget(doc: CodeChangesDoc, max = MAX_DOC_PATCH_BYTES): void {
  const budget: PatchBudget = { used: 0, max };
  for (const c of doc.checkouts) trimPatches(c.uncommitted.files, budget);
  for (const c of doc.checkouts) trimPatches(c.committed.files, budget);
  // A PR whose patches were dropped reads its files again next time — the budget may have room by then.
  for (const p of doc.prs) if (trimPatches(p.files, budget)) p.patchesDropped = true;
}

export async function collectCodeChanges(input: CollectInput, deps: CollectDeps): Promise<CollectResult> {
  const prev = deps.store.read(input.conversationId);
  // Patches are cut as they arrive, not only once the document is whole: twenty checkouts and twenty PRs of full patches
  // would otherwise sit in memory before the budget drops all but 6 MiB of them (#1299 review). The document's own
  // order (uncommitted, committed, PRs) is applied again at the end.
  const prBudget: PatchBudget = { used: 0, max: MAX_DOC_PATCH_BYTES };
  // The PRs GitHub did not answer for (a private repository the host's token cannot read): asked of the checkouts below.
  const unread: PullAsk[] = [];
  const prs = await sessionPrChanges(
    input.prUrls,
    input.startedAt,
    prev?.prs ?? [],
    deps,
    (files) => trimPatches(files, prBudget),
    unread,
  );
  // One running budget per layer: a later checkout's uncommitted patch is never pushed out by an earlier checkout's
  // committed one — the end-of-document pass (uncommitted first) would never have dropped it (#1299 review).
  const uncommittedBudget: PatchBudget = { used: 0, max: MAX_DOC_PATCH_BYTES };
  const committedBudget: PatchBudget = { used: 0, max: MAX_DOC_PATCH_BYTES };
  const prHeads = prs.map((p) => ({ repo: p.repo, headRepo: p.headRepo, headSha: p.headSha }));
  const list = deps.listCheckoutDirs ?? listCheckoutDirs;
  const readCheckout = deps.checkoutChanges ?? checkoutChanges;
  const { dirs } = await list(input.dirs, MAX_CHECKOUTS);
  const counted = new Set(prev?.counted.commits ?? []);
  const countedMerges = new Set(prev?.counted.merges ?? []);
  const lastRead = new Map((prev?.checkouts ?? []).map((c) => [c.id, c]));
  const checkouts: CheckoutChanges[] = [];
  const newCommits: CollectResult['newCommits'] = [];
  const local = new Map<string, PrChanges>();
  for (const dir of dirs.slice(0, MAX_CHECKOUTS)) {
    const asks = unread.filter((a) => !local.has(a.id));
    const read = await readCheckout({
      dir,
      sessionRoot: input.sessionRoot,
      roots: input.dirs,
      sessionStartedAt: input.startedAt,
      prHeads,
      // Commits before the host's counting start were the old parser's to count (CodeChangesStore.countingSince).
      ...(input.startedAt !== undefined
        ? { commits: { since: Math.max(input.startedAt, input.commitsSince ?? 0), skip: counted } }
        : {}),
      ...(asks.length ? { pulls: asks } : {}),
    });
    if (!read) continue;
    const { sessionCommits: made, pulls: found, ...changes } = read;
    for (const p of found ?? []) if (!local.has(p.id)) local.set(p.id, { ...p, fetchedAt: deps.now() });
    const c = keepLastRead(changes, lastRead.get(changes.id));
    trimPatches(c.uncommitted.files, uncommittedBudget);
    trimPatches(c.committed.files, committedBudget);
    if (hasChanges(c)) checkouts.push(c);
    // A checkout not read (refused, or changed during the read) hands on no commits either.
    if (UNREAD_CHECKOUT.has(read.uncommitted.skipped ?? '')) continue;
    for (const commit of made ?? []) newCommits.push({ ...commit, repo: c.repo });
  }
  checkouts.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.dir < b.dir ? -1 : 1));
  // A PR found in a checkout takes the place of its stored record (one read there before, asked again), else joins.
  for (const p of local.values()) {
    if (trimPatches(p.files, prBudget)) p.patchesDropped = true;
    const at = prs.findIndex((x) => x.id === p.id);
    if (at >= 0) prs[at] = p;
    else prs.push(p);
  }
  // A local read has no creation time: its merge stands in for the order (newest first).
  prs.sort((a, b) => (b.createdAt ?? b.mergedAt ?? 0) - (a.createdAt ?? a.mergedAt ?? 0));
  const unreadPrs = unread
    .filter((a) => !prs.some((p) => p.id === a.id))
    .map((a) => ({ url: a.url, repo: a.repo, number: a.number }));
  const doc: CodeChangesDoc = {
    version: 1,
    conversationId: input.conversationId,
    owner: input.owner,
    updatedAt: deps.now(),
    checkouts,
    prs,
    // Only what the metrics took: new commits and merges are marked once handed on (CodeChangesStore.markCounted).
    counted: { commits: [...counted].slice(-MAX_COUNTED_COMMITS), merges: [...countedMerges] },
  };
  if (input.startedAt !== undefined) doc.sessionStartedAt = input.startedAt;
  if (unreadPrs.length) doc.unreadPrs = unreadPrs;
  applyPatchBudget(doc);
  deps.store.write(doc);
  return {
    doc,
    summary: summarizeCodeChanges(doc),
    // Not "merged since the stored copy": a hand-off that failed hands the merge on again until it is marked.
    newMerges: prs.filter((p) => p.state === 'merged' && !countedMerges.has(p.id)),
    newCommits,
  };
}

/** The document without patches — the list answer (.prd/27 §6). */
export function listView(doc: CodeChangesDoc): CodeChangesDoc {
  const strip = (files: ChangedFile[]) => files.map(({ patch: _p, ...rest }) => rest);
  return {
    ...doc,
    checkouts: doc.checkouts.map((c) => ({
      ...c,
      uncommitted: { ...c.uncommitted, files: strip(c.uncommitted.files) },
      committed: { ...c.committed, files: strip(c.committed.files) },
    })),
    prs: doc.prs.map((p) => ({ ...p, files: strip(p.files) })),
    counted: { commits: [] },
  };
}

export interface FileSource {
  layer: 'uncommitted' | 'committed' | 'pr' | 'merged' | 'closed';
  /** The checkout folder, or `#<n>` for a PR. */
  label: string;
  prUrl?: string;
  prNumber?: number;
  file: ChangedFile;
}

/** Every layer's record of `repo` + `path` in the document, in layer order — the viewer's answer for one file. */
export function fileSources(doc: CodeChangesDoc, repo: string, filePath: string): FileSource[] {
  const out: FileSource[] = [];
  for (const c of doc.checkouts) {
    if (c.repo !== repo) continue;
    const u = c.uncommitted.files.find((f) => f.path === filePath);
    if (u) out.push({ layer: 'uncommitted', label: c.dir, file: u });
  }
  for (const c of doc.checkouts) {
    if (c.repo !== repo) continue;
    const k = c.committed.files.find((f) => f.path === filePath);
    if (k) out.push({ layer: 'committed', label: c.dir, file: k });
  }
  for (const p of doc.prs) {
    if (p.repo !== repo) continue;
    const f = p.files.find((x) => x.path === filePath);
    if (!f) continue;
    const layer = p.state === 'merged' ? 'merged' : p.state === 'closed' ? 'closed' : 'pr';
    out.push({ layer, label: `#${p.number}`, prUrl: p.url, prNumber: p.number, file: f });
  }
  return out;
}

// ── Scheduling ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  /** Minimum time between two runs of one session. */
  minIntervalMs?: number;
  /** Wait this long after a trigger before the first run (the turn's PR links land meanwhile). */
  delayMs?: number;
  /** Runs at once across sessions. */
  concurrency?: number;
  now?: () => number;
  logger?: { debug: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface CodeChangesScheduler {
  /** Run (soon) for `key`; resolves when that run — or the one it joined — has finished. Never rejects. */
  trigger: (key: string, opts?: { immediate?: boolean }) => Promise<void>;
  idle: () => Promise<void>;
}

/** `run(key)` per session key with the reconcile's discipline (see the module comment). */
export function createCodeChangesScheduler(
  run: (key: string) => Promise<void>,
  opts: SchedulerOptions = {},
): CodeChangesScheduler {
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? 15_000;
  const delay = opts.delayMs ?? 3_000;
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const lastRun = new Map<string, number>();
  const queued = new Map<string, { promise: Promise<void>; resolve: () => void; timer?: NodeJS.Timeout }>();
  const running = new Map<string, Promise<void>>();
  const waiting: string[] = [];

  // A key runs once at a time: a key already running stays queued (its finally schedules it again), a key waiting for a
  // slot has no timer (schedule skips it), and starting a key clears any timer its queued entry still had.
  const startOrWait = (key: string) => {
    if (running.has(key)) return;
    if (running.size >= concurrency) {
      if (!waiting.includes(key)) waiting.push(key);
      return;
    }
    const q = queued.get(key);
    if (!q) return;
    if (q.timer) {
      clearTimeout(q.timer);
      q.timer = undefined;
    }
    queued.delete(key);
    lastRun.set(key, now());
    const p = run(key)
      .catch((error) => opts.logger?.debug('code-changes run failed', { key, error: (error as Error)?.message }))
      .finally(() => {
        running.delete(key);
        q.resolve();
        if (queued.has(key)) schedule(key, false);
        // A slot is free: the next waiting key that is not running takes it.
        while (waiting.length > 0 && running.size < concurrency) {
          const next = waiting.shift()!;
          startOrWait(next);
        }
      });
    running.set(key, p);
  };

  const schedule = (key: string, immediate: boolean) => {
    const q = queued.get(key);
    if (!q || q.timer || running.has(key) || waiting.includes(key)) return;
    const since = (lastRun.get(key) ?? Number.NEGATIVE_INFINITY) + minInterval - now();
    const wait = Math.max(immediate ? 0 : delay, since, 0);
    q.timer = setTimeout(() => {
      q.timer = undefined;
      startOrWait(key);
    }, wait);
    q.timer.unref?.();
  };

  return {
    trigger(key, o = {}) {
      try {
        let q = queued.get(key);
        if (!q) {
          let resolve!: () => void;
          const promise = new Promise<void>((r) => {
            resolve = r;
          });
          q = { promise, resolve };
          queued.set(key, q);
        } else if (o.immediate && q.timer && !running.has(key)) {
          clearTimeout(q.timer);
          q.timer = undefined;
        }
        schedule(key, !!o.immediate);
        return q.promise;
      } catch (error) {
        opts.logger?.debug('code-changes trigger threw', { error: (error as Error)?.message });
        return Promise.resolve();
      }
    },
    async idle() {
      while (running.size > 0 || queued.size > 0) {
        await Promise.all([...running.values(), ...[...queued.values()].map((q) => q.promise)]);
      }
    },
  };
}

/** The session's own folder from its directories: the one named `session_<ms>_<id>`, else the first. */
export function sessionRootOf(dirs: string[]): string | undefined {
  return dirs.find((d) => /^session_\d{13}_/.test(path.basename(d))) ?? dirs[0];
}
