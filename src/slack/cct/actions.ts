/**
 * CCT block_action / view_submission handlers (Wave 4, #569).
 *
 * ⚠️ STABILITY: block_id and action_id values in `./views.ts` MUST NOT
 * change across `views.update` calls — Slack preserves typed `state.values`
 * only when keys are stable. The Add-Slot modal re-renders on
 * `kind_radio` change and must hit `updateModal` with the same block_ids,
 * or any typed-in credential is lost.
 *
 * Ack contract: every handler MUST call `ack()` within 3 seconds. Heavy
 * work (modal open, token-manager mutation) happens AFTER ack.
 *
 * All error surfaces use `response_action: 'errors'` keyed by BLOCK_ID
 * (Slack Block Kit spec — NOT action_id).
 *
 * Scope: Wave 4 wires CCT block actions into the shared Bolt `App`. Wave 5
 * will layer usage-fetch UX on top.
 */

import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { isAdminUser } from '../../admin-utils';
import type { AuthKey } from '../../auth/auth-key';
import { config } from '../../config';
import { Logger } from '../../logger';
import type { OAuthCredentials } from '../../oauth/refresher';
import { hasRequiredScopes } from '../../oauth/scope-check';
import type { TokenManager } from '../../token-manager';
import { renderCctCard } from '../z/topics/cct-topic';
import { type CctCardMode, decodeCctActionValue } from './action-value';
import {
  type AddSlotFormKind,
  appendStoreReadFailureBanner,
  buildAddSlotModal,
  buildAttachOAuthModal,
  buildCctCardBlocks,
  buildRemoveSlotModal,
  type CctCardViewerMode,
  escapeMrkdwn,
} from './builder';
import { renderInPlace } from './render-in-place';
import { CCT_ACTION_IDS, CCT_BLOCK_IDS, CCT_VIEW_IDS } from './views';

const logger = new Logger('CctActions');

const SETUP_TOKEN_REGEX = /^sk-ant-oat01-[A-Za-z0-9_-]{8,}$/;
// Z3 — mirror of TokenManager.API_KEY_REGEX. Duplicated here to keep modal
// validation synchronous (no await on the TM export). A drift guard is
// unnecessary because the TM throws on a shape mismatch too.
const API_KEY_REGEX = /^sk-ant-api03-[A-Za-z0-9_-]{8,}$/;

// Refresh-handler banner strings. Shared across handlers + tests to keep
// wording in one place.
export const REFRESH_BANNERS = {
  allNull:
    ':warning: *Refresh All OAuth Tokens — nothing refreshed* — every attached slot failed to refresh. Check the TokenManager logs for `refreshAllAttachedOAuthTokens` errors or the auth-state of each slot.',
  cardNull: ':warning: *Refresh — all usage fetches were throttled or failed.* Try again in a moment.',
  outerCatch: ':warning: Refresh failed. Please try again.',
  updateFailed: ':warning: 카드 갱신 실패. `/cct`를 다시 실행해주세요.',
} as const;

/**
 * #701 — single-failure descriptor used by the `Refresh All OAuth Tokens`
 * partial-failure banner. `name` is safe Slack-mrkdwn (slot names have
 * been validated through `addSlot`); `kind` is one of the fixed
 * {@link import('../../cct-store').RefreshErrorKind} arms, never the
 * freeform message. `status` is the numeric HTTP code when the upstream
 * supplied one — rendered as `(429)` / `(500)` for at-a-glance debugging.
 */
export interface RefreshFailureSummary {
  name: string;
  kind: string;
  status?: number;
}

/**
 * Build the `Refresh All OAuth Tokens` mixed-failure banner header.
 *
 * Only `name` + `kind` + `status` land here — NEVER `lastRefreshError.message`
 * or any freeform text. The contract is "secret-leak safe by construction":
 * `kind` is a fixed ASCII enum and `status` is a number. Names are
 * truncated at 5 entries with a ` … (+N more)` suffix so a large fleet
 * keeps the banner under Slack's reasonable mrkdwn width.
 */
/**
 * Escape a slot-name for safe inclusion in a Slack mrkdwn banner.
 *
 * Slot names pass `addSlot`'s length/uniqueness check but NOT Slack
 * mrkdwn safety. Two escape layers are required:
 *   1. mrkdwn formatting chars (`*` `_` `\``) via {@link escapeMrkdwn}
 *      so `ops*dev` doesn't collapse the banner's bold-header wrapper.
 *   2. HTML-entity encoding for `<`, `>`, `&` per Slack's escaping rule
 *      (https://api.slack.com/reference/surfaces/formatting#escaping) so
 *      a name like `<@UOPS>` / `<!channel>` / `<!here>` doesn't render
 *      as a mention inside the banner.
 */
function escapeSlotNameForBanner(name: string): string {
  const htmlEscaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escapeMrkdwn(htmlEscaped);
}

export function buildPartialFailureBanner(failures: RefreshFailureSummary[], total: number): string {
  if (failures.length === 0) return '';
  const labelFor = (f: RefreshFailureSummary): string => {
    const detail = f.status !== undefined ? `${f.status}` : f.kind;
    return `${escapeSlotNameForBanner(f.name)} (${detail})`;
  };
  const shown = failures.slice(0, 5).map(labelFor).join(', ');
  const overflow = failures.length > 5 ? ` … (+${failures.length - 5} more)` : '';
  return `:warning: *Refresh All OAuth Tokens — ${failures.length} of ${total} failed:* ${shown}${overflow}`;
}

/**
 * Surface descriptor for the `refresh_card` handler. Bolt's block_actions
 * payload carries a `container` block whose shape varies by surface:
 *   - `type: 'message'` → posted card; `chat.update(channel, ts, …)` works.
 *   - `type: 'ephemeral'` → ephemeral card from `postEphemeral`; `chat.update`
 *     is forbidden (no `message_ts` for ephemerals), so we use the
 *     `respond` callback with `replace_original: true` against the
 *     response_url Slack hands us per-action.
 * Anything else (`view`, missing container) falls back to the
 * `updateFailed` banner — we refuse to stack a fresh ephemeral card on
 * top of the stale one because that's exactly the bug Codex flagged.
 */
interface RefreshCardActionBody {
  user?: { id?: string };
  container?: {
    type?: 'message' | 'ephemeral' | string;
    channel_id?: string;
    message_ts?: string;
  };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ value?: string }>;
}

/**
 * Register all CCT block actions + view submissions on the Bolt app.
 *
 * Registered routes:
 *   action  cct_open_add       → open Add modal
 *   action  cct_kind_radio     → update Add modal (conditional blocks)
 *   action  cct_open_remove    → open Remove modal (resolves keyId from value)
 *   action  cct_next           → rotateToNext + re-post card
 *   view    cct_add_slot       → validate + addSlot + close
 *   view    cct_remove_slot    → removeSlot (handles pending-drain) + close
 */
export function registerCctActions(app: App, tokenManager: TokenManager): void {
  // Open Add modal.
  app.action(CCT_ACTION_IDS.add, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const triggerId: string | undefined = (body as any)?.trigger_id;
      if (!triggerId) {
        logger.warn('cct_open_add: missing trigger_id');
        return;
      }
      await client.views.open({ trigger_id: triggerId, view: buildAddSlotModal('setup_token') as any });
    } catch (err) {
      logger.error('cct_open_add failed', err);
    }
  });

  // Kind radio flip — update the open Add modal with conditional blocks.
  app.action(CCT_ACTION_IDS.kind_radio, async ({ ack, body, client }) => {
    await ack();
    try {
      const view = (body as any)?.view;
      if (!view?.id) return;
      const selected = (body as any)?.actions?.[0]?.selected_option?.value as string | undefined;
      const kind: AddSlotFormKind =
        selected === 'oauth_credentials' || selected === 'api_key' ? selected : 'setup_token';
      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: buildAddSlotModal(kind) as any,
      });
    } catch (err) {
      logger.error('cct_kind_radio update failed', err);
    }
  });

  // Open Remove modal — button value is the target keyId.
  app.action(CCT_ACTION_IDS.remove, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const triggerId: string | undefined = (body as any)?.trigger_id;
      if (!triggerId) return;
      // Per-slot Remove button: `value` carries the target keyId,
      // tagged via the #803 codec. Reject if invalid — no silent
      // fallback to active/slots[0].
      const decoded = decodeActionButtonValue(body);
      if (!decoded) {
        logger.warn('cct_open_remove: invalid or missing keyId on action value');
        return;
      }
      const targetKeyId = decoded.payload;
      const snap = await tokenManager.getSnapshot();
      const target = snap.registry.slots.find((s) => s.keyId === targetKeyId);
      if (!target) {
        logger.warn('cct_open_remove: target slot not found', { targetKeyId });
        return;
      }
      const hasActiveLeases = (snap.state[target.keyId]?.activeLeases.length ?? 0) > 0;
      await client.views.open({
        trigger_id: triggerId,
        view: buildRemoveSlotModal(target, hasActiveLeases) as any,
      });
    } catch (err) {
      logger.error('cct_open_remove failed', err);
    }
  });

  // Z2 — Open Attach OAuth modal. Button `value` carries the target keyId;
  // we re-check the slot shape (kind=cct + source='setup') server-side
  // before opening the modal so a stale card (where the user already
  // detached / re-attached elsewhere) never opens an attach flow against a
  // legacy-attachment slot or an api_key slot.
  app.action(CCT_ACTION_IDS.attach, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const triggerId: string | undefined = (body as any)?.trigger_id;
      if (!triggerId) return;
      const decoded = decodeActionButtonValue(body);
      if (!decoded) {
        logger.warn('cct_open_attach: invalid or missing keyId on action value');
        return;
      }
      const targetKeyId = decoded.payload;
      const snap = await tokenManager.getSnapshot();
      const target = snap.registry.slots.find((s) => s.keyId === targetKeyId);
      if (!target) {
        logger.warn('cct_open_attach: target slot not found', { targetKeyId });
        return;
      }
      if (target.kind !== 'cct' || target.source !== 'setup') {
        logger.warn('cct_open_attach: target slot is not a setup-source cct slot', {
          targetKeyId,
          kind: target.kind,
        });
        return;
      }
      await client.views.open({
        trigger_id: triggerId,
        view: buildAttachOAuthModal(target) as any,
      });
    } catch (err) {
      logger.error('cct_open_attach failed', err);
    }
  });

  // Z2 — Detach OAuth. Inline action (no modal): validate → ack → mutate.
  //
  // #803 — replaces the prior `postEphemeralCard` (which spawned a fresh
  // ephemeral on top of the stale card) with `renderCardInPlace` so the
  // clicked surface updates in place. cardMode is preserved from the
  // originating button so a non-admin viewing an admin-mode card who
  // clicked Detach (which they cannot) would have been refused at the
  // admin gate; admin-on-admin-card is the only happy path here.
  app.action(CCT_ACTION_IDS.detach, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const decoded = decodeActionButtonValue(body);
      if (!decoded) {
        logger.warn('cct_detach: invalid or missing keyId on action value');
        return;
      }
      const targetKeyId = decoded.payload;
      const renderMode = resolveRenderMode(decoded.cardMode, actorUserId(body));
      await tokenManager.detachOAuth(targetKeyId);
      await renderCardInPlace({ tokenManager, body, client, respond, viewerMode: renderMode });
    } catch (err) {
      logger.error('cct_detach failed', err);
    }
  });

  // Rotate to next.
  //
  // #803 — in-place card update via renderCardInPlace.
  app.action(CCT_ACTION_IDS.next, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      // Decode the button value so legacy `value:'next'` (pre-#803) and
      // tagged `cm:admin|next` both flow through. cardMode falls back
      // to actor-derived when legacy.
      const decoded = decodeActionButtonValue(body);
      const renderMode = resolveRenderMode(decoded?.cardMode ?? null, actorUserId(body));
      await tokenManager.rotateToNext();
      await renderCardInPlace({ tokenManager, body, client, respond, viewerMode: renderMode });
    } catch (err) {
      logger.error('cct_next failed', err);
    }
  });

  // Per-slot [Activate] button. Admin gate + `applyToken(keyId)`
  // + in-place card re-render.
  //
  // Button is only emitted for non-active, non-api_key slots (see
  // `buildSlotRow`); the handler re-validates server-side so a stale
  // card (where the user already rotated elsewhere) can't force a
  // runtime exception into `applyToken`'s api_key reject path.
  //
  // #803 — `respondWithCard` (which posted a fresh ephemeral via
  // `respond({replace_original:false})`) replaced by `renderCardInPlace`
  // so the clicked surface updates in place.
  app.action(CCT_ACTION_IDS.activate_slot, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const decoded = decodeActionButtonValue(body);
      if (!decoded) {
        logger.warn('cct_activate_slot: invalid or missing keyId on action value');
        return;
      }
      const targetKeyId = decoded.payload;
      const renderMode = resolveRenderMode(decoded.cardMode, actorUserId(body));
      const snap = await tokenManager.getSnapshot();
      const target = snap.registry.slots.find((s) => s.keyId === targetKeyId);
      if (!target) {
        logger.warn('cct_activate_slot: target slot not found', { targetKeyId });
        return;
      }
      if (target.kind === 'api_key') {
        logger.warn('cct_activate_slot: target is api_key (not runtime-selectable)', { targetKeyId });
        return;
      }
      await tokenManager.applyToken(targetKeyId);
      await renderCardInPlace({ tokenManager, body, client, respond, viewerMode: renderMode });
    } catch (err) {
      logger.error('cct_activate_slot failed', err);
    }
  });

  // Card-level "Refresh All OAuth Tokens" (admin-only fan-out).
  //
  // Ack first (Slack 3s contract), then admin gate, then the token-refresh
  // fan-out. This button force-refreshes the OAuth access_token for every
  // attached CCT slot AND awaits the profile sync under a shared deadline
  // so the card's email / rate-limit-tier badges reflect fresh data on the
  // same click. It does NOT re-fetch usage; usage re-fetches happen on the
  // separate card-level [Refresh] button.
  //
  // When every attached slot reports `error` (all refreshes failed), post
  // an ephemeral banner instead of silently re-rendering the same stale
  // card. Partial failures still re-post so successful rows update. Empty
  // result map (no attached slots) is not "all failed".
  app.action(CCT_ACTION_IDS.refresh_usage_all, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      // #803 — refresh_usage_all is admin-only and only emitted on the
      // admin card, so cardMode is implicitly 'admin'. Decode for
      // legacy compat anyway so a pre-#803 button still flows through.
      const decoded = decodeActionButtonValue(body);
      const renderMode = resolveRenderMode(decoded?.cardMode ?? null, actorUserId(body));
      // #701 — capture the starting keyIds BEFORE the refresh call so we
      // can detect slots that timed out (missing from `results`) separately
      // from slots that were concurrently removed/detached.
      const startingSnap = await tokenManager.getSnapshot();
      const startingAttached = startingSnap.registry.slots.filter(
        (s) => s.kind === 'cct' && s.oauthAttachment !== undefined,
      );
      const startingKeyIds = startingAttached.map((s) => s.keyId);
      const startingByKeyId = new Map(startingAttached.map((s) => [s.keyId, s]));

      const results = await tokenManager.refreshAllAttachedOAuthTokens({ awaitProfile: true });

      // #701 — classify EVERY starting keyId first (before deciding
      // all-failed vs. mixed), then derive the totals from that
      // classification. Deciding off raw `results` has two spec gaps the
      // second reviewer flagged: (1) when every slot hits the shared
      // deadline `results` is empty and the naive check misses all-failed,
      // (2) concurrently torn-down slots inflate the banner denominator.
      const snap2 = await tokenManager.getSnapshot();
      const stillAttached = new Set(
        snap2.registry.slots.filter((s) => s.kind === 'cct' && s.oauthAttachment !== undefined).map((s) => s.keyId),
      );
      let okCount = 0;
      const failures: RefreshFailureSummary[] = [];
      for (const keyId of startingKeyIds) {
        const outcome = results[keyId];
        if (outcome === 'ok') {
          okCount += 1;
          continue;
        }
        if (outcome === 'error') {
          const errInfo = snap2.state[keyId]?.lastRefreshError;
          failures.push({
            name: startingByKeyId.get(keyId)?.name ?? keyId,
            kind: errInfo?.kind ?? 'unknown',
            ...(errInfo?.status !== undefined ? { status: errInfo.status } : {}),
          });
          continue;
        }
        // Missing from results. Differentiate timeout vs. concurrent teardown.
        // Teardown cases are omitted from accounting entirely (spec).
        if (stillAttached.has(keyId)) {
          failures.push({ name: startingByKeyId.get(keyId)?.name ?? keyId, kind: 'timeout' });
        }
      }

      const effectiveTotal = okCount + failures.length;

      // #803 — All three outcome arms now go through `renderCardInPlace`
      // so the originating card surface is updated in place rather than
      // stacking a fresh ephemeral on top of the stale card.
      //
      // All-failed: prepend the `allNull` banner (no successes worth
      // re-rendering, but still render so the operator sees the card
      // chrome explaining why).
      // Partial: prepend the partial-failure banner with name (kind/code)
      // bullets.
      // Success-only: render the card with no banner.

      let banner: string | undefined;
      if (failures.length > 0 && okCount === 0 && effectiveTotal > 0) {
        banner = REFRESH_BANNERS.allNull;
      } else if (failures.length > 0) {
        banner = buildPartialFailureBanner(failures, effectiveTotal);
      }

      const result = await renderCardInPlace({
        tokenManager,
        body,
        client,
        respond,
        viewerMode: renderMode,
        prependBanner: banner,
      });
      if (result.surface === 'unknown' || !result.ok) {
        // Couldn't update the surface — surface the banner via
        // ephemeral fallback so we at least don't drop the failure
        // signal on the floor.
        if (banner) {
          await postEphemeralFailure(client, body, banner);
        } else {
          // Success-only path failed to render. Operator gets a generic
          // "card update failed" line so they re-invoke /cct.
          await postEphemeralFailure(client, body, REFRESH_BANNERS.updateFailed);
        }
      }
    } catch (err) {
      logger.error('cct_refresh_usage_all failed', err);
      await postEphemeralFailure(client, body, REFRESH_BANNERS.outerCatch);
    }
  });

  // Card-level "Refresh" — pure usage re-fetch fan-out. Siblings:
  //   - [Refresh All OAuth Tokens] above refreshes OAuth tokens.
  //   - This handler force-refreshes the usage snapshot on every attached
  //     CCT slot (via `fetchAndStoreUsage(keyId, { force: true })`) so the
  //     per-row usage bars reflect the latest Anthropic data on the same
  //     click.
  //
  // Surface-aware in-place update (Codex blocker follow-up to #672): the
  // Refresh button can be clicked from either a posted message (first
  // `/cct` card) OR from an ephemeral card spawned by a sibling action
  // (add/remove/attach/detach/refresh_usage_all all call
  // `postEphemeralCard`). We MUST update the clicked surface in place
  // instead of stacking yet another ephemeral card on the channel:
  //   - `container.type === 'message'`   → `chat.update`
  //   - `container.type === 'ephemeral'` → `respond({ replace_original: true })`
  //   - anything else / surface missing  → `updateFailed` banner
  //
  // When every attached slot fetch returns null (throttled or failed),
  // post an ephemeral `cardNull` banner instead of silently leaving the
  // same stale card in place.
  app.action(CCT_ACTION_IDS.refresh_card, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      // #803 — `refresh_card` is now allowed for non-admin (the only
      // affordance on the readonly card). Side-effect-bearing
      // `force=true` fetch is gated to (admin actor) ∧ (cardMode='admin')
      // so non-admin clicking Refresh on an admin-mode card
      // re-renders without forcing a fresh fetch — throttle is honored.
      const decoded = decodeActionButtonValue(body);
      if (!decoded && (body as any)?.actions?.[0]?.value !== undefined) {
        // Value present but unparseable. Banner + bail.
        logger.warn('cct_refresh_card: invalid action value');
        await postEphemeralFailure(client, body, REFRESH_BANNERS.updateFailed);
        return;
      }
      const userIdValue = actorUserId(body);
      const cardMode = decoded?.cardMode ?? null; // null when legacy / no value.
      const isLegacy = decoded?.isLegacy ?? false;
      const actorIsAdmin = userIdValue ? isAdminUser(userIdValue) : false;
      // Force gate: legacy decode → force=false (cardMode unknown,
      // safer to throttle); tagged → force only when actor is admin AND
      // cardMode is 'admin'.
      const allowForce = !isLegacy && actorIsAdmin && cardMode === 'admin';
      const renderMode: CctCardViewerMode = resolveRenderMode(cardMode, userIdValue);

      const snap = await tokenManager.getSnapshot();
      const keyIds = snap.registry.slots
        .filter((s) => s.kind === 'cct' && s.oauthAttachment !== undefined)
        .map((s) => s.keyId);

      let throttledAllNull = false;
      if (allowForce) {
        // Admin-on-admin-card: fan-out force fetch (existing behavior).
        const results = await Promise.allSettled(
          keyIds.map((keyId) => tokenManager.fetchAndStoreUsage(keyId, { force: true })),
        );
        const freshCount = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
        if (freshCount === 0 && keyIds.length > 0) {
          await postEphemeralFailure(client, body, REFRESH_BANNERS.cardNull);
          return;
        }
      } else if (keyIds.length > 0) {
        // Non-force path (non-admin, OR admin-on-readonly-card, OR
        // legacy value). `fetchUsageForAllAttached` respects the
        // per-keyId 5-minute throttle. When the timeout fires before
        // any slot returns or every slot is throttled, the result map
        // values are null — surface a context banner that says so but
        // STILL render the cached card so the user sees something.
        try {
          const results = await tokenManager.fetchUsageForAllAttached({
            timeoutMs: config.usage.cardOpenTimeoutMs,
          });
          const fresh = Object.values(results).filter((v) => v !== null).length;
          if (fresh === 0) throttledAllNull = true;
        } catch (err) {
          logger.debug('cct_refresh_card non-force fetch failed; rendering cached', {
            err: (err as Error)?.message ?? err,
          });
          throttledAllNull = true;
        }
      }

      const banner = throttledAllNull ? ':warning: _Cached usage · refresh limited (5-minute throttle)._' : undefined;

      const result = await renderCardInPlace({
        tokenManager,
        body,
        client,
        respond,
        viewerMode: renderMode,
        prependBanner: banner,
      });
      if (result.surface === 'unknown' || !result.ok) {
        // Unknown surface or transport failure — surface the fallback
        // banner so the operator re-invokes `/cct` explicitly. Refuse
        // to stack a fresh ephemeral card on top of the stale one
        // (that's exactly what #803 fixes).
        if (result.surface === 'unknown') {
          logger.warn('cct_refresh_card no surface to update', {
            container: (body as any)?.container,
          });
        }
        await postEphemeralFailure(client, body, REFRESH_BANNERS.updateFailed);
      }
    } catch (err) {
      logger.error('cct_refresh_card failed', err);
      await postEphemeralFailure(client, body, REFRESH_BANNERS.outerCatch).catch(() => {
        /* ignore double-failure */
      });
    }
  });

  // View submission: Add slot.
  //
  // #803 — admin gate added on the view submission entry. The modal-
  // open gate (`cct_open_add`) is the primary UX gate, but a non-admin
  // could in theory craft a `view_submission` payload directly via a
  // leaked view_id. Server-side gate makes the trust boundary
  // unambiguous.
  app.view(CCT_VIEW_IDS.add, async ({ ack, body, client }) => {
    if (!requireAdmin(body)) {
      // ack-with-errors keeps the modal open (non-admin shouldn't have
      // gotten here in normal flow); we surface a generic error keyed
      // by the name field so something visible appears.
      await ack({
        response_action: 'errors',
        errors: { [CCT_BLOCK_IDS.add_name]: 'Admin only.' },
      });
      return;
    }
    const values: Record<string, Record<string, any>> = (body as any)?.view?.state?.values ?? {};
    const errors = validateAddSubmission(values, tokenManager);
    if (errors) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    const name = readPlainText(values, CCT_BLOCK_IDS.add_name, CCT_ACTION_IDS.name_input);
    const kind = readRadio(values, CCT_BLOCK_IDS.add_kind, CCT_ACTION_IDS.kind_radio);
    try {
      if (kind === 'oauth_credentials') {
        const blob = readPlainText(values, CCT_BLOCK_IDS.add_oauth_credentials_blob, CCT_ACTION_IDS.oauth_blob_input);
        const creds = parseOAuthBlob(blob);
        // validateAddSubmission already confirmed `creds` is valid + ack selected.
        await tokenManager.addSlot({
          name,
          kind: 'oauth_credentials',
          credentials: creds!,
          acknowledgedConsumerTosRisk: true,
        });
      } else if (kind === 'api_key') {
        // Z3 — store-only api_key slot. validateAddSubmission already
        // enforced the sk-ant-api03-<chars> regex, but TokenManager.addSlot
        // re-checks before persist.
        const value = readPlainText(values, CCT_BLOCK_IDS.add_api_key_value, CCT_ACTION_IDS.api_key_input);
        await tokenManager.addSlot({ name, kind: 'api_key', value });
      } else {
        const value = readPlainText(values, CCT_BLOCK_IDS.add_setup_token_value, CCT_ACTION_IDS.setup_token_input);
        await tokenManager.addSlot({ name, kind: 'setup_token', value });
      }
      await ack();
      await postEphemeralCard(tokenManager, client, body);
    } catch (err) {
      // Surface CAS-level name collisions (lost a race with a parallel Add
      // for the same name) as a modal-level validation error.
      const msg = (err as Error)?.message ?? '';
      if (msg.startsWith('NAME_IN_USE:')) {
        await ack({
          response_action: 'errors',
          errors: { [CCT_BLOCK_IDS.add_name]: `Name \`${name}\` is already in use.` },
        });
        return;
      }
      // Unknown failure — ack without errors so the modal closes; the
      // caller will see the ephemeral card (or its absence) as feedback.
      await ack();
      logger.error('cct view_submission add failed', err);
    }
  });

  // View submission: Remove slot.
  //
  // #803 — admin gate added on the view submission entry. The modal-
  // open gate (`cct_open_remove`) is the primary UX gate; the
  // server-side gate here defends against direct view_submission
  // posts.
  app.view(CCT_VIEW_IDS.remove, async ({ ack, body, client }) => {
    if (!requireAdmin(body)) {
      await ack();
      return;
    }
    await ack();
    try {
      const keyId = ((body as any)?.view?.private_metadata ?? '') as string;
      if (!keyId) return;
      const result = await tokenManager.removeSlot(keyId);
      if (result.pendingDrain) {
        const userId = (body as any)?.user?.id as string | undefined;
        const channel = await resolveActorDm(client, userId);
        if (channel) {
          await client.chat.postMessage({
            channel,
            text: ':hourglass_flowing_sand: Slot tombstoned — it will be removed once in-flight requests drain.',
          });
        }
      }
      await postEphemeralCard(tokenManager, client, body);
    } catch (err) {
      logger.error('cct view_submission remove failed', err);
    }
  });

  // Z2 — View submission: Attach OAuth.
  //
  // Ordering (Codex P0 fix #1):
  //   1. Sync-validate blob shape, scopes, ToS ack.
  //   2. If invalid → ack with `response_action: 'errors'` keyed by block_id.
  //      This single ack satisfies Slack's 3s contract AND surfaces field
  //      errors on the still-open modal.
  //   3. If valid → ack plainly FIRST (satisfies 3s budget even if the store
  //      mutate hits CAS retries on a slow disk), then invoke `attachOAuth`.
  //   4. Runtime errors from `attachOAuth` (race-lost kind/source checks,
  //      scope drift) surface via ephemeral DM — the modal is already closed.
  app.view(CCT_VIEW_IDS.attach, async ({ ack, body, client }) => {
    // #803 — admin gate added on the view submission entry.
    if (!requireAdmin(body)) {
      await ack({
        response_action: 'errors',
        errors: { [CCT_BLOCK_IDS.attach_oauth_blob]: 'Admin only.' },
      });
      return;
    }
    const values: Record<string, Record<string, any>> = (body as any)?.view?.state?.values ?? {};
    const blob = readPlainText(values, CCT_BLOCK_IDS.attach_oauth_blob, CCT_ACTION_IDS.attach_oauth_input);
    const creds = parseOAuthBlob(blob);
    const errors: Record<string, string> = {};
    if (!creds) {
      errors[CCT_BLOCK_IDS.attach_oauth_blob] =
        'Paste a valid claudeAiOauth JSON object with accessToken, refreshToken, expiresAt, and scopes.';
    } else if (!hasRequiredScopes(creds.scopes)) {
      errors[CCT_BLOCK_IDS.attach_oauth_blob] = 'OAuth credentials missing required scope(s): user:profile.';
    }
    const acked = readCheckboxes(values, CCT_BLOCK_IDS.attach_tos_ack, CCT_ACTION_IDS.attach_tos_ack).includes('ack');
    if (!acked) {
      errors[CCT_BLOCK_IDS.attach_tos_ack] =
        'You must acknowledge the Anthropic Terms-of-Service risk to attach OAuth credentials.';
    }
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }
    const keyId = ((body as any)?.view?.private_metadata ?? '') as string;
    if (!keyId) {
      await ack();
      return;
    }
    // Ack FIRST to satisfy Slack's 3s view_submission contract. The mutate
    // path does disk I/O + CAS retry + refreshCache, which can spike beyond
    // 3s on a slow disk or contended store.
    await ack();
    try {
      await tokenManager.attachOAuth(keyId, creds!, true);
      await postEphemeralCard(tokenManager, client, body);
    } catch (err) {
      logger.error('cct view_submission attach failed', err);
      // Modal is already closed — surface failure via ephemeral DM so the
      // operator isn't left guessing. Swallow DM errors (Slack rate limits /
      // offline channel) — logger.error is the durable record.
      const userId = (body as any)?.user?.id as string | undefined;
      const channel = await resolveActorDm(client, userId);
      if (channel) {
        const msg = (err as Error)?.message ?? 'attach failed';
        try {
          await client.chat.postMessage({
            channel,
            text: `:warning: Attach OAuth failed: ${msg}`,
          });
        } catch (dmErr) {
          logger.debug('cct attach DM failed', { dmErr });
        }
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

function requireAdmin(body: unknown): boolean {
  const userId = (body as any)?.user?.id as string | undefined;
  if (!userId) return false;
  if (!isAdminUser(userId)) {
    logger.info('cct action denied for non-admin', { userId });
    return false;
  }
  return true;
}

/**
 * Pull the actor user id off the bolt body. Returns null when missing.
 */
function actorUserId(body: unknown): string | null {
  const userId = (body as any)?.user?.id;
  return typeof userId === 'string' && userId.length > 0 ? userId : null;
}

/**
 * Decode a button's `value` into `{ payload, cardMode, isLegacy }`.
 *
 * Returns null when the value is invalid — handler must ack and refuse
 * the action. Legacy values surface as `{ isLegacy: true, cardMode: null }`
 * so the caller can force `force=false` and fall back to the actor's
 * render mode. Tagged values surface the encoded mode verbatim.
 */
function decodeActionButtonValue(body: unknown): {
  payload: string;
  cardMode: CctCardMode | null;
  isLegacy: boolean;
} | null {
  const raw = (body as any)?.actions?.[0]?.value;
  const decoded = decodeCctActionValue(raw);
  if (decoded.kind === 'invalid') return null;
  if (decoded.kind === 'legacy') {
    return { payload: decoded.payload, cardMode: null, isLegacy: true };
  }
  return { payload: decoded.payload, cardMode: decoded.mode, isLegacy: false };
}

/**
 * Resolve the effective render mode for an action handler.
 *
 *   - tagged value (cardMode='admin'|'readonly') → use it. This is the
 *     "preserve cardMode across viewers" rule (#803 spec Q1=A).
 *   - legacy value (no `cm:` prefix) → fall back to the actor's mode.
 *     Legacy buttons can only have been emitted before #803 landed, so
 *     the safest mapping is "render the card as the actor would see a
 *     fresh /cct".
 */
function resolveRenderMode(cardMode: CctCardMode | null, actorUserIdValue: string | null): CctCardMode {
  if (cardMode !== null) return cardMode;
  if (actorUserIdValue && isAdminUser(actorUserIdValue)) return 'admin';
  return 'readonly';
}

/**
 * Validate the Add Slot view submission.
 *
 * Returns a `response_action.errors` object keyed by block_id on failure,
 * or `null` when the submission is valid.
 */
export function validateAddSubmission(
  values: Record<string, Record<string, any>>,
  tokenManager: TokenManager,
): Record<string, string> | null {
  const errors: Record<string, string> = {};
  const name = readPlainText(values, CCT_BLOCK_IDS.add_name, CCT_ACTION_IDS.name_input);
  if (!name || name.length > 64) {
    errors[CCT_BLOCK_IDS.add_name] = 'Name must be 1-64 characters.';
  } else if (tokenManager.listTokens().some((t) => t.name === name)) {
    errors[CCT_BLOCK_IDS.add_name] = `Name \`${name}\` is already in use.`;
  }
  const kind = readRadio(values, CCT_BLOCK_IDS.add_kind, CCT_ACTION_IDS.kind_radio);
  if (kind === 'setup_token') {
    const value = readPlainText(values, CCT_BLOCK_IDS.add_setup_token_value, CCT_ACTION_IDS.setup_token_input);
    if (!SETUP_TOKEN_REGEX.test(value)) {
      errors[CCT_BLOCK_IDS.add_setup_token_value] = 'Expected format: sk-ant-oat01-<chars> (≥ 8 chars).';
    }
  } else if (kind === 'oauth_credentials') {
    const blob = readPlainText(values, CCT_BLOCK_IDS.add_oauth_credentials_blob, CCT_ACTION_IDS.oauth_blob_input);
    const creds = parseOAuthBlob(blob);
    if (!creds) {
      errors[CCT_BLOCK_IDS.add_oauth_credentials_blob] =
        'Paste a valid claudeAiOauth JSON object with accessToken, refreshToken, expiresAt, and scopes.';
    } else if (!hasRequiredScopes(creds.scopes)) {
      errors[CCT_BLOCK_IDS.add_oauth_credentials_blob] = 'OAuth credentials missing required scope(s): user:profile.';
    }
    const acked = readCheckboxes(values, CCT_BLOCK_IDS.add_tos_ack, CCT_ACTION_IDS.tos_ack).includes('ack');
    if (!acked) {
      errors[CCT_BLOCK_IDS.add_tos_ack] =
        'You must acknowledge the Anthropic Terms-of-Service risk to use oauth_credentials.';
    }
  } else if (kind === 'api_key') {
    // Z3 — commercial API key format.
    const value = readPlainText(values, CCT_BLOCK_IDS.add_api_key_value, CCT_ACTION_IDS.api_key_input);
    if (!API_KEY_REGEX.test(value)) {
      errors[CCT_BLOCK_IDS.add_api_key_value] = 'Expected format: sk-ant-api03-<chars> (≥ 8 chars).';
    }
  } else {
    errors[CCT_BLOCK_IDS.add_kind] = 'Select a credential kind.';
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Parse an `oauth_credentials` JSON blob. Accepts either
 *   { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, … } }
 * or the bare `{ accessToken, … }` inner object. Returns null on shape
 * mismatch. `expiresAt` is accepted as either `expiresAt` (ms since epoch)
 * or `expiresAtMs` for forward-compat.
 */
export function parseOAuthBlob(raw: string): OAuthCredentials | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const outer = parsed as Record<string, unknown>;
  const inner = (outer.claudeAiOauth as Record<string, unknown> | undefined) ?? outer;
  if (!inner || typeof inner !== 'object') return null;
  const accessToken = typeof inner.accessToken === 'string' ? inner.accessToken : '';
  const refreshToken = typeof inner.refreshToken === 'string' ? inner.refreshToken : '';
  const scopes = Array.isArray(inner.scopes)
    ? (inner.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const expiresAtMs =
    typeof inner.expiresAtMs === 'number'
      ? inner.expiresAtMs
      : typeof inner.expiresAt === 'number'
        ? inner.expiresAt
        : NaN;
  if (!accessToken || !refreshToken || scopes.length === 0 || !Number.isFinite(expiresAtMs)) return null;
  const out: OAuthCredentials = {
    accessToken,
    refreshToken,
    expiresAtMs,
    scopes,
  };
  if (typeof inner.rateLimitTier === 'string') out.rateLimitTier = inner.rateLimitTier;
  if (typeof inner.subscriptionType === 'string') out.subscriptionType = inner.subscriptionType;
  return out;
}

function readPlainText(values: Record<string, Record<string, any>>, blockId: string, actionId: string): string {
  const raw = values?.[blockId]?.[actionId]?.value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function readRadio(values: Record<string, Record<string, any>>, blockId: string, actionId: string): string {
  const opt = values?.[blockId]?.[actionId]?.selected_option;
  return typeof opt?.value === 'string' ? opt.value : '';
}

function readCheckboxes(values: Record<string, Record<string, any>>, blockId: string, actionId: string): string[] {
  const selected = values?.[blockId]?.[actionId]?.selected_options;
  if (!Array.isArray(selected)) return [];
  return selected.map((o) => (typeof o?.value === 'string' ? (o.value as string) : '')).filter((v) => v.length > 0);
}

async function respondWithCard(opts: {
  tokenManager: TokenManager;
  respond?: (msg: any) => Promise<unknown>;
  body: unknown;
  client: WebClient;
}): Promise<void> {
  const { tokenManager, respond, body, client } = opts;
  const blocks = await buildCardFromManager(tokenManager);
  if (respond) {
    await respond({ response_type: 'ephemeral', replace_original: false, blocks, text: ':key: CCT' });
    return;
  }
  await postEphemeralCard(tokenManager, client, body);
}

/**
 * #803 — Render an in-place card update across the message + ephemeral
 * surfaces.
 *
 * `viewerMode` determines what the user sees — locked to the cardMode
 * stamped on the originating button (or actor-derived fallback when the
 * button was a legacy raw value).
 *
 * Message surface: delegate to `renderCctCard` so the trailing
 * `z_setting_cct_cancel` actions row that the cct-topic adds is
 * preserved across `chat.update` (a `buildCardFromManager` blob would
 * strip that chrome row).
 *
 * Ephemeral surface: lighter `buildCardFromManager` is sufficient — the
 * cancel row only lives on persistent message cards.
 *
 * `prependBanner` lets the caller layer a single section block above
 * the card (used by refresh_card on the throttle-all-null path and the
 * refresh_usage_all partial-failure path). The banner is a Slack
 * mrkdwn string.
 */
async function renderCardInPlace(opts: {
  tokenManager: TokenManager;
  body: unknown;
  client: WebClient;
  respond?: (msg: any) => Promise<unknown>;
  viewerMode: CctCardViewerMode;
  text?: string;
  prependBanner?: string;
}): Promise<{ surface: 'message' | 'ephemeral' | 'unknown'; ok: boolean }> {
  const { tokenManager, body, client, respond, viewerMode, prependBanner } = opts;
  const text = opts.text ?? ':key: CCT status';
  const userId = actorUserId(body);
  const renderMessageBlocks = async (): Promise<Record<string, unknown>[]> => {
    // Persistent message surfaces use renderCctCard so the trailing
    // `z_setting_cct_cancel` chrome row survives chat.update.
    let blocks: Record<string, unknown>[];
    if (userId) {
      try {
        const rendered = await renderCctCard({ userId, issuedAt: Date.now(), viewerMode });
        blocks = rendered.blocks as Record<string, unknown>[];
      } catch (err) {
        logger.warn('renderCardInPlace: renderCctCard failed, falling back to buildCardFromManager', {
          err: (err as Error).message,
        });
        blocks = await buildCardFromManager(tokenManager, { viewerMode });
      }
    } else {
      blocks = await buildCardFromManager(tokenManager, { viewerMode });
    }
    return prependBanner ? [{ type: 'section', text: { type: 'mrkdwn', text: prependBanner } }, ...blocks] : blocks;
  };
  const renderEphemeralBlocks = async (): Promise<Record<string, unknown>[]> => {
    const blocks = await buildCardFromManager(tokenManager, { viewerMode });
    return prependBanner ? [{ type: 'section', text: { type: 'mrkdwn', text: prependBanner } }, ...blocks] : blocks;
  };
  return renderInPlace({
    body: body as Parameters<typeof renderInPlace>[0]['body'],
    client,
    respond,
    text,
    renderMessageBlocks,
    renderEphemeralBlocks,
    logger,
  });
}

/**
 * Shared destination resolver for ephemeral helpers below. Bolt carries
 * the invoking user + channel in two shapes (`container.channel_id` for
 * block_actions, `channel.id` for view_submission). Returns `null` when
 * either field is absent (unit-test fakes, non-interactive events).
 */
interface EphemeralActionBody {
  user?: { id?: string };
  container?: { channel_id?: string };
  channel?: { id?: string };
}

function resolveEphemeralTarget(body: unknown): { userId: string; channel: string } | null {
  const typed = body as EphemeralActionBody;
  const userId = typed?.user?.id;
  const channel = typed?.container?.channel_id ?? typed?.channel?.id;
  if (!userId || !channel) return null;
  return { userId, channel };
}

async function postEphemeralCard(tokenManager: TokenManager, client: WebClient, body: unknown): Promise<void> {
  const target = resolveEphemeralTarget(body);
  if (!target) return;
  const blocks = await buildCardFromManager(tokenManager);
  try {
    await client.chat.postEphemeral({
      channel: target.channel,
      user: target.userId,
      text: ':key: CCT status',
      blocks: blocks as any,
    });
  } catch (err) {
    logger.debug('postEphemeralCard failed', { err });
  }
}

/**
 * #701 — single-surface partial-failure ephemeral. The banner `section`
 * block is prepended to the card blocks so the operator sees the failure
 * summary AND the updated per-row warnings in a single atomic message.
 * This replaces the pre-#701 "post banner; then post card" sequence that
 * could arrive out of order.
 *
 * On transport failure we fall back to a single `postEphemeralFailure`
 * with just the banner — losing the card detail is acceptable, losing
 * the failure signal entirely is not.
 */
async function postEphemeralCardWithBanner(
  tokenManager: TokenManager,
  client: WebClient,
  body: unknown,
  banner: string,
): Promise<void> {
  const target = resolveEphemeralTarget(body);
  if (!target) {
    logger.warn('postEphemeralCardWithBanner: missing user/channel on action body; banner dropped', { banner });
    return;
  }
  const cardBlocks = await buildCardFromManager(tokenManager);
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: banner },
    },
    ...cardBlocks,
  ];
  try {
    await client.chat.postEphemeral({
      channel: target.channel,
      user: target.userId,
      text: ':warning: CCT refresh — partial failure',
      blocks: blocks as any,
    });
  } catch (err) {
    logger.debug('postEphemeralCardWithBanner failed; falling back to banner-only', { err });
    await postEphemeralFailure(client, body, banner);
  }
}

/**
 * Ephemeral failure banner used by the refresh handlers when an
 * all-null / null result would otherwise re-render an identical card.
 */
async function postEphemeralFailure(client: WebClient, body: unknown, message: string): Promise<void> {
  const target = resolveEphemeralTarget(body);
  if (!target) {
    // Silent-drop hazard: the Option A banner would vanish with no signal.
    // Log at WARN so operators notice the missing user/channel shape.
    logger.warn('postEphemeralFailure: missing user/channel on action body; banner dropped', { message });
    return;
  }
  try {
    await client.chat.postEphemeral({
      channel: target.channel,
      user: target.userId,
      text: message,
    });
  } catch (err) {
    logger.debug('postEphemeralFailure failed', { err });
  }
}

/**
 * Build a CCT card from the live `TokenManager` snapshot.
 *
 * `viewerMode` is forwarded to `buildCctCardBlocks` so callers that
 * render an in-place ephemeral update can preserve the cardMode that
 * was stamped onto the originating button (#803). Default is `'admin'`
 * for backward compatibility with the small number of legacy call
 * sites that don't pass an explicit mode (kept until those callers are
 * audited in a follow-up).
 */
export async function buildCardFromManager(
  tokenManager: TokenManager,
  opts: { viewerMode?: CctCardViewerMode } = {},
): Promise<Record<string, unknown>[]> {
  const viewerMode: CctCardViewerMode = opts.viewerMode ?? 'admin';
  // Always load the authoritative snapshot so post-action ephemeral cards
  // reflect current per-slot state (rate-limit timestamps, usage, cooldown)
  // rather than rendering with an empty `states` map.
  //
  // Z3 runtime fence (Codex P0 fix #2): post-action ephemeral cards must NOT
  // render api_key slots as clickable rows / set-active options — api_key is
  // add-only in PR-B. `renderCctCard` already applies the same filter for
  // the Z-topic entry; we mirror it here for the CCT-action entry so the
  // fence is uniform across every card-render path.
  try {
    const snap = await tokenManager.getSnapshot();
    const slots = snap.registry.slots;
    const visibleSlots = slots.filter((s) => s.kind === 'cct');
    const hiddenApiKeyCount = slots.length - visibleSlots.length;
    const blocks = buildCctCardBlocks({
      slots: visibleSlots,
      states: snap.state ?? {},
      activeKeyId: snap.registry.activeKeyId,
      nowMs: Date.now(),
      viewerMode,
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
    return blocks;
  } catch (err) {
    logger.warn('buildCardFromManager: getSnapshot failed, falling back to listTokens()', { err });
    // Carry the api_key fence into the degraded path — cached summaries
    // include both kinds, and the card must never show api_key rows.
    const summaries = tokenManager.listTokens();
    const active = tokenManager.getActiveToken();
    const slots: AuthKey[] = summaries.map((s) =>
      s.kind === 'api_key'
        ? { kind: 'api_key', keyId: s.keyId, name: s.name, value: '', createdAt: '' }
        : { kind: 'cct', source: 'setup', keyId: s.keyId, name: s.name, setupToken: '', createdAt: '' },
    );
    const visibleSlots = slots.filter((s) => s.kind === 'cct');
    const hiddenApiKeyCount = slots.length - visibleSlots.length;
    const blocks = buildCctCardBlocks({
      slots: visibleSlots,
      states: {},
      activeKeyId: active?.keyId,
      viewerMode,
    });
    // Surface the store-read failure with the shared banner wording.
    appendStoreReadFailureBanner(blocks);
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
    return blocks;
  }
}

async function resolveActorDm(client: WebClient, userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const res = await client.conversations.open({ users: userId });
    return (res.channel as { id?: string } | undefined)?.id ?? null;
  } catch {
    return null;
  }
}
