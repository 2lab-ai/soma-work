import { describe, expect, it } from 'vitest';
import type { LlmuxAccount, LlmuxStatus } from '../../../auth/llmux-client';
import { buildAuthCardBlocks } from '../builder';

const nowMs = 1_900_000_000_000;
const runtime = { mode: 'llmux' as const, llmux: { baseUrl: 'http://localhost:3456', apiKey: 'secret' } };
const window = (utilization: number, seconds = 3600) => ({
  utilization,
  resets_at: nowMs / 1000 + seconds,
  resets_in_secs: seconds,
});
function account(name: string, group: string, extra: Partial<LlmuxAccount> = {}): LlmuxAccount {
  return {
    name,
    group,
    type: group === 'codex' ? 'codex' : 'oauth',
    status: 'ok',
    order: 1,
    five_hour: window(0.25),
    seven_day: window(0.5, 86400),
    ...extra,
  };
}
function render(accounts: LlmuxAccount[], page = 0, viewerMode: 'admin' | 'readonly' = 'readonly') {
  const status: LlmuxStatus = { current: 'ai1', current_by_group: { claude: 'ai1', codex: 'codex1' }, accounts };
  return buildAuthCardBlocks({ runtime, llmuxStatus: status, viewerMode, nowMs, page });
}
function text(blocks: unknown[]) {
  return JSON.stringify(blocks);
}

describe('T1/T2 auth capacity planning', () => {
  it('groups Claude → Codex → Grok then unknown groups, independent of incoming order', () => {
    const accounts = [
      account('grok1', 'grok'),
      account('codex1', 'codex'),
      account('ai2', 'claude', { order: 2 }),
      account('ai1', 'claude'),
      account('other1', 'other'),
    ];
    const original = structuredClone(accounts);
    const content = text(render(accounts));
    expect(content.indexOf('*Claude*')).toBeLessThan(content.indexOf('*Codex*'));
    expect(content.indexOf('*Codex*')).toBeLessThan(content.indexOf('*Grok*'));
    expect(content.indexOf('*ai1*')).toBeLessThan(content.indexOf('*ai2*'));
    expect(accounts).toEqual(original);
  });

  it('labels normalized totals, measured coverage, remaining percent and absolute reset', () => {
    const content = text(render([account('ai1', 'claude'), account('ai2', 'claude')]));
    expect(content).toContain('1.50계정분');
    expect(content).toContain('측정 2/2');
    expect(content).toContain('잔여 75%');
    expect(content).toContain('<!date^1900003600^');
    expect(content).toContain('1h');
    expect(content).toContain('다음 리셋');
    expect(content).toContain('+25%p');
    expect(content).toContain('토큰 수가 아닙니다');
  });

  it('does not invent remaining tokens from consumed token telemetry', () => {
    const content = text(
      render([
        account('grok1', 'grok', {
          five_hour: null,
          seven_day: null,
          totals: { requests: 5, input_tokens: 1000, output_tokens: 50 },
        }),
      ]),
    );
    expect(content).toContain('잔여량 미제공');
    expect(content).toContain('누적 사용');
    expect(content).toContain('1,000');
    expect(content).not.toContain('잔여 0%');
    expect(content).not.toContain('Infinity');
  });

  it('marks expired and malformed windows unknown rather than replenishing or throwing', () => {
    const content = text(
      render([
        account('ai1', 'claude', {
          five_hour: window(0.9, -1),
          seven_day: { utilization: Number.NaN, resets_at: Number.NaN, resets_in_secs: -1 },
        }),
      ]),
    );
    expect(content).toContain('재조회 필요');
    expect(content).not.toContain('잔여 100%');
    expect(content).not.toContain('Invalid Date');
    expect(content).not.toContain('NaN');
    expect(content).not.toContain('다음 리셋:');
  });

  it('keeps cooldown, auth failure and overlapping exhausted windows out of available count', () => {
    const content = text(
      render([
        account('ai1', 'claude', { five_hour: window(1, 60), seven_day: window(1, 3600) }),
        account('ai2', 'claude', { status: 'cooldown', cooldown_until: nowMs / 1000 + 600 }),
        account('ai3', 'claude', { status: 'auth_failed' }),
      ]),
    );
    expect(content).toContain('공통 한도 여유 0/3');
    expect(content).toContain('쿨다운');
    expect(content).toContain('인증 실패');
    expect(content).toContain('다른 한도');
  });

  it('never presents Grok synthetic reset as a five-hour subscription reset', () => {
    const content = text(render([account('grok1', 'grok', { five_hour: window(0.4, 60) })]));
    expect(content).toContain('속도 한도');
    expect(content).not.toContain('다음 리셋:');
    expect(content).not.toContain('<!date^1900000060^');
    expect(content).not.toContain('5h 잔여');
    expect(content).toContain('리셋 시각 미제공');
  });

  it('falls back to relative reset only when absolute time is missing, never when expired', () => {
    const content = text(
      render([account('ai1', 'claude', { five_hour: { utilization: 0.4, resets_at: 0, resets_in_secs: 120 } })]),
    );
    expect(content).toContain('<!date^1900000120^');
  });

  it('paginates large pools without dropping accounts or overflowing Slack blocks', () => {
    const accounts = Array.from({ length: 70 }, (_, n) =>
      account(`ai${n + 1}`, ['claude', 'codex', 'grok'][n % 3], { order: n + 1 }),
    );
    const names = new Set<string>();
    for (let page = 0; page < Math.ceil(accounts.length / 8); page++) {
      const blocks = render(accounts, page, 'admin');
      expect(blocks.length).toBeLessThanOrEqual(47);
      const content = text(blocks);
      expect(content).toContain('auth_page');
      for (const item of accounts) if (content.includes(`*${item.name}* —`)) names.add(item.name);
      for (const block of blocks) {
        const value = (block as { text?: { text?: string } }).text?.text;
        if (value) expect(value.length).toBeLessThanOrEqual(3000);
      }
    }
    expect(names.size).toBe(70);
  });

  it('keeps all provider totals visible even when the first page contains only Claude accounts', () => {
    const accounts = [
      ...Array.from({ length: 12 }, (_, n) => account(`ai${n + 1}`, 'claude', { order: n + 1 })),
      account('codex1', 'codex'),
      account('grok1', 'grok'),
    ];
    for (const page of [0, 1]) {
      const content = text(render(accounts, page));
      for (const provider of ['Claude', 'Codex', 'Grok']) expect(content).toContain(`*${provider}*`);
      expect(content).toContain('9.00계정분');
    }
  });

  it('localizes snapshot time and does not label Grok as a depleted subscription', () => {
    const content = text(render([account('grok1', 'grok', { five_hour: window(0.4, 60) })]));
    expect(content).toContain('조회 <!date^1900000000^');
    expect(content).not.toContain('5h·7d 확인');
    expect(content).not.toContain('공통 한도 여유 0/1');
    expect(content).toContain('속도 한도 측정 1/1');
  });

  it('does not hide failed health behind current_by_group selection', () => {
    const content = text(render([account('ai1', 'claude', { status: 'auth_failed' })]));
    expect(content).toContain('인증 실패');
    expect(content).not.toContain('✅ *ai1*');
  });

  it('surfaces Codex reset credits as counts, preserving zero versus unknown and stale failures', () => {
    const content = text(
      render([
        account('codex1', 'codex', {
          usage_control: {
            available_resets: 2,
            applicable_resets: 0,
            last_refresh_ms: nowMs - 60_000,
            last_error: 'failed',
          },
        }),
        account('codex2', 'codex', { usage_control: {} }),
      ]),
    );
    expect(content).toContain('수동 리셋: 보유 2회 · 현재 적용 가능 0회');
    expect(content).toContain('수동 리셋: 보유 미확인 · 현재 적용 가능 미확인');
    expect(content).toContain('최근 조회 실패');
    expect(content).toContain('자동 사용하지 않습니다');
  });

  it('marks scoped exhaustion separately without promising all-model availability', () => {
    const content = text(
      render([account('ai1', 'claude', { scoped_limits: [{ ...window(1), scope_label: 'Fable', is_active: true }] })]),
    );
    expect(content).toContain('공통 한도 여유 1/1');
    expect(content).toContain('모델별 한도 별도');
    expect(content).toContain('7d-fable 잔여 0%');
  });

  it('escapes upstream Slack mentions and falls back to type for older Codex accounts', () => {
    const content = text(render([account('<!channel>', '', { group: undefined, type: 'codex' })]));
    expect(content).toContain('*Codex*');
    expect(content).not.toContain('<!channel>');
    expect(content).toContain('&lt;!channel&gt;');
  });
});
