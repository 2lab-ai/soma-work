/**
 * GitHub as the receipt for a write (#832, review rounds 17-18).
 *
 * The parser in `session-link-capture.ts` reads a tool call's input and result and proposes what it wrote — a PR or
 * issue created, merged or closed. Syntax cannot prove that a call ran and wrote: sixteen review rounds kept finding a
 * call that did not run, or did not write, whose output still held an object of that repo. So a proposal reaches the
 * card only when GitHub confirms it:
 *
 * - create — the object was created inside the window. When the call's input names a head branch (`head:"…"`,
 *   `-f head=…`, `gh pr create --head …`) the PR's head must be one of them; when it names an issue title, the title
 *   must be in the input. (Another session on the same App can create a PR in the same seconds; the branch this call
 *   named is not its branch.) A call that names neither — `gh pr create --fill`, a body read from a file — is taken on
 *   the window alone.
 * - merge — the PR was merged inside the window. The call named the PR itself, so a merge is its target's.
 * - close — the PR or issue is closed, not merged, and was closed inside the window.
 *
 * The window runs from the start of the turn the call was made in to the call's result, widened by `SLACK_MS`, on
 * GitHub's clock: the host's time is moved by the difference between GitHub's `Date` header and the host's clock when
 * the answer arrived. (The turn's start, not the moment the host saw the call: the host reads the SDK's events in turn
 * and can see a call long after it ran.) A proposal GitHub does not confirm, or one it could not be asked about in
 * time, records nothing; the turn-end check (#833) still finds a real PR.
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
  /** A GET that has not answered by then (token included) confirms nothing. Default `TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface ReceiptCheckArgs {
  effects: ReadonlyArray<GitHubEffect>;
  /** A lower bound for when each call started (host clock, ms) — the start of its turn — by tool-use id. */
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
/** The longest a check waits for GitHub, the token included. */
export const TIMEOUT_MS = 8_000;

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

// The head branches a call's input names as literals: a quoted `head` value (`head:"x"`, `"head": "x"`), `-f head=x`,
// `gh pr create --head x` / `-H x`. A value that is a variable (`head: branch`, `head=$B`) names nothing.
const HEAD_NAMES = [
  /["']?\bhead["']?\s*:\s*["']([\w./:-]+)["']/g,
  /(?:^|\s)-[fF]\s+["']?head=([\w./:-]+)/g,
  /\bgh\s+pr\s+create\b[^\n;|&]*?\s(?:--head|-H)(?:=|\s+)["']?([\w./:-]+)/g,
];
// An issue title the input names: a `title` key, `-f title=`, `gh issue create --title` / `-t`.
const TITLE_NAMED =
  /["']?\btitle["']?\s*:\s*["']|(?:^|\s)-[fF]\s+["']?title=|\bgh\s+issue\s+create\b[^\n;|&]*?\s(?:--title|-t)(?:=|\s)/;

function namedHeads(input: string): string[] {
  const out: string[] = [];
  for (const re of HEAD_NAMES) for (const m of input.matchAll(re)) out.push(m[1]);
  return out;
}

function correlated(kind: 'pr' | 'issue', obj: GitHubReceiptObject, input: string | undefined): boolean {
  const text = input ?? '';
  if (kind === 'pr') {
    const heads = namedHeads(text);
    if (heads.length === 0) return true;
    const head = obj.headRef;
    return typeof head === 'string' && heads.some((h) => h === head || h.endsWith(`:${head}`));
  }
  if (!TITLE_NAMED.test(text)) return true;
  if (typeof obj.title !== 'string') return false;
  const fragment = titleFragment(obj.title);
  return fragment.length > 0 && fragment.length >= Math.min(8, obj.title.trim().length) && text.includes(fragment);
}

/** `p`, or undefined once `ms` passed — a hung GET (or token fetch) must not hold the answer. */
function withinMs<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
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
    obj = await withinMs(deps.fetchObject(m[1], m[2], kind, Number(m[4])), deps.timeoutMs ?? TIMEOUT_MS);
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
    try {
      // In parallel: a slow answer must not hold the others.
      const checked = args.effects.slice(0, MAX_CHECKS);
      const ok = await Promise.all(checked.map((e) => confirmOne(e, args, deps, now).catch(() => false)));
      return checked.filter((_, i) => ok[i]);
    } catch {
      // Bookkeeping: never throws.
      return [];
    }
  };
}
