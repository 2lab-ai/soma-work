import { isAdminUser } from '../../admin-utils';
import { getAuthMode } from '../../auth/auth-runtime';
import { switchLlmuxAccount } from '../../auth/llmux-client';
import { advertisedLlmuxBaseUrl, buildLlmuxKeyDmText } from '../../auth/llmux-key-info';
import { describeTenantKey, ensureTenantKey } from '../../auth/llmux-tenant-keys';
import { CommandParser } from '../command-parser';
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
  };
  userSettingsStore?: {
    getUserSettings(userId: string): { slackName?: string; email?: string } | undefined;
  };
}

/**
 * Handles auth backend commands (#llmux runtime switch):
 *   - `auth`                     — show the auth card (mode + llmux pool /
 *                                  legacy cct card). Non-admin sees the
 *                                  readonly variant: same account info, no
 *                                  mutating buttons, no settings line.
 *   - `auth llmux` / `auth cct`  — flip the runtime auth mode (admin only).
 *     (`set auth llmux|cct` is an accepted alias.)
 *   - `auth switch <name>`       — llmux manual account switch (admin only).
 *   - `auth key` / bare `key`    — DM the caller their personal llmux client
 *                                  key + local Claude Code setup (any user:
 *                                  it is THEIR key; llmux meters them by it).
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
      return this.executeKey(ctx);
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

    // status — card render. Viewer mode (admin/readonly) is derived inside
    // renderAuthCard; readonly only strips mutating affordances + the
    // settings line, account info renders for everyone.
    const { text: fallback, blocks } = await renderAuthCard({ userId: user, issuedAt: Date.now() });
    await say({ text: fallback ?? '🔐 Auth', blocks, thread_ts: threadTs });
    return { handled: true };
  }

  /**
   * `key` — issue-or-reuse the caller's llmux client key and DM it to them
   * with local Claude Code / llmux CLI setup. `ensureTenantKey` guarantees the
   * SAME user always gets the SAME key (per daemon); a fresh issuance and a
   * repeat request are indistinguishable here on purpose.
   */
  private async executeKey(ctx: CommandContext): Promise<CommandResult> {
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

    const settings = this.deps?.userSettingsStore?.getUserSettings(user);
    const lease = await ensureTenantKey(user, { name: settings?.slackName, email: settings?.email });
    if (!lease) {
      await say({
        text: '❌ llmux 키 발급에 실패했습니다 — 데몬 상태를 확인해주세요 (`auth` 카드). 잠시 후 다시 시도하면 재발급을 시도합니다.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const meta = describeTenantKey(user);
    const dmText = buildLlmuxKeyDmText({
      secret: lease.secret,
      baseUrl: advertisedLlmuxBaseUrl(lease.baseUrl),
      ...(meta?.id ? { keyId: meta.id } : {}),
      ...(meta?.name ? { keyName: meta.name } : {}),
      ...(meta?.issuedAtMs ? { issuedAtMs: meta.issuedAtMs } : {}),
      ...(meta?.rotatedAtMs ? { rotatedAtMs: meta.rotatedAtMs } : {}),
    });

    // Secret-safe error boundary: `dmText` carries the plaintext key, so a
    // rejection from the Slack calls must NOT propagate to callers that might
    // serialize handler state into logs or chat. The user-facing reply is a
    // constant; the logged detail is only the Slack error message (which never
    // echoes request bodies) — and the console redaction layer additionally
    // masks any `lmk-…` that would slip through a future path.
    try {
      const dmChannel = await slackApi.openDmChannel(user);
      await slackApi.postMessage(dmChannel, dmText);

      // Invoked from a channel → confirm there WITHOUT the secret. Invoked
      // from the DM itself → the key message above IS the response.
      if (channel !== dmChannel) {
        await say({ text: '🔑 llmux 키와 로컬 Claude Code 사용법을 DM으로 보냈습니다.', thread_ts: threadTs });
      }
    } catch {
      await say({
        text: '❌ DM 발송에 실패했습니다 — 봇과의 DM이 열려 있는지 확인한 뒤 다시 시도해주세요.',
        thread_ts: threadTs,
      });
    }
    return { handled: true };
  }
}
