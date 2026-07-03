/**
 * Auth card block_action / view_submission handlers (#llmux runtime switch).
 *
 * Registered routes:
 *   action  auth_mode_switch_(llmux|ccp)  → flip runtime auth mode + re-render
 *   action  auth_llmux_switch_account     → POST /llmux/switch + re-render
 *   action  auth_llmux_open_add           → open Add-account modal
 *   action  auth_llmux_open_remove        → open Remove confirm modal
 *   action  auth_llmux_open_settings      → open Settings modal
 *   action  auth_refresh                  → re-render with fresh /llmux/status
 *   view    auth_llmux_add_account        → POST /llmux/add-account
 *   view    auth_llmux_remove_account     → POST /llmux/remove-account
 *   view    auth_llmux_settings           → setLlmuxSettings (validated probe)
 *
 * Ack contract: every handler calls `ack()` within 3 seconds; llmux HTTP
 * work happens after ack. Mutating routes are admin-gated server-side
 * (`requireAdmin`) — hiding the buttons for readonly viewers is UX, not
 * security.
 *
 * Card re-render: button actions go through `renderInPlace` (same surface-
 * aware update path as the CCT card, #803). Modal submissions carry the
 * originating card surface in `private_metadata` (`{channel, ts}`) and
 * `chat.update` it directly — Slack gives view submissions no `respond`.
 */

import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { isAdminUser } from '../../admin-utils';
import { getAuthRuntimeSnapshot, setLlmuxSettings } from '../../auth/auth-runtime';
import {
  addLlmuxAccount,
  isLlmuxUp,
  LlmuxClientError,
  removeLlmuxAccount,
  switchLlmuxAccount,
} from '../../auth/llmux-client';
import { Logger } from '../../logger';
import { renderInPlace } from '../cct/render-in-place';
import { applyAuthMode, renderAuthCard } from '../z/topics/auth-topic';
import { buildLlmuxAddAccountModal, buildLlmuxRemoveAccountModal, buildLlmuxSettingsModal } from './builder';
import { AUTH_ACTION_IDS, AUTH_BLOCK_IDS, AUTH_VIEW_IDS } from './views';

const logger = new Logger('AuthActions');

function actorId(body: unknown): string | undefined {
  return (body as { user?: { id?: string } })?.user?.id;
}

/** Admin gate — logs and swallows non-admin clicks on mutating routes. */
function requireAdmin(body: unknown): boolean {
  const userId = actorId(body);
  const admin = userId !== undefined && isAdminUser(userId);
  if (!admin) logger.warn(`auth action denied for non-admin user ${userId ?? '(unknown)'}`);
  return admin;
}

/** Card surface (channel/ts) from an action body, for modal private_metadata. */
function cardSurface(body: unknown): { channel?: string; ts?: string } {
  const b = body as {
    container?: { channel_id?: string; message_ts?: string };
    channel?: { id?: string };
    message?: { ts?: string };
  };
  return {
    channel: b.container?.channel_id ?? b.channel?.id,
    ts: b.container?.message_ts ?? b.message?.ts,
  };
}

/** Re-render the auth card in place after a button action. */
async function rerenderCard(args: {
  body: unknown;
  client: WebClient;
  respond?: (msg: Record<string, unknown>) => Promise<unknown>;
  userId: string;
  banner?: string;
}): Promise<void> {
  const { text, blocks } = await renderAuthCard({ userId: args.userId, issuedAt: Date.now() });
  if (args.banner) {
    blocks.unshift({
      type: 'section',
      text: { type: 'mrkdwn', text: args.banner },
    });
  }
  await renderInPlace({
    body: args.body as Parameters<typeof renderInPlace>[0]['body'],
    client: args.client,
    respond: args.respond,
    text: text ?? '🔐 Auth',
    renderMessageBlocks: () => blocks,
    renderEphemeralBlocks: () => blocks,
  });
}

/** Re-render the auth card at a known surface (view-submission path). */
async function rerenderCardAt(
  client: WebClient,
  surface: { channel?: string; ts?: string },
  userId: string,
  banner?: string,
): Promise<void> {
  if (!surface.channel || !surface.ts) return;
  try {
    const { text, blocks } = await renderAuthCard({ userId, issuedAt: Date.now() });
    if (banner) blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: banner } });
    await client.chat.update({ channel: surface.channel, ts: surface.ts, text: text ?? '🔐 Auth', blocks });
  } catch (err) {
    logger.warn(`auth card update failed: ${(err as Error).message}`);
  }
}

function parseSurfaceMetadata(raw: string | undefined): { channel?: string; ts?: string; name?: string } {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as { channel?: string; ts?: string; name?: string };
  } catch {
    return {};
  }
}

/** Input value helper for modal state. */
function viewValue(body: unknown, blockId: string): string | undefined {
  const values = (body as { view?: { state?: { values?: Record<string, Record<string, { value?: string }>> } } })?.view
    ?.state?.values;
  const v = values?.[blockId]?.value?.value;
  return typeof v === 'string' ? v.trim() : undefined;
}

export function registerAuthActions(app: App): void {
  // ── Mode switch (llmux | ccp) ────────────────────────────────────
  app.action(new RegExp(`^${AUTH_ACTION_IDS.mode}_(llmux|ccp)$`), async ({ ack, body, client, respond }) => {
    await ack();
    try {
      const userId = actorId(body);
      if (!userId || !requireAdmin(body)) return;
      const raw = (body as { actions?: Array<{ value?: string }> })?.actions?.[0]?.value;
      const mode = raw === 'llmux' ? 'llmux' : 'ccp';
      const result = await applyAuthMode({ userId, mode });
      await rerenderCard({
        body,
        client,
        respond: respond as (msg: Record<string, unknown>) => Promise<unknown>,
        userId,
        banner: result.ok ? result.summary : `${result.summary}${result.description ? `\n${result.description}` : ''}`,
      });
    } catch (err) {
      logger.error('auth_mode_switch failed', err);
    }
  });

  // ── Manual llmux account switch ─────────────────────────────────
  app.action(AUTH_ACTION_IDS.switch, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      const userId = actorId(body);
      if (!userId || !requireAdmin(body)) return;
      const account = (body as { actions?: Array<{ value?: string }> })?.actions?.[0]?.value;
      if (!account) return;
      let banner: string;
      try {
        const result = await switchLlmuxAccount(account);
        banner = `🔀 Switched llmux account → *${result.current}*`;
      } catch (err) {
        // 409 = scheduler refusal (ineligible / unknown) — surface its reason.
        banner = `❌ Switch failed: ${err instanceof LlmuxClientError ? err.message : String(err)}`;
      }
      await rerenderCard({
        body,
        client,
        respond: respond as (msg: Record<string, unknown>) => Promise<unknown>,
        userId,
        banner,
      });
    } catch (err) {
      logger.error('auth_llmux_switch_account failed', err);
    }
  });

  // ── Refresh (allowed for readonly viewers — GET /llmux/status only) ─
  app.action(AUTH_ACTION_IDS.refresh, async ({ ack, body, client, respond }) => {
    await ack();
    try {
      const userId = actorId(body);
      if (!userId) return;
      await rerenderCard({
        body,
        client,
        respond: respond as (msg: Record<string, unknown>) => Promise<unknown>,
        userId,
      });
    } catch (err) {
      logger.error('auth_refresh failed', err);
    }
  });

  // ── Open modals ─────────────────────────────────────────────────
  app.action(AUTH_ACTION_IDS.settings, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const triggerId = (body as { trigger_id?: string })?.trigger_id;
      if (!triggerId) return;
      const metadata = JSON.stringify(cardSurface(body));
      await client.views.open({
        trigger_id: triggerId,
        view: buildLlmuxSettingsModal(getAuthRuntimeSnapshot(), metadata) as never,
      });
    } catch (err) {
      logger.error('auth_llmux_open_settings failed', err);
    }
  });

  app.action(AUTH_ACTION_IDS.add, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const triggerId = (body as { trigger_id?: string })?.trigger_id;
      if (!triggerId) return;
      const metadata = JSON.stringify(cardSurface(body));
      await client.views.open({ trigger_id: triggerId, view: buildLlmuxAddAccountModal(metadata) as never });
    } catch (err) {
      logger.error('auth_llmux_open_add failed', err);
    }
  });

  app.action(AUTH_ACTION_IDS.remove, async ({ ack, body, client }) => {
    await ack();
    try {
      if (!requireAdmin(body)) return;
      const triggerId = (body as { trigger_id?: string })?.trigger_id;
      const name = (body as { actions?: Array<{ value?: string }> })?.actions?.[0]?.value;
      if (!triggerId || !name) return;
      const metadata = JSON.stringify({ ...cardSurface(body), name });
      await client.views.open({
        trigger_id: triggerId,
        view: buildLlmuxRemoveAccountModal(name, metadata) as never,
      });
    } catch (err) {
      logger.error('auth_llmux_open_remove failed', err);
    }
  });

  // ── View submission: Settings ───────────────────────────────────
  app.view(AUTH_VIEW_IDS.settings, async ({ ack, body, client }) => {
    if (!requireAdmin(body)) {
      await ack();
      return;
    }
    const baseUrl = viewValue(body, AUTH_BLOCK_IDS.settings_base_url);
    const apiKey = viewValue(body, AUTH_BLOCK_IDS.settings_api_key);
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      await ack({
        response_action: 'errors',
        errors: { [AUTH_BLOCK_IDS.settings_base_url]: 'Base URL must start with http:// or https://' },
      } as never);
      return;
    }
    await ack();
    try {
      // Probe the CANDIDATE URL before persisting — a typo here must not
      // silently break every llmux dispatch. Unreachable → persist anyway
      // (operator may be pre-configuring), but banner the warning.
      const reachable = await isLlmuxUp(baseUrl);
      setLlmuxSettings({ baseUrl, apiKey: apiKey || undefined });
      const userId = actorId(body) ?? '';
      const surface = parseSurfaceMetadata((body as { view?: { private_metadata?: string } })?.view?.private_metadata);
      const banner = reachable
        ? `⚙️ llmux settings saved — \`${baseUrl}\` reachable ✅`
        : `⚙️ llmux settings saved — ⚠️ \`${baseUrl}\` is not answering yet`;
      await rerenderCardAt(client, surface, userId, banner);
    } catch (err) {
      logger.error('auth view_submission settings failed', err);
    }
  });

  // ── View submission: Add account ────────────────────────────────
  app.view(AUTH_VIEW_IDS.add, async ({ ack, body, client }) => {
    if (!requireAdmin(body)) {
      await ack();
      return;
    }
    const apiKey = viewValue(body, AUTH_BLOCK_IDS.add_api_key);
    const name = viewValue(body, AUTH_BLOCK_IDS.add_name);
    if (!apiKey) {
      await ack({
        response_action: 'errors',
        errors: { [AUTH_BLOCK_IDS.add_api_key]: 'API key is required.' },
      } as never);
      return;
    }
    await ack();
    try {
      const userId = actorId(body) ?? '';
      const surface = parseSurfaceMetadata((body as { view?: { private_metadata?: string } })?.view?.private_metadata);
      let banner: string;
      try {
        const result = await addLlmuxAccount({ apiKey, name: name || undefined });
        banner = `➕ llmux account *${result.name}* ${result.added ? 'added' : 'updated'} (${result.type})`;
      } catch (err) {
        banner = `❌ Add failed: ${err instanceof LlmuxClientError ? err.message : String(err)}`;
      }
      await rerenderCardAt(client, surface, userId, banner);
    } catch (err) {
      logger.error('auth view_submission add failed', err);
    }
  });

  // ── View submission: Remove account ─────────────────────────────
  app.view(AUTH_VIEW_IDS.remove, async ({ ack, body, client }) => {
    if (!requireAdmin(body)) {
      await ack();
      return;
    }
    await ack();
    try {
      const userId = actorId(body) ?? '';
      const metadata = parseSurfaceMetadata((body as { view?: { private_metadata?: string } })?.view?.private_metadata);
      if (!metadata.name) return;
      let banner: string;
      try {
        await removeLlmuxAccount(metadata.name);
        banner = `🗑️ llmux account *${metadata.name}* removed`;
      } catch (err) {
        banner = `❌ Remove failed: ${err instanceof LlmuxClientError ? err.message : String(err)}`;
      }
      await rerenderCardAt(client, metadata, userId, banner);
    } catch (err) {
      logger.error('auth view_submission remove failed', err);
    }
  });
}
