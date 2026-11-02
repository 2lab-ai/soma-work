/**
 * 스레드 태스크 카드 end to end (SSOT 2026-11-02, .prd/21 §5): what the Slack thread's root message carries for an
 * owner, from their saved settings to the blocks handed to `chat.update`.
 *
 *   the real UserSettingsStore (a temp data dir) → the host's wiring exactly as src/index.ts plugs it
 *   (`threadCardProviders`) → the real ThreadSurface.updatePanel → ThreadHeaderBuilder.fromSession → the blocks
 *   sent to Slack (the Slack API is the only double).
 *
 *   F1  an owner who never opened the editor: the header follows their task card (minimal 1안)
 *   F2  the dashboard in advanced 2안: the header follows that card (the same rule, another card)
 *   F3  an edited task card (tokens and steps on, the model first): the header follows the edit
 *   C1  따로 설정: the owner's own thread card, whatever the task card shows
 *   T1  서버 슬랙 테마: the header is the server's `ui.threadheader` for the owner's session theme, as before
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConversationSession, ThreadSurfaceDeps } from '@soma/slack/thread-surface';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { applyTodoList } from '../../session/task-ledger';
import { UserSettingsStore } from '../../user-settings-store';
import { BUILTIN_PRESETS, normalizeLayoutDoc } from '../../view-layout';
import { threadCardProviders } from '../thread-card-data';

// The Slack package as the daemon loads it (Node's require): ThreadSurface and the header builder it requires share
// one module, so the providers set here are the ones the surface's header reads.
const nodeRequire = createRequire(__filename);
const { setThreadHeaderProviders, ThreadHeaderBuilder } = nodeRequire(
  '@soma/slack/thread-header-builder',
) as typeof import('@soma/slack/thread-header-builder');
const { setThreadSurfaceProviders, ThreadSurface } = nodeRequire(
  '@soma/slack/thread-surface',
) as typeof import('@soma/slack/thread-surface');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-card-e2e-'));
const store = new UserSettingsStore(dir);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() =>
  setThreadHeaderProviders({
    getDashboardSessionUrl: () => undefined,
    getThreadCardLines: () => undefined,
    getThreadCardData: () => undefined,
  }),
);

const KEY = 'work:C1:1793.000100';
const DASH = (owner: string) => `https://soma.example/dashboard/${owner}?session=${encodeURIComponent(KEY)}`;
const PR = 'https://github.com/2lab-ai/soma-work/pull/733';

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
    linkHistory: { prs: [{ url: PR, label: 'PR #733', provider: 'github', type: 'pr', status: 'open' }] },
    isActive: true,
    terminated: false,
    logVerbosity: 0,
    activityState: 'working',
    actionPanel: { channelId: 'C1', messageTs: '1793.000100' },
  } as unknown as ConversationSession;
}

/** The root message's blocks as ThreadSurface sends them to Slack. */
async function rootBlocks(ownerId: string): Promise<any[]> {
  // The host's wiring: src/index.ts (the header's providers) and src/slack/thread-surface.ts (the session theme).
  setThreadHeaderProviders({ getDashboardSessionUrl: (owner) => DASH(owner), ...threadCardProviders(store) });
  setThreadSurfaceProviders({ getSessionTheme: (userId) => store.getUserSessionTheme(userId ?? '') });
  const s = session(ownerId);
  const updates: Array<{ ts: string; blocks: any[] }> = [];
  const deps: ThreadSurfaceDeps = {
    slackApi: {
      getClient: vi.fn().mockReturnValue({}),
      getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
      updateMessage: vi.fn(async (_c: string, ts: string, _t: string, blocks: any[]) => {
        updates.push({ ts, blocks });
      }),
      postMessage: vi.fn(async () => ({ ts: 'posted-ts' })),
    } as any,
    claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(s) } as any,
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
  };
  const surf = new ThreadSurface(deps);
  await surf.updatePanel(s, KEY);
  const root = updates.filter((u) => u.ts === '1793.000100').pop();
  expect(root).toBeDefined();
  return root!.blocks;
}

/** The header part of the root message (before the panel's controls), one string per block. */
function header(blocks: any[]): string[] {
  const end = blocks.findIndex((b) => b?.type === 'divider' || b?.type === 'actions');
  return blocks
    .slice(0, end < 0 ? blocks.length : end)
    .map((b) =>
      b.type === 'header'
        ? `H ${b.text.text}`
        : b.type === 'context'
          ? `C ${b.elements.map((e: any) => e.text).join(' | ')}`
          : b.type === 'section'
            ? `S ${b.text?.text ?? ''}`
            : b.type,
    );
}

/** The card's lines of the root message: the header minus the surface's own status section (작업 중). */
const card = (blocks: any[]) => header(blocks).filter((line) => !line.includes('*작업 중*'));
const LINKS = (owner: string, pr = true) =>
  `C 📋 <${DASH(owner)}|작업 로그>` + (pr ? ` | 🔀 <${PR}|PR #733> · 기록 당시 Open` : '');

describe('the Slack thread header from the owner’s saved settings', () => {
  it('F1 an owner who never opened the editor: the header follows their task card (minimal 1안)', async () => {
    expect(card(await rootBlocks('U_FOLLOW'))).toEqual([
      'H 결제 페이지 리뉴얼',
      'C <@U_FOLLOW> | ▶ 카드 폼 검증 추가 | $6.20 | `opus-5.5 (1M)`',
      LINKS('U_FOLLOW'),
    ]);
  });

  it('F2 the dashboard in advanced 2안: the header follows that card (tokens · cost row, steps and context chips)', async () => {
    store.setUserDashboardMode('U_ADV', 'advanced');
    store.setUserDashboardPlan('U_ADV', '2');
    expect(card(await rootBlocks('U_ADV'))).toEqual([
      'H 결제 페이지 리뉴얼',
      'C <@U_ADV> | ▶ 카드 폼 검증 추가 | 6.4M 토큰 | $6.20 | 작업 2/4 | ▓▓░░░ 430k/1M (43.0% used)',
      LINKS('U_ADV'),
    ]);
  });

  it('F3 an edited task card (tokens and steps on, the model first): the header follows the edit', async () => {
    const face = JSON.parse(JSON.stringify(BUILTIN_PRESETS['1'].minimal.card));
    const at = (id: string) => face.foot.findIndex((c: { id: string }) => c.id === id);
    face.foot[at('tokens')].on = true;
    face.foot[at('steps')].on = true;
    const [model] = face.foot.splice(at('model'), 1);
    face.foot.unshift(model);
    store.setUserDashboardLayout('U_EDIT', normalizeLayoutDoc({ v: 1, presets: { '1': { minimal: { card: face } } } }));
    expect(card(await rootBlocks('U_EDIT'))).toEqual([
      'H 결제 페이지 리뉴얼',
      'C <@U_EDIT> | ▶ 카드 폼 검증 추가 | `opus-5.5 (1M)` | $6.20 | 작업 2/4 | 6.4M 토큰',
      LINKS('U_EDIT'),
    ]);
  });

  it('C1 따로 설정: the owner’s own thread card, whatever the task card shows', async () => {
    store.setUserDashboardLayout(
      'U_CUSTOM',
      normalizeLayoutDoc({
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
    );
    expect(card(await rootBlocks('U_CUSTOM'))).toEqual([
      'H 결제 페이지 리뉴얼',
      'C 작업 2/4 | ▶ 카드 폼 검증 추가 | `zwork`',
      LINKS('U_CUSTOM', false),
    ]);
  });

  it('T1 서버 슬랙 테마: the header is the server’s ui.threadheader for the owner’s session theme, as before', async () => {
    store.setUserDashboardLayout('U_THEME', normalizeLayoutDoc({ v: 1, thread: { mode: 'theme' } }));
    store.setUserSessionTheme('U_THEME', 'compact');
    const got = card(await rootBlocks('U_THEME'));
    expect(got).toEqual([
      'S *Zhuge — 결제 페이지 리뉴얼*',
      `C \`zwork\` | \`opus-5.5 (1M)\` | ▓▓░░░ 430k/1M (43.0% used) | 📋 <${DASH('U_THEME')}|작업 로그>`,
    ]);
    expect(got.join('\n')).not.toContain('▶ 카드 폼 검증 추가'); // the card's task line is not the theme's
    // Exactly the server's compact theme lines: the header as it was drawn before the thread card existed.
    setThreadHeaderProviders({ getDashboardSessionUrl: (owner) => DASH(owner), getThreadCardLines: () => undefined });
    const s = session('U_THEME');
    const before = ThreadHeaderBuilder.build({
      title: s.title,
      workflow: s.workflow,
      ownerName: s.ownerName,
      ownerId: s.ownerId,
      linkHistory: s.linkHistory,
      model: s.model,
      usage: s.usage,
      sessionKey: KEY,
      theme: 'compact',
      suppressSessionStatus: true,
    }).blocks!;
    expect(got).toEqual(card(before));
  });
});
