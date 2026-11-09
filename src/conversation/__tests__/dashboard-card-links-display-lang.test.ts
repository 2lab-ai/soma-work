/**
 * The board's link states in the viewer's display language (#773).
 *
 * The bug: with the display language set to English, the board's chips still said a PR's or issue's state in Korean
 * ("#1065 열림", "#1049 머지됨", "#1042 닫힘"). The board's JSON (cardLinks, followupLinks — card-links.ts) is never
 * run through the page catalog (display-lang-web.ts translates HTML pages, JSON errors and the settings labels only),
 * so a word the server puts there stays Korean. The server now sends the state as a key too (CardLink.state) and the
 * page says it in its own words (PR_STATE_LABEL), which `translatePage` puts in the viewer's language.
 *
 *   L1  an en viewer's page: Open · Draft · Merged · Closed — the face's chips and their tooltips, the follow-up bar
 *   L2  a ko viewer's page is as before: 열림 · 초안 · 머지됨 · 닫힘
 *   L3  a tracker's own state name (Jira's), a key the page does not know and a board without the key (an older host)
 *       show the server's word as sent
 *   L4  the settings page's sample card (대시보드 화면 tab) says them as the board does: one vocabulary
 *
 * Executes the shipped page code (cut out of renderDashboardPage()'s template literal, cooked as the browser gets it),
 * fed with what the server sends (cardLinksOf / followupLinksOf).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerPageCatalog, translatePage } from '@soma/common/i18n-page';
import { describe, expect, it } from 'vitest';
import { cardLinksOf, followupLinksOf } from '../card-links';
import { LAYOUT_CLIENT_JS } from '../settings-layout-tab';

const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
registerPageCatalog(JSON.parse(readFileSync(join(CATALOG, 'en-page.json'), 'utf8')));

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}

type Chip = { kind: string; text: string; status?: string; tone?: string; title?: string };
type Page = { cardLinksFace(s: unknown): Chip[]; cardFollowupsOf(s: unknown, col: string): Chip[] };

/** The page's link code as a viewer in `lang` gets it: the script run through the page catalog, as the server does. */
function page(lang: 'ko' | 'en'): Page {
  const vars = ['PR_STATE_LABEL', 'CARD_LINK_KIND', 'CARD_LINK_TONES'].map(clientVar).join('\n');
  const fns = ['cardLinksFace', 'cardFollowupsOf'].map(clientFn).join('\n');
  const html = `<script>\n${vars}\n${fns}\n</script>`;
  const shown = lang === 'en' ? translatePage(html, 'en') : html;
  const script = shown.slice('<script>\n'.length, shown.lastIndexOf('\n</script>'));
  return new Function(
    'dhShow',
    'followupReconcile',
    'followupGoneLoad',
    `${script}\nreturn { cardLinksFace: cardLinksFace, cardFollowupsOf: cardFollowupsOf };`,
  )(
    () => true,
    () => {},
    () => ({}),
  ) as Page;
}

const GH = 'https://github.com/acme/app';
const JIRA = 'https://acme.atlassian.net/browse/PROJ-12';
// What a session records (the link's state as GitHub says it, or as the tracker names it).
const SRC = {
  links: { pr: { url: `${GH}/pull/1065`, status: 'open' }, issue: { url: `${GH}/issues/1042`, status: 'closed' } },
  linkHistory: {
    prs: [
      { url: `${GH}/pull/1049`, status: 'merged' },
      { url: `${GH}/pull/1060`, status: 'draft' },
      { url: `${GH}/pull/1030`, status: 'closed' },
    ],
    issues: [
      { url: `${GH}/issues/1070`, status: 'open' },
      { url: JIRA, status: 'In Progress' },
    ],
  },
};
// What the board sends for it.
const SESSION = { key: 'inst::C1:t1', cardLinks: cardLinksOf(SRC), followupLinks: followupLinksOf(SRC) };
const byText = (chips: Chip[], field: 'status' | 'title') => Object.fromEntries(chips.map((c) => [c.text, c[field]]));

describe('L1 — an en viewer’s chips say the states in English', () => {
  it('the face’s chips: Open · Draft · Merged · Closed (the bug: "#1065 열림", "#1049 머지됨", "#1042 닫힘")', () => {
    expect(byText(page('en').cardLinksFace(SESSION), 'status')).toEqual({
      '#1065': 'Open',
      '#1049': 'Merged',
      '#1060': 'Draft',
      '#1030': 'Closed',
      '#1042': 'Closed',
      '#1070': 'Open',
      'PROJ-12': 'In Progress',
    });
  });

  it('their tooltips, and nothing on a chip is Korean', () => {
    const chips = page('en').cardLinksFace(SESSION);
    expect(byText(chips, 'title')).toMatchObject({
      '#1049': 'PR #1049 · Merged',
      '#1042': 'Issue #1042 · Closed',
      'PROJ-12': 'Issue PROJ-12 · In Progress',
    });
    expect(JSON.stringify(chips)).not.toMatch(/[가-힣]/);
  });

  it('the follow-up bar (every open issue and PR) says them in English too', () => {
    expect(byText(page('en').cardFollowupsOf(SESSION, 'idle'), 'status')).toEqual({
      '#1065': 'Open',
      '#1060': 'Draft',
      '#1070': 'Open',
      'PROJ-12': 'In Progress',
    });
  });
});

describe('L2 — a ko viewer’s chips are as before', () => {
  it('열림 · 초안 · 머지됨 · 닫힘, on the face and in the follow-up bar', () => {
    const ko = page('ko');
    expect(byText(ko.cardLinksFace(SESSION), 'status')).toEqual({
      '#1065': '열림',
      '#1049': '머지됨',
      '#1060': '초안',
      '#1030': '닫힘',
      '#1042': '닫힘',
      '#1070': '열림',
      'PROJ-12': 'In Progress',
    });
    expect(byText(ko.cardLinksFace(SESSION), 'title')).toMatchObject({ '#1049': 'PR #1049 · 머지됨' });
    expect(byText(ko.cardFollowupsOf(SESSION, 'idle'), 'status')).toMatchObject({ '#1065': '열림', '#1060': '초안' });
  });
});

describe('L3 — a word without a key the page knows shows as the server sent it', () => {
  it('a board from an older host (no key), an unknown key, a key that is no own entry', () => {
    const en = page('en');
    const chip = (over: Record<string, unknown>) =>
      en.cardLinksFace({ cardLinks: [{ kind: 'pr', url: `${GH}/pull/1`, text: '#1', ...over }] })[0].status;
    expect(chip({ status: 'queued' })).toBe('queued');
    expect(chip({ status: 'queued', state: 'queued' })).toBe('queued');
    expect(chip({ status: 'x', state: 'constructor' })).toBe('x');
    expect(chip({ state: 'merged' })).toBe('Merged');
    expect(chip({})).toBeUndefined();
  });
});

describe('L4 — the settings page’s sample card says them as the board does', () => {
  it('Open · Merged, capitalized as on the board’s chips and its PR metric ("#12 Merged")', () => {
    const en = translatePage(`<script>\n${LAYOUT_CLIENT_JS}\n</script>`, 'en');
    for (const said of [
      "status: 'Open'",
      "status: 'Merged'",
      "'PR #700 · Open'",
      "'PR #700 · Merged'",
      "'#700 Open'",
      "'PR #700 Open'",
      "'#700 Merged'",
      "'PR #700 Merged'",
    ])
      expect(en).toContain(said);
    expect(en).not.toMatch(/#700 (open|merged)'/);
  });
});
