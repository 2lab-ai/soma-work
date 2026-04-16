/**
 * `ZRespond` implementations — 3 response strategies for the `/z` entry points.
 *
 * Invariants (see plan/MASTER-SPEC.md §5-3, §10):
 *  - Ephemeral (slash / channel) NEVER uses `chat.update`.
 *  - `SlashZRespond.replace` uses `response_url + replace_original:true`.
 *  - `ChannelEphemeralZRespond.replace` requires a per-action `response_url`.
 *  - `DmZRespond.replace` uses `client.chat.update` with a **branded**
 *    `BotMessageTs` — user message ts cannot be passed here at the type level.
 *  - When a required URL/ts is missing on `replace()` we MUST send a visible
 *    "⚠️ UI가 만료됐습니다. `/z <topic>`으로 다시 열어주세요." notice rather
 *    than silently no-op — `replace` is always a visible mutation, so silent
 *    failure breaks the contract.
 *  - `dismiss()` is treated as an "already closed" semantic when the resource
 *    (responseUrl / botMessageTs) is missing — silent no-op is correct UX
 *    (the user wanted to close; it IS closed, or already was). Missing
 *    resources are logged at `info` level with the `ZRESPOND_DISMISS_NOOP`
 *    tag so ops can detect misuse. See FIX #4 in PR #509.
 */

import type { RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';
import type { BotMessageTs, ZBlock, ZRespond, ZSource } from './types';

const logger = new Logger('ZRespond');

const UI_EXPIRED_MSG = '⚠️ UI가 만료됐습니다. `/z <topic>`으로 다시 열어주세요.';

/* ------------------------------------------------------------------ *
 * SlashZRespond
 * ------------------------------------------------------------------ */

export class SlashZRespond implements ZRespond {
  readonly source: ZSource = 'slash';

  constructor(private readonly respondFn: RespondFn) {}

  async send(opts: { text?: string; blocks?: ZBlock[]; ephemeral?: boolean }): Promise<{ ts?: string }> {
    await this.respondFn({
      response_type: opts.ephemeral === false ? 'in_channel' : 'ephemeral',
      text: opts.text,
      blocks: opts.blocks as any,
    });
    // Slash respond() does not return a ts.
    return {};
  }

  async replace(opts: { text?: string; blocks?: ZBlock[] }): Promise<void> {
    try {
      await this.respondFn({
        response_type: 'ephemeral',
        replace_original: true,
        text: opts.text,
        blocks: opts.blocks as any,
      });
    } catch (err) {
      logger.warn('SlashZRespond.replace failed, surfacing UI-expired notice', {
        err: (err as Error).message,
      });
      await this.send({ text: UI_EXPIRED_MSG, ephemeral: true });
    }
  }

  /**
   * dismiss(): silent-on-missing-resource contract.
   * SlashZRespond always has a respondFn so there's no "missing" case, but
   * respondFn throwing is treated as "already closed / UI expired" — we log
   * at warn level but do NOT send a user-facing fallback. Replace() is the
   * visible path; dismiss is a user intent to close. See FIX #4.
   */
  async dismiss(): Promise<void> {
    try {
      await this.respondFn({
        response_type: 'ephemeral',
        delete_original: true,
        text: '',
      });
    } catch (err) {
      logger.warn('SlashZRespond.dismiss failed', {
        err: (err as Error).message,
        tag: 'ZRESPOND_DISMISS_NOOP',
      });
      // Non-critical — no user-facing fallback needed.
    }
  }
}

/* ------------------------------------------------------------------ *
 * ChannelEphemeralZRespond
 * ------------------------------------------------------------------ */

export interface ChannelEphemeralDeps {
  client: WebClient;
  channel: string;
  user: string;
  threadTs?: string;
  /** response_url captured from a button action; optional on initial send. */
  responseUrl?: string;
}

export class ChannelEphemeralZRespond implements ZRespond {
  readonly source: ZSource = 'channel_mention';

  constructor(private deps: ChannelEphemeralDeps) {}

  /** Allow routers to rebind the `response_url` after a button click. */
  setResponseUrl(url: string | undefined): void {
    this.deps = { ...this.deps, responseUrl: url };
  }

  async send(opts: { text?: string; blocks?: ZBlock[]; ephemeral?: boolean }): Promise<{ ts?: string }> {
    const { client, channel, user, threadTs } = this.deps;
    try {
      const res = await client.chat.postEphemeral({
        channel,
        user,
        text: opts.text ?? '',
        blocks: opts.blocks as any,
        thread_ts: threadTs,
      });
      return { ts: (res as any).message_ts };
    } catch (err) {
      const code = (err as any)?.data?.error ?? (err as Error).message;
      const permissionLike = ['user_not_in_channel', 'channel_not_found', 'user_not_found', 'not_in_channel'];
      if (permissionLike.includes(code)) {
        logger.info('postEphemeral rejected, falling back to DM', { channel, user, code });
        const res = await client.chat.postMessage({
          channel: user,
          text: opts.text ?? '',
          blocks: opts.blocks as any,
        });
        return { ts: (res as any).ts };
      }
      throw err;
    }
  }

  async replace(opts: { text?: string; blocks?: ZBlock[] }): Promise<void> {
    if (!this.deps.responseUrl) {
      logger.warn('ChannelEphemeralZRespond.replace missing response_url — surfacing UI-expired notice');
      await this.send({ text: UI_EXPIRED_MSG, ephemeral: true });
      return;
    }
    try {
      await postToResponseUrl(this.deps.responseUrl, {
        replace_original: true,
        response_type: 'ephemeral',
        text: opts.text,
        blocks: opts.blocks,
      });
    } catch (err) {
      logger.warn('ChannelEphemeralZRespond.replace failed', { err: (err as Error).message });
      await this.send({ text: UI_EXPIRED_MSG, ephemeral: true });
    }
  }

  /**
   * dismiss(): silent-on-missing-response_url contract.
   * When `responseUrl` is absent the UI was never posted via an interactive
   * flow (or has expired) — treating this as "already closed" is the natural
   * UX. We emit an info log with the `ZRESPOND_DISMISS_NOOP` tag so ops can
   * detect unintended misuse. See FIX #4 in PR #509.
   */
  async dismiss(): Promise<void> {
    if (!this.deps.responseUrl) {
      logger.info('ChannelEphemeralZRespond.dismiss: no response_url — treating as already-closed', {
        channel: this.deps.channel,
        user: this.deps.user,
        tag: 'ZRESPOND_DISMISS_NOOP',
      });
      return;
    }
    try {
      await postToResponseUrl(this.deps.responseUrl, {
        delete_original: true,
      });
    } catch (err) {
      logger.warn('ChannelEphemeralZRespond.dismiss failed', {
        err: (err as Error).message,
        tag: 'ZRESPOND_DISMISS_NOOP',
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * DmZRespond
 * ------------------------------------------------------------------ */

export interface DmZRespondDeps {
  client: WebClient;
  channel: string; // the DM channel id
  /**
   * Bot message ts — set after initial `send()` returns. Branded so callers
   * cannot accidentally pass a user message ts into `chat.update`.
   */
  botMessageTs?: BotMessageTs;
}

export class DmZRespond implements ZRespond {
  readonly source: ZSource = 'dm';

  constructor(private deps: DmZRespondDeps) {}

  async send(opts: { text?: string; blocks?: ZBlock[]; ephemeral?: boolean }): Promise<{ ts?: string }> {
    const { client, channel } = this.deps;
    const res = await client.chat.postMessage({
      channel,
      text: opts.text ?? '',
      blocks: opts.blocks as any,
    });
    const ts = (res as any).ts as string | undefined;
    if (ts) {
      // Mint the branded token — only DmZRespond may produce BotMessageTs.
      this.deps.botMessageTs = ts as BotMessageTs;
    }
    return { ts };
  }

  async replace(opts: { text?: string; blocks?: ZBlock[] }): Promise<void> {
    const { client, channel, botMessageTs } = this.deps;
    if (!botMessageTs) {
      logger.warn('DmZRespond.replace missing botMessageTs — surfacing UI-expired notice');
      await this.send({ text: UI_EXPIRED_MSG });
      return;
    }
    try {
      await client.chat.update({
        channel,
        ts: botMessageTs, // branded — guaranteed by construction
        text: opts.text ?? '',
        blocks: opts.blocks as any,
      });
    } catch (err) {
      logger.warn('DmZRespond.replace failed', { err: (err as Error).message });
      await this.send({ text: UI_EXPIRED_MSG });
    }
  }

  /**
   * dismiss(): silent-on-missing-botMessageTs contract.
   * Without a stored bot message ts there is nothing to delete — treating
   * this as "already closed" is the natural UX. We emit an info log with
   * the `ZRESPOND_DISMISS_NOOP` tag so ops can detect unintended misuse.
   * See FIX #4 in PR #509.
   */
  async dismiss(): Promise<void> {
    const { client, channel, botMessageTs } = this.deps;
    if (!botMessageTs) {
      logger.info('DmZRespond.dismiss: no botMessageTs — treating as already-closed', {
        channel,
        tag: 'ZRESPOND_DISMISS_NOOP',
      });
      return;
    }
    try {
      await client.chat.delete({ channel, ts: botMessageTs });
      this.deps = { ...this.deps, botMessageTs: undefined };
    } catch (err) {
      logger.warn('DmZRespond.dismiss failed', {
        err: (err as Error).message,
        tag: 'ZRESPOND_DISMISS_NOOP',
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function postToResponseUrl(
  url: string,
  payload: {
    response_type?: 'ephemeral' | 'in_channel';
    replace_original?: boolean;
    delete_original?: boolean;
    text?: string;
    blocks?: ZBlock[];
  },
): Promise<void> {
  // Uses global `fetch` — available in Node 18+.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`response_url POST failed: ${res.status} ${res.statusText}`);
  }
}
