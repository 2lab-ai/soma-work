import { SlackApiHelper } from './slack-api-helper';
import { ActionPanelBuilder } from './action-panel-builder';
import { RequestCoordinator } from './request-coordinator';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';
import { Logger } from '../logger';
import { SlackMessagePayload } from './user-choice-handler';

interface ActionPanelManagerDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  requestCoordinator: RequestCoordinator;
}

export class ActionPanelManager {
  private logger = new Logger('ActionPanelManager');

  constructor(private deps: ActionPanelManagerDeps) {}

  async ensurePanel(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }
    await this.renderPanel(session, sessionKey);
  }

  async updatePanel(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel) {
      await this.ensurePanel(session, sessionKey);
      return;
    }
    await this.renderPanel(session, sessionKey);
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
    const contextUsagePercent = this.getContextUsagePercent(session);
    const choiceMessageLink = await this.ensureChoiceMessageLink(panelState, channelId);

    const payload = ActionPanelBuilder.build({
      sessionKey,
      workflow: session.workflow,
      disabled,
      choiceBlocks: panelState.choiceBlocks,
      waitingForChoice: panelState.waitingForChoice,
      choiceMessageLink,
      activityState: session.activityState,
      contextUsagePercent,
      hasActiveRequest,
      agentPhase: panelState.agentPhase,
      activeTool: panelState.activeTool,
      statusUpdatedAt: panelState.statusUpdatedAt,
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
          payload.blocks
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
          { blocks: payload.blocks }
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

  private getContextUsagePercent(session: ConversationSession): number | undefined {
    const usage = session.usage;
    if (!usage || usage.contextWindow <= 0) {
      return undefined;
    }

    const used = usage.currentInputTokens
      + usage.currentCacheReadTokens
      + usage.currentCacheCreateTokens;
    const percent = Math.round((used / usage.contextWindow) * 100);
    return Math.max(0, Math.min(100, percent));
  }

  private extractChoiceBlocks(payload: SlackMessagePayload): any[] {
    if (payload.attachments?.[0]?.blocks) {
      return payload.attachments[0].blocks as any[];
    }
    if (payload.blocks) return payload.blocks;
    return [];
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
