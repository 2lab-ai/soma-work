import type { ClaudeHandler } from '../../claude-handler';
import { config } from '../../config';
import type { Logger } from '../../logger';
import type { SlackApiHelper } from '../slack-api-helper';

/** Stale-click marker shown on a button message after a superseded click. */
const STALE_CLICK_TEXT = '⏱️ _이 질문은 더 이상 유효하지 않습니다._';

/** Rollback marker for askUserForm partial-failure. */
export const FORM_BUILD_FAILED_TEXT = '⏱️ _폼 생성에 실패했습니다._';

/** Supersede marker applied to prior choice messages when a new ask arrives. */
export const SUPERSEDED_TEXT = '⏱️ _새 질문으로 대체되었습니다._';

export type ClickBranch = 'legacy' | 'p3' | 'stale';

/**
 * Wrap a marker text in a single-section Slack blocks payload.
 */
export function buildMarkerBlocks(text: string): any[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

/**
 * P3 (PHASE>=3) click routing.
 *
 *   PHASE<3          → always 'legacy' (ignore any payload turnId)
 *   PHASE>=3 + pc    → match turnId + ts/formId → 'p3' else 'stale'
 *   PHASE>=3 + !pc   → payload has turnId → 'stale' (never resurrect via
 *                      legacy ts-union) else 'legacy' (truly pre-flip)
 */
export function classifyClick(
  claudeHandler: ClaudeHandler,
  args: {
    sessionKey: string;
    payloadTurnId?: string;
    messageTs?: string;
    formId?: string;
  },
): ClickBranch {
  if (config.ui.fiveBlockPhase < 3) return 'legacy';
  const session = claudeHandler.getSessionByKey(args.sessionKey);
  const pc = session?.actionPanel?.pendingChoice;
  if (pc) {
    const turnIdMatches = !!args.payloadTurnId && pc.turnId === args.payloadTurnId;
    const tsMatches =
      pc.kind === 'single'
        ? !!args.messageTs && pc.choiceTs === args.messageTs
        : !!args.formId && pc.formIds.includes(args.formId);
    if (turnIdMatches && tsMatches) return 'p3';
    return 'stale';
  }
  if (args.payloadTurnId) return 'stale';
  return 'legacy';
}

/**
 * Apply the stale marker to the clicked message. Best-effort (logs on
 * failure; never throws).
 */
export async function markClickAsStale(
  slackApi: SlackApiHelper,
  logger: Logger,
  channel: string | undefined,
  messageTs: string | undefined,
  sessionKey: string,
): Promise<void> {
  if (!channel || !messageTs) return;
  try {
    await slackApi.updateMessage(channel, messageTs, STALE_CLICK_TEXT, buildMarkerBlocks(STALE_CLICK_TEXT), []);
  } catch (err) {
    logger.warn('markClickAsStale: updateMessage failed', {
      sessionKey,
      messageTs,
      error: (err as Error)?.message ?? String(err),
    });
  }
}
