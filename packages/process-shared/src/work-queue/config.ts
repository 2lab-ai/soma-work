/**
 * `config.json#workQueues` (.prd/36 §4.4) — which queues this host has.
 *
 *   "workQueues": { "deploy": ["dev2", "stage0"], "qa": ["dev2", "stage0"] }
 *
 * Key = lane, value = environments; each pair is one queue `<lane>:<env>`. No key → no queues. The old array form
 * (#726: `[{ id, workflow, targets, … }]`) still reads — `workflow` as the lane, `targets` as environments — with a
 * warning. Never throws: a bad lane or environment is skipped with a warning.
 */

export interface WorkQueueDef {
  /** `<lane>:<env>`. */
  id: string;
  lane: string;
  env: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

/** `refs/heads/deploy/dev2`, `deploy/DEV2` → `dev2` (the old form named deploy branches). */
function legacyTarget(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/^deploy\//, '');
}

export function parseWorkQueuesConfig(raw: unknown): { queues: WorkQueueDef[]; warnings: string[] } {
  const queues: WorkQueueDef[] = [];
  const warnings: string[] = [];
  const add = (lane: string, envs: unknown, where: string): void => {
    const l = lane.trim().toLowerCase();
    if (!NAME_RE.test(l)) {
      warnings.push(`${where}: lane "${lane}" is not a short lower-case name — skipped`);
      return;
    }
    if (!Array.isArray(envs)) {
      warnings.push(`${where}: expected a list of environments — skipped`);
      return;
    }
    for (const env of envs) {
      const e = typeof env === 'string' ? env.trim().toLowerCase() : '';
      if (!NAME_RE.test(e)) {
        warnings.push(`${where}: environment "${String(env)}" is not a short lower-case name — skipped`);
        continue;
      }
      const id = `${l}:${e}`;
      if (!queues.some((q) => q.id === id)) queues.push({ id, lane: l, env: e });
    }
  };

  if (raw === undefined || raw === null) return { queues, warnings };
  if (Array.isArray(raw)) {
    warnings.push('workQueues: the old array form — write { "<lane>": ["<env>", …] } instead');
    raw.forEach((entry, i) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const targets = Array.isArray(e.targets)
        ? e.targets.map((t) => (typeof t === 'string' ? legacyTarget(t) : t))
        : e.targets;
      add(typeof e.workflow === 'string' ? e.workflow : '', targets, `workQueues[${i}]`);
    });
    return { queues, warnings };
  }
  if (typeof raw !== 'object') {
    warnings.push('workQueues: expected { "<lane>": ["<env>", …] } — no queues');
    return { queues, warnings };
  }
  for (const [lane, envs] of Object.entries(raw as Record<string, unknown>)) add(lane, envs, `workQueues.${lane}`);
  return { queues, warnings };
}
