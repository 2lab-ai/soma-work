/**
 * Turn-end reconciliation from GitHub (#833, epic #831): the PRs GitHub says the session's own branches have go on its
 * task card, however they were made — REST, the web UI, another machine. The one layer that does not depend on how a
 * command was spelled (L1, `githubEffectsOf`, reads the calls; this asks GitHub).
 *
 * For each git checkout under the session's directories: its current branch → `GET /repos/{o}/{r}/pulls?head=…`.
 *   - a PR created after the session started becomes the current link ('always'), unless the card already has it;
 *   - the current link only for this checkout's own PR: created after the session started, its head commit in the
 *     checkout, and the branch checked out by no other session (asked at decision time, so it holds across restarts);
 *     of several, the newest open one;
 *   - every other PR goes to history only ('history');
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
  head_sha?: string;
}

export interface ReconcilerDeps {
  findCheckouts: (dirs: string[]) => Promise<Checkout[]>;
  /** The PRs whose head is `owner:branch`; undefined when the query failed (nothing is cached then). */
  fetchPulls: (owner: string, name: string, branch: string) => Promise<PullSummary[] | undefined>;
  /** Whether the checkout's HEAD contains the commit (the PR's head is this checkout's work). */
  containsCommit: (dir: string, sha: string) => Promise<boolean>;
  /** Whether another, not terminated session has a checkout on `owner/name#branch` (the branch is then ambiguous). */
  checkedOutElsewhere: (sessionKey: string, owner: string, name: string, branch: string) => Promise<boolean>;
  noteLinks: (sessionKey: string, links: SessionLink[], mode: 'always' | 'history') => boolean;
  pushCard: (sessionKey: string) => void;
  /**
   * Whether `sessionKey` still names this session, not terminated — asked before every write. A reconcile can end after
   * the user closed the session and started another in the same thread: its PRs must not land on the new card.
   */
  isCurrent: (sessionKey: string, session: object) => boolean;
  now?: () => number;
  /** Minimum time between two reconciles of one session (a turn's continuations end several times). */
  minIntervalMs?: number;
  logger?: { debug: (msg: string, meta?: Record<string, unknown>) => void };
}

interface SessionLike {
  startedAt?: unknown;
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

const MAX_CLOSING_ISSUES = 5;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;

/** The directories a session works in: its own folder, the turn's and the session's cwd, and its source checkouts. */
export function sessionDirs(session: SessionLike | Record<string, unknown>, workingDirectory?: string): string[] {
  const s = session as SessionLike;
  const dirs = [s.sessionWorkingDir, workingDirectory, s.workingDirectory]
    .concat(Array.isArray(s.sourceWorkingDirs) ? s.sourceWorkingDirs : [])
    .filter((d): d is string => typeof d === 'string' && d.length > 0);
  return [...new Set(dirs)];
}

/** When the session started: its recorded `startedAt`, else the epoch in its directory's name (`session_<ms>_<id>`). */
export function sessionStartMs(session: SessionLike): number | undefined {
  if (typeof session.startedAt === 'number' && Number.isFinite(session.startedAt)) return session.startedAt;
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
  /** A trigger that came while one ran or within the interval: run once, later, with its latest arguments. */
  const pending = new Map<string, ReconcileArgs>();
  const timers = new Map<string, NodeJS.Timeout>();
  /** `owner/name#branch` → the head sha and PRs of a found answer. */
  const found = new Map<string, { sha: string; pulls: PullSummary[] }>();

  async function reconcileOne(sessionKey: string, session: SessionLike, workingDirectory: string): Promise<void> {
    const dirs = sessionDirs(session, workingDirectory);
    if (dirs.length === 0) return;
    const start = sessionStartMs(session);
    const checkouts = await deps.findCheckouts(dirs);
    const asked = new Set<string>();
    let changed = false;
    for (const c of checkouts) {
      // Owner and repo are case-insensitive on GitHub; a branch is not.
      const key = `${c.owner.toLowerCase()}/${c.name.toLowerCase()}#${c.branch}`;
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
      const candidates: Array<{ link: SessionLink; open: boolean; created: number }> = [];
      const history: SessionLink[] = [];
      const issues: SessionLink[] = [];
      for (const p of pulls) {
        const base = classifyLinkUrl(p.html_url);
        if (!base || base.type !== 'pr') continue;
        const link: SessionLink = { ...base, status: pullStatus(p), ...(p.title ? { title: p.title } : {}) };
        issues.push(...closingIssues(p, c.owner, c.name));
        const created = p.created_at ? Date.parse(p.created_at) : Number.NaN;
        const isNew = start !== undefined && Number.isFinite(created) && created >= start;
        // A candidate for the current link: this checkout's own PR — made after the session started, its head commit in
        // this checkout (a PR someone opened from a branch of the same name is not), and not yet on the card.
        if (isNew && !onCard(session, link.url) && !!p.head_sha && (await deps.containsCommit(c.dir, p.head_sha))) {
          candidates.push({ link, open: link.status !== 'closed' && link.status !== 'merged', created });
        } else {
          history.push(link);
        }
      }
      // Of several, the newest open one is current; and none when another session also checks the branch out.
      candidates.sort((a, b) => Number(b.open) - Number(a.open) || b.created - a.created);
      const ambiguous =
        candidates.length > 0 && (await deps.checkedOutElsewhere(sessionKey, c.owner, c.name, c.branch));
      const current = ambiguous ? [] : candidates.slice(0, 1).map((x) => x.link);
      history.push(...(ambiguous ? candidates : candidates.slice(1)).map((x) => x.link));
      // The awaits above can outlast the session: write only while the key still names it.
      if (!deps.isCurrent(sessionKey, session)) return;
      if (current.length > 0 && deps.noteLinks(sessionKey, current, 'always')) changed = true;
      if (history.length > 0 && deps.noteLinks(sessionKey, history, 'history')) changed = true;
      if (issues.length > 0 && deps.noteLinks(sessionKey, issues, 'history')) changed = true;
    }
    if (changed && deps.isCurrent(sessionKey, session)) deps.pushCard(sessionKey);
  }

  function later(sessionKey: string, waitMs: number): void {
    if (timers.has(sessionKey)) return;
    const t = setTimeout(() => {
      timers.delete(sessionKey);
      const next = pending.get(sessionKey);
      pending.delete(sessionKey);
      if (next) trigger(next);
    }, waitMs);
    t.unref?.();
    timers.set(sessionKey, t);
  }

  function trigger(args: ReconcileArgs): void {
    const { sessionKey, session, workingDirectory } = args;
    if (inFlight.has(sessionKey)) {
      pending.set(sessionKey, args);
      return;
    }
    const wait = (lastRun.get(sessionKey) ?? Number.NEGATIVE_INFINITY) + minInterval - now();
    if (wait > 0) {
      pending.set(sessionKey, args);
      later(sessionKey, wait);
      return;
    }
    lastRun.set(sessionKey, now());
    const run = reconcileOne(sessionKey, session as SessionLike, workingDirectory)
      .catch((error) => {
        deps.logger?.debug('session PR reconcile failed', { sessionKey, error: (error as Error)?.message });
      })
      .finally(() => {
        inFlight.delete(sessionKey);
        // A trigger that came meanwhile runs once, after the interval.
        if (pending.has(sessionKey))
          later(sessionKey, Math.max(0, (lastRun.get(sessionKey) ?? 0) + minInterval - now()));
      });
    inFlight.set(sessionKey, run);
  }

  const reconcile = ((args: ReconcileArgs) => {
    try {
      const { sessionKey, session } = args ?? ({} as ReconcileArgs);
      if (!sessionKey || !session || typeof session !== 'object') return;
      trigger(args);
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

// Only what git needs: no tokens from the host env, no global or system config (its token rewrite, credential helpers).
const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(dir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 5000, env: GIT_ENV }, (error, stdout) =>
      resolve(error ? undefined : String(stdout).trim()),
    );
  });
}

/** Whether the checkout's HEAD contains `sha` (`git merge-base --is-ancestor`); false when the commit is unknown. */
export async function gitContainsCommit(dir: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  return (await git(dir, ['merge-base', '--is-ancestor', sha, 'HEAD'])) !== undefined;
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
 * The git checkouts in `dirs`, their immediate children, and the worktrees those repositories list under `dirs`
 * (`.claude/worktrees/…`), whose current branch is a work branch (not main, master, deploy/*, or a detached HEAD) on a
 * GitHub remote. At most `max` directories are read; `complete` says whether every candidate was. `stop` ends the scan
 * at the first checkout it accepts.
 */
export async function scanGitCheckouts(
  dirs: string[],
  max = MAX_CHECKOUTS,
  stop?: (c: Checkout) => boolean,
): Promise<{ checkouts: Checkout[]; complete: boolean }> {
  const roots = [...new Set(dirs)].map((d) => path.resolve(d));
  const candidates: string[] = [];
  // Whether every directory was read: a dir past MAX_CHILDREN or one that could not be read (not merely absent)
  // leaves the scan incomplete — a caller asking "does anyone else have this branch" must then assume yes.
  let read = true;
  for (const root of roots) {
    if (await isCheckout(root)) candidates.push(root);
    let entries: string[] = [];
    try {
      const dirsOnly = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory());
      if (dirsOnly.length > MAX_CHILDREN) read = false;
      entries = dirsOnly.slice(0, MAX_CHILDREN).map((e) => path.join(root, e.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') read = false;
      continue;
    }
    for (const child of entries) if (await isCheckout(child)) candidates.push(child);
  }
  // The worktrees a found repository lists (`git worktree list`), when they sit under one of the dirs.
  // git reports real paths (`/private/var/…` on macOS): compare against the dirs as given and as resolved.
  const bases = [...roots, ...(await Promise.all(roots.map((r) => fs.realpath(r).catch(() => r))))];
  const under = (p: string) => bases.some((r) => p === r || p.startsWith(`${r}${path.sep}`));
  const seen = new Set(await Promise.all(candidates.map((c) => fs.realpath(c).catch(() => c))));
  for (const repo of [...new Set(candidates)].slice(0, max)) {
    const list = await git(repo, ['worktree', 'list', '--porcelain']);
    for (const line of (list ?? '').split('\n')) {
      const wt = line.startsWith('worktree ') ? path.resolve(line.slice('worktree '.length)) : undefined;
      if (!wt || seen.has(wt) || !under(wt)) continue;
      seen.add(wt);
      candidates.push(wt);
    }
  }
  const unique = [...new Set(candidates)];
  const out: Checkout[] = [];
  for (const dir of unique.slice(0, max)) {
    const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch || /^(?:main|master)$/.test(branch) || branch.startsWith('deploy/')) continue;
    const remote = await git(dir, ['config', '--get', 'remote.origin.url']);
    const m = remote?.match(GITHUB_REMOTE);
    if (!m) continue;
    const sha = await git(dir, ['rev-parse', 'HEAD']);
    if (!sha) continue;
    const c = { dir, owner: m[1], name: m[2], branch, sha };
    out.push(c);
    if (stop?.(c)) return { checkouts: out, complete: true };
  }
  return { checkouts: out, complete: read && unique.length <= max };
}

/** The work-branch checkouts under `dirs` (see {@link scanGitCheckouts}). */
export async function findGitCheckouts(dirs: string[], max = MAX_CHECKOUTS): Promise<Checkout[]> {
  return (await scanGitCheckouts(dirs, max)).checkouts;
}
