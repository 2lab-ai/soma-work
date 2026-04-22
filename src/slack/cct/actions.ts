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
import {
  type AddSlotFormKind,
  appendStoreReadFailureBanner,
  buildAddSlotModal,
  buildAttachOAuthModal,
  buildCctCardBlocks,
  buildRemoveSlotModal,
  buildRenameSlotModal,
} from './builder';
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
    ':warning: *Refresh all — no fresh data* — every attached slot returned no usage (throttled or failed). Check the TokenManager logs for `fetchAndStoreUsage` errors or the usage-store health.',
  slotNull:
    ':warning: *Refresh slot — no fresh data* — this slot returned no usage (throttled or failed). Check the TokenManager logs for `fetchAndStoreUsage` errors or the usage-store health.',
  outerCatch: ':warning: Refresh failed. Please try again.',
} as const;

/**
 * Register all CCT block actions + view submissions on the Bolt app.
 *
 * Registered routes:
 *   action  cct_open_add       → open Add modal
 *   action  cct_kind_radio     → update Add modal (conditional blocks)
 *   action  cct_open_remove    → open Remove modal (resolves keyId from value)
 *   action  cct_open_rename    → open Rename modal (ditto)
 *   action  cct_next           → rotateToNext + re-post card
 *   action  cct_set_active     → applyToken + re-post card
 *   view    cct_add_slot       → validate + addSlot + close
 *   view    cct_remove_slot    → removeSlot (handles pending-drain) + close
 *   view    cct_rename_slot    → renameSlot + close
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
      // Per-slot Remove button: `value` carries the target keyId. Reject
      // if absent or unknown — no silent fallback to active/slots[0].
      const bodyAction = (body as any).actions?.[0];
      const targetKeyId = typeof bodyAction?.value === 'string' ? bodyAction.value : undefined;
      if (!targetKeyId) {
        logger.warn('cct_open_remove: missing keyId on action value');
        return;
      }
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
      const bodyAction = (body as any).actions?.[0];
      const targetKeyId = typeof bodyAction?.value === 'string' ? bodyAction.value : undefined;
      if (!targetKeyId) {
        logger.warn('cct_open_attach: missing keyId on action value');
        return;
      }
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
  // The card is re-posted ephemerally so the user immediately sees the
  // Attach button replace the Detach button for that slot.
  app.action(CCT_ACTION_IDS.detach, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const bodyAction = (body as any).actions?.[0];
      const targetKeyId = typeof bodyAction?.value === 'string' ? bodyAction.value : undefined;
      if (!targetKeyId) {
        logger.warn('cct_detach: missing keyId on action value');
        return;
      }
      await tokenManager.detachOAuth(targetKeyId);
      await postEphemeralCard(tokenManager, client, body);
    } catch (err) {
      logger.error('cct_detach failed', err);
    }
  });

  // Open Rename modal.
  app.action(CCT_ACTION_IDS.rename, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const triggerId: string | undefined = (body as any)?.trigger_id;
      if (!triggerId) return;
      // Per-slot Rename button: `value` carries the target keyId.
      const bodyAction = (body as any).actions?.[0];
      const targetKeyId = typeof bodyAction?.value === 'string' ? bodyAction.value : undefined;
      if (!targetKeyId) {
        logger.warn('cct_open_rename: missing keyId on action value');
        return;
      }
      const snap = await tokenManager.getSnapshot();
      const target = snap.registry.slots.find((s) => s.keyId === targetKeyId);
      if (!target) {
        logger.warn('cct_open_rename: target slot not found', { targetKeyId });
        return;
      }
      await client.views.open({
        trigger_id: triggerId,
        view: buildRenameSlotModal(target) as any,
      });
    } catch (err) {
      logger.error('cct_open_rename failed', err);
    }
  });

  // Rotate to next.
  app.action(CCT_ACTION_IDS.next, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      await tokenManager.rotateToNext();
      await respondWithCard({ tokenManager, respond, body, client });
    } catch (err) {
      logger.error('cct_next failed', err);
    }
  });

  // Set active.
  app.action(CCT_ACTION_IDS.set_active, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const keyId = (body as any)?.actions?.[0]?.selected_option?.value as string | undefined;
      if (!keyId) return;
      await tokenManager.applyToken(keyId);
      await respondWithCard({ tokenManager, respond, body, client });
    } catch (err) {
      logger.error('cct_set_active failed', err);
    }
  });

  // Card-level "Refresh all" (admin-only fan-out).
  //
  // Ack first (Slack 3s contract), then admin gate, then fetch. Does NOT
  // forward `force` to per-slot calls — the per-keyId in-flight dedupe
  // lets this share the scheduler's tick when they overlap, and forcing
  // every slot would defeat the local `nextUsageFetchAllowedAt` throttle
  // that protects Anthropic from refresh storms. See
  // `token-manager.ts fetchUsageForAllAttached` and the test contract at
  // `token-manager.test.ts` ("does NOT forward force").
  //
  // When every attached slot returns `null` (all fetches throttled or
  // failed), post an ephemeral banner instead of silently re-rendering
  // the same stale card. Partial failures still re-post so successful
  // rows update. Empty input map (no attached slots) is not "all failed".
  app.action(CCT_ACTION_IDS.refresh_usage_all, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const results = await tokenManager.fetchUsageForAllAttached({
        timeoutMs: config.usage.fetchTimeoutMs,
      });
      const entries = Object.values(results);
      const allFailed = entries.length > 0 && entries.every((r) => r === null);
      if (allFailed) {
        await postEphemeralFailure(client, body, REFRESH_BANNERS.allNull);
        return;
      }
      await postEphemeralCard(tokenManager, client, body);
    } catch (err) {
      logger.error('cct_refresh_usage_all failed', err);
      await postEphemeralFailure(client, body, REFRESH_BANNERS.outerCatch);
    }
  });

  // Per-slot "Refresh" — admin gate + `{ force: true }` bypasses the
  // local throttle for this single slot. When `fetchAndStoreUsage`
  // returns `null` (throttled or failed), post the same ephemeral banner
  // the Refresh-all handler uses for its all-null branch so the admin
  // sees actionable feedback instead of an unchanged re-render.
  app.action(CCT_ACTION_IDS.refresh_usage_slot, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const bodyAction = (body as any).actions?.[0];
      const targetKeyId = typeof bodyAction?.value === 'string' ? bodyAction.value : undefined;
      if (!targetKeyId) {
        logger.warn('cct_refresh_usage_slot: missing keyId on action value');
        return;
      }
      const result = await tokenManager.fetchAndStoreUsage(targetKeyId, { force: true });
      if (result === null) {
        await postEphemeralFailure(client, body, REFRESH_BANNERS.slotNull);
        return;
      }
      await postEphemeralCard(tokenManager, client, body);
    } catch (err) {
      logger.error('cct_refresh_usage_slot failed', err);
      await postEphemeralFailure(client, body, REFRESH_BANNERS.outerCatch);
    }
  });

  // View submission: Add slot.
  app.view(CCT_VIEW_IDS.add, async ({ ack, body, client }) => {
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
  app.view(CCT_VIEW_IDS.remove, async ({ ack, body, client }) => {
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

  // View submission: Rename slot.
  app.view(CCT_VIEW_IDS.rename, async ({ ack, body, client }) => {
    const values: Record<string, Record<string, any>> = (body as any)?.view?.state?.values ?? {};
    const newName = readPlainText(values, CCT_BLOCK_IDS.rename_name, CCT_ACTION_IDS.rename_input);
    if (!newName || newName.length > 64) {
      await ack({
        response_action: 'errors',
        errors: { [CCT_BLOCK_IDS.rename_name]: 'Name must be 1-64 characters.' },
      });
      return;
    }
    const clash = tokenManager.listTokens().some((t) => t.name === newName);
    if (clash) {
      await ack({
        response_action: 'errors',
        errors: { [CCT_BLOCK_IDS.rename_name]: `Name \`${newName}\` is already in use.` },
      });
      return;
    }
    try {
      const keyId = ((body as any)?.view?.private_metadata ?? '') as string;
      if (!keyId) {
        await ack();
        return;
      }
      await tokenManager.renameSlot(keyId, newName);
      await ack();
      await postEphemeralCard(tokenManager, client, body);
    } catch (err) {
      // Race-lost path: parallel rename landed the same name first.
      const msg = (err as Error)?.message ?? '';
      if (msg.startsWith('NAME_IN_USE:')) {
        await ack({
          response_action: 'errors',
          errors: { [CCT_BLOCK_IDS.rename_name]: `Name \`${newName}\` is already in use.` },
        });
        return;
      }
      await ack();
      logger.error('cct view_submission rename failed', err);
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
 * Ephemeral failure banner used by the refresh handlers when an
 * all-null / null result would otherwise re-render an identical card.
 */
async function postEphemeralFailure(client: WebClient, body: unknown, message: string): Promise<void> {
  const target = resolveEphemeralTarget(body);
  if (!target) return;
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

export async function buildCardFromManager(tokenManager: TokenManager): Promise<Record<string, unknown>[]> {
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
