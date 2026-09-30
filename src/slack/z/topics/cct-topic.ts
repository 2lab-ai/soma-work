/**
 * `/z cct` Block Kit topic — Wave 4 overhaul (#569).
 *
 * The card now surfaces the per-slot rate-limit timestamp, usage
 * utilisation, the ConsumerTosBadge for oauth_credentials slots, plus an
 * Add/Remove/Rename action row driven by `src/slack/cct/builder.ts`. The
 * text `/z cct set <name>` and `/z cct next` grammars remain wired
 * through `applyCct` for back-compat.
 *
 * Add/Remove/Rename now open modals — handlers live in
 * `src/slack/cct/actions.ts` and are registered on the shared Bolt app.
 */

import { isAdminUser } from '../../../admin-utils';
import type { AuthKey, CctStoreSnapshot } from '../../../cct-store';
import { config } from '../../../config';
import { Logger } from '../../../logger';
import { getTokenManager, type TokenSummary } from '../../../token-manager';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { decodeCctActionValue, encodeCctActionValue } from '../../cct/action-value';
import { encodeAuthOriginPayload } from '../../cct/auth-origin';
import { appendStoreReadFailureBanner, buildCctCardBlocks, type CctCardViewerMode } from '../../cct/builder';
import { CCT_ACTION_IDS } from '../../cct/views';
import type { ZBlock } from '../types';

const logger = new Logger('CctTopic');

/**
 * Compositional input for an EMBEDDING wrapper (the `auth` card in ccp
 * mode, T3 #auth-capacity-overview follow-up). Absent → direct `cct`
 * rendering, unchanged.
 *
 * When present:
 *   - slot rows are WINDOWED to `page`/`pageSize` (slot pagination, not
 *     block truncation — every slot stays reachable via the wrapper's
 *     paging nav; out-of-range pages clamp to the last page).
 *   - the card-level [Refresh] (`cct_refresh_card`) is removed: its
 *     handler re-renders the BARE CCT card in place, which would wipe
 *     the wrapper (header / admin toggle / nav). The wrapper's own
 *     Refresh re-renders the full composition instead. All other legacy
 *     controls (Activate / Add / Remove / Attach / Detach / Next rotate /
 *     Refresh-All-OAuth) are kept as-is.
 */
export interface CctCardEmbed {
  /** Requested 0-based slot page; clamped into [0, pageCount-1]. */
  page: number;
  /** Slot rows per page (>= 1). */
  pageSize: number;
}

/**
 * Remove the card-level Refresh control for embedded rendering. Only the
 * card-level actions row carries `cct_refresh_card` (per-slot Refresh was
 * removed in card v2); an actions block left empty is dropped entirely —
 * Slack rejects actions blocks with zero elements (readonly cards have a
 * refresh-only row).
 */
function stripCardLevelRefresh(blocks: ZBlock[]): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as { type?: string; elements?: Array<{ action_id?: string }> };
    if (block.type !== 'actions' || !Array.isArray(block.elements)) continue;
    const kept = block.elements.filter((el) => el.action_id !== CCT_ACTION_IDS.refresh_card);
    if (kept.length === block.elements.length) continue;
    if (kept.length === 0) blocks.splice(i, 1);
    else block.elements = kept;
  }
}

/**
 * Stamp the auth-origin page onto every `cm:`-tagged button value of an
 * embedded card: `cm:<mode>|<inner>` → `cm:<mode>|ao:<page>|<inner>`.
 * Mutation handlers in `cct/actions.ts` peel the marker and re-render
 * the AUTH WRAPPER (at that page) instead of the bare CCT card, so the
 * admin toggle / pagination survive mutations. Non-tagged values (the
 * cancel button, auth nav JSON) are untouched, and direct cards never
 * pass through here.
 */
function stampAuthOriginOnActionValues(blocks: ZBlock[], page: number): void {
  for (const block of blocks) {
    const b = block as { type?: string; elements?: Array<{ value?: unknown }> };
    if (b.type !== 'actions' || !Array.isArray(b.elements)) continue;
    for (const el of b.elements) {
      const decoded = decodeCctActionValue(el.value);
      if (decoded.kind !== 'tagged') continue;
      el.value = encodeCctActionValue({
        mode: decoded.mode,
        payload: encodeAuthOriginPayload(page, decoded.payload),
      });
    }
  }
}

/**
 * Pull the latest `CctStoreSnapshot` via the public `getSnapshot()` API so
 * we can hand full `SlotState`s to the builder. Wrapped in try/catch to
 * preserve defensive behaviour — a broken store must not brick the card.
 *
 * `loadFailed` is true when `getSnapshot()` threw; callers surface this in
 * a banner so operators notice the empty card is not "no slots configured"
 * but a silent store-read failure (see #644 review P3).
 */
async function loadSnapshotOrEmpty(): Promise<{
  slots: AuthKey[];
  states: Record<string, NonNullable<CctStoreSnapshot['state'][string]>>;
  activeKeyId?: string;
  loadFailed?: boolean;
}> {
  try {
    const snap = await getTokenManager().getSnapshot();
    return {
      slots: snap.registry.slots,
      states: snap.state,
      activeKeyId: snap.registry.activeKeyId,
    };
  } catch (err) {
    logger.warn(`loadSnapshotOrEmpty: getSnapshot failed — rendering empty card: ${(err as Error).message}`);
    return { slots: [], states: {}, loadFailed: true };
  }
}

/**
 * Render the `/cct` Block Kit card.
 *
 * Render-mode rules:
 *   - Pass an explicit `viewerMode` → use it verbatim. This is the
 *     "preserve cardMode across viewers" path (#803 spec Q1=A) — used
 *     by action handlers that decode the originating button's
 *     `cm:<mode>|<payload>` value and want re-rendering to keep that
 *     mode regardless of who clicked.
 *   - Otherwise → derive from `isAdminUser(userId)` (admin↔'admin',
 *     non-admin↔'readonly').
 *
 * Side effects:
 *   - Admin viewer (effective mode = 'admin') triggers the on-open
 *     `fetchUsageForAllAttached` fan-out so the card reflects fresh
 *     usage on every open (Z1 contract).
 *   - Readonly viewer SKIPS the fetch fan-out — live refetch is an
 *     admin-only mutation against the Anthropic API; non-admin viewers
 *     see the latest cached snapshot only.
 *   - `skipOnOpenFetch: true` → caller has already performed the
 *     relevant fetch (e.g. the `refresh_card` action handler) and
 *     wants the card render to read snapshot only. Avoids double
 *     fan-out against Anthropic on the same click.
 */
export async function renderCctCard(args: {
  userId: string;
  issuedAt: number;
  viewerMode?: CctCardViewerMode;
  skipOnOpenFetch?: boolean;
  /** Embedding-wrapper composition (auth ccp card). Absent = direct card, unchanged. */
  embed?: CctCardEmbed;
}): Promise<RenderResult & { embedSlotPage?: number; embedSlotPageCount?: number }> {
  const { userId, viewerMode: viewerModeOverride, skipOnOpenFetch, embed } = args;
  const effectiveViewerMode: CctCardViewerMode = viewerModeOverride ?? (isAdminUser(userId) ? 'admin' : 'readonly');

  // Admin viewer triggers the on-open fan-out unless the caller has
  // already settled the usage refresh.
  if (effectiveViewerMode === 'admin' && !skipOnOpenFetch) {
    try {
      await getTokenManager()
        .fetchUsageForAllAttached({ timeoutMs: config.usage.cardOpenTimeoutMs })
        .catch((err: unknown) => {
          logger.debug(`fetchUsageForAllAttached: ignored error on card open: ${(err as Error)?.message ?? err}`);
        });
    } catch (err) {
      // Defensive: a non-async throw from the getTokenManager() accessor must
      // not brick card rendering.
      logger.debug(`fetchUsageForAllAttached accessor threw: ${(err as Error)?.message ?? err}`);
    }
  }

  const { slots, states, activeKeyId, loadFailed } = await loadSnapshotOrEmpty();
  // Z3 runtime fence — phase1 renders CCT slots only; api_key slots are
  // store-only in PR-B and are hidden from the card row list + legacy
  // set-active buttons. A `context` line below surfaces the hidden count
  // so operators can still see the api_key slots exist.
  const visibleSlots = slots.filter((s) => s.kind === 'cct');
  const hiddenApiKeyCount = slots.length - visibleSlots.length;

  // ── Embed slot pagination (auth ccp wrapper, T3 follow-up) ─────────
  // Window the SLOTS, never the built blocks: every legacy slot stays
  // reachable through the wrapper's paging nav, and the builder's own
  // overflow trimmer never needs to fire for a page-sized window.
  let renderSlots = visibleSlots;
  let embedSlotPage: number | undefined;
  let embedSlotPageCount: number | undefined;
  if (embed) {
    const pageSize = Math.max(1, Math.floor(embed.pageSize));
    embedSlotPageCount = Math.max(1, Math.ceil(visibleSlots.length / pageSize));
    // Stale cards may carry an out-of-range page (slots removed since
    // render) — clamp to the last page instead of rendering empty.
    embedSlotPage = Math.min(embedSlotPageCount - 1, Math.max(0, Math.floor(embed.page) || 0));
    renderSlots = visibleSlots.slice(embedSlotPage * pageSize, (embedSlotPage + 1) * pageSize);
  }

  const blocks = buildCctCardBlocks({
    slots: renderSlots,
    states,
    activeKeyId,
    nowMs: Date.now(),
    viewerMode: effectiveViewerMode,
  });

  if (embed) {
    stripCardLevelRefresh(blocks);
    stampAuthOriginOnActionValues(blocks, embedSlotPage ?? 0);
    if ((embedSlotPageCount ?? 1) > 1) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${visibleSlots.length} slot(s) · ${(embedSlotPage ?? 0) + 1}/${embedSlotPageCount} 페이지`,
          },
        ],
      });
    }
  }

  // #644 review P3 — surface store-read failures as a visible warning
  // banner instead of an indistinguishable-from-empty card. Operators
  // relying on the card to see slot health should notice a store outage
  // immediately; logs alone are not enough. Shared wording with the
  // `buildCardFromManager` fallback path via `appendStoreReadFailureBanner`
  // (see #644 review 4146267530 Finding #6).
  if (loadFailed) {
    appendStoreReadFailureBanner(blocks);
  }

  if (hiddenApiKeyCount > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${hiddenApiKeyCount} api_key slots hidden (phase1: add-only, use is follow-up)`,
        },
      ],
    });
  }

  // Always include the cancel/dismiss button for the ZSettings pipeline.
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'z_setting_cct_cancel',
        text: { type: 'plain_text', text: '❌ 취소' },
        style: 'danger',
        value: 'cancel',
      },
    ],
  });

  const active = visibleSlots.find((s) => s.keyId === activeKeyId);
  return {
    text: `🔑 CCT (active: ${active?.name ?? 'none'})`,
    blocks,
    ...(embed ? { embedSlotPage, embedSlotPageCount } : {}),
  };
}

export async function applyCct(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  if (!isAdminUser(userId)) {
    return { ok: false, summary: '🚫 Admin only: CCT는 관리자만 변경할 수 있습니다.' };
  }
  const tm = getTokenManager();
  // Z3 runtime fence (Codex P0 fix #2): text-command `/z cct set <name>` and
  // `next` must not target api_key slots — phase1 treats api_key as add-only.
  // Mirrors the fence in cct-handler.ts (listRuntimeSelectableTokens) and
  // the render-side filter in `renderCctCard` so every user-facing path
  // agrees about what's selectable.
  const tokens = tm.listRuntimeSelectableTokens();
  if (tokens.length === 0) {
    return { ok: false, summary: '⚠️ No CCT tokens configured.' };
  }

  if (value === 'next') {
    const rotated = await tm.rotateToNext();
    if (!rotated) {
      return { ok: false, summary: '⚠️ 하나의 토큰만 있어 rotate할 수 없습니다.' };
    }
    const active = tm.getActiveToken();
    return {
      ok: true,
      summary: `🔄 Rotated → *${active?.name ?? rotated.name}*`,
      description: `kind: \`${active?.kind ?? 'cct'}\``,
    };
  }
  // Support both the new bare-name form (`value = t.name`) emitted by Block
  // Kit buttons and the legacy `set_<name>` form used by `/z cct set <name>`
  // text invocations, so the same handler serves both paths.
  const setMatch = value.match(/^set_(.+)$/);
  const target = setMatch ? setMatch[1] : value;
  const match = tokens.find((t: TokenSummary) => t.name === target);
  if (!match) {
    const available = tokens.map((t: TokenSummary) => `\`${t.name}\``).join(', ');
    return {
      ok: false,
      summary: `❌ Unknown token: \`${target}\``,
      description: `Available: ${available}`,
    };
  }
  await tm.applyToken(match.keyId);
  const active = tm.getActiveToken();
  return {
    ok: true,
    summary: `🔑 Active → *${active?.name ?? match.name}*`,
    description: `kind: \`${active?.kind ?? match.kind}\``,
  };
}

export function createCctTopicBinding(): ZTopicBinding {
  return {
    topic: 'cct',
    apply: (args) => applyCct({ userId: args.userId, value: args.value }),
    // #803 — `viewerMode` is decided by `renderCctCard` from
    // `isAdminUser(userId)` when not explicitly overridden by an
    // action-handler caller. The /z dispatcher does not know which
    // mode to render in, so we let renderCctCard derive it.
    renderCard: (args) => renderCctCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
