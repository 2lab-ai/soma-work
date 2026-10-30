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
  // Tone pass P5: the palette is four token tones (not hex), and the badge is a tint chip — the
  // tone at 14% into the card, the word 70% toward the ink (≥ 4.5:1 in both themes; white on the
  // old #F4D03F was 1.5:1).
  it('ships the 4-tone env badge palette from tokens, drawn as a tint chip', () => {
    expect(DASHBOARD_TS).toContain(
      "var ENV_BADGE_PALETTE = ['var(--st-run)', 'var(--green)', 'var(--purple)', 'var(--orange)'];",
    );
    expect(DASHBOARD_TS).toContain(`style="--env-tone:' + envColor + '"`);
    expect(DASHBOARD_TS).toContain('background: color-mix(in srgb, var(--env-tone, var(--ib-muted)) 14%, var(--ib-card));');
    expect(DASHBOARD_TS).toContain('color: color-mix(in srgb, var(--env-tone, var(--ib-muted)) 70%, var(--ib-text));');
    expect(DASHBOARD_TS).not.toContain('#F4D03F');
  });

  it('exposes getEnvBadgeColor for renderCardBody', () => {
    expect(DASHBOARD_TS).toContain('function getEnvBadgeColor');
  });

  it('renderCardBody suppresses the env badge when only one env is in the cache', () => {
    // The condition `_envCount() > 1` is the gate. Drop it and a
    // single-instance deploy gets a meaningless badge on every card.
    expect(DASHBOARD_TS).toContain('_envCount() > 1');
  });

  it('exposes a topbar tokens tooltip wrap with breakdown attribute', () => {
    expect(DASHBOARD_TS).toContain('id="stat-tokens-wrap"');
    expect(DASHBOARD_TS).toContain('id="stat-tokens-tooltip"');
    expect(DASHBOARD_TS).toContain('data-has-breakdown');
  });

  it('mobile tap-toggle uses (hover: none) media query', () => {
    expect(DASHBOARD_TS).toContain('@media (hover: none)');
    expect(DASHBOARD_TS).toContain("matchMedia('(hover: none)')");
  });

  it('updateTokenBreakdown suppresses the tooltip when fewer than 2 envs are present', () => {
    expect(DASHBOARD_TS).toContain('function updateTokenBreakdown()');
    expect(DASHBOARD_TS).toContain('envNames.length < 2');
  });

  it('CSS `.env-badge` rule is present in the inline style block', () => {
    // The open card's body is the page's (a light-DOM slot of <ui-agent-inbox>): its
    // rules are scoped by .card-body, not by the old inline .card.
    expect(DASHBOARD_TS).toContain('.card-body .card-refs .env-badge');
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
