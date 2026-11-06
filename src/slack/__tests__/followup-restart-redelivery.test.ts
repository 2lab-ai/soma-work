import type { FollowupItem } from '@soma/slack/followup-queue';
import { describe, expect, it } from 'vitest';
import { buildSteerUserMessage } from '../../agent-runtime/turn-input-channel';
import {
  FOLLOWUP_RESTART_REDELIVERY_MAX_AGE_MS,
  FOLLOWUP_SHUTDOWN_STOP_REASON,
  isRestartCutUndelivered,
  restartCutVerdict,
  transcriptShowsRead,
} from '../followup-restart-redelivery';

const NOW = Date.parse('2026-11-03T09:30:00Z');
const ENQUEUED = Date.parse('2026-11-03T08:25:36Z');

function row(over: Partial<FollowupItem> = {}): FollowupItem {
  return {
    id: 'S#3',
    sessionKey: 'S',
    seq: 3,
    epoch: 2,
    state: 'uncertain',
    eventKey: 'C:1793694335.923679',
    message: { user: 'U1', channel: 'C', ts: '1793694335.923679', text: '크론 stage0 트리거해줘야함' },
    context: {},
    enqueuedAt: ENQUEUED,
    updatedAt: ENQUEUED + 185_000,
    stateReason: FOLLOWUP_SHUTDOWN_STOP_REASON,
    ...over,
  } as FollowupItem;
}

/** The two shapes the work-m64 transcript held on 2026-11-03 (trimmed to the fields read). */
const QUEUED_COMMAND_LINE = JSON.stringify({
  parentUuid: 'dd4c4fa2-9991-4e58-9856-a32e3a97f969',
  attachment: {
    type: 'queued_command',
    prompt: [{ type: 'text', text: '크론 stage0 트리거해줘야함' }],
    source_uuid: '60a8f6c6-c37c-4540-9a67-033f078dc289',
  },
  type: 'attachment',
  uuid: '7030ff48-11e5-4650-b947-cc3a582f28ad',
  timestamp: '2026-11-03T08:25:37.687Z',
});
const OWN_TURN_LINE = JSON.stringify({
  parentUuid: 'cc7dd2f5-fedf-44af-b468-faddbed118f0',
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '&gt; 입금 감지는…' }] },
  uuid: 'e4938d8a-4a16-4aad-9821-d3850724ea27',
  timestamp: '2026-11-03T07:43:00.000Z',
});
const TRANSCRIPT = `${OWN_TURN_LINE}\n${QUEUED_COMMAND_LINE}\n`;

describe('isRestartCutUndelivered', () => {
  it('takes a row the shutdown stop or the restart parked before its words reached the model', () => {
    expect(isRestartCutUndelivered(row(), NOW)).toBe(true);
    expect(isRestartCutUndelivered(row({ state: 'paused', stateReason: 'process restart' }), NOW)).toBe(true);
    expect(
      isRestartCutUndelivered(row({ state: 'paused', stateReason: 'process restart — 모델이 읽었는지 미확인' }), NOW),
    ).toBe(true);
  });

  it('leaves a row a person stopped, one with delivery evidence, a live row and a stale one', () => {
    expect(isRestartCutUndelivered(row({ stateReason: '실행이 중단되었습니다 (stop)' }), NOW)).toBe(false);
    expect(isRestartCutUndelivered(row({ deliveredAt: ENQUEUED + 1000 }), NOW)).toBe(false);
    expect(isRestartCutUndelivered(row({ state: 'queued' }), NOW)).toBe(false);
    expect(isRestartCutUndelivered(row({ state: 'failed' }), NOW)).toBe(false);
    expect(isRestartCutUndelivered(row({ enqueuedAt: NOW - FOLLOWUP_RESTART_REDELIVERY_MAX_AGE_MS - 1 }), NOW)).toBe(
      false,
    );
  });
});

describe('transcriptShowsRead', () => {
  it('finds a steer folded into a turn by its source_uuid, and one that started a turn by its uuid', () => {
    expect(transcriptShowsRead(TRANSCRIPT, { uuid: '60a8f6c6-c37c-4540-9a67-033f078dc289', since: ENQUEUED })).toBe(
      true,
    );
    expect(transcriptShowsRead(TRANSCRIPT, { uuid: 'e4938d8a-4a16-4aad-9821-d3850724ea27', since: ENQUEUED })).toBe(
      true,
    );
    expect(transcriptShowsRead(TRANSCRIPT, { uuid: '86530b9f-2fbe-47cf-8df5-858ffc84b32f', since: ENQUEUED })).toBe(
      false,
    );
  });

  it('a parentUuid naming the uuid is not the message itself', () => {
    expect(transcriptShowsRead(TRANSCRIPT, { uuid: 'dd4c4fa2-9991-4e58-9856-a32e3a97f969', since: 0 })).toBe(false);
  });

  it('without a uuid, matches the exact words handed to the model at or after the enqueue', () => {
    expect(transcriptShowsRead(TRANSCRIPT, { text: '크론 stage0 트리거해줘야함', since: ENQUEUED })).toBe(true);
    // Before it was even sent: some earlier message with the same words.
    expect(transcriptShowsRead(TRANSCRIPT, { text: '크론 stage0 트리거해줘야함', since: ENQUEUED + 60_000 })).toBe(
      false,
    );
    expect(transcriptShowsRead(TRANSCRIPT, { text: '처리중인거 보여줘야함', since: ENQUEUED })).toBe(false);
    expect(transcriptShowsRead(TRANSCRIPT, { text: '  ', since: 0 })).toBe(false);
  });

  // PR #1005 review (fable) — a steered message reaches the transcript framed (STEER_MESSAGE_HEADER, SSOT 2026-11-06):
  // the words are the user's, the frame is the host's. Matched by its words, it is still the message itself.
  it('matches the words of a steered message through the frame the host put around them', () => {
    const framed = buildSteerUserMessage({ uuid: 'u-framed', text: '크론 stage0 트리거해줘야함' }).message.content;
    const line = JSON.stringify({
      attachment: { type: 'queued_command', prompt: framed, source_uuid: 'u-framed' },
      type: 'attachment',
      uuid: 'a-framed',
      timestamp: '2026-11-03T08:25:37.687Z',
    });
    expect(transcriptShowsRead(`${line}\n`, { text: '크론 stage0 트리거해줘야함', since: ENQUEUED })).toBe(true);
    expect(transcriptShowsRead(`${line}\n`, { text: 'stage0', since: ENQUEUED })).toBe(false);
  });
});

describe('restartCutVerdict', () => {
  it('read only on the transcript’s word', () => {
    expect(restartCutVerdict(row(), () => TRANSCRIPT)).toBe('read');
    expect(restartCutVerdict(row({ cutSteerUuid: '60a8f6c6-c37c-4540-9a67-033f078dc289' }), () => TRANSCRIPT)).toBe(
      'read',
    );
    expect(
      restartCutVerdict(row({ message: { ...row().message, text: '처리중인거 보여줘야함' } }), () => TRANSCRIPT),
    ).toBe('unread');
  });

  it('asks the transcript for a row an older build took out of steered on a crash (review R1, astra P1)', () => {
    const legacy = row({ state: 'paused', stateReason: 'process restart — 모델이 읽었는지 미확인' });
    expect(restartCutVerdict(legacy, () => TRANSCRIPT)).toBe('read');
    expect(restartCutVerdict({ ...legacy, message: { ...legacy.message, text: '다른 말' } }, () => TRANSCRIPT)).toBe(
      'unread',
    );
  });

  it('sends it when no transcript answers, and never asks for a row that only waited', () => {
    expect(restartCutVerdict(row(), () => undefined)).toBe('unread');
    let read = false;
    const reader = () => {
      read = true;
      return TRANSCRIPT;
    };
    expect(restartCutVerdict(row({ state: 'paused', stateReason: 'process restart' }), reader)).toBe('unread');
    expect(read).toBe(false);
  });
});
