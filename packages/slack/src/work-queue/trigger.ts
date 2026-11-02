/**
 * Host-side reading of a deploy trigger (`repo source -> target`).
 *
 * The deploy workflow prompt has the model parse the trigger, but the work
 * queue must decide BEFORE the model runs, so the host reads the same text.
 * It only needs the target (and the repo, when a queue is scoped to repos):
 * repo normalisation against channel context stays the model's job.
 */
import { decodeSlackEntities } from '@soma/common/format/display-title';
import type { WorkQueueDef } from './config';

export interface DeployTrigger {
  repos: string[];
  source: string;
  target: string;
}

const ARROW_RE = /->|→/;
const NAME_RE = /^[A-Za-z0-9_./-]+/;
const MENTION_RE = /<[@#!][^>]*>/g;

/** `refs/heads/deploy/dev2`, `deploy/dev2`, `DEV2` → `dev2`. */
export function normalizeTargetBranch(branch: string): string {
  return branch
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/^deploy\//, '');
}

/** `acme/Projalpha.git` → `projalpha`. */
export function normalizeRepo(repo: string): string {
  const last = repo.trim().toLowerCase().split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/, '');
}

function leadingName(token: string): string | undefined {
  return token.match(NAME_RE)?.[0];
}

/** Parse the first line of `text` that holds a deploy arrow. */
export function parseDeployTrigger(text: string): DeployTrigger | undefined {
  const decoded = decodeSlackEntities(text ?? '').replace(MENTION_RE, ' ');
  const line = decoded.split('\n').find((l) => ARROW_RE.test(l));
  if (!line) return undefined;
  const [left, ...rest] = line.split(ARROW_RE);
  const right = rest.join(' ');
  const target = leadingName(right.trim());
  if (!target) return undefined;

  const tokens = left.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return undefined;
  const source = leadingName(tokens[tokens.length - 1]);
  if (!source) return undefined;
  let repoTokens = tokens.slice(0, -1);
  if (repoTokens.length > 1 && repoTokens[0].toLowerCase() === 'deploy') repoTokens = repoTokens.slice(1);
  const repos = repoTokens
    .join(' ')
    .split(',')
    .map((r) => leadingName(r.trim().replace(/:$/, '')))
    .filter((r): r is string => !!r);
  if (repos.length === 0) return undefined;
  return { repos, source, target };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word presence of `deploy/<t>` or `<t>` (Korean particles may follow). */
function mentionsTarget(text: string, target: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_./-])(deploy/)?${escapeRegExp(target)}(?![A-Za-z0-9_./-])`, 'i');
  return re.test(text);
}

function mentionsRepo(text: string, repo: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(repo)}(\\.git)?(?![A-Za-z0-9_.-])`, 'i');
  return re.test(text);
}

/**
 * The queue a deploy request belongs to, if any.
 *
 * Only sessions of the queue's workflow are matched. A parsed trigger decides
 * by its target (and repos). Without an arrow — the classifier still chose
 * `deploy`, so this is a deploy in other words — a whole-word mention of a
 * queued target is enough: an unrecognised wording must not bypass the queue.
 */
export function matchWorkQueue(
  queues: readonly WorkQueueDef[],
  workflow: string | undefined,
  text: string,
): WorkQueueDef | undefined {
  if (!workflow) return undefined;
  const candidates = queues.filter((q) => q.workflow === workflow);
  if (candidates.length === 0) return undefined;
  const trigger = parseDeployTrigger(text);
  if (trigger) {
    const target = normalizeTargetBranch(trigger.target);
    const repos = trigger.repos.map(normalizeRepo);
    return candidates.find((q) => q.targets.includes(target) && (!q.repos || repos.some((r) => q.repos?.includes(r))));
  }
  const plain = decodeSlackEntities(text ?? '');
  return candidates.find(
    (q) => q.targets.some((t) => mentionsTarget(plain, t)) && (!q.repos || q.repos.some((r) => mentionsRepo(plain, r))),
  );
}
