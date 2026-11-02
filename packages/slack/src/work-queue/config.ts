/**
 * Work queues — `config.json#workQueues`.
 *
 * A work queue caps how many sessions of one kind of work run at once across
 * every user of this bot. The built-in queue serialises dev2 deploys
 * (`develop -> deploy/dev2`, one at a time). Each entry:
 *
 *   {
 *     "id": "deploy-dev2",            // stable id, persisted with the queue state
 *     "label": "deploy/dev2 배포",     // shown to people on the busy card
 *     "workflow": "deploy",           // dispatch workflow the queue applies to
 *     "targets": ["deploy/dev2"],     // target branches (`dev2` ≡ `deploy/dev2`)
 *     "repos": ["Projalpha"],             // optional: only these repos (any when absent)
 *     "concurrency": 1,               // sessions allowed to run at once
 *     "askTimeoutMinutes": 10,        // unanswered "cancel / deploy after" card → cancelled
 *     "holderIdleMinutes": 10         // a running deploy left waiting on its own question
 *                                     // this long gives the slot back
 *   }
 *
 * No key → the built-in dev2 queue. `[]` → no queues. A value that is not an
 * array keeps the built-in queue (and warns): a typo must never silently drop
 * the dev2 guard.
 *
 * The queue matches on the target, not the source: two deploys collide on the
 * branch and environment they write to, whatever they were merged from.
 */
import { normalizeTargetBranch, normalizeRepo } from './trigger';

export interface WorkQueueDef {
  id: string;
  label: string;
  workflow: string;
  /** Normalised with {@link normalizeTargetBranch}. */
  targets: string[];
  /** Normalised with {@link normalizeRepo}; undefined = any repo. */
  repos: string[] | undefined;
  concurrency: number;
  askTimeoutMs: number;
  holderIdleMs: number;
}

const MINUTE_MS = 60_000;
const DEFAULT_ASK_TIMEOUT_MINUTES = 10;
const DEFAULT_HOLDER_IDLE_MINUTES = 10;

/** The raw built-in entry — what an operator would write to get today's default. */
export const DEFAULT_WORK_QUEUES_CONFIG: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  Object.freeze({
    id: 'deploy-dev2',
    label: 'deploy/dev2 배포',
    workflow: 'deploy',
    targets: ['deploy/dev2'],
    concurrency: 1,
    askTimeoutMinutes: DEFAULT_ASK_TIMEOUT_MINUTES,
    holderIdleMinutes: DEFAULT_HOLDER_IDLE_MINUTES,
  }),
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function positiveInt(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return out.length === value.length ? out : undefined;
}

function parseQueueEntry(raw: unknown, index: number): { def?: WorkQueueDef; warning?: string } {
  const where = `workQueues[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { warning: `${where}: expected an object` };
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { warning: `${where}: "id" must be a short identifier` };
  const workflow = entry.workflow;
  if (typeof workflow !== 'string' || workflow.trim() === '') {
    return { warning: `${where} (${id}): "workflow" is required` };
  }
  const targets = stringList(entry.targets);
  if (!targets || targets.length === 0) return { warning: `${where} (${id}): "targets" must list branch names` };
  let repos: string[] | undefined;
  if (entry.repos !== undefined) {
    repos = stringList(entry.repos);
    if (!repos || repos.length === 0) return { warning: `${where} (${id}): "repos" must list repo names` };
  }
  const concurrency = positiveInt(entry.concurrency, 1);
  const askTimeoutMinutes = positiveInt(entry.askTimeoutMinutes, DEFAULT_ASK_TIMEOUT_MINUTES);
  const holderIdleMinutes = positiveInt(entry.holderIdleMinutes, DEFAULT_HOLDER_IDLE_MINUTES);
  if (concurrency === undefined || askTimeoutMinutes === undefined || holderIdleMinutes === undefined) {
    return {
      warning: `${where} (${id}): "concurrency", "askTimeoutMinutes" and "holderIdleMinutes" must be whole numbers ≥ 1`,
    };
  }
  const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : id;
  return {
    def: {
      id,
      label,
      workflow: workflow.trim(),
      targets: [...new Set(targets.map(normalizeTargetBranch))],
      repos: repos ? [...new Set(repos.map(normalizeRepo))] : undefined,
      concurrency,
      askTimeoutMs: askTimeoutMinutes * MINUTE_MS,
      holderIdleMs: holderIdleMinutes * MINUTE_MS,
    },
  };
}

function parseList(list: readonly unknown[]): { queues: WorkQueueDef[]; warnings: string[] } {
  const queues: WorkQueueDef[] = [];
  const warnings: string[] = [];
  list.forEach((raw, index) => {
    const { def, warning } = parseQueueEntry(raw, index);
    if (warning) warnings.push(warning);
    if (!def) return;
    if (queues.some((q) => q.id === def.id)) {
      warnings.push(`workQueues[${index}] (${def.id}): duplicate id, ignored`);
      return;
    }
    queues.push(def);
  });
  return { queues, warnings };
}

/** The built-in queues, parsed. */
export const DEFAULT_WORK_QUEUES: readonly WorkQueueDef[] = Object.freeze(parseList(DEFAULT_WORK_QUEUES_CONFIG).queues);

/** Parse `config.json#workQueues`. Never throws; bad entries are skipped with a warning. */
export function parseWorkQueuesConfig(raw: unknown): { queues: WorkQueueDef[]; warnings: string[] } {
  if (raw === undefined) return { queues: DEFAULT_WORK_QUEUES.map((q) => ({ ...q })), warnings: [] };
  if (!Array.isArray(raw)) {
    return {
      queues: DEFAULT_WORK_QUEUES.map((q) => ({ ...q })),
      warnings: ['workQueues: expected an array — keeping the built-in queues'],
    };
  }
  return parseList(raw);
}
