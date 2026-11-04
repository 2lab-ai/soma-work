/**
 * Safeguards halt — what Slack shows and who may lift it.
 *
 * Anthropic's safeguards blocked a request (`@soma/common/safeguard`). The
 * session cannot go on with that model, so the executor stops the work and
 * locks the session (`session.safeguardHalt`). This module owns:
 *   - the label every surface uses ("세이프가드 에러", never "오류 발생");
 *   - the thread notice and its admin button;
 *   - the two decisions around the lock: whether a dispatched turn may run
 *     (`decideSafeguardGate`) and whether a button click unlocks
 *     (`decideSafeguardUnlock`).
 *
 * The lock is lifted ONLY by an admin pressing the button — an authenticated
 * Slack action bound to this halt (`atMs`). A message never unlocks it: host
 * turns (epic wakes, post-compact replays) and queued messages are authored as
 * the owner, who is often an admin, and a bare `help` would unlock without
 * meaning to retry anything.
 */
import { formatSafeguardDetail, type SafeguardHalt } from '@soma/common/safeguard';

export const SAFEGUARD_ERROR_LABEL = '세이프가드 에러';
export const SAFEGUARD_ERROR_EMOJI = '🛡️';
/** The admin unlock button on the halt notice. */
export const SAFEGUARD_ADMIN_RETRY_ACTION = 'safeguard_admin_retry';

function detailSuffix(halt: SafeguardHalt): string {
  const detail = formatSafeguardDetail(halt);
  return detail ? `\n${detail}` : '';
}

/** The thread notice posted once, when the flag arrives. */
export function safeguardHaltNoticeText(halt: SafeguardHalt): string {
  return (
    `${SAFEGUARD_ERROR_EMOJI} *${SAFEGUARD_ERROR_LABEL}* — Anthropic safeguards가 이 요청을 차단해 작업을 즉시 중단했습니다.\n` +
    '이 세션은 같은 모델로 더 진행할 수 없습니다. 자동 재시도·goal 연속·자동 재개를 모두 멈췄고, ' +
    '이 스레드에서 다시 시도하려면 관리자(admin)가 아래 버튼으로 허용해야 합니다.' +
    detailSuffix(halt)
  );
}

/**
 * The thread notice when the goal completion eval — its own query — was the
 * one blocked. Text only (the loop's notice seam); the admin button comes with
 * the refusal of the next message in the thread.
 */
export function safeguardEvalHaltNoticeText(halt: SafeguardHalt): string {
  return (
    `${SAFEGUARD_ERROR_EMOJI} *${SAFEGUARD_ERROR_LABEL}* — goal 완료 판정 요청이 Anthropic safeguards에 차단되어 작업을 즉시 중단했습니다.\n` +
    '이 세션은 같은 모델로 더 진행할 수 없습니다. 다시 시도하려면 관리자(admin) 허용이 필요합니다 — ' +
    '이 스레드에 메시지를 보내면 *관리자 재시도 허용* 버튼이 표시됩니다.' +
    detailSuffix(halt)
  );
}

/** The turn card body (`TurnCompletionEvent.message`); its first line is the card header suffix. */
export function safeguardCardMessage(halt: SafeguardHalt): string {
  return (
    'Anthropic safeguards가 요청을 차단해 작업을 중단했습니다 — 관리자만 다시 시도할 수 있습니다.' + detailSuffix(halt)
  );
}

export interface SafeguardButtonValue {
  sessionKey: string;
  /** The halt this button lifts — a later halt is not lifted by an older notice. */
  atMs: number;
}

export function buildSafeguardHaltBlocks(halt: SafeguardHalt, sessionKey: string): any[] {
  return withSafeguardRetryButton(safeguardHaltNoticeText(halt), halt, sessionKey);
}

/**
 * The refusal of a message in a halted thread carries the admin button too:
 * the halt notice may never have reached Slack (a failed post), and the button
 * is the only way to lift the lock — every refusal re-offers it.
 */
export function buildSafeguardRefusalBlocks(
  halt: SafeguardHalt,
  sessionKey: string,
  opts: { isAdmin: boolean },
): any[] {
  return withSafeguardRetryButton(safeguardRefusalNotice(halt, opts), halt, sessionKey);
}

function withSafeguardRetryButton(text: string, halt: SafeguardHalt, sessionKey: string): any[] {
  const value: SafeguardButtonValue = { sessionKey, atMs: halt.atMs };
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: SAFEGUARD_ADMIN_RETRY_ACTION,
          text: { type: 'plain_text', text: '관리자 재시도 허용', emoji: true },
          style: 'danger',
          value: JSON.stringify(value),
        },
      ],
    },
  ];
}

export function parseSafeguardButtonValue(raw: unknown): SafeguardButtonValue | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as Partial<SafeguardButtonValue>;
    if (typeof v.sessionKey !== 'string' || !v.sessionKey) return null;
    if (typeof v.atMs !== 'number' || !Number.isFinite(v.atMs)) return null;
    return { sessionKey: v.sessionKey, atMs: v.atMs };
  } catch {
    return null;
  }
}

/**
 * May a dispatched turn run in this thread?
 *   - `pass`   — not halted.
 *   - `refuse` — a person's message (admin or not): not run, answered with a notice.
 *   - `drop`   — a host turn (synthetic: goal continuation, auto-resume, cron,
 *                auto-compact continuation; or `hostTurn`: epic wakes,
 *                post-compact replays): not run, no notice.
 */
export function decideSafeguardGate(input: {
  halt: SafeguardHalt | undefined;
  hostTurn: boolean;
}): 'pass' | 'refuse' | 'drop' {
  if (!input.halt) return 'pass';
  return input.hostTurn ? 'drop' : 'refuse';
}

/** Does this button click lift the lock? */
export function decideSafeguardUnlock(input: {
  halt: SafeguardHalt | undefined;
  clickerIsAdmin: boolean;
  buttonAtMs: number;
}): 'unlock' | 'not-admin' | 'not-halted' | 'stale' {
  if (!input.clickerIsAdmin) return 'not-admin';
  if (!input.halt) return 'not-halted';
  if (input.halt.atMs !== input.buttonAtMs) return 'stale';
  return 'unlock';
}

/** Why a message in a halted thread did not run. */
export function safeguardRefusalNotice(halt: SafeguardHalt, opts: { isAdmin: boolean }): string {
  const how = opts.isAdmin
    ? '관리자는 세이프가드 안내의 *관리자 재시도 허용* 버튼으로 잠금을 해제한 뒤 다시 보내세요.'
    : '다시 시도하려면 관리자(admin) 권한이 필요합니다 — 관리자에게 요청하세요.';
  return (
    `${SAFEGUARD_ERROR_EMOJI} *${SAFEGUARD_ERROR_LABEL}*로 중단된 세션입니다 — 이 메시지는 실행하지 않았습니다. ${how}` +
    detailSuffix(halt)
  );
}

/** Posted when an admin lifts the lock. */
export function safeguardUnlockedNotice(adminUserId: string): string {
  return (
    `✅ <@${adminUserId}> 관리자가 ${SAFEGUARD_ERROR_LABEL} 잠금을 해제했습니다 — 이 스레드에 메시지를 보내면 다시 실행합니다. ` +
    '같은 모델은 다시 차단될 수 있으니 `%model <모델> <지시>`로 모델을 바꿔 보내는 것을 권장합니다.'
  );
}
