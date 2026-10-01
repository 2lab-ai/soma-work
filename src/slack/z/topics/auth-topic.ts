/**
 * `auth` Block Kit topic (#llmux runtime switch).
 *
 * Renders the auth-mode card: current backend (llmux vs legacy cct), runtime
 * mode switch, llmux pool usage + manual account switch, llmux settings, and
 * account add/remove. Modal/button handlers live in
 * `src/slack/auth/actions.ts` and are registered on the shared Bolt app.
 *
 * In ccp (legacy cct) mode the card appends the existing CCT card blocks so
 * `auth` remains the single entry point for "what is my auth state".
 */

import { isAdminUser } from '../../../admin-utils';
import { getAuthRuntimeSnapshot, setAuthMode } from '../../../auth/auth-runtime';
import { fetchLlmuxStatus, isLlmuxUp, type LlmuxStatus } from '../../../auth/llmux-client';
import { type AuthMode, config } from '../../../config';
import { Logger } from '../../../logger';
import { getTokenManager } from '../../../token-manager';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import {
  type AuthCardViewerMode,
  buildAuthCardBlocks,
  buildAuthModeHeaderBlocks,
  buildAuthNavigationBlocks,
} from '../../auth/builder';
import { AUTH_ACTION_IDS } from '../../auth/views';
import { renderCctCard } from './cct-topic';

const logger = new Logger('AuthTopic');

/**
 * Legacy (ccp) embed: CCT slot rows per wrapper page. 8 mirrors the llmux
 * card's PAGE_SIZE and bounds the worst-case composed card at 42 blocks
 * (see the ccp branch of `renderAuthCard`) — comfortably under Slack's
 * 50-block hard cap with one slot reserved for the action-result banner.
 */
const CCP_SLOT_PAGE_SIZE = 8;

/**
 * Render the `auth` card.
 *
 *   - llmux mode: fetch `/llmux/status` (short timeout) and render the pool.
 *     Unreachable llmux renders the card with a ❌ banner instead of failing.
 *   - ccp mode: render the mode header, then append the existing CCT card
 *     (which itself is viewer-mode aware, #803) plus the shared auth
 *     navigation. The direct `cct` command path is untouched.
 *
 * Viewer-mode authorization (T3 #auth-capacity-overview):
 *   - DEFAULT (no `viewerMode`) is the READONLY overview for everyone —
 *     admins included. The admin surface is opt-in via the [Admin mode]
 *     nav button (`viewerMode:'admin'`).
 *   - `viewerMode:'admin'` is honored ONLY when `isAdminUser(userId)` —
 *     encoded card state is untrusted input, so a forged/stale admin
 *     stamp from a non-admin demotes to readonly.
 *   - `canManage` (= `isAdminUser(userId)`) is passed to the builder so
 *     the readonly overview can show the single [Admin mode] button (and
 *     the admin card its [Overview] return) without ever widening the
 *     rendered mode itself.
 */
export async function renderAuthCard(args: {
  userId: string;
  issuedAt: number;
  viewerMode?: AuthCardViewerMode;
  page?: number;
  /** Explicit Refresh fetches legacy usage non-force, independently of management UI. */
  refreshUsage?: boolean;
}): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const canManage = isAdminUser(userId);
  const viewerMode: AuthCardViewerMode = args.viewerMode === 'admin' && canManage ? 'admin' : 'readonly';
  const page = args.page ?? 0;
  const runtime = getAuthRuntimeSnapshot();

  if (runtime.mode === 'llmux') {
    let llmuxStatus: LlmuxStatus | null = null;
    let llmuxError: string | undefined;
    try {
      llmuxStatus = await fetchLlmuxStatus();
    } catch (err) {
      llmuxError = (err as Error).message;
      logger.warn(`renderAuthCard: llmux status fetch failed: ${llmuxError}`);
    }
    const blocks = buildAuthCardBlocks({
      runtime,
      llmuxStatus,
      llmuxError,
      viewerMode,
      nowMs: Date.now(),
      canManage,
      page,
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: AUTH_ACTION_IDS.cancel,
          text: { type: 'plain_text', text: '❌ 취소' },
          style: 'danger',
          value: 'cancel',
        },
      ],
    });
    return {
      text: `🔐 Auth: llmux (${llmuxStatus ? `${llmuxStatus.accounts.length} slots, current: ${llmuxStatus.current ?? 'none'}` : 'unreachable'})`,
      blocks,
    };
  }

  // ccp (legacy cct) mode — mode header + the existing CCT card below.
  // The EFFECTIVE viewer mode (post-authorization) is passed through so a
  // forged admin stamp cannot widen the embedded CCT card either, and the
  // shared auth navigation (refresh / viewer toggle / paging) is appended
  // after the CCT blocks so `auth` keeps one navigation surface in both
  // runtime modes. The direct `cct` command path does not go through here.
  //
  // Block budget: legacy slots are PAGINATED through the wrapper's page
  // state (`embed` input on renderCctCard) — never block-truncated. Worst
  // case per page: wrapper header 3 (admin) + divider 1 + builder chrome
  // 2 + 8 slots × 4 + page context 1 + hidden-api_key context 1 + cancel
  // 1 + nav 1 = 42 blocks, ≤ 49 with the action-banner slot reserved.
  // The embed render also drops the CCT card-level [Refresh] — its
  // handler would re-render the BARE cct card and wipe this wrapper; the
  // nav's own Refresh re-renders the full composition instead.
  const headerBlocks = buildAuthModeHeaderBlocks(runtime, viewerMode);
  // Preserve the legacy readonly refresh contract without exposing management
  // controls or bypassing the token manager's per-account fetch throttle.
  if (args.refreshUsage) {
    let cached = false;
    try {
      const readings = Object.values(
        await getTokenManager().fetchUsageForAllAttached({ timeoutMs: config.usage.cardOpenTimeoutMs }),
      );
      cached = readings.length > 0 && readings.every((reading) => reading === null);
    } catch (err) {
      logger.warn('auth usage refresh failed; rendering cached snapshot', { error: (err as Error).name });
      cached = true;
    }
    if (cached)
      headerBlocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':warning: Cached usage · refresh limited or failed (5-minute throttle).' }],
      });
  }
  const cctCard = await renderCctCard({
    userId,
    issuedAt,
    viewerMode,
    skipOnOpenFetch: args.refreshUsage,
    embed: { page, pageSize: CCP_SLOT_PAGE_SIZE },
  });
  const slotPage = cctCard.embedSlotPage ?? page;
  const slotPageCount = cctCard.embedSlotPageCount ?? 1;
  return {
    text: `🔐 Auth: cct (legacy) — ${cctCard.text ?? ''}`,
    blocks: [
      ...headerBlocks,
      { type: 'divider' },
      ...cctCard.blocks,
      ...buildAuthNavigationBlocks(viewerMode, canManage, slotPage, slotPageCount),
    ],
  };
}

/**
 * Flip the runtime auth mode (admin only). Guard rails:
 *   - switching TO llmux probes the proxy first and refuses when it is
 *     unreachable — an accidental flip must not brick every dispatch.
 *   - switching to ccp is always allowed (legacy path needs no probe; the
 *     CCT card itself shows slot health).
 */
export async function applyAuthMode(args: { userId: string; mode: AuthMode }): Promise<ApplyResult> {
  const { userId, mode } = args;
  if (!isAdminUser(userId)) {
    return { ok: false, summary: '🚫 Admin only: auth 모드는 관리자만 변경할 수 있습니다.' };
  }
  const runtime = getAuthRuntimeSnapshot();
  if (runtime.mode === mode) {
    return { ok: true, summary: `이미 *${mode === 'llmux' ? 'llmux' : 'cct (legacy)'}* 모드입니다.` };
  }
  if (mode === 'llmux') {
    const up = await isLlmuxUp(runtime.llmux.baseUrl);
    if (!up) {
      return {
        ok: false,
        summary: `❌ llmux가 \`${runtime.llmux.baseUrl}\` 에서 응답하지 않습니다 — 모드 전환을 거부합니다.`,
        description: 'llmux를 먼저 띄우거나 (`llmux serve`), 카드의 ⚙️ Settings에서 base URL을 고친 뒤 다시 시도하세요.',
      };
    }
  }
  setAuthMode(mode);
  return {
    ok: true,
    summary: `🔐 Auth mode → *${mode === 'llmux' ? 'llmux' : 'cct (legacy)'}*`,
    description: '다음 dispatch부터 적용됩니다 (재시작 불필요, `data/auth-runtime.json`에 영속).',
  };
}

export function createAuthTopicBinding(): ZTopicBinding {
  return {
    topic: 'auth',
    apply: async (args) => {
      const mode = args.value === 'llmux' ? 'llmux' : args.value === 'ccp' || args.value === 'cct' ? 'ccp' : null;
      if (!mode) return { ok: false, summary: `❌ Unknown auth mode: \`${args.value}\` (expected llmux|cct)` };
      return applyAuthMode({ userId: args.userId, mode });
    },
    renderCard: (args) => renderAuthCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
