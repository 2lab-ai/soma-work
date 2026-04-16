/**
 * Action + view handlers for `/z` Block Kit cards (Phase 2, #507).
 *
 * Registers on the Bolt app:
 *   - action  /^z_setting_(.+)_set_(.+)$/      — apply an option (e.g. set model=opus)
 *   - action  /^z_setting_(.+)_cancel$/        — dismiss the card
 *   - action  /^z_setting_(.+)_open_modal$/    — open a text-input modal
 *   - action  /^z_help_nav_(.+)$/              — render topic card
 *   - view    /^z_setting_(.+)_modal_submit$/  — apply submitted modal input
 *
 * Source-aware ZRespond reconstruction (MUST match original send surface):
 *   - DM      (container.channel_id starts with 'D')
 *             → DmZRespond.fromAction(body)  (branded botMessageTs from body.message.ts)
 *   - Channel/Slash (has body.response_url)
 *             → ChannelEphemeralZRespond with responseUrl bound
 *
 * Invariants (see plan/MASTER-SPEC.md §10 + §15):
 *   - ephemeral (slash/channel) replace → response_url + replace_original
 *     (NEVER chat.update)
 *   - DM replace → chat.update({ts: botMessageTs}) with branded ts
 *   - Missing response_url / botMessageTs → ZRespond.replace surfaces a
 *     "UI expired" notice, never a silent no-op.
 */

import type { App, RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import { ChannelEphemeralZRespond, DmZRespond, SlashZRespond } from '../z/respond';
import type { ZRespond } from '../z/types';

const logger = new Logger('ZSettingsActions');

/** Topic-scoped apply + card-render hooks wired into the action handler. */
export interface ZTopicBinding {
  /** Topic id (must match `z_setting_<topic>_set_<value>` regex). */
  topic: string;
  /**
   * Called when a user clicks a `z_setting_<topic>_set_<value>` button.
   * Return a human-readable confirmation summary on success. Throwing or
   * returning null produces the generic "applied" fallback.
   */
  apply(args: {
    userId: string;
    value: string;
    actionId: string;
    /** Full action body (for advanced handlers that need extras). */
    body: any;
  }): Promise<ApplyResult>;
  /**
   * Re-render the topic's setting card. Invoked on `z_help_nav_<topic>`.
   * Must return Block Kit blocks ready for replace().
   */
  renderCard(args: { userId: string; issuedAt: number }): Promise<RenderResult>;
  /**
   * Optional: handle an `z_setting_<topic>_open_modal` click → push a
   * `views.open` payload. Receives trigger_id + callback_id guidance.
   */
  openModal?(args: { client: WebClient; triggerId: string; body: any; userId: string }): Promise<void>;
  /**
   * Optional: handle a `z_setting_<topic>_modal_submit` view submission.
   * Return a confirmation summary; replace() isn't called for views, so the
   * handler is responsible for user-visible feedback (typically via DM or
   * postEphemeral on the response channel).
   */
  submitModal?(args: {
    client: WebClient;
    body: any;
    userId: string;
    values: Record<string, Record<string, any>>;
  }): Promise<void>;
}

export interface ApplyResult {
  /** If false, render an error card instead of a confirmation. */
  ok: boolean;
  /** Short header line (markdown ok). */
  summary: string;
  /** Optional longer markdown context. */
  description?: string;
  /** When true, the card is dismissed instead of replaced with confirmation. */
  dismiss?: boolean;
}

export interface RenderResult {
  text?: string;
  blocks: any[];
}

/* ------------------------------------------------------------------ *
 * ZRespond reconstruction from action/view bodies
 * ------------------------------------------------------------------ */

/**
 * Mint a ZRespond instance from the incoming action body.
 *
 * Chooses DM vs. ephemeral path based on container channel id and presence
 * of response_url.  Falls back to a `SlashZRespond` wrapper for slash-flow
 * cases that do not carry a channel_id container (rare but possible).
 */
export function respondFromActionBody(args: { body: any; client: WebClient; respond?: RespondFn }): ZRespond {
  const { body, client, respond } = args;
  const channelId: string | undefined = body?.container?.channel_id ?? body?.channel?.id;
  const isDm = channelId?.startsWith('D') === true;

  if (isDm) {
    return DmZRespond.fromAction(body, client);
  }

  const responseUrl: string | undefined = body?.response_url;
  if (responseUrl) {
    return new ChannelEphemeralZRespond({
      client,
      channel: channelId ?? '',
      user: body?.user?.id ?? '',
      threadTs: body?.container?.thread_ts ?? body?.message?.thread_ts,
      responseUrl,
    });
  }

  if (respond) {
    return new SlashZRespond(respond);
  }

  // Last-resort fallback — no response_url and not a DM. Build a
  // ChannelEphemeralZRespond without a responseUrl so `replace()` surfaces
  // the UI-expired notice instead of silently no-oping.
  return new ChannelEphemeralZRespond({
    client,
    channel: channelId ?? '',
    user: body?.user?.id ?? '',
  });
}

/* ------------------------------------------------------------------ *
 * Registry — plugged in by the bootstrap wire-up (event-router etc.)
 * ------------------------------------------------------------------ */

export class ZTopicRegistry {
  private bindings = new Map<string, ZTopicBinding>();

  register(binding: ZTopicBinding): void {
    this.bindings.set(binding.topic, binding);
  }

  get(topic: string): ZTopicBinding | undefined {
    return this.bindings.get(topic);
  }

  topics(): string[] {
    return [...this.bindings.keys()];
  }
}

/* ------------------------------------------------------------------ *
 * Handler class — owns the regex routes.
 * ------------------------------------------------------------------ */

export interface ZSettingsActionDeps {
  registry: ZTopicRegistry;
}

export class ZSettingsActionHandler {
  constructor(private readonly deps: ZSettingsActionDeps) {}

  register(app: App): void {
    app.action(/^z_setting_(.+)_set_(.+)$/, async ({ ack, body, client, respond }) => {
      await ack();
      await this.handleSet(body, client, respond);
    });

    app.action(/^z_setting_(.+)_cancel$/, async ({ ack, body, client, respond }) => {
      await ack();
      await this.handleCancel(body, client, respond);
    });

    app.action(/^z_setting_(.+)_open_modal$/, async ({ ack, body, client }) => {
      await ack();
      await this.handleOpenModal(body, client);
    });

    app.action(/^z_help_nav_(.+)$/, async ({ ack, body, client, respond }) => {
      await ack();
      await this.handleHelpNav(body, client, respond);
    });

    app.view(/^z_setting_(.+)_modal_submit$/, async ({ ack, body, client }) => {
      await ack();
      await this.handleModalSubmit(body, client);
    });
  }

  async handleSet(body: any, client: WebClient, respond?: RespondFn): Promise<void> {
    const action = body?.actions?.[0];
    const actionId: string | undefined = action?.action_id;
    if (!actionId) {
      logger.warn('z_setting_*_set_* dispatched without action_id');
      return;
    }
    const match = actionId.match(/^z_setting_(.+)_set_(.+)$/);
    if (!match) return;
    const [, topic, value] = match;
    const binding = this.deps.registry.get(topic);
    if (!binding) {
      logger.warn('Unknown topic for z_setting_*_set_*', { topic, actionId });
      return;
    }
    const userId: string = body?.user?.id ?? '';
    const zRespond = respondFromActionBody({ body, client, respond });

    try {
      const result = await binding.apply({ userId, value, actionId, body });
      if (result.dismiss) {
        await zRespond.dismiss();
        return;
      }
      const issuedAt = Date.now();
      const confirmation = await import('../z/ui-builder').then((m) =>
        m.buildConfirmationCard({
          topic,
          icon: result.ok ? '✅' : '❌',
          title: result.summary.split('\n')[0] || topic,
          summary: result.summary,
          description: result.description,
          issuedAt,
        }),
      );
      await zRespond.replace({
        text: result.summary,
        blocks: confirmation,
      });
    } catch (err) {
      logger.error('z_setting apply failed', {
        topic,
        value,
        err: (err as Error).message,
      });
      await zRespond.replace({
        text: `❌ ${(err as Error).message}`,
      });
    }
  }

  async handleCancel(body: any, client: WebClient, respond?: RespondFn): Promise<void> {
    const zRespond = respondFromActionBody({ body, client, respond });
    await zRespond.dismiss();
  }

  async handleOpenModal(body: any, client: WebClient): Promise<void> {
    const action = body?.actions?.[0];
    const actionId: string | undefined = action?.action_id;
    if (!actionId) return;
    const match = actionId.match(/^z_setting_(.+)_open_modal$/);
    if (!match) return;
    const [, topic] = match;
    const binding = this.deps.registry.get(topic);
    if (!binding?.openModal) {
      logger.warn('openModal not implemented for topic', { topic });
      return;
    }
    const triggerId: string = body?.trigger_id ?? '';
    const userId: string = body?.user?.id ?? '';
    try {
      await binding.openModal({ client, triggerId, body, userId });
    } catch (err) {
      logger.error('openModal failed', { topic, err: (err as Error).message });
    }
  }

  async handleHelpNav(body: any, client: WebClient, respond?: RespondFn): Promise<void> {
    const action = body?.actions?.[0];
    const actionId: string | undefined = action?.action_id;
    if (!actionId) return;
    const match = actionId.match(/^z_help_nav_(.+)$/);
    if (!match) return;
    const [, topic] = match;
    const binding = this.deps.registry.get(topic);
    if (!binding) {
      logger.warn('Unknown topic for z_help_nav_*', { topic, actionId });
      return;
    }
    const zRespond = respondFromActionBody({ body, client, respond });
    try {
      const { blocks, text } = await binding.renderCard({
        userId: body?.user?.id ?? '',
        issuedAt: Date.now(),
      });
      await zRespond.replace({ text, blocks });
    } catch (err) {
      logger.error('renderCard failed', { topic, err: (err as Error).message });
      await zRespond.replace({
        text: `❌ ${topic} 카드 로드 실패: ${(err as Error).message}`,
      });
    }
  }

  async handleModalSubmit(body: any, client: WebClient): Promise<void> {
    const callbackId: string | undefined = body?.view?.callback_id;
    if (!callbackId) return;
    const match = callbackId.match(/^z_setting_(.+)_modal_submit$/);
    if (!match) return;
    const [, topic] = match;
    const binding = this.deps.registry.get(topic);
    if (!binding?.submitModal) {
      logger.warn('submitModal not implemented for topic', { topic });
      return;
    }
    const userId: string = body?.user?.id ?? '';
    const values: Record<string, Record<string, any>> = body?.view?.state?.values ?? {};
    try {
      await binding.submitModal({ client, body, userId, values });
    } catch (err) {
      logger.error('submitModal failed', { topic, err: (err as Error).message });
    }
  }
}
