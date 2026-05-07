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
  it('ships the 4-color env badge palette', () => {
    expect(DASHBOARD_TS).toContain('#5DADE2');
    expect(DASHBOARD_TS).toContain('#48C9B0');
    expect(DASHBOARD_TS).toContain('#F4D03F');
    expect(DASHBOARD_TS).toContain('#EC7063');
  });

  it('exposes getEnvBadgeColor for renderCard', () => {
    expect(DASHBOARD_TS).toContain('function getEnvBadgeColor');
  });

  it('renderCard suppresses the env badge when only one env is in the cache', () => {
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

  it('updateTokenStats suppresses the tooltip when fewer than 2 envs are present', () => {
    expect(DASHBOARD_TS).toContain('envNames.length < 2');
  });

  it('CSS `.env-badge` rule is present in the inline style block', () => {
    expect(DASHBOARD_TS).toContain('.card .card-meta .env-badge');
  });
});
