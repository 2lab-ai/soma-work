/**
 * SSOT 2026-10-29 — "디테일 카드에서 Goal 도 디폴트로 collapsed 로 표시해줘. 첫 3줄 정도만
 * 표시되도록." The fold is layout, so this suite checks it in a real browser:
 * the shipped page CSS and the shipped client goal code (cut out of
 * renderDashboardPage()'s template literal and cooked exactly as the browser
 * receives it), in an open Session Detail panel, in headless Chromium.
 *
 * CI installs the Chromium headless shell (ci.yml), so there a browser that
 * does not launch is a failure. A machine without one skips, saying why.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const CSS = cook(
  TEMPLATE.slice(
    TEMPLATE.indexOf('<style>') + '<style>'.length,
    TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>')),
  ),
);
const FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'formatTokens',
  'formatDuration',
  'formatGoalTime',
  'renderGoalHistory',
  'isBusy',
  'renderCardGoal',
  'isEditingGoal',
  'captureGoalDraft',
  'restoreGoalDraft',
  'domKeyOf',
  'domKeyLater',
  'domMorph',
  'domMorphChildren',
  'morphInnerHtml',
  'togglePanelGoal',
  'syncGoalMore',
  'renderPanelGoal',
];
const VARS = [
  'GOAL_STATUS_LABELS',
  'GOAL_STATUS_TONE',
  'GOAL_SVG',
  'GOAL_VIA_LABELS',
  '_goalHistoryOpen',
  '_goalErrors',
  '_busy',
  '_panelGoalOpen',
  'GOAL_FOLD_LINES',
];

// Eight lines of objective — the user's own words first.
const LONG = [
  '디테일 카드에서 Goal 도 디폴트로 collapsed 로 표시해줘. 첫 3줄 정도만 표시되도록.',
  '세션 정보처럼 기본은 접어 두고, 필요할 때만 펼친다.',
  '자세히를 켜고 열어도, 카드의 관리 → 로 열어도 처음에는 접혀 있다.',
  '남은 것, 대기 중인 goal, 완료 기록, 추가 입력란은 그대로 둔다.',
  '다섯째 줄',
  '여섯째 줄',
  '일곱째 줄',
  '여덟째 줄',
].join('\n');

function pageHtml(objective: string): string {
  const session = {
    key: 'k',
    ownerId: 'U1',
    terminated: false,
    goal: {
      current: {
        goalId: 'g1',
        objective,
        status: 'active',
        continuationCount: 2,
        maxContinuations: 10,
        lastEvalReason: '실제 브라우저 확인',
      },
      queue: [{ goalId: 'g2', objective: '다음 goal' }],
      completedCount: 1,
    },
  };
  // The open panel's real nesting: .slide-panel.open > .panel-body > .panel-scroll > .panel-surface > #panel-goal.
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="slide-panel open" id="slide-panel" style="--panel-w: 440px">
  <div class="panel-body" id="panel-body"><div class="panel-scroll" id="panel-scroll">
    <section class="panel-surface" id="panel-surface" aria-label="작업 정보">
      <div class="panel-goal" id="panel-goal" role="region" tabindex="-1" aria-label="Goal" style="display:none"></div>
    </section>
  </div></div>
</div>
<script>
var panelSessionKey = 'k', currentUserId = 'U1';
function sessionColOf() { return 'working'; }
function isSiblingSession() { return false; }
var _sessionCache = { k: ${JSON.stringify(session).replace(/</g, '\\u003c')} };
${VARS.map(clientVar).join('\n')}
${FNS.map(clientFn).join('\n')}
renderPanelGoal();
</script></body></html>`;
}

interface Fold {
  lineHeight: number;
  lines: number;
  fullLines: number;
  open: boolean;
  toggle: string | null;
  chev: boolean;
  expanded: string | null;
  focusOnToggle: boolean;
}
// In-page code is passed as source (the repo's tsconfig carries no DOM lib).
const MEASURE = `(() => {
  const obj = document.querySelector('#panel-goal .cg-objective');
  const more = document.querySelector('#panel-goal .cg-more');
  const lh = parseFloat(getComputedStyle(obj).lineHeight);
  return {
    lineHeight: lh,
    lines: Math.round(obj.getBoundingClientRect().height / lh),
    fullLines: Math.round(obj.scrollHeight / lh),
    open: !!obj.closest('.card-goal.is-open'),
    toggle: more && more.checkVisibility() ? more.textContent.trim() : null,
    chev: !!more && !!more.querySelector('span.chev[aria-hidden="true"]'),
    expanded: more ? more.getAttribute('aria-expanded') : null,
    focusOnToggle: !!more && document.activeElement === more,
  };
})()`;
const TOGGLE_SHOWN = `(() => { const m = document.querySelector('#panel-goal .cg-more'); return !!m && m.checkVisibility(); })()`;
const TOGGLE_HIDDEN = `(() => { const m = document.querySelector('#panel-goal .cg-more'); return !!m && !m.checkVisibility(); })()`;
const panelWidth = (px: number) => `document.getElementById('slide-panel').style.setProperty('--panel-w', '${px}px')`;
function measure(page: Page): Promise<Fold> {
  return page.evaluate(MEASURE) as Promise<Fold>;
}

let browser: Browser | null = null;
let launchError = '';
beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    launchError = String(e).split('\n')[0];
  }
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function openPage(ctx: { skip: (note?: string) => void }, objective: string): Promise<Page> {
  if (!browser) {
    if (process.env.CI) throw new Error(`Chromium did not launch: ${launchError}`);
    ctx.skip(`no Chromium here: ${launchError}`);
  }
  const page = await (browser as Browser).newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(pageHtml(objective));
  await page.waitForSelector('#panel-goal .cg-objective');
  expect(errors).toEqual([]);
  return page;
}

describe('panel goal fold — in a real browser (Chromium)', () => {
  it('opens folded to 3 lines; 펼치기 shows every line, 접기 folds it again, focus stays on the toggle', async (ctx) => {
    const page = await openPage(ctx, LONG);
    const folded = await measure(page);
    const shotFolded = await page.locator('#panel-goal').screenshot();
    await page.click('#panel-goal .cg-more');
    const opened = await measure(page);
    const shotOpen = await page.locator('#panel-goal').screenshot();
    await page.click('#panel-goal .cg-more');
    const refolded = await measure(page);
    await page.close();

    console.log(`GOAL_FOLD ${JSON.stringify({ folded, opened, refolded })}`);
    // The job keeps no artifacts: the log carries the two renders for review.
    if (process.env.CI) {
      console.log(`GOAL_FOLD_SHOT folded ${shotFolded.toString('base64')}`);
      console.log(`GOAL_FOLD_SHOT open ${shotOpen.toString('base64')}`);
    }

    expect(folded.lineHeight).toBeGreaterThan(0);
    // Tone pass P8: the toggle's word plus the icon set's chevron (a CSS-drawn span that turns with
    // aria-expanded) — was the text triangles 펼치기 ▼ / 접기 ▲.
    expect(folded).toMatchObject({ lines: 3, open: false, toggle: '펼치기', chev: true, expanded: 'false' });
    expect(folded.fullLines).toBeGreaterThanOrEqual(8);
    expect(opened).toMatchObject({ lines: folded.fullLines, open: true, toggle: '접기', chev: true, expanded: 'true' });
    expect(opened.focusOnToggle).toBe(true);
    expect(refolded).toMatchObject({ lines: 3, open: false, toggle: '펼치기', chev: true, expanded: 'false' });
    expect(refolded.focusOnToggle).toBe(true);
  }, 60_000);

  it('a goal that fits in 3 lines shows all of it and no toggle', async (ctx) => {
    const page = await openPage(ctx, '짧은 goal 한 줄');
    const short = await measure(page);
    await page.close();
    expect(short).toMatchObject({ lines: 1, fullLines: 1, toggle: null });
  }, 60_000);

  it('the toggle follows the width: a narrower panel that wraps the goal past 3 lines gets 펼치기', async (ctx) => {
    const page = await openPage(ctx, '대시보드 Goal 접힘을 실제 브라우저에서 확인한다');
    await page.evaluate(panelWidth(640));
    await page.waitForFunction(TOGGLE_HIDDEN);
    const wide = await measure(page);
    await page.evaluate(panelWidth(240));
    // The ResizeObserver on #panel-goal measures again after layout.
    await page.waitForFunction(TOGGLE_SHOWN);
    const narrow = await measure(page);
    await page.close();
    console.log(`GOAL_FOLD_RESIZE ${JSON.stringify({ wide, narrow })}`);
    expect(wide.fullLines).toBeLessThanOrEqual(3);
    expect(wide.toggle).toBeNull();
    expect(narrow.fullLines).toBeGreaterThan(3);
    expect(narrow).toMatchObject({ lines: 3, toggle: '펼치기' });
  }, 60_000);
});
