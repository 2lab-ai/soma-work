/**
 * `auth` Block Kit card builder (#llmux runtime switch).
 *
 * Layout (llmux mode):
 *   ┌ 🔐 Auth — header + current mode
 *   ├ actions: [llmux] [cct (legacy)] mode buttons        (admin only)
 *   ├ context: llmux server line (version · uptime · port, or ❌ unreachable)
 *   ├ context: settings line (base URL · masked key) + ⚙️ Edit  (admin only)
 *   ├ provider summary: remaining by window, measurement coverage, next reset
 *   ├ paged accounts: remaining percent, local reset time, cooldown + usage
 *   │   explicit admin mode: [Switch] [Remove] / overview: read-only details
 *   └ navigation: [Refresh] [Previous/Next] [Admin mode/Overview]
 *       [Add account], settings and backend controls need explicit admin mode
 *
 * Layout (ccp/cct mode): header + mode buttons + hint; the caller appends
 * the existing CCT card blocks below (see `renderAuthCard` in
 * `src/slack/z/topics/auth-topic.ts`).
 *
 * Non-admin ("readonly") rules:
 *   - account identity is fully visible — names and the `current:` account
 *     render the same for every viewer (the CCT card behaves the same, #803).
 *     Non-admins must be able to tell WHICH account is burning the quota.
 *   - no mutating buttons (mode switch / settings / switch / add / remove).
 *   - the settings line stays admin-only: base URL + API key are infra
 *     secrets, not account info.
 */

import type { AuthRuntimeState } from '../../auth/auth-runtime';
import type { LlmuxAccount, LlmuxStatus } from '../../auth/llmux-client';
import { accountLines, authText, groupAccounts, groupSummary, providerName } from './capacity';

export { collectScopedWindows } from './capacity';

import type { ZBlock } from '../z/types';
import { AUTH_ACTION_IDS, AUTH_BLOCK_IDS, AUTH_VIEW_IDS } from './views';

export type AuthCardViewerMode = 'admin' | 'readonly';

export interface AuthCardInput {
  runtime: AuthRuntimeState;
  /** null when llmux is unreachable (or ccp mode where we skip the fetch). */
  llmuxStatus: LlmuxStatus | null;
  /** Reachability error detail shown when `llmuxStatus` is null in llmux mode. */
  llmuxError?: string;
  viewerMode: AuthCardViewerMode;
  canManage?: boolean;
  page?: number;
  nowMs: number;
}

/** Mask a secret for display: last 4 chars only (`••••ocal`). */
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return '••••';
  return `••••${secret.slice(-4)}`;
}

const STATUS_EMOJI: Record<string, string> = {
  active: '✅',
  ok: '·',
  cooldown: '🧊',
  auth_failed: '⛔',
};

function statusEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? '·';
}

function formatUptime(uptimeSecs: number | undefined): string {
  if (uptimeSecs === undefined) return '—';
  const h = Math.floor(uptimeSecs / 3600);
  const m = Math.floor((uptimeSecs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Header + mode-switch row shared by BOTH modes. */
export function buildAuthModeHeaderBlocks(runtime: AuthRuntimeState, viewerMode: AuthCardViewerMode): ZBlock[] {
  const modeLabel = runtime.mode === 'llmux' ? '🟢 llmux (proxy)' : '🔑 cct (legacy)';
  const blocks: ZBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔐 Auth', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Mode:* ${modeLabel}\n_llmux is the default backend; cct is legacy (direct OAuth token pool)._`,
      },
    },
  ];
  if (viewerMode === 'admin') {
    const buttonFor = (mode: 'llmux' | 'ccp', label: string): ZBlock => ({
      type: 'button',
      action_id: `${AUTH_ACTION_IDS.mode}_${mode}`,
      text: { type: 'plain_text', text: label, emoji: true },
      value: mode,
      ...(runtime.mode === mode ? { style: 'primary' } : {}),
    });
    blocks.push({
      type: 'actions',
      elements: [buttonFor('llmux', 'llmux'), buttonFor('ccp', 'cct (legacy)')],
    });
  }
  return blocks;
}

/** One llmux account section block (+ optional admin accessory). */
function buildAccountBlocks(account: LlmuxAccount, viewerMode: AuthCardViewerMode, nowMs: number): ZBlock[] {
  const isActive = account.status === 'active';
  // Account identity is viewer-independent — every viewer sees the real name.
  const name = authText(account.name);
  const emoji = statusEmoji(account.status);
  const badges: string[] = [authText(account.type)];
  if (isActive) badges.push('active');
  const details = accountLines(account, nowMs).join('\n');
  const section: ZBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: boundedText(`  ${emoji} *${name}* — ${badges.join(' · ')}\n${details}`),
    },
  };
  const blocks: ZBlock[] = [section];
  if (viewerMode === 'admin') {
    const elements: ZBlock[] = [];
    if (!isActive) {
      elements.push({
        type: 'button',
        action_id: AUTH_ACTION_IDS.switch,
        text: { type: 'plain_text', text: 'Switch', emoji: true },
        style: 'primary',
        value: account.name,
      });
    }
    elements.push({
      type: 'button',
      action_id: AUTH_ACTION_IDS.remove,
      text: { type: 'plain_text', text: 'Remove', emoji: true },
      style: 'danger',
      value: account.name,
    });
    blocks.push({ type: 'actions', elements });
  }
  return blocks;
}

/** Eight rows leave room for headers, admin controls and mutation banners. */
const PAGE_SIZE = 8;

function boundedText(text: string): string {
  return text.length <= 2900 ? text : `${text.slice(0, 2800)}\n… 상세 정보가 길어 일부 생략되었습니다.`;
}

export function buildAuthNavigationBlocks(
  viewerMode: AuthCardViewerMode,
  canManage: boolean,
  page = 0,
  pageCount = 1,
): ZBlock[] {
  const button = (id: string, label: string, mode: AuthCardViewerMode, targetPage: number): ZBlock => ({
    type: 'button',
    action_id: id,
    text: { type: 'plain_text', text: label },
    value: JSON.stringify({ viewerMode: mode, page: targetPage }),
  });
  const elements = [button(AUTH_ACTION_IDS.refresh, '🔄 Refresh', viewerMode, page)];
  if (page > 0) elements.push(button(`${AUTH_ACTION_IDS.page}_prev`, '← 이전', viewerMode, page - 1));
  if (page + 1 < pageCount) elements.push(button(`${AUTH_ACTION_IDS.page}_next`, '다음 →', viewerMode, page + 1));
  if (viewerMode === 'admin') elements.push(button(AUTH_ACTION_IDS.viewer, '일반 보기', 'readonly', page));
  else if (canManage) elements.push(button(AUTH_ACTION_IDS.viewer, '어드민 모드', 'admin', page));
  return [{ type: 'actions', elements }];
}

/** Full auth card body for llmux mode (header included). */
export function buildAuthCardBlocks(input: AuthCardInput): ZBlock[] {
  const { runtime, llmuxStatus, llmuxError, viewerMode, nowMs } = input;
  const pageCount = Math.max(1, Math.ceil((llmuxStatus?.accounts.length ?? 0) / PAGE_SIZE));
  const page = Math.max(0, Math.min(pageCount - 1, Number.isFinite(input.page) ? Math.floor(input.page ?? 0) : 0));
  const blocks = buildAuthModeHeaderBlocks(runtime, viewerMode);

  if (runtime.mode !== 'llmux') return blocks;

  // ── llmux server line ────────────────────────────────────────────
  if (llmuxStatus) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `llmux \`${llmuxStatus.version ?? '?'}\` · up ${formatUptime(llmuxStatus.uptime_secs)} · port ${llmuxStatus.port ?? '?'} · current: *${authText(llmuxStatus.current ?? 'none')}*`,
        },
      ],
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❌ *llmux unreachable* — ${viewerMode === 'admin' ? authText(llmuxError ?? 'no response') : '상태를 불러오지 못했습니다. 관리자에게 확인하세요.'}\n_Start llmux locally (\`llmux serve\`) or fix the base URL below, then Refresh._`,
      },
    });
  }

  // ── settings line (admin only — base URL may reveal infra) ──────
  if (viewerMode === 'admin') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Settings* — \`ANTHROPIC_BASE_URL\`: \`${runtime.llmux.baseUrl}\` · \`ANTHROPIC_API_KEY\`: \`${maskSecret(runtime.llmux.apiKey)}\``,
      },
      accessory: {
        type: 'button',
        action_id: AUTH_ACTION_IDS.settings,
        text: { type: 'plain_text', text: '⚙️ Edit', emoji: true },
        value: 'settings',
      },
    });
  }

  // ── accounts ─────────────────────────────────────────────────────
  if (llmuxStatus) {
    blocks.push({ type: 'divider' });
    if (llmuxStatus.accounts.length === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No accounts in the llmux pool. Add one below or via llmux TUI/islands._' },
      });
    }
    let offset = 0;
    for (const [group, accounts] of groupAccounts(llmuxStatus.accounts)) {
      const visible = accounts.slice(
        Math.max(0, page * PAGE_SIZE - offset),
        Math.max(0, (page + 1) * PAGE_SIZE - offset),
      );
      offset += accounts.length;
      // Keep the three requested provider summaries visible on every page;
      // unknown groups appear on their account page to bound the block count.
      if (!visible.length && !['claude', 'codex', 'grok'].includes(group)) continue;
      const current = llmuxStatus.current_by_group?.[group] ?? (group === 'claude' ? llmuxStatus.current : undefined);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: boundedText(
            `*${providerName(group)}* · ${accounts.length}계정${current ? ` · current: *${authText(current)}*` : ''}\n${groupSummary(accounts, nowMs).join('\n')}`,
          ),
        },
      });
      for (const account of visible)
        blocks.push(
          ...buildAccountBlocks(
            { ...account, status: current === account.name && account.status === 'ok' ? 'active' : account.status },
            viewerMode,
            nowMs,
          ),
        );
    }
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${llmuxStatus.accounts.length} slot(s) · ${page + 1}/${pageCount} 페이지 · 조회 <!date^${Math.floor(nowMs / 1000)}^{date_short_pretty} {time}|${new Date(nowMs).toISOString()}> · 공급자 측정 시각 미제공`,
        },
      ],
    });
  }

  // ── footer actions ──────────────────────────────────────────────
  const footer: ZBlock[] = [];
  if (viewerMode === 'admin') {
    footer.push({
      type: 'button',
      action_id: AUTH_ACTION_IDS.add,
      text: { type: 'plain_text', text: '➕ Add account', emoji: true },
      value: 'add',
    });
  }
  if (footer.length) blocks.push({ type: 'actions', elements: footer });
  blocks.push(...buildAuthNavigationBlocks(viewerMode, input.canManage ?? viewerMode === 'admin', page, pageCount));
  if (viewerMode === 'admin') {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '➕ adds an *API-key* account. OAuth (Pro/Max) accounts need a browser on the llmux host — use `llmux login` / islands.',
        },
      ],
    });
  }
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

/**
 * Settings modal — llmux base URL + API key. `private_metadata` carries the
 * originating card surface (`{channel, ts}` JSON) so the submit handler can
 * re-render the card in place.
 */
export function buildLlmuxSettingsModal(runtime: AuthRuntimeState, privateMetadata: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: AUTH_VIEW_IDS.settings,
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'llmux settings' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: AUTH_BLOCK_IDS.settings_base_url,
        label: { type: 'plain_text', text: 'ANTHROPIC_BASE_URL' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: runtime.llmux.baseUrl,
          placeholder: { type: 'plain_text', text: 'http://localhost:3456' },
        },
      },
      {
        type: 'input',
        block_id: AUTH_BLOCK_IDS.settings_api_key,
        optional: true,
        label: { type: 'plain_text', text: 'ANTHROPIC_API_KEY' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: `unchanged (${maskSecret(runtime.llmux.apiKey)})` },
        },
        hint: {
          type: 'plain_text',
          text: 'Leave blank to keep the current key. Loopback llmux ignores the value; remote llmux checks it against proxy.api_key.',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Applies to the *next* dispatch immediately (no restart) and persists across restarts (`data/auth-runtime.json`).',
          },
        ],
      },
    ],
  };
}

/** Add-account modal (llmux api-key account). */
export function buildLlmuxAddAccountModal(privateMetadata: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: AUTH_VIEW_IDS.add,
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Add llmux account' },
    submit: { type: 'plain_text', text: 'Add' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: AUTH_BLOCK_IDS.add_name,
        optional: true,
        label: { type: 'plain_text', text: 'Name' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'auto (api-N)' },
        },
      },
      {
        type: 'input',
        block_id: AUTH_BLOCK_IDS.add_api_key,
        label: { type: 'plain_text', text: 'Anthropic API key' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'sk-ant-api03-…' },
        },
        hint: {
          type: 'plain_text',
          text: 'Sent once to the local llmux daemon (POST /llmux/add-account); never stored by soma-work.',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'OAuth (Pro/Max) accounts require a browser on the llmux host — run `llmux login` there or use llmux-islands.',
          },
        ],
      },
    ],
  };
}

/** Remove-account confirm modal. `private_metadata` = JSON {channel, ts, name}. */
export function buildLlmuxRemoveAccountModal(name: string, privateMetadata: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: AUTH_VIEW_IDS.remove,
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Remove llmux account' },
    submit: { type: 'plain_text', text: 'Remove' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Remove *${name}* from the llmux pool?\nThis calls \`POST /llmux/remove-account\` with \`confirm:true\` — the credential is deleted from the llmux config file.`,
        },
      },
    ],
  };
}
