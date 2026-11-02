/**
 * Plan mode (SSOT 2026-11-02) — a real dashboard server for the browser check
 * (`scripts/plan-mode-browser-check.cjs`). The real web server, routes, registry
 * (scratch data dir) and plan decider; the task turn controller is a stub that
 * accepts a start (its 202) and records the text, so 시작 can be seen to send the plan.
 *
 * Seeds, owned by U0PLANVIEWER:
 *   - a plan-mode task whose plan v1 waits (awaiting), four levels deep;
 *   - a task waiting on a simple question (예 / 아니오).
 *
 * Run from the repo root:
 *   SOMA_CONFIG_DIR=$TMP/cfg CONVERSATION_VIEWER_PORT=33981 CONVERSATION_VIEWER_TOKEN=tok \
 *   DASHBOARD_JWT_SECRET=secret npx tsx scripts/plan-mode-browser-server.ts
 * It prints `READY <sso-url>` once listening.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const OWNER = 'U0PLANVIEWER';

async function main() {
  const { SessionRegistry } = await import('../src/session-registry');
  const dashboard = await import('../src/conversation/dashboard');
  const webServer = await import('../src/conversation/web-server');
  const { issueSlackToken } = await import('../src/conversation/oauth');
  const { createTaskPlanDecider } = await import('../src/task-turn/task-plan-decision');
  const { buildTaskSessionKey } = await import('../src/session-identity');

  const registry = new SessionRegistry();
  const dir = (name: string) => {
    const d = path.join('/tmp', OWNER, `session_plan_check_${name}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  const planned = registry.createTask({
    ownerId: OWNER,
    ownerName: 'Plan Viewer',
    workingDirectory: dir('a'),
    title: 'soma-work 대시보드에 작업 계획 모드 넣어줘',
    planMode: true,
  });
  registry.submitTaskPlan(planned.taskId!, {
    summary: '새 작업에 작업 계획 모드를 넣고, 시작을 누르기 전에는 실행하지 않는다',
    intent: '받아쓰기·음성 지시나 긴 에픽이 잘못 읽힌 채 실행되지 않도록, 실행 전에 계획을 보여 주고 확인받는다',
    ssot: ['대시보드 "새 작업"에서 plan 토글 on/off 추가 (디폴트 on)', '시작 · 취소 · 직접 입력을 받아 작업을 진행'],
    intents: [
      { id: 'I1', text: '실행 전에 유저가 계획을 확인하고 직접 시작한다', source: 'SSOT_1' },
      { id: 'I2', text: '확인은 클릭 한 번 — 카드에서 바로', source: '추론' },
    ],
    phases: [
      {
        title: '서버 게이트',
        goal: '시작 전에는 계획 도구만, 시작하면 계획 전문으로 작업',
        steps: [
          { title: '계획 게이트 저장', detail: 'drafting → awaiting → approved | cancelled, 엄격 저장', refs: ['T4'] },
          {
            title: '계획 제출 도구',
            detail: 'plan_submit — 구조화된 4단 계획',
            deliverable: 'plan-server.ts',
            refs: ['T2'],
          },
        ],
      },
      {
        title: '화면',
        goal: '카드를 열면 계획이 바로, 버튼은 손닿는 곳에',
        steps: [
          { title: '디테일 카드에 계획', detail: '입력 필요 영역에 인라인', refs: ['T5'] },
          { title: '맨 위 · 맨 아래 · 작업 카드 버튼', refs: ['T6'] },
          { title: '단순 질문 버튼', refs: ['T7'] },
        ],
      },
    ],
    assumptions: ['대시보드 작업만'],
    risks: ['계획 중 모델이 작업을 시작 — 도구 부착으로 막음'],
    outOfScope: ['Slack 채널 새 작업'],
    questions: ['에픽도 계획 모드를 기본으로 할까요?'],
  });

  const asking = registry.createTask({
    ownerId: OWNER,
    ownerName: 'Plan Viewer',
    workingDirectory: dir('b'),
    title: '배포 전 확인',
  });
  asking.activityState = 'waiting';
  asking.actionPanel = {
    channelId: '',
    userId: OWNER,
    waitingForChoice: true,
    pendingQuestion: {
      type: 'user_choice',
      question: 'dev에 배포할까요?',
      askId: 'ask-check-1',
      choices: [
        { id: 'yes', label: '예' },
        { id: 'no', label: '아니오' },
      ],
      recommendedChoiceId: 'yes',
    } as never,
  };

  const started: string[] = [];
  const answered: string[] = [];
  const controller = {
    canStart: () => null,
    isRunning: () => false,
    start: async (req: { sessionKey: string; text: string }) => {
      started.push(req.text);
      return { status: 202, body: { ok: true } };
    },
  };
  dashboard.setDashboardSessionAccessor(() => registry.getAllSessions());
  dashboard.setDashboardTaskPlanHandler(
    createTaskPlanDecider({
      getSession: (k) => registry.getSessionByKey(k),
      setTaskPlanGate: (taskId, gate) => registry.setTaskPlanGate(taskId, gate),
      controller: controller as never,
      logger: { info: () => {}, warn: () => {} },
    }),
  );
  dashboard.setDashboardTaskAnswerHandler(async (sessionKey, askId, answer) => {
    answered.push(`${sessionKey}|${askId}|${JSON.stringify(answer)}`);
    const s = registry.getSessionByKey(sessionKey);
    if (s?.actionPanel) {
      s.actionPanel.pendingQuestion = undefined;
      s.actionPanel.waitingForChoice = false;
    }
    if (s) s.activityState = 'idle';
    dashboard.broadcastSessionUpdate();
    return { status: 202, body: { ok: true } };
  });

  // The new-task composer's context and a launcher that offers the dashboard-task destination (B1).
  const { NEW_TASK_LIMITS } = await import('../src/conversation/new-task');
  dashboard.setDashboardNewTaskProvider({
    context: async () => ({
      models: [{ nickname: 'opus', model: 'claude-opus-5-5[1m]', label: 'Opus' }],
      defaultModel: 'opus',
      efforts: ['high'],
      defaultEffort: 'high',
      channels: [],
      defaultChannelId: null,
      membershipUnknown: false,
      autogoalDefault: false,
      usage: { scope: 'shared-pool', source: null, fetchedAt: null },
      limits: NEW_TASK_LIMITS,
    }),
    start: async () => ({ status: 'running' }),
  } as never);
  dashboard.setDashboardTaskLauncher({
    launch: async () => ({ status: 200, body: { sessionKey: 'task:none', status: 'running' } }),
    folders: () => [],
  });

  await webServer.startWebServer({ listen: true });
  const port = process.env.CONVERSATION_VIEWER_PORT;
  const token = issueSlackToken({ slackUserId: OWNER, email: `${OWNER}@slack.local`, name: 'Plan Viewer' });
  // The driver reads what 시작 sent and what was answered.
  fs.writeFileSync(
    path.join(process.env.SOMA_CONFIG_DIR as string, 'keys.json'),
    JSON.stringify({ planned: buildTaskSessionKey(planned.taskId!), asking: buildTaskSessionKey(asking.taskId!) }),
  );
  setInterval(() => {
    fs.writeFileSync(
      path.join(process.env.SOMA_CONFIG_DIR as string, 'effects.json'),
      JSON.stringify({ started, answered, gate: registry.getSessionByTaskId(planned.taskId!)?.taskPlan?.state }),
    );
  }, 200);
  console.log(`READY http://127.0.0.1:${port}/auth/sso?token=${encodeURIComponent(token)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
