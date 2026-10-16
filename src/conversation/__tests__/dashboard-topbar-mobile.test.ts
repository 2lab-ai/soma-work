/**
 * Static structure tests for the dashboard top bar: #800 (no horizontal page
 * overflow on phones) and the responsive top bar that replaced its crushed
 * labels ("Conv", "OFF", "SOMA-W…", text wrapping inside buttons at 820px).
 *
 * These tests cannot prove the layout at runtime (that requires a real
 * browser; scripts/screenshot-agent-inbox.ts `topbarChecks` runs Chromium and
 * WebKit from 360 to 1280px across status × pill name × selected user and
 * asserts no wrapping, hard cuts, overlap or overflow, reachable ≥44px
 * controls and ellipsized names with their full name in title, and
 * scripts/screenshot-dashboard.ts the #800 overflow sweep at 360–680).
 * What they CAN do — and what guards against regression — is verify that
 * every structural piece the layout depends on is still in the HTML and CSS:
 *
 *   - ws-badge has role="status" + aria-label so screen readers still hear
 *     state when the badge collapses to a 10px dot below 640px;
 *   - user-pill prefix and admin-mode-label are wrapped in dedicated spans
 *     so CSS can hide the "Logged in as" prefix without losing the name and
 *     JS can rewrite ON/OFF without losing "Admin: ";
 *   - every control keeps its label on one line (nowrap, flex: none); the
 *     one-row nav never shrinks (so nothing paints into the account group);
 *   - the user select is a visible label (ellipsis) over a transparent native
 *     select whose title carries the full name;
 *   - below 1024px the nav takes its own row; below 640px the select fills it.
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

    it('Conversations is one full label (no short "Conv" variant)', () => {
      expect(DASHBOARD_TS).toContain(
        '<a href="/conversations"><span aria-hidden="true">&#x1F4DD;</span>Conversations</a>',
      );
      expect(DASHBOARD_TS).not.toContain('nav-icon');
    });

    it('the user select is a visible label with the native select laid over it, full name in title', () => {
      expect(DASHBOARD_TS).toContain(
        '<span class="user-select"><span class="user-select-label" id="user-select-label" aria-hidden="true">All Users</span><select id="user-select" title="All Users" onchange="selectUser(this.value)">',
      );
    });

    it('user pill and theme toggle sit in their own account group after the nav', () => {
      const bar = DASHBOARD_TS.match(/<div class="topbar">[\s\S]*?\n {2}<\/div>\n/)?.[0] ?? '';
      const nav = bar.indexOf('<div class="nav">');
      const account = bar.indexOf('<div class="topbar-account">');
      expect(nav).toBeGreaterThan(0);
      expect(account).toBeGreaterThan(nav);
      expect(bar.indexOf('id="user-select"')).toBeGreaterThan(nav);
      expect(bar.indexOf('id="admin-mode-toggle"')).toBeLessThan(account);
      expect(bar.indexOf('id="user-pill"')).toBeGreaterThan(account);
      expect(bar.indexOf('id="theme-toggle"')).toBeGreaterThan(account);
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

    it('the one-row nav never shrinks below its controls (they would paint over the account group)', () => {
      const nav = DASHBOARD_TS.match(/\n\.topbar \.nav \{[^}]*\}/)?.[0] ?? '';
      expect(nav).toContain('flex: none');
      expect(nav).not.toContain('min-width: 0');
      // The account group is what gives way on the one-row bar.
      expect(DASHBOARD_TS).toMatch(/\n\.topbar \.topbar-account \{[^}]*min-width: 0;[^}]*flex: 0 1 auto/);
    });

    it('the user select caps the selected name on the one-row bar; the label ends in an ellipsis', () => {
      // The rule right after its comment (the shared `.topbar .nav a, .topbar .nav .user-select` block comes first).
      const wrap = DASHBOARD_TS.match(/\*\/\n\.topbar \.nav \.user-select \{[^}]*\}/)?.[0] ?? '';
      expect(wrap).toContain('max-inline-size: 180px');
      expect(wrap).toContain('min-width: 0');
      // WebKit passes the ellipsized label's text up as page overflow unless the wrapper clips.
      expect(wrap).toContain('overflow: hidden');
      expect(DASHBOARD_TS).toContain(
        '.topbar .user-select-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }',
      );
      // No native-select sizing: WebKit hard-cuts a native select's text.
      expect(DASHBOARD_TS).not.toContain('field-sizing');
    });

    it('the native select is transparent and covers the whole visible box (every tap and key reaches it)', () => {
      const sel = DASHBOARD_TS.match(/\n\.topbar \.user-select select \{[^}]*\}/)?.[0] ?? '';
      for (const decl of [
        'position: absolute',
        'z-index: 1',
        'inset: 0',
        'inline-size: 100%',
        'block-size: 100%',
        'opacity: 0',
      ])
        expect(sel).toContain(decl);
      // The chevron (a transformed ::after, so a stacking context above the select) must not take the tap.
      const chevron = DASHBOARD_TS.match(/\n\.topbar \.user-select::after \{[^}]*\}/)?.[0] ?? '';
      expect(chevron).toContain('transform: rotate(45deg)');
      expect(chevron).toContain('pointer-events: none');
      expect(DASHBOARD_TS).toContain('.topbar .user-select:has(select:focus-visible) {');
    });

    it('nav links, select, admin toggle and status badge never wrap or shrink their label', () => {
      const navBlock = DASHBOARD_TS.match(/\.topbar \.nav a,\n\.topbar \.nav \.user-select \{[^}]*\}/)?.[0] ?? '';
      const adminBlock = DASHBOARD_TS.match(/\.topbar \.admin-toggle \{[^}]*\}/)?.[0] ?? '';
      const wsBlock = DASHBOARD_TS.match(/\n\.ws-badge \{[^}]*\}/)?.[0] ?? '';
      for (const block of [navBlock, adminBlock, wsBlock]) {
        expect(block).toContain('white-space: nowrap');
        expect(block).toContain('flex: none');
      }
    });

    it('the user pill is the only shrinkable control — its name ends in an ellipsis', () => {
      const pill = DASHBOARD_TS.match(/\.topbar \.user-pill \{[^}]*\}/)?.[0] ?? '';
      expect(pill).toContain('flex: 0 1 auto');
      expect(pill).toContain('min-width: 0');
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

  describe('CSS — @media (max-width: 1023px): the nav takes its own row', () => {
    const block1023 = DASHBOARD_TS.match(/@media \(max-width: 1023px\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    it('block exists', () => {
      expect(block1023).not.toBe('');
    });

    it('the top bar wraps into rows instead of crushing its controls', () => {
      expect(block1023).toMatch(/\.topbar\s*\{[^}]*flex-wrap:\s*wrap/);
    });

    it('the nav is a full-width second row that wraps rather than overflow', () => {
      expect(block1023).toContain(
        '.topbar .nav { order: 1; flex: 1 0 100%; margin-left: 0; flex-wrap: wrap; min-width: 0; }',
      );
    });

    it('a selected name can use the whole nav row', () => {
      expect(block1023).toContain('.topbar .nav .user-select { max-inline-size: 100%; }');
    });

    it('the account group has basis 0, so a long name never pushes it onto a row of its own', () => {
      expect(block1023).toContain('.topbar .topbar-account { flex: 1 1 0; justify-content: flex-end; }');
    });
  });

  describe('CSS — @media (max-width: 639px): phone top bar', () => {
    const block639 = DASHBOARD_TS.match(/@media \(max-width: 639px\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    it('block exists', () => {
      expect(block639).not.toBe('');
    });

    it('ws-badge collapses to 10px round dot via text-indent trick', () => {
      expect(block639).toContain('inline-size: 10px');
      expect(block639).toContain('block-size: 10px');
      expect(block639).toContain('border-radius: 50%');
      expect(block639).toContain('text-indent: 100%');
    });

    it('user-pill-prefix is hidden (the pill shows the name only)', () => {
      expect(block639).toContain('.topbar .user-pill-prefix { display: none; }');
    });

    it('the user select fills the nav row', () => {
      expect(block639).toContain('.topbar .nav .user-select { flex: 1 1 auto; }');
    });

    it('theme-toggle is a 32px square (no padding)', () => {
      expect(block639).toMatch(/#theme-toggle\s*\{[^}]*inline-size:\s*32px[^}]*block-size:\s*32px/);
    });
  });

  describe('CSS — labels are never cut down', () => {
    it('no rule hides the "Admin: " prefix or swaps Conversations for a short label', () => {
      expect(DASHBOARD_TS).not.toContain('.admin-mode-prefix { display: none; }');
      expect(DASHBOARD_TS).not.toContain('.nav-text { display: none; }');
    });

    it('the brand never ends in an ellipsis', () => {
      expect(DASHBOARD_TS).not.toMatch(/\.topbar\s+h1\s*\{[^}]*text-overflow/);
    });

    it('the old 680px / 480px top-bar overrides are gone (one set of breakpoints: 1023 / 639)', () => {
      const block680 = DASHBOARD_TS.match(/@media \(max-width: 680px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
      expect(block680).not.toContain('.topbar');
      expect(DASHBOARD_TS).not.toContain('@media (max-width: 480px) {');
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

  describe('CSS — coarse-pointer × narrow combined media (#800 codex P2)', () => {
    // Touch devices match `@media (pointer: coarse)` which sets
    // `padding: 8px 16px` on `.topbar .nav a, .topbar .nav .user-select` —
    // wide enough to push the topbar past 360-414px viewports.
    // Combined queries restore tight padding at narrow widths.
    // These rules MUST come AFTER `@media (pointer: coarse)` in source
    // order so the more specific (combined) query wins the cascade.

    it('@media (max-width: 680px) and (pointer: coarse) trims nav padding to 4px 8px', () => {
      const block = DASHBOARD_TS.match(/@media \(max-width: 680px\) and \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0];
      expect(block).toBeTruthy();
      expect(block).toMatch(/\.topbar\s+\.nav\s+a,\s*\.topbar\s+\.nav\s+\.user-select\s*\{[^}]*padding:\s*4px\s+8px/);
    });

    it('@media (max-width: 480px) and (pointer: coarse) trims nav padding to 4px 6px', () => {
      const block = DASHBOARD_TS.match(/@media \(max-width: 480px\) and \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0];
      expect(block).toBeTruthy();
      expect(block).toMatch(/\.topbar\s+\.nav\s+a,\s*\.topbar\s+\.nav\s+\.user-select\s*\{[^}]*padding:\s*4px\s+6px/);
    });

    it('combined coarse-narrow rules come AFTER @media (pointer: coarse) in source order', () => {
      const coarseIdx = DASHBOARD_TS.indexOf('@media (pointer: coarse) {');
      const narrowCoarseIdx = DASHBOARD_TS.indexOf('@media (max-width: 680px) and (pointer: coarse)');
      expect(coarseIdx).toBeGreaterThan(0);
      expect(narrowCoarseIdx).toBeGreaterThan(coarseIdx);
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
