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
  CCT_CARD_BLOCK_ID_PREFIX,
  CCT_VIEW_IDS,
  OAUTH_BLOB_HELP,
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

/** Narrow alphabet for the usage-bar label. */
export type UsageWindowLabel = '5h' | '7d' | '7d-sonnet';

/** Full window duration per label (ms). Used to scale the remaining-bar. */
const WINDOW_DURATION_MS: Record<UsageWindowLabel, number> = {
  '5h': 5 * 3_600_000,
  '7d': 7 * 86_400_000,
  '7d-sonnet': 7 * 86_400_000,
};

/** Right-padded label per type — mirrors the earlier `padUsageLabel(label)`. */
const LABEL_PADDED: Record<UsageWindowLabel, string> = {
  '5h': '5h'.padEnd(USAGE_LABEL_WIDTH),
  '7d': '7d'.padEnd(USAGE_LABEL_WIDTH),
  '7d-sonnet': '7d-sonnet'.padEnd(USAGE_LABEL_WIDTH),
};

/**
 * Integer percent (0..100) from the Anthropic utilization wire format.
 *
 * #701 — Anthropic's `/api/oauth/usage` endpoint passes through raw
 * integer percent (0..100+). The pre-#701 implementation split on
 * `util <= 1` to paper over a legacy "0..1 fraction" form, but the split
 * has an irreducible ambiguity at `util === 1` (is it 1% or 100%?). With
 * the server pinned to percent form the dual-form is dead weight AND
 * actively buggy: server value `1` (= 1%) rendered as `100%` AND tripped
 * `isUtilizationFull` the moment the 7d window hit a single percent.
 *
 * Percent-only interpretation — `Math.round(clamp(util, 0..100))`. Tests
 * that historically passed fractional inputs (0.82, 0.5, etc.) have been
 * migrated to percent form to match what the real server sends.
 */
function utilToPctInt(util: number | undefined): number {
  if (util === undefined || !Number.isFinite(util)) return 0;
  return Math.max(0, Math.min(100, Math.round(util)));
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
 * Map remaining cooldown ms → Slack color emoji per option-A spec
 * (PR #672 follow-up). Boundaries are inclusive on the upper edge:
 *   ≤ 1h   → yellow
 *   ≤ 5h   → orange
 *   ≤ 24h  → purple
 *   > 24h  → red
 */
function cooldownColor(remainingMs: number): string {
  const HOUR = 3_600_000;
  if (remainingMs <= HOUR) return ':large_yellow_circle:';
  if (remainingMs <= 5 * HOUR) return ':large_orange_circle:';
  if (remainingMs <= 24 * HOUR) return ':large_purple_circle:';
  return ':red_circle:';
}

/**
 * Shared progress-bar formatter — used by the CCT card usage panel and the
 * `/cct usage` text output. Keeping the format centralised guarantees both
 * surfaces evolve together.
 *
 * Layout (card v2 follow-up — dual bar):
 *   `<padded_label> <utilization-bar> <pct>% · <remaining-bar> resets in Xh Ym`
 *   `<padded_label> (no data)` — sentinel form when `util` is undefined.
 *
 * The remaining-bar is scaled against the window duration (`WINDOW_DURATION_MS`)
 * so a 7d window with 3d left is a 3/7 ≈ 43% bar, and a 5h window with 30m
 * left is a 30/300 = 10% bar. This gives operators a visual hint of how
 * much of the window has elapsed alongside the raw duration.
 *
 * The legacy `· expires in X` suffix was removed in this commit — the new
 * remaining-bar conveys the same information more compactly.
 */
export function formatUsageBar(
  util: number | undefined,
  resetsAtIso: string | undefined,
  nowMs: number,
  label: UsageWindowLabel,
): string {
  const padded = LABEL_PADDED[label];
  if (util === undefined || !Number.isFinite(util) || !resetsAtIso) {
    return `${padded} (no data)`;
  }
  const pct = utilToPctInt(util);
  const filled = Math.max(0, Math.min(PROGRESS_BAR_CELLS, Math.round((pct / 100) * PROGRESS_BAR_CELLS)));
  const utilBar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_CELLS - filled);
  const resetMs = new Date(resetsAtIso).getTime();
  const windowMs = WINDOW_DURATION_MS[label];
  let remainingBar: string;
  let hint: string;
  if (!Number.isFinite(resetMs)) {
    // Unparseable reset timestamp — show a dotted placeholder so the column
    // layout is preserved and hint to "<1m".
    remainingBar = '·'.repeat(PROGRESS_BAR_CELLS);
    hint = '<1m';
  } else {
    const remainingMs = Math.max(0, resetMs - nowMs);
    const rFilled = Math.max(
      0,
      Math.min(PROGRESS_BAR_CELLS, Math.round((remainingMs / windowMs) * PROGRESS_BAR_CELLS)),
    );
    remainingBar = '█'.repeat(rFilled) + '░'.repeat(PROGRESS_BAR_CELLS - rFilled);
    hint = formatUsageResetDelta(remainingMs);
  }
  return `${padded} ${utilBar} ${pct}% · ${remainingBar} resets in ${hint}`;
}

/**
 * Format a raw `rate_limit_tier` string for display. Card v2 (#668
 * follow-up): the profile endpoint gives us `default_claude_max_20x` etc;
 * the card shows a human-friendly label and falls through to the raw
 * string for unknown values so ops can still diagnose.
 *
 * `api_key` slots always surface as `API` (no subscription concept).
 */
export function formatRateLimitTier(raw: string | undefined, kind: 'cct' | 'api_key'): string | null {
  if (kind === 'api_key') return 'API';
  if (!raw) return null;
  switch (raw) {
    case 'default_claude_max_20x':
      return 'Max 20×';
    case 'default_claude_max_5x':
      return 'Max 5×';
    case 'default_claude_pro':
      return 'Pro';
    case 'default_claude_max':
      return 'Max';
    // Retain compatibility with the earlier `subscriptionType` vocabulary
    // (max_5x / max_20x / pro) — those were already surfaced in the head
    // line before the profile endpoint landed.
    case 'max_5x':
      return 'Max 5×';
    case 'max_20x':
      return 'Max 20×';
    case 'pro':
      return 'Pro';
    default:
      return raw;
  }
}

/**
 * Subscription-tier badge appended to the head line of a CCT slot row.
 * Returns ` · Max 5×` / ` · Max 20×` / ` · Pro` / `` — the leading ` · `
 * is always included when there is a badge so the head line reads as a
 * dot-separated list without the caller having to concatenate separators.
 *
 * Source priority (card v2):
 *   1. oauthAttachment.profile.rateLimitTier (from /api/oauth/profile)
 *   2. oauthAttachment.rateLimitTier         (from the refresh response)
 *   3. oauthAttachment.subscriptionType      (legacy, pre-profile field)
 *
 * `api_key` slots and CCT slots without any of the three fields produce
 * the empty-string sentinel so the badge is simply absent.
 */
export function subscriptionBadge(slot: AuthKey): string {
  if (!isCctSlot(slot)) return '';
  const attachment = slot.oauthAttachment;
  if (!attachment) return '';
  const raw = attachment.profile?.rateLimitTier ?? attachment.rateLimitTier ?? attachment.subscriptionType ?? undefined;
  const formatted = formatRateLimitTier(raw, 'cct');
  return formatted ? ` · ${formatted}` : '';
}

/**
 * Truncate a string to `max` chars. When longer, keeps the head/tail and
 * drops an ellipsis in the middle so the local-part and domain stay
 * readable (e.g. `alice.long...@example.com`).
 */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  // Reserve 3 chars for the ellipsis; split remaining budget 60/40 so the
  // local-part (left) keeps more characters than the domain.
  const head = Math.max(1, Math.floor((max - 3) * 0.6));
  const tail = Math.max(1, max - 3 - head);
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}

/**
 * Format the profile email for the head-line suffix. Returns `` when
 * the attachment has no profile or the profile has no email.
 *
 * Truncates at 40 chars (middle-ellipsis) so the head line stays within
 * Slack's sensible mrkdwn width on narrow clients.
 */
function emailSuffix(slot: AuthKey): string {
  if (!isCctSlot(slot)) return '';
  const email = slot.oauthAttachment?.profile?.email;
  if (!email) return '';
  return ` · ${truncateMiddle(email, 40)}`;
}

/**
 * Stale-usage threshold for prepending a `:warning:` glyph to the
 * `fetched <ago>` suffix. Anything ≤ 10 min is "fresh enough"; beyond
 * that the operator should treat the render with some skepticism.
 */
const USAGE_STALE_WARN_MS = 10 * 60 * 1000;

/**
 * Build the three usage-panel rows (5h / 7d / 7d-sonnet) as a single
 * context block. Returns `null` when the slot has no usage data — callers
 * simply skip the panel in that case (no placeholder rendered).
 *
 * #701 additions (no new blocks, all in-panel):
 *   - trailing `fetched <ago>` suffix on the final row so operators can
 *     tell fresh snapshots from hours-old stale ones. `:warning:` glyph
 *     prepends when the snapshot is older than {@link USAGE_STALE_WARN_MS}.
 *   - when `state.lastRefreshError` is present alongside a snapshot, a
 *     single dim warning line is prepended INSIDE the same context block
 *     (above the code fence) — the per-slot block count stays at 1, so
 *     the existing 50-block budget math at `buildCctCardBlocks` is
 *     unaffected.
 */
function buildUsagePanelBlock(usage: UsageSnapshot, nowMs: number, keyId: string, state?: SlotState): ZBlock | null {
  const rows: string[] = [];
  if (usage.fiveHour) {
    rows.push(formatUsageBar(usage.fiveHour.utilization, usage.fiveHour.resetsAt, nowMs, '5h'));
  }
  if (usage.sevenDay) {
    rows.push(formatUsageBar(usage.sevenDay.utilization, usage.sevenDay.resetsAt, nowMs, '7d'));
  }
  // Card v2 (#668 follow-up): hide the 7d-sonnet row when utilization is 0
  // (or absent). Most slots never touch Sonnet, so a flat `░░░░░░░░░░ 0%`
  // row is line noise — drop it rather than pad the panel with it.
  if (usage.sevenDaySonnet && usage.sevenDaySonnet.utilization > 0) {
    rows.push(formatUsageBar(usage.sevenDaySonnet.utilization, usage.sevenDaySonnet.resetsAt, nowMs, '7d-sonnet'));
  }
  if (rows.length === 0) return null;

  // #701 — append `fetched <ago>` suffix to the final row. One suffix per
  // panel (the snapshot is atomic; all windows share fetchedAt). Gracefully
  // skip if fetchedAt is missing/unparseable — the rest of the panel still
  // renders.
  const fetchedAtMs = Date.parse(usage.fetchedAt);
  if (Number.isFinite(fetchedAtMs)) {
    const ageMs = Math.max(0, nowMs - fetchedAtMs);
    const ago = formatUsageResetDelta(ageMs);
    const glyph = ageMs > USAGE_STALE_WARN_MS ? ':warning: ' : '';
    rows[rows.length - 1] = `${rows[rows.length - 1]} · ${glyph}fetched ${ago} ago`;
  }

  // #701 — when refresh is currently failing AND a (likely stale) usage
  // snapshot exists, prepend an in-panel warning line inside the SAME
  // context block. This is critical to the block-budget invariant: the
  // staleness warning must not add a new block.
  let staleHeader = '';
  if (
    state?.lastRefreshError &&
    typeof state?.lastRefreshFailedAt === 'number' &&
    Number.isFinite(state.lastRefreshFailedAt)
  ) {
    const failedAgo = formatUsageResetDelta(nowMs - state.lastRefreshFailedAt);
    staleHeader = `:warning: _Usage is stale — last refresh failed ${failedAgo} ago._\n`;
  }

  // Wrap in a code fence so Slack preserves the monospace alignment that
  // the padded labels rely on. `block_id` is prefixed so the overflow
  // guard can identify usage panels by id rather than by text content.
  const text = `${staleHeader}\`\`\`\n${rows.join('\n')}\n\`\`\``;
  return {
    type: 'context',
    block_id: `${CCT_CARD_BLOCK_ID_PREFIX.usagePanel}${keyId}`,
    elements: [{ type: 'mrkdwn', text }],
  };
}

/**
 * Cooldown trigger — the reason a slot is currently parked. Priority order
 * `7d > 5h > manual` is the user-facing intent: "biggest bucket first".
 * Callers surface only the highest-priority trigger on the badge; the
 * `rate-limited via <source>` segment still carries the source separately.
 */
export type CooldownSource = 'seven_day' | 'five_hour' | 'manual';

export interface CooldownInfo {
  /** True when any trigger fires. False ⇒ healthy cooldown-free slot. */
  inCooldown: boolean;
  /**
   * ms until the cooldown expires. Clamped at ≥0 — a past `resetsAt` renders
   * as "0s" rather than negative-duration garbage. Only meaningful when
   * `inCooldown` is true.
   */
  remainingMs: number;
  source: CooldownSource | null;
}

/**
 * True when a usage window is at or over its budget.
 *
 * #701 — Anthropic's `/api/oauth/usage` endpoint sends raw integer percent.
 * The pre-#701 implementation kept a dual-form escape hatch with `> 1.5`
 * as the fraction/percent split, but the boundary was irreducibly
 * ambiguous at `util === 1` (interpreted as 100% fraction form → Full).
 * Server value `1` (= 1%) therefore falsely tripped the 7d Cooldown badge.
 *
 * Percent-only interpretation now agrees with {@link utilToPctInt}: full
 * means `util >= 100`. Sibling helper
 * `normalizeUtilizationToPercent` in `src/slack/pipeline/stream-executor.ts`
 * was updated in the same PR for consistency.
 */
function isUtilizationFull(util: number | undefined): boolean {
  if (util === undefined || !Number.isFinite(util)) return false;
  return util >= 100;
}

/**
 * OAuth-slot cooldown — utilization-first, with `cooldownUntil` as a
 * lower-priority fallback. Priority: 7d full > 5h full >
 * cooldownUntil(future) > healthy.
 *
 * "Full" is evaluated by {@link isUtilizationFull}, which handles both the
 * legacy 0..1 fraction form and the 0..100 percent form the real API sends.
 *
 * Why we honor `cooldownUntil` for OAuth slots (Codex P1 follow-up #679):
 * the Anthropic utilization snapshot is the SSOT for an OAuth slot's
 * BUDGET, but the SDK 429 → `cooldownUntil` bookkeeping is still consulted
 * by the runtime picker (`TokenManager.isEligible` / `rotateOnRateLimit` /
 * `recordRateLimitHint`). When the SDK 429s an OAuth slot before
 * utilization crosses the full threshold (or before the snapshot is
 * refreshed), the picker rejects it but the card was rendering "Healthy" —
 * silent UX bug where the Activate button became a no-op. By falling
 * through to `cooldownUntil` after the utilization checks miss, the card
 * matches the picker's reality without disturbing the utilization-first
 * ordering.
 *
 * The `manual` source intentionally renders as a bare "Cooldown <dur>"
 * label (no 5h/7d marker) — the SDK 429 doesn't disclose which window
 * triggered it, so guessing would be misleading.
 */
function computeUsageCooldown(state: SlotState | undefined, nowMs: number): CooldownInfo {
  if (!state) return { inCooldown: false, remainingMs: 0, source: null };
  const sevenDay = state.usage?.sevenDay;
  if (sevenDay && isUtilizationFull(sevenDay.utilization)) {
    const resets = new Date(sevenDay.resetsAt).getTime();
    const remaining = Number.isFinite(resets) ? Math.max(0, resets - nowMs) : 0;
    return { inCooldown: true, remainingMs: remaining, source: 'seven_day' };
  }
  const fiveHour = state.usage?.fiveHour;
  if (fiveHour && isUtilizationFull(fiveHour.utilization)) {
    const resets = new Date(fiveHour.resetsAt).getTime();
    const remaining = Number.isFinite(resets) ? Math.max(0, resets - nowMs) : 0;
    return { inCooldown: true, remainingMs: remaining, source: 'five_hour' };
  }
  // Codex P1 follow-up (#679): SDK 429 → state.cooldownUntil is still
  // honored by the runtime picker (isEligible/rotateOnRateLimit). When
  // the utilization snapshot is stale or 429 lands before utilization
  // crosses ≥1, the OAuth card MUST surface this so UI matches picker.
  if (state.cooldownUntil) {
    const until = new Date(state.cooldownUntil).getTime();
    if (Number.isFinite(until) && until > nowMs) {
      return { inCooldown: true, remainingMs: until - nowMs, source: 'manual' };
    }
  }
  return { inCooldown: false, remainingMs: 0, source: null };
}

/**
 * Non-OAuth slot cooldown — `state.cooldownUntil` only. This is the SDK
 * 429-derived reset time and is the SSOT for slots that don't have an
 * OAuth profile (api_key slots and bare setup-only slots).
 */
function computeManualCooldown(state: SlotState | undefined, nowMs: number): CooldownInfo {
  if (!state?.cooldownUntil) return { inCooldown: false, remainingMs: 0, source: null };
  const until = new Date(state.cooldownUntil).getTime();
  if (Number.isFinite(until) && until > nowMs) {
    return { inCooldown: true, remainingMs: until - nowMs, source: 'manual' };
  }
  return { inCooldown: false, remainingMs: 0, source: null };
}

/**
 * Render the leading status badge per option-A spec (PR #672 follow-up):
 *   - refresh_failed | revoked       → :black_circle: Unavailable
 *   - healthy + no cooldown          → :large_green_circle: Healthy
 *   - healthy + 7d cooldown          → :{color}: 7d Cooldown <dur>
 *   - healthy + 5h cooldown          → :{color}: 5h Cooldown <dur>
 *   - healthy + manual cooldown      → :{color}: Cooldown <dur>
 *   (5h/7d label suppressed for manual since it is not budget-window-tied.)
 *
 * Color is determined by `cooldownColor(remainingMs)`.
 */
function authStateBadge(authState: AuthState, cooldown: CooldownInfo): string {
  if (authState !== 'healthy') return ':black_circle: Unavailable';
  if (!cooldown.inCooldown) return ':large_green_circle: Healthy';
  const color = cooldownColor(cooldown.remainingMs);
  let sourceLabel: string;
  if (cooldown.source === 'seven_day') sourceLabel = '7d Cooldown';
  else if (cooldown.source === 'five_hour') sourceLabel = '5h Cooldown';
  else sourceLabel = 'Cooldown';
  return `${color} ${sourceLabel} ${formatUsageResetDelta(cooldown.remainingMs)}`;
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
 * Emoji glyph for a refresh-error kind. Rate-limited uses the hourglass
 * because it is a "come back later" signal rather than a user error;
 * network / timeout use the satellite-antenna because the upstream is
 * unreachable. Everything else uses the generic warning glyph.
 */
function refreshErrorGlyph(kind: string): string {
  if (kind === 'rate_limited') return ':hourglass:';
  if (kind === 'network' || kind === 'timeout') return ':satellite_antenna:';
  return ':warning:';
}

/**
 * Format the `lastRefreshError` diagnostic as a single concatenatable
 * segment for `buildSlotStatusLine` (#701).
 *
 * The `message` comes from the `TokenManager.classifyRefreshError` fixed-
 * template table — never from raw `err.message` or response bodies — so
 * rendering it here is the only place an operator sees the short reason.
 * `consecutiveRefreshFailures >= 2` appends a ` · ×N` streak badge so a
 * slot stuck in retry loops is visually distinguishable from a single blip.
 */
function formatRefreshErrorSegment(state: SlotState | undefined, nowMs: number): string | null {
  const err = state?.lastRefreshError;
  if (!err) return null;
  const ago =
    typeof state?.lastRefreshFailedAt === 'number' && Number.isFinite(state.lastRefreshFailedAt)
      ? ` (${formatUsageResetDelta(nowMs - state.lastRefreshFailedAt)} ago)`
      : '';
  const glyph = refreshErrorGlyph(err.kind);
  const streak =
    state?.consecutiveRefreshFailures !== undefined && state.consecutiveRefreshFailures >= 2
      ? ` · ×${state.consecutiveRefreshFailures}`
      : '';
  return `${glyph} ${err.message}${ago}${streak}`;
}

/**
 * Format the `rateLimitedAt` / `rateLimitSource` pair as a
 * `rate-limited <ts> via <source>` segment. Returns null when the state
 * has no `rateLimitedAt` — caller can unconditionally push `?? []`.
 * Source suffix is omitted for legacy payloads that predate
 * `rateLimitSource` (raw enum matches the TokenManager classifier, same
 * shape both branches of `buildSlotStatusLine` emit).
 */
function formatRateLimitedSegment(state: SlotState | undefined, userTz: string, nowMs: number): string | null {
  if (!state?.rateLimitedAt) return null;
  const ts = formatRateLimitedAt(state.rateLimitedAt, userTz, nowMs);
  const source = state.rateLimitSource ? ` via ${state.rateLimitSource}` : '';
  return `rate-limited ${ts}${source}`;
}

/**
 * Build the second-line status segment per option-A spec
 * (PR #672 follow-up).
 *
 * OAuth-attached slots: badge + OAuth refresh hint ONLY. The SDK
 * utilization snapshot is the SSOT — operator-facing noise like
 * `active`, `rate-limited`, `tombstoned`, `:lock: rotation-off`, and
 * `leases:` is suppressed for OAuth slots. Operators inspect those via
 * dashboards / CLI.
 *
 * Non-OAuth slots (api_key or bare setup-only): cooldownUntil is the
 * SSOT, and the historical operator signals stay visible since there is
 * no other surface for them.
 */
function buildSlotStatusLine(
  slot: AuthKey,
  state: SlotState | undefined,
  isActive: boolean,
  nowMs: number,
  userTz: string,
): string {
  const segments: string[] = [];

  if (isCctSlot(slot) && slot.oauthAttachment !== undefined) {
    const authState = state?.authState ?? 'healthy';
    const cooldown = computeUsageCooldown(state, nowMs);
    segments.push(authStateBadge(authState, cooldown));
    // #723 +B: rate-limit source context for the OAuth bare 'Cooldown' badge.
    // 5h/7d cooldowns self-explain (the badge names the window); only the
    // manual source (SDK 429 → cooldownUntil) needs this context. Gated on
    // healthy so the Unavailable branch below isn't mixed with two reasons.
    if (authState === 'healthy' && cooldown.source === 'manual') {
      const rlSeg = formatRateLimitedSegment(state, userTz, nowMs);
      if (rlSeg) segments.push(rlSeg);
    }
    // Skip OAuth refresh hint when the slot is Unavailable (refresh_failed /
    // revoked) — OAuth refresh is no longer meaningful for a broken slot, so
    // the hint is pure noise. Per option-A SSOT: TO-BE-3 = `:black_circle:
    // Unavailable` only, no trailing segment.
    if (authState === 'healthy') {
      const hint = formatOAuthExpiryHint(slot.oauthAttachment.expiresAtMs, nowMs);
      if (hint) segments.push(hint);
    }
    // #701 — surface the most recent refresh failure regardless of
    // authState. For `healthy` slots this attaches context to "why is
    // usage stale?"; for `refresh_failed` / `revoked` slots it replaces
    // the empty right-hand side with an actual reason the operator can
    // read (the refresh hint above is suppressed for non-healthy states).
    const refreshErrSeg = formatRefreshErrorSegment(state, nowMs);
    if (refreshErrSeg) segments.push(refreshErrSeg);
    // #723 +D: when formatRefreshErrorSegment returns nothing (no
    // `lastRefreshError` on file — e.g. direct ops mutation, or an
    // upgrade that landed before the diagnostic was written back),
    // give the bare Unavailable badge a canned reason so the card is
    // self-explanatory. Skipped when refreshErrSeg already supplies
    // richer context (no double-up).
    if (authState !== 'healthy' && !refreshErrSeg) {
      segments.push(authState === 'revoked' ? ':warning: OAuth revoked' : ':warning: OAuth refresh failed');
    }
  } else {
    const cooldown = computeManualCooldown(state, nowMs);
    segments.push(authStateBadge(state?.authState ?? 'healthy', cooldown));
    if (isActive) segments.push('active');
    if (slot.disableRotation) segments.push(':lock: rotation-off');
    const rlSeg = formatRateLimitedSegment(state, userTz, nowMs);
    if (rlSeg) segments.push(rlSeg);
    if (state?.tombstoned) segments.push(':wastebasket: tombstoned (drain in progress)');
    if (state && state.activeLeases.length > 0) segments.push(`leases: ${state.activeLeases.length}`);
  }
  return segments.join(' · ');
}

/**
 * Render a single slot row.
 *
 * Layout (subscription tier + 5h/7d/OAuth expiry for EVERY slot):
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
  const line1 = [
    ':key:',
    `*${escapeMrkdwn(slot.name)}*`,
    displayKindTag(slot),
    subscriptionBadge(slot),
    emailSuffix(slot),
    tosBadge(slot),
  ]
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
  //   2. Attach or Detach OAuth — only for setup-source cct slots.
  //   3. Remove — always, last (danger).
  //
  // Per-slot Refresh / Rename buttons were removed in the card v2
  // follow-up: Refresh is now a card-level fan-out
  // (`CCT_ACTION_IDS.refresh_card`), and Rename was unused in practice.
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
    const panel = buildUsagePanelBlock(state.usage, nowMs, slot.keyId, state);
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
 * Card v2 (#668 follow-up): lowered from 48 → 47 to reserve one extra
 * slot for the cct-topic.ts trailer chrome (legacy set-active action row
 * + cancel button + store-read banner) that lands AFTER this helper
 * returns. Kept at 47 in the PR #672 follow-up after the budget footer
 * was removed, so the trailer reservation is unchanged.
 */
const SLACK_BLOCK_SOFT_CAP = 47;

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
    if ((blocks[i] as { type?: string }).type === 'divider') blocks.splice(i, 1);
  }
  if (blocks.length <= SLACK_BLOCK_SOFT_CAP) return blocks;
  // Phase 2: strip usage-context blocks. Matches on the stable
  // `CCT_CARD_BLOCK_ID_PREFIX.usagePanel` prefix stamped by
  // `buildUsagePanelBlock` — resilient to future formatting changes in
  // the panel body (e.g. dropping the code fence).
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks.length <= SLACK_BLOCK_SOFT_CAP) break;
    const b = blocks[i] as { type?: string; block_id?: string };
    if (b.type !== 'context') continue;
    if (typeof b.block_id === 'string' && b.block_id.startsWith(CCT_CARD_BLOCK_ID_PREFIX.usagePanel)) {
      blocks.splice(i, 1);
    }
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

  // Card-level action row: Next rotate / Add / Refresh All OAuth Tokens. Per-slot
  // [Activate] / [Remove] / [Attach|Detach] live on each slot row (see
  // `buildSlotRow`). The per-slot inline [Activate] button is the only
  // activation affordance; the legacy `set_active` fallback dropdown was
  // dropped in the card v2 follow-up.
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
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh All OAuth Tokens', emoji: true },
      value: 'refresh_all',
    },
    {
      type: 'button',
      action_id: CCT_ACTION_IDS.refresh_card,
      text: { type: 'plain_text', text: ':arrows_counterclockwise: Refresh', emoji: true },
      value: 'refresh_card',
    },
  ];
  blocks.push({ type: 'actions', elements: actionElements });

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
export function escapeMrkdwn(text: string): string {
  return text.replace(/[*_`]/g, (ch) => `\\${ch}`);
}
