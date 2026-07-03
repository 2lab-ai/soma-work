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
import type { AuthMode } from '../../../config';
import { Logger } from '../../../logger';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { type AuthCardViewerMode, buildAuthCardBlocks, buildAuthModeHeaderBlocks } from '../../auth/builder';
import { AUTH_ACTION_IDS } from '../../auth/views';
import { renderCctCard } from './cct-topic';

const logger = new Logger('AuthTopic');

/**
 * Render the `auth` card.
 *
 *   - llmux mode: fetch `/llmux/status` (short timeout) and render the pool.
 *     Unreachable llmux renders the card with a ❌ banner instead of failing.
 *   - ccp mode: render the mode header, then append the existing CCT card
 *     (which itself is viewer-mode aware, #803).
 */
export async function renderAuthCard(args: {
  userId: string;
  issuedAt: number;
  viewerMode?: AuthCardViewerMode;
}): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const viewerMode: AuthCardViewerMode = args.viewerMode ?? (isAdminUser(userId) ? 'admin' : 'readonly');
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
  const headerBlocks = buildAuthModeHeaderBlocks(runtime, viewerMode);
  const cctCard = await renderCctCard({ userId, issuedAt });
  return {
    text: `🔐 Auth: cct (legacy) — ${cctCard.text ?? ''}`,
    blocks: [...headerBlocks, { type: 'divider' }, ...cctCard.blocks],
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
