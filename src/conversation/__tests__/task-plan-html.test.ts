/**
 * Plan mode (SSOT 2026-11-02) — the plan as HTML, drawn by the server from the
 * structured plan the model submitted: high-level concept first, then the
 * phases, their steps and each step's detail (T3). The same fragment is the
 * detail card's inline plan and the body of the full-page view.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerDisplayCatalog, runWithDisplayLang } from '@soma/common/i18n';
import { describe, expect, it } from 'vitest';
import { applyPlanSubmission, checkPlanSubmission, newPlanGate } from '../../task-turn/task-plan';
import { renderTaskPlanHtml, renderTaskPlanPage, TASK_PLAN_PAGE_CSP } from '../task-plan-html';

const NOW = 1_800_000_000_000;
const plan = (extra: Record<string, unknown> = {}) =>
  applyPlanSubmission(
    newPlanGate(NOW),
    checkPlanSubmission({
      summary: '새 작업에 계획 모드를 넣는다',
      intent: '긴 지시가 잘못 읽힌 채 실행되지 않게',
      ssot: ['plan 토글 on/off 추가 (디폴트 on)'],
      intents: [{ id: 'I1', text: '실행 전 확인' }],
      phases: [
        {
          title: '서버 게이트',
          goal: '승인 전에는 실행하지 않는다',
          steps: [
            { title: '계획 제출 도구', detail: '도구 이름은 plan_submit', deliverable: 'plan-server.ts', refs: ['T2'] },
          ],
        },
        { title: '화면', steps: [{ title: '디테일 카드' }] },
      ],
      assumptions: ['대시보드 작업만'],
      risks: ['계획 중 작업 시작'],
      outOfScope: ['Slack 채널'],
      questions: ['에픽도?'],
      ...extra,
    }),
    NOW,
  ).plan!;

describe('renderTaskPlanHtml — high level to detail (T3)', () => {
  it('draws the levels in order: conclusion → phase map → phases → steps → details', () => {
    const html = renderTaskPlanHtml(plan());
    const at = (s: string) => html.indexOf(s);
    expect(at('data-level="0"')).toBeGreaterThanOrEqual(0);
    expect(at('data-level="0"')).toBeLessThan(at('data-level="1"'));
    expect(at('data-level="1"')).toBeLessThan(at('data-level="2"'));
    expect(at('data-level="2"')).toBeLessThan(at('data-level="3"'));
    // The conclusion leads; the phase map names every phase before any phase's body.
    expect(at('새 작업에 계획 모드를 넣는다')).toBeLessThan(at('tp-map'));
    expect(at('tp-map')).toBeLessThan(at('계획 제출 도구'));
    expect(at('계획 제출 도구')).toBeLessThan(at('도구 이름은 plan_submit'));
    expect(html).toContain('v1');
    for (const s of ['대시보드 작업만', '계획 중 작업 시작', 'Slack 채널', '에픽도?', 'I1', 'T2', 'plan-server.ts']) {
      expect(html).toContain(s);
    }
  });

  it('escapes everything the model wrote — no markup of its own reaches the page', () => {
    const html = renderTaskPlanHtml(
      plan({
        summary: '<script>alert(1)</script>',
        phases: [{ title: '"><img src=x onerror=1>', steps: [{ title: 'a&b' }] }],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a&amp;b');
  });

  it('leaves out the sections a plan does not have', () => {
    const html = renderTaskPlanHtml(
      plan({ assumptions: undefined, risks: undefined, outOfScope: undefined, questions: undefined, ssot: undefined }),
    );
    expect(html).not.toContain('tp-risks');
    expect(html).not.toContain('tp-ssot');
  });
});

describe('renderTaskPlanPage — the full-page view', () => {
  it('is a whole document with the fragment, no script, and a closed content policy', () => {
    const page = renderTaskPlanPage(plan(), { title: 'soma-work 대시보드 개선', state: 'awaiting' });
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('soma-work 대시보드 개선');
    expect(page).toContain('data-level="3"');
    expect(page).not.toMatch(/<script/i);
    expect(TASK_PLAN_PAGE_CSP).toContain("default-src 'none'");
    expect(TASK_PLAN_PAGE_CSP).toContain("script-src 'none'");
    // An opaque origin: sandbox without allow-same-origin (review R1, grok P1).
    expect(TASK_PLAN_PAGE_CSP.split(';')[0].trim()).toBe('sandbox');
    expect(TASK_PLAN_PAGE_CSP).not.toContain('allow-same-origin');
  });
  it('dark mode wins over the shared light defaults (the dark colours come after TASK_PLAN_CSS)', () => {
    // Same selector (.tp), so the later rule wins: dark set before the shared CSS was overridden by its
    // light defaults — dark text on a black page (phase titles, notes) (review R1, browser check).
    const page = renderTaskPlanPage(plan(), { title: 't', state: 'awaiting' });
    const shared = page.indexOf('.tp { --tp-text: var(--ib-text');
    const dark = page.indexOf('@media (prefers-color-scheme: dark)');
    expect(shared).toBeGreaterThan(-1);
    expect(dark).toBeGreaterThan(shared);
    expect(page.slice(dark)).toContain('--tp-text: #f5f5f7');
  });
});

describe("the plan in the display language (#771) — the labels are ours, the plan text is the model's", () => {
  // The English catalog src/index.ts loads (`@soma/common/i18n-en`).
  const CATALOG = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog');
  registerDisplayCatalog('en', JSON.parse(readFileSync(join(CATALOG, 'en-text.json'), 'utf8')));
  const OWN = ['작업 계획', '의도', '지시 원문', '산출물', '확인할 것', '가정', '위험', '범위 밖', '승인 대기', '단계'];

  it("en: every label in English; the model's words as written", () => {
    const html = runWithDisplayLang('en', () => renderTaskPlanHtml(plan(), { state: 'awaiting' }));
    for (const word of OWN) expect(html, word).not.toContain(word);
    expect(html).toContain('Plan v1 · Awaiting approval');
    expect(html).toContain('>Intent<');
    expect(html).toContain('>Outputs<');
    expect(html).toContain('aria-label="Phases"');
    for (const s of ['새 작업에 계획 모드를 넣는다', '서버 게이트', '대시보드 작업만', '에픽도?'])
      expect(html).toContain(s);
    const page = runWithDisplayLang('en', () => renderTaskPlanPage(plan(), { title: 'soma-work', state: 'approved' }));
    expect(page).toContain('<title>Plan v1 — soma-work</title>');
    expect(page).toContain('Plan v1 · Started');
  });

  it('ko (the default): byte for byte as before', () => {
    const html = renderTaskPlanHtml(plan(), { state: 'awaiting' });
    expect(html).toContain('작업 계획 v1 · 승인 대기');
    expect(html).toContain('<span class="tp-label">의도</span>');
    expect(html).toContain('aria-label="단계"');
    expect(renderTaskPlanPage(plan(), { title: 't', state: 'awaiting' })).toContain('<title>작업 계획 v1 — t</title>');
  });
});
