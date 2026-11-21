/**
 * affectUI Agent Inbox → the session board: the remaining delta
 * (.prd/affectui/re-agent-inbox.md §4, D1–D10). Static checks on the served
 * template — markup and CSS the contract depends on. The board is @2lab.ai/ui
 * <ui-agent-inbox>: its face, tones, holds, announcer, Escape and aria-controls
 * are the library's (agent-inbox.test.ts); the host contract (cardOf, the
 * columns, the slot body, the one primary button) runs from the shipped source
 * in dashboard-affectui-agent-inbox-client.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const CSS = TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>')));

/** The body of the first `@media|@container <query> {` block that starts with `head`. */
function block(css: string, head: string): string {
  const at = css.indexOf(head);
  if (at < 0) return '';
  const end = css.indexOf('\n}\n', at);
  return css.slice(at, end < 0 ? undefined : end);
}

// The board is @2lab.ai/ui <ui-agent-inbox>: the tinted status pill and its tones (D1), the state word that
// goes on a narrow face (D2), the ring in the pill (D3), the polite live region (D6) and the labelled column
// sections (D9) are the element's — its styles.ts and agent-inbox.test.ts ('maps status to tone …', 'draws each
// column as a section labelled by its name and count …', 'announces counts politely …').
describe('D1–D9 — the board is the element', () => {
  it('the board element sits in the inbox under the token wrapper, its module loaded', () => {
    expect(TEMPLATE).toContain('<section class="inbox ui-tok" id="inbox" aria-label="에이전트 인박스">');
    expect(TEMPLATE).toContain('<ui-agent-inbox id="kanban" class="kanban" view="board" lang="ko"></ui-agent-inbox>');
    expect(TEMPLATE).toContain(
      '<script type="module" src="/dashboard/ui/agent-inbox.js?v=${UI_LIB_VERSION}"></script>',
    );
    expect(CSS).toContain('ui-agent-inbox.kanban, ui-agent-inbox.cron-inbox { display: block; min-width: 0; }');
  });

  it('the open card’s body rules are scoped to the body (it is light DOM in the card’s slot, outside any .card)', () => {
    expect(CSS).not.toMatch(/(^|[\s,])\.card [.a-z]/m);
    expect(CSS).toContain('.card-body .card-refs {');
    expect(CSS).toContain('.card-body .card-question {');
  });
});

describe('D10 — one ink primary per open card: the decision', () => {
  it('the multi-question 답변하기 is the kit’s ink button (D3 E-16): the page keeps only its place, no button look of its own', () => {
    expect(CSS).toContain('.card-body .card-mc-go { width: 100%; margin-top: 8px; }');
    expect(CSS).not.toMatch(/\.card-mc-go[^{]*\{[^}]*(background|border-color|color):/);
    expect(TEMPLATE).toContain(`class="ui-btn' + (primary ? ' is-primary' : '') + ' card-mc-go"`);
  });
});
