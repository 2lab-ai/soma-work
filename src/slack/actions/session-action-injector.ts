import type { ClaudeHandler } from '../../claude-handler';
import type { Logger } from '../../logger';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';

/**
 * Shared dependencies for action handlers that delegate execution to the
 * session AI by injecting a message into the session thread.
 */
export interface SessionActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/**
 * Backend-specific text/data for one injected session action, derived from the
 * Block Kit action payload.
 */
export interface SessionActionPlan {
  /** Session whose thread receives the injected instruction. */
  sessionKey: string;
  /** `logger.info` label + structured data recorded when the action starts. */
  logLabel: string;
  logData: Record<string, unknown>;
  /** Ephemeral acknowledgement shown to the clicking user. */
  ackText: string;
  /** Instruction injected into the session thread for the AI to execute. */
  injectedText: string;
}

function createSayFn(ctx: SessionActionContext, channel: string): SayFn {
  return async (args: any) => {
    const msgArgs = typeof args === 'string' ? { text: args } : args;
    return ctx.slackApi.postMessage(channel, msgArgs.text, {
      threadTs: msgArgs.thread_ts,
      blocks: msgArgs.blocks,
      attachments: msgArgs.attachments,
    });
  };
}

/**
 * Run the shared "validate session → acknowledge → inject instruction" flow.
 *
 * `plan` maps the raw Block Kit action value to the backend-specific strings;
 * everything else (owner/thread guards, activity state, message injection,
 * error handling) is identical across handlers and lives here.
 */
export async function runSessionInjectionAction(
  ctx: SessionActionContext,
  logger: Logger,
  body: any,
  respond: RespondFn,
  errorText: string,
  plan: (valueData: any, userId: string | undefined) => SessionActionPlan,
): Promise<void> {
  try {
    const action = body.actions[0];
    const valueData = JSON.parse(action.value);
    const userId = body.user?.id;

    const { sessionKey, logLabel, logData, ackText, injectedText } = plan(valueData, userId);

    logger.info(logLabel, logData);

    const session = ctx.claudeHandler.getSessionByKey(sessionKey);
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

    const threadTs = session.threadTs;
    if (!threadTs) {
      await respond({
        response_type: 'ephemeral',
        text: '❌ 세션의 스레드를 찾을 수 없습니다.',
        replace_original: false,
      });
      return;
    }

    // Acknowledge to user
    await respond({
      response_type: 'ephemeral',
      text: ackText,
      replace_original: false,
    });

    // Inject message into session thread for AI to execute
    ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
    const say = createSayFn(ctx, session.channelId);
    await ctx.messageHandler(
      { user: userId, channel: session.channelId, thread_ts: threadTs, ts: '', text: injectedText },
      say,
    );
  } catch (error) {
    logger.error('Error processing session injection action', error);
    try {
      await respond({
        response_type: 'ephemeral',
        text: errorText,
        replace_original: false,
      });
    } catch (respondError) {
      logger.error('Failed to send error response', respondError);
    }
  }
}
