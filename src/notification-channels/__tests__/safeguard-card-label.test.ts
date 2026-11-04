/**
 * ssot-task: T4 — the turn card says "세이프가드 에러", not "오류 발생".
 *
 * The card keeps category `Exception` (red, full error body, no feedback
 * buttons, excluded from the completion tracker); only the label and the
 * emoji change, keyed on `errorKind: 'safeguard'`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
  },
}));

import { getTurnEventEmoji, getTurnEventLabel, type TurnCompletionEvent } from '../../turn-notifier';
import { SlackBlockKitChannel } from '../slack-block-kit-channel';

function event(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'Exception',
    userId: 'U123',
    channel: 'C123',
    threadTs: '123.456',
    durationMs: 0,
    message: '세이프가드 에러 — Anthropic safeguards가 이 요청을 차단했습니다',
    ...overrides,
  };
}

function cardText(api: { postMessage: ReturnType<typeof vi.fn> }): string {
  const call = api.postMessage.mock.calls[0];
  const blocks = call[2]?.attachments?.[0]?.blocks ?? call[2]?.blocks ?? [];
  return blocks.map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '').join('\n');
}

describe('safeguard turn card label (T4)', () => {
  it('getTurnEventLabel / getTurnEventEmoji name the safeguard error', () => {
    expect(getTurnEventLabel(event({ errorKind: 'safeguard' }))).toBe('세이프가드 에러');
    expect(getTurnEventEmoji(event({ errorKind: 'safeguard' }))).toBe('🛡️');
  });

  it('other Exception cards keep "오류 발생"', () => {
    expect(getTurnEventLabel(event())).toBe('오류 발생');
    expect(getTurnEventEmoji(event())).toBe('🔴');
  });

  it('the Slack card header reads "세이프가드 에러"', async () => {
    const api = { postMessage: vi.fn().mockResolvedValue(undefined) };
    await new SlackBlockKitChannel(api).send(event({ errorKind: 'safeguard' }));
    const text = cardText(api);
    expect(text).toContain('세이프가드 에러');
    expect(text).not.toContain('오류 발생');
  });
});
