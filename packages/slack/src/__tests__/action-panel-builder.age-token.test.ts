import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from '../action-panel-builder';

/**
 * #1031 ④ — the header's ages must not freeze.
 *
 * The header is posted once and stays until the next render — for a finished
 * session that is days. A baked "마지막 활동 5분 전" was still on screen five
 * days later (2026-11-06: an 11-05 thread read "23초 전"). The ages are Slack
 * date tokens instead: Slack renders `{ago}` at view time, in the viewer's own
 * locale. The fallback — notifications, clients without token support — is
 * the ABSOLUTE time, which cannot go stale.
 */

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function rail(params: Partial<Parameters<typeof ActionPanelBuilder.build>[0]>): string {
  const payload = ActionPanelBuilder.build({ sessionKey: 'C1:1700.000000', now: NOW, ...params });
  return payload.blocks[0].text.text as string;
}

function token(atMs: number): string {
  const sec = Math.floor(atMs / 1000);
  return `<!date^${sec}^{ago}|${new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}>`;
}

describe('ActionPanelBuilder — ages are Slack date tokens (#1031 ④)', () => {
  it('states the last real progress as a date token, not a baked age', () => {
    const out = rail({ activityState: 'working', agentPhase: '코드 수정 중', lastProgressAt: NOW - 5 * MINUTE });

    expect(out).toContain(`마지막 활동 ${token(NOW - 5 * MINUTE)}`);
    expect(out).not.toMatch(/\d+(초|분|시간|일) 전/);
  });

  it('states the liveness signal as a date token too', () => {
    const out = rail({
      activityState: 'working',
      agentPhase: '코드 수정 중',
      lastProgressAt: NOW - 12 * MINUTE,
      lastSignalAt: NOW - 5 * SECOND,
    });

    expect(out).toContain(`응답 신호 ${token(NOW - 5 * SECOND)}`);
    expect(out).not.toMatch(/\d+(초|분|시간|일) 전/);
  });

  it('falls back to the absolute time, never a relative one', () => {
    const out = rail({ activityState: 'working', lastProgressAt: NOW - 3 * SECOND });
    const fallback = /<!date\^\d+\^\{ago\}\|([^>]+)>/.exec(out)?.[1];

    expect(fallback).toBe('2023-11-14T22:13:17Z');
  });

  it('clamps a stamp from the future (clock skew) to now', () => {
    const out = rail({ activityState: 'working', lastProgressAt: NOW + 30 * SECOND });

    expect(out).toContain(`마지막 활동 ${token(NOW)}`);
  });

  it('still says the progress is unknown when there is none', () => {
    const out = rail({ activityState: 'working', agentPhase: '코드 수정 중' });

    expect(out).toContain('실제 활동 기록 없음');
    expect(out).not.toContain('<!date^');
  });
});
