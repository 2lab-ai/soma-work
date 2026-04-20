/**
 * Block Kit builders for the CCT card + modals (Wave 4, #569).
 *
 * All block_id / action_id values for modal inputs live in `./views.ts` so
 * that `views.update` (kind-radio flip) keeps the user's typed values
 * intact — Slack preserves `state.values` only when keys are stable.
 */

import type { AuthKey, AuthState, SlotState } from '../../cct-store';
import { isCctSlot } from '../../cct-store';
import { formatRateLimitedAt } from '../../util/format-rate-limited-at';
import type { ZBlock } from '../z/types';
import {
  CCT_ACTION_IDS,
  CCT_BLOCK_IDS,
  CCT_VIEW_IDS,
  OAUTH_BLOB_HELP,
  OAUTH_BLOB_WARN_THRESHOLD,
  SLACK_PLAIN_TEXT_INPUT_MAX,
} from './views';

/** Shape used by the card renderer. */
export interface CctCardInput {
  slots: AuthKey[];
  /** Keyed by keyId. */
  states: Record<string, SlotState>;
  activeKeyId?: string;
  /** Default: `Date.now()`. Accepts an explicit "now" for stable snapshots. */
  nowMs?: number;
  /** IANA timezone for rate-limit timestamps. Default: Asia/Seoul. */
  userTz?: string;
}

/**
 * UI-facing "kind" for the Add-slot modal radio. Drives the conditional
 * form blocks — `setup_token` asks for a bare token string,
 * `oauth_credentials` asks for a claudeAiOauth blob + ToS ack, and
 * `api_key` (Z3) asks for a raw `sk-ant-api03-<chars>` commercial key.
 * These values are mapped to the v2 AuthKey arms by `cct/actions.ts` on
 * submit. The api_key arm is store-only in phase 1 — the TokenManager
 * fence prevents a rotation from landing on it.
 */
export type AddSlotFormKind = 'setup_token' | 'oauth_credentials' | 'api_key';

/**
 * UI kind label for a persisted AuthKey: used in the row header tag. CCT
 * slots carry an internal `source` distinction that drives the ToS badge.
 */
function displayKindTag(slot: AuthKey): string {
  if (slot.kind === 'api_key') return ' · api_key';
  return slot.source === 'setup' ? ' · cct/setup' : ' · cct/legacy-attachment';
}

/** ToS-risk badge — only for CCT slots with an OAuth attachment. */
function tosBadge(slot: AuthKey): string {
  if (!isCctSlot(slot)) return '';
  if (slot.source === 'legacy-attachment') return ' :warning: ToS-risk';
  return slot.oauthAttachment ? ' :warning: ToS-risk' : '';
}

/** Utility: format 0..1 or 0..100 utilization as a percent integer string. */
function toPct(utilization: number | undefined): string {
  if (utilization === undefined || !Number.isFinite(utilization)) return '0%';
  const scaled = utilization <= 1 ? utilization * 100 : utilization;
  return `${Math.round(scaled)}%`;
}

function authStateBadge(state: AuthState): string {
  switch (state) {
    case 'healthy':
      return ':large_green_circle: healthy';
    case 'refresh_failed':
      return ':large_yellow_circle: refresh_failed';
    case 'revoked':
      return ':red_circle: revoked';
    default: {
      // Exhaustiveness — unreachable under the AuthState union.
      const exhaustive: never = state;
      return String(exhaustive);
    }
  }
}

/**
 * Render a single slot row — one section block plus (when meta is
 * present) a context block with the rate-limit timestamp, usage, and
 * cooldown.
 */
export function buildSlotRow(
  slot: AuthKey,
  state: SlotState | undefined,
  isActive: boolean,
  nowMs: number,
  userTz: string = 'Asia/Seoul',
): ZBlock[] {
  const blocks: ZBlock[] = [];
  const headLine = [
    ':key:',
    `*${escapeMrkdwn(slot.name)}*`,
    isActive ? '· active' : '',
    displayKindTag(slot),
    tosBadge(slot),
  ]
    .filter(Boolean)
    .join(' ');

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: headLine },
  });

  // Context line — only when we have something meaningful.
  const segments: string[] = [];
  if (state) {
    segments.push(authStateBadge(state.authState));
    if (state.rateLimitedAt) {
      const ts = formatRateLimitedAt(state.rateLimitedAt, userTz, nowMs);
      const source = state.rateLimitSource ? ` via ${state.rateLimitSource}` : '';
      segments.push(`rate-limited ${ts}${source}`);
    }
    if (state.usage) {
      const u = state.usage;
      const parts: string[] = [];
      if (u.fiveHour) parts.push(`5h ${toPct(u.fiveHour.utilization)}`);
      if (u.sevenDay) parts.push(`7d ${toPct(u.sevenDay.utilization)}`);
      if (parts.length > 0) segments.push(`usage ${parts.join(' ')}`);
    }
    if (state.cooldownUntil) {
      const untilMs = new Date(state.cooldownUntil).getTime();
      if (Number.isFinite(untilMs) && untilMs > nowMs) {
        segments.push(`cooldown until ${formatRateLimitedAt(state.cooldownUntil, userTz, nowMs).split(' / ')[0]}`);
      }
    }
    if (state.tombstoned) {
      segments.push(':wastebasket: tombstoned (drain in progress)');
    }
    if (state.activeLeases.length > 0) {
      segments.push(`leases: ${state.activeLeases.length}`);
    }
  } else {
    segments.push(authStateBadge('healthy'));
  }
  if (segments.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: segments.join(' · ') }],
    });
  }

  // Per-slot action row: Remove / Rename + Z2 Attach-or-Detach for
  // setup-source cct slots (only that arm of the union can toggle an
  // oauthAttachment — legacy-attachment slots carry a mandatory one,
  // api_key has no attachment surface at all). The button `value` carries
  // the keyId so the open handler routes to the clicked slot.
  const actionElements: ZBlock[] = [
    {
      type: 'button',
      action_id: CCT_ACTION_IDS.remove,
      style: 'danger',
      text: { type: 'plain_text', text: ':wastebasket: Remove', emoji: true },
      value: slot.keyId,
    },
    {
      type: 'button',
      action_id: CCT_ACTION_IDS.rename,
      text: { type: 'plain_text', text: ':pencil2: Rename', emoji: true },
      value: slot.keyId,
    },
  ];
  if (isCctSlot(slot) && slot.source === 'setup') {
    if (slot.oauthAttachment === undefined) {
      actionElements.push({
        type: 'button',
        action_id: CCT_ACTION_IDS.attach,
        style: 'primary',
        text: { type: 'plain_text', text: ':link: Attach OAuth', emoji: true },
        value: slot.keyId,
      });
    } else {
      actionElements.push({
        type: 'button',
        action_id: CCT_ACTION_IDS.detach,
        text: { type: 'plain_text', text: ':unlock: Detach OAuth', emoji: true },
        value: slot.keyId,
      });
    }
  }
  blocks.push({
    type: 'actions',
    elements: actionElements,
  });

  return blocks;
}

/**
 * Build the full CCT card: header + per-slot rows + action row.
 */
export function buildCctCardBlocks(input: CctCardInput): ZBlock[] {
  const nowMs = input.nowMs ?? Date.now();
  const userTz = input.userTz ?? 'Asia/Seoul';
  const blocks: ZBlock[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':key: CCT Tokens', emoji: true },
  });

  if (input.slots.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No CCT slots configured. Click *Add* to create one, or set `CLAUDE_CODE_OAUTH_TOKEN_LIST`.',
      },
    });
  } else {
    for (const slot of input.slots) {
      const rowBlocks = buildSlotRow(slot, input.states[slot.keyId], slot.keyId === input.activeKeyId, nowMs, userTz);
      for (const b of rowBlocks) blocks.push(b);
      blocks.push({ type: 'divider' });
    }
  }

  // Card-level action row: Next / Add. Per-slot Remove/Rename buttons live
  // on each slot row (emitted by `buildSlotRow`) so they carry the correct
  // slotId via the button's `value`.
  const actionElements: ZBlock[] = [
    {
      type: 'button',
      action_id: CCT_ACTION_IDS.next,
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Next rotate', emoji: true },
      value: 'next',
    },
    {
      type: 'button',
      action_id: CCT_ACTION_IDS.add,
      style: 'primary',
      text: { type: 'plain_text', text: ':heavy_plus_sign: Add', emoji: true },
      value: 'add',
    },
  ];
  blocks.push({ type: 'actions', elements: actionElements });

  // Set-active selector (only when >1 slot).
  if (input.slots.length > 1) {
    const options = input.slots.map((s) => ({
      text: { type: 'plain_text', text: s.name, emoji: false },
      value: s.keyId,
    }));
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'static_select',
          action_id: CCT_ACTION_IDS.set_active,
          placeholder: { type: 'plain_text', text: 'Set active slot', emoji: true },
          options,
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
 * Modal: Add slot — split fields + type radio + conditional input blocks
 * + ConsumerTosBadge ack checkbox (oauth_credentials only).
 *
 * `selectedKind` controls which of the two conditional input blocks is
 * rendered. A `views.update` on the kind-radio action re-renders with
 * the same block_ids / action_ids so Slack preserves typed values.
 */
export function buildAddSlotModal(selectedKind: AddSlotFormKind = 'setup_token'): Record<string, unknown> {
  const blocks: ZBlock[] = [];

  // Name input
  blocks.push({
    type: 'input',
    block_id: CCT_BLOCK_IDS.add_name,
    label: { type: 'plain_text', text: 'Slot name', emoji: true },
    element: {
      type: 'plain_text_input',
      action_id: CCT_ACTION_IDS.name_input,
      max_length: 64,
      placeholder: { type: 'plain_text', text: 'e.g. cct1, team-shared, personal-max' },
    },
  });

  // Kind radio — dispatches on select so we can re-render conditional blocks.
  blocks.push({
    type: 'input',
    block_id: CCT_BLOCK_IDS.add_kind,
    label: { type: 'plain_text', text: 'Credential kind', emoji: true },
    dispatch_action: true,
    element: {
      type: 'radio_buttons',
      action_id: CCT_ACTION_IDS.kind_radio,
      initial_option: radioOption(selectedKind),
      options: [radioOption('setup_token'), radioOption('oauth_credentials'), radioOption('api_key')],
    },
  });

  if (selectedKind === 'api_key') {
    // Z3 — api_key: raw sk-ant-api03-<chars> commercial API key. Stored
    // only; TokenManager's runtime fence prevents it being selected as
    // active in phase 1 (applyToken/rotate/acquireLease reject it).
    blocks.push({
      type: 'input',
      block_id: CCT_BLOCK_IDS.add_api_key_value,
      label: { type: 'plain_text', text: 'Anthropic API key (sk-ant-api03-…)', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: CCT_ACTION_IDS.api_key_input,
        max_length: SLACK_PLAIN_TEXT_INPUT_MAX,
        placeholder: { type: 'plain_text', text: 'sk-ant-api03-…' },
      },
      hint: {
        type: 'plain_text',
        text: 'Store-only in phase 1 — api_key slots cannot be rotated onto yet.',
      },
    });
  } else if (selectedKind === 'setup_token') {
    blocks.push({
      type: 'input',
      block_id: CCT_BLOCK_IDS.add_setup_token_value,
      label: { type: 'plain_text', text: 'Setup token (sk-ant-oat01-…)', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: CCT_ACTION_IDS.setup_token_input,
        max_length: SLACK_PLAIN_TEXT_INPUT_MAX,
        placeholder: { type: 'plain_text', text: 'sk-ant-oat01-…' },
      },
      hint: {
        type: 'plain_text',
        text: 'Setup tokens follow the `sk-ant-oat01-<chars>` format.',
      },
    });
  } else {
    blocks.push({
      type: 'input',
      block_id: CCT_BLOCK_IDS.add_oauth_credentials_blob,
      label: { type: 'plain_text', text: 'OAuth credentials (JSON)', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: CCT_ACTION_IDS.oauth_blob_input,
        multiline: true,
        max_length: SLACK_PLAIN_TEXT_INPUT_MAX,
        placeholder: {
          type: 'plain_text',
          text: '{"claudeAiOauth":{"accessToken":"…","refreshToken":"…","expiresAt":…,"scopes":["user:profile"]}}',
        },
      },
      hint: { type: 'plain_text', text: OAUTH_BLOB_HELP },
    });
    // ConsumerTosBadge ack — required when kind = oauth_credentials.
    blocks.push({
      type: 'input',
      block_id: CCT_BLOCK_IDS.add_tos_ack,
      label: { type: 'plain_text', text: 'Consumer ToS acknowledgement', emoji: true },
      element: {
        type: 'checkboxes',
        action_id: CCT_ACTION_IDS.tos_ack,
        options: [
          {
            text: {
              type: 'plain_text',
              text: "I understand that using a consumer Claude subscription token for automated requests may violate Anthropic's Terms of Service.",
              emoji: false,
            },
            value: 'ack',
          },
        ],
      },
    });
  }

  return {
    type: 'modal',
    callback_id: CCT_VIEW_IDS.add,
    title: { type: 'plain_text', text: 'Add CCT slot', emoji: true },
    submit: { type: 'plain_text', text: 'Add', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    blocks,
  };
}

/** Modal: Confirm remove slot — warns when active leases present. */
export function buildRemoveSlotModal(slot: AuthKey, hasActiveLeases: boolean): Record<string, unknown> {
  const warning = hasActiveLeases
    ? ':warning: Slot has active leases; the slot will be *tombstoned* and removed once in-flight requests drain.'
    : 'This will remove the slot immediately.';
  const blocks: ZBlock[] = [
    {
      type: 'section',
      block_id: CCT_BLOCK_IDS.remove_confirm,
      text: {
        type: 'mrkdwn',
        text: `Remove slot *${escapeMrkdwn(slot.name)}*${displayKindTag(slot)}?\n${warning}`,
      },
    },
  ];
  return {
    type: 'modal',
    callback_id: CCT_VIEW_IDS.remove,
    title: { type: 'plain_text', text: 'Remove CCT slot', emoji: true },
    submit: { type: 'plain_text', text: 'Remove', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    // `private_metadata` carries the keyId through view_submission.
    private_metadata: slot.keyId,
    blocks,
  };
}

/**
 * Z2 — Modal: Attach OAuth credentials to an existing setup-source cct
 * slot. Mirrors the `oauth_credentials` arm of the Add modal but targets
 * an existing keyId (passed via `private_metadata`) instead of creating a
 * new slot. On submit, `actions.ts` calls `TokenManager.attachOAuth(keyId,
 * creds, true)` which re-validates scopes and persists the attachment
 * while keeping `source: 'setup'` untouched.
 */
export function buildAttachOAuthModal(slot: AuthKey): Record<string, unknown> {
  const blocks: ZBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Attach OAuth credentials to *${escapeMrkdwn(slot.name)}* (setup-source cct slot).`,
      },
    },
    {
      type: 'input',
      block_id: CCT_BLOCK_IDS.attach_oauth_blob,
      label: { type: 'plain_text', text: 'OAuth credentials (JSON)', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: CCT_ACTION_IDS.attach_oauth_input,
        multiline: true,
        max_length: SLACK_PLAIN_TEXT_INPUT_MAX,
        placeholder: {
          type: 'plain_text',
          text: '{"claudeAiOauth":{"accessToken":"…","refreshToken":"…","expiresAt":…,"scopes":["user:profile","user:inference"]}}',
        },
      },
      hint: { type: 'plain_text', text: OAUTH_BLOB_HELP },
    },
    {
      type: 'input',
      block_id: CCT_BLOCK_IDS.attach_tos_ack,
      label: { type: 'plain_text', text: 'Consumer ToS acknowledgement', emoji: true },
      element: {
        type: 'checkboxes',
        action_id: CCT_ACTION_IDS.attach_tos_ack,
        options: [
          {
            text: {
              type: 'plain_text',
              text: "I understand that using a consumer Claude subscription token for automated requests may violate Anthropic's Terms of Service.",
              emoji: false,
            },
            value: 'ack',
          },
        ],
      },
    },
  ];
  return {
    type: 'modal',
    callback_id: CCT_VIEW_IDS.attach,
    title: { type: 'plain_text', text: 'Attach OAuth', emoji: true },
    submit: { type: 'plain_text', text: 'Attach', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: slot.keyId,
    blocks,
  };
}

/** Modal: Rename slot. */
export function buildRenameSlotModal(slot: AuthKey): Record<string, unknown> {
  const blocks: ZBlock[] = [
    {
      type: 'input',
      block_id: CCT_BLOCK_IDS.rename_name,
      label: { type: 'plain_text', text: 'New name', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: CCT_ACTION_IDS.rename_input,
        max_length: 64,
        initial_value: slot.name,
      },
    },
  ];
  return {
    type: 'modal',
    callback_id: CCT_VIEW_IDS.rename,
    title: { type: 'plain_text', text: 'Rename CCT slot', emoji: true },
    submit: { type: 'plain_text', text: 'Rename', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: slot.keyId,
    blocks,
  };
}

function radioOption(kind: AddSlotFormKind): Record<string, unknown> {
  const labelMap: Record<AddSlotFormKind, string> = {
    setup_token: 'setup_token (sk-ant-oat01-…)',
    oauth_credentials: 'oauth_credentials (claudeAiOauth blob) :warning:',
    api_key: 'api_key (sk-ant-api03-…, store-only)',
  };
  return {
    text: { type: 'plain_text', text: labelMap[kind], emoji: true },
    value: kind,
  };
}

/** Minimal mrkdwn-safe escape: strips `*` and `_` that would close formatting. */
function escapeMrkdwn(text: string): string {
  return text.replace(/[*_`]/g, (ch) => `\\${ch}`);
}

// Re-export the warn threshold so actions.ts can trip on it if needed.
export { OAUTH_BLOB_WARN_THRESHOLD };
