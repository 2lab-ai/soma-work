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
import { appendStoreReadFailureBanner, buildCctCardBlocks, type CctCardViewerMode } from '../../cct/builder';

const logger = new Logger('CctTopic');

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
 * #803 — Non-admin users now see the FULL slot status (mode='readonly')
 * with mutating affordances stripped. The `viewerMode` opt allows
 * action-handler callers (e.g. `refresh_card`) to override the
 * actor-derived default so a non-admin clicking Refresh on an admin
 * card preserves the admin layout instead of flipping it to readonly.
 *
 * Render-mode rules:
 *   - Pass an explicit `viewerMode` → use it verbatim. This is the
 *     "preserve cardMode across viewers" path (#803 spec Q1=A).
 *   - Otherwise → derive from `isAdminUser(userId)` (admin↔'admin',
 *     non-admin↔'readonly').
 *
 * Side effects:
 *   - Admin viewer (effective mode = 'admin') triggers the on-open
 *     `fetchUsageForAllAttached` fan-out so the card reflects fresh
 *     usage on every open. (Z1 contract — preserved.)
 *   - Readonly viewer (effective mode = 'readonly') SKIPS the fetch
 *     fan-out. Live refetch is an admin-only mutation against the
 *     Anthropic API; non-admin viewers see the latest cached snapshot
 *     ONLY (#803 spec Q2=B / Q3=A).
 */
export async function renderCctCard(args: {
  userId: string;
  issuedAt: number;
  viewerMode?: CctCardViewerMode;
}): Promise<RenderResult> {
  const { userId, viewerMode: viewerModeOverride } = args;
  const effectiveViewerMode: CctCardViewerMode = viewerModeOverride ?? (isAdminUser(userId) ? 'admin' : 'readonly');

  // #803 — On-open fetchUsage fan-out is admin-only. Readonly viewers
  // see whatever is already in the cached snapshot. The Refresh button
  // on the readonly card calls `fetchUsageForAllAttached` non-force,
  // which still respects the per-slot 5-minute throttle.
  if (effectiveViewerMode === 'admin') {
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
  const blocks = buildCctCardBlocks({
    slots: visibleSlots,
    states,
    activeKeyId,
    nowMs: Date.now(),
    viewerMode: effectiveViewerMode,
  });

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
  return { text: `🔑 CCT (active: ${active?.name ?? 'none'})`, blocks };
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
