/**
 * GitHub as the receipt for a write (#832, review round 17).
 *
 * The parser in `session-link-capture.ts` reads a tool call's input and result and proposes what it wrote — a PR or
 * issue created, merged or closed. Syntax cannot prove that a call ran and wrote: sixteen review rounds kept finding a
 * call that did not run, or did not write, whose output still held an object of that repo. So a proposal reaches the
 * card only when GitHub confirms it:
 *
 * - create — the object was created inside the call's window, and it is this call's: a PR's head branch, or an
 *   issue's title, appears in the call's own input. (Another session on the same App can create a PR in the same
 *   seconds; its branch is not in this call.)
 * - merge — the PR was merged inside the window. The call named the PR itself, so a merge is its target's.
 * - close — the PR or issue is closed, not merged, and was closed inside the window.
 *
 * The window is the call's start and its result, widened by `SLACK_MS`, on GitHub's clock: the host's time is moved by
 * the difference between GitHub's `Date` header and the host's clock when the answer arrived. A proposal GitHub does
 * not confirm, or one it could not be asked about, records nothing; the turn-end check (#833) still finds a real PR.
 */
import type { GitHubEffect } from '@soma/slack/session-link-capture';

/** What GitHub says about one PR or issue, and its clock when it said it. */
export interface GitHubReceiptObject {
  createdAt?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  state?: string;
  /** A PR's head branch. */
  headRef?: string;
  title?: string;
  /** GitHub's `Date` header, in ms — undefined when absent or unreadable. */
  serverNowMs?: number;
}

export interface ReceiptCheckDeps {
  /** GET the PR or issue — undefined when the request failed. Must not throw (a throw is treated as a failure). */
  fetchObject: (
    owner: string,
    repo: string,
    kind: 'pr' | 'issue',
    number: number,
  ) => Promise<GitHubReceiptObject | undefined>;
  now?: () => number;
}

export interface ReceiptCheckArgs {
  effects: ReadonlyArray<GitHubEffect>;
  /** When each call started (host clock, ms), by tool-use id. */
  startedAt: ReadonlyMap<string, number>;
  /** Each call's input, as text, by tool-use id — the create's correlation. */
  inputs: ReadonlyMap<string, string>;
  /** When the results arrived (host clock, ms). */
  endedAt: number;
}

/** Slack on each side of the window: GitHub's timestamps are whole seconds, its `Date` header too. */
export const SLACK_MS = 5_000;
/** At most this many proposals are checked per batch of results: a flood is not a burst of GETs. */
export const MAX_CHECKS = 10;

const OBJECT_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)$/;

function within(iso: string | null | undefined, from: number, to: number, skew: number): boolean {
  if (typeof iso !== 'string') return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  // Move GitHub's time onto the host's clock.
  const host = t - skew;
  return host >= from - SLACK_MS && host <= to + SLACK_MS;
}

/** The longest run of a title without quote or escape characters — what survives the shell's quoting in an input. */
function titleFragment(title: string): string {
  return title.split(/['"`\\$]/).reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), '');
}

function correlated(kind: 'pr' | 'issue', obj: GitHubReceiptObject, input: string | undefined): boolean {
  if (!input) return false;
  if (kind === 'pr') return typeof obj.headRef === 'string' && obj.headRef.length > 0 && input.includes(obj.headRef);
  if (typeof obj.title !== 'string') return false;
  const fragment = titleFragment(obj.title);
  return fragment.length >= 8 && input.includes(fragment);
}

async function confirmOne(
  e: GitHubEffect,
  args: ReceiptCheckArgs,
  deps: ReceiptCheckDeps,
  now: () => number,
): Promise<boolean> {
  const m = e.link.url.match(OBJECT_URL);
  if (!m || !e.toolUseId) return false;
  const kind = m[3] === 'pull' ? 'pr' : 'issue';
  if ((kind === 'pr') !== (e.link.type === 'pr')) return false;
  const started = args.startedAt.get(e.toolUseId);
  if (started === undefined) return false;
  let obj: GitHubReceiptObject | undefined;
  try {
    obj = await deps.fetchObject(m[1], m[2], kind, Number(m[4]));
  } catch {
    return false;
  }
  if (!obj) return false;
  const skew = typeof obj.serverNowMs === 'number' && Number.isFinite(obj.serverNowMs) ? obj.serverNowMs - now() : 0;
  const from = started;
  const to = args.endedAt;
  switch (e.op) {
    case 'create':
      return within(obj.createdAt, from, to, skew) && correlated(kind, obj, args.inputs.get(e.toolUseId));
    case 'merge':
      return kind === 'pr' && within(obj.mergedAt, from, to, skew);
    case 'close':
      return obj.state === 'closed' && !obj.mergedAt && within(obj.closedAt, from, to, skew);
    default:
      return false;
  }
}

/** The proposals GitHub confirms, in their order. Never throws; a failure confirms nothing. */
export function createGithubReceiptChecker(
  deps: ReceiptCheckDeps,
): (args: ReceiptCheckArgs) => Promise<GitHubEffect[]> {
  const now = deps.now ?? Date.now;
  return async (args) => {
    const out: GitHubEffect[] = [];
    try {
      for (const e of args.effects.slice(0, MAX_CHECKS)) {
        if (await confirmOne(e, args, deps, now)) out.push(e);
      }
    } catch {
      // Bookkeeping: never throws.
    }
    return out;
  };
}
