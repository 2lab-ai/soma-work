/**
 * Static structure tests for #800 — dashboard topbar mobile horizontal
 * overflow fix.
 *
 * These tests cannot prove zero scroll-overflow at runtime (that requires a
 * real browser; see scripts/screenshot-dashboard.ts for the live assertion).
 * What they CAN do — and what guards against regression — is verify that
 * every structural piece the fix depends on is still in the rendered HTML
 * and CSS:
 *
 *   - ws-badge has role="status" + aria-label so screen readers still hear
 *     state when the badge collapses to a 10px dot at ≤680px;
 *   - user-pill prefix and admin-mode-label are wrapped in dedicated spans
 *     so CSS can hide the prefix without losing the dynamic state;
 *   - the @media (max-width: 480px) breakpoint exists with the expected
 *     rules, AND the @media (max-width: 680px) block carries the dot/pill
 *     reduction rules added by this fix.
 *
 * Anything in this list silently disappearing is a regression.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Read the source file directly. Importing the module would pull in the
// full server stack (fastify, recorder, etc.) which is overkill for a
// pure string-shape assertion.
const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

describe('dashboard topbar mobile overflow fix (#800)', () => {
  describe('HTML structure', () => {
    it('ws-badge has role="status" and aria-label so dot-collapsed state is announced', () => {
      expect(DASHBOARD_TS).toContain(
        '<span class="ws-badge" id="ws-status" role="status" aria-label="WebSocket: Connecting">',
      );
    });

    it('user-pill prefix is a dedicated span that CSS can hide at narrow viewports', () => {
      expect(DASHBOARD_TS).toContain('<span class="user-pill-prefix">Logged in as </span>');
    });

    it('admin-mode-label is split into prefix + state spans', () => {
      expect(DASHBOARD_TS).toContain(
        '<span id="admin-mode-label"><span class="admin-mode-prefix">Admin: </span><span class="admin-mode-state">OFF</span></span>',
      );
    });
  });

  describe('CSS — base flex-shrink cascade (all viewports)', () => {
    it('.topbar has min-width: 0 to allow children to shrink', () => {
      // Rule appears inside the .topbar block declared right after the
      // "TOPBAR — strict horizontal grid" comment.
      const topbarBlock = DASHBOARD_TS.match(/TOPBAR — strict horizontal grid[\s\S]*?\.topbar\s*\{[^}]*\}/);
      expect(topbarBlock).not.toBeNull();
      expect(topbarBlock?.[0]).toContain('min-width: 0');
    });

    it('.topbar .nav has min-width: 0', () => {
      expect(DASHBOARD_TS).toMatch(/\.topbar\s+\.nav\s*\{[^}]*min-width:\s*0/);
    });

    it('.topbar .nav select has clamp() inline-size + min-width: 0', () => {
      expect(DASHBOARD_TS).toContain('.topbar .nav select { min-width: 0; inline-size: clamp(72px, 24vw, 140px); }');
    });

    it('.topbar .user-pill b uses ellipsis + max-width: 100% so long names shrink', () => {
      // Match against the rule block following ".topbar .user-pill b".
      const m = DASHBOARD_TS.match(/\.topbar\s+\.user-pill\s+b\s*\{[^}]*\}/);
      expect(m).not.toBeNull();
      const block = m?.[0] ?? '';
      expect(block).toContain('text-overflow: ellipsis');
      expect(block).toContain('max-width: 100%');
      expect(block).toContain('white-space: nowrap');
      expect(block).toContain('display: inline-block');
    });
  });

  describe('CSS — @media (max-width: 680px) extensions', () => {
    // Capture just the 680px block so other media queries can't satisfy
    // these by accident.
    const block680 = DASHBOARD_TS.match(/@media \(max-width: 680px\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    it('block exists', () => {
      expect(block680).not.toBe('');
    });

    it('ws-badge collapses to 10px round dot via text-indent trick', () => {
      expect(block680).toContain('inline-size: 10px');
      expect(block680).toContain('block-size: 10px');
      expect(block680).toContain('border-radius: 50%');
      expect(block680).toContain('text-indent: 100%');
    });

    it('user-pill-prefix is hidden at ≤680px (icon-only pill)', () => {
      expect(block680).toContain('.topbar .user-pill-prefix { display: none; }');
    });

    it('user-pill caps at 140px so it cannot push the row past the viewport', () => {
      expect(block680).toMatch(/\.topbar\s+\.user-pill\s*\{\s*max-width:\s*140px/);
    });

    it('theme-toggle becomes a 32px square (no padding) at ≤680px', () => {
      expect(block680).toMatch(/#theme-toggle\s*\{[^}]*inline-size:\s*32px[^}]*block-size:\s*32px/);
    });
  });

  describe('CSS — new @media (max-width: 480px) block', () => {
    const block480 = DASHBOARD_TS.match(/@media \(max-width: 480px\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    it('block exists', () => {
      expect(block480).not.toBe('');
    });

    it('topbar h1 shrinks via flex-shrink: 1 + ellipsis', () => {
      expect(block480).toContain('flex-shrink: 1');
      expect(block480).toContain('text-overflow: ellipsis');
    });

    it('user-pill caps at 100px at ≤480px', () => {
      expect(block480).toMatch(/\.topbar\s+\.user-pill\s*\{\s*max-width:\s*100px/);
    });

    it('admin-mode-prefix is hidden at ≤480px (state-only "ON" / "OFF")', () => {
      expect(block480).toContain('.topbar .admin-mode-prefix { display: none; }');
    });

    it('select drops to clamp(60px, 22vw, 100px)', () => {
      expect(block480).toContain('inline-size: clamp(60px, 22vw, 100px)');
    });
  });

  describe('JS — admin-mode renderer writes to state span', () => {
    it('_renderAdminModeButton queries .admin-mode-state and writes ON/OFF only', () => {
      // The function must update the state span (not the whole label) so
      // hiding the prefix at ≤480px doesn't blank the label entirely.
      expect(DASHBOARD_TS).toMatch(
        /_renderAdminModeButton[\s\S]*?querySelector\('\.admin-mode-state'\)[\s\S]*?textContent\s*=\s*on\s*\?\s*'ON'\s*:\s*'OFF'/,
      );
    });

    it('_renderAdminModeButton has flat-textContent fallback when state span is absent', () => {
      // Guards legacy templates / unit-test setups that didn't render the
      // split spans yet.
      expect(DASHBOARD_TS).toMatch(
        /_renderAdminModeButton[\s\S]*?else\s+lbl\.textContent\s*=\s*on\s*\?\s*'Admin: ON'\s*:\s*'Admin: OFF'/,
      );
    });
  });

  describe('JS — connectWs handlers maintain title + aria-label', () => {
    it('onopen sets aria-label="WebSocket: Live"', () => {
      expect(DASHBOARD_TS).toMatch(/ws\.onopen[\s\S]*?statusEl\.setAttribute\('aria-label',\s*'WebSocket: Live'\)/);
    });

    it('onopen sets title="WebSocket: Live"', () => {
      expect(DASHBOARD_TS).toMatch(/ws\.onopen[\s\S]*?statusEl\.title\s*=\s*'WebSocket: Live'/);
    });

    it('onclose sets aria-label="WebSocket: Reconnecting"', () => {
      expect(DASHBOARD_TS).toMatch(
        /ws\.onclose[\s\S]*?statusEl\.setAttribute\('aria-label',\s*'WebSocket: Reconnecting'\)/,
      );
    });

    it('onclose sets title="WebSocket: Reconnecting"', () => {
      expect(DASHBOARD_TS).toMatch(/ws\.onclose[\s\S]*?statusEl\.title\s*=\s*'WebSocket: Reconnecting'/);
    });
  });

  describe('Anti-regression: avoided side-effects', () => {
    it('does NOT add html, body { overflow-x: hidden } — width is fitted directly', () => {
      // Hiding overflow would mask future regressions. The fix relies on
      // making everything actually fit, not on hiding the consequence.
      expect(DASHBOARD_TS).not.toMatch(/html\s*,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
      expect(DASHBOARD_TS).not.toMatch(/body\s*,\s*html\s*\{[^}]*overflow-x:\s*hidden/);
    });
  });
});
