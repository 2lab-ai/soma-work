/**
 * Link-derived session title pipeline (#762).
 *
 * Trigger surfaces:
 *   - first dispatch (`session-initializer.ts`)
 *   - explicit `link <type> <url>` command (`link-handler.ts`)
 *   - mid-conversation model-emitted link directive (`stream-executor.ts`)
 *
 * Pipeline (fire-and-forget):
 *   1. Capture the live URL set + `linkRefreshGeneration` BEFORE any async work.
 *   2. `fetchBatchLinkMetadata` to fill in real GitHub/Jira titles.
 *   3. Re-check URL set + generation against the session BEFORE writing —
 *      `resetSessionContext` (or a fresh /link command) bumps generation,
 *      so a slow refresh from before the reset aborts cleanly.
 *   4. Stamp each link's `title` via `setSessionLink` (full title, no
 *      truncation — display-side capping owns layout decisions).
 *   5. Derive a `session.title`:
 *        - exactly one resolved title → use it as-is
 *        - issue + PR titles → ask Haiku for a 1-line summary; fall back to
 *          `${issue} · ${pr}` join when LLM is unavailable / fails
 *   6. Persist via `setSessionTitle` and emit a single-card WS patch.
 *
 * `summaryTitle` ownership stays elsewhere — this module only stages a stable
 * baseline (`title` + `links.*.title`) so `displayTitle()`'s priority chain
 * has good fallbacks while the LLM summarizer warms up.
 */

import type { ClaudeHandler } from '../claude-handler';
import { broadcastSingleSessionUpdate } from '../conversation/dashboard';
import { fetchBatchLinkMetadata } from '../link-metadata-fetcher';
import { Logger } from '../logger';
import type { ConversationSession, SessionLink, SessionLinks } from '../types';
import { generateSessionSummaryTitle } from './summarizer';

const logger = new Logger('LinkDerivedTitle');

/** Cap stored on `session.title` so the UI never has to defend against megabyte titles. */
const MAX_SESSION_TITLE_LENGTH = 200;

interface SessionAddress {
  channelId: string;
  threadTs: string | undefined;
  sessionKey: string;
}

/**
 * Lightweight subset of `ClaudeHandler` we need — keeps unit tests cheap and
 * documents the call surface this module is allowed to touch.
 */
export interface LinkDerivedTitleHandler {
  getSession(channelId: string, threadTs?: string): ConversationSession | undefined;
  getSessionByKey(sessionKey: string): ConversationSession | undefined;
  setSessionLink(channelId: string, threadTs: string | undefined, link: SessionLink): void;
  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void;
}

interface UrlSnapshot {
  issueUrl?: string;
  prUrl?: string;
  docUrl?: string;
}

function captureUrls(links: SessionLinks | undefined): UrlSnapshot {
  return {
    issueUrl: links?.issue?.url,
    prUrl: links?.pr?.url,
    docUrl: links?.doc?.url,
  };
}

function urlsEqual(a: UrlSnapshot, b: UrlSnapshot): boolean {
  return a.issueUrl === b.issueUrl && a.prUrl === b.prUrl && a.docUrl === b.docUrl;
}

function clampTitle(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX_SESSION_TITLE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_SESSION_TITLE_LENGTH - 1)}…`;
}

/**
 * Fetch metadata for active links, stamp their `.title` onto the session,
 * and derive a session-level title from the resolved link titles. Safe to
 * fire-and-forget — every error path logs at warn-level and returns early.
 */
export async function stampLinkTitlesAndDeriveSessionTitle(
  handler: LinkDerivedTitleHandler,
  address: SessionAddress,
): Promise<void> {
  const { channelId, threadTs, sessionKey } = address;

  const session = handler.getSession(channelId, threadTs);
  if (!session) {
    logger.debug('Session vanished before link-title refresh started', { sessionKey });
    return;
  }

  const initialUrls = captureUrls(session.links);
  const initialGeneration = session.linkRefreshGeneration ?? 0;

  // Build the SessionLink[] to pass to fetchBatchLinkMetadata. Skip slots that
  // already carry a non-blank title — title is the slow remote field, status
  // is the cheap one, and we don't want to clobber a label-only refresh.
  const slots: Array<{ slot: 'issue' | 'pr' | 'doc'; link: SessionLink }> = [];
  if (session.links?.issue?.url && !nonBlank(session.links.issue.title)) {
    slots.push({ slot: 'issue', link: { ...session.links.issue } });
  }
  if (session.links?.pr?.url && !nonBlank(session.links.pr.title)) {
    slots.push({ slot: 'pr', link: { ...session.links.pr } });
  }
  if (session.links?.doc?.url && !nonBlank(session.links.doc.title)) {
    slots.push({ slot: 'doc', link: { ...session.links.doc } });
  }

  if (slots.length === 0) {
    // Even with no slots to fetch, the existing titles might still let us
    // refresh `session.title` (e.g. cached titles arrived from a prior
    // run). Compute & write below using the current link state.
    await maybeWriteSessionTitle(handler, address, session, initialGeneration, initialUrls);
    return;
  }

  let enriched: SessionLink[];
  try {
    enriched = await fetchBatchLinkMetadata(slots.map((s) => s.link));
  } catch (err) {
    logger.warn('fetchBatchLinkMetadata threw', {
      sessionKey,
      error: (err as Error).message,
    });
    return;
  }

  // Re-check freshness BEFORE any write. Bail out if the session was reset
  // or the user pointed at different URLs while we were in flight.
  const liveSession = handler.getSession(channelId, threadTs);
  if (!liveSession) return;
  const liveUrls = captureUrls(liveSession.links);
  const liveGeneration = liveSession.linkRefreshGeneration ?? 0;
  if (liveGeneration !== initialGeneration || !urlsEqual(liveUrls, initialUrls)) {
    logger.debug('Link refresh stale — aborting write', {
      sessionKey,
      initialGeneration,
      liveGeneration,
      urlsChanged: !urlsEqual(liveUrls, initialUrls),
    });
    return;
  }

  // Stamp each link's title back via setSessionLink. Skip writes when
  // metadata returned no title (e.g. token-less environment) so we don't
  // erase a previously-good cached value.
  for (let i = 0; i < slots.length; i++) {
    const slotInfo = slots[i];
    const updated = enriched[i];
    if (!updated || !nonBlank(updated.title)) continue;
    if (updated.title === slotInfo.link.title) continue;
    handler.setSessionLink(channelId, threadTs, { ...slotInfo.link, ...updated });
  }

  await maybeWriteSessionTitle(handler, address, liveSession, initialGeneration, initialUrls);
}

/**
 * Variant for the `/link <type> <url>` flow: fetch a single link's title,
 * then funnel through the same derivation pipeline. Kept as a thin wrapper
 * so callers don't need to know whether the addition was a 1-link or N-link
 * update — both end up running through `stampLinkTitlesAndDeriveSessionTitle`.
 */
export async function stampLinkTitleIfMissing(
  handler: LinkDerivedTitleHandler,
  address: SessionAddress,
): Promise<void> {
  await stampLinkTitlesAndDeriveSessionTitle(handler, address);
}

async function maybeWriteSessionTitle(
  handler: LinkDerivedTitleHandler,
  address: SessionAddress,
  baseline: ConversationSession,
  baselineGeneration: number,
  baselineUrls: UrlSnapshot,
): Promise<void> {
  const { channelId, threadTs, sessionKey } = address;

  // Re-read the session — setSessionLink calls above may have refreshed
  // titles that we want to consume here.
  const session = handler.getSession(channelId, threadTs) ?? baseline;
  const issueTitle = nonBlank(session.links?.issue?.title);
  const prTitle = nonBlank(session.links?.pr?.title);
  const docTitle = nonBlank(session.links?.doc?.title);

  const titles = [issueTitle, prTitle, docTitle].filter((t): t is string => Boolean(t));
  if (titles.length === 0) return;

  let derived: string | undefined;
  if (titles.length === 1) {
    derived = clampTitle(titles[0]);
  } else if (issueTitle && prTitle && !docTitle) {
    derived = await summarizeIssueAndPrTitles(issueTitle, prTitle);
  } else {
    // 3-link case (rare) or 2-link with doc — join titles deterministically.
    derived = clampTitle(titles.join(' · '));
  }

  if (!derived) return;

  // Stale-guard once more before writing — we may have made another async hop
  // (LLM call) between the freshness check and this point.
  const liveSession = handler.getSession(channelId, threadTs);
  if (!liveSession) return;
  if ((liveSession.linkRefreshGeneration ?? 0) !== baselineGeneration) return;
  if (!urlsEqual(captureUrls(liveSession.links), baselineUrls)) return;

  // Don't blat a meaningful existing title with the same value.
  const currentTitle = nonBlank(liveSession.title);
  if (currentTitle === derived) return;

  handler.setSessionTitle(channelId, threadTs, derived);
  try {
    broadcastSingleSessionUpdate(sessionKey);
  } catch (err) {
    // Broadcast failures must not break the title write.
    logger.warn('broadcastSingleSessionUpdate failed', {
      sessionKey,
      error: (err as Error).message,
    });
  }
}

/**
 * Ask Haiku (via `generateSessionSummaryTitle`) to fold issue + PR titles
 * into a single concise headline. Falls back to `${issue} · ${pr}` (clamped)
 * when the LLM call returns null.
 *
 * Exposed so unit tests can target the issue+PR branch directly without
 * going through the full pipeline.
 */
export async function summarizeIssueAndPrTitles(issueTitle: string, prTitle: string): Promise<string> {
  const fallback = clampTitle(`${issueTitle} · ${prTitle}`);
  try {
    const result = await generateSessionSummaryTitle([`Issue: ${issueTitle}`, `PR: ${prTitle}`]);
    if (result?.title) {
      const cleaned = clampTitle(result.title);
      if (cleaned.length > 0) return cleaned;
    }
  } catch (err) {
    logger.warn('summarizeIssueAndPrTitles LLM call threw — using join fallback', {
      error: (err as Error).message,
    });
  }
  return fallback;
}

function nonBlank(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Adapter: lift a real `ClaudeHandler` into the narrower
 * `LinkDerivedTitleHandler` shape. Lets call sites pass `claudeHandler`
 * directly without leaking the full surface into this module's tests.
 */
export function adaptHandler(handler: ClaudeHandler): LinkDerivedTitleHandler {
  return {
    getSession: handler.getSession.bind(handler),
    getSessionByKey: handler.getSessionByKey.bind(handler),
    setSessionLink: handler.setSessionLink.bind(handler),
    setSessionTitle: handler.setSessionTitle.bind(handler),
  };
}
