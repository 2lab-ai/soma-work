/**
 * affectUI Agent Inbox → the session board: the remaining delta
 * (.prd/affectui/re-agent-inbox.md §4, D1–D10). Static checks on the served
 * template — markup and CSS the contract depends on. Behaviour (tone, pop,
 * lane hold, announcer, Escape, aria-controls, the one primary button) runs
 * from the shipped source in dashboard-affectui-agent-inbox-client.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const CSS = TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>'));

/** The body of the first `@media|@container <query> {` block that starts with `head`. */
function block(css: string, head: string): string {
  const at = css.indexOf(head);
  if (at < 0) return '';
  const end = css.indexOf('\n}\n', at);
  return css.slice(at, end < 0 ? undefined : end);
}

describe('D1 — the status tag is a tinted pill with a tone', () => {
  it("the board's own token blocks carry the four tone pairs, dark first, light overrides", () => {
    // Own `:root` / light blocks in the board's CSS region (epic hygiene: the shared blocks stay untouched).
    const dark = /:root \{\n {2}--st-run-bg: #1d2a47;[\s\S]*?\n\}/.exec(CSS)?.[0] ?? '';
    const light = /\[data-theme="light"\] \{\n {2}--st-run-bg: #e8eeff;[\s\S]*?\n\}/.exec(CSS)?.[0] ?? '';
    expect(block(CSS, ':root {')).not.toContain('--st-run-bg');
    expect(block(CSS, '[data-theme="light"] {')).not.toContain('--st-run-bg');
    for (const tone of ['run', 'wait', 'done', 'rest']) {
      expect(dark, tone).toMatch(new RegExp(`--st-${tone}-bg: #[0-9a-f]{6};`));
      expect(dark, tone).toMatch(new RegExp(`--st-${tone}-fg: #[0-9a-f]{6};`));
      expect(light, tone).toMatch(new RegExp(`--st-${tone}-bg: #[0-9a-f]{6};`));
      expect(light, tone).toMatch(new RegExp(`--st-${tone}-fg: #[0-9a-f]{6};`));
    }
    // The values the doc's contrast table was computed for.
    expect(dark).toContain('--st-run-bg: #1d2a47;');
    expect(dark).toContain('--st-run-fg: #a3bdff;');
    expect(light).toContain('--st-wait-bg: #fff1dc;');
    expect(light).toContain('--st-wait-fg: #8f5300;');
  });

  it('the pill: 24px tall, fully rounded, 12.5px, shrinks to its content, each tone on its tokens', () => {
    const rule = CSS.slice(CSS.indexOf('.card-status {'), CSS.indexOf('}', CSS.indexOf('.card-status {')));
    expect(rule).toContain('height: 24px;');
    expect(rule).toContain('border-radius: 999px;');
    expect(rule).toContain('padding: 0 10px 0 8px;');
    expect(rule).toContain('font-size: 12.5px;');
    expect(rule).toContain('flex: 0 1 auto;');
    for (const tone of ['run', 'wait', 'done', 'rest']) {
      expect(CSS).toContain(
        `.card-status[data-tone="${tone}"] { background: var(--st-${tone}-bg); color: var(--st-${tone}-fg); }`,
      );
    }
    // Recency rides in the pill, in the pill's colour.
    expect(CSS).toContain('.card-status .st-ago { color: inherit; }');
  });
});

describe('D2 — the state word hides by card width, not by view', () => {
  it('no view-based prefix rule is left', () => {
    // No base rule hides the word (the old one was `.st-prefix { display: none; }` at column 0).
    expect(CSS).not.toMatch(/^\.st-prefix \{/m);
    expect(CSS).not.toContain('.kanban[data-view="list"] .st-prefix');
  });

  it('the face is a size container; at 300px of content the prefix goes', () => {
    expect(CSS).toMatch(/\.card-face \{[^}]*container: cardface \/ inline-size;/);
    const q = block(CSS, '@container cardface (max-width: 300px) {');
    expect(q).toContain('.card-status .st-prefix { display: none; }');
  });
});

describe('D3 — the running ring inside the pill', () => {
  it('track and arc follow the icon colour, and the reduced-motion ring stays whole', () => {
    expect(CSS).toContain(
      '.card-status .spinner { border-color: color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; border-right-color: currentColor; }',
    );
    // The shared reduced-motion block is untouched; the board's own block keeps the pill's ring whole.
    const shared = block(CSS, '@media (prefers-reduced-motion: reduce) {\n  *,*::before');
    expect(shared).toContain('.spinner { border-color: var(--st-run); background: radial-gradient');
    expect(shared).not.toContain('.card-status');
    const ring = CSS.indexOf('.card-status .spinner { border-color: color-mix(');
    const own = CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  /* D3');
    expect(own).toBeGreaterThan(ring);
    // After the shared block, so the first reduced-motion block in the sheet stays the shared one.
    expect(own).toBeGreaterThan(CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  *,*::before'));
    expect(block(CSS, '@media (prefers-reduced-motion: reduce) {\n  /* D3')).toContain(
      '.card-status .spinner { border-color: currentColor; }',
    );
  });
});

describe('D6 — one polite live region for the board', () => {
  it('sits in the inbox, visually hidden, polite, atomic', () => {
    const inbox = TEMPLATE.slice(TEMPLATE.indexOf('<section class="inbox"'), TEMPLATE.indexOf('id="kanban"'));
    expect(inbox).toContain(
      '<p id="inbox-live" class="ib-sr" role="status" aria-live="polite" aria-atomic="true"></p>',
    );
    expect(CSS).toContain(
      '.ib-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }',
    );
  });
});

describe('D9 — each column is a labelled section', () => {
  it('section + aria-labelledby (name and count), heading ids, closing tags match', () => {
    for (const [c, name] of [
      ['waiting', 'NEEDS YOU'],
      ['working', 'RUNNING'],
      ['done', 'DONE'],
    ]) {
      expect(TEMPLATE).toContain(
        `<section class="kanban-col" id="col-${c}" data-col="${c}" aria-labelledby="col-${c}-name count-${c}">`,
      );
      expect(TEMPLATE).toContain(`<h3 id="col-${c}-name">${name}</h3>`);
    }
    expect(TEMPLATE).not.toContain('<div class="kanban-col"');
    const kanban = TEMPLATE.slice(
      TEMPLATE.indexOf('<div class="kanban" id="kanban"'),
      TEMPLATE.indexOf('</section>\n  </div>'),
    );
    expect((kanban.match(/<section class="kanban-col"/g) ?? []).length).toBe(3);
    expect((kanban.match(/<\/section>/g) ?? []).length).toBe(3);
  });
});

describe('D10 — one ink primary per open card: the decision', () => {
  const INK = 'background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); font-weight: 600;';

  it('the multi-question 답변하기 matches the recommended choice, hover included (own hover block)', () => {
    expect(CSS).toContain(`.card .btn-choice.btn-choice-primary { ${INK} }`);
    expect(CSS).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{\n {2}\.card \.btn-choice\.btn-choice-primary:hover:not\(:disabled\) \{ background: var\(--ib-text\);/,
    );
  });

  it("in the card a permission prompt's Approve is the ink primary and Deny a secondary; the panel keeps its own", () => {
    expect(CSS).toContain(`.card .btn-perm.btn-perm-approve { ${INK} }`);
    expect(CSS).toContain(
      '.card .btn-perm.btn-perm-deny { background: var(--ib-card); border-color: var(--ib-card-border); color: var(--st-fail-text); }',
    );
    // The unscoped rules (the panel's prompt) are unchanged.
    expect(CSS).toContain('.btn-perm-approve { color: #fff; background: #1f8f4e; border-color: #1f8f4e; }');
    expect(CSS).toContain('.btn-perm-deny { color: #fff; background: #c43c3c; border-color: #c43c3c; }');
  });
});
