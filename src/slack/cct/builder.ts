/**
 * Block Kit builders for the CCT card + modals (Wave 4, #569).
 *
 * All block_id / action_id values for modal inputs live in `./views.ts` so
 * that `views.update` (kind-radio flip) keeps the user's typed values
 * intact — Slack preserves `state.values` only when keys are stable.
 */

import type { AuthKey, AuthState, SlotState, UsageSnapshot } from '../../cct-store';
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

/**
 * Width of the Unicode progress bar used by `formatUsageBar`. Ten cells
 * gives 10-pp resolution, fits well within Slack mrkdwn width, and avoids
 * wrapping on narrow clients.
 */
const PROGRESS_BAR_CELLS = 10;

/**
 * Label column width — right-padded so three stacked rows (`5h`, `7d`,
 * `7d-sonnet`) line up under one another. Matches the longest supported
 * label (`7d-sonnet` = 9 chars).
 */
const USAGE_LABEL_WIDTH = 9;

/** Pad a short label to the fixed column width (right-pad with spaces). */
function padUsageLabel(label: string): string {
  if (label.length >= USAGE_LABEL_WIDTH) return label;
  return label + ' '.repeat(USAGE_LABEL_WIDTH - label.length);
}

/** Integer percent (0..100) from a 0..1 or 0..100 utilization number. */
function utilToPctInt(util: number | undefined): number {
  if (util === undefined || !Number.isFinite(util)) return 0;
  const scaled = util <= 1 ? util * 100 : util;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/**
 * "Xd Yh" / "Xh Ym" / "Ym" / "<1m" from a positive delta in ms. Switches to
 * day-granularity at the 24h boundary so a 7-day 7d-sonnet reset renders as
 * `7d 0h` instead of `168h 0m` (see #644 review).
 */
export function formatUsageResetDelta(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return '<1m';
  const totalMin = Math.floor(deltaMs / 60_000);
  if (totalMin < 1) return '<1m';
  const totalHours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (totalHours > 0) return `${totalHours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Shared progress-bar formatter — used by the CCT card usage panel and the
 * `/cct usage` text output. Keeping the format centralised guarantees both
 * surfaces evolve together (bar width, glyphs, "resets in" hint).
 *
 * Layout:
 *   `<padded_label> <bar> <pct>% · resets in Xh Ym`
 *   `<padded_label> (no data)` — sentinel form when `util` is undefined or
 *   the reset timestamp is missing.
 */
export function formatUsageBar(
  util: number | undefined,
  resetsAtIso: string | undefined,
  nowMs: number,
  label: string,
): string {
  const padded = padUsageLabel(label);
  if (util === undefined || !Number.isFinite(util) || !resetsAtIso) {
    return `${padded} (no data)`;
  }
  const pct = utilToPctInt(util);
  const filled = Math.max(0, Math.min(PROGRESS_BAR_CELLS, Math.round((pct / 100) * PROGRESS_BAR_CELLS)));
  const empty = PROGRESS_BAR_CELLS - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const resetMs = new Date(resetsAtIso).getTime();
  const delta = Number.isFinite(resetMs) ? resetMs - nowMs : NaN;
  const hint = Number.isFinite(delta) ? formatUsageResetDelta(delta) : '<1m';
  return `${padded} ${bar} ${pct}% · resets in ${hint}`;
}

/**
 * Subscription-tier badge appended to the head line of a CCT slot row.
 * Returns ` · Max 5x` / ` · Max 20x` / ` · Pro` / `` — the leading ` · `
 * is always included when there is a badge so the head line reads as a
 * dot-separated list without the caller having to concatenate separators.
 *
 * `api_key` slots and CCT slots without an attachment (or without a
 * `subscriptionType`) produce the empty-string sentinel so the badge is
 * simply absent.
 */
export function subscriptionBadge(slot: AuthKey): string {
  if (!isCctSlot(slot)) return '';
  const attachment = slot.oauthAttachment;
  if (!attachment || !attachment.subscriptionType) return '';
  return ` · ${formatSubscriptionType(attachment.subscriptionType)}`;
}

function formatSubscriptionType(raw: string): string {
  switch (raw) {
    case 'max_5x':
      return 'Max 5x';
    case 'max_20x':
      return 'Max 20x';
    case 'pro':
      return 'Pro';
    default:
      return raw;
  }
}

/**
 * Build the three usage-panel rows (5h / 7d / 7d-sonnet) as a single
 * context block. Returns `null` when the slot has no usage data — callers
 * simply skip the panel in that case (no placeholder rendered).
 */
function buildUsagePanelBlock(usage: UsageSnapshot, nowMs: number): ZBlock | null {
  const rows: string[] = [];
  if (usage.fiveHour) {
    rows.push(formatUsageBar(usage.fiveHour.utilization, usage.fiveHour.resetsAt, nowMs, '5h'));
  }
  if (usage.sevenDay) {
    rows.push(formatUsageBar(usage.sevenDay.utilization, usage.sevenDay.resetsAt, nowMs, '7d'));
  }
  if (usage.sevenDaySonnet) {
    rows.push(formatUsageBar(usage.sevenDaySonnet.utilization, usage.sevenDaySonnet.resetsAt, nowMs, '7d-sonnet'));
  }
  if (rows.length === 0) return null;
  // Wrap in a code fence so Slack preserves the monospace alignment that
  // the padded labels rely on.
  const text = '```\n' + rows.join('\n') + '\n```';
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
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
 * Format an absolute epoch-ms expiry delta as "OAuth refreshes in Xh Ym".
 * Delegates to `formatUsageResetDelta` for consistent formatting with the
 * usage-panel "resets in" hint. Negative delta (already expired) returns
 * the `:warning: expired` sentinel — we don't dress it up because the
 * operator needs to notice.
 */
function formatOAuthExpiryHint(expiresAtMs: number, nowMs: number): string {
  if (!Number.isFinite(expiresAtMs)) return '';
  const delta = expiresAtMs - nowMs;
  if (delta <= 0) return ':warning: OAuth expired';
  return `OAuth refreshes in ${formatUsageResetDelta(delta)}`;
}

/**
 * Build the status/meta line rendered directly under the name. Always
 * includes the authState badge (defaults to `healthy` when state is
 * absent). Optionally appends `active`, OAuth expiry hint, rate-limited
 * timestamp + source, cooldown-until, tombstoned flag, and live lease
 * count — only when the underlying field is truthy.
 *
 * The line is always emitted for every slot (even bare setup-only slots)
 * so every row carries the `healthy` / `refresh_failed` / `revoked`
 * badge per #653 M2 — no more active-only gating.
 */
function buildSlotStatusLine(
  slot: AuthKey,
  state: SlotState | undefined,
  isActive: boolean,
  nowMs: number,
  userTz: string,
): string {
  const segments: string[] = [];
  segments.push(authStateBadge(state?.authState ?? 'healthy'));
  if (isActive) segments.push('active');
  // OAuth expiry — only for CCT slots that carry an attachment. `api_key`
  // and bare setup slots have no OAuth to refresh so they're omitted.
  if (isCctSlot(slot) && slot.oauthAttachment !== undefined) {
    const hint = formatOAuthExpiryHint(slot.oauthAttachment.expiresAtMs, nowMs);
    if (hint) segments.push(hint);
  }
  if (state?.rateLimitedAt) {
    const ts = formatRateLimitedAt(state.rateLimitedAt, userTz, nowMs);
    const source = state.rateLimitSource ? ` via ${state.rateLimitSource}` : '';
    segments.push(`rate-limited ${ts}${source}`);
  }
  if (state?.cooldownUntil) {
    const untilMs = new Date(state.cooldownUntil).getTime();
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      segments.push(`cooldown until ${formatRateLimitedAt(state.cooldownUntil, userTz, nowMs).split(' / ')[0]}`);
    }
  }
  if (state?.tombstoned) segments.push(':wastebasket: tombstoned (drain in progress)');
  if (state && state.activeLeases.length > 0) segments.push(`leases: ${state.activeLeases.length}`);
  return segments.join(' · ');
}

/**
 * Render a single slot row.
 *
 * Layout (#653 M2 — subscription tier + 5h/7d/OAuth expiry for EVERY slot):
 *   1. section  — multi-line header: name+kind+tier+ToS-risk on line 1,
 *                  healthy/rate-limited/OAuth-expiry segments on line 2.
 *   2. actions  — per-slot buttons: Activate (if not active & not api_key),
 *                  Refresh (if attached), Attach|Detach OAuth (setup source),
 *                  Rename, Remove.
 *   3. context  — usage panel (5h/7d/7d-sonnet progress bars), only when
 *                  the slot is attached and has a persisted usage snapshot.
 *   4. divider  — stripped by `buildCctCardBlocks` when the total block
 *                  count would exceed Slack's 50-block hard cap.
 *
 * Block budget (Slack hard cap: 50 blocks total):
 *   rich attached slot   = section + actions + usage-context + divider = 4
 *   bare/api_key slot    = section + actions + divider                 = 3
 *   card chrome          = header + card-actions + set-active-actions  = 3
 *   typical fleet (≤11)  = 3 + 11*4 = 47  (under cap)
 *   worst case (15 rich) = 3 + 15*4 = 63  (`buildCctCardBlocks`
 *                          strips dividers, then drops usage-context if
 *                          still over)
 */
export function buildSlotRow(
  slot: AuthKey,
  state: SlotState | undefined,
  isActive: boolean,
  nowMs: number,
  userTz: string = 'Asia/Seoul',
): ZBlock[] {
  const blocks: ZBlock[] = [];
  // Line 1: identity (name · kind · tier · ToS-risk). Tier + active marker
  // are now emitted for EVERY slot — #653 M2 removes the prior isActive
  // gating so inactive rows carry the full signal (user specifically wants
  // tier + 5h + 7d always visible, not just on the currently-selected row).
  const line1 = [':key:', `*${escapeMrkdwn(slot.name)}*`, displayKindTag(slot), subscriptionBadge(slot), tosBadge(slot)]
    .filter(Boolean)
    .join(' ');
  // Line 2: live status (auth state + active flag + OAuth expiry +
  // rate-limited / cooldown). Always non-empty because `authStateBadge`
  // returns a badge even for an absent state.
  const line2 = buildSlotStatusLine(slot, state, isActive, nowMs, userTz);
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `${line1}\n${line2}` },
  });

  // Per-slot action row. Ordering by intent:
  //   1. Activate (primary, first) — only when slot is NOT active and
  //      NOT an api_key (api_key is store-only in phase 1).
  //   2. Refresh — only when the slot carries an OAuth attachment (the
  //      precondition for `/api/oauth/usage` AND the OAuth-token refresh
  //      endpoint). Force-refreshes BOTH the OAuth access_token AND the
  //      usage snapshot — the `Refresh` handler orchestrates both calls
  //      so the card reflects new expiresAtMs + new usage on the same
  //      click (see actions.ts cct_refresh_usage_slot).
  //   3. Attach or Detach OAuth — only for setup-source cct slots.
  //   4. Rename — always.
  //   5. Remove — always, last (danger).
  const actionElements: ZBlock[] = [];
  if (!isActive && slot.kind !== 'api_key') {
    actionElements.push({
      type: 'button',
      action_id: CCT_ACTION_IDS.activate_slot,
      style: 'primary',
      text: { type: 'plain_text', text: ':arrow_forward: Activate', emoji: true },
      value: slot.keyId,
    });
  }
  if (isCctSlot(slot) && slot.oauthAttachment !== undefined) {
    actionElements.push({
      type: 'button',
      action_id: CCT_ACTION_IDS.refresh_usage_slot,
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
      value: slot.keyId,
    });
  }
  if (isCctSlot(slot) && slot.source === 'setup') {
    if (slot.oauthAttachment === undefined) {
      actionElements.push({
        type: 'button',
        action_id: CCT_ACTION_IDS.attach,
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
  actionElements.push({
    type: 'button',
    action_id: CCT_ACTION_IDS.rename,
    text: { type: 'plain_text', text: ':pencil2: Rename', emoji: true },
    value: slot.keyId,
  });
  actionElements.push({
    type: 'button',
    action_id: CCT_ACTION_IDS.remove,
    style: 'danger',
    text: { type: 'plain_text', text: ':wastebasket: Remove', emoji: true },
    value: slot.keyId,
  });
  blocks.push({
    type: 'actions',
    elements: actionElements,
  });

  // Usage panel — only when the slot has a persisted usage snapshot. The
  // panel is emitted for EVERY attached slot (no longer isActive-gated);
  // the block-budget overflow guard in `buildCctCardBlocks` collapses
  // these first if the card would exceed Slack's 50-block cap.
  if (state?.usage && isCctSlot(slot) && slot.oauthAttachment !== undefined) {
    const panel = buildUsagePanelBlock(state.usage, nowMs);
    if (panel) blocks.push(panel);
  }

  return blocks;
}

/**
 * Shared store-read failure banner. Pushed onto a card so operators
 * distinguish a failed `getSnapshot()` fallback from an empty-slot card.
 * Both entry points (actions.ts fallback + cct-topic.ts loader) call
 * this helper to keep the wording identical across surfaces.
 */
export function appendStoreReadFailureBanner(blocks: ZBlock[]): void {
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: ':warning: *Store read failed* — card rendered empty as a fallback. Check the CctTopic logs for `loadSnapshotOrEmpty: getSnapshot failed` or `buildCardFromManager: getSnapshot failed`.',
      },
    ],
  });
}

/**
 * Safety margin under Slack's 50-block hard cap per message / ephemeral.
 * Stops the card assembly well short of the cap so adjacent banners
 * (store-read failure, api_key hidden context) still fit.
 */
const SLACK_BLOCK_SOFT_CAP = 48;

/**
 * Post-assembly overflow guard. Invoked only when the rich layout
 * (section + actions + usage-context + divider per slot) would push the
 * card over Slack's 50-block hard cap.
 *
 * Collapse order (least-to-most information-loss):
 *   1. strip all dividers  — visual-only, no signal lost
 *   2. drop usage-context  — usage panel still reachable via /cct usage
 *
 * Walks `blocks` in-place and returns the mutated reference for clarity.
 */
function trimBlocksToSlackCap(blocks: ZBlock[]): ZBlock[] {
  if (blocks.length <= SLACK_BLOCK_SOFT_CAP) return blocks;
  // Phase 1: strip dividers.
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks.length <= SLACK_BLOCK_SOFT_CAP) break;
    if ((blocks[i] as any).type === 'divider') blocks.splice(i, 1);
  }
  if (blocks.length <= SLACK_BLOCK_SOFT_CAP) return blocks;
  // Phase 2: strip usage-context blocks. Heuristic — a `context` block
  // whose mrkdwn element starts with a code fence is the usage panel
  // emitted by `buildUsagePanelBlock`.
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks.length <= SLACK_BLOCK_SOFT_CAP) break;
    const b = blocks[i] as any;
    if (b.type !== 'context') continue;
    const text = b.elements?.[0]?.text as string | undefined;
    if (typeof text === 'string' && text.startsWith('```')) blocks.splice(i, 1);
  }
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

  // Card-level action row: Next rotate / Add / Refresh all. Per-slot
  // [Activate] / [Refresh] / [Rename] / [Remove] / [Attach|Detach] live on
  // each slot row (see `buildSlotRow`). `set_active` is retained as a
  // fallback dropdown only when there are >1 slots, for screen-reader
  // accessibility and bulk-navigation (#653 M2: inline [Activate] button
  // is the primary affordance; dropdown is backup).
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
    {
      type: 'button',
      action_id: CCT_ACTION_IDS.refresh_usage_all,
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh all', emoji: true },
      value: 'refresh_all',
    },
  ];
  blocks.push({ type: 'actions', elements: actionElements });

  // Set-active selector (only when >1 slot). Kept as a fallback for large
  // fleets where the overflow guard may have dropped inline [Activate]
  // affordances along with their actions rows (defensive — today the
  // guard only strips dividers and usage-context blocks).
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

  // Apply the overflow guard AFTER chrome is added so dividers inside
  // slot rows (not chrome) are the first casualty.
  return trimBlocksToSlackCap(blocks);
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
