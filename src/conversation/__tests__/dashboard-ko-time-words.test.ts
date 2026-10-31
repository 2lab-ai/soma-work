/**
 * D8 — one language on the dashboard: Korean chrome, Korean time words, keep-all on every page.
 * Executes the shipped page code (cut out of renderDashboardPage()'s template literal and cooked as the
 * browser receives it — the harness of dashboard-live-surfaces-client.test.ts).
 *
 *   T1  the page's settled-time words are @2lab.ai/ui's Korean: formatNmSSs(ms) === fmtSpan(ms, 'ko') and
 *       formatSince(ms) === fmtSince(ms, 'ko') over a range of values (the library's own functions, imported
 *       from its elapsed module under DOM shims — never evaluated as text)
 *   T2  every <ui-elapsed> the page writes carries lang="ko" (the element reads its own lang, not the page's);
 *       formatDuration keeps '' for nothing and the library's words otherwise; cronAgo speaks fmtSince
 *   T3  the chrome words are Korean: the effort levels, the session actions (중지 · 휴지통 · 닫기 · 즐겨찾기),
 *       the agent tabs (메인) and section tabs (대화), the starred group, the breadcrumb and section label,
 *       the system turn (no page name — the element's 시스템), the compaction / goal / token words
 *   T4  keep-all on every page body: the dashboard, the viewer and the settings page break Korean between words
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderSettingsPage } from '../settings-page';
import { renderConversationListPage } from '../viewer';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, ...vars].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

type Fmt = {
  formatNmSSs: (ms: unknown) => string;
  formatSince: (ms: unknown) => string;
  formatDuration: (ms: unknown) => string;
  elapsedHtml: (since: number, title?: string) => string;
  agoHtml: (at: number) => string;
  activeTimeHtml: (leg: number, acc: number, title?: string) => string;
  cronAgo: (ms: number, now: number) => string;
  EFFORT_LABELS: Record<string, string>;
};
const page = load<Fmt>(
  ['formatNmSSs', 'formatSince', 'formatDuration', 'elapsedHtml', 'agoHtml', 'activeTimeHtml', 'cronAgo'],
  ['EFFORT_LABELS'],
  {
    toNum: (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0),
    escAttr: (s: string) => String(s).replace(/"/g, '&quot;'),
  },
);

// The library's own words. Its elapsed module defines a custom element at load, so the two DOM globals it
// touches are shimmed before the import — the functions under test are pure.
type ElapsedModule = Pick<typeof import('@2lab.ai/ui/dist/components/elapsed/index.js'), 'fmtSpan' | 'fmtSince'>;
let lib: ElapsedModule;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  if (!g.HTMLElement) g.HTMLElement = class {};
  if (!g.customElements) g.customElements = { define() {}, get() {} };
  // @ts-expect-error TS2307 — the package's "exports" subpath resolves under node16 / bundler resolution; this
  // tsconfig is "node" (vitest resolves it; auth-pages.test.ts's './server' has a typesVersions entry, this has none).
  lib = (await import('@2lab.ai/ui/elapsed')) as ElapsedModule;
});

const SPANS = [
  0, 1, 999, 1000, 5000, 42_000, 59_000, 59_999, 60_000, 61_000, 65_000, 562_000, 600_000, 3_599_000, 3_600_000,
  3_601_000, 3_900_000, 8_100_000, 36_000_000, 86_399_000, 86_400_000, 90_000_000, 720_000_000,
];
const SINCES = [
  0,
  1000,
  44_000,
  44_999,
  45_000,
  59_000,
  60_000,
  90_000,
  300_000,
  3_599_000,
  3_600_000,
  3_601_000,
  10_800_000,
  47 * 3_600_000,
  48 * 3_600_000 - 1,
  48 * 3_600_000,
  49 * 3_600_000,
  10 * 86_400_000,
  400 * 86_400_000,
];

describe('T1 — the page speaks the library’s Korean for a settled time', () => {
  it('formatNmSSs(ms) === fmtSpan(ms, "ko"): 42초 · 9분 22초 · 2시간 15분', () => {
    for (const ms of SPANS) expect(page.formatNmSSs(ms), `${ms}ms`).toBe(lib.fmtSpan(ms, 'ko'));
    expect(page.formatNmSSs(5000)).toBe('5초');
    expect(page.formatNmSSs(562_000)).toBe('9분 22초');
    expect(page.formatNmSSs(65_000)).toBe('1분 05초');
    expect(page.formatNmSSs(8_100_000)).toBe('2시간 15분');
    expect(page.formatNmSSs(3_900_000)).toBe('1시간 05분');
  });
  it('formatSince(ms) === fmtSince(ms, "ko"): 방금 · 5분 전 · 3시간 전 · 2일 전', () => {
    for (const ms of SINCES) expect(page.formatSince(ms), `${ms}ms`).toBe(lib.fmtSince(ms, 'ko'));
    expect(page.formatSince(30_000)).toBe('방금');
    expect(page.formatSince(300_000)).toBe('5분 전');
    expect(page.formatSince(10_800_000)).toBe('3시간 전');
    expect(page.formatSince(49 * 3_600_000)).toBe('2일 전');
  });
  it('nothing, a negative or NaN reads as the library does (0초 · 방금)', () => {
    for (const v of [undefined, null, '', Number.NaN, -1, -60_000]) {
      expect(page.formatNmSSs(v)).toBe(lib.fmtSpan(Number(v) || 0, 'ko'));
      expect(page.formatSince(v)).toBe(lib.fmtSince(Number(v) || 0, 'ko'));
    }
    expect(page.formatNmSSs(Number.NaN)).toBe('0초');
    expect(page.formatSince(-5)).toBe('방금');
  });
});

describe('T2 — every live time is the element in Korean; the settled ones say the same', () => {
  it('elapsedHtml / agoHtml write lang="ko" on <ui-elapsed> (it reads its own lang, not the page’s)', () => {
    expect(page.elapsedHtml(1_700_000_000_000)).toBe('<ui-elapsed since="1700000000000" lang="ko"></ui-elapsed>');
    expect(page.elapsedHtml(1_700_000_000_000, '활성 시간')).toBe(
      '<ui-elapsed since="1700000000000" lang="ko" title="활성 시간"></ui-elapsed>',
    );
    expect(page.agoHtml(1_700_000_000_000)).toBe(
      '<ui-elapsed since="1700000000000" format="ago" lang="ko"></ui-elapsed>',
    );
    expect(page.activeTimeHtml(1_700_000_000_000, 5000)).toBe(
      '<ui-elapsed since="1699999995000" lang="ko"></ui-elapsed>',
    );
    // No <ui-elapsed> in the page's script without its lang.
    const written = TEMPLATE.match(/<ui-elapsed [^>]*>/g) ?? [];
    expect(written.length).toBeGreaterThan(0);
    for (const tag of written) expect(tag, tag).toContain('lang="ko"');
  });
  it('a closed 활성 시간 is settled text in the same words; formatDuration keeps "" for nothing; cronAgo speaks fmtSince', () => {
    expect(page.activeTimeHtml(0, 65_000, '활성 시간')).toBe('<span title="활성 시간">1분 05초</span>');
    expect(page.formatDuration(0)).toBe('');
    expect(page.formatDuration(-1)).toBe('');
    expect(page.formatDuration(undefined)).toBe('');
    for (const ms of SPANS.filter((x) => x > 0)) expect(page.formatDuration(ms)).toBe(lib.fmtSpan(ms, 'ko'));
    const now = 1_700_000_000_000;
    expect(page.cronAgo(now - 300_000, now)).toBe('5분 전');
    expect(page.cronAgo(now - 49 * 3_600_000, now)).toBe('2일 전');
    // The page's own 0초 where a settled time is empty; no English unit left in a time word.
    expect(TEMPLATE).toContain("formatDuration(completed - started) || '0초'");
    expect(TEMPLATE).not.toMatch(/\+ '(s|m |h |d )'/);
    expect(TEMPLATE).not.toContain('capCountdown');
  });
  it('the viewer page writes its <ui-elapsed> in Korean too', () => {
    const VIEWER_TS = readFileSync(join(__dirname, '..', 'viewer.ts'), 'utf-8');
    for (const tag of VIEWER_TS.match(/<ui-elapsed [^>]*>/g) ?? []) expect(tag, tag).toContain('lang="ko"');
  });
});

describe('T3 — the chrome is Korean', () => {
  it('effort levels: 낮음 · 보통 · 높음 · 매우 높음 · 최대', () => {
    expect(page.EFFORT_LABELS).toEqual({ low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' });
  });
  it('session actions 중지 · 휴지통 · 닫기, the star 즐겨찾기 (both states), the starred group; the sibling lock in Korean', () => {
    expect(TEMPLATE).toContain("var label = kind === 'stop' ? '중지' : (kind === 'trash' ? '휴지통' : '닫기');");
    expect(TEMPLATE).toContain("stop: '중지 — 세션 중지'");
    expect(TEMPLATE).toContain("close: '닫기 — 세션 종료'");
    expect(TEMPLATE).toContain("trash: '휴지통 — 세션 휴지통으로'");
    // The source is a template literal: its \u escapes carry a doubled backslash on disk.
    expect(TEMPLATE).toContain("label: starred ? '\\\\u2605 즐겨찾기' : '\\\\u2606 즐겨찾기'");
    expect(TEMPLATE).toContain("groups.unshift({ key: 'starred', label: '\\\\u2605 즐겨찾기'");
    expect(PAGE_STRINGS.siblingLock({ instanceName: 'other', host: 'h', port: 1 })).toBe(
      '이 세션은 other (h:1)에서 열어 조작하세요',
    );
    expect(TEMPLATE).toContain('lock: STRINGS.siblingLock(env) }];');
    expect(TEMPLATE).toContain('if (isSiblingSession(s)) return STRINGS.siblingLock(env);');
    expect(TEMPLATE).not.toContain('to act on this session');
    for (const en of ["'Stop'", "'Trash'", "'Close'", 'Starred', "'\\u2606 Star'"])
      expect(TEMPLATE, en).not.toContain(en);
  });
  it('tabs 메인 · 대화; the Tasks head 작업; breadcrumb and section 에이전트 인박스; 목표 regions and badges', () => {
    expect(TEMPLATE).toContain("var tabs = [tab(PT_MAIN, st0, '메인', model, true)];");
    expect(TEMPLATE).toContain("{ id: 'conv', label: '대화', title: '지시와 답변' },");
    expect(TEMPLATE).toContain("var title = '작업' + (scopeLabel ?");
    expect(TEMPLATE).toContain('<section class="inbox ui-tok" id="inbox" aria-label="에이전트 인박스">');
    // D8b A-16: the trail is <ui-breadcrumbs lang="ko">; its crumbs are the page's data.
    expect(TEMPLATE).toContain('<ui-breadcrumbs class="crumbs" id="inbox-trail" lang="ko"></ui-breadcrumbs>');
    // The root crumb keeps the reader's user scope (R-D8 P3): /dashboard/<userId> as the URL says it, painted again on a user switch.
    expect(TEMPLATE).toContain(
      "var home = currentUserId ? '/dashboard/' + encodeURIComponent(currentUserId) : '/dashboard';",
    );
    expect(TEMPLATE).toContain(
      "taskElData(el, { items: [{ label: 'soma-work', href: home }, { label: '에이전트 인박스' }] });",
    );
    expect(clientFn('selectUser')).toContain('paintTrail();');
    expect(TEMPLATE).not.toContain('crumb-cur');
    expect(TEMPLATE).toContain('aria-label="작업" tabindex="-1"></div>');
    expect(TEMPLATE).toContain('aria-label="목표" style="display:none"></div>');
    expect(TEMPLATE).toContain("label: n ? '목표 #' + n[1] + '/' + n[2] : '목표'");
    // No chrome string starts with the English word (a console.error message is not chrome).
    expect(TEMPLATE).not.toMatch(/'Goal (#|자동|계속|완료|판정)|'Goal'/);
    expect(TEMPLATE).toContain('<title>soma-work 대시보드</title>');
  });
  it('effort reads 추론 강도 everywhere a person sees it; the New task levels are the Korean words, not the ids (R-D8 P2)', () => {
    expect(TEMPLATE).toContain('aria-label="이 세션의 모델과 추론 강도"');
    expect(TEMPLATE).toContain("var title = kind === 'model' ? '새 세션 기본 모델' : '새 세션 기본 추론 강도';");
    expect(TEMPLATE).toContain(
      "return { text: '이미 추론 강도 ' + effortLabel(res.effort) + '입니다', error: false };",
    );
    // The <select>'s option text is what the sweep cannot see: the level's word (낮음 … 최대), its id the value.
    expect(TEMPLATE).toContain(
      "return '<option value=\"' + escAttr(e) + '\"' + (e === _ntState.effort ? ' selected' : '') + '>' + esc(effortLabel(e)) + '</option>';",
    );
    expect(TEMPLATE).not.toMatch(/'[^'\n]*[가-힣][^'\n]*\beffort\b[^'\n]*'/);
  });
  it('the system turn carries no page name — the element says 시스템 under lang="ko"; the open card says 시스템', () => {
    expect(clientFn('convSysTurn')).toContain("var x = { id: id, role: 'system', kind:");
    expect(clientFn('convSysTurn')).not.toContain("name: 'System'");
    expect(TEMPLATE).toContain('<span class="io-who is-sys">시스템</span>');
    expect(TEMPLATE).not.toContain("'System'");
  });
  it('tokens, effort, compaction, titles: 토큰 · 추론 · 자동 압축 · 제목 없음 · 사용자 · 어시스턴트 · 나', () => {
    expect(TEMPLATE).not.toMatch(/' tok'|' tokens|' tok · '/);
    expect(TEMPLATE).toContain("' 토큰 · '");
    expect(TEMPLATE).toContain('<span class="td-prefix">추론 </span>');
    expect(TEMPLATE).toContain('<label class="ui-select-chip nt-chip-effort"><span>추론</span>');
    expect(TEMPLATE).toContain("'(으)로 전환 · 자동 압축 '");
    // No string the page shows says "autocompact" (comments may).
    expect(TEMPLATE).not.toMatch(/'[^'\n]*autocompact[^'\n]*'/);
    expect(TEMPLATE).toContain("s.title || '제목 없음'");
    expect(TEMPLATE).toContain("name: String(t.userName || '사용자')");
    expect(TEMPLATE).toContain("BOT_NAME || '어시스턴트'");
    expect(TEMPLATE).toContain("userName: '나',");
    expect(TEMPLATE).toContain("e[0] === 'default' ? '기본' : e[0]");
    expect(TEMPLATE).toContain("['SDK 트리거', c.trigger]");
    expect(TEMPLATE).toContain("return '컨텍스트 윈도우 사용량' +");
    expect(TEMPLATE).toContain('|| STRINGS.error)');
    expect(TEMPLATE).not.toContain("|| 'Error')");
  });
});

describe('T4 — keep-all on every page body', () => {
  const RULE = 'html:lang(ko) body { word-break: keep-all; overflow-wrap: anywhere; }';
  it('the dashboard', () => {
    expect(TEMPLATE).toContain(RULE);
  });
  it('the viewer (its h1 and time line inherit it)', () => {
    const html = renderConversationListPage([]);
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain(RULE);
  });
  it('the settings page (its h1 inherits it)', () => {
    const html = renderSettingsPage();
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain(RULE);
  });
});
