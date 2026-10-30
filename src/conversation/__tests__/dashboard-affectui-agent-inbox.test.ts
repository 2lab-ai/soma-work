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
// column as a section labelled by its name and count …', 'announces counts politely …'). The page must not keep
// a second copy of them.
describe('D1–D9 — the board is the element; the page keeps no copy of its face', () => {
  it('the board element sits in the inbox under the token wrapper, its module loaded', () => {
    expect(TEMPLATE).toContain('<section class="inbox ui-tok" id="inbox" aria-label="Agent inbox">');
    expect(TEMPLATE).toContain('<ui-agent-inbox id="kanban" class="kanban" view="board"></ui-agent-inbox>');
    expect(TEMPLATE).toContain(
      '<script type="module" src="/dashboard/ui/agent-inbox.js?v=${UI_LIB_VERSION}"></script>',
    );
    expect(CSS).toContain('ui-agent-inbox.kanban, ui-agent-inbox.cron-inbox { display: block; min-width: 0; }');
  });

  it('no inline face, pill, tone token, column or live-region markup is left', () => {
    for (const gone of [
      /\.card-status\b/,
      /\.card-face\b/,
      /\.card-metrics\b/,
      /\.owner-badge\b/,
      /--st-(run|wait|done|rest)-(bg|fg):/,
      /--ob-\d-(bg|fg):/,
      /\.kanban-col\b/,
      /@container cardface/,
      /\.card-expand\b/,
      /\.done-group\b/,
    ])
      expect(CSS, String(gone)).not.toMatch(gone);
    for (const gone of ['id="inbox-live"', 'class="kanban-col"', 'id="cards-waiting"', 'class="col-skel"'])
      expect(TEMPLATE, gone).not.toContain(gone);
  });

  it('the open card’s body rules are scoped to the body (it is light DOM in the card’s slot, outside any .card)', () => {
    expect(CSS).not.toMatch(/(^|[\s,])\.card [.a-z]/m);
    expect(CSS).toContain('.card-body .card-refs {');
    expect(CSS).toContain('.card-body .card-question {');
  });
});

describe('D10 — one ink primary per open card: the decision', () => {
  const INK = 'background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); font-weight: 600;';

  it('the multi-question 답변하기 is the card’s ink primary, hover included (own hover block)', () => {
    expect(CSS).toContain(`.card-body .btn-choice.btn-choice-primary { ${INK} }`);
    expect(CSS).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{\n {2}\.card-body \.btn-choice\.btn-choice-primary:hover:not\(:disabled\) \{ background: var\(--ib-text\);/,
    );
  });
});

// affectUI batch 1: the card's permission prompts and single-choice question are <ui-approval-card>s.
// Their answers' weight is the element's: Approve / Submit is its primary (.ac-primary), Deny a quiet
// secondary (library: approval-card.test.ts "renders title, risk, rules, the command and Approve / Deny"),
// a card this viewer cannot answer is locked and says why ("canAnswer false / string locks the answers and
// says why"). The dashboard's old button CSS for them — the lead Approve (.is-lead), the quiet recommended
// choice (.is-quiet), the Slack-style prompt (.perm-*, .btn-perm*), the card's choice row — is gone and must
// not come back (PR #450 R1 P1's hover-weight rules went with it: the element owns its hover states).
describe('D10 — the card’s prompts and question take their weight from the element; the old button CSS is gone', () => {
  it('no rule for the removed renderers’ markup is left in the page CSS', () => {
    for (const gone of [
      /\.btn-perm\b/,
      /\.is-lead\b/,
      /\.is-quiet\b/,
      /\.perm-[a-z]/,
      /\.card(-body)? \.btn-choice-recommended/,
      /\.card(-body)? \.btn-choice\.btn-choice-recommended/,
      /\.choice-row-recommended\b/,
      /\.choice-divider\b/,
      /\.card-question-choices\b/,
      /:has\(\.btn-perm/,
    ])
      expect(CSS, String(gone)).not.toMatch(gone);
    // The panel's multi-question form still draws its recommended choice (renderMultiChoicePanel).
    expect(CSS).toMatch(/\n\.btn-choice-recommended \{/);
  });

  it('the open card draws approval-card slots, never the old buttons', () => {
    const body = TEMPLATE.slice(TEMPLATE.indexOf('\nfunction renderCardBody('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain('acPermissionsHtml(s)');
    expect(fn).toContain('acQuestionHtml(s, s.pendingQuestion)');
    for (const gone of ['btn-perm', 'is-lead', 'is-quiet', 'btn-choice-recommended', 'choice-row-recommended'])
      expect(fn, gone).not.toContain(gone);
  });
});
