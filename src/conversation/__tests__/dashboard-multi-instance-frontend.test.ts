/**
 * Static structure tests for #814 — multi-instance dashboard frontend.
 *
 * Same pattern as `dashboard-topbar-mobile.test.ts` (read the rendered
 * dashboard source, assert structural invariants). Cheap to run and
 * catches regressions where someone refactors the inline JS/CSS bundle
 * and accidentally drops a piece the multi-instance UI depends on.
 *
 * The actual DOM behaviour (badge colour, tooltip suppression on
 * single-env, tap-toggle on touch) is exercised by Playwright dashboard
 * tests; these tests only verify the bundle ships the bits.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

describe('Dashboard multi-instance frontend (#814)', () => {
  // Tone pass P5 / D8b D-15: the palette is four token tones (not hex), and the badge is the kit's toned chip
  // (@2lab.ai/ui 0.15.0 .ui-chip.is-toned.is-sm) — the tone at 14% into the card, the word 70% toward the ink
  // (≥ 4.5:1 in both themes; white on the old #F4D03F was 1.5:1), the border 28% — drawn by the kit, not the page.
  it('ships the 4-tone env badge palette from tokens, drawn as the kit’s toned chip', () => {
    expect(DASHBOARD_TS).toContain(
      "var ENV_BADGE_PALETTE = ['var(--st-run)', 'var(--green)', 'var(--purple)', 'var(--orange)'];",
    );
    expect(DASHBOARD_TS).toContain(
      `envHtml = '<span class="ui-chip is-toned is-sm" style="--ui-tone:' + envColor + '" title="' + escAttr(instName + ' (' + envHostPort + ')') + '">' + esc(instName) + '</span>';`,
    );
    // The page's own chip rule is gone; the kit the page inlines (ui-lib.ts uiLibKitCss) has the toned chip.
    for (const gone of ['.env-badge', '--env-tone', 'color-mix(in srgb, var(--env-tone'])
      expect(DASHBOARD_TS, gone).not.toContain(gone);
    expect(DASHBOARD_TS).not.toContain('#F4D03F');
    const kit = readFileSync(
      join(__dirname, '..', '..', '..', 'node_modules', '@2lab.ai', 'ui', 'dist', 'ui-kit.css'),
      'utf-8',
    );
    expect(kit).toContain('.ui-chip.is-toned {');
    expect(kit).toContain('background: color-mix(in srgb, var(--ui-tone, var(--ui-ib-muted)) 14%, var(--ui-ib-card));');
    expect(kit).toContain('color: color-mix(in srgb, var(--ui-tone, var(--ui-ib-muted)) 70%, var(--ui-ib-text));');
    expect(kit).toMatch(/\.ui-chip\.is-sm \{[^}]*height: 20px/);
  });

  it('exposes getEnvBadgeColor for renderCardBody', () => {
    expect(DASHBOARD_TS).toContain('function getEnvBadgeColor');
  });

  it('renderCardBody suppresses the env badge when only one env is in the cache', () => {
    // The condition `_envCount() > 1` is the gate. Drop it and a
    // single-instance deploy gets a meaningless badge on every card.
    expect(DASHBOARD_TS).toContain('_envCount() > 1');
  });

  it('hands the stats strip a token breakdown on the 토큰 figure (D2 B-04: <ui-stat-strip> breakdown)', () => {
    // The per-instance breakdown is data: a title and one row per env plus the total, in the figure's format.
    expect(DASHBOARD_TS).toContain("rows.push({ label: '합계', value: totalTokens });");
    expect(DASHBOARD_TS).toContain("next = { title: '보드 세션 기준', rows: rows };");
    expect(DASHBOARD_TS).toContain('if (_tokenBreakdown) tokens.breakdown = _tokenBreakdown;');
    // It repaints the strip only when the breakdown changed (it runs on every board render).
    expect(DASHBOARD_TS).toContain('if (JSON.stringify(next) === JSON.stringify(_tokenBreakdown)) return;');
    // The old wrap / inline tooltip are gone.
    expect(DASHBOARD_TS).not.toContain('stat-tokens-wrap');
    expect(DASHBOARD_TS).not.toContain('stat-tokens-tooltip');
  });

  it('touch still reaches the breakdown: the strip figure is a button whose press toggles the card (D2 B-04)', () => {
    // <ui-stat-strip> makes a figure with a breakdown a button; a press toggles its tooltip (touch too), and
    // <ui-bar-chart> holds a tapped bar's tooltip itself — the page keeps no tap rule of its own.
    expect(DASHBOARD_TS).not.toContain('initTooltipTap');
    expect(DASHBOARD_TS).not.toContain('_tapTip');
  });

  it('updateTokenBreakdown suppresses the breakdown when fewer than 2 envs are present', () => {
    expect(DASHBOARD_TS).toContain('function updateTokenBreakdown()');
    // Fewer than two envs: no breakdown (a plain figure, no tooltip, no tab stop).
    expect(DASHBOARD_TS).toContain('var next = null;');
    expect(DASHBOARD_TS).toContain('if (envNames.length >= 2) {');
  });

  it('no CSS rule of the page’s own for the badge — the open card’s body (a light-DOM slot of <ui-agent-inbox>) takes the kit’s classes', () => {
    expect(DASHBOARD_TS).not.toContain('.card-body .card-refs .env-badge');
    expect(DASHBOARD_TS).toContain(
      "/* ── ENV BADGE — multi-instance origin tag (#814): the kit's toned chip (.ui-chip.is-toned.is-sm, D8b D-15)",
    );
  });

  // PR #815 review #1 — sibling cards must not invite action clicks.
  it('renderCardBody suppresses action buttons on sibling cards (env mismatch)', () => {
    // The bundle must declare SELF_INSTANCE_NAME and the isSibling check.
    expect(DASHBOARD_TS).toContain('SELF_INSTANCE_NAME');
    expect(DASHBOARD_TS).toContain('s.environment.instanceName !== SELF_INSTANCE_NAME');
    // The disabled placeholder uses the redirect arrow (\u2192) so the
    // user sees `Stop -> mac-mini-dev` instead of a live button.
    expect(DASHBOARD_TS).toContain('\\u2192');
  });

  it('renderDashboardPage injects SELF_INSTANCE_NAME from server config', () => {
    // Source-line check that the constant comes from initSelfInstance,
    // not a hardcoded null. Catches regressions where someone simplifies
    // the template and drops the dynamic injection.
    expect(DASHBOARD_TS).toContain('SELF_INSTANCE_NAME = ${initSelfInstance}');
    expect(DASHBOARD_TS).toContain('initSelfInstance =');
  });
});
