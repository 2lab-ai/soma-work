import { SlackApiHelper } from './slack-api-helper';
import { ActionPanelBuilder, PRStatusInfo } from './action-panel-builder';
import { RequestCoordinator } from './request-coordinator';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';
import { Logger } from '../logger';
import { SlackMessagePayload } from './user-choice-handler';
import { fetchGitHubPRDetails, fetchGitHubPRReviewStatus, isPRMergeable } from '../link-metadata-fetcher';
import { ThreadHeaderBuilder } from './thread-header-builder';

interface ThreadPanelDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  requestCoordinator: RequestCoordinator;
}

export class ThreadPanel {
  private logger = new Logger('ThreadPanel');

  constructor(private deps: ThreadPanelDeps) {}

  async create(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }
    await this.renderPanel(session, sessionKey);
  }

  async setStatus(
    session: ConversationSession,
    sessionKey: string,
    patch: {
      agentPhase?: string;
      activeTool?: string;
      waitingForChoice?: boolean;
    }
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
      await this.renderPanel(session, sessionKey);
    } catch (error) {
      this.logger.debug('Failed to update panel runtime status', {
        sessionKey,
        error: (error as Error).message,
      });
    }

    if (session.threadModel === 'bot-initiated' && session.threadRootTs) {
      await this.renderHeader(session);
    }
  }

  async updateHeader(session: ConversationSession): Promise<void> {
    await this.renderHeader(session);
  }

  async attachChoice(
    sessionKey: string,
    payload: SlackMessagePayload,
    sourceMessageTs?: string
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

    await this.renderPanel(session, sessionKey, true);
  }

  async clearChoice(sessionKey: string): Promise<void> {
    const session = this.deps.claudeHandler.getSessionByKey(sessionKey);
    if (!session?.actionPanel) return;

    if (!session.actionPanel.choiceBlocks || session.actionPanel.choiceBlocks.length === 0) {
      session.actionPanel.waitingForChoice = false;
      await this.renderPanel(session, sessionKey, true);
      return;
    }

    session.actionPanel.choiceBlocks = undefined;
    session.actionPanel.waitingForChoice = false;
    session.actionPanel.choiceMessageTs = undefined;
    session.actionPanel.choiceMessageLink = undefined;

    await this.renderPanel(session, sessionKey, true);
  }

  async updatePanel(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel) {
      await this.create(session, sessionKey);
      return;
    }
    await this.renderPanel(session, sessionKey);
  }

  async close(session: ConversationSession, sessionKey: string): Promise<void> {
    // Update panel to closed state
    if (session.actionPanel) {
      await this.renderPanel(session, sessionKey, true);
    }

    // Update header to closed state
    if (session.threadModel === 'bot-initiated' && session.threadRootTs) {
      await this.renderHeader(session, { closed: true });
    }
  }

  private async renderHeader(
    session: ConversationSession,
    overrides?: { closed?: boolean }
  ): Promise<void> {
    if (!session.threadRootTs) return;

    try {
      const payload = ThreadHeaderBuilder.fromSession(session, overrides);
      await this.deps.slackApi.updateMessage(
        session.channelId,
        session.threadRootTs,
        payload.text,
        payload.blocks,
        payload.attachments
      );
    } catch (error) {
      this.logger.debug('Failed to update thread root', {
        error: (error as Error).message,
      });
    }
  }

  private async renderPanel(
    session: ConversationSession,
    sessionKey: string,
    force: boolean = false
  ): Promise<void> {
    const panelState = session.actionPanel || {};
    const channelId = panelState.channelId || session.channelId;
    const userId = panelState.userId || session.ownerId;

    if (!channelId || !userId) {
      this.logger.debug('Skipping action panel render (missing channel/user)', { sessionKey });
      return;
    }

    const hasActiveRequest = this.deps.requestCoordinator.isRequestActive(sessionKey);
    const disabled = this.computeDisabled(session, hasActiveRequest);
    const contextRemainingPercent = this.getContextRemainingPercent(session);
    const choiceMessageLink = await this.ensureChoiceMessageLink(panelState, channelId);

    // Fetch PR status if a GitHub PR link is attached
    const prStatusInfo = await this.fetchPRStatus(session);

    const payload = ActionPanelBuilder.build({
      sessionKey,
      workflow: session.workflow,
      disabled,
      choiceBlocks: panelState.choiceBlocks,
      waitingForChoice: panelState.waitingForChoice,
      choiceMessageLink,
      latestResponseLink: panelState.latestResponseLink,
      turnSummary: panelState.turnSummary,
      activityState: session.activityState,
      contextRemainingPercent,
      hasActiveRequest,
      agentPhase: panelState.agentPhase,
      activeTool: panelState.activeTool,
      statusUpdatedAt: panelState.statusUpdatedAt,
      logVerbosity: session.logVerbosity,
      prStatus: prStatusInfo?.prStatus,
      prUrl: prStatusInfo?.prUrl,
    });

    const renderKey = JSON.stringify(payload.blocks || []);
    if (!force && panelState.renderKey === renderKey) {
      return;
    }

    let rendered = false;

    if (panelState.messageTs) {
      try {
        await this.deps.slackApi.updateMessage(
          channelId,
          panelState.messageTs,
          payload.text,
          payload.blocks,
          undefined,
          {
            unfurlLinks: false,
            unfurlMedia: false,
          }
        );
        rendered = true;
      } catch (error) {
        this.logger.warn('Failed to update action panel', { sessionKey, error });
        panelState.messageTs = undefined;
      }
    }

    if (!panelState.messageTs) {
      try {
        const result = await this.deps.slackApi.postMessage(
          channelId,
          payload.text,
          {
            blocks: payload.blocks,
            unfurlLinks: false,
            unfurlMedia: false,
          }
        );
        panelState.messageTs = result?.ts;
        rendered = true;
      } catch (error) {
        this.logger.warn('Failed to post action panel', { sessionKey, error });
      }
    }

    if (!rendered) {
      return;
    }

    panelState.renderKey = renderKey;
    panelState.disabled = disabled;
    panelState.channelId = channelId;
    panelState.userId = userId;
    panelState.lastRenderedAt = Date.now();
    session.actionPanel = panelState;
  }

  private computeDisabled(session: ConversationSession, hasActiveRequest: boolean): boolean {
    const isBusy = session.activityState === 'working' || session.activityState === 'waiting';
    const waitingForChoice = session.actionPanel?.waitingForChoice;
    return Boolean(isBusy || waitingForChoice || hasActiveRequest);
  }

  private getContextRemainingPercent(session: ConversationSession): number | undefined {
    const usage = session.usage;
    if (!usage || usage.contextWindow <= 0) {
      return undefined;
    }

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

  private async fetchPRStatus(
    session: ConversationSession
  ): Promise<{ prStatus: PRStatusInfo; prUrl: string } | undefined> {
    const prLink = session.links?.pr;
    if (!prLink || prLink.provider !== 'github') return undefined;

    try {
      const [details, reviewStatus] = await Promise.all([
        fetchGitHubPRDetails(prLink),
        fetchGitHubPRReviewStatus(prLink),
      ]);
      if (!details) return undefined;

      const prStatus: PRStatusInfo = {
        state: details.merged ? 'merged' : details.state,
        mergeable: isPRMergeable(details),
        draft: details.draft,
        merged: details.merged,
        approved: reviewStatus === 'approved',
        head: details.head,
        base: details.base,
      };

      // Cache in session state for use by action handlers
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

      return { prStatus, prUrl: prLink.url };
    } catch (error) {
      this.logger.debug('Failed to fetch PR status for action panel', { error });
      return undefined;
    }
  }

  private async ensureChoiceMessageLink(
    panelState: NonNullable<ConversationSession['actionPanel']>,
    channelId: string
  ): Promise<string | undefined> {
    if (!panelState.waitingForChoice) {
      return undefined;
    }

    if (panelState.choiceMessageLink) {
      return panelState.choiceMessageLink;
    }

    if (!panelState.choiceMessageTs) {
      return undefined;
    }

    const permalink = await this.deps.slackApi.getPermalink(channelId, panelState.choiceMessageTs);
    if (permalink) {
      panelState.choiceMessageLink = permalink;
      return permalink;
    }

    return undefined;
  }
}
