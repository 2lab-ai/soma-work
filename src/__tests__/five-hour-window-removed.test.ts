/**
 * The 5-hour usage window is gone (owner, 2026-11-04: "이제 5시간 사용량 있는
 * 프로바이더가 없어짐"; 2026-11-10: "llmux에서도 완전히 삭제해주고, soma-work에서도
 * 완전히 삭제해줘"). A reading that still arrives — an older llmux daemon, an
 * operator config.json seeded before the removal — is ignored, never an error.
 */

import { describe, expect, it } from 'vitest';
import type { LlmuxAccount } from '../auth/llmux-client';
import { accountLines, groupSummary } from '../slack/auth/capacity';
import { normalizeUiSurfacesConfig } from '../slack/surface-config';

const NOW_MS = Date.parse('2026-11-10T00:00:00Z');
const NOW_S = NOW_MS / 1000;

/** A stale 5h reading as an older llmux would still carry it. */
const LEGACY_FIVE = { utilization: 1, resets_at: NOW_S + 3600, resets_in_secs: 3600 };

function llmuxAccount(over: Partial<LlmuxAccount> & Record<string, unknown> = {}): LlmuxAccount {
  return {
    name: 'claude:ai1@example.com',
    type: 'oauth',
    group: 'claude',
    status: 'ok',
    order: 1,
    blocked: null,
    seven_day: { utilization: 0.4, resets_at: NOW_S + 3 * 86400, resets_in_secs: 3 * 86400 },
    ...over,
  } as LlmuxAccount;
}

describe('5h window removed — llmux status', () => {
  it('a stale 5h reading from an older llmux does not mark the account unavailable on the Slack auth card', () => {
    const account = llmuxAccount({ five_hour: { ...LEGACY_FIVE, utilization: 1 } });
    const lines = [...groupSummary([account], NOW_MS), ...accountLines(account, NOW_MS)].join('\n');
    expect(lines).toContain('공통 한도 여유 1/1');
  });
});

describe('5h window removed — turn notification surface', () => {
  it('a config.json seeded before the removal still loads: its fivehour entry is dropped without a warning', () => {
    const { config, warnings } = normalizeUiSurfacesConfig({
      turnend: {
        lines: [
          [
            { field: 'duration', label: 'Dur' },
            { field: 'fivehour', label: '5h', bar: { width: 6 } },
            { field: 'sevenday', label: '7d' },
          ],
        ],
      },
    });
    expect(warnings).toEqual([]);
    expect(config.turnend?.lines?.[0].fields.map((f) => f.field)).toEqual(['duration', 'sevenday']);
  });
});
