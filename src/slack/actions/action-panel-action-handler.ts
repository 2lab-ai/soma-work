import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import type { ConversationSession } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import { ActionPanelBuilder } from '../action-panel-builder';
import { ContextWindowManager } from '../context-window-manager';
import type { RequestCoordinator } from '../request-coordinator';
import type { SlackApiHelper } from '../slack-api-helper';
import { postSourceThreadSummary } from '../source-thread-summary';
import { ThreadHeaderBuilder } from '../thread-header-builder';
import type { ThreadPanel } from '../thread-panel';
import type { RespondFn } from './types';

interface PanelActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  requestCoordinator?: RequestCoordinator;
  threadPanel?: ThreadPanel;
}

/**
 * The surface carries one control: `세션 종료`. The workflow buttons (New Fix /
 * Renew Fix / PR 문서화 / New·Renew 리뷰 / PR 승인 / Merge) and `⏸ 중지` were
 * removed on 2026-10-27 ("세션 종료 버튼을 제외하고 모두 삭제"). A running turn
 * is still stopped from the thread (`!`) or the dashboard. A message rendered
 * before the removal still carries the old buttons until its next re-render;
 * such a click lands on the "unsupported" reply below.
 */
interface PanelActionValue {
  sessionKey?: string;
  action?: string;
}

export class ActionPanelActionHandler {
  private logger = new Logger('ActionPanelActionHandler');

  constructor(private ctx: PanelActionContext) {}

  async handleAction(body: any, respond: RespondFn): Promise<void> {
    try {
      const action = body.actions?.[0];
      const rawValue = action?.value || '{}';
      const value: PanelActionValue = JSON.parse(rawValue);
      const userId = body.user?.id;

      if (!value.sessionKey || !value.action || !userId) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 액션 정보를 확인할 수 없습니다.',
          replace_original: false,
        });
        return;
      }

      const session = this.ctx.claudeHandler.getSessionByKey(value.sessionKey);
      if (!session) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션을 찾을 수 없습니다. 이미 종료되었을 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      if (session.ownerId !== userId) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 소유자만 이 작업을 수행할 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      // Close action: terminate the session
      if (value.action === 'close') {
        await this.handleClose(value.sessionKey!, session, respond);
        return;
      }

      // Anything else is a removed button (a workflow button or ⏸ 중지) on a
      // message rendered before the 2026-10-27 removal, or a forged value.
      // Nothing to run.
      await respond({
        response_type: 'ephemeral',
        text: '❌ 지원하지 않는 액션입니다.',
        replace_original: false,
      });
    } catch (error) {
      this.logger.error('Error handling action panel action', error);
      try {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 액션 처리 중 오류가 발생했습니다.',
          replace_original: false,
        });
      } catch {}
    }
  }

  private async handleClose(sessionKey: string, session: ConversationSession, respond: RespondFn): Promise<void> {
    // Mark session as inactive BEFORE abort/render to prevent race conditions.
    // Stream executor abort handlers may re-render the surface; isActive=false
    // ensures buildCombinedBlocks treats it as closed even without the override.
    session.isActive = false;

    // Abort active AI request BEFORE rendering closed state. Tag as
    // `session-close` so the notification gate stays quiet — closing the
    // session is itself a terminal UI action.
    this.ctx.requestCoordinator?.abortSession(sessionKey, 'session-close');

    // Update surface to closed state BEFORE terminating (session is deleted on terminate).
    // Delegate to ThreadPanel (single-writer) which renders combined header + panel blocks.
    if (this.ctx.threadPanel) {
      try {
        await this.ctx.threadPanel.close(session, sessionKey);
      } catch (error) {
        // Fall back to direct update below
        this.updateSurfaceDirect(session, sessionKey);
      }
    } else {
      await this.updateSurfaceDirect(session, sessionKey);
    }

    // Fire-and-forget: post source thread summary
    postSourceThreadSummary(this.ctx.slackApi, session, 'closed').catch(() => {});

    const success = this.ctx.claudeHandler.terminateSession(sessionKey);
    if (success) {
      await respond({
        response_type: 'ephemeral',
        text: '🔒 세션이 종료되었습니다.',
        replace_original: false,
      });
    } else {
      await respond({
        response_type: 'ephemeral',
        text: '❌ 세션 종료에 실패했습니다.',
        replace_original: false,
      });
    }
  }

  /**
   * Fallback: update surface message directly with combined header + panel blocks.
   * Used when threadPanel is not available.
   */
  private async updateSurfaceDirect(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel?.messageTs) return;
    try {
      const theme = userSettingsStore.getUserSessionTheme(session.ownerId);
      // Same composition and the same live-PR rule as ThreadSurface (T2).
      const livePr = ActionPanelBuilder.livePrStatus(session.links?.pr, session.actionPanel.prStatus);
      const headerPayload = ThreadHeaderBuilder.fromSession(session, {
        closed: true,
        theme,
        sessionKey,
        suppressSessionStatus: true,
        liveLinkStatus: ThreadHeaderBuilder.livePrLinkStatus(livePr?.fetchedForUrl, livePr),
      });
      const panelPayload = ActionPanelBuilder.build({
        sessionKey,
        workflow: session.workflow,
        closed: true,
        contextRemainingPercent: this.getContextRemainingPercent(session),
        prStatus: livePr ? { ...livePr } : undefined,
        turnSummary: session.actionPanel.turnSummary,
        latestResponseLink: session.actionPanel.latestResponseLink,
      });
      const combinedBlocks = ActionPanelBuilder.compose(headerPayload.blocks || [], panelPayload.blocks);
      await this.ctx.slackApi.updateMessage(
        session.channelId,
        session.actionPanel.messageTs,
        panelPayload.text,
        combinedBlocks,
      );
    } catch (error) {
      // Non-blocking: surface update failure shouldn't prevent termination
    }
  }

  private getContextRemainingPercent(session: ConversationSession): number | undefined {
    const usage = session.usage;
    if (!usage || usage.contextWindow <= 0) return undefined;
    return Number(ContextWindowManager.computeRemainingPercent(usage).toFixed(1));
  }
}
