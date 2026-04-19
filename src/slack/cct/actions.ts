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
import { Logger } from '../../logger';
import type { OAuthCredentials } from '../../oauth/refresher';
import { hasRequiredScopes } from '../../oauth/scope-check';
import type { TokenManager } from '../../token-manager';
import { buildAddSlotModal, buildCctCardBlocks, buildRemoveSlotModal, buildRenameSlotModal } from './builder';
import { CCT_ACTION_IDS, CCT_BLOCK_IDS, CCT_VIEW_IDS } from './views';

const logger = new Logger('CctActions');

const SETUP_TOKEN_REGEX = /^sk-ant-oat01-[A-Za-z0-9_-]{8,}$/;

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
      const kind = selected === 'oauth_credentials' ? 'oauth_credentials' : 'setup_token';
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

async function postEphemeralCard(tokenManager: TokenManager, client: WebClient, body: unknown): Promise<void> {
  const userId = (body as any)?.user?.id as string | undefined;
  const channel = (body as any)?.container?.channel_id ?? (body as any)?.channel?.id;
  if (!userId || !channel) return;
  const blocks = await buildCardFromManager(tokenManager);
  try {
    await client.chat.postEphemeral({
      channel,
      user: userId,
      text: ':key: CCT status',
      blocks: blocks as any,
    });
  } catch (err) {
    logger.debug('postEphemeralCard failed', { err });
  }
}

export async function buildCardFromManager(tokenManager: TokenManager): Promise<Record<string, unknown>[]> {
  // Always load the authoritative snapshot so post-action ephemeral cards
  // reflect current per-slot state (rate-limit timestamps, usage, cooldown)
  // rather than rendering with an empty `states` map.
  try {
    const snap = await tokenManager.getSnapshot();
    return buildCctCardBlocks({
      slots: snap.registry.slots,
      states: snap.state ?? {},
      activeKeyId: snap.registry.activeKeyId,
      nowMs: Date.now(),
    });
  } catch (err) {
    logger.warn('buildCardFromManager: getSnapshot failed, falling back to listTokens()', { err });
    const summaries = tokenManager.listTokens();
    const active = tokenManager.getActiveToken();
    // The summary shape lacks the full AuthKey surface, so we reconstruct
    // minimal AuthKey-ish objects for the fallback card. This path runs
    // only when getSnapshot fails (disk corruption / unreadable file),
    // which should be rare.
    const slots: AuthKey[] = summaries.map((s) =>
      s.kind === 'api_key'
        ? { kind: 'api_key', keyId: s.keyId, name: s.name, value: '', createdAt: '' }
        : { kind: 'cct', source: 'setup', keyId: s.keyId, name: s.name, setupToken: '', createdAt: '' },
    );
    return buildCctCardBlocks({
      slots,
      states: {},
      activeKeyId: active?.keyId,
    });
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
