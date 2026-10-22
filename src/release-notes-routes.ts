/**
 * SOMA_RELEASE_NOTES_CHANNELS — where the deploy workflow's release notes go.
 *
 * Operator config, per instance (the host's `.env`), read once by `config.ts`:
 *
 *   SOMA_RELEASE_NOTES_CHANNELS=acme/app@deploy/staging=C0STAGING01,*=session
 *
 * Entries are separated by commas or newlines:
 *   - `owner/repo@branch=<channel>` — that repo's deploys into that branch (repo
 *     matched case-insensitively). Wins over a bare-branch entry.
 *   - `branch=<channel>` — any repo's deploys into that branch.
 *   - `*=session` | `*=<channel>` — the fallback for a deploy no entry matches:
 *     the deploy session's own channel, or a fixed channel. Without `*`, an
 *     unmatched deploy goes to NO channel root: its notes stay in the deploy thread.
 * `<channel>` is a channel ID or `#name`. `session` is only valid for `*`.
 * Branches are matched exactly, after trimming and dropping `refs/heads/`.
 * A malformed entry is dropped alone (the rest still apply) and reported.
 *
 * A branch that only differs in spelling from a mapped one (same last path
 * segment, case-insensitive: `staging` / `deploy/STAGING` vs `deploy/staging`) is a
 * near-miss. It is diagnostic only — it never routes to that entry's channel and
 * never changes the fallback's destination; it only turns the notice into a warning.
 *
 * Pure: no env, no I/O.
 */

import type { ReleaseNotesRouting } from '@soma/slack/release-notes-poster';

export interface ReleaseNotesRoute {
  /** Lower-cased `owner/repo`; absent for a bare-branch entry. */
  repo?: string;
  target: string;
  channel: string;
}

export interface ReleaseNotesChannelsConfig {
  routes: ReleaseNotesRoute[];
  /** The `*` entry: `session`, or a channel. Absent = unmatched deploys stay in the deploy thread. */
  fallback?: string;
  /** Malformed entries, as written. */
  invalid: string[];
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const BRANCH_PATTERN = /^[\w./-]+$/;
const CHANNEL_PATTERN = /^(#\S+|[CGD][A-Z0-9]{6,})$/;

export function normalizeBranch(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, '');
}

/** Parse the env value. Never throws; malformed entries land in `invalid`. */
export function parseReleaseNotesChannels(raw: string | undefined): ReleaseNotesChannelsConfig {
  const config: ReleaseNotesChannelsConfig = { routes: [], invalid: [] };
  for (const entry of (raw ?? '').split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const eq = trimmed.lastIndexOf('=');
    const key = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    const value = eq > 0 ? trimmed.slice(eq + 1).trim() : '';

    if (key === '*' && (value === 'session' || CHANNEL_PATTERN.test(value)) && config.fallback === undefined) {
      config.fallback = value;
      continue;
    }
    if (!key || key === '*' || !CHANNEL_PATTERN.test(value)) {
      config.invalid.push(trimmed);
      continue;
    }

    const at = key.indexOf('@');
    const repo = at < 0 ? undefined : key.slice(0, at);
    const target = normalizeBranch(at < 0 ? key : key.slice(at + 1));
    if ((repo !== undefined && !REPO_PATTERN.test(repo)) || !BRANCH_PATTERN.test(target)) {
      config.invalid.push(trimmed);
      continue;
    }
    config.routes.push(
      repo === undefined ? { target, channel: value } : { repo: repo.toLowerCase(), target, channel: value },
    );
  }
  return config;
}

function keyOf(route: ReleaseNotesRoute): string {
  return route.repo ? `${route.repo}@${route.target}` : route.target;
}

function lastSegment(branch: string): string {
  return branch.slice(branch.lastIndexOf('/') + 1).toLowerCase();
}

/** Decide where one repo's notes go. */
export function routeReleaseNotes(
  config: ReleaseNotesChannelsConfig,
  repo: string,
  target: string,
): ReleaseNotesRouting {
  const { routes, fallback, invalid } = config;
  const keys = routes.map(keyOf);
  if (routes.length === 0 && fallback === undefined && invalid.length === 0) {
    return { destination: { kind: 'session' }, unmapped: false, keys, nearMisses: [], invalid };
  }

  const branch = normalizeBranch(target);
  const repoKey = repo.trim().toLowerCase();
  const applies = routes.filter((route) => !route.repo || route.repo === repoKey);
  const exact =
    applies.find((route) => route.repo && route.target === branch) ??
    applies.find((route) => !route.repo && route.target === branch);
  if (exact) {
    return { destination: { kind: 'channel', channel: exact.channel }, unmapped: false, keys, nearMisses: [], invalid };
  }

  const nearMisses = applies
    .filter((route) => lastSegment(route.target) === lastSegment(branch))
    .map((route) => ({ key: keyOf(route), channel: route.channel }));
  const destination =
    fallback === undefined
      ? ({ kind: 'deploy-thread' } as const)
      : fallback === 'session'
        ? ({ kind: 'session' } as const)
        : ({ kind: 'channel', channel: fallback } as const);
  return { destination, unmapped: true, keys, nearMisses, invalid };
}
