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
import { Logger } from '../../../logger';
import { getTokenManager, type TokenSummary } from '../../../token-manager';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildCctCardBlocks } from '../../cct/builder';

const logger = new Logger('CctTopic');

/** Z1 — upper bound for usage fan-out on card open. Chosen so the card
 * still renders responsively (under Slack's 3s budget for ephemeral post)
 * even when one or two keys are slow or unreachable. The fan-out runs
 * allSettled internally, so the slowest key caps the wait here. */
const USAGE_ON_OPEN_TIMEOUT_MS = 1500;

/**
 * Pull the latest `CctStoreSnapshot` via the public `getSnapshot()` API so
 * we can hand full `SlotState`s to the builder. Wrapped in try/catch to
 * preserve defensive behaviour — a broken store must not brick the card.
 */
async function loadSnapshotOrEmpty(): Promise<{
  slots: AuthKey[];
  states: Record<string, NonNullable<CctStoreSnapshot['state'][string]>>;
  activeKeyId?: string;
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
    return { slots: [], states: {} };
  }
}

export async function renderCctCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId } = args;
  const admin = isAdminUser(userId);
  if (!admin) {
    return {
      text: '🚫 CCT (admin only)',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🔑 CCT Tokens', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🚫 *CCT Token — admin only*\nOnly administrators may view or change CCT tokens.',
          },
        },
        {
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
        },
      ],
    };
  }

  // Z1 — Card open fan-out: refresh usage for every CCT slot that
  // currently carries an OAuthAttachment so inactive slots don't render
  // with stale/empty usage. Await (not fire-and-forget) per plan §3.6 so
  // "한눈에" semantics hold; fall back to `.catch()` and whatever is in
  // the snapshot if the fan-out throws or hits the timeout.
  try {
    await getTokenManager()
      .fetchUsageForAllAttached({ timeoutMs: USAGE_ON_OPEN_TIMEOUT_MS })
      .catch((err: unknown) => {
        logger.debug(`fetchUsageForAllAttached: ignored error on card open: ${(err as Error)?.message ?? err}`);
      });
  } catch (err) {
    // Defensive: a non-async throw from the getTokenManager() accessor must
    // not brick card rendering.
    logger.debug(`fetchUsageForAllAttached accessor threw: ${(err as Error)?.message ?? err}`);
  }

  const { slots, states, activeKeyId } = await loadSnapshotOrEmpty();
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
  });

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

  // Back-compat: the text `/z cct` command still used legacy-named action
  // IDs from the shared ui-builder. We add them here so the existing
  // z-settings-actions router continues to resolve `set_<name>` / `next`.
  const legacyActions: Record<string, unknown>[] = visibleSlots.map((s) => ({
    type: 'button',
    action_id: `z_setting_cct_set_${s.name}`,
    text: { type: 'plain_text', text: `🔑 ${s.name}`, emoji: true },
    value: s.name,
  }));
  legacyActions.push({
    type: 'button',
    action_id: 'z_setting_cct_set_next',
    text: { type: 'plain_text', text: '🔄 Next (rotate)', emoji: true },
    value: 'next',
  });
  blocks.push({ type: 'actions', elements: legacyActions });

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
  const tokens = tm.listTokens();
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
    renderCard: (args) => renderCctCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
