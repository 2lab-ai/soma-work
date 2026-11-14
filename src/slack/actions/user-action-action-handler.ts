import { Logger } from '../../logger';
import type { ConversationSession } from '../../types';
import { parseUserActionButtonValue, USER_ACTION_DONE_ACTION_ID, userActionResolvedPrompt } from '../user-action-card';
import { resolveSessionUserAction, type UserActionHostDeps } from '../user-action-host';
import type { MessageHandler, RespondFn, SayFn } from './types';

export const USER_ACTION_OWNER_ONLY_TEXT = '이 사용자 작업은 세션 소유자(또는 승인된 사람)만 완료로 표시할 수 있습니다.';
export const USER_ACTION_ALREADY_TEXT = '이미 표시된 사용자 작업입니다.';
export const USER_ACTION_GONE_TEXT = '이 사용자 작업을 찾을 수 없습니다(세션이 끝났거나 오래된 카드).';

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
 * ✅ 완료했어요 / ❌ 안 됐어요 on a user-action card. First answer wins; the card loses its buttons; the agent gets a
 * self-contained message through the normal message path (so it runs as a turn, queued behind a running one).
 */
export class UserActionActionHandler {
  private logger = new Logger('UserActionActionHandler');

  constructor(private deps: UserActionActionDeps) {}

  /** `_respond` is unused: the card itself is rewritten by resolveSessionUserAction. */
  async handleResolve(body: any, _respond: RespondFn): Promise<void> {
    const button = body?.actions?.[0];
    const value = parseUserActionButtonValue(button?.value);
    const userId: string | undefined = body?.user?.id;
    const channel: string | undefined = body?.channel?.id;
    if (!value || !userId) {
      this.logger.warn('invalid user action button payload');
      return;
    }
    const status = button.action_id === USER_ACTION_DONE_ACTION_ID ? 'done' : 'failed';
    const session = this.deps.getSessionByKey(value.sessionKey);
    const ephemeral = async (text: string) => {
      if (channel) await this.deps.slackApi.postEphemeral(channel, userId, text).catch(() => undefined);
    };
    if (!session) return ephemeral(USER_ACTION_GONE_TEXT);
    if (!this.deps.mayAnswer(value.sessionKey, session, userId)) return ephemeral(USER_ACTION_OWNER_ONLY_TEXT);

    const r = await resolveSessionUserAction({
      session,
      sessionKey: value.sessionKey,
      id: value.id,
      status,
      by: userId,
      at: (this.deps.now ?? Date.now)(),
      deps: { slackApi: this.deps.slackApi, persistAndBroadcast: this.deps.persistAndBroadcast },
    });
    if (!r.ok) return ephemeral(r.reason === 'already-resolved' ? USER_ACTION_ALREADY_TEXT : USER_ACTION_GONE_TEXT);

    const target = session.channelId || channel;
    if (!target) return;
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
          user: userId,
          channel: target,
          thread_ts: session.threadRootTs || session.threadTs || body?.message?.thread_ts,
          ts: body?.message?.ts ?? String(Date.now() / 1000),
          text: userActionResolvedPrompt(r.action),
        },
        say,
      );
    } catch (error) {
      this.logger.error('telling the agent about a resolved user action failed', {
        sessionKey: value.sessionKey,
        id: value.id,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }
}
