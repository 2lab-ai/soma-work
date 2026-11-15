/**
 * The session's copy of its code changes (.prd/27 §3): counts per layer, per repository and per PR, a few paths — what
 * the model reads (GET_SESSION, the turn context) and the board stamps. Never a patch.
 */

import {
  CHANGE_LAYERS,
  type ChangeLayer,
  type CodeChangesDoc,
  type CodeChangesSummary,
  type LayerTotals,
} from './types';

const MAX_PATHS = 8;
const MAX_REPOS = 20;
const MAX_PRS = 20;

const zero = (): LayerTotals => ({ files: 0, additions: 0, deletions: 0 });

export function summarizeCodeChanges(doc: CodeChangesDoc): CodeChangesSummary {
  const layers = Object.fromEntries(CHANGE_LAYERS.map((l) => [l, zero()])) as Record<ChangeLayer, LayerTotals>;
  const add = (l: ChangeLayer, files: number, additions: number, deletions: number) => {
    layers[l].files += files;
    layers[l].additions += additions;
    layers[l].deletions += deletions;
  };
  const repos: CodeChangesSummary['repos'] = [];
  for (const c of doc.checkouts) {
    add('uncommitted', c.uncommitted.files.length, c.uncommitted.additions, c.uncommitted.deletions);
    add('committed', c.committed.files.length, c.committed.additions, c.committed.deletions);
    if (repos.length >= MAX_REPOS) continue;
    const paths = [...c.uncommitted.files, ...c.committed.files].map((f) => f.path);
    const entry: CodeChangesSummary['repos'][number] = {
      repo: c.repo,
      dir: c.dir,
      uncommitted: {
        files: c.uncommitted.files.length,
        additions: c.uncommitted.additions,
        deletions: c.uncommitted.deletions,
      },
      committed: {
        files: c.committed.files.length,
        additions: c.committed.additions,
        deletions: c.committed.deletions,
        commits: c.committed.commits.length,
      },
      paths: [...new Set(paths)].slice(0, MAX_PATHS),
    };
    if (c.branch) entry.branch = c.branch;
    if (c.uncommitted.skipped) entry.skipped = c.uncommitted.skipped;
    repos.push(entry);
  }
  for (const p of doc.prs) {
    if (p.state === 'open' || p.state === 'draft') add('pr', p.changedFiles, p.additions, p.deletions);
    else if (p.state === 'merged') add('merged', p.changedFiles, p.additions, p.deletions);
  }
  return {
    updatedAt: doc.updatedAt,
    layers,
    repos,
    prs: doc.prs.slice(0, MAX_PRS).map((p) => ({
      url: p.url,
      number: p.number,
      repo: p.repo,
      state: p.state,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
    })),
  };
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const s = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const totals = (v: unknown): LayerTotals => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { files: n(o.files), additions: n(o.additions), deletions: n(o.deletions) };
};
const PR_STATES = new Set(['open', 'draft', 'merged', 'closed']);

/** A persisted summary read back from disk: anything malformed becomes undefined, never a throw. */
export function sanitizeCodeChangesSummary(raw: unknown): CodeChangesSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return undefined;
  const lr = (r.layers && typeof r.layers === 'object' ? r.layers : {}) as Record<string, unknown>;
  const layers = Object.fromEntries(CHANGE_LAYERS.map((l) => [l, totals(lr[l])])) as Record<ChangeLayer, LayerTotals>;
  const repos: CodeChangesSummary['repos'] = [];
  for (const x of Array.isArray(r.repos) ? r.repos.slice(0, MAX_REPOS) : []) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const repo = s(o.repo);
    if (!repo) continue;
    const committed = (o.committed && typeof o.committed === 'object' ? o.committed : {}) as Record<string, unknown>;
    const entry: CodeChangesSummary['repos'][number] = {
      repo,
      uncommitted: totals(o.uncommitted),
      committed: { ...totals(committed), commits: n(committed.commits) },
      paths: (Array.isArray(o.paths) ? o.paths : [])
        .map((p) => s(p, 500))
        .filter((p): p is string => !!p)
        .slice(0, MAX_PATHS),
    };
    const dir = s(o.dir);
    const branch = s(o.branch);
    const skipped = s(o.skipped, 80);
    if (dir) entry.dir = dir;
    if (branch) entry.branch = branch;
    if (skipped) entry.skipped = skipped;
    repos.push(entry);
  }
  const prs: CodeChangesSummary['prs'] = [];
  for (const x of Array.isArray(r.prs) ? r.prs.slice(0, MAX_PRS) : []) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const url = s(o.url, 500);
    const repo = s(o.repo);
    if (!url || !repo || !PR_STATES.has(String(o.state))) continue;
    prs.push({
      url,
      number: n(o.number),
      repo,
      state: o.state as CodeChangesSummary['prs'][number]['state'],
      additions: n(o.additions),
      deletions: n(o.deletions),
      changedFiles: n(o.changedFiles),
    });
  }
  return { updatedAt: r.updatedAt, layers, repos, prs };
}
