/**
 * Where a task card's work happens, and its two clocks (SSOT 2026-11-05 — the board's filters and sort):
 *
 *   repo         the GitHub repo (`owner/repo`, lower case) of the work's own PR or issue — the active PR, the
 *                active issue, then the newest of the link history — else the repo its Slack channel maps to
 *                when the channel is public and maps exactly one (a channel of several repos does not say which).
 *   channelName  a public Slack channel's name as the channel registry knows it (no `#`). Absent for a DM, a
 *                dashboard-only task and a channel the bot does not know — the card then says what it can.
 *   channelPrivate  the channel is private (or the registry cannot say it is public): the board goes to every
 *                signed-in viewer, members or not, so neither its name nor the repo it maps to is sent — the card
 *                says 비공개 채널. The repo of the card's own PR or issue still is (that link is on the card).
 *   startedAt    when the task started (epoch ms): the session's own start, else its Slack thread's first
 *                message (the thread ts is that message's time).
 *   progressAt   when the work last moved (epoch ms): the later of the last input and the last change of state
 *                (a turn starting, finishing, waiting) — an archive's finish time.
 *
 * Pure apart from the registry lookup, which the caller can replace.
 */

import { getChannel } from '../channel-registry';

export interface CardWhere {
  repo?: string;
  channelName?: string;
  channelPrivate?: true;
}

export interface CardClocks {
  startedAt?: number;
  progressAt?: number;
}

interface LinkLike {
  url?: unknown;
}

interface WhereSource {
  channelId?: unknown;
  links?: { pr?: LinkLike; issue?: LinkLike } | null;
  linkHistory?: { prs?: unknown; issues?: unknown } | null;
}

export type ChannelLookup = (channelId: string) => { name?: string; repos?: string[]; isPrivate?: boolean } | undefined;

const GITHUB_REPO_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/?#]|$)/;

/** `owner/repo` (lower case, no `.git`) of a github.com URL; undefined for anything else. */
export function githubRepoOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const m = GITHUB_REPO_URL.exec(url.trim());
  if (!m) return undefined;
  const repo = m[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return undefined;
  return `${m[1]}/${repo}`.toLowerCase();
}

function newestRepoOf(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const repo = githubRepoOf((list[i] as LinkLike | undefined)?.url);
    if (repo) return repo;
  }
  return undefined;
}

function safeLookup(lookup: ChannelLookup, channelId: string): ReturnType<ChannelLookup> {
  try {
    return lookup(channelId);
  } catch {
    // A registry that cannot answer never fails the card.
    return undefined;
  }
}

/** The card's repo and channel name (see the module comment). */
export function cardWhereOf(s: WhereSource, lookup: ChannelLookup = getChannel): CardWhere {
  const out: CardWhere = {};
  const channelId = typeof s.channelId === 'string' ? s.channelId : '';
  const known = channelId ? safeLookup(lookup, channelId) : undefined;
  // Only a channel the registry says is public gives its name and its repo to every viewer.
  const channel = known && known.isPrivate === false ? known : undefined;
  if (known && !channel) out.channelPrivate = true;
  const repo =
    githubRepoOf(s.links?.pr?.url) ??
    githubRepoOf(s.links?.issue?.url) ??
    newestRepoOf(s.linkHistory?.prs) ??
    newestRepoOf(s.linkHistory?.issues) ??
    (Array.isArray(channel?.repos) && channel.repos.length === 1
      ? githubRepoOf(`https://github.com/${channel.repos[0]}`)
      : undefined);
  if (repo) out.repo = repo;
  const name = typeof channel?.name === 'string' ? channel.name.trim() : '';
  if (name) out.channelName = name;
  return out;
}

function finiteMs(v: unknown): number | undefined {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) && t > 0 ? t : undefined;
  }
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : undefined;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : undefined;
  }
  return undefined;
}

/** A Slack ts (`1793870941.429100`) as epoch ms; undefined when it is not one. */
export function slackTsMs(ts: unknown): number | undefined {
  if (typeof ts !== 'string' || !/^\d{9,11}(\.\d+)?$/.test(ts)) return undefined;
  const ms = Math.round(Number(ts) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

interface ClockSource {
  startedAt?: unknown;
  threadTs?: unknown;
  lastActivity?: unknown;
}

/** A live session's clocks: started at its start (else its thread's), moved at its last input or state change. */
export function liveCardClocks(
  s: ClockSource & { activityStateChangedAt?: unknown; activeLegStartedAtMs?: unknown },
): CardClocks {
  return clocks(s, [s.lastActivity, s.activityStateChangedAt, s.activeLegStartedAtMs]);
}

/** An archive's clocks: started as a live one, moved last when it finished (else its last input). */
export function archivedCardClocks(s: ClockSource & { doneAt?: unknown }): CardClocks {
  return clocks(s, [s.lastActivity, s.doneAt]);
}

function clocks(s: ClockSource, moves: unknown[]): CardClocks {
  const out: CardClocks = {};
  const started = finiteMs(s.startedAt) ?? slackTsMs(s.threadTs);
  let progress: number | undefined;
  for (const m of moves) {
    const t = finiteMs(m);
    if (t !== undefined && (progress === undefined || t > progress)) progress = t;
  }
  if (progress !== undefined) out.progressAt = progress;
  // A start after the last move is a clock we cannot trust (a thread ts of a migrated thread): the start is the move.
  if (started !== undefined) out.startedAt = progress !== undefined ? Math.min(started, progress) : started;
  return out;
}
