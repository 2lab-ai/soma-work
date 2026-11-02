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
 *   C2  the one-line row: <ui-conversation>'s system turn — who · when · badge ·
 *       what it did, opening to its facts and the raw prompt (convTurnsOf)
 *   C3  /compact: the element's progress while it runs (it ticks in place),
 *       its numbers once done; live only while it is the latest turn of a
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
/** A client var's value as the browser has it (its declaration cut out and run alone). */
function clientVarValue(name: string): unknown {
  return new Function(`${clientVar(name)}\nreturn ${name};`)();
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
  'cpDoneText',
  'cpEnsureTicker',
  'cpTick',
  'estimateTokens',
  'splitInvokedSkills',
  'skillBadgesHtml',
  // D3: 지시와 답변's turns are <ui-conversation>'s — the page hands it data.
  'ansCacheKey',
  'artInTurn',
  'convSummaryOf',
  'convSysTurn',
  'convTurnsOf',
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
type Turn = Record<string, unknown> & { id: string; role: string };
type Built = { turns: Turn[]; slots: { name: string; kind: string; list: unknown[] }[] };
type Api = {
  sysTurnInfo(t: unknown): Info;
  convTurnsOf(list: unknown[], c: Record<string, unknown>): Built;
  splitInvokedSkills(raw: string): { text: string; skills: { name: string; body: string; tokens: number }[] };
  estimateTokens(s: string): number;
};

function api(extra: Record<string, unknown> = {}) {
  const setInterval = vi.fn(() => 7);
  const a = load<Api>(SYS_FNS, SYS_VARS, {
    STRINGS: { summaryFailed: '요약 실패', summaryPending: '요약 만드는 중…' },
    setInterval,
    ...extra,
  });
  // The element's turns for a list (convPaint's context: a working session unless said otherwise).
  const conv = (list: unknown[], c: Record<string, unknown> = {}) =>
    a.convTurnsOf(list, {
      cid: 'conv-sys',
      bot: 'Soma',
      now: Date.now(),
      working: true,
      answers: {},
      failed: {},
      arts: [],
      ...c,
    });
  const one = (t: unknown, c: Record<string, unknown> = {}) => conv([t], c).turns[0];
  return { ...a, setInterval, conv, one };
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
    expect(plain).toMatchObject({ kind: 'goal', label: '목표 #2/10', line: '목표 자동 계속' });
    const gap = 'The work summary contains no evidence at all: <files> missing';
    const withGap = sysTurnInfo(user(goalPrompt(3, 10, gap)));
    expect(withGap).toMatchObject({ kind: 'goal', label: '목표 #3/10' });
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

describe('C2 — the one-line row (<ui-conversation> system turn)', () => {
  it('who · when · badge · line, opening to the facts and the raw prompt (data the element escapes)', () => {
    const raw = `${goalPrompt(2, 10, 'needs <evidence> & tests')}`;
    const t = api().one(user(raw, SYSTEM));
    // SSOT 2026-10-29 T7: the harness sent it — System (the element draws its gear avatar).
    expect(t).toMatchObject({ id: 'u1', role: 'system', kind: 'goal', label: '목표 #2/10' });
    expect(t.text).toBe('직전 평가: needs <evidence> & tests');
    expect(t.facts).toContainEqual(['회차', '2 / 10']);
    expect(String(t.raw)).toMatch(/^\[goal-continuation\] Continue working/);
    expect(String(t.raw)).toContain('<previous-eval-reason>');
    expect(t.at).toEqual(expect.any(Number));
    expect(t).not.toHaveProperty('media');
  });

  it('SSOT 2026-10-29 T7 — a harness turn is System (never the user’s name); a person’s turn keeps theirs', () => {
    const { one } = api();
    for (const t of [
      user(RESTART_PROMPT, SYSTEM),
      user('/compact', { ...SYSTEM, compact: {} }),
      user(goalPrompt(1, 3), SYSTEM),
    ]) {
      const x = one(t);
      expect(x.role).toBe('system');
      expect(x.name).toBeUndefined();
      expect(JSON.stringify(x)).not.toContain('"name":"Z"');
    }
    expect(one(user(RESTART_PROMPT, { ...SYSTEM, userName: undefined })).name).toBeUndefined();
    const mine = one(user('배포까지 진행', PERSON));
    expect(mine).toEqual({ id: 'u1', role: 'user', name: 'Z', at: expect.any(Number), text: '배포까지 진행' });
    expect(one(user('익명', { ...PERSON, userName: undefined })).name).toBe('사용자');
  });

  it('files on a one-line turn (the message the auto-compact intercepted): the media slot of its open detail (G1-2, 0.12.0)', () => {
    const sys = user('/compact', {
      ...SYSTEM,
      compact: {},
      timestamp: Date.now() - 3_600_000,
      attachments: [{ id: 'F1', name: 'a.png', kind: 'image' }, { id: 'F2', name: 'b.pdf' }, { name: 'no-id.txt' }],
    });
    const built = api().conv([sys]);
    const x = built.turns[0];
    expect(x.role).toBe('system');
    expect(x.media).toBe(true);
    expect(JSON.stringify(x.facts ?? [])).not.toContain('첨부 파일');
    expect(built.slots).toEqual([
      expect.objectContaining({
        name: 'media-u1',
        kind: 'media',
        list: [
          { id: 'F1', name: 'a.png', kind: 'image' },
          { id: 'F2', name: 'b.pdf' },
        ],
      }),
    ]);
    // Without files: no slot, no media flag.
    const bare = api().conv([user('/compact', { ...SYSTEM, compact: {}, timestamp: Date.now() - 3_600_000 })]);
    expect(bare.turns[0]).not.toHaveProperty('media');
    expect(bare.slots).toEqual([]);
    // A person's files go in the same slot, above their words.
    const person = api().conv([user('보세요', { ...PERSON, attachments: [{ id: 'F1', name: 'a.png' }] })]);
    expect(person.turns[0].media).toBe(true);
    expect(person.slots).toEqual([expect.objectContaining({ name: 'media-u1', kind: 'media' })]);
  });

  it('a restart row says so in one line', () => {
    const x = api().one(user(RESTART_PROMPT, SYSTEM));
    expect(x).toMatchObject({ kind: 'restart', label: '시스템 재시작', text: '중단된 작업 자동 재개' });
    expect(String(x.raw)).toMatch(/^The service was restarted and the previous task was interrupted\./);
  });

  it('a turn sent from the composer is the server turn once echoed (a later /compact result finds it)', () => {
    const ws = TEMPLATE.slice(
      TEMPLATE.indexOf("msg.type === 'conversation_update'"),
      TEMPLATE.indexOf("msg.type === 'session_action'"),
    );
    // The optimistic turn is found in 지시와 답변's data and replaced there by the server's — matched by its words
    // or by being the viewer's own, never by a time window (SSOT 2026-11-02 T1, dashboard-optimistic-echo-client).
    expect(ws).toContain('onConversationTurn(msg.conversationId, msg.turn)');
    expect(clientFn('onConversationTurn')).toContain(
      'appendTurnToPanel(turn, false, ptOptimisticFor(_panelTurnsList, turn, _viewerUserId) || undefined)',
    );
    // affectUI batch 2b: the composer (<ui-agent-steering>) draws the optimistic turn only when no turn is running;
    // a note sent mid-turn is a queued note in the steering list instead (dashboard-steering-client).
    const from = TEMPLATE.indexOf("optimisticId = 'optimistic-' + Date.now();");
    expect(from).toBeGreaterThan(-1);
    const send = TEMPLATE.slice(from, TEMPLATE.indexOf('_optimistic: true', from));
    expect(send).toContain('appendTurnToPanel({');
    expect(send).toContain("origin: { by: 'user' }");
  });

  it('an open row stays open when its turn changes (a /compact result landing): the element keys turns by id', () => {
    // appendTurnToPanel updates the turn in place in the data (ptUpsert); <ui-conversation> rebuilds that turn's
    // node only and keeps what the reader opened on it (its per-id state).
    const src = clientFn('appendTurnToPanel');
    expect(src).toContain('ptUpsert(_panelTurnsList, turn, replaceId)');
    expect(src).toContain('convPaint()');
  });
});

describe('C3 — /compact: progress while it runs, its numbers once done', () => {
  it('running: the element’s progress (elapsed / default estimate ticks in place); the facts say 진행 중', () => {
    const start = Date.now() - 42_000;
    const x = api().one(user('/compact', { ...SYSTEM, compact: {}, timestamp: start }));
    expect(x).toMatchObject({ role: 'system', kind: 'compact', label: '자동 압축' });
    expect(x.progress).toEqual({ startedAt: start, estimateMs: 150_000, verb: '압축 중…' });
    expect(x.facts).toContainEqual(['상태', '진행 중']);
    expect(x.facts).toContainEqual(['예상 시간', '2분 30초 (기본값)']);
  });

  it('the estimate is the conversation’s previous compaction when the turn carries one', () => {
    const x = api().one(
      user('/compact', { ...SYSTEM, timestamp: Date.now() - 45_000, compact: { estimateMs: 90_000 } }),
    );
    expect(x.progress).toMatchObject({ estimateMs: 90_000 });
    expect(x.facts).toContainEqual(['예상 시간', '1분 30초 (직전 압축 기준)']);
  });

  it('past the estimate it is still running (the element draws the over-run sweep, no false percentage)', () => {
    const x = api().one(user('/compact', { ...SYSTEM, compact: {}, timestamp: Date.now() - 200_000 }));
    expect(x.progress).toMatchObject({ estimateMs: 150_000 });
  });

  it('done: the badge, "자동 압축 처리" with before → after and the time; the facts in full', () => {
    const t0 = Date.now() - 3_600_000;
    const x = api().one(
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
    expect(x).not.toHaveProperty('progress');
    expect(x).toMatchObject({
      kind: 'compact',
      label: '자동 압축',
      text: '자동 압축 처리 · 182.3K → 31.0K 토큰 · 2분 14초',
    });
    expect(x.facts).toEqual(
      expect.arrayContaining([
        ['상태', '완료'],
        ['압축 전 → 후', '182,340 → 31,020 토큰 (−83%)'],
        ['걸린 시간', '2분 14초'],
        ['예상 시간', '2분 00초 (직전 압축 기준)'],
        ['SDK 트리거', 'manual'],
        ['실행', 'soma-work — 컨텍스트가 자동 압축 지점을 넘어 /compact 실행'],
      ]),
    );
    expect(x.raw).toBe('/compact');
  });

  it('a /compact with a later turn after it is not running (no first-frame flash)', () => {
    const t = user('/compact', { ...SYSTEM, compact: {}, timestamp: Date.now() - 30_000 });
    const next = user('다음 지시', { id: 'u2' });
    const x = api().conv([t, next]).turns[0];
    expect(x).not.toHaveProperty('progress');
    expect(x.text).toBe('자동 압축 처리');
    expect(x.facts).toContainEqual(['상태', '결과 기록 없음']);
    // The last of the list is still live.
    expect(api().conv([next, t]).turns[1].progress).toBeTruthy();
  });

  it('no result and older than a compaction can run: "압축 처리", 결과 기록 없음', () => {
    const x = api().one(user('/compact', { timestamp: Date.now() - 3_600_000 }));
    expect(x.text).toBe('압축 처리');
    expect(x.facts).toContainEqual(['상태', '결과 기록 없음']);
    expect(x).not.toHaveProperty('progress');
  });

  it('the session stopped working → no longer running, no result kept (convPaint’s working rule)', () => {
    const t = user('/compact', { ...SYSTEM, compact: {}, timestamp: Date.now() - 30_000 });
    const idle = api().one(t, { working: false });
    expect(idle).not.toHaveProperty('progress');
    expect(idle.facts).toContainEqual(['상태', '결과 기록 없음']);
    expect(api().one(t, { working: true }).progress).toBeTruthy();
    // A session missing from a loaded board is not running; before the board loads it is undecided.
    expect(clientFn('convPaint')).toContain(
      "var working = s ? s.activityState === 'working' : Object.keys(_sessionCache).length === 0;",
    );
  });
});

describe('C3b — the card’s /compact line on a narrow card never overflows; the bar gives way first', () => {
  // (지시와 답변's system row is <ui-conversation>'s own layout now; the open card's 응답 keeps this line.)
  it('the bar shrinks first (high shrink weight), then the line truncates from its end', () => {
    expect(TEMPLATE).toMatch(/\.cp-bar \{ flex: 0 1000 120px; min-width: 0; max-width: 120px;/);
    expect(TEMPLATE).not.toContain('.cp-slot > .sys-line { flex-shrink: 0; }');
    expect(TEMPLATE).not.toMatch(/flex-shrink: 0\.\d/);
  });

  it('a running line never cuts its times: only the overdue words take the ellipsis', () => {
    expect(TEMPLATE).toContain('.cp-time { flex: none; white-space: nowrap; }');
    expect(TEMPLATE).toContain(
      '.cp-over { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    );
  });

  it('the old inline system row is gone (no renderer, no rules)', () => {
    expect(TEMPLATE).not.toMatch(/\nfunction renderSysTurn\(/);
    expect(TEMPLATE).not.toContain('.sys-row-in');
    expect(TEMPLATE).not.toContain('container: sysrow');
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

  it('convTurnsOf: the words, then one chip per skill (name · ≈tokens · its text for the pane)', () => {
    const x = api().one(
      user(
        invoked('예측 시장 관련 개발 리포트 시각화', [
          ['local:using-ssot', SSOT_BODY],
          ['local:autoz', AUTOZ_BODY],
        ]),
      ),
    );
    expect(x.role).toBe('user');
    // Task view T1.3 (#486): the whole instruction — the element folds it to 12 lines (clampLines).
    expect(x.text).toBe('예측 시장 관련 개발 리포트 시각화');
    expect(JSON.stringify(x.text)).not.toContain('invoked_skills');
    expect(x.skills).toEqual([
      { name: 'local:using-ssot', tokens: expect.any(Number), text: expect.stringContaining('') },
      { name: 'local:autoz', tokens: expect.any(Number), text: expect.any(String) },
    ]);
    expect((x.skills as { tokens: number }[])[0].tokens).toBeGreaterThan(0);
  });

  it('skills only (no words): chips, no text', () => {
    const x = api().one(user(invoked('', [['local:autoz', AUTOZ_BODY]])));
    expect(x.text).toBe('');
    expect(x.skills).toEqual([expect.objectContaining({ name: 'local:autoz' })]);
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
    expect(panes['skd-u9-0'].innerHTML).toContain('≈524 토큰 (추정)');
    expect(panes['skd-u9-0'].innerHTML).toContain('<pre class="skill-body">&lt;b&gt;raw&lt;/b&gt; &amp; body</pre>');

    a.skillToggle(btns[1]); // one at a time
    expect(btns[0].attrs['aria-expanded']).toBe('false');
    expect(panes['skd-u9-0'].hidden).toBe(true);
    expect(panes['skd-u9-1'].hidden).toBe(false);
    expect(panes['skd-u9-1'].innerHTML).toContain('≈1.2K 토큰 (추정)');

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

  it('convTurnsOf: one line with its badge (the element’s background kind)', () => {
    const x = api().one(user(one, SYSTEM));
    expect(x).toMatchObject({ role: 'system', kind: 'background', label: '백그라운드 재개 #1/6' });
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
    ioSysToggle(cid: string, open: boolean): void;
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
      ansSlotHtml: () => '',
      setInterval,
      _ioCache,
      // The element that draws card k1 (ioRefreshCards repaints the cards on it).
      _cardHost: { k1: {} },
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
    // SSOT 2026-10-29 T7: the harness sent it — the 지시 is System's, not the user's name.
    expect(out).toContain('<div class="io-label">지시<span class="io-who is-sys">시스템</span></div>');
    expect(out).not.toContain('<span class="io-who">Z</span>');
    expect(out).toContain(
      `<ui-disclosure class="io-sys" data-cid="${CID}" flush><span slot="summary" class="io-sys-row">`,
    );
    expect(out).toContain('<span class="ui-chip sys-badge" data-kind="goal">목표 #2/10</span>');
    expect(out).toContain('<span class="sys-line">직전 평가: No evidence: no files, diffs, or tests.</span>');
    expect(out).toContain('<dt>회차</dt><dd>2 / 10</dd>');
    expect(out).toContain('<pre class="sys-raw">[goal-continuation] Continue working');
    // The raw prompt is no longer the 지시's visible text.
    expect(out).not.toContain('<div class="io-text">[goal-continuation]');
  });

  it('restart (recorded before origins were kept) and background-work-resume read the same way', () => {
    const r = card(user(`${RESTART_PROMPT}\n\n--- 중단 시점 컨텍스트 ---\n세션 제목: 대시보드`)).html();
    expect(r).toContain('<span class="ui-chip sys-badge" data-kind="restart">시스템 재시작</span>');
    expect(r).toContain('<span class="sys-line">중단된 작업 자동 재개 · 대시보드</span>');
    const b = card(user(buildBackgroundWaitPrompt({ count: 1, labels: ['local_bash'] } as never, 2, 6), SYSTEM)).html();
    expect(b).toContain('<span class="ui-chip sys-badge" data-kind="bgwork">백그라운드 재개 #2/6</span>');
  });

  it('the row stays open across the card re-render (the morph drops attributes the markup lacks)', () => {
    const c = card(user(goalPrompt(2, 10), SYSTEM));
    expect(c.html()).not.toContain('<ui-disclosure class="io-sys" data-cid="' + CID + '" open');
    c.ioSysToggle(CID, true);
    expect(c.html()).toContain(`<ui-disclosure class="io-sys" data-cid="${CID}" open flush>`);
    c.ioSysToggle(CID, false);
    expect(c.html()).not.toContain('<ui-disclosure class="io-sys" data-cid="' + CID + '" open');
    // The element's ui-toggle is answered once, on the document: the reader's choice by its card's conversation.
    expect(TEMPLATE).toContain(
      "if (t.classList.contains('io-sys')) ioSysToggle(t.getAttribute('data-cid') || '', open);",
    );
  });

  it('a person typed it: the words as before', () => {
    const out = card(user('배포까지 진행', PERSON)).html();
    expect(out).toContain('<div class="io-text">배포까지 진행</div>');
    expect(out).not.toContain('io-sys');
    // SSOT 2026-10-29 T7: a person's 지시 keeps their name (System is only the harness's).
    expect(out).toContain('<div class="io-label">지시<span class="io-who">Z</span></div>');
    expect(out).not.toContain('is-sys');
    expect(out).not.toContain('시스템');
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
        `<button type="button" class="skill-badge" aria-expanded="false" aria-controls="ios-${CID}-0" onclick="ioSkillToggle\\('${CID}',0\\)"[^>]*><span class="skill-name">local:using-ssot</span><span class="skill-tok">≈\\d+ 토큰</span></button>`,
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
    expect(out).toContain('<span class="ui-chip sys-badge" data-kind="compact">자동 압축</span>');
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
      '<div class="io-cp"><span class="cp-slot"><span class="sys-line">자동 압축 처리 · 182.3K → 31.0K 토큰 · 2분 14초</span></span></div>',
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
        // The open card's body: its slot on the board element names the session.
        closest: (sel: string) =>
          sel === '.card-slot[data-session-key]'
            ? { getAttribute: (k: string) => (k === 'data-session-key' ? key : null) }
            : null,
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

describe('C7 — the work log (작업 로그, <ui-work-log>): an instruction entry reads like the conversation', () => {
  const invoked = (text: string, skills: [string, string][]) =>
    `${text}\n\n<invoked_skills>\n${skills.map(([k, c]) => `<${k}>\n${c}\n</${k}>`).join('\n')}\n</invoked_skills>`;
  type Entry = Record<string, unknown> & { kind: string; text?: string; skills?: Record<string, unknown>[] };
  type WlApi = {
    wlEntryOf(st: unknown, e: Record<string, unknown>): Entry;
    wlEntryFactsText(e: Record<string, unknown>): string;
  };
  function wl() {
    return load<WlApi>(
      [...SYS_FNS, 'wlInstructionTurn', 'wlEntryFactsText', 'wlCutSkills', 'wlFullText', 'wlRawView', 'wlEntryOf'],
      [...SYS_VARS, 'WL_LABELS', 'WL_RAW_MISSING_MSG', 'WL_RAW_ERROR_MSG', 'WL_RAW_DAMAGED_MSG', 'WL_FORBIDDEN_MSG'],
      { setInterval: vi.fn(() => 7) },
    );
  }
  const ST = { entries: [] };
  const entry = (text: string, extra: Record<string, unknown> = {}) => ({
    seq: 5,
    ts: 1_792_900_000_000,
    kind: 'instruction',
    text,
    ...extra,
  });

  it('a turn soma-work sent: one line — badge, what it did, time — on a row that opens the raw', () => {
    const x = wl().wlEntryOf(ST, entry(goalPrompt(2, 10, 'No evidence: no files, diffs, or tests.'), { by: 'system' }));
    expect(x).toEqual({
      id: '5',
      at: 1_792_900_000_000,
      kind: 'system',
      system: { kind: 'goal', label: '목표 #2/10' },
      text: '직전 평가: No evidence: no files, diffs, or tests.',
      hasRaw: true,
    });
  });

  it('entries written before origins were kept are read from their text (goal, background resume, restart)', () => {
    const a = wl();
    expect(a.wlEntryOf(ST, entry(goalPrompt(3, 10))).system).toEqual({ kind: 'goal', label: '목표 #3/10' });
    expect(
      a.wlEntryOf(ST, entry(buildBackgroundWaitPrompt({ count: 1, labels: ['local_bash'] } as never, 1, 6))).system,
    ).toEqual({ kind: 'background', label: '백그라운드 재개 #1/6' });
    const restart = a.wlEntryOf(ST, entry(`${RESTART_PROMPT}\n\n--- 중단 시점 컨텍스트 ---\n세션 제목: 대시보드`));
    expect(restart.system).toEqual({ kind: 'restart', label: '시스템 재시작' });
    expect(restart.text).toBe('중단된 작업 자동 재개 · 대시보드');
  });

  it('/compact: 자동 압축 when soma-work ran it, 압축 when a person did; a goal objective starting with /compact is words', () => {
    const a = wl();
    const auto = a.wlEntryOf(ST, entry('/compact', { by: 'system', compactTurn: true }));
    expect(auto).toMatchObject({
      kind: 'system',
      system: { kind: 'compact', label: '자동 압축' },
      text: '컨텍스트 압축 (/compact)',
    });
    expect(a.wlEntryOf(ST, entry('/compact', { by: 'user', compactTurn: true })).system).toEqual({
      kind: 'compact',
      label: '압축',
    });
    const literal = a.wlEntryOf(ST, entry('/compact 명령의 버그를 고쳐라', { by: 'user' }));
    expect(literal).toMatchObject({ kind: 'instruction', text: '/compact 명령의 버그를 고쳐라' });
    expect(literal).not.toHaveProperty('system');
  });

  it('a person’s instruction: the words, and a chip per skill it invoked (name, tokens, its text for the pane)', () => {
    const x = wl().wlEntryOf(
      ST,
      entry(
        invoked('예측 시장 리포트', [
          ['local:using-ssot', 'ssot body'],
          ['local:autoz', 'autoz body'],
        ]),
        { by: 'user' },
      ),
    );
    expect(x).toMatchObject({ kind: 'instruction', text: '예측 시장 리포트' });
    expect(x.skills).toEqual([
      { name: 'local:using-ssot', tokens: expect.any(Number), text: 'ssot body' },
      { name: 'local:autoz', tokens: expect.any(Number), text: 'autoz body' },
    ]);
    expect(JSON.stringify(x.text)).not.toContain('invoked_skills');
  });

  it('a stored text cut inside the skill block (4,000 characters): the words, and a chip per readable skill name — no cut text', () => {
    const cut = `예측 시장 리포트\n\n<invoked_skills>\n<local:using-ssot>\nssot body\n</local:using-ssot>\n<local:autoz>\n${'x'.repeat(3000)}`;
    const x = wl().wlEntryOf(ST, entry(cut, { by: 'user', rawBytes: 51_998 }));
    expect(x.text).toBe('예측 시장 리포트');
    expect(x.skills).toEqual([{ name: 'local:using-ssot' }, { name: 'local:autoz' }]);
    expect(JSON.stringify(x)).not.toContain('xxxxxxxxxx');
    expect(JSON.stringify(x)).not.toContain('ssot body');
    // wlPaint loads the stored original for such a row (its chips then carry the text and tokens).
    expect(clientFn('wlPaint')).toContain('wlRawFetch(st, Number(x.id))');
  });

  it('the stored original loaded: every skill with its text and tokens', () => {
    const full = invoked('예측 시장 리포트', [
      ['local:using-ssot', 'ssot body'],
      ['local:autoz', 'autoz body'],
    ]);
    const cut = `예측 시장 리포트\n\n<invoked_skills>\n<local:using-ssot>\nssot body\n</local:using-ssot>\n<local:autoz>\n${'x'.repeat(3000)}`;
    const st = { entries: [], rawDone: { 5: { status: 'ok', raw: full } } };
    const x = wl().wlEntryOf(st, entry(cut, { by: 'user', rawBytes: 51_998 }));
    expect(x.skills).toEqual([
      { name: 'local:using-ssot', tokens: expect.any(Number), text: 'ssot body' },
      { name: 'local:autoz', tokens: expect.any(Number), text: 'autoz body' },
    ]);
  });

  it('two blocks (autoskill closed, the $skill one cut): one row of chips for both, no skill text', () => {
    const two = `리포트\n\n<invoked_skills>\n<local:using-ssot>\nssot body\n</local:using-ssot>\n</invoked_skills>\n\n<invoked_skills>\n<local:autoz>\n${'y'.repeat(3000)}`;
    const x = wl().wlEntryOf(ST, entry(two, { by: 'user', rawBytes: 40_000 }));
    expect(x.text).toBe('리포트');
    expect((x.skills ?? []).map((k) => k.name)).toEqual(['local:using-ssot', 'local:autoz']);
    expect(JSON.stringify(x)).not.toContain('yyyyyyyyyy');
  });

  it('a text that was not cut (no stored original) and only mentions the tag is words, never chips', () => {
    const x = wl().wlEntryOf(ST, entry('예시: <invoked_skills>\n<foo> 처럼 쓰면 된다', { by: 'user' }));
    expect(x).not.toHaveProperty('skills');
    expect(x.text).toBe('예시: <invoked_skills>\n<foo> 처럼 쓰면 된다');
  });

  it('a plain instruction is unchanged', () => {
    const x = wl().wlEntryOf(ST, entry('대시보드 고쳐줘', { by: 'user' }));
    expect(x).toEqual({ id: '5', at: 1_792_900_000_000, kind: 'instruction', text: '대시보드 고쳐줘', hasRaw: true });
  });

  it('the opened row shows the facts with the raw prompt (the viewer’s note); a person’s row has none', () => {
    const a = wl();
    expect(a.wlEntryFactsText(entry(goalPrompt(2, 10, 'gap'), { by: 'system' }))).toBe(
      '회차: 2 / 10 · 직전 평가에서 남은 일: gap',
    );
    expect(a.wlEntryFactsText(entry('대시보드 고쳐줘', { by: 'user' }))).toBe('');
    expect(a.wlEntryFactsText({ seq: 6, kind: 'narration', text: goalPrompt(2, 10) })).toBe('');
    const open = a.wlEntryOf({ entries: [], open: new Set([5]) }, entry(goalPrompt(2, 10, 'gap'), { by: 'system' }));
    expect(open.raw).toEqual({
      state: 'ready',
      text: expect.stringContaining('[goal-continuation]'),
      note: '회차: 2 / 10 · 직전 평가에서 남은 일: gap',
    });
  });
});

// D4 K-06: <ui-disclosure> toggles by itself — since 0.8.0 a click on the slotted summary's words counts too, so
// D1's click workaround (G4-4) is gone. The page keeps each choice from the element's ui-toggle and, for a region
// it paints only while open, paints it on the way open and drops its nodes once ui-toggled says the fold settled.
describe('D4 — the page keeps a disclosure’s choice and paints its region around the element’s motion (K-06)', () => {
  const INIT = (() => {
    const start = TEMPLATE.indexOf('(function initDisclosures() {');
    const end = TEMPLATE.indexOf('\n})();', start);
    if (start < 0 || end < 0) throw new Error('initDisclosures not found');
    return cook(TEMPLATE.slice(start, end + 6));
  })();
  type Fn = (e: unknown) => void;
  type Choice = boolean | 'folding';
  function setup() {
    const on: Record<string, Fn[]> = {};
    const document = {
      addEventListener: (type: string, fn: Fn) => {
        on[type] = [...(on[type] ?? []), fn];
      },
    };
    const calls: string[] = [];
    const state = new Function(
      'document',
      'ioSysToggle',
      'renderPanelInfo',
      'repaintPanelTasks',
      'renderPanelArtifactsSection',
      `var _panelInfoOpen = false; var _panelTasksOpen = false; var _umPanelOpen = false;\n${INIT}\nreturn { get: function() { return { info: _panelInfoOpen, tasks: _panelTasksOpen, um: _umPanelOpen }; } };`,
    )(
      document,
      (cid: string, open: boolean) => calls.push(`io ${cid} ${open}`),
      () => calls.push('info'),
      () => calls.push('tasks'),
      () => calls.push('arts'),
    ) as { get(): { info: Choice; tasks: Choice; um: Choice } };
    const el = (cls: string, attrs: Record<string, string> = {}) => ({
      tagName: 'UI-DISCLOSURE',
      classList: { contains: (c: string) => c === cls },
      getAttribute: (n: string) => attrs[n] ?? null,
    });
    const fire = (type: string, target: unknown, open: boolean) => {
      for (const fn of on[type] ?? []) fn({ target, detail: { open } });
    };
    return { state, calls, el, fire };
  }

  it('the page no longer toggles a disclosure itself: the 0.5.0 click workaround is gone', () => {
    expect(INIT).not.toContain("addEventListener('click'");
    expect(INIT).not.toContain('.toggle()');
    expect(TEMPLATE).not.toContain('function dcSummaryHost(');
  });

  it('a card’s system instruction keeps its choice; the completed goals fold inside <ui-goal-card> (D6b) — no page choice', () => {
    const s = setup();
    s.fire('ui-toggle', s.el('io-sys', { 'data-cid': 'conv-1' }), true);
    s.fire('ui-toggle', s.el('cg-hx', { 'data-hx': 'k1' }), false);
    s.fire('ui-toggled', s.el('cg-hx', { 'data-hx': 'k1' }), false);
    expect(s.calls).toEqual(['io conv-1 true']);
    expect(INIT).not.toContain('cg-hx');
  });

  it('세션 정보 / Tasks / 지시 첨부: painted on the way open, kept as folding through the close, dropped once settled', () => {
    const s = setup();
    s.fire('ui-toggle', s.el('pi-dc'), true);
    expect(s.state.get().info).toBe(true);
    expect(s.calls).toEqual(['info']);
    s.fire('ui-toggle', s.el('pi-dc'), false);
    expect(s.state.get().info).toBe('folding');
    expect(s.calls).toEqual(['info']); // nothing dropped while the region folds
    s.fire('ui-toggled', s.el('pi-dc'), true); // an open that settled: nothing to drop
    expect(s.calls).toEqual(['info']);
    s.fire('ui-toggled', s.el('pi-dc'), false);
    expect(s.state.get().info).toBe(false);
    expect(s.calls).toEqual(['info', 'info']);
    s.fire('ui-toggle', s.el('panel-tasks-dc'), true);
    s.fire('ui-toggle', s.el('panel-um-dc'), true);
    expect(s.state.get()).toEqual({ info: false, tasks: true, um: true });
    expect(s.calls.slice(2)).toEqual(['tasks', 'arts']);
    s.fire('ui-toggle', s.el('panel-tasks-dc'), false);
    s.fire('ui-toggled', s.el('panel-tasks-dc'), false);
    s.fire('ui-toggle', s.el('panel-um-dc'), false);
    s.fire('ui-toggled', s.el('panel-um-dc'), false);
    expect(s.state.get()).toEqual({ info: false, tasks: false, um: false });
    expect(s.calls.slice(4)).toEqual(['tasks', 'arts']);
    // A close that settled without a fold asked for here (a repaint closed it): nothing to drop again.
    s.fire('ui-toggled', s.el('panel-tasks-dc'), false);
    expect(s.calls).toHaveLength(6);
    // Another element's ui-toggle is not a disclosure's.
    s.fire(
      'ui-toggle',
      { tagName: 'UI-AGENT-TREE', classList: { contains: () => true }, getAttribute: () => null },
      true,
    );
    expect(s.calls).toHaveLength(6);
    expect(s.state.get()).toEqual({ info: false, tasks: false, um: false });
  });
});
