/**
 * The two pictures, as SVG: every label escaped, the headline numbers present,
 * drawn at 2× for sharp text — and the real font + resvg turn them into PNGs.
 */
import { describe, expect, it } from 'vitest';
import type { LlmuxAccount, LlmuxStatus } from '../../../auth/llmux-client';
import { buildCapacityView } from '../../../conversation/capacity-view';
import { buildAccountReport, buildAuthInfographic, describeAuthInfographic } from '../infographic-model';
import { renderAuthReportPng, renderAuthSummaryPng } from '../infographic-publish';
import { buildAccountReportSvg, buildAuthSummarySvg, escapeXml, REPORT_WIDTH, SUMMARY_WIDTH } from '../infographic-svg';

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const D = 86400;
const w = (utilization: number, inSecs: number) => ({ utilization, resets_at: NOW_S + inSecs, resets_in_secs: inSecs });
const acct = (over: Partial<LlmuxAccount> & { name: string }): LlmuxAccount => ({
  type: 'oauth',
  status: 'ok',
  order: 1,
  blocked: null,
  seven_day: null,
  ...over,
});

const status = {
  current: 'claude:a<b>&c@x',
  version: 'llmux 0.2.26 (preview 2026-11-17)',
  current_by_group: { claude: 'claude:a<b>&c@x' },
  accounts: [
    acct({ name: 'claude:a<b>&c@x', group: 'claude', seven_day: w(0.25, 2 * D) }),
    acct({ name: 'claude:ai2@x', group: 'claude', seven_day: w(1, D / 2), blocked: '7d 100.0% > 99%' }),
    acct({ name: 'codex:ai5@x', group: 'codex', type: 'codex', seven_day: w(0.5, 3 * D) }),
    acct({ name: 'grok:ai@x', group: 'grok', type: 'grok' }),
  ],
} as LlmuxStatus;
const view = buildCapacityView(status, {}, NOW_MS);
const info = buildAuthInfographic(status, view, NOW_MS);
const report = buildAccountReport(status, view, NOW_MS);

describe('buildAuthSummarySvg', () => {
  const svg = buildAuthSummarySvg(info);

  it('is drawn at 2× of the logical width', () => {
    expect(svg).toContain(`width="${SUMMARY_WIDTH * 2}"`);
    expect(svg).toContain(`viewBox="0 0 ${SUMMARY_WIDTH} `);
  });

  it('leads with the usable amount, the total, the next return and the clock', () => {
    expect(svg).toContain('LLM 남은 용량');
    expect(svg).toContain('>0.8<'); // Claude: 0.75 usable now
    expect(svg).toContain('/ 2.0 계정분');
    expect(svg).toContain('다음 +1.0 · 내일 05:00');
    expect(svg).toContain('KST 기준');
    expect(svg).toContain('llmux 0.2.26');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('Grok 1계정');
    expect(svg).toContain('토큰 수가 아닙니다');
  });
});

describe('buildAccountReportSvg', () => {
  const svg = buildAccountReportSvg(report);

  it('escapes account names and marks the current account', () => {
    expect(svg).not.toContain('a<b>&c');
    expect(svg).toContain(escapeXml('a<b>&c'));
    expect(svg).toContain('현재');
    expect(svg).toContain(`width="${REPORT_WIDTH * 2}"`);
  });

  it('shows every provider and the weekly-drained account with its return time', () => {
    for (const label of ['Claude', 'Codex', 'Grok']) expect(svg).toContain(`>${label}<`);
    expect(svg).toContain('주간 소진');
    expect(svg).toContain('복귀 내일 05:00');
  });
});

describe('describeAuthInfographic (alt text)', () => {
  it('says the picture in one line per provider', () => {
    const alt = describeAuthInfographic(info);
    expect(alt).toContain('Claude 지금 0.8/2.0 계정분');
    expect(alt).toContain('다음 +1.0 내일 05:00');
    expect(alt.length).toBeLessThanOrEqual(2000);
  });
});

describe('PNG render (bundled font + resvg)', () => {
  it('renders both pictures to PNG', async () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const [summary, accounts] = await Promise.all([renderAuthSummaryPng(info), renderAuthReportPng(report)]);
    expect(summary.subarray(0, 4).equals(sig)).toBe(true);
    expect(accounts.subarray(0, 4).equals(sig)).toBe(true);
  }, 20_000);
});
