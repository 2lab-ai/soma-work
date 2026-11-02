/**
 * 스레드 태스크 카드 receipt (SSOT 2026-11-02, .prd/21 §5): the Slack thread root message's header for five owners,
 * rendered by the real path — a real UserSettingsStore (a temp data dir), the host's wiring (`threadCardProviders`,
 * the session theme as src/slack/thread-surface.ts sets it), the real ThreadSurface — with only the Slack API doubled.
 * Writes `<outDir>/<case>.json` (the header blocks, before the panel's controls) and `<outDir>/all.json`, ready to
 * post with chat.postMessage or to draw with a Block Kit renderer.
 *
 *   follow-default    never opened the editor (minimal 1안)
 *   follow-advanced   dashboard in advanced 2안
 *   follow-edited     an edited task card (tokens and steps on, the model first)
 *   custom            따로 설정 (steps · task · workflow; the dashboard link only)
 *   theme             서버 슬랙 테마 with the compact session theme
 *
 * Run: env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/thread-card-receipt.ts [outDir]
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setThreadHeaderProviders } from '@soma/slack/thread-header-builder';
import { type ConversationSession, setThreadSurfaceProviders, ThreadSurface } from '@soma/slack/thread-surface';
import { applyTodoList } from '../src/session/task-ledger';
import { threadCardProviders } from '../src/slack/thread-card-data';
import { UserSettingsStore } from '../src/user-settings-store';
import { BUILTIN_PRESETS, type DashboardLayoutDoc, normalizeLayoutDoc } from '../src/view-layout';

const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'thread-card');
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-card-receipt-'));
const store = new UserSettingsStore(dir);

const KEY = 'work:C1:1793.000100';
const DASH = (owner: string) => `https://soma.example/dashboard/${owner}?session=${encodeURIComponent(KEY)}`;

function session(ownerId: string): ConversationSession {
  const ledger = applyTodoList(
    undefined,
    [
      { content: '요구 정리', status: 'completed' },
      { content: '화면 설계', status: 'completed' },
      { content: '카드 폼 검증 추가', status: 'in_progress', activeForm: '카드 폼 검증 추가 중' },
      { content: '확인', status: 'pending' },
    ] as any,
    1_000,
  );
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: '1793.000100',
    threadRootTs: '1793.000100',
    threadModel: 'bot-initiated',
    ownerId,
    ownerName: 'Zhuge',
    title: '결제 페이지 리뉴얼',
    workflow: 'zwork',
    model: 'claude-opus-5-5[1m]',
    usage: {
      contextWindow: 1_000_000,
      currentInputTokens: 20_000,
      currentOutputTokens: 4_000,
      currentCacheReadTokens: 400_000,
      currentCacheCreateTokens: 6_000,
      totalInputTokens: 300_000,
      totalOutputTokens: 40_000,
      totalCacheReadTokens: 6_000_000,
      totalCacheCreateTokens: 100_000,
      totalCostUsd: 6.2,
    },
    taskLedger: ledger,
    // 작업 카드의 연결 (.prd/22): an issue, a PR and a wiki — the card's 연결 row brings the link history.
    linkHistory: {
      issues: [
        {
          url: 'https://2lab.atlassian.net/browse/PAY-12',
          label: 'PAY-12',
          provider: 'jira',
          type: 'issue',
          status: 'In Progress',
        },
      ],
      docs: [
        {
          url: 'https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design',
          label: 'Confluence',
          provider: 'confluence',
          type: 'doc',
          title: '결제 폼 설계',
        },
      ],
      prs: [
        {
          url: 'https://github.com/2lab-ai/soma-work/pull/733',
          label: 'PR #733',
          provider: 'github',
          type: 'pr',
          status: 'open',
        },
      ],
    },
    isActive: true,
    terminated: false,
    logVerbosity: 0,
    activityState: 'working',
    actionPanel: { channelId: 'C1', messageTs: '1793.000100' },
  } as unknown as ConversationSession;
}

async function headerOf(ownerId: string): Promise<any[]> {
  setThreadHeaderProviders({ getDashboardSessionUrl: (owner) => DASH(owner), ...threadCardProviders(store) });
  setThreadSurfaceProviders({ getSessionTheme: (userId) => store.getUserSessionTheme(userId ?? '') });
  const s = session(ownerId);
  let sent: any[] = [];
  const surface = new ThreadSurface({
    slackApi: {
      getClient: () => ({}),
      getPermalink: async () => 'https://slack.example/p',
      updateMessage: async (_c: string, ts: string, _t: string, blocks: any[]) => {
        if (ts === '1793.000100') sent = blocks;
      },
      postMessage: async () => ({ ts: 'posted-ts' }),
    } as any,
    claudeHandler: { getSessionByKey: () => s } as any,
    requestCoordinator: { isRequestActive: () => false } as any,
    todoManager: { getTodos: () => [], getEffectiveStatus: () => undefined } as any,
  });
  await surface.updatePanel(s, KEY);
  const end = sent.findIndex((b) => b?.type === 'divider' || b?.type === 'actions');
  return sent.slice(0, end < 0 ? sent.length : end);
}

async function main() {
  const face = JSON.parse(JSON.stringify(BUILTIN_PRESETS['1'].minimal.card));
  const at = (id: string) => face.foot.findIndex((c: { id: string }) => c.id === id);
  face.foot[at('tokens')].on = true;
  face.foot[at('steps')].on = true;
  face.foot.unshift(face.foot.splice(at('model'), 1)[0]);
  const docs: Record<string, DashboardLayoutDoc> = {
    U_EDIT: normalizeLayoutDoc({ v: 1, presets: { '1': { minimal: { card: face } } } }),
    U_CUSTOM: normalizeLayoutDoc({
      v: 1,
      thread: {
        mode: 'custom',
        custom: {
          info: [
            { id: 'steps', on: true },
            { id: 'task', on: true },
            { id: 'workflow', on: true },
            { id: 'owner', on: false },
            { id: 'cost', on: false },
            { id: 'model', on: false },
          ],
          nav: [
            { id: 'dashboardLink', on: true },
            { id: 'linkhistory', on: false },
          ],
        },
      },
    }),
    U_THEME: normalizeLayoutDoc({ v: 1, thread: { mode: 'theme' } }),
  };
  for (const [u, doc] of Object.entries(docs)) store.setUserDashboardLayout(u, doc);
  store.setUserDashboardMode('U_ADV', 'advanced');
  store.setUserDashboardPlan('U_ADV', '2');
  store.setUserSessionTheme('U_THEME', 'compact');

  const cases: Array<[string, string]> = [
    ['follow-default', 'U_FOLLOW'],
    ['follow-advanced', 'U_ADV'],
    ['follow-edited', 'U_EDIT'],
    ['custom', 'U_CUSTOM'],
    ['theme', 'U_THEME'],
  ];
  const all: Record<string, any[]> = {};
  for (const [name, owner] of cases) {
    all[name] = await headerOf(owner);
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(all[name], null, 2));
    console.log(`${name}: ${all[name].length} blocks`);
  }
  fs.writeFileSync(path.join(OUT, 'all.json'), JSON.stringify(all, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
