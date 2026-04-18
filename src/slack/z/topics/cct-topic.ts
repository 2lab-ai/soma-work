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
import type { CctStoreSnapshot, TokenSlot } from '../../../cct-store';
import { getTokenManager, type TokenSummary } from '../../../token-manager';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildCctCardBlocks } from '../../cct/builder';

/**
 * Best-effort: pull the most recent `CctStoreSnapshot` from the token
 * manager so we can hand full `SlotState`s to the builder. We access a
 * non-public method via duck typing — when unavailable (tests), we fall
 * back to an empty state map.
 */
async function loadSnapshotOrEmpty(): Promise<{
  slots: TokenSlot[];
  states: Record<string, NonNullable<CctStoreSnapshot['state'][string]>>;
  activeSlotId?: string;
}> {
  const tm = getTokenManager() as unknown as {
    // Duck-typed private store access.
    store?: { load?: () => Promise<CctStoreSnapshot> };
    listTokens: () => TokenSummary[];
    getActiveToken: () => { slotId: string; name: string; kind: TokenSlot['kind'] } | null;
  };
  try {
    if (tm.store?.load) {
      const snap = await tm.store.load();
      return {
        slots: snap.registry.slots,
        states: snap.state,
        activeSlotId: snap.registry.activeSlotId,
      };
    }
  } catch {
    /* ignore */
  }
  // Fallback: synthesise minimal slots from listTokens().
  const summaries = tm.listTokens();
  const active = tm.getActiveToken();
  const slots = summaries.map((s) => ({
    slotId: s.slotId,
    name: s.name,
    kind: s.kind,
    // Minimal placeholders so the builder's type is satisfied. The builder
    // only reads slotId/name/kind for non-state fields.
    createdAt: '',
    ...(s.kind === 'oauth_credentials'
      ? {
          credentials: { accessToken: '', refreshToken: '', expiresAtMs: 0, scopes: [] },
          acknowledgedConsumerTosRisk: true as const,
        }
      : { value: '' }),
  })) as unknown as TokenSlot[];
  return {
    slots,
    states: {},
    activeSlotId: active?.slotId,
  };
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

  const { slots, states, activeSlotId } = await loadSnapshotOrEmpty();
  const blocks = buildCctCardBlocks({
    slots,
    states,
    activeSlotId,
    nowMs: Date.now(),
  });

  // Back-compat: the text `/z cct` command still used legacy-named action
  // IDs from the shared ui-builder. We add them here so the existing
  // z-settings-actions router continues to resolve `set_<name>` / `next`.
  const legacyActions: Record<string, unknown>[] = slots.map((s) => ({
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

  const active = slots.find((s) => s.slotId === activeSlotId);
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
      description: `kind: \`${active?.kind ?? 'setup_token'}\``,
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
  await tm.applyToken(match.slotId);
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
