/**
 * The host side of the code-changes collector (.prd/27 §1): which session a run is for, what it reads from that session,
 * and what it writes back — the summary on the session (persisted), the card pushed, the result handed on (metrics).
 * A run writes only while the key still names the same, not terminated session (a close or a /new can land meanwhile).
 */

import { type GitHubIssueMeta, type IssueTreeNote, prTreeEntries, refreshIssueEntries } from '../issue-tree/relations';
import { fetchGitHubIssueMeta, fetchGitHubPullDetail, fetchGitHubPullFiles } from '../link-metadata-fetcher';
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
  /** The result handed on (metrics). Its new commits are marked counted once it returns without throwing. */
  onResult?: (key: string, session: S, result: CollectResult) => void | Promise<void>;
  store?: CodeChangesStore;
  collect?: Partial<CollectDeps>;
  /**
   * .prd/29 — the session's issue tree: what a collect learned about its PRs (titles, states, the issues they close,
   * stacks) and its GitHub issues (title, state, parent — each read once) goes in.
   */
  issueTree?: {
    note: (key: string, entries: ReadonlyArray<IssueTreeNote>) => boolean;
    /** The GitHub issue URLs the tree has not read yet. */
    toCheck: (key: string) => string[];
  };
  fetchIssue?: (owner: string, repo: string, number: number) => Promise<GitHubIssueMeta | undefined>;
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
  // Commits before this host counted them were the old parser's (CodeChangesStore.countingSince): read once.
  const countingSince = store.countingSince();
  /**
   * The turn's working directory per session key, with the session it belongs to: a `/new` that replaced the session
   * before the run must not hand the old turn's folder to the new conversation (#1299 review).
   */
  const turnDirs = new Map<string, { session: unknown; dir: string }>();

  /** Drops the turn folders of sessions that ended or were replaced: the map lives as long as the daemon. */
  function sweepTurnDirs(): void {
    for (const [key, t] of turnDirs) {
      const live = deps.getSessionByKey(key);
      if (!live || live !== t.session || live.terminated) turnDirs.delete(key);
    }
  }

  async function run(key: string): Promise<void> {
    const session = deps.getSessionByKey(key);
    if (!session || session.terminated || !session.conversationId) {
      turnDirs.delete(key);
      return;
    }
    const turn = turnDirs.get(key);
    const dirs = sessionDirs(
      session as Record<string, unknown>,
      turn && turn.session === session ? turn.dir : undefined,
    );
    if (dirs.length === 0) return;
    const result = await collectCodeChanges(
      {
        conversationId: session.conversationId,
        owner: { id: session.ownerId ?? '', name: session.ownerName ?? '' },
        sessionRoot: session.sessionWorkingDir ?? sessionRootOf(dirs),
        dirs,
        startedAt: sessionStartMs(session),
        commitsSince: countingSince,
        prUrls: sessionPrUrls(session),
      },
      collectDeps,
    );
    const live = deps.getSessionByKey(key);
    if (live !== session || live.terminated) return;
    session.codeChanges = result.summary;
    deps.persist(key);
    if (deps.issueTree) {
      try {
        deps.issueTree.note(key, prTreeEntries(result.doc.prs));
      } catch (error) {
        deps.logger?.debug('issue tree: PR relations not noted', { key, error: (error as Error)?.message });
      }
    }
    deps.pushCard(key);
    void refreshIssues(key, session);
    // Nothing takes the result: nothing is marked — a consumer installed later still gets every commit and merge.
    if (!deps.onResult) return;
    try {
      await deps.onResult(key, session, result);
    } catch (error) {
      // Not marked: the next collect hands these on again (their metric rows are written first-wins).
      deps.logger?.debug('code-changes onResult threw', { key, error: (error as Error)?.message });
      return;
    }
    store.markCounted(result.doc.conversationId, {
      commits: result.newCommits.map((c) => c.sha),
      merges: result.newMerges.map((p) => p.id),
    });
  }

  /** .prd/29 — the tree's GitHub issues not read yet: their titles, states and parents (once each), then the card. */
  async function refreshIssues(key: string, session: S): Promise<void> {
    const tree = deps.issueTree;
    if (!tree) return;
    try {
      const urls = tree.toCheck(key);
      if (urls.length === 0) return;
      const entries = await refreshIssueEntries(urls, deps.fetchIssue ?? fetchGitHubIssueMeta, Date.now());
      const live = deps.getSessionByKey(key);
      if (live !== session || live.terminated || entries.length === 0) return;
      if (tree.note(key, entries)) deps.pushCard(key);
    } catch (error) {
      deps.logger?.debug('issue tree: issues not read', { key, error: (error as Error)?.message });
    }
  }

  const scheduler = createCodeChangesScheduler(run, { logger: deps.logger, ...deps.scheduler });

  return {
    scheduler,
    /** Turn folders held (tests). */
    turnDirCount: () => turnDirs.size,
    /** Turn end: snapshot soon (fire-and-forget). */
    snapshot(args: { sessionKey: string; session?: unknown; workingDirectory?: string }): void {
      if (!args?.sessionKey) return;
      sweepTurnDirs();
      if (args.workingDirectory) {
        turnDirs.set(args.sessionKey, {
          session: args.session ?? deps.getSessionByKey(args.sessionKey),
          dir: args.workingDirectory,
        });
      }
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
