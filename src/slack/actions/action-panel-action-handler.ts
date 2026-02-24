import { SlackApiHelper } from '../slack-api-helper';
import { ClaudeHandler } from '../../claude-handler';
import { RequestCoordinator } from '../request-coordinator';
import { Logger } from '../../logger';
import { ConversationSession } from '../../types';
import { MessageHandler, SayFn, RespondFn } from './types';

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
  | 'pr_approve'
  | 'focus_choice'
  | 'stop';

interface PanelActionValue {
  sessionKey?: string;
  action?: PanelAction;
}

interface ActionConfig {
  requires: 'issue' | 'pr';
  buildText: (url: string) => string;
  ackText: (label: string) => string;
}

const ACTION_CONFIG: Record<Exclude<PanelAction, 'focus_choice' | 'stop'>, ActionConfig> = {
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

      const isFocusChoiceAction = value.action === 'focus_choice';
      if (
        !isFocusChoiceAction
        && (session.activityState === 'working'
          || session.activityState === 'waiting'
          || session.actionPanel?.waitingForChoice)
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

      const config = ACTION_CONFIG[value.action as Exclude<PanelAction, 'focus_choice' | 'stop'>];
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

      const injectedText = config.buildText(requiredUrl);
      this.ctx.claudeHandler.setActivityStateByKey(value.sessionKey, 'working');
      const say = this.createSayFn(session.channelId);
      await this.ctx.messageHandler(
        { user: userId, channel: session.channelId, thread_ts: threadTs, ts: '', text: injectedText },
        say
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
    const link = choiceMessageTs
      ? await this.ctx.slackApi.getPermalink(session.channelId, choiceMessageTs)
      : null;

    const text = link
      ? `❓ 질문 카드에서 답변해 주세요: ${link}`
      : '❓ 이 스레드의 질문 카드에서 답변해 주세요.';

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
