/**
 * .prd/26 §6 (#1297) — the turn context's line about work left behind: code in the session's checkouts that is not
 * committed, or committed but in no PR yet, as of the last collect (the previous turn end). Nothing when there is none,
 * so a session that pushed everything pays no tokens. Data only — what to do about it is the model's call.
 */

interface Totals {
  files: number;
  additions: number;
  deletions: number;
}

/** The fields of the session's code-changes summary this line reads (somalib `CodeChangesSummary`). */
export interface CodeChangesContextInput {
  updatedAt: number;
  repos: Array<{
    repo: string;
    dir?: string;
    branch?: string;
    uncommitted: Totals;
    committed: Totals & { commits: number };
    paths: string[];
  }>;
}

const MAX_REPOS = 3;
const MAX_PATHS = 5;
/** A summary older than this is not shown — the checkouts have likely moved on (a session left for days). */
const MAX_AGE_MS = 7 * 24 * 3600_000;

const clean = (s: string) => s.replace(/[<>\n\r]/g, ' ').slice(0, 200);

export function uncommittedChangesContext(
  cc: CodeChangesContextInput | undefined,
  now: number = Date.now(),
): string | undefined {
  if (!cc || !Array.isArray(cc.repos) || !Number.isFinite(cc.updatedAt) || now - cc.updatedAt > MAX_AGE_MS)
    return undefined;
  const pending = cc.repos.filter((r) => (r.uncommitted?.files ?? 0) > 0 || (r.committed?.files ?? 0) > 0);
  if (pending.length === 0) return undefined;
  const lines = pending.slice(0, MAX_REPOS).map((r) => {
    const parts: string[] = [];
    if (r.uncommitted.files > 0) {
      parts.push(
        `${r.uncommitted.files} files not committed (+${r.uncommitted.additions} -${r.uncommitted.deletions})`,
      );
    }
    if (r.committed.files > 0) {
      parts.push(`${r.committed.commits} commits in no PR yet (${r.committed.files} files)`);
    }
    const where = [r.dir ? `dir ${clean(r.dir)}` : '', r.branch ? `branch ${clean(r.branch)}` : '']
      .filter(Boolean)
      .join(', ');
    const paths = (r.paths ?? []).slice(0, MAX_PATHS).map(clean);
    const more = (r.paths ?? []).length > MAX_PATHS ? ', …' : '';
    return `  - ${clean(r.repo)}${where ? ` (${where})` : ''}: ${parts.join('; ')}${paths.length ? ` — ${paths.join(', ')}${more}` : ''}`;
  });
  if (pending.length > MAX_REPOS) lines.push(`  - and ${pending.length - MAX_REPOS} more checkouts`);
  return [
    `<uncommitted-changes as-of="${new Date(cc.updatedAt).toISOString()}">`,
    "  This session's checkouts hold work that is not in a PR yet (as of the last turn end):",
    ...lines,
    '</uncommitted-changes>',
  ].join('\n');
}
