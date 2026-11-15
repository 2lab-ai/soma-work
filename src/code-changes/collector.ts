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
import { checkoutChanges, type SessionCommit, sessionCommits, UNREAD_CHECKOUT } from './checkout-changes';
import { type PrDeps, sessionPrChanges } from './pr-changes';
import type { CodeChangesStore } from './store';
import { summarizeCodeChanges } from './summary';
import type { ChangedFile, CheckoutChanges, CodeChangesDoc, CodeChangesSummary, PrChanges } from './types';

export const MAX_CHECKOUTS = 20;
/** The patches one document keeps, all layers together; past it the later files keep their counts only. */
export const MAX_DOC_PATCH_BYTES = 6 * 1024 * 1024;
const MAX_COUNTED_COMMITS = 2000;

export interface CollectInput {
  conversationId: string;
  owner: { id: string; name: string };
  /** The session's own folder (labels are relative to it). */
  sessionRoot?: string;
  /** Every folder the session works in (`sessionDirs`). */
  dirs: string[];
  startedAt?: number;
  /** The PR links on the session's card (current first, then history). */
  prUrls: string[];
}

export interface CollectDeps extends PrDeps {
  store: CodeChangesStore;
  listCheckoutDirs?: (dirs: string[], max: number) => Promise<{ dirs: string[] }>;
  checkoutChanges?: typeof checkoutChanges;
  sessionCommits?: typeof sessionCommits;
}

export interface CollectResult {
  doc: CodeChangesDoc;
  summary: CodeChangesSummary;
  /** PRs merged since the stored copy (or every merged PR on a first run). */
  newMerges: PrChanges[];
  /** Commits made in the session's checkouts that the metrics do not hold yet. */
  newCommits: Array<SessionCommit & { repo: string }>;
}

const hasChanges = (c: CheckoutChanges) =>
  c.uncommitted.files.length > 0 || c.committed.files.length > 0 || !!c.uncommitted.skipped;

/** Drop patches past the document budget, in layer order (uncommitted, committed, then PRs). */
export function applyPatchBudget(doc: CodeChangesDoc, max = MAX_DOC_PATCH_BYTES): void {
  let used = 0;
  const visit = (f: ChangedFile) => {
    if (!f.patch) return;
    const bytes = Buffer.byteLength(f.patch, 'utf8');
    if (used + bytes > max) {
      delete f.patch;
      f.patchTruncated = true;
      return;
    }
    used += bytes;
  };
  for (const c of doc.checkouts) c.uncommitted.files.forEach(visit);
  for (const c of doc.checkouts) c.committed.files.forEach(visit);
  for (const p of doc.prs) p.files.forEach(visit);
}

export async function collectCodeChanges(input: CollectInput, deps: CollectDeps): Promise<CollectResult> {
  const prev = deps.store.read(input.conversationId);
  const prs = await sessionPrChanges(input.prUrls, input.startedAt, prev?.prs ?? [], deps);
  const prHeads = prs.map((p) => ({ repo: p.repo, headRef: p.headRef, headSha: p.headSha, createdAt: p.createdAt }));
  const list = deps.listCheckoutDirs ?? listCheckoutDirs;
  const readCheckout = deps.checkoutChanges ?? checkoutChanges;
  const readCommits = deps.sessionCommits ?? sessionCommits;
  const { dirs } = await list(input.dirs, MAX_CHECKOUTS);
  const counted = new Set(prev?.counted.commits ?? []);
  const checkouts: CheckoutChanges[] = [];
  const newCommits: CollectResult['newCommits'] = [];
  for (const dir of dirs.slice(0, MAX_CHECKOUTS)) {
    const c = await readCheckout({
      dir,
      sessionRoot: input.sessionRoot,
      roots: input.dirs,
      sessionStartedAt: input.startedAt,
      prHeads,
    });
    if (!c) continue;
    if (hasChanges(c)) checkouts.push(c);
    // A checkout the gate refused is not read for commits either.
    if (input.startedAt !== undefined && !UNREAD_CHECKOUT.has(c.uncommitted.skipped ?? '')) {
      for (const commit of await readCommits(dir, input.startedAt, counted)) {
        counted.add(commit.sha);
        newCommits.push({ ...commit, repo: c.repo });
      }
    }
  }
  checkouts.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.dir < b.dir ? -1 : 1));
  const doc: CodeChangesDoc = {
    version: 1,
    conversationId: input.conversationId,
    owner: input.owner,
    updatedAt: deps.now(),
    checkouts,
    prs,
    counted: { commits: [...counted].slice(-MAX_COUNTED_COMMITS) },
  };
  if (input.startedAt !== undefined) doc.sessionStartedAt = input.startedAt;
  applyPatchBudget(doc);
  deps.store.write(doc);
  const wasMerged = new Set((prev?.prs ?? []).filter((p) => p.state === 'merged').map((p) => p.id));
  return {
    doc,
    summary: summarizeCodeChanges(doc),
    newMerges: prs.filter((p) => p.state === 'merged' && !wasMerged.has(p.id)),
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
