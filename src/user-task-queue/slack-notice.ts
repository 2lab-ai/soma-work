/**
 * The Slack messages of the per-user task queue — pure builders (text + Block Kit), no API calls.
 *
 * - queued   — posted in the thread whose request waits: what runs and where, that this one starts on its own when
 *              that ends, and the two buttons: 먼저 진행 (stop the running one and go first) and 대기 취소.
 * - started  — the same message rewritten when its turn came (no buttons left).
 * - cancelled — the same message rewritten when it left the line.
 * - deferred — posted in the thread that was stopped so another could go first.
 */
import { escapeSlackMrkdwn } from '../slack/mrkdwn-escape';

export const USER_TASK_QUEUE_BYPASS_ACTION_ID = 'user_task_queue_bypass';
export const USER_TASK_QUEUE_CANCEL_ACTION_ID = 'user_task_queue_cancel';

const VALUE_PREFIX = 'utq:';

/** A task as a notice names it: its title and the link to its thread (when Slack gave one). */
export interface NoticeTask {
  title?: string;
  link?: string;
}

export interface QueuedNoticeInput {
  entryId: string;
  /** 1-based place in the person's line. */
  position: number;
  /** Tasks the person may run at once. */
  limit: number;
  running: NoticeTask[];
  /** How many of the person's tasks wait, this one included. */
  waitingCount: number;
}

export interface SlackNotice {
  text: string;
  blocks: any[];
}

export function queueActionValue(entryId: string): string {
  return `${VALUE_PREFIX}${entryId}`;
}

export function parseQueueActionValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(VALUE_PREFIX)) return undefined;
  const id = value.slice(VALUE_PREFIX.length);
  return id ? id : undefined;
}

function taskRef(task: NoticeTask): string {
  const title = escapeSlackMrkdwn((task.title ?? '').trim() || '제목 없는 작업');
  return task.link ? `<${task.link}|${title}>` : title;
}

function section(text: string): any {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): any {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

export function buildQueuedNotice(input: QueuedNoticeInput): SlackNotice {
  const place = input.position <= 1 ? '다음 차례' : `대기 ${input.position}번째`;
  const runningLines = input.running.length
    ? input.running.map((t) => `• 진행 중: ${taskRef(t)}`).join('\n')
    : '• 진행 중인 작업이 곧 끝납니다';
  const startsAfter =
    input.running.length > 1 || input.position > 1
      ? '앞의 작업이 끝나면 차례대로 이 요청을 자동으로 시작합니다.'
      : '그 작업이 끝나면 이 요청을 자동으로 시작합니다.';
  const text = `⏳ 작업 대기열에 들어갔습니다 (${place}) — 진행 중인 작업이 끝나면 자동으로 시작합니다.`;
  const blocks = [
    section(`⏳ *작업 대기열에 들어갔습니다 — ${place}*`),
    section(
      `동시에 진행할 수 있는 작업은 *${input.limit}개*입니다. 지금 진행 중인 작업:\n${runningLines}\n` +
        `${startsAfter} 따로 하실 일은 없습니다.`,
    ),
    section(
      '*먼저 하고 싶다면* `먼저 진행`을 누르세요. 진행 중인 작업을 멈추고 이 요청을 바로 시작합니다 — ' +
        '멈춘 작업은 이 요청이 끝난 뒤 멈춘 지점부터 이어서 합니다.',
    ),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: USER_TASK_QUEUE_BYPASS_ACTION_ID,
          text: { type: 'plain_text', text: '먼저 진행', emoji: true },
          style: 'primary',
          value: queueActionValue(input.entryId),
        },
        {
          type: 'button',
          action_id: USER_TASK_QUEUE_CANCEL_ACTION_ID,
          text: { type: 'plain_text', text: '대기 취소', emoji: true },
          value: queueActionValue(input.entryId),
        },
      ],
    },
    context(
      `대기 중인 작업 ${input.waitingCount}개 · 대시보드 *응답 필요* 탭 맨 위 *대기큐*에서도 보고 조작할 수 있습니다.`,
    ),
  ];
  return { text, blocks };
}

/** Its turn came: `turn` — a running task ended; `bypass` — the person let it go first (`deferred` = what stopped). */
export function buildStartedNotice(how: 'turn' | 'bypass', deferred?: NoticeTask): SlackNotice {
  if (how === 'bypass') {
    const what = deferred
      ? `진행 중이던 ${taskRef(deferred)} 작업은 뒤로 미뤘습니다`
      : '진행 중이던 작업은 뒤로 미뤘습니다';
    const text = '▶️ 먼저 진행합니다 — 대기열을 건너뛰고 지금 시작했습니다.';
    return {
      text,
      blocks: [
        section('▶️ *먼저 진행합니다* — 대기열을 건너뛰고 지금 시작했습니다.'),
        context(`${what}. 이 작업이 끝나면 멈춘 지점부터 이어서 합니다.`),
      ],
    };
  }
  const text = '▶️ 차례가 와서 시작했습니다 — 앞의 작업이 끝났습니다.';
  return { text, blocks: [section('▶️ *차례가 와서 시작했습니다* — 앞의 작업이 끝났습니다.')] };
}

export function buildCancelledNotice(): SlackNotice {
  const text = '🚫 대기를 취소했습니다 — 이 요청은 실행되지 않습니다.';
  return {
    text,
    blocks: [section('🚫 *대기를 취소했습니다* — 이 요청은 실행되지 않습니다. 다시 하려면 메시지를 다시 보내세요.')],
  };
}

/** Posted in the stopped thread: `first` went ahead of it. */
export function buildDeferredNotice(first: NoticeTask): SlackNotice {
  const text = '⏸ 이 작업을 잠시 멈췄습니다 — 다른 작업을 먼저 진행합니다.';
  return {
    text,
    blocks: [
      section(`⏸ *이 작업을 잠시 멈췄습니다* — ${taskRef(first)} 작업을 먼저 진행합니다.`),
      context('그 작업이 끝나면 이 작업을 멈춘 지점부터 자동으로 이어서 합니다. 대시보드 *대기큐*에서 볼 수 있습니다.'),
    ],
  };
}

/** The host turn that carries a stopped task on (not the person's words). */
export const RESUME_PROMPT =
  '[user-task-queue] 이 작업은 사용자가 다른 작업을 먼저 진행하도록 잠시 멈췄습니다. 그 작업이 끝났으니, ' +
  '멈춘 지점부터 이어서 진행하세요 — 멈춘 동안 바뀐 것이 있으면 다시 확인하세요. ' +
  'This comes from the host, not the user.';
