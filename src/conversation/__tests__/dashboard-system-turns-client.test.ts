/**
 * Dashboard SSOT 2026-10-27 — the detail panel's conversation: a turn the user
 * did not type reads as one line, and the skills an instruction invoked read
 * as badges. Executes the shipped page code (cut out of renderDashboardPage()'s
 * template literal, the harness of dashboard-user-media-client.test.ts).
 *
 *   C1  sysTurnInfo: what soma-work injected — /compact (자동 압축 / 압축),
 *       restart resume, error retry, goal continuation (Goal #n/m), cron,
 *       /renew save + load, any other host turn — each producer's wording
 *       pinned against its source; a turn a person sent is never one of them
 *   C2  the one-line row: who · when · badge · what it did, opening to its
 *       facts and the raw prompt
 *   C3  /compact: progress (elapsed / estimate, %) while it runs, its numbers
 *       once done; cpTick keeps it live only while it is the latest turn of a
 *       working session
 *   C4  skills: the <invoked_skills> block becomes badges (name · estimated
 *       tokens) that open the skill body, written on first open
 *   C5  background-work-resume: the host prompt that keeps a turn going while
 *       background work runs reads as its own badge (백그라운드 재개 #n/m)
 *   C6  the inbox's open card (지시 / 응답): the same one line + badge for a
 *       turn the user did not type, skill badges under the user's words, and a
 *       /compact's progress or result as the 응답 — open state kept per
 *       conversation across the card's morph re-render
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBackgroundWaitPrompt } from '@soma/slack/pipeline/background-wait';
import { describe, expect, it, vi } from 'vitest';
import { buildGoalContinuationPrompt } from '../../prompt/session-goal-block';
import { GOAL_CONTINUATION_TEXT_PREFIX } from '../../slack/goal-continuation';
import type { SessionGoal } from '../../types';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const DASHBOARD_TS = read('src/conversation/dashboard.ts');
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
// Cut once per name: every test loads the same shipped functions.
const cooked = new Map<string, string>();
function clientFn(name: string): string {
  const hit = cooked.get(`fn:${name}`);
  if (hit) return hit;
  const src = cutFn(name);
  cooked.set(`fn:${name}`, src);
  return src;
}
function cutFn(name: string): string {
  assertUnique(name);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const hit = cooked.get(`var:${name}`);
  if (hit) return hit;
  const src = cutVar(name);
  cooked.set(`var:${name}`, src);
  return src;
}
function cutVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const SYS_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'decodeSlackEntities',
  'formatTokens',
  'formatDuration',
  'sysOneLine',
  'sysBetween',
  'sysResumeContext',
  'sysTurnInfo',
  'cpClock',
  'cpState',
  'cpProgressHtml',
  'cpLineHtml',
  'cpFacts',
  'sysFactsHtml',
  'renderSysTurn',
  'cpEnsureTicker',
  'cpTick',
  'estimateTokens',
  'splitInvokedSkills',
  'skillBadgesHtml',
];
const SYS_VARS = [
  'SYS_RESTART_HEADS',
  'SYS_RESUME_CONTEXT',
  'SYS_RETRY_MARK',
  'CP_DEFAULT_EST_MS',
  'CP_MAX_MS',
  '_cpTimer',
  '_skillBodies',
  '_skillSeq',
];

type Info = { kind: string; label: string; line: string; raw: string; facts: [string, string][] } | null;
type Api = {
  sysTurnInfo(t: unknown): Info;
  renderTurn(t: unknown, i?: number, arr?: unknown[], cid?: string): string;
  splitInvokedSkills(raw: string): { text: string; skills: { name: string; body: string; tokens: number }[] };
  estimateTokens(s: string): number;
};

function api(extra: Record<string, unknown> = {}) {
  const setInterval = vi.fn(() => 7);
  const a = load<Api>([...SYS_FNS, 'renderTurn'], SYS_VARS, {
    panelConvId: 'conv-sys',
    _artCache: {},
    renderTurnArtifacts: () => '',
    umRegister: () => {},
    renderUserMedia: () => '',
    ansStateHtml: () => '',
    setInterval,
    ...extra,
  });
  return { ...a, setInterval };
}
const user = (rawContent: string, extra: Record<string, unknown> = {}) => ({
  id: 'u1',
  role: 'user',
  timestamp: Date.now(),
  userName: 'Z',
  rawContent,
  ...extra,
});
const SYSTEM = { origin: { by: 'system' } };
const PERSON = { origin: { by: 'user' } };

const RESTART_PROMPT = read('src/prompt/restart.prompt').trimEnd();
const goalPrompt = (n: number, max: number, reason?: string) =>
  `${GOAL_CONTINUATION_TEXT_PREFIX} ${buildGoalContinuationPrompt({
    continuationCount: n,
    maxContinuations: max,
    lastEvalReason: reason,
  } as unknown as SessionGoal)}`;

describe('C1 — what soma-work injected, by its own wording', () => {
  it('/compact: 자동 압축 when soma-work sent it, 압축 when a person did or nobody recorded who', () => {
    const { sysTurnInfo } = api();
    expect(sysTurnInfo(user('/compact', { ...SYSTEM, compact: {} }))).toMatchObject({
      kind: 'compact',
      label: '자동 압축',
    });
    expect(sysTurnInfo(user('/compact', { ...PERSON, compact: {} }))).toMatchObject({ kind: 'compact', label: '압축' });
    // The recorder marks every compaction turn (the executor's flag): /compact
    // with instructions, too. A newer turn without the mark is words.
    expect(sysTurnInfo(user('/compact 인증 쪽 위주로', { ...PERSON, compact: {} }))).toMatchObject({ kind: 'compact' });
    expect(sysTurnInfo(user('/compact', PERSON))).toBeNull();
    const legacy = sysTurnInfo(user('/compact'));
    expect(legacy).toMatchObject({ kind: 'compact', label: '압축' });
    expect(legacy?.facts).toContainEqual(['실행', '기록 없음 (출처를 저장하기 전의 턴)']);
    expect(sysTurnInfo(user('/compactify the list'))).toBeNull();
    // soma-work records only the bare command; a goal objective that starts with
    // it (executor literalPrompt) is the user's words.
    expect(sysTurnInfo(user('/compact 명령의 버그를 고쳐라'))).toBeNull();
    expect(sysTurnInfo(user('/compact 명령의 버그를 고쳐라', PERSON))).toBeNull();
  });

  it('restart resume — the restart.prompt text, recorded with or without an origin', () => {
    const { sysTurnInfo } = api();
    expect(sysTurnInfo(user(RESTART_PROMPT, SYSTEM))).toMatchObject({ kind: 'restart', label: '시스템 재시작' });
    expect(sysTurnInfo(user(RESTART_PROMPT))).toMatchObject({ kind: 'restart', line: '중단된 작업 자동 재개' });
    // The fallback slack-handler uses when the prompt file is missing.
    const handler = read('src/slack-handler.ts');
    const fallbackHead = '서비스가 재시작되어 이전 작업이 중단되었다.';
    expect(handler).toContain(`'${fallbackHead} `);
    expect(sysTurnInfo(user(`${fallbackHead} 아래 순서로 작업을 이어가라:`))).toMatchObject({ kind: 'restart' });
  });

  it('the resume context autoResumeSession appends: title, workflow — and an error makes it a retry', () => {
    const { sysTurnInfo } = api();
    const handler = read('src/slack-handler.ts');
    expect(handler).toContain('\\n\\n--- 중단 시점 컨텍스트 ---\\n');
    expect(handler).toContain('`세션 제목: ${session.title}`');
    expect(handler).toContain('`워크플로우: ${session.workflow}`');
    expect(handler).toContain('`⚠️ 이전 시도 중 오류 발생: ${errorContext}`');

    const ctx = (lines: string[]) => `${RESTART_PROMPT}\n\n--- 중단 시점 컨텍스트 ---\n${lines.join('\n')}`;
    const restart = sysTurnInfo(user(ctx(['세션 제목: 대시보드 개선', '워크플로우: z']), SYSTEM));
    expect(restart).toMatchObject({ kind: 'restart', line: '중단된 작업 자동 재개 · 대시보드 개선' });
    expect(restart?.facts).toContainEqual(['워크플로우', 'z']);

    const retry = sysTurnInfo(
      user(ctx(['세션 제목: 대시보드 개선', '⚠️ 이전 시도 중 오류 발생: 429 rate limited']), SYSTEM),
    );
    expect(retry).toMatchObject({ kind: 'retry', label: '자동 재시도', line: '오류 뒤 자동 재개 · 429 rate limited' });
    expect(retry?.facts[0]).toEqual(['이전 오류', '429 rate limited']);
  });

  it('goal continuation — Goal #n/m and the evaluator gap, from the real prompt builder', () => {
    const { sysTurnInfo } = api();
    const plain = sysTurnInfo(user(goalPrompt(2, 10), SYSTEM));
    expect(plain).toMatchObject({ kind: 'goal', label: 'Goal #2/10', line: 'Goal 자동 계속' });
    const gap = 'The work summary contains no evidence at all: <files> missing';
    const withGap = sysTurnInfo(user(goalPrompt(3, 10, gap)));
    expect(withGap).toMatchObject({ kind: 'goal', label: 'Goal #3/10' });
    expect(withGap?.line).toBe(`직전 평가: ${gap}`);
    expect(withGap?.facts).toEqual([
      ['회차', '3 / 10'],
      ['직전 평가에서 남은 일', gap],
    ]);
  });

  it('cron — the [cron:<name>] prefix cronText writes', () => {
    const { sysTurnInfo } = api();
    expect(read('src/cron-scheduler.ts')).toContain('return `[cron:${job.name}] ${job.prompt}`;');
    expect(sysTurnInfo(user('[cron:daily-report] 어제 머지된 PR 요약', SYSTEM))).toMatchObject({
      kind: 'cron',
      label: '크론',
      line: 'daily-report · 어제 머지된 PR 요약',
    });
  });

  it('/renew — the save prompt (a command the user typed) and the load continuation', () => {
    const { sysTurnInfo } = api();
    const renew = read('src/slack/commands/renew-handler.ts');
    expect(renew).toContain('const savePrompt = `Follow this exact sequence:');
    expect(renew).toContain('skill="local:save"');
    const save = 'Follow this exact sequence:\n\n1. Invoke Skill tool: skill="local:save"\n2. ...';
    expect(sysTurnInfo(user(save, PERSON))).toMatchObject({ kind: 'renew', line: '컨텍스트 저장 (1/2)' });

    const exec = read('packages/slack/src/pipeline/stream-executor.ts');
    expect(exec).toContain("const loadPrompt = `Use 'local:load' skill with this saved context:");
    expect(exec).toContain('<user-instruction>${userMessage}</user-instruction>');
    const load = `Use 'local:load' skill with this saved context:\n<save>\nctx\n</save>\n\nAfter loading the context, execute this user instruction:\n<user-instruction>PR 마무리</user-instruction>`;
    const info = sysTurnInfo(user(load, SYSTEM));
    expect(info).toMatchObject({ kind: 'renew', line: '저장된 컨텍스트 불러오기 · PR 마무리' });
    expect(info?.facts).toContainEqual(['이어서 할 지시', 'PR 마무리']);
  });

  it('any other host turn reads as 자동 입력; a person never reads as an injected kind', () => {
    const { sysTurnInfo } = api();
    expect(sysTurnInfo(user('Continue the handoff: phase 2 of 5', SYSTEM))).toMatchObject({
      kind: 'system',
      label: '자동 입력',
      line: 'Continue the handoff: phase 2 of 5',
    });
    // A person pasting the goal prompt into their message is still their message.
    expect(sysTurnInfo(user(goalPrompt(2, 10), PERSON))).toBeNull();
    expect(sysTurnInfo(user(RESTART_PROMPT, PERSON))).toBeNull();
    expect(sysTurnInfo(user('대시보드 고쳐줘'))).toBeNull();
    expect(sysTurnInfo({ role: 'assistant', rawContent: '/compact' })).toBeNull();
  });
});

describe('C2 — the one-line row', () => {
  it('who · when · badge · line, opening to the facts and the raw prompt (escaped)', () => {
    const { renderTurn } = api();
    const raw = `${goalPrompt(2, 10, 'needs <evidence> & tests')}`;
    const out = renderTurn(user(raw, SYSTEM));
    expect(out).toMatch(/^<div class="turn user is-sys" data-sys="goal" data-turn-id="u1" data-ts="\d+">/);
    expect(out).toContain('<div class="turn-avatar user-avatar">Z</div>');
    expect(out).toContain('<details class="sys-turn"><summary class="sys-row"><span class="sys-row-in">');
    expect(out).toContain('<span class="turn-name">Z</span>');
    expect(out).toContain('<span class="sys-badge" data-kind="goal">Goal #2/10</span>');
    expect(out).toContain('<span class="sys-line">직전 평가: needs &lt;evidence&gt; &amp; tests</span>');
    expect(out).toContain('<dt>회차</dt><dd>2 / 10</dd>');
    expect(out).toContain(
      '<div class="sys-raw-h">원본 프롬프트</div><pre class="sys-raw">[goal-continuation] Continue working',
    );
    expect(out).toContain('&lt;previous-eval-reason&gt;');
    expect(out).not.toContain('turn-content'); // never the raw prompt as the face
  });

  it('files on a one-line turn (the message the auto-compact intercepted) open with it', () => {
    const registered: unknown[] = [];
    const out = api({
      renderUserMedia: () => '<div class="um-media">FILES</div>',
      umRegister: (_cid: string, list: unknown[]) => registered.push(list),
    }).renderTurn(
      user('/compact', {
        ...SYSTEM,
        compact: {},
        timestamp: Date.now() - 3_600_000,
        attachments: [{ id: 'F1', name: 'a.png', kind: 'image' }],
      }),
    );
    expect(out).toContain('is-sys');
    expect(out).toContain('<div class="sys-detail"><div class="um-media">FILES</div>');
    expect(registered).toHaveLength(1); // the viewer can page through them
  });

  it('a restart row says so in one line', () => {
    const out = api().renderTurn(user(RESTART_PROMPT, SYSTEM));
    expect(out).toContain('<span class="sys-badge" data-kind="restart">시스템 재시작</span>');
    expect(out).toContain('<span class="sys-line">중단된 작업 자동 재개</span>');
    expect(out).toContain('<pre class="sys-raw">The service was restarted and the previous task was interrupted.');
  });

  it('a turn sent from the composer is the server turn once echoed (a later /compact result finds it)', () => {
    const ws = TEMPLATE.slice(
      TEMPLATE.indexOf("msg.type === 'conversation_update'"),
      TEMPLATE.indexOf("msg.type === 'session_action'"),
    );
    expect(ws).toContain('[data-turn-id^="optimistic-"]');
    expect(ws).toContain('updateTurnInPanel(optEl, msg.turn)');
    const send = TEMPLATE.slice(
      TEMPLATE.indexOf('const optimisticTurn = {'),
      TEMPLATE.indexOf('appendTurnToPanel(optimisticTurn);'),
    );
    expect(send).toContain("origin: { by: 'user' }");
  });

  it('an open row stays open when its turn re-renders (a /compact result landing)', () => {
    const src = clientFn('updateTurnInPanel');
    expect(src).toContain(".querySelector('.sys-turn[open]')");
    expect(src).toContain('sysEl.open = true');
  });
});

describe('C3 — /compact: progress while it runs, its numbers once done', () => {
  it('running: elapsed / default estimate, %, a progressbar — and the ticker starts', () => {
    const a = api();
    const out = a.renderTurn(user('/compact', { ...SYSTEM, compact: {}, timestamp: Date.now() - 42_000 }));
    expect(out).toContain('<span class="sys-badge" data-kind="compact">자동 압축</span>');
    expect(out).toContain('data-cp-live="1"');
    expect(out).toContain('data-cp-est="150000"');
    expect(out).toContain('<span class="cp-time"><span class="cp-verb">압축 중 · </span>0:42 / 약 2:30</span>');
    // Inside <summary> (a button) a progressbar role is dropped by AT: the bar is
    // decoration, the line's text carries the numbers.
    expect(out).toContain('<span class="cp-bar" aria-hidden="true"><i style="width:28%"></i></span>');
    expect(out).not.toContain('role="progressbar"');
    expect(out).toContain('<span class="cp-pct">28%</span>');
    expect(out).toContain('<dt>상태</dt><dd class="cp-state">진행 중</dd>');
    expect(out).toContain('<dt>예상 시간</dt><dd>2m 30s (기본값)</dd>');
    expect(a.setInterval).toHaveBeenCalledTimes(1);
  });

  it('the estimate is the conversation’s previous compaction when the turn carries one', () => {
    const out = api().renderTurn(
      user('/compact', { ...SYSTEM, timestamp: Date.now() - 45_000, compact: { estimateMs: 90_000 } }),
    );
    expect(out).toContain('<span class="cp-time"><span class="cp-verb">압축 중 · </span>0:45 / 약 1:30</span>');
    expect(out).toContain('<i style="width:50%"></i>');
    expect(out).toContain('<dd>1m 30s (직전 압축 기준)</dd>');
  });

  it('past the estimate: no false percentage — "예상보다 오래 걸리는 중" and a moving bar', () => {
    const out = api().renderTurn(user('/compact', { ...SYSTEM, compact: {}, timestamp: Date.now() - 200_000 }));
    expect(out).toContain(
      '<span class="cp-time"><span class="cp-verb">압축 중 · </span>3:20 / 약 2:30</span><span class="cp-over"> · 예상보다 오래 걸리는 중</span>',
    );
    expect(out).toContain('class="cp-bar is-over"');
    expect(out).not.toContain('cp-pct');
  });

  it('done: the badge, "자동 압축 처리" with before → after and the time; the facts in full', () => {
    const t0 = Date.now() - 3_600_000;
    const out = api().renderTurn(
      user('/compact', {
        ...SYSTEM,
        timestamp: t0,
        compact: {
          estimateMs: 120_000,
          endedAt: t0 + 134_000,
          durationMs: 134_000,
          preTokens: 182_340,
          postTokens: 31_020,
          trigger: 'manual',
        },
      }),
    );
    expect(out).not.toContain('data-cp-live');
    expect(out).toContain('<span class="sys-badge" data-kind="compact">자동 압축</span>');
    expect(out).toContain('<span class="sys-line">자동 압축 처리 · 182.3K → 31.0K 토큰 · 2m 14s</span>');
    expect(out).toContain('<dt>상태</dt><dd class="cp-state">완료</dd>');
    expect(out).toContain('<dt>압축 전 → 후</dt><dd>182,340 → 31,020 토큰 (−83%)</dd>');
    expect(out).toContain('<dt>걸린 시간</dt><dd>2m 14s</dd>');
    expect(out).toContain('<dt>예상 시간</dt><dd>2m 0s (직전 압축 기준)</dd>');
    expect(out).toContain('<dt>SDK trigger</dt><dd>manual</dd>');
    expect(out).toContain('<dt>실행</dt><dd>soma-work — 컨텍스트가 자동 압축 지점을 넘어 /compact 실행</dd>');
    expect(out).toContain('<pre class="sys-raw">/compact</pre>');
  });

  it('a /compact with a later turn after it is not live at render time (no first-frame flash)', () => {
    const t = user('/compact', { ...SYSTEM, compact: {}, timestamp: Date.now() - 30_000 });
    const next = user('다음 지시', { id: 'u2' });
    const out = api().renderTurn(t, 0, [t, next], 'conv-sys');
    expect(out).not.toContain('data-cp-live');
    expect(out).toContain('<span class="sys-line">자동 압축 처리</span>');
    expect(out).toContain('<dd class="cp-state">결과 기록 없음</dd>');
    // The last of a batch (or a pushed turn, no batch) is still live.
    expect(api().renderTurn(t, 1, [next, t], 'conv-sys')).toContain('data-cp-live="1"');
  });

  it('no result and older than a compaction can run: "압축 처리", 결과 기록 없음', () => {
    const out = api().renderTurn(user('/compact', { timestamp: Date.now() - 3_600_000 }));
    expect(out).toContain('<span class="sys-line">압축 처리</span>');
    expect(out).toContain('<dt>상태</dt><dd class="cp-state">결과 기록 없음</dd>');
    expect(out).not.toContain('data-cp-live');
  });

  // A minimal DOM for cpTick: nodes with attributes and a .cp-slot / .sys-badge.
  function fakeTurn(start: number, live = true) {
    const attrs: Record<string, string> = { 'data-cp-start': String(start), 'data-cp-est': '150000' };
    if (live) attrs['data-cp-live'] = '1';
    const slot = { innerHTML: '' };
    const state = { textContent: '진행 중' };
    return {
      slot,
      state,
      getAttribute: (k: string) => attrs[k] ?? null,
      removeAttribute: (k: string) => {
        delete attrs[k];
      },
      hasLive: () => 'data-cp-live' in attrs,
      querySelector: (sel: string) =>
        sel === '.cp-slot'
          ? slot
          : sel === '.cp-state'
            ? state
            : sel === '.sys-badge'
              ? { textContent: '자동 압축' }
              : null,
    };
  }
  const NOW = 1_792_900_000_000;
  function tick(
    turns: ReturnType<typeof fakeTurn>[],
    session: Record<string, unknown> | null,
    others: Record<string, unknown> = {},
  ) {
    const clearInterval = vi.fn();
    const document = {
      // The 응답 작성 중 row (.ans-pending, no data-ts) is always the list's last
      // child while the session works after a user turn — a /compact included.
      querySelectorAll: (sel: string) =>
        sel === '#panel-turns .turn[data-cp-live]'
          ? turns.filter((t) => t.hasLive())
          : sel === '#panel-turns > .turn[data-ts]'
            ? turns
            : sel === '#panel-turns > .turn'
              ? [...turns, { pending: true }]
              : [],
    };
    const { cpTick } = load<{ cpTick(): void }>(
      ['esc', 'toNum', 'cpClock', 'cpProgressHtml', 'cpTick'],
      ['CP_DEFAULT_EST_MS', 'CP_MAX_MS', '_cpTimer'],
      {
        document,
        clearInterval,
        Date: { now: () => NOW },
        panelSessionKey: 'k',
        _sessionCache: session ? { k: session, ...others } : { ...others },
      },
    );
    cpTick();
    return { clearInterval };
  }

  it('cpTick: the latest turn of a working session keeps ticking', () => {
    const t = fakeTurn(NOW - 75_000);
    tick([t], { activityState: 'working' });
    expect(t.hasLive()).toBe(true);
    expect(t.slot.innerHTML).toContain('<span class="cp-verb">압축 중 · </span>1:15 / 약 2:30');
    expect(t.slot.innerHTML).toContain('<i style="width:50%"></i>');
  });

  it('cpTick: a later turn landed, or the session stopped working → no longer live, no result kept', () => {
    const compact = fakeTurn(NOW - 30_000);
    const next = fakeTurn(NOW, false);
    tick([compact, next], { activityState: 'working' });
    expect(compact.hasLive()).toBe(false);
    // The same line and 상태 a fresh render of a result-less /compact shows.
    expect(compact.slot.innerHTML).toBe('<span class="sys-line">자동 압축 처리</span>');
    expect(compact.state.textContent).toBe('결과 기록 없음');

    const idle = fakeTurn(NOW - 30_000);
    tick([idle], { activityState: 'idle' });
    expect(idle.hasLive()).toBe(false);
  });

  it('cpTick: a session missing from a loaded board is not running; before the board loads it is undecided', () => {
    const gone = fakeTurn(NOW - 30_000);
    tick([gone], null, { other: { activityState: 'working' } });
    expect(gone.hasLive()).toBe(false);

    const early = fakeTurn(NOW - 30_000);
    tick([early], null);
    expect(early.hasLive()).toBe(true);
    expect(early.slot.innerHTML).toContain('</span>0:30 / 약 2:30');
  });

  it('cpTick: nothing live → the timer stops', () => {
    const { clearInterval } = tick([fakeTurn(NOW - 1000, false)], { activityState: 'working' });
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });
});

describe('C3b — on a narrow panel the row never overflows; the bar gives way first', () => {
  // Measured in Chromium (shipped CSS + renderer) at 320 / 400px panels: no
  // horizontal overflow, overdue or not, short or long names. A no-shrink rule on
  // the line would overflow (it holds the overdue suffix too).
  it('the bar shrinks first (high shrink weight), then the line truncates from its end', () => {
    expect(TEMPLATE).toMatch(/\.cp-bar \{ flex: 0 1000 120px; min-width: 0; max-width: 120px;/);
    expect(TEMPLATE).not.toContain('.cp-slot > .sys-line { flex-shrink: 0; }');
    // Priority by weight ratio (bar 1000 : line 1). Every weight stays
    // ≥ 1: below 1 the flex algorithm hands out only that fraction of the space
    // to shrink, and the row overflows.
    expect(TEMPLATE).not.toMatch(/flex-shrink: 0\.\d/);
  });
  it('the name never shrinks (a long one is capped with an ellipsis); the time never wraps', () => {
    expect(TEMPLATE).toContain('.sys-row-in .turn-time { flex: none; white-space: nowrap; }');
    expect(TEMPLATE).toMatch(
      /\.sys-row-in \.turn-name \{ flex: none; max-width: 6em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/,
    );
  });
  it('a narrow row drops what is said elsewhere — the default desktop drawer keeps the name', () => {
    expect(TEMPLATE).toMatch(/\.sys-turn \{ container: sysrow \/ inline-size; \}/);
    // ≤ 420px (the default 440px drawer's row is ~355px): "압축 중" goes, the name stays.
    expect(TEMPLATE).toMatch(/@container sysrow \(max-width: 420px\) \{ \.cp-verb \{ display: none; \} \}/);
    // ≤ 340px (phones): the name goes too — the avatar shows it.
    expect(TEMPLATE).toMatch(
      /@container sysrow \(max-width: 340px\) \{ \.sys-row-in \.turn-name \{ display: none; \} \}/,
    );
  });

  it('a running line never cuts its times: only the overdue words take the ellipsis', () => {
    expect(TEMPLATE).toContain('.turn[data-cp-live] .cp-slot > .sys-line { display: contents; }');
    expect(TEMPLATE).toContain('.cp-time { flex: none; white-space: nowrap; }');
    expect(TEMPLATE).toContain(
      '.cp-over { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    );
    expect(TEMPLATE).toMatch(/@container sysrow \(max-width: 280px\) \{ \.cp-pct \{ display: none; \} \}/);
  });

  it('the overdue words sit after the times, so the ellipsis cuts them first', () => {
    const { cpProgressHtml } = load<{ cpProgressHtml(e: number, est: number): string }>(
      ['esc', 'cpClock', 'toNum', 'cpProgressHtml'],
      [],
    );
    expect(cpProgressHtml(200_000, 134_000)).toContain(
      '<span class="sys-line"><span class="cp-time"><span class="cp-verb">압축 중 · </span>3:20 / 약 2:14</span><span class="cp-over"> · 예상보다 오래 걸리는 중</span></span>',
    );
    expect(cpProgressHtml(44_000, 134_000)).toContain(
      '<span class="sys-line"><span class="cp-time"><span class="cp-verb">압축 중 · </span>0:44 / 약 2:14</span></span>',
    );
  });
});

describe('C4 — the skills an instruction invoked, as badges', () => {
  // The block skill-force-handler / autoskill-fire append (format pinned below).
  const invoked = (text: string, skills: [string, string][]) =>
    `${text}\n\n<invoked_skills>\n${skills.map(([k, c]) => `<${k}>\n${c}\n</${k}>`).join('\n')}\n</invoked_skills>`;
  const SSOT_BODY =
    'Base directory for this skill: /opt/soma-work/dev/dist/local/skills/using-ssot\n\n---\nname: using-ssot\n---\n# using-ssot — Single Source of Truth';
  const AUTOZ_BODY =
    'Base directory for this skill: /opt/soma-work/dev/dist/local/skills/autoz\n\n# autoz — 자율 파이프라인';

  it('the producers write the block this parser reads', () => {
    const force = read('src/slack/commands/skill-force-handler.ts');
    expect(force).toContain('.map(([key, content]) => `<${key}>\\n${content}\\n</${key}>`)');
    expect(force).toContain('const invokedBlock = `<invoked_skills>\\n${skillBlocks}\\n</invoked_skills>`;');
    expect(force).toContain('const finalPrompt = `${text}\\n\\n${invokedBlock}`;');
    const auto = read('src/slack/autoskill-fire.ts');
    expect(auto).toContain(
      'blocks.push(`<${resolved.key}>\\n${header}\\n\\n${resolved.content}\\n</${resolved.key}>`);',
    );
  });

  it('splits the instruction from its skills; each skill keeps its body and an estimate', () => {
    const { splitInvokedSkills } = api();
    const out = splitInvokedSkills(
      invoked('예측 시장 관련 개발 리포트 시각화', [
        ['local:using-ssot', SSOT_BODY],
        ['local:autoz', AUTOZ_BODY],
      ]),
    );
    expect(out.text).toBe('예측 시장 관련 개발 리포트 시각화');
    expect(out.skills.map((s) => s.name)).toEqual(['local:using-ssot', 'local:autoz']);
    expect(out.skills[0].body).toBe(SSOT_BODY);
    expect(out.skills[1].body).toBe(AUTOZ_BODY);
    expect(out.skills[0].tokens).toBeGreaterThan(20);
    // A body holding other tags (<speaker>) ends at its own closing tag only.
    const nested = splitInvokedSkills(invoked('x', [['user:dev', 'see <speaker>Z</speaker> and </other>']]));
    expect(nested.skills).toEqual([
      { name: 'user:dev', body: 'see <speaker>Z</speaker> and </other>', tokens: expect.any(Number) },
    ]);
    expect(splitInvokedSkills('평범한 지시')).toEqual({ text: '평범한 지시', skills: [] });
  });

  it('the first turn of a session carries two blocks (autoskill, then the deferred $skill): both read', () => {
    const { splitInvokedSkills } = api();
    // slack-handler appends `\n\n${invokedBlock}` once per fire.
    const handler = read('src/slack-handler.ts');
    expect(handler).toContain('`${dispatchText}\\n\\n${fire.invokedBlock}`');
    expect(handler).toContain('`${dispatchText}\\n\\n${deferredSkillFire.invokedBlock}`');
    const two = `${invoked('배포해줘', [['local:using-ssot', SSOT_BODY]])}\n\n${invoked('', [['user:deploy', 'deploy body']]).trimStart()}`;
    const out = splitInvokedSkills(two);
    expect(out.text).toBe('배포해줘');
    expect(out.skills.map((x) => x.name)).toEqual(['local:using-ssot', 'user:deploy']);
  });

  it('a literal <invoked_skills> in the words is the words (no closing tag, or before a real block)', () => {
    const { splitInvokedSkills } = api();
    expect(splitInvokedSkills('Explain <invoked_skills> syntax and its parser')).toEqual({
      text: 'Explain <invoked_skills> syntax and its parser',
      skills: [],
    });
    // A closed block that holds no skill is words too, even beside a real block.
    const closed = splitInvokedSkills(
      invoked('Explain <invoked_skills> syntax </invoked_skills> please', [['local:autoz', AUTOZ_BODY]]),
    );
    expect(closed.text).toBe('Explain <invoked_skills> syntax </invoked_skills> please');
    expect(closed.skills.map((x) => x.name)).toEqual(['local:autoz']);
    // A stray closing tag in the words does not hide the real block after it.
    const stray = splitInvokedSkills(invoked('close with </invoked_skills> like this', [['local:autoz', AUTOZ_BODY]]));
    expect(stray.text).toBe('close with </invoked_skills> like this');
    expect(stray.skills.map((x) => x.name)).toEqual(['local:autoz']);
    // A skill tag never closed is words, and does not swallow the skills after it.
    const unclosed = splitInvokedSkills(
      'do it\n\n<invoked_skills>\n<broken>\nno end\n<local:autoz>\nbody\n</local:autoz>\n</invoked_skills>',
    );
    expect(unclosed.skills.map((x) => x.name)).toEqual(['local:autoz']);
    const out = splitInvokedSkills(invoked('What does <invoked_skills> do?', [['local:autoz', AUTOZ_BODY]]));
    expect(out.text).toBe('What does <invoked_skills> do?');
    expect(out.skills.map((x) => x.name)).toEqual(['local:autoz']);
  });

  it('estimateTokens: ~4 ASCII characters or 1 other character per token', () => {
    const { estimateTokens } = api();
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('가나다')).toBe(3);
    expect(estimateTokens('')).toBe(0);
  });

  it('renderTurn: the words, then one badge per skill (name · ≈tokens); bodies not written yet', () => {
    const { renderTurn } = api();
    const out = renderTurn(
      user(
        invoked('예측 시장 관련 개발 리포트 시각화', [
          ['local:using-ssot', SSOT_BODY],
          ['local:autoz', AUTOZ_BODY],
        ]),
      ),
    );
    expect(out).toContain('<div class="turn user" data-turn-id="u1"');
    // Task view T1.3 (#486): the instruction is the whole text, folded to 12 lines until clicked.
    expect(out).toMatch(
      /<div class="turn-content turn-instr" role="button"[^>]*>예측 시장 관련 개발 리포트 시각화<\/div>/,
    );
    expect(out).not.toContain('invoked_skills');
    expect(out).not.toContain('Base directory');
    expect(out).toContain('<div class="skill-badges" role="group" aria-label="활성화된 스킬 2개">');
    expect(out).toMatch(
      /<button type="button" class="skill-badge" aria-expanded="false" aria-controls="skd-u1-0" data-skill="skd-u1-0" onclick="skillToggle\(this\)"[^>]*><span class="skill-name">local:using-ssot<\/span><span class="skill-tok">≈\d+ tokens<\/span><\/button>/,
    );
    expect(out).toContain('<span class="skill-name">local:autoz</span>');
    expect(out).toContain('<div class="skill-detail" id="skd-u1-0" hidden></div>');
    expect(out).toContain('<div class="skill-detail" id="skd-u1-1" hidden></div>');
  });

  it('skills only (no words): badges, no empty text block', () => {
    const out = api().renderTurn(user(invoked('', [['local:autoz', AUTOZ_BODY]])));
    expect(out).not.toContain('turn-content');
    expect(out).toContain('local:autoz');
  });

  it('skillToggle opens that skill (body written once, escaped), closes the one open, and closes again', () => {
    const panes: Record<string, { hidden: boolean; innerHTML: string; firstChild: unknown }> = {};
    const pane = (id: string) => {
      const p = { hidden: true, innerHTML: '', firstChild: null as unknown };
      Object.defineProperty(p, 'firstChild', { get: () => (p.innerHTML ? {} : null) });
      panes[id] = p;
      return p;
    };
    const document = { getElementById: (id: string) => panes[id] ?? null };
    const a = load<{
      skillBadgesHtml(key: string, skills: unknown[]): string;
      skillToggle(btn: unknown): void;
    }>(
      ['esc', 'escAttr', 'toNum', 'formatTokens', 'skillBadgesHtml', 'skillPaneHtml', 'skillToggle'],
      ['_skillBodies', '_skillSeq'],
      {
        document,
      },
    );
    a.skillBadgesHtml('u9', [
      { name: 'local:using-ssot', body: '<b>raw</b> & body', tokens: 524 },
      { name: 'local:autoz', body: 'autoz body', tokens: 1234 },
    ]);
    pane('skd-u9-0');
    pane('skd-u9-1');
    const btns: any[] = [];
    const row = { querySelectorAll: () => btns.filter((b) => b.attrs['aria-expanded'] === 'true') };
    for (const id of ['skd-u9-0', 'skd-u9-1']) {
      const attrs: Record<string, string> = { 'data-skill': id, 'aria-expanded': 'false' };
      btns.push({
        attrs,
        parentNode: row,
        getAttribute: (k: string) => attrs[k] ?? null,
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
        },
      });
    }

    a.skillToggle(btns[0]);
    expect(btns[0].attrs['aria-expanded']).toBe('true');
    expect(panes['skd-u9-0'].hidden).toBe(false);
    expect(panes['skd-u9-0'].innerHTML).toContain('<span class="skill-name">local:using-ssot</span>');
    expect(panes['skd-u9-0'].innerHTML).toContain('≈524 tokens (추정)');
    expect(panes['skd-u9-0'].innerHTML).toContain('<pre class="skill-body">&lt;b&gt;raw&lt;/b&gt; &amp; body</pre>');

    a.skillToggle(btns[1]); // one at a time
    expect(btns[0].attrs['aria-expanded']).toBe('false');
    expect(panes['skd-u9-0'].hidden).toBe(true);
    expect(panes['skd-u9-1'].hidden).toBe(false);
    expect(panes['skd-u9-1'].innerHTML).toContain('≈1.2K tokens (추정)');

    a.skillToggle(btns[1]); // and closes
    expect(btns[1].attrs['aria-expanded']).toBe('false');
    expect(panes['skd-u9-1'].hidden).toBe(true);
  });
});

describe('C5 — background-work-resume reads as its own badge', () => {
  // The real prompt builder (packages/slack/src/pipeline/background-wait.ts).
  const one = buildBackgroundWaitPrompt({ count: 1, labels: ['local_bash'] } as never, 1, 6);
  const two = buildBackgroundWaitPrompt({ count: 2, labels: ['local_bash', 'local_agent'] } as never, 3, 6);
  const bare = buildBackgroundWaitPrompt({ count: 1, labels: [] } as never, 6, 6);

  it('백그라운드 재개 #n/m — the round, how many tasks were still running and which', () => {
    const { sysTurnInfo } = api();
    for (const extra of [SYSTEM, {}]) {
      const info = sysTurnInfo(user(one, extra)) as NonNullable<Info>;
      expect(info.kind).toBe('bgwork');
      expect(info.label).toBe('백그라운드 재개 #1/6');
      expect(info.line).toBe('실행 중인 백그라운드 작업 1개 (local_bash) — 턴을 이어감');
      expect(info.facts).toEqual([
        ['회차', '1 / 6'],
        ['실행 중인 작업', '1개 (local_bash)'],
        ['이유', '턴이 끝났지만 런타임이 백그라운드 작업을 아직 실행 중으로 보고'],
      ]);
      expect(info.raw).toBe(one);
    }
    const info2 = sysTurnInfo(user(two, SYSTEM)) as NonNullable<Info>;
    expect(info2.label).toBe('백그라운드 재개 #3/6');
    expect(info2.facts[1]).toEqual(['실행 중인 작업', '2개 (local_bash, local_agent)']);
    const info3 = sysTurnInfo(user(bare, SYSTEM)) as NonNullable<Info>;
    expect(info3.line).toBe('실행 중인 백그라운드 작업 1개 — 턴을 이어감');
    expect(info3.facts[1]).toEqual(['실행 중인 작업', '1개']);
  });

  it('a person who typed the marker is a person', () => {
    expect(api().sysTurnInfo(user(one, PERSON))).toBeNull();
  });

  it('renderTurn: one line with its badge', () => {
    const out = api().renderTurn(user(one, SYSTEM));
    expect(out).toContain('data-sys="bgwork"');
    expect(out).toContain('<span class="sys-badge" data-kind="bgwork">백그라운드 재개 #1/6</span>');
  });
});

describe('C6 — the inbox card: 지시 / 응답', () => {
  const CID = 'conv-io';
  const NOW = 1_792_900_000_000;
  // A clock frozen at NOW that still builds dates (끝난 시각).
  class FrozenDate extends Date {
    static now() {
      return NOW;
    }
  }
  const invoked = (text: string, skills: [string, string][]) =>
    `${text}\n\n<invoked_skills>\n${skills.map(([k, c]) => `<${k}>\n${c}\n</${k}>`).join('\n')}\n</invoked_skills>`;
  type CardApi = {
    renderCardIo(s: unknown): string;
    ioSysToggle(el: { open: boolean }, cid: string): void;
    ioSkillToggle(cid: string, i: number): void;
    fetchCardIo(cid: string): Promise<{ instruction: { turn: Record<string, unknown> }; response: unknown }>;
  };
  const IO_FNS = [
    ...SYS_FNS,
    'skillPaneHtml',
    'ioOpenState',
    'ioSysToggle',
    'ioSkillToggle',
    'ioRefreshCards',
    'ioSkillsHtml',
    'ioInstructionHtml',
    'ioCompactOutHtml',
    'renderCardIo',
    'fetchCardIo',
  ];
  function card(
    turn: Record<string, unknown>,
    opts: { response?: unknown; working?: boolean; extra?: Record<string, unknown> } = {},
  ) {
    const setInterval = vi.fn(() => 7);
    const refreshCard = vi.fn();
    const raw = String(turn.rawContent);
    const _ioCache: Record<string, unknown> = {
      [CID]: {
        state: 'ok',
        data: {
          instruction: { text: raw.slice(0, 500) + (raw.length > 500 ? '…' : ''), who: 'Z', attachments: [], turn },
          response: opts.response ?? null,
        },
      },
    };
    const session = { key: 'k1', conversationId: CID, activityState: opts.working ? 'working' : 'idle' };
    const a = load<CardApi>(IO_FNS, [...SYS_VARS, '_ioOpen'], {
      panelConvId: 'other',
      _artCache: {},
      renderTurnArtifacts: () => '',
      umRegister: () => {},
      renderUserMedia: () => '',
      ansStateHtml: () => '',
      setInterval,
      _ioCache,
      _cardEls: { k1: {} },
      _sessionCache: { k1: session },
      refreshCard,
      Date: FrozenDate,
      ...(opts.extra || {}),
    });
    return { ...a, html: () => a.renderCardIo(session), setInterval, refreshCard, session };
  }

  it('a turn the user did not type: one line with its badge, opening to the facts and the raw prompt', () => {
    const c = card(user(goalPrompt(2, 10, 'No evidence: no files, diffs, or tests.'), SYSTEM));
    const out = c.html();
    expect(out).toContain('<div class="io-label">지시<span class="io-who">Z</span></div>');
    expect(out).toContain(`<details class="io-sys" ontoggle="ioSysToggle(this,'${CID}')">`);
    expect(out).toContain('<span class="sys-badge" data-kind="goal">Goal #2/10</span>');
    expect(out).toContain('<span class="sys-line">직전 평가: No evidence: no files, diffs, or tests.</span>');
    expect(out).toContain('<dt>회차</dt><dd>2 / 10</dd>');
    expect(out).toContain('<pre class="sys-raw">[goal-continuation] Continue working');
    // The raw prompt is no longer the 지시's visible text.
    expect(out).not.toContain('<div class="io-text">[goal-continuation]');
  });

  it('restart (recorded before origins were kept) and background-work-resume read the same way', () => {
    const r = card(user(`${RESTART_PROMPT}\n\n--- 중단 시점 컨텍스트 ---\n세션 제목: 대시보드`)).html();
    expect(r).toContain('<span class="sys-badge" data-kind="restart">시스템 재시작</span>');
    expect(r).toContain('<span class="sys-line">중단된 작업 자동 재개 · 대시보드</span>');
    const b = card(user(buildBackgroundWaitPrompt({ count: 1, labels: ['local_bash'] } as never, 2, 6), SYSTEM)).html();
    expect(b).toContain('<span class="sys-badge" data-kind="bgwork">백그라운드 재개 #2/6</span>');
  });

  it('the row stays open across the card re-render (the morph drops attributes the markup lacks)', () => {
    const c = card(user(goalPrompt(2, 10), SYSTEM));
    expect(c.html()).not.toContain('<details class="io-sys" open');
    c.ioSysToggle({ open: true }, CID);
    expect(c.html()).toContain(`<details class="io-sys" open ontoggle="ioSysToggle(this,'${CID}')">`);
    c.ioSysToggle({ open: false }, CID);
    expect(c.html()).not.toContain('<details class="io-sys" open');
  });

  it('a person typed it: the words as before', () => {
    const out = card(user('배포까지 진행', PERSON)).html();
    expect(out).toContain('<div class="io-text">배포까지 진행</div>');
    expect(out).not.toContain('io-sys');
  });

  it('skills: the user’s words, then one badge per skill — parsed from the whole turn, not the 500-character cut', () => {
    const long = 'x'.repeat(900);
    const c = card(
      user(
        invoked('예측 시장 리포트', [
          ['local:using-ssot', `Base directory for this skill: /s\n${long}`],
          ['local:autoz', 'autoz <b>body</b>'],
        ]),
        PERSON,
      ),
    );
    const out = c.html();
    expect(out).toContain('<div class="io-text">예측 시장 리포트</div>');
    expect(out).not.toContain('invoked_skills');
    expect(out).not.toContain('Base directory');
    expect(out).toContain('<div class="skill-badges" role="group" aria-label="활성화된 스킬 2개">');
    expect(out).toMatch(
      new RegExp(
        `<button type="button" class="skill-badge" aria-expanded="false" aria-controls="ios-${CID}-0" onclick="ioSkillToggle\\('${CID}',0\\)"[^>]*><span class="skill-name">local:using-ssot</span><span class="skill-tok">≈\\d+ tokens</span></button>`,
      ),
    );
    expect(out).not.toContain('skill-body');
  });

  it('a skill badge opens that skill’s body (escaped) and keeps it open across re-renders; one at a time', () => {
    const c = card(
      user(
        invoked('리포트', [
          ['local:using-ssot', 'ssot body'],
          ['local:autoz', 'autoz <b>body</b>'],
        ]),
        PERSON,
      ),
    );
    c.ioSkillToggle(CID, 1);
    expect(c.refreshCard).toHaveBeenCalledWith('k1');
    let out = c.html();
    expect(out).toContain(`aria-controls="ios-${CID}-1" onclick="ioSkillToggle('${CID}',1)"`);
    expect(out).toMatch(/aria-expanded="true" aria-controls="ios-conv-io-1"/);
    expect(out).toContain(`<div class="skill-detail" id="ios-${CID}-1">`);
    expect(out).toContain('<pre class="skill-body">autoz &lt;b&gt;body&lt;/b&gt;</pre>');
    expect(out).not.toContain('ssot body');
    c.ioSkillToggle(CID, 0); // the other one: one at a time
    out = c.html();
    expect(out).toContain('<pre class="skill-body">ssot body</pre>');
    expect(out).not.toContain('autoz &lt;b&gt;');
    c.ioSkillToggle(CID, 0); // and closed
    expect(c.html()).not.toContain('skill-body');
  });

  it('/compact running: the 지시 is one line, the 응답 its progress (elapsed / estimate, %) — and the ticker starts', () => {
    const c = card(user('/compact', { ...SYSTEM, timestamp: NOW - 30_000, compact: { estimateMs: 120_000 } }), {
      working: true,
    });
    const out = c.html();
    expect(out).toContain('<span class="sys-badge" data-kind="compact">자동 압축</span>');
    expect(out).toContain('<span class="sys-line">컨텍스트 압축 (/compact)</span>');
    expect(out).toContain(
      `<div class="io-cp" data-cp-live="1" data-cp-start="${NOW - 30_000}" data-cp-est="120000" data-cp-label="자동 압축">`,
    );
    expect(out).toContain('<span class="cp-verb">압축 중 · </span>0:30 / 약 2:00');
    expect(out).toContain('<span class="cp-pct">25%</span>');
    expect(out).not.toContain('응답 작성 중');
    expect(c.setInterval).toHaveBeenCalledTimes(1);
  });

  it('/compact done: the 응답 is its result; the facts in the 지시 row', () => {
    const c = card(
      user('/compact', {
        ...SYSTEM,
        timestamp: NOW - 200_000,
        compact: {
          estimateMs: 140_000,
          endedAt: NOW - 66_000,
          durationMs: 134_000,
          preTokens: 182_340,
          postTokens: 31_020,
          trigger: 'auto',
        },
      }),
    );
    const out = c.html();
    expect(out).toContain(
      '<div class="io-cp"><span class="cp-slot"><span class="sys-line">자동 압축 처리 · 182.3K → 31.0K 토큰 · 2m 14s</span></span></div>',
    );
    expect(out).not.toContain('data-cp-live');
    expect(out).toContain('<dt>압축 전 → 후</dt><dd>182,340 → 31,020 토큰 (−83%)</dd>');
    expect(out).not.toContain('응답 없음');
  });

  it('/compact with no result and the session not working: no live progress, 결과 기록 없음', () => {
    const out = card(user('/compact', { ...SYSTEM, timestamp: NOW - 30_000, compact: {} })).html();
    expect(out).not.toContain('data-cp-live');
    expect(out).toContain('<span class="sys-line">자동 압축 처리</span>');
    expect(out).toContain('<dd class="cp-state">결과 기록 없음</dd>');
  });

  it('/compact with a reply after it: the result line, then the reply', () => {
    const out = card(user('/compact', { ...SYSTEM, timestamp: NOW - 30_000, compact: {} }), {
      working: true,
      response: { title: '압축 뒤 요약', body: '본문' },
    }).html();
    expect(out).not.toContain('data-cp-live');
    expect(out).toContain('<span class="io-title">압축 뒤 요약</span>');
  });

  it('fetchCardIo keeps the whole latest user turn (raw, origin, compact) for the card to read', async () => {
    const long = invoked('지시', [['local:autoz', 'y'.repeat(2000)]]);
    const turns = [
      { id: 'u1', role: 'user', timestamp: 1, userName: 'Z', rawContent: long, origin: { by: 'user' } },
      { id: 'a1', role: 'assistant', timestamp: 2, summaryTitle: 'T', summaryBody: 'B' },
    ];
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ turns }) }));
    const c = card(user('x'), { extra: { fetch } });
    const res = await c.fetchCardIo(CID);
    expect(res.instruction.turn.rawContent).toBe(long);
    expect(res.instruction.turn.origin).toEqual({ by: 'user' });
    expect(res.instruction.turn.role).toBe('user');
    expect(res.response).toEqual({ title: 'T', body: 'B' });
  });

  it('cpTick keeps an open card’s compaction live while its session works, and ends it when it stops', () => {
    const NOWT = 1_792_900_000_000;
    function node(start: number, key: string) {
      const attrs: Record<string, string> = {
        'data-cp-live': '1',
        'data-cp-start': String(start),
        'data-cp-est': '120000',
        'data-cp-label': '자동 압축',
      };
      const slot = { innerHTML: '' };
      return {
        slot,
        attrs,
        getAttribute: (k: string) => attrs[k] ?? null,
        removeAttribute: (k: string) => {
          delete attrs[k];
        },
        querySelector: (sel: string) => (sel === '.cp-slot' ? slot : null),
        closest: (sel: string) =>
          sel === '.card' ? { getAttribute: (k: string) => (k === 'data-session-key' ? key : null) } : null,
      };
    }
    const working = node(NOWT - 45_000, 'w');
    const idle = node(NOWT - 45_000, 'i');
    const document = {
      querySelectorAll: (sel: string) => (sel === '.card-io [data-cp-live]' ? [working, idle] : []),
    };
    const { cpTick } = load<{ cpTick(): void }>(
      ['esc', 'toNum', 'cpClock', 'cpProgressHtml', 'cpTick'],
      ['CP_DEFAULT_EST_MS', 'CP_MAX_MS', '_cpTimer'],
      {
        document,
        clearInterval: vi.fn(),
        Date: { now: () => NOWT },
        panelSessionKey: null,
        _sessionCache: { w: { activityState: 'working' }, i: { activityState: 'idle' } },
      },
    );
    cpTick();
    expect(working.attrs['data-cp-live']).toBe('1');
    expect(working.slot.innerHTML).toContain('</span>0:45 / 약 2:00');
    expect(idle.attrs['data-cp-live']).toBeUndefined();
    expect(idle.slot.innerHTML).toBe('<span class="sys-line">자동 압축 처리</span>');
  });
});

describe('C7 — the work log (작업 로그): an instruction entry reads like the conversation', () => {
  const invoked = (text: string, skills: [string, string][]) =>
    `${text}\n\n<invoked_skills>\n${skills.map(([k, c]) => `<${k}>\n${c}\n</${k}>`).join('\n')}\n</invoked_skills>`;
  type WlApi = {
    renderWorkLogEntry(e: Record<string, unknown>): string;
    wlEntryFactsHtml(e: Record<string, unknown>): string;
  };
  function wl() {
    return load<WlApi>(
      [...SYS_FNS, 'wlInstructionTurn', 'wlEntryFactsHtml', 'wlCutSkills', 'wlCutSkillsHtml', 'renderWorkLogEntry'],
      [...SYS_VARS, 'WL_LABELS'],
      { setInterval: vi.fn(() => 7) },
    );
  }
  const entry = (text: string, extra: Record<string, unknown> = {}) => ({
    seq: 5,
    ts: 1_792_900_000_000,
    kind: 'instruction',
    text,
    ...extra,
  });

  it('a turn soma-work sent: one line — badge, what it did, time — on the row that opens the raw', () => {
    const out = wl().renderWorkLogEntry(
      entry(goalPrompt(2, 10, 'No evidence: no files, diffs, or tests.'), { by: 'system' }),
    );
    expect(out).toContain('<div class="wl-entry wl-instruction is-sys" data-seq="5">');
    expect(out).toContain(
      '<div class="wl-row" role="button" tabindex="-1" aria-expanded="false" aria-controls="wl-detail-5">',
    );
    expect(out).toMatch(
      /<div class="wl-head"><span class="sys-badge" data-kind="goal">Goal #2\/10<\/span><span class="wl-sys-line">직전 평가: No evidence: no files, diffs, or tests\.<\/span><span class="wl-time">/,
    );
    expect(out).not.toContain('[goal-continuation]');
    expect(out).not.toContain('<span class="wl-label">지시</span>');
  });

  it('entries written before origins were kept are read from their text (goal, background resume, restart)', () => {
    const a = wl();
    expect(a.renderWorkLogEntry(entry(goalPrompt(3, 10)))).toContain('data-kind="goal">Goal #3/10</span>');
    expect(
      a.renderWorkLogEntry(entry(buildBackgroundWaitPrompt({ count: 1, labels: ['local_bash'] } as never, 1, 6))),
    ).toContain('data-kind="bgwork">백그라운드 재개 #1/6</span>');
    expect(
      a.renderWorkLogEntry(entry(`${RESTART_PROMPT}\n\n--- 중단 시점 컨텍스트 ---\n세션 제목: 대시보드`)),
    ).toContain(
      'data-kind="restart">시스템 재시작</span><span class="wl-sys-line">중단된 작업 자동 재개 · 대시보드</span>',
    );
  });

  it('/compact: 자동 압축 when soma-work ran it, 압축 when a person did; a goal objective starting with /compact is words', () => {
    const a = wl();
    expect(a.renderWorkLogEntry(entry('/compact', { by: 'system', compactTurn: true }))).toContain(
      'data-kind="compact">자동 압축</span><span class="wl-sys-line">컨텍스트 압축 (/compact)</span>',
    );
    expect(a.renderWorkLogEntry(entry('/compact', { by: 'user', compactTurn: true }))).toContain(
      'data-kind="compact">압축</span>',
    );
    const literal = a.renderWorkLogEntry(entry('/compact 명령의 버그를 고쳐라', { by: 'user' }));
    expect(literal).not.toContain('sys-badge');
    expect(literal).toContain('<div class="wl-text">/compact 명령의 버그를 고쳐라</div>');
  });

  it('a person’s instruction: the words on the row, skill badges beside it (never inside the row button)', () => {
    const out = wl().renderWorkLogEntry(
      entry(
        invoked('예측 시장 리포트', [
          ['local:using-ssot', 'ssot body'],
          ['local:autoz', 'autoz body'],
        ]),
        { by: 'user' },
      ),
    );
    expect(out).toContain('<span class="wl-label">지시</span>');
    expect(out).toContain(
      '<div class="wl-text">예측 시장 리포트</div></div><div class="skill-badges" role="group" aria-label="활성화된 스킬 2개">',
    );
    expect(out).toContain('aria-controls="skd-wl5-0" data-skill="skd-wl5-0" onclick="skillToggle(this)"');
    expect(out).not.toContain('invoked_skills');
    expect(out).not.toContain('ssot body');
    expect(out.indexOf('skill-badges')).toBeLessThan(out.indexOf('wl-detail-5" aria-live'));
  });

  it('a stored text cut inside the skill block (4,000 characters): the words, and a badge per readable skill name — no skill text', () => {
    const cut = `예측 시장 리포트\n\n<invoked_skills>\n<local:using-ssot>\nssot body\n</local:using-ssot>\n<local:autoz>\n${'x'.repeat(3000)}`;
    const out = wl().renderWorkLogEntry(entry(cut, { by: 'user', rawBytes: 51_998 }));
    expect(out).toContain(
      '<div class="wl-text">예측 시장 리포트</div></div><div class="skill-badges" role="group" aria-label="활성화된 스킬">',
    );
    expect(out).toContain(
      '<button type="button" class="skill-badge" aria-expanded="false" data-wl-seq="5" data-wl-skill="local:using-ssot" onclick="wlSkillOpen(this)"',
    );
    expect(out).toContain('data-wl-skill="local:autoz" onclick="wlSkillOpen(this)"');
    // Past the cut more may follow: one badge says so.
    expect(out).toContain('data-wl-skill="" onclick="wlSkillOpen(this)"');
    expect(out).not.toContain('xxxxxxxxxx');
    expect(out).not.toContain('ssot body');
    expect(out).not.toContain('invoked_skills');
  });

  it('wlSkillOpen: loads the stored original, redraws the badges with every skill and its tokens, opens the one clicked', async () => {
    const full = invoked('예측 시장 리포트', [
      ['local:using-ssot', 'ssot body'],
      ['local:autoz', 'autoz body'],
    ]);
    const skillToggle = vi.fn();
    const named = (name: string) => ({ querySelector: () => ({ textContent: name }) });
    const fresh = [named('local:using-ssot'), named('local:autoz')];
    const document = { querySelectorAll: vi.fn((sel: string) => (sel === '[data-skill^="skd-wl5-"]' ? fresh : [])) };
    const state = { convId: 'c1', closed: false };
    const a = load<{ wlSkillOpen(btn: unknown): Promise<void> }>(
      [
        'esc',
        'escAttr',
        'toNum',
        'formatTokens',
        'decodeSlackEntities',
        'estimateTokens',
        'splitInvokedSkills',
        'skillBadgesHtml',
        'wlSkillOpen',
      ],
      ['_skillBodies', '_skillSeq'],
      {
        _wl: state,
        document,
        skillToggle,
        wlFetchJson: vi.fn(),
        wlRawLoad: vi.fn(async () => ({ status: 'ok', raw: full })),
      },
    );
    const group: { outerHTML: string } = { outerHTML: '' };
    const attrs: Record<string, string> = { 'data-wl-seq': '5', 'data-wl-skill': 'local:autoz' };
    const btn = {
      parentNode: group,
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      removeAttribute: (k: string) => {
        delete attrs[k];
      },
    };
    await a.wlSkillOpen(btn);
    expect(group.outerHTML).toContain('<div class="skill-badges" role="group" aria-label="활성화된 스킬 2개">');
    expect(group.outerHTML).toMatch(
      /aria-controls="skd-wl5-1" data-skill="skd-wl5-1" onclick="skillToggle\(this\)"[^>]*><span class="skill-name">local:autoz<\/span><span class="skill-tok">≈\d+ tokens<\/span>/,
    );
    expect(skillToggle).toHaveBeenCalledWith(fresh[1]);
  });

  it('a plain instruction is unchanged', () => {
    const out = wl().renderWorkLogEntry(entry('대시보드 고쳐줘', { by: 'user' }));
    expect(out).toContain('<div class="wl-head"><span class="wl-label">지시</span>');
    expect(out).toContain('<div class="wl-text">대시보드 고쳐줘</div>');
    expect(out).not.toContain('sys-badge');
  });

  it('the opened row shows the facts above the raw prompt; a person’s row has none', () => {
    const a = wl();
    expect(a.wlEntryFactsHtml(entry(goalPrompt(2, 10, 'gap'), { by: 'system' }))).toBe(
      '<dl class="sys-facts"><dt>회차</dt><dd>2 / 10</dd><dt>직전 평가에서 남은 일</dt><dd>gap</dd></dl>',
    );
    expect(a.wlEntryFactsHtml(entry('대시보드 고쳐줘', { by: 'user' }))).toBe('');
    expect(a.wlEntryFactsHtml({ seq: 6, kind: 'narration', text: goalPrompt(2, 10) })).toBe('');
  });
});
