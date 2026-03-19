import { SlackApiHelper } from './slack-api-helper';
import { ActionPanelBuilder, PRStatusInfo } from './action-panel-builder';
import { ThreadHeaderBuilder } from './thread-header-builder';
import { RequestCoordinator } from './request-coordinator';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';
import { Logger } from '../logger';
import { SlackMessagePayload } from './user-choice-handler';
import { fetchGitHubPRDetails, fetchGitHubPRReviewStatus, isPRMergeable } from '../link-metadata-fetcher';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThreadSurfaceDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  requestCoordinator: RequestCoordinator;
}

interface PRCacheEntry {
  prStatus: PRStatusInfo;
  prUrl: string;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval between consecutive Slack chat.update calls (ms). */
const RENDER_DEBOUNCE_MS = 500;

/** PR status cache TTL (ms). */
const PR_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// ThreadSurface
// ---------------------------------------------------------------------------

/**
 * **Single-writer** surface for the combined thread header + action panel.
 *
 * Owns exactly one Slack message per session and is the *only* code path
 * that calls `chat.update` on that message.
 *
 * Layout (blocks):
 *   Header section  — owner, title, workflow, links
 *   Status section  — badge, agent chip, PR chip, context %
 *   Metrics context — time, tools, link, verbosity
 *   Choice slot     — (optional, when waiting for user input)
 *   Action buttons  — workflow actions + close
 */
export class ThreadSurface {
  private logger = new Logger('ThreadSurface');

  // Debounce / coalescing state
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private inflightPromise: Promise<void> | null = null;
  private pendingSession: ConversationSession | null = null;
  private pendingForce = false;

  // PR status cache (per-surface instance ≈ per-session)
  private prCache: PRCacheEntry | null = null;

  constructor(private deps: ThreadSurfaceDeps) {}

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Ensure the surface message exists for the given session.
   * - bot-initiated: uses threadRootTs (already posted by session-initializer)
   * - user-initiated: creates a new message in the thread if needed
   */
  async initialize(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }

    if (session.threadModel === 'bot-initiated' && session.threadRootTs) {
      // For bot-initiated: the root message IS the surface
      if (!session.actionPanel.messageTs) {
        session.actionPanel.messageTs = session.threadRootTs;
      }
    }

    // Render initial state (force to ensure message is created)
    await this.doRender(session, sessionKey, true);
  }

  /**
   * Request a (debounced) re-render of the surface.
   * Multiple rapid calls coalesce into a single chat.update.
   */
  async requestRender(
    session: ConversationSession,
    sessionKey: string,
    force = false,
  ): Promise<void> {
    this.scheduleRender(session, sessionKey, force);
  }

  /**
   * Update session status and request render.
   * Replaces ThreadPanel.setStatus().
   */
  async setStatus(
    session: ConversationSession,
    sessionKey: string,
    patch: {
      agentPhase?: string;
      activeTool?: string;
      waitingForChoice?: boolean;
    },
  ): Promise<void> {
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }

    session.actionPanel.agentPhase = patch.agentPhase;
    session.actionPanel.activeTool = patch.activeTool;
    if (typeof patch.waitingForChoice === 'boolean') {
      session.actionPanel.waitingForChoice = patch.waitingForChoice;
    }
    session.actionPanel.statusUpdatedAt = Date.now();

    try {
      await this.requestRender(session, sessionKey);
    } catch (error) {
      this.logger.debug('Failed to update surface status', {
        sessionKey,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Attach user choice blocks and force-render.
   */
  async attachChoice(
    sessionKey: string,
    payload: SlackMessagePayload,
    sourceMessageTs?: string,
  ): Promise<void> {
    const session = this.deps.claudeHandler.getSessionByKey(sessionKey);
    if (!session) return;

    const choiceBlocks = this.extractChoiceBlocks(payload);
    if (choiceBlocks.length === 0) return;

    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }

    session.actionPanel.choiceBlocks = choiceBlocks;
    session.actionPanel.waitingForChoice = true;
    session.actionPanel.choiceMessageLink = undefined;
    if (sourceMessageTs) {
      session.actionPanel.choiceMessageTs = sourceMessageTs;
    }

    await this.doRender(session, sessionKey, true);
  }

  /**
   * Clear pending choice and force-render.
   */
  async clearChoice(sessionKey: string): Promise<void> {
    const session = this.deps.claudeHandler.getSessionByKey(sessionKey);
    if (!session?.actionPanel) return;

    session.actionPanel.choiceBlocks = undefined;
    session.actionPanel.waitingForChoice = false;
    session.actionPanel.choiceMessageTs = undefined;
    session.actionPanel.choiceMessageLink = undefined;

    await this.doRender(session, sessionKey, true);
  }

  /**
   * Generic re-render (e.g. after usage update).
   */
  async updatePanel(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel) {
      await this.initialize(session, sessionKey);
      return;
    }
    await this.requestRender(session, sessionKey);
  }

  /**
   * Render the final "closed" state.
   */
  async close(session: ConversationSession, sessionKey: string): Promise<void> {
    if (session.actionPanel) {
      await this.doRender(session, sessionKey, true, { closed: true });
    }
  }

  /**
   * Refresh the PR status cache (call from outside render path).
   */
  async refreshPRStatus(session: ConversationSession): Promise<void> {
    const entry = await this.fetchPRStatusEntry(session);
    if (entry) {
      this.prCache = entry;
    }
  }

  // =========================================================================
  // Debounce & Coalescing
  // =========================================================================

  private scheduleRender(
    session: ConversationSession,
    sessionKey: string,
    force: boolean,
  ): void {
    // Always keep latest state
    this.pendingSession = session;
    this.pendingForce = this.pendingForce || force;

    if (force) {
      // Force: cancel pending timer and execute immediately
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      this.flushRender(sessionKey);
      return;
    }

    // Debounced: reset timer
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.flushRender(sessionKey);
    }, RENDER_DEBOUNCE_MS);
  }

  private flushRender(sessionKey: string): void {
    const session = this.pendingSession;
    const force = this.pendingForce;
    this.pendingSession = null;
    this.pendingForce = false;

    if (!session) return;

    if (this.inflightPromise) {
      // Another render in flight — re-queue so latest state wins
      this.pendingSession = session;
      this.pendingForce = force;
      return;
    }

    this.inflightPromise = this.doRender(session, sessionKey, force)
      .catch((err) =>
        this.logger.debug('Surface render error', { sessionKey, error: (err as Error).message }),
      )
      .finally(() => {
        this.inflightPromise = null;
        // If state accumulated while we were rendering, flush again
        if (this.pendingSession) {
          this.flushRender(sessionKey);
        }
      });
  }

  // =========================================================================
  // Core Render
  // =========================================================================

  private async doRender(
    session: ConversationSession,
    sessionKey: string,
    force: boolean,
    overrides?: { closed?: boolean },
  ): Promise<void> {
    const panelState = session.actionPanel || {};
    const channelId = panelState.channelId || session.channelId;

    if (!channelId) {
      this.logger.debug('Skipping surface render (no channel)', { sessionKey });
      return;
    }

    // Build combined blocks
    const blocks = this.buildCombinedBlocks(session, sessionKey, overrides);
    const text = this.buildFallbackText(session, overrides);
    const renderKey = JSON.stringify(blocks);

    // Skip if nothing changed (unless forced)
    if (!force && panelState.renderKey === renderKey) {
      return;
    }

    let rendered = false;

    // Try to update existing message
    if (panelState.messageTs) {
      try {
        await this.deps.slackApi.updateMessage(
          channelId,
          panelState.messageTs,
          text,
          blocks,
          undefined,
          { unfurlLinks: false, unfurlMedia: false },
        );
        rendered = true;
      } catch (error) {
        this.logger.warn('Failed to update surface message', { sessionKey, error });
        // If this was the thread root (bot-initiated), don't try to create a new one
        if (session.threadModel === 'bot-initiated' && panelState.messageTs === session.threadRootTs) {
          return;
        }
        panelState.messageTs = undefined;
      }
    }

    // Create new message if needed (user-initiated only)
    if (!panelState.messageTs) {
      try {
        const threadTs = session.threadRootTs || session.threadTs;
        const result = await this.deps.slackApi.postMessage(channelId, text, {
          blocks,
          threadTs,
          unfurlLinks: false,
          unfurlMedia: false,
        });
        panelState.messageTs = result?.ts;
        rendered = true;
      } catch (error) {
        this.logger.warn('Failed to post surface message', { sessionKey, error });
      }
    }

    if (!rendered) return;

    // Update bookkeeping
    panelState.renderKey = renderKey;
    panelState.lastRenderedAt = Date.now();
    panelState.channelId = channelId;
    panelState.userId = panelState.userId || session.ownerId;
    session.actionPanel = panelState;
  }

  // =========================================================================
  // Block Assembly
  // =========================================================================

  /**
   * Build the combined header + panel blocks.
   */
  private buildCombinedBlocks(
    session: ConversationSession,
    sessionKey: string,
    overrides?: { closed?: boolean },
  ): any[] {
    const isClosed = overrides?.closed || !session.isActive;
    const hasActiveRequest = this.deps.requestCoordinator.isRequestActive(sessionKey);
    const panelState = session.actionPanel || {};
    const choiceMessageLink = panelState.choiceMessageLink;

    // Read PR status from cache (never fetch in render path)
    const prStatusInfo = this.prCache;

    if (isClosed) {
      return this.buildClosedBlocks(session, sessionKey, prStatusInfo);
    }

    const blocks: any[] = [];

    // ── 1. Header section ──
    blocks.push(...this.buildHeaderBlocks(session));

    // ── 2. Status + fields section (from ActionPanelBuilder) ──
    const panelPayload = ActionPanelBuilder.build({
      sessionKey,
      workflow: session.workflow,
      disabled: this.computeDisabled(session, hasActiveRequest),
      choiceBlocks: panelState.choiceBlocks,
      waitingForChoice: panelState.waitingForChoice,
      choiceMessageLink,
      latestResponseLink: panelState.latestResponseLink,
      turnSummary: panelState.turnSummary,
      activityState: session.activityState,
      contextRemainingPercent: this.getContextRemainingPercent(session),
      hasActiveRequest,
      agentPhase: panelState.agentPhase,
      activeTool: panelState.activeTool,
      statusUpdatedAt: panelState.statusUpdatedAt,
      logVerbosity: session.logVerbosity,
      prStatus: prStatusInfo?.prStatus,
      prUrl: prStatusInfo?.prUrl,
    });

    // ActionPanelBuilder.build() returns full blocks — use them after header
    blocks.push(...panelPayload.blocks);

    return blocks;
  }

  /**
   * Header blocks: title + context row.
   */
  private buildHeaderBlocks(session: ConversationSession): any[] {
    const payload = ThreadHeaderBuilder.fromSession(session);
    return payload.blocks || [];
  }

  /**
   * Closed state: header + closed panel.
   */
  private buildClosedBlocks(
    session: ConversationSession,
    sessionKey: string,
    prStatusInfo: PRCacheEntry | null,
  ): any[] {
    const blocks: any[] = [];

    // Header with closed flag
    const headerPayload = ThreadHeaderBuilder.fromSession(session, { closed: true });
    blocks.push(...(headerPayload.blocks || []));

    // Closed panel
    const panelPayload = ActionPanelBuilder.build({
      sessionKey,
      workflow: session.workflow,
      closed: true,
      turnSummary: session.actionPanel?.turnSummary,
      contextRemainingPercent: this.getContextRemainingPercent(session),
      latestResponseLink: session.actionPanel?.latestResponseLink,
      prStatus: prStatusInfo?.prStatus,
      prUrl: prStatusInfo?.prUrl,
    });
    blocks.push(...panelPayload.blocks);

    return blocks;
  }

  private buildFallbackText(
    session: ConversationSession,
    overrides?: { closed?: boolean },
  ): string {
    const title = session.title || 'Session';
    const owner = session.ownerName || session.ownerId || '';
    const closed = overrides?.closed ? ' [종료됨]' : '';
    return `${owner} — ${title}${closed}`;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private computeDisabled(session: ConversationSession, hasActiveRequest: boolean): boolean {
    const isBusy = session.activityState === 'working' || session.activityState === 'waiting';
    const waitingForChoice = session.actionPanel?.waitingForChoice;
    return Boolean(isBusy || waitingForChoice || hasActiveRequest);
  }

  private getContextRemainingPercent(session: ConversationSession): number | undefined {
    const usage = session.usage;
    if (!usage || usage.contextWindow <= 0) return undefined;
    const usedTokens = usage.currentInputTokens + usage.currentOutputTokens;
    const remainingPercent = ((usage.contextWindow - usedTokens) / usage.contextWindow) * 100;
    return Math.max(0, Math.min(100, Number(remainingPercent.toFixed(1))));
  }

  private extractChoiceBlocks(payload: SlackMessagePayload): any[] {
    if (payload.attachments?.[0]?.blocks) {
      return payload.attachments[0].blocks as any[];
    }
    if (payload.blocks) return payload.blocks;
    return [];
  }

  // =========================================================================
  // PR Status (out-of-render-path)
  // =========================================================================

  private async fetchPRStatusEntry(
    session: ConversationSession,
  ): Promise<PRCacheEntry | null> {
    const prLink = session.links?.pr;
    if (!prLink || prLink.provider !== 'github') return null;

    // Use cache if fresh
    if (this.prCache && Date.now() - this.prCache.fetchedAt < PR_CACHE_TTL_MS) {
      return this.prCache;
    }

    try {
      const [details, reviewStatus] = await Promise.all([
        fetchGitHubPRDetails(prLink),
        fetchGitHubPRReviewStatus(prLink),
      ]);
      if (!details) return null;

      const prStatus: PRStatusInfo = {
        state: details.merged ? 'merged' : details.state,
        mergeable: isPRMergeable(details),
        draft: details.draft,
        merged: details.merged,
        approved: reviewStatus === 'approved',
        head: details.head,
        base: details.base,
      };

      // Also cache in session for action handlers
      if (session.actionPanel) {
        session.actionPanel.prStatus = {
          state: prStatus.state,
          mergeable: prStatus.mergeable,
          draft: prStatus.draft,
          merged: prStatus.merged,
          approved: prStatus.approved,
          head: prStatus.head,
          base: prStatus.base,
        };
      }

      return { prStatus, prUrl: prLink.url, fetchedAt: Date.now() };
    } catch (error) {
      this.logger.debug('Failed to fetch PR status', { error });
      return null;
    }
  }

  /**
   * Ensure PR cache is populated, then request render.
   * Call this after link changes or on action button click.
   */
  async refreshAndRender(session: ConversationSession, sessionKey: string): Promise<void> {
    await this.refreshPRStatus(session);
    await this.requestRender(session, sessionKey, true);
  }
}