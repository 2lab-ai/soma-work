/**
 * Host side of user actions (`instruct_user`): the MCP server validates and inspects; this keeps the record on the
 * session (`session.userActions`, apart from the pending question), posts its Slack card, and answers its buttons.
 * Every change is persisted and pushed to the dashboard through `persistAndBroadcast`.
 */
import {
  appendUserAction,
  INSTRUCT_USER_TOOL_NAME,
  parseInstructUserToolResult,
  type ResolveUserActionResult,
  resolveUserAction,
  type UserActionRecord,
} from 'somalib/user-action/user-action';
import { Logger } from '../logger';
import type { ConversationSession } from '../types';
import { buildUserActionCard } from './user-action-card';

const logger = new Logger('UserActionHost');

export interface UserActionHostDeps {
  slackApi: {
    postMessage(
      channel: string,
      text: string,
      options?: { threadTs?: string; attachments?: any[]; unfurlLinks?: boolean; unfurlMedia?: boolean },
    ): Promise<{ ts?: string }>;
    updateMessage(channel: string, ts: string, text: string, blocks?: any[], attachments?: any[]): Promise<void>;
  };
  persistAndBroadcast?: (sessionKey: string) => void;
}

/**
 * Take every successful `instruct_user` result of a tool batch: store it, post its card (when the session has a
 * Slack thread), then persist and broadcast once. A failed post keeps the record — the dashboard still shows it.
 */
export async function captureUserActionToolResults(args: {
  toolResults: ReadonlyArray<{ toolName?: string; result: unknown; isError?: boolean }>;
  session: ConversationSession;
  sessionKey: string;
  channel: string;
  threadTs?: string;
  deps: UserActionHostDeps;
}): Promise<UserActionRecord[]> {
  const { session, sessionKey, channel, threadTs, deps } = args;
  const captured: UserActionRecord[] = [];
  for (const tr of args.toolResults) {
    if (tr.toolName !== INSTRUCT_USER_TOOL_NAME || tr.isError === true) continue;
    const action = parseInstructUserToolResult(tr.result);
    if (!action) continue;
    let stored: UserActionRecord = action;
    if (channel) {
      try {
        const card = buildUserActionCard(action, sessionKey);
        const post = await deps.slackApi.postMessage(channel, card.text, {
          threadTs,
          attachments: card.attachments,
          unfurlLinks: false,
          unfurlMedia: false,
        });
        if (post.ts) stored = { ...action, slackTs: post.ts };
      } catch (error) {
        logger.warn('user action card post failed — kept for the dashboard', {
          sessionKey,
          id: action.id,
          error: (error as Error)?.message ?? String(error),
        });
      }
    }
    session.userActions = appendUserAction(session.userActions, stored);
    captured.push(stored);
  }
  if (captured.length) {
    try {
      deps.persistAndBroadcast?.(sessionKey);
    } catch (error) {
      logger.warn('user action persist/broadcast failed', { sessionKey, error: (error as Error)?.message });
    }
  }
  return captured;
}

/**
 * Mark a pending action done or failed (first answer wins), rewrite its Slack card without the buttons, and
 * persist + broadcast. Telling the agent is the caller's job (it owns the message path).
 */
export async function resolveSessionUserAction(args: {
  session: ConversationSession;
  sessionKey: string;
  id: string;
  status: 'done' | 'failed';
  by: string;
  at: number;
  deps: UserActionHostDeps;
}): Promise<ResolveUserActionResult> {
  const { session, sessionKey, deps } = args;
  const r = resolveUserAction(session.userActions, args.id, args.status, args.by, args.at);
  if (!r.ok) return r;
  session.userActions = r.list;
  const channel = session.channelId;
  if (channel && r.action.slackTs) {
    try {
      const card = buildUserActionCard(r.action, sessionKey);
      await deps.slackApi.updateMessage(channel, r.action.slackTs, card.text, undefined, card.attachments);
    } catch (error) {
      logger.warn('user action card update failed', { sessionKey, id: args.id, error: (error as Error)?.message });
    }
  }
  try {
    deps.persistAndBroadcast?.(sessionKey);
  } catch (error) {
    logger.warn('user action persist/broadcast failed', { sessionKey, error: (error as Error)?.message });
  }
  return r;
}
