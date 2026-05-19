/** Stale-click marker shown on a button message after a superseded click. */
const STALE_CLICK_TEXT = '⏱️ _이 질문은 더 이상 유효하지 않습니다._';

/** Rollback marker for askUserForm partial-failure. */
export const FORM_BUILD_FAILED_TEXT = '⏱️ _폼 생성에 실패했습니다._';

/** Supersede marker applied to prior choice messages when a new ask arrives. */
export const SUPERSEDED_TEXT = '⏱️ _새 질문으로 대체되었습니다._';

export type ClickBranch = 'legacy' | 'p3' | 'stale';

export interface PendingChoiceForClick {
  turnId?: string;
  kind: 'single' | 'multi';
  choiceTs?: string;
  formIds: string[];
}

export interface ClickSession {
  actionPanel?: {
    pendingChoice?: PendingChoiceForClick;
  };
}

export interface ClickSessionReader {
  getSessionByKey(sessionKey: string): ClickSession | undefined;
}

export interface SlackApiStaleMarkerWriter {
  updateMessage(channel: string, messageTs: string, text: string, blocks: any[], attachments: any[]): Promise<unknown>;
}

export interface WarnLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

let getFiveBlockPhase: () => number = () => Number(process.env.SOMA_UI_5BLOCK_PHASE || 0);

export function setClickClassifierFiveBlockPhaseProvider(provider: () => number): void {
  getFiveBlockPhase = provider;
}

/**
 * Wrap a marker text in a single-section Slack blocks payload.
 */
export function buildMarkerBlocks(text: string): any[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

/**
 * P3 (PHASE>=3) click routing.
 *
 *   PHASE<3          -> always 'legacy' (ignore any payload turnId)
 *   PHASE>=3 + pc    -> match turnId + ts/formId -> 'p3' else 'stale'
 *   PHASE>=3 + !pc   -> payload has turnId -> 'stale' else 'legacy'
 */
export function classifyClick(
  claudeHandler: ClickSessionReader,
  args: {
    sessionKey: string;
    payloadTurnId?: string;
    messageTs?: string;
    formId?: string;
  },
): ClickBranch {
  if (getFiveBlockPhase() < 3) return 'legacy';
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
 * Apply the stale marker to the clicked message. Best-effort.
 */
export async function markClickAsStale(
  slackApi: SlackApiStaleMarkerWriter,
  logger: WarnLogger,
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
