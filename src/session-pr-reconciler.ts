/**
 * Turn-end reconciliation from GitHub (#833, epic #831): the PRs GitHub says the session's own branches have go on its
 * task card, however they were made — REST, the web UI, another machine. The one layer that does not depend on how a
 * command was spelled (L1, `githubEffectsOf`, reads the calls; this asks GitHub).
 *
 * For each git checkout under the session's directories: its current branch → `GET /repos/{o}/{r}/pulls?head=…`.
 *   - a PR created after the session started becomes the current link ('always'), unless the card already has it;
 *   - an older PR (an inherited branch), any PR when the start is unknown, and any PR on a branch another session also
 *     checks out (ambiguous) go to history only ('history');
 *   - the PR's closing issues (`Closes #12`) go to history.
 * Budget: at most one query per branch per reconcile; a found answer is reused while the head sha is the same; an empty
 * answer is asked again next time (a PR can be opened without a new commit). One reconcile per session at a time, and a
 * minimum interval between them. Never throws.
 */

import { canonicalLinkUrl, classifyLinkUrl } from '@soma/slack/session-link-capture';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { SessionLink } from './types';

export interface Checkout {
  dir: string;
  owner: string;
  name: string;
  branch: string;
  sha: string;
}

export interface PullSummary {
  html_url: string;
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  created_at?: string;
  body?: string | null;
}

export interface ReconcilerDeps {
  findCheckouts: (dirs: string[]) => Promise<Checkout[]>;
  /** The PRs whose head is `owner:branch`; undefined when the query failed (nothing is cached then). */
  fetchPulls: (owner: string, name: string, branch: string) => Promise<PullSummary[] | undefined>;
  noteLinks: (sessionKey: string, links: SessionLink[], mode: 'always' | 'history') => boolean;
  pushCard: (sessionKey: string) => void;
  now?: () => number;
  /** Minimum time between two reconciles of one session (a turn's continuations end several times). */
  minIntervalMs?: number;
  logger?: { debug: (msg: string, meta?: Record<string, unknown>) => void };
}

interface SessionLike {
  sessionWorkingDir?: unknown;
  workingDirectory?: unknown;
  sourceWorkingDirs?: unknown;
  links?: { pr?: { url?: unknown } } | null;
  linkHistory?: { prs?: Array<{ url?: unknown } | null> } | null;
}

export interface ReconcileArgs {
  sessionKey: string;
  session: SessionLike | Record<string, unknown> | null | undefined;
  workingDirectory: string;
}

export type SessionPrReconciler = ((args: ReconcileArgs) => void) & {
  /** Resolves when every reconcile in flight has finished (tests, shutdown). */
  idle: () => Promise<void>;
};

const AMBIGUOUS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CLOSING_ISSUES = 5;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;

/** When the session started: the epoch in its directory's name (`session_<ms>_<id>`), else unknown. */
export function sessionStartMs(session: SessionLike): number | undefined {
  for (const dir of [session.sessionWorkingDir, session.workingDirectory]) {
    const m = typeof dir === 'string' ? path.basename(dir).match(/^session_(\d{13})_/) : null;
    if (m) return Number(m[1]);
  }
  return undefined;
}

function pullStatus(p: PullSummary): string {
  if (p.merged_at) return 'merged';
  if (p.draft && p.state !== 'closed') return 'draft';
  return p.state === 'closed' ? 'closed' : 'open';
}

function onCard(session: SessionLike, url: string): boolean {
  const canon = canonicalLinkUrl(url);
  const urls = [session.links?.pr?.url, ...(session.linkHistory?.prs ?? []).map((l) => l?.url)];
  return urls.some((u) => typeof u === 'string' && canonicalLinkUrl(u) === canon);
}

function closingIssues(p: PullSummary, owner: string, name: string): SessionLink[] {
  const out: SessionLink[] = [];
  const seen = new Set<string>();
  for (const m of (p.body ?? '').matchAll(CLOSING)) {
    const link = classifyLinkUrl(`https://github.com/${m[1] ?? owner}/${m[2] ?? name}/issues/${m[3]}`);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
    if (out.length >= MAX_CLOSING_ISSUES) break;
  }
  return out;
}

export function createSessionPrReconciler(deps: ReconcilerDeps): SessionPrReconciler {
  const now = deps.now ?? Date.now;
  const minInterval = deps.minIntervalMs ?? 20_000;
  const inFlight = new Map<string, Promise<void>>();
  const lastRun = new Map<string, number>();
  /** `owner/name#branch` → the head sha and PRs of a found answer. */
  const found = new Map<string, { sha: string; pulls: PullSummary[] }>();
  /** `owner/name#branch` → the sessions that checked it out, and when. */
  const seenBy = new Map<string, Map<string, number>>();

  async function reconcileOne(sessionKey: string, session: SessionLike, workingDirectory: string): Promise<void> {
    const dirs = [session.sessionWorkingDir, workingDirectory, session.workingDirectory]
      .concat(Array.isArray(session.sourceWorkingDirs) ? session.sourceWorkingDirs : [])
      .filter((d): d is string => typeof d === 'string' && d.length > 0);
    if (dirs.length === 0) return;
    const start = sessionStartMs(session);
    const checkouts = await deps.findCheckouts([...new Set(dirs)]);
    const asked = new Set<string>();
    let changed = false;
    for (const c of checkouts) {
      const key = `${c.owner}/${c.name}#${c.branch}`.toLowerCase();
      const observers = seenBy.get(key) ?? new Map<string, number>();
      observers.set(sessionKey, now());
      seenBy.set(key, observers);
      if (asked.has(key)) continue;
      asked.add(key);
      let pulls = found.get(key)?.sha === c.sha ? found.get(key)!.pulls : undefined;
      if (!pulls) {
        const answer = await deps.fetchPulls(c.owner, c.name, c.branch);
        if (!answer) continue;
        if (answer.length > 0) found.set(key, { sha: c.sha, pulls: answer });
        else found.delete(key);
        pulls = answer;
      }
      const ambiguous = [...observers].some(([other, at]) => other !== sessionKey && now() - at < AMBIGUOUS_WINDOW_MS);
      const current: SessionLink[] = [];
      const history: SessionLink[] = [];
      const issues: SessionLink[] = [];
      for (const p of pulls) {
        const base = classifyLinkUrl(p.html_url);
        if (!base || base.type !== 'pr') continue;
        const link: SessionLink = { ...base, status: pullStatus(p), ...(p.title ? { title: p.title } : {}) };
        const created = p.created_at ? Date.parse(p.created_at) : Number.NaN;
        const isNew = start !== undefined && Number.isFinite(created) && created >= start;
        (isNew && !ambiguous && !onCard(session, link.url) ? current : history).push(link);
        issues.push(...closingIssues(p, c.owner, c.name));
      }
      if (current.length > 0 && deps.noteLinks(sessionKey, current, 'always')) changed = true;
      if (history.length > 0 && deps.noteLinks(sessionKey, history, 'history')) changed = true;
      if (issues.length > 0 && deps.noteLinks(sessionKey, issues, 'history')) changed = true;
    }
    if (changed) deps.pushCard(sessionKey);
  }

  const reconcile = ((args: ReconcileArgs) => {
    try {
      const { sessionKey, session, workingDirectory } = args ?? ({} as ReconcileArgs);
      if (!sessionKey || !session || typeof session !== 'object') return;
      if (inFlight.has(sessionKey)) return;
      const at = now();
      if (at - (lastRun.get(sessionKey) ?? Number.NEGATIVE_INFINITY) < minInterval) return;
      lastRun.set(sessionKey, at);
      const run = reconcileOne(sessionKey, session as SessionLike, workingDirectory)
        .catch((error) => {
          deps.logger?.debug('session PR reconcile failed', { sessionKey, error: (error as Error)?.message });
        })
        .finally(() => inFlight.delete(sessionKey));
      inFlight.set(sessionKey, run);
    } catch (error) {
      deps.logger?.debug('session PR reconcile threw', { error: (error as Error)?.message });
    }
  }) as SessionPrReconciler;
  reconcile.idle = async () => {
    while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
  };
  return reconcile;
}

// ── The real checkout finder ────────────────────────────────────────────────────────────────────────────────────────

const MAX_CHECKOUTS = 20;
const MAX_CHILDREN = 200;

function git(dir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { timeout: 5000, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => resolve(error ? undefined : String(stdout).trim()),
    );
  });
}

async function isCheckout(dir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// `https://[user[:token]@]github.com/o/r[.git]` or `git@github.com:o/r[.git]` — read from the raw config value
// (`git remote get-url` would apply the host's token rewrite).
const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

/**
 * The git checkouts in `dirs` and their immediate children whose current branch is a work branch (not main, master,
 * deploy/*, or a detached HEAD) on a GitHub remote. At most {@link MAX_CHECKOUTS}.
 */
export async function findGitCheckouts(dirs: string[]): Promise<Checkout[]> {
  const candidates: string[] = [];
  for (const root of [...new Set(dirs)]) {
    if (await isCheckout(root)) candidates.push(root);
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .slice(0, MAX_CHILDREN)
        .map((e) => path.join(root, e.name));
    } catch {
      continue;
    }
    for (const child of entries) if (await isCheckout(child)) candidates.push(child);
  }
  const out: Checkout[] = [];
  for (const dir of [...new Set(candidates)].slice(0, MAX_CHECKOUTS)) {
    const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch || /^(?:main|master)$/.test(branch) || branch.startsWith('deploy/')) continue;
    const remote = await git(dir, ['config', '--get', 'remote.origin.url']);
    const m = remote?.match(GITHUB_REMOTE);
    if (!m) continue;
    const sha = await git(dir, ['rev-parse', 'HEAD']);
    if (!sha) continue;
    out.push({ dir, owner: m[1], name: m[2], branch, sha });
  }
  return out;
}
