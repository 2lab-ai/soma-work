/**
 * Slack cards of the work queue. The busy card offers the two choices the
 * requester asked for: cancel, or run after the current one ends.
 */
import { escapeSlackMrkdwn as escapeMrkdwn } from '../mrkdwn-escape';
import type { WorkQueueDef } from './config';
import type { CancelReason } from './manager';

export const WORK_QUEUE_WAIT_ACTION = 'work_queue_wait';
export const WORK_QUEUE_CANCEL_ACTION = 'work_queue_cancel';

export interface HolderLine {
  userId: string;
  permalink?: string;
  minutes: number;
  status: 'running' | 'waiting' | 'finishing';
}

export interface CardPayload {
  text: string;
  blocks: any[];
}

const STATUS_TEXT: Record<HolderLine['status'], string> = {
  running: '실행 중',
  waiting: '사용자 입력 대기',
  finishing: '마무리 중',
};

/** "배포" for deploy queues, "작업" otherwise. */
export function workNoun(queue: WorkQueueDef): string {
  return queue.workflow === 'deploy' ? '배포' : '작업';
}

function section(text: string): any {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): any {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function holderText(h: HolderLine, noun: string): string {
  const where = h.permalink ? ` · <${h.permalink}|스레드>` : '';
  return `• <@${h.userId}> 님의 ${noun}${where} · ${h.minutes}분째 · ${STATUS_TEXT[h.status]}`;
}

export function buildBusyCard(queue: WorkQueueDef, holders: HolderLine[], waiterId: string): CardPayload {
  const noun = workNoun(queue);
  const askMinutes = Math.round(queue.askTimeoutMs / 60_000);
  const label = escapeMrkdwn(queue.label);
  const text = `⏳ 이미 ${noun}가 진행 중입니다 — ${queue.label}`;
  return {
    text,
    blocks: [
      section(
        `⏳ *이미 ${noun}가 진행 중입니다* — \`${label}\` 큐는 동시에 ${queue.concurrency}개만 진행합니다.\n` +
          `${holders.map((h) => holderText(h, noun)).join('\n')}\n\n` +
          `이 요청은 시작하지 않았습니다. 취소할까요, 아니면 현재 ${noun}가 끝난 뒤 ${noun}할까요?`,
      ),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: WORK_QUEUE_WAIT_ACTION,
            style: 'primary',
            text: { type: 'plain_text', text: `현재 ${noun}가 끝나면 ${noun}` },
            value: waiterId,
          },
          {
            type: 'button',
            action_id: WORK_QUEUE_CANCEL_ACTION,
            text: { type: 'plain_text', text: '취소' },
            value: waiterId,
          },
        ],
      },
      context(`${askMinutes}분 안에 선택하지 않으면 이 요청은 자동으로 취소됩니다.`),
    ],
  };
}

export function buildWaitingCard(queue: WorkQueueDef, position: number, waiterId: string): CardPayload {
  const noun = workNoun(queue);
  const text = `⏳ 대기 중 — 앞선 ${noun}가 끝나면 자동으로 시작합니다 (대기 순번 ${position})`;
  return {
    text,
    blocks: [
      section(`⏳ *대기 중* — 앞선 ${noun}가 끝나면 이 요청을 자동으로 시작합니다. (대기 순번 ${position})`),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: WORK_QUEUE_CANCEL_ACTION,
            text: { type: 'plain_text', text: '대기 취소' },
            value: waiterId,
          },
        ],
      },
    ],
  };
}

/** A card with its buttons removed. */
export function buildClosedCard(text: string): CardPayload {
  return { text, blocks: [section(text)] };
}

export function startedText(queue: WorkQueueDef): string {
  const noun = workNoun(queue);
  return `▶️ 앞선 ${noun}가 끝나 이 요청을 시작합니다.`;
}

export function cancelledText(queue: WorkQueueDef, reason: CancelReason): string {
  const noun = workNoun(queue);
  switch (reason) {
    case 'ask-timeout':
      return `⏹️ ${Math.round(queue.askTimeoutMs / 60_000)}분 동안 선택이 없어 ${noun} 요청을 취소했습니다.`;
    case 'user':
      return `⏹️ ${noun} 요청을 취소했습니다.`;
    case 'session-gone':
      return `⏹️ 세션이 종료되어 ${noun} 요청을 취소했습니다.`;
    case 'session-reset':
      return `⏹️ 세션이 초기화되어 ${noun} 요청을 취소했습니다.`;
  }
}

export function alreadyWaitingText(queue: WorkQueueDef, position: number | undefined): string {
  const noun = workNoun(queue);
  return position
    ? `⏳ 이 스레드의 ${noun} 요청은 이미 대기 중입니다 (대기 순번 ${position}). 앞선 ${noun}가 끝나면 자동으로 시작합니다.`
    : `⏳ 이 스레드의 ${noun} 요청이 이미 선택을 기다리고 있습니다 — 위 카드에서 취소 또는 대기를 골라주세요.`;
}

export function slotReturnedText(queue: WorkQueueDef): string {
  const noun = workNoun(queue);
  return (
    `⏸️ ${Math.round(queue.holderIdleMs / 60_000)}분 동안 응답이 없어 \`${escapeMrkdwn(queue.label)}\` 슬롯을 반납했습니다. ` +
    `이어서 진행하면 다시 큐를 거칩니다 — 다른 ${noun}가 진행 중이면 기다려야 합니다.`
  );
}

export const EXPIRED_CLICK_TEXT = '⏱️ 만료된 요청입니다 — 필요하면 다시 요청해주세요.';
export const NOT_REQUESTER_TEXT = '⚠️ 요청한 사람만 선택할 수 있습니다.';
