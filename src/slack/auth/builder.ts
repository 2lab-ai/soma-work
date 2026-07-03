/**
 * `auth` Block Kit card builder (#llmux runtime switch).
 *
 * Layout (llmux mode):
 *   ┌ 🔐 Auth — header + current mode
 *   ├ actions: [llmux] [cct (legacy)] mode buttons        (admin only)
 *   ├ context: llmux server line (version · uptime · port, or ❌ unreachable)
 *   ├ context: settings line (base URL · masked key) + ⚙️ Edit  (admin only)
 *   ├ per-account section: status emoji + name + usage bars (5h/7d)
 *   │   admin: [Switch] [Remove] accessory / readonly: bars only, name masked
 *   └ actions: [➕ Add account] [🔄 Refresh]               (Add = admin only)
 *
 * Layout (ccp/cct mode): header + mode buttons + hint; the caller appends
 * the existing CCT card blocks below (see `renderAuthCard` in
 * `src/slack/z/topics/auth-topic.ts`).
 *
 * Non-admin ("readonly") rules (#goal req 4):
 *   - account names are NEVER shown (llmux names embed emails) — rows render
 *     as `slot N (kind)`.
 *   - no mutating buttons (mode switch / settings / switch / add / remove).
 *   - slot count + per-slot usage remain visible.
 */

import type { AuthRuntimeState } from '../../auth/auth-runtime';
import type { LlmuxAccount, LlmuxStatus } from '../../auth/llmux-client';
import { formatUsageBar } from '../cct/builder';
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
  nowMs: number;
}

/** Mask a secret for display: last 4 chars only (`••••ocal`). */
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return '••••';
  return `••••${secret.slice(-4)}`;
}

/**
 * Mask an llmux account name for readonly viewers. llmux names commonly
 * embed emails (`claude:foo@bar.com`) and the readonly contract is "no
 * emails, ever" — so readonly rows use the positional label instead of a
 * masked transform (masking still leaks length/shape).
 */
export function readonlySlotLabel(account: LlmuxAccount): string {
  return `slot ${account.order} (${account.type})`;
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

/** llmux `/llmux/status` windows are 0..1 ratios; card bars take 0..100 percent + ISO reset. */
function llmuxWindowBar(
  window: { utilization: number; resets_at: number } | null | undefined,
  label: '5h' | '7d',
  nowMs: number,
): string {
  if (!window) return formatUsageBar(undefined, undefined, nowMs, label);
  return formatUsageBar(window.utilization * 100, new Date(window.resets_at * 1000).toISOString(), nowMs, label);
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
  const name = viewerMode === 'admin' ? account.name : readonlySlotLabel(account);
  const emoji = statusEmoji(account.status);
  const badges: string[] = [account.type];
  if (account.group && account.group !== 'claude') badges.push(account.group);
  if (isActive) badges.push('active');
  if (account.status === 'cooldown') badges.push('cooldown');
  if (account.status === 'auth_failed') badges.push('auth failed');
  if (account.blocked) badges.push(account.blocked);
  const bars = [llmuxWindowBar(account.five_hour, '5h', nowMs), llmuxWindowBar(account.seven_day, '7d', nowMs)].join(
    '\n',
  );
  const section: ZBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${emoji} *${name}* — ${badges.join(' · ')}\n\`\`\`\n${bars}\n\`\`\``,
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

/** Full auth card body for llmux mode (header included). */
export function buildAuthCardBlocks(input: AuthCardInput): ZBlock[] {
  const { runtime, llmuxStatus, llmuxError, viewerMode, nowMs } = input;
  const blocks = buildAuthModeHeaderBlocks(runtime, viewerMode);

  if (runtime.mode !== 'llmux') return blocks;

  // ── llmux server line ────────────────────────────────────────────
  if (llmuxStatus) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `llmux \`${llmuxStatus.version ?? '?'}\` · up ${formatUptime(llmuxStatus.uptime_secs)} · port ${llmuxStatus.port ?? '?'} · current: *${viewerMode === 'admin' ? (llmuxStatus.current ?? 'none') : llmuxStatus.current ? 'set' : 'none'}*`,
        },
      ],
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❌ *llmux unreachable* — ${llmuxError ?? 'no response'}\n_Start llmux locally (\`llmux serve\`) or fix the base URL below, then Refresh._`,
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
    for (const account of llmuxStatus.accounts) {
      blocks.push(...buildAccountBlocks(account, viewerMode, nowMs));
    }
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${llmuxStatus.accounts.length} slot(s)` }],
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
  footer.push({
    type: 'button',
    action_id: AUTH_ACTION_IDS.refresh,
    text: { type: 'plain_text', text: '🔄 Refresh', emoji: true },
    value: 'refresh',
  });
  blocks.push({ type: 'actions', elements: footer });
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
