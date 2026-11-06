import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from '../action-panel-builder';

/**
 * #1031 ⑤ — a sleeping session's header says it sleeps.
 *
 * After 24h idle the session goes to SLEEPING: a 💤 reaction and a notice are
 * posted, but the header kept reading "⚪ 사용 가능 · 사용자 액션 대기"
 * (2026-11-06: two 11-05 threads). The header now states the sleep and what
 * wakes it — the same words as the sleep notice.
 */

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function rail(params: Partial<Parameters<typeof ActionPanelBuilder.build>[0]>): string {
  const payload = ActionPanelBuilder.build({ sessionKey: 'C1:1700.000000', now: NOW, ...params });
  return payload.blocks[0].text.text as string;
}

describe('ActionPanelBuilder — Sleep state (#1031 ⑤)', () => {
  it('replaces 사용 가능 with the sleep badge and what wakes it', () => {
    const out = rail({
      sleeping: true,
      activityState: 'idle',
      agentPhase: '사용자 액션 대기',
      lastProgressAt: NOW - 5 * DAY,
    });
    const firstLine = out.split('\n')[0];

    expect(firstLine.startsWith('💤 *Sleep*')).toBe(true);
    expect(firstLine).toContain('메시지를 보내면 이어서 진행');
    expect(firstLine).toContain('마지막 활동 <!date^');
    expect(out).not.toContain('사용 가능');
    expect(out).not.toContain('사용자 액션 대기');
  });

  it('shows the sleep even with no progress ever recorded', () => {
    const out = rail({ sleeping: true });

    expect(out.split('\n')[0]).toContain('💤 *Sleep* · 메시지를 보내면 이어서 진행');
  });

  it('a closed session reads closed, not asleep', () => {
    const payload = ActionPanelBuilder.build({ sessionKey: 'C1:1700.000000', now: NOW, closed: true, sleeping: true });
    const all = JSON.stringify(payload.blocks);

    expect(all).toContain('종료');
    expect(all).not.toContain('Sleep');
  });

  it('an awake session is unchanged', () => {
    const out = rail({
      disabled: false,
      activityState: 'idle',
      agentPhase: '사용자 액션 대기',
      lastProgressAt: NOW - 1000,
    });

    expect(out.split('\n')[0].startsWith('⚪ *사용 가능* · 사용자 액션 대기')).toBe(true);
  });
});
