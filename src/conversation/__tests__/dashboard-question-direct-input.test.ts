import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChoiceActionHandler } from '../../slack/actions/choice-action-handler';
import { viewerScope } from '../__fixtures__/viewer-scope';

/**
 * #917 — the last option of every question is direct input, on the dashboard too.
 *
 * SSOT_1 (Z, 2026-11-04): "… 1번은 추천 행동 2번 3번은 대안행동 그리고 맨 마지막에는 직접입력하는 유저에게 질문이
 * 있어야함."
 *
 * Slack already ends every question with ✏️ 직접 입력, and the dashboard's multi-question form takes an own answer.
 * The dashboard's single-choice question did not ("the route takes one of them only"): its card now offers a free-text
 * answer, its quick-choice face ends with a 직접 입력 button, and the answer route takes the 직접입력 sentinel.
 */

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const Q = {
  type: 'user_choice',
  question: '[small] 다음에 무엇을 할까요?',
  recommendedChoiceId: '1',
  choices: [
    { id: '1', label: '머지' },
    { id: '2', label: '리뷰 요청' },
    { id: '3', label: '보류' },
  ],
};
const SESSION = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  ownerId: 'U1',
  activityState: 'waiting',
  pendingQuestion: Q,
  ...over,
});
const BASE_FNS = ['esc', 'escAttr', 'acQuestionLock', 'acQuestionId', 'stripRecommendedMarker', 'resolveRecommendedId'];
const BASE_INJECT = (state: Record<string, unknown> = {}) => ({
  currentUserId: 'U1',
  READ_ONLY_MSG: '읽기 전용 — 내 세션이 아닙니다',
  isSiblingSession: () => false,
  _acState: state,
});

describe('client — the single-choice question takes direct input (#917)', () => {
  it('the approval card offers a free-text answer', () => {
    const c = load<{ acQuestionData(s: unknown, q: unknown): Record<string, unknown> }>(
      [...BASE_FNS, 'acQuestionData'],
      ['AC_SIBLING'],
      BASE_INJECT(),
    );
    expect(c.acQuestionData(SESSION(), Q).allowOther).toBe(true);
  });

  it('the quick-choice face ends with a 직접 입력 button, after the choices', () => {
    const c = load<{ quickChoiceHtml(s: unknown, q: unknown, onFace?: boolean): string }>(
      [...BASE_FNS, 'quickChoiceHtml'],
      ['AC_SIBLING'],
      BASE_INJECT(),
    );
    const html = c.quickChoiceHtml(SESSION(), Q);
    const labels = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(labels).toEqual(['머지', '리뷰 요청', '보류', '✏️ 직접 입력']);
    expect(html).toContain('cardQuickDirectInput(this)');
  });

  it('a free-text answer goes to the route as the 직접입력 sentinel with its text', async () => {
    const posts: Array<[string, any]> = [];
    const state: Record<string, any> = {};
    const c = load<{ answerChoice(k: string, qid: string, choiceId: string, text?: string): Promise<any> }>(
      [...BASE_FNS, 'answerChoice'],
      ['MC_CUSTOM_ID', 'AC_SIBLING'],
      {
        ...BASE_INJECT(state),
        _sessionCache: { 'inst::C1:t1': SESSION() },
        acRepaint: () => undefined,
        acDrop: () => undefined,
        acRefusal: async () => ({ status: 'error', message: 'x' }),
        dashToast: () => undefined,
        acPost: async (url: string, body: string) => {
          posts.push([url, JSON.parse(body)]);
          return { ok: true, status: 200 };
        },
      },
    );
    const qid = load<{ acQuestionId(q: unknown): string }>(['acQuestionId'], []).acQuestionId(Q);
    const st = await c.answerChoice('inst::C1:t1', qid, '', '  스테이징에 먼저 배포해  ');
    expect(posts).toEqual([
      [
        '/api/dashboard/session/inst%3A%3AC1%3At1/answer-choice',
        { choiceId: '직접입력', label: '스테이징에 먼저 배포해', question: Q.question },
      ],
    ]);
    expect(st).toMatchObject({ status: 'resolved', outcome: 'answered', text: '스테이징에 먼저 배포해' });
  });

  it('the ui-answer listener hands a text answer (no choiceId) to answerChoice', () => {
    const at = TEMPLATE.indexOf("document.addEventListener('ui-answer'");
    const listener = TEMPLATE.slice(at, TEMPLATE.indexOf('});', at));
    expect(listener).toContain('e.detail.text');
    expect(listener).toMatch(/answerChoice\(.*e\.detail\.text\);/);
  });
});

describe('server — the single-choice answer takes the direct-input sentinel (#917)', () => {
  function answerSession() {
    const session: any = {
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      channelId: 'C1',
      ownerId: 'U1',
      activityState: 'waiting',
      actionPanel: { pendingQuestion: Q },
    };
    return session;
  }

  it('a 직접입력 answer is not refused as an invalid choice: its text is the user turn', async () => {
    const session = answerSession();
    const messageHandler = vi.fn().mockResolvedValue(undefined);
    const claudeHandler = {
      getSessionByKey: vi.fn(() => session),
      setActivityStateByKey: vi.fn((_k: string, st: string) => {
        session.activityState = st;
      }),
      getSessionRegistry: () => ({ persistAndBroadcast: vi.fn() }),
    };
    const handler = new ChoiceActionHandler(
      {
        slackApi: { updateMessage: vi.fn().mockResolvedValue(undefined), deleteMessage: vi.fn() },
        claudeHandler,
        messageHandler,
        threadPanel: { clearChoice: vi.fn().mockResolvedValue(undefined) },
      } as any,
      {
        get: () => undefined,
        set: () => undefined,
        delete: () => undefined,
        getFormsBySession: () => new Map(),
      } as any,
    );
    await handler.handleChoiceFromDashboard('C1:thread-root', '직접입력', '스테이징에 먼저 배포해', Q.question, 'U1');
    expect(messageHandler).toHaveBeenCalledTimes(1);
    expect(messageHandler.mock.calls[0][0].text).toBe('스테이징에 먼저 배포해');
  });

  it('the route lets a direct-input answer be longer than a choice label', () => {
    const at = DASHBOARD_TS.indexOf("'/api/dashboard/session/:key/answer-choice'");
    const route = DASHBOARD_TS.slice(at, DASHBOARD_TS.indexOf('// ── Answer multi-choice from dashboard ──', at));
    expect(route).toContain('CUSTOM_CHOICE_ID');
  });
});
