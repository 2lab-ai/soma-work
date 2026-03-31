import { getChannelConfluenceUrl } from '../../channel-registry';
import type { ClaudeHandler } from '../../claude-handler';
import { mergeGitHubPR } from '../../link-metadata-fetcher';
import { Logger } from '../../logger';
import type { ConversationSession } from '../../types';
import { ActionPanelBuilder } from '../action-panel-builder';
import { ContextWindowManager } from '../context-window-manager';
import type { RequestCoordinator } from '../request-coordinator';
import type { SlackApiHelper } from '../slack-api-helper';
import { postSourceThreadSummary } from '../source-thread-summary';
import type { MessageHandler, RespondFn, SayFn } from './types';

interface PanelActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
  requestCoordinator?: RequestCoordinator;
}

type PanelAction =
  | 'issue_research'
  | 'pr_create'
  | 'pr_review'
  | 'pr_docs'
  | 'pr_fix'
  | 'pr_fix_new'
  | 'pr_fix_renew'
  | 'pr_review_new'
  | 'pr_review_renew'
  | 'pr_approve'
  | 'pr_merge'
  | 'close'
  | 'focus_choice'
  | 'stop';

/** Actions that map to a resource link (issue or PR) and drive a prompt */
type ResourceAction = Exclude<PanelAction, 'focus_choice' | 'stop' | 'pr_merge' | 'close'>;

interface PanelActionValue {
  sessionKey?: string;
  action?: PanelAction;
  prUrl?: string;
  headBranch?: string;
  baseBranch?: string;
}

interface ActionConfig {
  requires: 'issue' | 'pr';
  buildText: (url: string) => string;
  ackText: (label: string) => string;
}

const ACTION_CONFIG: Record<ResourceAction, ActionConfig> = {
  issue_research: {
    requires: 'issue',
    buildText: (url) => `이 이슈를 리서치해줘: ${url}`,
    ackText: (label) => `🔀 ${label} 리서치 요청을 전달합니다...`,
  },
  pr_create: {
    requires: 'issue',
    buildText: (url) => `이 이슈로 PR 생성해줘: ${url}`,
    ackText: (label) => `🔀 ${label} 기반 PR 생성 요청을 전달합니다...`,
  },
  pr_review: {
    requires: 'pr',
    buildText: (url) => `PR 리뷰해줘: ${url}`,
    ackText: (label) => `🔀 ${label} 리뷰 요청을 전달합니다...`,
  },
  pr_docs: {
    requires: 'pr',
    buildText: (url) => `PR 문서화 해줘: ${url}`,
    ackText: (label) => `🔀 ${label} 문서화 요청을 전달합니다...`,
  },
  pr_fix: {
    requires: 'pr',
    buildText: (url) => `new fix ${url}`,
    ackText: (label) => `🔀 ${label} 수정 요청을 전달합니다...`,
  },
  pr_approve: {
    requires: 'pr',
    buildText: (url) => `PR 승인해줘: ${url}`,
    ackText: (label) => `🔀 ${label} 승인 요청을 전달합니다...`,
  },
  pr_fix_new: {
    requires: 'pr',
    buildText: (url) => `new fix ${url}`,
    ackText: () => '🆕 컨텍스트 초기화 후 수정 시작...',
  },
  pr_fix_renew: {
    requires: 'pr',
    buildText: (url) => `renew fix ${url}`,
    ackText: () => '♻️ 컨텍스트 유지하며 수정 시작...',
  },
  pr_review_new: {
    requires: 'pr',
    buildText: (url) => `new ${url}`,
    ackText: () => '🆕 컨텍스트 초기화 후 리뷰 시작...',
  },
  pr_review_renew: {
    requires: 'pr',
    buildText: (url) => `renew ${url}`,
    ackText: () => '♻️ 컨텍스트 유지하며 리뷰 시작...',
  },
};

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

      // Stop action: abort the active request
      if (value.action === 'stop') {
        await this.handleStop(value.sessionKey!, session, respond);
        return;
      }

      // Close action: terminate the session
      if (value.action === 'close') {
        await this.handleClose(value.sessionKey!, session, respond);
        return;
      }

      // Merge action: direct GitHub API call (no model invocation)
      if (value.action === 'pr_merge') {
        if (session.workflow === 'pr-review' || session.workflow === 'pr-fix-and-update') {
          await respond({
            response_type: 'ephemeral',
            text: '❌ 이 워크플로우에서는 direct merge를 지원하지 않습니다. merge gate 질문에서만 머지할 수 있습니다.',
            replace_original: false,
          });
          return;
        }
        await this.handleMerge(
          value as PanelActionValue & { prUrl?: string; headBranch?: string; baseBranch?: string },
          session,
          respond,
        );
        return;
      }

      const isFocusChoiceAction = value.action === 'focus_choice';
      if (
        !isFocusChoiceAction &&
        (session.activityState === 'working' ||
          session.activityState === 'waiting' ||
          session.actionPanel?.waitingForChoice)
      ) {
        await respond({
          response_type: 'ephemeral',
          text: '⏸️ 현재 세션이 처리 중이거나 입력 대기 상태입니다. 잠시 후 다시 시도해 주세요.',
          replace_original: false,
        });
        return;
      }

      if (isFocusChoiceAction) {
        await this.handleFocusChoice(session, respond);
        return;
      }

      const config = ACTION_CONFIG[value.action as ResourceAction];
      if (!config) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 지원하지 않는 액션입니다.',
          replace_original: false,
        });
        return;
      }
      const links = session.links;
      const requiredLink = config.requires === 'issue' ? links?.issue : links?.pr;
      const requiredUrl = requiredLink?.url;

      if (!requiredUrl) {
        const label = config.requires === 'issue' ? '이슈' : 'PR';
        await respond({
          response_type: 'ephemeral',
          text: `❌ ${label} 링크가 없습니다.`,
          replace_original: false,
        });
        return;
      }

      const threadTs = session.threadRootTs || session.threadTs;
      if (!threadTs) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 스레드를 찾을 수 없습니다.',
          replace_original: false,
        });
        return;
      }

      const label = requiredLink?.label || (config.requires === 'issue' ? '이슈' : 'PR');
      await respond({
        response_type: 'ephemeral',
        text: config.ackText(label),
        replace_original: false,
      });

      // pr_docs: auto-inject confluence URL if available
      let injectedText: string;
      if (value.action === 'pr_docs') {
        const confluenceUrl = getChannelConfluenceUrl(session.channelId);
        injectedText = confluenceUrl ? `new ${confluenceUrl} ${requiredUrl}` : config.buildText(requiredUrl);
      } else {
        injectedText = config.buildText(requiredUrl);
      }
      this.ctx.claudeHandler.setActivityStateByKey(value.sessionKey, 'working');
      const say = this.createSayFn(session.channelId);
      await this.ctx.messageHandler(
        { user: userId, channel: session.channelId, thread_ts: threadTs, ts: '', text: injectedText },
        say,
      );
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

  private async handleMerge(
    value: PanelActionValue & { prUrl?: string; headBranch?: string; baseBranch?: string },
    session: ConversationSession,
    respond: RespondFn,
  ): Promise<void> {
    const { prUrl, headBranch, baseBranch } = value;
    if (!prUrl) {
      await respond({ response_type: 'ephemeral', text: '❌ PR URL을 찾을 수 없습니다.', replace_original: false });
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: '🔀 PR 머지를 진행합니다...',
      replace_original: false,
    });

    const result = await mergeGitHubPR(prUrl);

    if (result.success) {
      const threadTs = session.threadRootTs || session.threadTs;
      if (threadTs) {
        const branchInfo = headBranch && baseBranch ? `\`${headBranch}\` → \`${baseBranch}\`` : '';
        await this.ctx.slackApi.postMessage(
          session.channelId,
          `🔀 PR merged (squash)${branchInfo ? `: ${branchInfo}` : ''}`,
          { threadTs },
        );
      }

      // Update PR status in session to reflect merged state
      if (session.actionPanel) {
        session.actionPanel.prStatus = {
          state: 'merged',
          mergeable: false,
          draft: false,
          merged: true,
          head: headBranch,
          base: baseBranch,
        };
      }

      // Fire-and-forget: do not block the merge response path
      postSourceThreadSummary(this.ctx.slackApi, session, 'merged').catch((err) =>
        this.logger.error('Unexpected escape from postSourceThreadSummary', err),
      );
    } else {
      await respond({
        response_type: 'ephemeral',
        text: `❌ ${result.message}`,
        replace_original: false,
      });
    }
  }

  private async handleStop(sessionKey: string, session: ConversationSession, respond: RespondFn): Promise<void> {
    if (!this.ctx.requestCoordinator) {
      await respond({
        response_type: 'ephemeral',
        text: '❌ 중지 기능을 사용할 수 없습니다.',
        replace_original: false,
      });
      return;
    }

    const aborted = this.ctx.requestCoordinator.abortSession(sessionKey);
    if (aborted) {
      await respond({
        response_type: 'ephemeral',
        text: '🛑 요청을 중지했습니다.',
        replace_original: false,
      });
    } else {
      await respond({
        response_type: 'ephemeral',
        text: 'ℹ️ 현재 처리 중인 요청이 없습니다.',
        replace_original: false,
      });
    }
  }

  private async handleClose(sessionKey: string, session: ConversationSession, respond: RespondFn): Promise<void> {
    // Update action panel to closed state BEFORE terminating (session is deleted on terminate)
    if (session.actionPanel?.messageTs) {
      try {
        const panelPayload = ActionPanelBuilder.build({
          sessionKey,
          workflow: session.workflow,
          closed: true,
          contextRemainingPercent: this.getContextRemainingPercent(session),
          prStatus: session.actionPanel.prStatus ? { ...session.actionPanel.prStatus } : undefined,
          turnSummary: session.actionPanel.turnSummary,
          latestResponseLink: session.actionPanel.latestResponseLink,
        });
        await this.ctx.slackApi.updateMessage(
          session.channelId,
          session.actionPanel.messageTs,
          panelPayload.text,
          panelPayload.blocks,
        );
      } catch (error) {
        // Non-blocking: panel update failure shouldn't prevent termination
      }
    }

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

  private getContextRemainingPercent(session: ConversationSession): number | undefined {
    const usage = session.usage;
    if (!usage || usage.contextWindow <= 0) return undefined;
    return Number(ContextWindowManager.computeRemainingPercent(usage).toFixed(1));
  }

  private async handleFocusChoice(session: ConversationSession, respond: RespondFn): Promise<void> {
    if (!session?.actionPanel?.waitingForChoice) {
      await respond({
        response_type: 'ephemeral',
        text: 'ℹ️ 현재 대기 중인 질문이 없습니다.',
        replace_original: false,
      });
      return;
    }

    const choiceMessageTs = session.actionPanel.choiceMessageTs;
    const link = choiceMessageTs ? await this.ctx.slackApi.getPermalink(session.channelId, choiceMessageTs) : null;

    const text = link ? `❓ 질문 카드에서 답변해 주세요: ${link}` : '❓ 이 스레드의 질문 카드에서 답변해 주세요.';

    await respond({
      response_type: 'ephemeral',
      text,
      replace_original: false,
    });
  }

  private createSayFn(channel: string): SayFn {
    return async (args: any) => {
      const msgArgs = typeof args === 'string' ? { text: args } : args;
      return this.ctx.slackApi.postMessage(channel, msgArgs.text, {
        threadTs: msgArgs.thread_ts,
        blocks: msgArgs.blocks,
        attachments: msgArgs.attachments,
      });
    };
  }
}
