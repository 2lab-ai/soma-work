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
 *   4. Stamp each link's `title` via `setSessionLink`.
 *   5. Derive a `session.title`:
 *        - exactly one resolved title → use it as-is
 *        - issue + PR titles → ask Haiku for a 1-line summary; fall back to
 *          `${issue} · ${pr}` join when LLM is unavailable / fails
 *   6. Persist via `setSessionTitle` and emit a single-card WS patch.
 *
 * `summaryTitle` ownership stays elsewhere — this module only stages a stable
 * baseline (`title` + `links.*.title`) so `displayTitle()`'s priority chain
 * has good fallbacks while the LLM summarizer warms up.
 *
 * Concurrency: `inFlightSessions` keys on `ConversationSession` so the three
 * trigger surfaces firing simultaneously (e.g. dispatch + onSessionLinksDetected
 * during the same turn) collapse to one fetch — same precedent as
 * `instructions-summarizer.ts:35`.
 */

import type { ClaudeHandler } from '../claude-handler';
import { broadcastSingleSessionUpdate } from '../conversation/dashboard';
import { nonBlank } from '../format/display-title';
import { fetchBatchLinkMetadata } from '../link-metadata-fetcher';
import { Logger } from '../logger';
import type { ConversationSession, SessionLink, SessionLinks } from '../types';
import { generateSessionSummaryTitle } from './summarizer';

const logger = new Logger('LinkDerivedTitle');

/** Cap stored on `session.title` — the UI never has to defend against megabyte titles. */
const MAX_SESSION_TITLE_LENGTH = 200;

/** Slot order used both for SessionLinks iteration and SessionLink[] zipping. */
const LINK_SLOTS: ReadonlyArray<keyof SessionLinks> = ['issue', 'pr', 'doc'];

/** In-flight dedup — at most one refresh per session at a time. */
const inFlightSessions = new WeakSet<ConversationSession>();

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

  if (inFlightSessions.has(session)) {
    logger.debug('Link-title refresh already in flight for session — skipping', { sessionKey });
    return;
  }
  inFlightSessions.add(session);

  try {
    await runRefresh(handler, address, session);
  } finally {
    inFlightSessions.delete(session);
  }
}

async function runRefresh(
  handler: LinkDerivedTitleHandler,
  address: SessionAddress,
  session: ConversationSession,
): Promise<void> {
  const { channelId, threadTs, sessionKey } = address;

  const initialUrls = captureUrls(session.links);
  const initialGeneration = session.linkRefreshGeneration ?? 0;

  // Skip slots that already carry a title — title is the slow remote field, and
  // an empty fetcher result would otherwise erase a previously-good cached
  // value via the no-op write guard below.
  const slots: Array<{ slot: keyof SessionLinks; link: SessionLink }> = [];
  for (const slot of LINK_SLOTS) {
    const link = session.links?.[slot];
    if (link?.url && !nonBlank(link.title)) {
      slots.push({ slot, link: { ...link } });
    }
  }

  if (slots.length === 0) {
    // Cached titles from a prior run may still let us refresh `session.title`.
    await maybeWriteSessionTitle(handler, address, initialGeneration, initialUrls);
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

  // Stale-guard before any write. resetSessionContext bumps generation; the
  // user (or model) may have pointed at different URLs while we were in flight.
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

  for (let i = 0; i < slots.length; i++) {
    const slotInfo = slots[i];
    const updated = enriched[i];
    if (!updated || !nonBlank(updated.title)) continue;
    if (updated.title === slotInfo.link.title) continue;
    handler.setSessionLink(channelId, threadTs, { ...slotInfo.link, ...updated });
  }

  await maybeWriteSessionTitle(handler, address, initialGeneration, initialUrls);
}

async function maybeWriteSessionTitle(
  handler: LinkDerivedTitleHandler,
  address: SessionAddress,
  baselineGeneration: number,
  baselineUrls: UrlSnapshot,
): Promise<void> {
  const { channelId, threadTs, sessionKey } = address;

  // Re-read so setSessionLink writes above are visible. If the session vanished
  // mid-flight, abort — the `?? baseline` fallback would re-introduce the exact
  // stale state the guards just rejected.
  const session = handler.getSession(channelId, threadTs);
  if (!session) return;

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
    derived = clampTitle(titles.join(' · '));
  }

  if (!derived) return;

  // Re-check after the LLM hop — generation/URL set may have moved again.
  const liveSession = handler.getSession(channelId, threadTs);
  if (!liveSession) return;
  if ((liveSession.linkRefreshGeneration ?? 0) !== baselineGeneration) return;
  if (!urlsEqual(captureUrls(liveSession.links), baselineUrls)) return;

  if (nonBlank(liveSession.title) === derived) return;

  handler.setSessionTitle(channelId, threadTs, derived);
  try {
    broadcastSingleSessionUpdate(sessionKey);
  } catch (err) {
    logger.warn('broadcastSingleSessionUpdate failed', {
      sessionKey,
      error: (err as Error).message,
    });
  }
}

/**
 * Ask Haiku to fold issue + PR titles into a single concise headline. Falls
 * back to `${issue} · ${pr}` (clamped) when the LLM call returns null or throws.
 *
 * Exported so unit tests can target the issue+PR branch directly.
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

/**
 * Adapter: lift a real `ClaudeHandler` into the narrower
 * `LinkDerivedTitleHandler` shape. Methods are wrapped (not bound) so the
 * adapter never reads `setSessionLink` / `setSessionTitle` until the
 * pipeline actually needs them — important for tests whose mocks only
 * implement the read side, and whose `getSession` returns null causing the
 * pipeline to bail before touching the write methods.
 */
function adaptHandler(handler: ClaudeHandler): LinkDerivedTitleHandler {
  return {
    getSession: (channelId, threadTs) => handler.getSession(channelId, threadTs),
    setSessionLink: (channelId, threadTs, link) => handler.setSessionLink(channelId, threadTs, link),
    setSessionTitle: (channelId, threadTs, title) => handler.setSessionTitle(channelId, threadTs, title),
  };
}

/**
 * Fire-and-forget scheduler — collapses the boilerplate (sessionKey lookup +
 * `.catch` log) the three trigger surfaces all need. `tag` is a free-form
 * label that lands in the warn log so failures point back to the call site.
 */
export function scheduleLinkDerivedTitleRefresh(
  claudeHandler: Pick<
    ClaudeHandler,
    'getSession' | 'getSessionByKey' | 'getSessionKey' | 'setSessionLink' | 'setSessionTitle'
  >,
  channelId: string,
  threadTs: string | undefined,
  tag: string,
): void {
  const sessionKey = claudeHandler.getSessionKey(channelId, threadTs);
  stampLinkTitlesAndDeriveSessionTitle(adaptHandler(claudeHandler as ClaudeHandler), {
    channelId,
    threadTs,
    sessionKey,
  }).catch((err) => {
    logger.warn('Link-derived title refresh failed', {
      tag,
      sessionKey,
      error: (err as Error).message,
    });
  });
}
