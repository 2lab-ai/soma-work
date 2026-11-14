import { Logger } from '../../logger';
import type { ConversationSession } from '../../types';
import { parseUserActionButtonValue, USER_ACTION_DONE_ACTION_ID } from '../user-action-card';
import { type AnswerUserActionCode, answerUserAction, type UserActionHostDeps } from '../user-action-host';
import type { MessageHandler, RespondFn, SayFn } from './types';

export const USER_ACTION_OWNER_ONLY_TEXT = '이 사용자 작업은 세션 소유자(또는 승인된 사람)만 완료로 표시할 수 있습니다.';
export const USER_ACTION_ALREADY_TEXT = '이미 표시된 사용자 작업입니다.';
export const USER_ACTION_GONE_TEXT = '이 사용자 작업을 찾을 수 없습니다(세션이 끝났거나 오래된 카드).';
export const USER_ACTION_NOT_DELIVERED_TEXT = '봇에게 전달하지 못해 대기 상태로 되돌렸습니다. 잠시 뒤 다시 눌러 주세요.';

const REFUSAL_TEXT: Record<AnswerUserActionCode, string> = {
  gone: USER_ACTION_GONE_TEXT,
  forbidden: USER_ACTION_OWNER_ONLY_TEXT,
  'already-resolved': USER_ACTION_ALREADY_TEXT,
  'not-delivered': USER_ACTION_NOT_DELIVERED_TEXT,
};

interface UserActionActionDeps {
  slackApi: UserActionHostDeps['slackApi'] & {
    postEphemeral(channel: string, user: string, text: string): Promise<unknown>;
  };
  getSessionByKey(sessionKey: string): ConversationSession | undefined;
  persistAndBroadcast(sessionKey: string): void;
  /** Whether `userId` may speak for the session (owner, approved, trusted) — the instruction gate. */
  mayAnswer(sessionKey: string, session: ConversationSession, userId: string): boolean;
  messageHandler: MessageHandler;
  now?: () => number;
}

/**
 * ✅ 완료했어요 / ❌ 안 됐어요 on a user-action card: {@link answerUserAction} with the agent told through the normal
 * message path (its turn runs, or waits behind a running one). A refusal is told to the clicker only.
 */
export class UserActionActionHandler {
  private logger = new Logger('UserActionActionHandler');

  constructor(private deps: UserActionActionDeps) {}

  /** `_respond` is unused: the card itself is rewritten by the answer path. */
  async handleResolve(body: any, _respond: RespondFn): Promise<void> {
    const button = body?.actions?.[0];
    const value = parseUserActionButtonValue(button?.value);
    const userId: string | undefined = body?.user?.id;
    const channel: string | undefined = body?.channel?.id;
    if (!value || !userId) {
      this.logger.warn('invalid user action button payload');
      return;
    }
    const r = await answerUserAction({
      sessionKey: value.sessionKey,
      id: value.id,
      status: button.action_id === USER_ACTION_DONE_ACTION_ID ? 'done' : 'failed',
      actor: userId,
      at: (this.deps.now ?? Date.now)(),
      deps: {
        slackApi: this.deps.slackApi,
        persistAndBroadcast: this.deps.persistAndBroadcast,
        getSession: this.deps.getSessionByKey,
        mayAnswer: this.deps.mayAnswer,
        notify: (sessionKey, session, text, actor) => this.tellAgent(sessionKey, session, text, actor, body, channel),
      },
    });
    if (!r.ok && channel) {
      await this.deps.slackApi.postEphemeral(channel, userId, REFUSAL_TEXT[r.code]).catch(() => undefined);
    }
  }

  /** The answer as the clicker's message in the session's thread. False when the message path throws. */
  private async tellAgent(
    sessionKey: string,
    session: ConversationSession,
    text: string,
    actor: string,
    body: any,
    channel: string | undefined,
  ): Promise<boolean> {
    const target = session.channelId || channel;
    if (!target) return false;
    const say: SayFn = async (args: any) => {
      const msg = typeof args === 'string' ? { text: args } : args;
      return this.deps.slackApi.postMessage(target, msg.text, {
        threadTs: msg.thread_ts,
        attachments: msg.attachments,
      }) as any;
    };
    try {
      await this.deps.messageHandler(
        {
          user: actor,
          channel: target,
          thread_ts: session.threadRootTs || session.threadTs || body?.message?.thread_ts,
          ts: body?.message?.ts ?? String(Date.now() / 1000),
          text,
        },
        say,
      );
      return true;
    } catch (error) {
      this.logger.error('telling the agent about a resolved user action failed', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      return false;
    }
  }
}
