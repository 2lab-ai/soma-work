import { describe, expect, it } from 'vitest';
import type { LlmuxAccount, LlmuxWindow } from '../../../auth/llmux-client';
import { groupSummary, remaining, resetAt, windowLine } from '../capacity';

const nowMs = 1_900_000_000_000;
const window = (resets_at: unknown): LlmuxWindow =>
  ({ utilization: 0.4, resets_at, resets_in_secs: 120 }) as LlmuxWindow;

describe('T2 invalid absolute reset must not become a relative forecast', () => {
  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    8.64e12,
    'tomorrow',
  ])('keeps an explicitly invalid absolute reset unknown: %s', (absolute) => {
    const reading = window(absolute);
    expect(resetAt(reading, nowMs)).toBeUndefined();
    expect(remaining(reading, nowMs)).toBeUndefined();
    const line = windowLine('5h', reading, nowMs);
    expect(line).toContain('재조회 필요');
    expect(line).not.toContain('<!date^');
    expect(line).not.toContain('잔여 60%');
    const account: LlmuxAccount = {
      name: 'ai1',
      type: 'oauth',
      group: 'claude',
      status: 'ok',
      order: 1,
      five_hour: reading,
      seven_day: null,
    };
    const summary = groupSummary([account], nowMs).join('\n');
    expect(summary).toContain('5h 잔여량 미제공 · 측정 0/1');
    expect(summary).not.toContain('다음 리셋:');
  });

  it.each([undefined, null, 0])('uses relative fallback only for a missing absolute reset: %s', (absolute) => {
    expect(resetAt(window(absolute), nowMs)).toBe(nowMs / 1000 + 120);
    expect(remaining(window(absolute), nowMs)).toBe(0.6);
  });

  it('does not revive an expired absolute timestamp with a positive relative value', () => {
    const expired = window(nowMs / 1000 - 1);
    expect(resetAt(expired, nowMs)).toBe(nowMs / 1000 - 1);
    expect(remaining(expired, nowMs)).toBeUndefined();
  });
});
