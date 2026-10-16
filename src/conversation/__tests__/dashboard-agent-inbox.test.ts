/**
 * Static structure tests for the Agent inbox board (.prd/10-agent-inbox-board-spec.md
 * §3.1 board, §4 motion, §5 responsive).
 *
 * Like dashboard-topbar-mobile.test.ts these read the template source and
 * assert the pieces the contract depends on. Behaviour that can run without a
 * browser (work-log merge/paging, card 지시/응답 retry, escaping, contrast) is
 * executed from the shipped source in dashboard-agent-inbox-client.test.ts;
 * DOM + WAAPI behaviour (FLIP frames, no-op renders during entry/exit, 390px
 * overflow) runs in scripts/screenshot-agent-inbox.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
// Only the page template — server code above it must not satisfy (or trip)
// these assertions by accident.
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

/** Body of a top-level client function: from its declaration to the first `\n}\n`. */
function fnBody(name: string): string {
  // The browser runs the LAST of several same-named declarations — refuse to pick one.
  const decls = TEMPLATE.match(new RegExp(`^(?:async )?function ${name}\\(`, 'gm')) ?? [];
  if (decls.length > 1) throw new Error(`client function ${name} is declared ${decls.length} times`);
  const start = TEMPLATE.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = TEMPLATE.indexOf('\n}\n', start);
  return TEMPLATE.slice(start, end < 0 ? undefined : end);
}

/** Remove every `@media (hover: hover) and (pointer: fine) { ... }` block. */
function stripHoverBlocks(css: string): string {
  return css.replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, '');
}

describe('agent inbox board — layout (§3.1)', () => {
  it('has the breadcrumb and the Board | List segmented control', () => {
    expect(TEMPLATE).toContain('Agent inbox');
    expect(TEMPLATE).toContain('data-view="board"');
    expect(TEMPLATE).toContain('data-view="list"');
  });

  it('persists the view in localStorage and defaults to List below 640px', () => {
    expect(TEMPLATE).toContain("'soma-board-view'");
    expect(TEMPLATE).toContain('innerWidth < 640');
  });

  it('renders three columns in order NEEDS YOU → RUNNING → DONE', () => {
    const waiting = TEMPLATE.indexOf('id="col-waiting"');
    const working = TEMPLATE.indexOf('id="col-working"');
    const done = TEMPLATE.indexOf('id="col-done"');
    expect(waiting).toBeGreaterThan(-1);
    expect(working).toBeGreaterThan(waiting);
    expect(done).toBeGreaterThan(working);
    expect(TEMPLATE).toContain('NEEDS YOU');
    expect(TEMPLATE).toContain('RUNNING');
    expect(TEMPLATE).toContain('>DONE<');
    expect(TEMPLATE).toContain('Nothing here');
  });

  it('drops the old 4-column idle/closed containers', () => {
    expect(TEMPLATE).not.toContain('id="col-closed"');
    expect(TEMPLATE).not.toContain('id="cards-idle"');
    expect(TEMPLATE).not.toContain('id="cards-closed"');
  });

  it('keeps the 7-day Show older toggle for closed cards', () => {
    expect(TEMPLATE).toContain('Show older');
    expect(TEMPLATE).toContain('function toggleOlderClosed()');
  });
});

describe('agent inbox board — drag and drop removed (§3.1-5)', () => {
  it('has no draggable cards, drag listeners, or confirm() prompts', () => {
    expect(TEMPLATE).not.toContain('draggable=');
    expect(TEMPLATE).not.toContain("'dragstart'");
    expect(TEMPLATE).not.toContain("'drop'");
    expect(TEMPLATE).not.toContain('confirm(');
  });
});

describe('agent inbox board — keyed reconciler (§3.1-6)', () => {
  it('cards are keyed by the raw session key (attribute-escaped)', () => {
    expect(TEMPLATE).toContain("data-session-key', key");
  });

  it('renderBoard no longer rewrites columns with innerHTML', () => {
    const body = fnBody('renderBoard');
    expect(body).not.toBe('');
    expect(body).not.toContain('innerHTML');
    expect(body).toContain('reconcileBoard(');
  });

  it('the reconciler only replaces a card part when its HTML changed', () => {
    const body = fnBody('applyCardParts');
    expect(body).not.toBe('');
    expect(body).toContain('_faceHtml !==');
    expect(body).toContain('_bodyHtml !==');
    expect(fnBody('patchCard')).toContain('applyCardParts(');
  });

  it('a same-data render stops before touching the DOM or a running entrance/exit (§3.1-6)', () => {
    const body = fnBody('reconcileBoard');
    expect(body).toContain('if (changed) applyBoardPlan(');
    // Nothing on the planning path finishes entrances or removes fading cards.
    expect(TEMPLATE).not.toContain('clearExitingCards');
    expect(fnBody('measureCards')).not.toContain('.finish(');
    expect(fnBody('exitCard')).toContain('anim.onfinish = anim.oncancel');
  });

  it('dictionaries keyed by session keys / conversation ids are prototype-free', () => {
    expect(TEMPLATE).toContain('var _cardEls = Object.create(null);');
    expect(TEMPLATE).toContain('var _ioCache = Object.create(null);');
    expect(TEMPLATE).toContain('let _sessionCache = Object.create(null);');
    expect(fnBody('reconcileBoard')).toContain('var wanted = Object.create(null);');
    expect(fnBody('renderBoard')).toContain('_sessionCache = Object.create(null);');
  });

  it('sessionUpdated goes through the same patch path', () => {
    const ws = fnBody('connectWs');
    expect(ws).toContain("msg.type === 'sessionUpdated'");
    expect(ws).toContain('patchCard(');
    expect(ws).not.toContain('replaceWith(');
  });
});

describe('agent inbox board — expanded card (§3.1-4)', () => {
  it('card click toggles expansion in place instead of opening the panel', () => {
    expect(TEMPLATE).toContain('function toggleCard(');
    expect(TEMPLATE).not.toContain('onclick="openPanel(');
  });

  it('does not repeat the pending question the face already shows', () => {
    expect(fnBody('renderCardBody')).toContain('pq.question === faceSummary');
    expect(fnBody('renderMultiChoiceCard')).toContain('=== faceSummary');
  });

  it('every card can open the panel; without a conversation the work log reads 작업 로그 없음', () => {
    const body = fnBody('renderCardBody');
    expect(body).toMatch(/const worklogBtn = '<button type="button" class="btn-action btn-primary"/);
    expect(TEMPLATE).toContain("var WL_EMPTY_MSG = '작업 로그 없음';");
    expect(fnBody('resetWorkLog')).toContain('WL_EMPTY_MSG');
    expect(fnBody('openPanel')).toContain('resetWorkLog(panelConvId, true)');
  });

  it('a WS session_update re-attaches sibling-instance cards from the last poll', () => {
    expect(fnBody('connectWs')).toContain('renderBoard(mergeSiblingCards(msg.board))');
    expect(fnBody('loadSessions')).toContain('_lastPolledBoard = data.board;');
  });

  it('older panel turns keep the reading position (anchored on the first visible element)', () => {
    const body = fnBody('loadMorePanelTurns');
    expect(body).toContain('panelScrollAnchor(scrollEl)');
    expect(body).toContain('anchor.el.getBoundingClientRect().top - anchor.top');
  });

  it('reopening a card retries a failed 지시/응답 fetch at once', () => {
    expect(fnBody('toggleCard')).toContain('ensureCardIo(key, true)');
  });

  it('lazy-loads the latest instruction/response pair with limit=2', () => {
    expect(TEMPLATE).toContain("'?limit=2'");
    expect(TEMPLATE).toContain('지시');
    expect(TEMPLATE).toContain('응답');
  });

  it('the 작업 로그 button opens the panel at the work log', () => {
    expect(DASHBOARD_TS).toContain("openPanel(\\\\'' + escJs(s.key) + '\\\\',true)");
    expect(TEMPLATE).toContain('작업 로그');
  });
});

describe('agent inbox board — work log panel (§3.1-7, §3.3)', () => {
  it('has a work log section in the panel', () => {
    expect(TEMPLATE).toContain('id="panel-worklog"');
    expect(TEMPLATE).toContain('작업 로그 없음');
  });

  it('loads on open and recovers on every reconnect while a conversation is open', () => {
    expect(TEMPLATE).toContain("'/worklog'");
    expect(fnBody('openPanel')).toContain('loadWorkLog()');
    expect(fnBody('connectWs')).toContain('if (panelOpen && _wl) recoverWorkLog();');
    // Switching conversations closes the previous state so late responses drop.
    expect(fnBody('resetWorkLog')).toContain('_wl.closed = true');
  });

  it('live-appends work_log WS entries through the seq merge', () => {
    expect(fnBody('connectWs')).toContain("msg.type === 'work_log'");
    expect(fnBody('connectWs')).toContain('pushLiveWorkLog(msg.conversationId, msg.entry)');
    expect(fnBody('pushLiveWorkLog')).toContain('wlOnLive(');
    expect(fnBody('wlOnLive')).toContain('wlMerge(');
  });
});

describe('agent inbox board — deep link (§3.1-8)', () => {
  it('reads ?session= and opens the card + panel at the work log', () => {
    expect(TEMPLATE).toContain('URLSearchParams(location.search)');
    expect(TEMPLATE).toContain(".get('session')");
    expect(fnBody('openDeepLinkedSession')).toContain('openPanel(key, true)');
  });

  it('retries on board renders for ~10s, then gives up silently', () => {
    expect(TEMPLATE).toContain('DEEP_LINK_WINDOW_MS = 10000');
    const body = fnBody('openDeepLinkedSession');
    // The deadline gates every attempt, not only misses — a card that first
    // appears on the 30 s poll must not open the panel long after load.
    const deadline = body.indexOf('Date.now() > _deepLinkDeadline');
    expect(deadline).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(body.indexOf('resolveDeepLinkKey('));
    expect(fnBody('renderBoard')).toContain('openDeepLinkedSession()');
  });

  // Execute the shipped client function itself. It must stay free of
  // backslashes so the TS source text is byte-identical to the served JS.
  const src = fnBody('resolveDeepLinkKey');
  const resolve = (ref: string, keys: string[], self: string | null) =>
    new Function(`${src}\n}\nreturn resolveDeepLinkKey;`)()(ref, keys, self) as string | null;

  it('resolveDeepLinkKey source is extractable verbatim', () => {
    expect(src).toContain('function resolveDeepLinkKey(ref, keys, selfInstance)');
    expect(src).not.toContain('\\');
  });

  it('matches an exact board key (prefixed form, or unprefixed single-instance board)', () => {
    const prefixed = ['mac-mini::work:C1:1700000000.000100', 'mac-mini::work:C2:1700000000.000200'];
    expect(resolve('mac-mini::work:C2:1700000000.000200', prefixed, 'mac-mini')).toBe(
      'mac-mini::work:C2:1700000000.000200',
    );
    const raw = ['work:C1:1700000000.000100', 'work:C2:1700000000.000200'];
    expect(resolve('work:C1:1700000000.000100', raw, null)).toBe('work:C1:1700000000.000100');
  });

  it('maps the Slack registry key (no instance prefix) to the unique "::<key>" card', () => {
    const keys = ['mac-mini::work:C1:1700000000.000100', 'mac-mini::work:C2:1700000000.000200'];
    expect(resolve('work:C1:1700000000.000100', keys, 'mac-mini')).toBe('mac-mini::work:C1:1700000000.000100');
    // Sibling card, self instance unknown — still unique by suffix.
    expect(resolve('work:C2:1700000000.000200', keys, null)).toBe('mac-mini::work:C2:1700000000.000200');
  });

  it('prefers this instance when the same thread is on two instances, else refuses to guess', () => {
    const keys = ['oud::work:C1:1700000000.000100', 'mac-mini::work:C1:1700000000.000100'];
    expect(resolve('work:C1:1700000000.000100', keys, 'mac-mini')).toBe('mac-mini::work:C1:1700000000.000100');
    expect(resolve('work:C1:1700000000.000100', keys, 'other')).toBeNull();
  });

  it('returns null when nothing matches yet (caller retries on the next render)', () => {
    expect(resolve('work:C9:1700000000.000900', ['mac-mini::work:C1:1700000000.000100'], 'mac-mini')).toBeNull();
    // A bare suffix of a key segment is not a match.
    expect(resolve('1700000000.000100', ['mac-mini::work:C1:1700000000.000100'], 'mac-mini')).toBeNull();
    expect(resolve('', ['mac-mini::work:C1:1700000000.000100'], 'mac-mini')).toBeNull();
  });
});

describe('agent inbox board — motion contract (§4)', () => {
  it('declares the motion tokens verbatim', () => {
    expect(TEMPLATE).toContain('--ease-out: cubic-bezier(0.23, 1, 0.32, 1);');
    expect(TEMPLATE).toContain('--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);');
    expect(TEMPLATE).toContain('--dur-press: 160ms;');
    expect(TEMPLATE).toContain('--dur-expand: 240ms;');
    expect(TEMPLATE).toContain('--dur-move: 320ms;');
    expect(TEMPLATE).toContain('--dur-fade: 180ms;');
  });

  it('expands with grid-template-rows 0fr → 1fr', () => {
    expect(TEMPLATE).toContain('grid-template-rows: 0fr;');
    expect(TEMPLATE).toContain('grid-template-rows: 1fr;');
  });

  it('runs FLIP through WAAPI and honours reduced motion', () => {
    expect(TEMPLATE).toContain('.animate(');
    expect(TEMPLATE).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });

  it('presses scale to 0.97 — pointer presses only, never keyboard activation (§4-5, §4-9)', () => {
    const rules = TEMPLATE.match(/^[^\n{]*:active[^\n{]*\{[^}]*transform: scale\(0\.97\)[^}]*\}/gm) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const selectors = rule.slice(0, rule.indexOf('{')).split(',');
      for (const sel of selectors) expect(sel, sel).toContain(':not(:focus-visible)');
    }
  });

  it('reduced motion stops the spinner and shows a static working indicator (§4-8)', () => {
    const reduced = TEMPLATE.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(reduced).toContain('.spinner, .spin { animation: none !important; }');
    expect(reduced).toMatch(/\.spinner \{ border-color: var\(--st-run\); background: radial-gradient/);
  });

  it('the context fill animates transform scaleX, not width', () => {
    expect(TEMPLATE).toMatch(
      /\.card \.context-bar-fill \{[^}]*transform-origin: left center;[^}]*transition: transform/,
    );
    expect(fnBody('renderCardBody')).toContain('style="transform:scaleX(');
  });

  it('board cards drop the star on the recommended choice (the solid primary marks it)', () => {
    expect(TEMPLATE).toContain('.card .btn-choice-recommended::before { content: none; }');
  });

  it('board hover effects live only inside (hover: hover) and (pointer: fine)', () => {
    expect(TEMPLATE).toContain('@media (hover: hover) and (pointer: fine) {');
    const outside = stripHoverBlocks(TEMPLATE);
    for (const sel of [
      '.card:hover',
      '.card-face:hover',
      '.seg-btn:hover',
      '.btn-action:hover',
      '.show-older-btn:hover',
    ]) {
      expect(outside, sel).not.toContain(sel);
    }
  });
});

describe('agent inbox board — responsive (§5)', () => {
  it('caps the page at 1280px', () => {
    expect(TEMPLATE).toContain('max-width: 1280px');
  });

  it('640–1023px scrolls the three columns horizontally with snap', () => {
    const block = TEMPLATE.match(/@media \(max-width: 1023px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('scroll-snap-type: x mandatory');
    expect(block).toContain('minmax(300px');
  });

  it('<640px raises tap targets to 44px', () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('min-height: 44px');
  });

  it('every remaining control is 44px on narrow or touch screens (panel, topbar, period tabs)', () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\), \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('.panel-close { width: 44px; height: 44px; }');
    expect(block).toContain('.period-btn { min-height: 44px; }');
    expect(block).toContain(
      '.topbar .nav a, .topbar .nav .user-select, .topbar .user-pill, .topbar .admin-toggle { min-height: 44px; }',
    );
    expect(block).toContain('#theme-toggle { min-block-size: 44px; position: relative; }');
    expect(block).toContain('#panel-title-sub-regen { min-width: 44px; min-height: 44px; }');
    // Must follow the #800 coarse blocks so it wins the cascade.
    expect(TEMPLATE.indexOf('@media (max-width: 639px), (pointer: coarse)')).toBeGreaterThan(
      TEMPLATE.indexOf('@media (max-width: 480px) and (pointer: coarse)'),
    );
  });
});
