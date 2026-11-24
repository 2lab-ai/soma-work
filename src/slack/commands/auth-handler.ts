import { isAdminUser } from '../../admin-utils';
import { getAuthMode, getLlmuxSettings } from '../../auth/auth-runtime';
import { switchLlmuxAccount } from '../../auth/llmux-client';
import { advertisedLlmuxBaseUrl, buildLlmuxKeyDmText } from '../../auth/llmux-key-info';
import {
  checkTenantKey,
  describeTenantKey,
  ensureTenantKey,
  rotateTenantKey,
  type TenantKeyLease,
} from '../../auth/llmux-tenant-keys';
import { CommandParser } from '../command-parser';
import { deliverImageCard, type FilesUploadClient, slackImageUploader } from '../slack-file-image';
import { applyAuthMode, renderAuthCard } from '../z/topics/auth-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * The slice of CommandDependencies the `key` DM path needs. Optional — the
 * handler still serves the card-only commands without them.
 */
export interface AuthHandlerDeps {
  slackApi?: {
    openDmChannel(userId: string): Promise<string>;
    postMessage(channel: string, text: string, options?: unknown): Promise<{ ts?: string; channel?: string }>;
    /** This bot's client — uploads the card's summary picture (the same bot posts the card). */
    getClient?(): FilesUploadClient;
  };
  userSettingsStore?: {
    getUserSettings(userId: string): { slackName?: string; email?: string } | undefined;
  };
}

/**
 * Handles auth backend commands (#llmux runtime switch):
 *   - `auth`                     — show the auth card (mode + llmux pool /
 *                                  legacy cct card). Everyone starts with
 *                                  the readonly overview; admins can open
 *                                  management controls via Admin mode.
 *   - `auth llmux` / `auth cct`  — flip the runtime auth mode (admin only).
 *     (`set auth llmux|cct` is an accepted alias.)
 *   - `auth switch <name>`       — llmux manual account switch (admin only).
 *   - `auth key` / bare `key`    — DM the caller their personal llmux client
 *                                  key + local Claude Code / Codex setup (any user:
 *                                  it is THEIR key; llmux meters them by it).
 *   - `auth key rotate` / `key rotate` — revoke the caller's current secret and
 *                                  DM a new one (any user, their own key only).
 *
 * llmux settings (`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`) and account
 * add/remove are card-modal only — secrets must not transit chat text. The
 * `key` DM is the one sanctioned secret delivery: user-scoped, DM-only, and
 * the channel-side confirmation never carries the secret.
 */
export class AuthHandler implements CommandHandler {
  constructor(private readonly deps?: AuthHandlerDeps) {}

  canHandle(text: string): boolean {
    return CommandParser.isAuthCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseAuthCommand(text);

    if (action.action === 'key') {
      return this.executeKey(ctx, 'show');
    }
    if (action.action === 'key-rotate') {
      return this.executeKey(ctx, 'rotate');
    }

    const denyNonAdmin = async (): Promise<CommandResult> => {
      await say({ text: '⛔ Admin only command', thread_ts: threadTs });
      return { handled: true };
    };

    if (action.action === 'set-mode') {
      if (!isAdminUser(user)) return denyNonAdmin();
      const result = await applyAuthMode({ userId: user, mode: action.mode });
      const detail = result.description ? `\n${result.description}` : '';
      await say({ text: `${result.summary}${detail}`, thread_ts: threadTs });
      return { handled: true };
    }

    if (action.action === 'switch') {
      if (!isAdminUser(user)) return denyNonAdmin();
      try {
        const result = await switchLlmuxAccount(action.target);
        await say({ text: `🔀 llmux account → *${result.current}*`, thread_ts: threadTs });
      } catch (err) {
        await say({ text: `❌ Switch failed: ${(err as Error).message}`, thread_ts: threadTs });
      }
      return { handled: true };
    }

    // Status always starts in overview, including for admins. Management
    // controls require the renderer's explicit, authorized Admin mode action.
    // The overview leads with the summary picture when this bot can upload it;
    // Slack refusing the fresh file still lands the text card (deliverImageCard).
    const client = this.deps?.slackApi?.getClient?.();
    const card = await renderAuthCard({
      userId: user,
      issuedAt: Date.now(),
      ...(client ? { uploadImage: slackImageUploader(client) } : {}),
    });
    await deliverImageCard(card, (blocks) =>
      say({ text: card.text ?? '🔐 Auth', blocks: blocks as never, thread_ts: threadTs }),
    );
    return { handled: true };
  }

  /**
   * `key` / `key rotate` — DM the caller their llmux client key with local
   * Claude Code / Codex / llmux CLI setup.
   *
   * - `show`: issue-or-reuse via `ensureTenantKey` (the SAME user gets the SAME
   *   key per daemon). Before sending, llmux is asked whether it still accepts
   *   the stored secret: a key rotated outside soma-work (`llmux key rotate`)
   *   is dead, so it is NOT sent — the user is told to run `key rotate`; a key
   *   an admin revoked sends the user to the admin.
   * - `rotate`: `rotateTenantKey` revokes the current secret and stores a new
   *   one under the same llmux id; only the new secret is DMed. The address the
   *   DM advertises is resolved FIRST — rotating and then failing to say where
   *   to use the new key would only kill the old one.
   */
  private async executeKey(ctx: CommandContext, mode: 'show' | 'rotate'): Promise<CommandResult> {
    const { user, channel, threadTs, say } = ctx;

    if (getAuthMode() !== 'llmux') {
      await say({
        text: '❌ 지금은 llmux 모드가 아닙니다 — 클라이언트 키는 `auth llmux` 상태에서만 발급됩니다.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const slackApi = this.deps?.slackApi;
    if (!slackApi) {
      await say({ text: '❌ DM 발송 경로가 구성되지 않았습니다 (slackApi 미주입).', thread_ts: threadTs });
      return { handled: true };
    }

    const noAddress = async (): Promise<CommandResult> => {
      await say({
        text: '❌ 이 봇 호스트에서 외부에서 접근 가능한 IP를 찾지 못했습니다 — 운영자가 `LLMUX_ADVERTISED_BASE_URL`을 설정해야 합니다.',
        thread_ts: threadTs,
      });
      return { handled: true };
    };
    const revokedByAdmin = async (): Promise<CommandResult> => {
      await say({
        text: '⛔ 당신의 llmux 키는 관리자가 폐기했습니다 — `key rotate`로는 되살릴 수 없습니다. 새 키가 필요하면 관리자에게 요청하세요.',
        thread_ts: threadTs,
      });
      return { handled: true };
    };

    const settings = this.deps?.userSettingsStore?.getUserSettings(user);
    const profile = { name: settings?.slackName, email: settings?.email };
    let lease: TenantKeyLease | null;
    if (mode === 'rotate') {
      if (!(await advertisedLlmuxBaseUrl(getLlmuxSettings().baseUrl))) return noAddress();
      const rotated = await rotateTenantKey(user, profile);
      if (!rotated.ok) {
        if (rotated.reason === 'revoked') return revokedByAdmin();
        await say({
          text: '❌ llmux 키 교체에 실패했습니다 — 기존 키는 그대로입니다. 잠시 후 `key rotate`를 다시 보내주세요 (계속 실패하면 `auth` 카드로 데몬 상태를 확인).',
          thread_ts: threadTs,
        });
        return { handled: true };
      }
      lease = rotated.lease;
    } else {
      lease = await ensureTenantKey(user, profile);
      if (!lease) {
        await say({
          text: '❌ llmux 키 발급에 실패했습니다 — 데몬 상태를 확인해주세요 (`auth` 카드). 잠시 후 다시 시도하면 재발급을 시도합니다.',
          thread_ts: threadTs,
        });
        return { handled: true };
      }
      const health = await checkTenantKey(user);
      if (health === 'revoked') return revokedByAdmin();
      if (health === 'stale') {
        await say({
          text: '⚠️ 봇이 가진 당신의 llmux 키는 llmux에서 이미 교체되어 401(`Invalid proxy API key`)을 받습니다 (봇 밖에서 로테이션됨). `key rotate`를 보내면 새 키를 DM으로 받습니다.',
          thread_ts: threadTs,
        });
        return { handled: true };
      }
    }

    // IP-only contract: never DM a hostname a plain-office-network client
    // can't resolve. No determinable IP is an operator problem, not a card.
    // (`rotate` already checked this before rotating; the lease's own daemon is
    // re-resolved here because the secret is only valid there.)
    const advertised = await advertisedLlmuxBaseUrl(lease.baseUrl);
    if (!advertised) {
      if (mode === 'show') return noAddress();
      await say({
        text: '❌ 키는 교체됐지만 외부에서 접근 가능한 IP를 찾지 못해 DM을 보내지 못했습니다 — 이전 키는 이미 폐기됐습니다. 운영자가 `LLMUX_ADVERTISED_BASE_URL`을 설정한 뒤 `key`를 보내면 새 키를 받습니다.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const meta = describeTenantKey(user);
    const dmText = buildLlmuxKeyDmText({
      secret: lease.secret,
      baseUrl: advertised,
      ...(meta?.id ? { keyId: meta.id } : {}),
      ...(meta?.name ? { keyName: meta.name } : {}),
      ...(meta?.issuedAtMs ? { issuedAtMs: meta.issuedAtMs } : {}),
      ...(meta?.rotatedAtMs ? { rotatedAtMs: meta.rotatedAtMs } : {}),
      ...(mode === 'rotate' ? { rotatedNow: true } : {}),
    });

    // Secret-safe error boundary: `dmText` carries the plaintext key, so a
    // rejection from the Slack calls must NOT propagate to callers that might
    // serialize handler state into logs or chat. The error is deliberately
    // swallowed (constant user-facing reply, no diagnostics emitted here) —
    // and the console redaction layer additionally masks any `lmk-…` that
    // would slip through a future logging path.
    try {
      const dmChannel = await slackApi.openDmChannel(user);
      await slackApi.postMessage(dmChannel, dmText);

      // Invoked from a channel → confirm there WITHOUT the secret. Invoked
      // from the DM itself → the key message above IS the response.
      if (channel !== dmChannel) {
        await say({
          text:
            mode === 'rotate'
              ? '🔑 llmux 키를 새 키로 교체했습니다 — 이전 키는 폐기됐고, 새 키와 사용법을 DM으로 보냈습니다.'
              : '🔑 llmux 키와 로컬 Claude Code / Codex 사용법을 DM으로 보냈습니다.',
          thread_ts: threadTs,
        });
      }
    } catch {
      await say({
        text:
          mode === 'rotate'
            ? '❌ 키는 교체됐지만 DM 발송에 실패했습니다 — 이전 키는 이미 폐기됐습니다. 봇과의 DM이 열려 있는지 확인한 뒤 `key`를 보내면 새 키를 받습니다.'
            : '❌ DM 발송에 실패했습니다 — 봇과의 DM이 열려 있는지 확인한 뒤 다시 시도해주세요.',
        thread_ts: threadTs,
      });
    }
    return { handled: true };
  }
}
