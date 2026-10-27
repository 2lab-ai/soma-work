/**
 * Auto-mode permission WARNING publisher (SSOT_2 #3) — "지금 퍼미션 묻는거랑 비슷한
 * 화면인데 유저에게 묻는건 아니고 경고 표시만 출력해줘 이거 슬랙 메세지랑 대시보드
 * 채팅창에도 그대로 해줘."
 *
 * One warning event, two surfaces:
 *   • Slack — the warning card (`buildPermissionWarningBlocks`: the request card's
 *     shape without buttons) posted into the session thread at every verbosity
 *     level, like the permission card itself.
 *   • Dashboard — a `permission_warning` work-log entry, which the panel renders
 *     as the same card in its chat (owner-only, like the rest of the work log).
 *
 * The two are independent: a Slack failure still records the dashboard entry,
 * and the caller (the PreToolUse hook) has already decided `allow` — nothing here
 * can turn into a question or a denial.
 */

import { recordConversationWorkLog } from '@soma/slack/pipeline/stream-executor';
import { buildPermissionWarningBlocks } from 'somalib/permission/slack-messenger';
import type { PermissionWarningEvent } from '../agent-runtime/policy/permission-warning';
import { Logger } from '../logger';

const logger = new Logger('PermissionWarning');

export interface PermissionWarningPublisherDeps {
  postMessage(channel: string, text: string, options?: { threadTs?: string; blocks?: unknown[] }): Promise<unknown>;
  /** Defaults to the shared work-log recorder. */
  recordWorkLog?: typeof recordConversationWorkLog;
}

export async function publishPermissionWarning(
  warning: PermissionWarningEvent,
  deps: PermissionWarningPublisherDeps,
): Promise<void> {
  const record = deps.recordWorkLog ?? recordConversationWorkLog;
  if (warning.conversationId) {
    record(warning.conversationId, {
      kind: 'permission_warning',
      text: warning.command,
      tool: warning.toolName,
      // The full command, so opening the row in the work log always shows it.
      raw: warning.command,
      warning: { rules: warning.rules, reason: warning.reason },
    });
  }
  const blocks = buildPermissionWarningBlocks({
    toolName: warning.toolName,
    input: warning.toolInput,
    user: warning.user,
    rules: warning.rules,
    reason: warning.reason,
  });
  const fallback = `⚠️ Permission warning — ${warning.toolName}: ${warning.rules.map((r) => r.id).join(', ')}`;
  try {
    await deps.postMessage(warning.channel, fallback, {
      ...(warning.threadTs ? { threadTs: warning.threadTs } : {}),
      blocks,
    });
  } catch (err) {
    logger.warn('Failed to post the permission warning to Slack', {
      channel: warning.channel,
      threadTs: warning.threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('Auto-mode permission warning published', {
    user: warning.user,
    tool: warning.toolName,
    rules: warning.rules.map((r) => r.id),
  });
}
