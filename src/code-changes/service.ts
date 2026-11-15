/**
 * The host side of the code-changes collector (.prd/27 §1): which session a run is for, what it reads from that session,
 * and what it writes back — the summary on the session (persisted), the card pushed, the result handed on (metrics).
 * A run writes only while the key still names the same, not terminated session (a close or a /new can land meanwhile).
 */

import { fetchGitHubPullDetail, fetchGitHubPullFiles } from '../link-metadata-fetcher';
import { sessionDirs, sessionStartMs } from '../session-pr-reconciler';
import {
  type CollectDeps,
  type CollectResult,
  collectCodeChanges,
  createCodeChangesScheduler,
  type SchedulerOptions,
  sessionRootOf,
} from './collector';
import { type CodeChangesStore, getCodeChangesStore } from './store';
import type { CodeChangesSummary } from './types';

export interface SessionLike {
  conversationId?: string;
  ownerId?: string;
  ownerName?: string;
  terminated?: boolean;
  startedAt?: number;
  sessionWorkingDir?: string;
  workingDirectory?: string;
  sourceWorkingDirs?: string[];
  links?: { pr?: { url?: string } } | null;
  linkHistory?: { prs?: Array<{ url?: string } | null> } | null;
  codeChanges?: CodeChangesSummary;
}

export interface CodeChangesServiceDeps<S extends SessionLike> {
  getSessionByKey: (key: string) => S | undefined;
  allSessions: () => Iterable<[string, S]>;
  persist: (key: string) => void;
  pushCard: (key: string) => void;
  onResult?: (key: string, session: S, result: CollectResult) => void;
  store?: CodeChangesStore;
  collect?: Partial<CollectDeps>;
  scheduler?: SchedulerOptions;
  logger?: { debug: (msg: string, meta?: Record<string, unknown>) => void };
}

/** How long the dashboard's refresh waits for a run before it answers with what is stored. */
export const REFRESH_WAIT_MS = 20_000;

/** The PR links on a session's card: the current one, then the history, newest first. */
export function sessionPrUrls(session: SessionLike): string[] {
  const urls = [session.links?.pr?.url, ...[...(session.linkHistory?.prs ?? [])].reverse().map((l) => l?.url)];
  return [...new Set(urls.filter((u): u is string => typeof u === 'string' && u.length > 0))];
}

export function createCodeChangesService<S extends SessionLike>(deps: CodeChangesServiceDeps<S>) {
  const store = deps.store ?? getCodeChangesStore();
  const collectDeps: CollectDeps = {
    fetchPullDetail: fetchGitHubPullDetail,
    fetchPullFiles: fetchGitHubPullFiles,
    now: Date.now,
    ...deps.collect,
    store,
  };
  /** The turn's working directory per session key (the last one a trigger named). */
  const turnDirs = new Map<string, string>();

  async function run(key: string): Promise<void> {
    const session = deps.getSessionByKey(key);
    if (!session || session.terminated || !session.conversationId) return;
    const dirs = sessionDirs(session as Record<string, unknown>, turnDirs.get(key));
    if (dirs.length === 0) return;
    const result = await collectCodeChanges(
      {
        conversationId: session.conversationId,
        owner: { id: session.ownerId ?? '', name: session.ownerName ?? '' },
        sessionRoot: session.sessionWorkingDir ?? sessionRootOf(dirs),
        dirs,
        startedAt: sessionStartMs(session),
        prUrls: sessionPrUrls(session),
      },
      collectDeps,
    );
    const live = deps.getSessionByKey(key);
    if (live !== session || live.terminated) return;
    session.codeChanges = result.summary;
    deps.persist(key);
    deps.pushCard(key);
    try {
      deps.onResult?.(key, session, result);
    } catch (error) {
      deps.logger?.debug('code-changes onResult threw', { key, error: (error as Error)?.message });
    }
  }

  const scheduler = createCodeChangesScheduler(run, { logger: deps.logger, ...deps.scheduler });

  return {
    scheduler,
    /** Turn end: snapshot soon (fire-and-forget). */
    snapshot(args: { sessionKey: string; workingDirectory?: string }): void {
      if (!args?.sessionKey) return;
      if (args.workingDirectory) turnDirs.set(args.sessionKey, args.workingDirectory);
      void scheduler.trigger(args.sessionKey);
    },
    /**
     * The dashboard asked for fresh changes of a conversation: run now for its live session (waiting at most
     * REFRESH_WAIT_MS). False when no live session holds the conversation (a closed card shows what is stored).
     */
    async refresh(conversationId: string, waitMs = REFRESH_WAIT_MS): Promise<boolean> {
      for (const [key, s] of deps.allSessions()) {
        if (s.conversationId !== conversationId || s.terminated) continue;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          scheduler.trigger(key, { immediate: true }),
          new Promise<void>((r) => {
            timer = setTimeout(r, waitMs);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
        return true;
      }
      return false;
    },
  };
}

export type CodeChangesService = ReturnType<typeof createCodeChangesService>;
