/**
 * Lane names (.prd/36 v2 D11) and `config.json#workQueues`.
 *
 * A lane is named by the work that uses it — `qa-dev2`, `deploy-stage0` — and exists from its first entry: nothing
 * has to be configured before a session lines up (SSOT_4 "미리 설정된게 아니라"). A name is lower case,
 * `[a-z0-9][a-z0-9._-]{0,47}`. The first form (`<lane>:<env>`, .prd/36 v1) still reads: `qa:dev2` is `qa-dev2`, and
 * a deploy branch as the environment (`deploy:deploy/<env>`, `refs/heads/…`) is the environment.
 *
 * `config.json#workQueues` only pins lanes: a pinned lane is listed (board, settings, `queue_list`) even while it is
 * empty. `{ "deploy": ["dev2"], "qa": ["dev2"] }` pins `deploy-dev2` and `qa-dev2`; the #726 array form still reads.
 * Never throws: a bad entry is skipped with a warning.
 */

import * as fs from 'node:fs';

export const QUEUE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** `refs/heads/deploy/<env>`, `deploy/<ENV>` → `<env>` (the old forms named deploy branches). */
function legacyTarget(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/^deploy\//, '');
}

/**
 * A lane name as a model or a person writes it, in its one spelling: lower case, surrounding space gone, and the
 * v1 `<lane>:<env>` form joined with `-` (the environment without a `refs/heads/` or `deploy/` prefix).
 */
export function normalizeQueueName(raw: string): string {
  const text = raw.trim().toLowerCase();
  const at = text.indexOf(':');
  if (at < 0) return text;
  return `${text.slice(0, at)}-${legacyTarget(text.slice(at + 1))}`;
}

export function isQueueName(name: string): boolean {
  return QUEUE_NAME_RE.test(name);
}

/** The lanes `config.json#workQueues` pins, in order, each once. */
export function parseWorkQueuesConfig(raw: unknown): { queues: string[]; warnings: string[] } {
  const queues: string[] = [];
  const warnings: string[] = [];
  const add = (lane: string, envs: unknown, where: string): void => {
    if (!Array.isArray(envs)) {
      warnings.push(`${where}: expected a list of environments — skipped`);
      return;
    }
    for (const env of envs) {
      const name = typeof env === 'string' ? normalizeQueueName(`${lane}:${env}`) : '';
      if (!isQueueName(name) || !lane.trim() || typeof env !== 'string' || !env.trim()) {
        warnings.push(`${where}: "${lane}" × "${String(env)}" is not a short lower-case name — skipped`);
        continue;
      }
      if (!queues.includes(name)) queues.push(name);
    }
  };

  if (raw === undefined || raw === null) return { queues, warnings };
  if (Array.isArray(raw)) {
    // `[]` was the #726 way to turn the queue off: nothing pinned, nothing to warn about.
    if (raw.length === 0) return { queues, warnings };
    warnings.push('workQueues: the old array form — write { "<lane>": ["<env>", …] } instead');
    raw.forEach((entry, i) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      add(typeof e.workflow === 'string' ? e.workflow : '', e.targets, `workQueues[${i}]`);
    });
    return { queues, warnings };
  }
  if (typeof raw !== 'object') {
    warnings.push('workQueues: expected { "<lane>": ["<env>", …] } — nothing pinned');
    return { queues, warnings };
  }
  for (const [lane, envs] of Object.entries(raw as Record<string, unknown>)) add(lane, envs, `workQueues.${lane}`);
  return { queues, warnings };
}

/**
 * The lanes `config.json#workQueues` pins, re-read when the file changes. A config that cannot be read keeps the last
 * good list (and pins nothing before the first good read): pinning only decides what is listed while empty, never
 * whether a lane can be used.
 */
export function readPinnedQueuesFromConfigFile(
  configFile: string | undefined,
  warn?: (message: string) => void,
): () => readonly string[] {
  let good: { mtimeMs: number; queues: string[] } | undefined;
  return () => {
    if (!configFile) return [];
    try {
      const mtimeMs = fs.statSync(configFile).mtimeMs;
      if (good?.mtimeMs === mtimeMs) return good.queues;
      const raw: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const parsed = parseWorkQueuesConfig(
        raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).workQueues : undefined,
      );
      for (const warning of parsed.warnings) warn?.(`config.json ${warning}`);
      good = { mtimeMs, queues: parsed.queues };
      return parsed.queues;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn?.(`config.json unreadable — keeping the last pinned lanes: ${(error as Error)?.message}`);
      }
      return good?.queues ?? [];
    }
  };
}
