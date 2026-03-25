/**
 * Webhook command handler — manages webhook URL registration.
 * Trace: docs/turn-notification/trace.md, Scenario 6
 *
 * Commands:
 *   webhook register <url>  — Register webhook URL
 *   webhook remove          — Remove registered webhook URL
 *   webhook test            — Send test payload to registered URL
 */

import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { userSettingsStore } from '../../user-settings-store';
import { Logger } from '../../logger';

const logger = new Logger('WebhookHandler');

const WEBHOOK_USAGE =
  `📋 *웹훅 사용법*\n\n\`webhook register <url>\` — 웹훅 URL 등록\n\`webhook remove\` — 웹훅 삭제\n\`webhook test\` — 테스트 페이로드 전송`;

/** RFC 1918 / link-local / loopback IPv4 patterns. */
const IPV4_BLOCKED = [
  /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^127\./,
];

function isBlockedIPv4(ip: string): boolean {
  return IPV4_BLOCKED.some(p => p.test(ip));
}

/**
 * Validate webhook URL: HTTPS only + block private/internal network addresses.
 * Returns error message string if invalid, null if valid.
 */
export function validateWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `올바른 URL을 입력하세요: \`${url}\``;
  }

  if (parsed.protocol !== 'https:') {
    return `HTTPS URL만 허용됩니다. 입력: \`${parsed.protocol}\``;
  }

  const hostname = parsed.hostname.toLowerCase();
  // Strip IPv6 brackets for pattern matching, then strip trailing dot (FQDN normalization)
  const raw = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const bareHost = raw.replace(/\.$/, '');

  // Only apply IP-range checks to actual IP addresses, not domain names
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost);
  const isIPv6 = bareHost.includes(':');

  if (bareHost === 'localhost') {
    return '내부 네트워크 주소는 허용되지 않습니다.';
  }

  if (isIPv4 && isBlockedIPv4(bareHost)) {
    return '내부 네트워크 주소는 허용되지 않습니다.';
  }

  if (isIPv6) {
    const IPV6_BLOCKED = [/^::1$/, /^fe80:/i, /^fc00:/i, /^fd[0-9a-f]{2}:/i];
    if (IPV6_BLOCKED.some(p => p.test(bareHost))) {
      return '내부 네트워크 주소는 허용되지 않습니다.';
    }

    // Detect IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:HHHH:HHHH) and re-check
    const v4MappedMatch = bareHost.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
      || bareHost.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (v4MappedMatch) {
      let embeddedIPv4: string;
      if (v4MappedMatch[2]) {
        // Hex form: ::ffff:7f00:1 → 127.0.0.1
        const hi = parseInt(v4MappedMatch[1], 16);
        const lo = parseInt(v4MappedMatch[2], 16);
        embeddedIPv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      } else {
        embeddedIPv4 = v4MappedMatch[1];
      }
      if (isBlockedIPv4(embeddedIPv4)) {
        return '내부 네트워크 주소는 허용되지 않습니다.';
      }
    }
  }

  return null;
}

/** Apply a webhook setting patch with error handling. */
async function applyWebhookPatch(
  ctx: { user: string; threadTs: string; say: CommandContext['say'] },
  patch: Parameters<typeof userSettingsStore.patchNotification>[1],
  successText: string,
  logLabel: string,
): Promise<void> {
  try {
    userSettingsStore.patchNotification(ctx.user, patch);
  } catch (error: any) {
    logger.error(logLabel, { user: ctx.user, error: error.message });
    await ctx.say({ text: `❌ 설정 저장 실패: ${error.message}`, thread_ts: ctx.threadTs }).catch(
      (sayErr: any) => logger.warn('Failed to send error reply', { error: sayErr?.message })
    );
    return;
  }
  await ctx.say({ text: successText, thread_ts: ctx.threadTs }).catch(
    (sayErr: any) => logger.warn('Failed to send success reply', { error: sayErr?.message })
  );
}

export class WebhookHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isWebhookCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const parsed = CommandParser.parseWebhookCommand(text);

    if (!parsed) {
      await say({ text: WEBHOOK_USAGE, thread_ts: threadTs });
      return { handled: true };
    }

    switch (parsed.action) {
      case 'register': {
        const url = parsed.value?.trim();
        if (!url) {
          await say({
            text: `❌ URL을 입력하세요. 사용법: \`webhook register <url>\``,
            thread_ts: threadTs,
          });
          break;
        }

        // Validate URL — HTTPS only, block private/internal networks
        const urlError = validateWebhookUrl(url);
        if (urlError) {
          await say({
            text: `❌ ${urlError}`,
            thread_ts: threadTs,
          });
          break;
        }

        await applyWebhookPatch(
          { user, threadTs, say },
          { webhookUrl: url },
          `✅ 웹훅이 등록되었습니다: \`${url}\``,
          'Failed to register webhook',
        );
        break;
      }

      case 'remove':
        await applyWebhookPatch(
          { user, threadTs, say },
          { webhookUrl: undefined },
          `✅ 웹훅이 삭제되었습니다.`,
          'Failed to remove webhook',
        );
        break;

      case 'test': {
        const settings = userSettingsStore.getUserSettings(user);
        const webhookUrl = settings?.notification?.webhookUrl;
        if (!webhookUrl) {
          await say({
            text: `❌ 등록된 웹훅이 없습니다. 먼저 \`webhook register <url>\`으로 등록하세요.`,
            thread_ts: threadTs,
          });
          break;
        }

        // Re-validate stored URL before fetch (defense-in-depth: DNS rebinding, TOCTOU)
        const revalidateErr = validateWebhookUrl(webhookUrl);
        if (revalidateErr) {
          await say({ text: `❌ 저장된 URL이 유효하지 않습니다: ${revalidateErr}`, thread_ts: threadTs });
          break;
        }

        const testPayload = {
          event: 'turn_completed',
          category: 'WorkflowComplete',
          sessionId: 'test-session',
          userId: user,
          message: 'This is a test webhook payload',
          timestamp: new Date().toISOString(),
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload),
            signal: controller.signal,
            redirect: 'error',
          });

          if (response.ok) {
            await say({
              text: `✅ 테스트 웹훅 발송 성공 (HTTP ${response.status})`,
              thread_ts: threadTs,
            });
          } else {
            await say({
              text: `❌ 테스트 실패: 서버가 HTTP ${response.status}을 반환했습니다`,
              thread_ts: threadTs,
            });
          }
        } catch (error: any) {
          const msg = error.name === 'AbortError' ? '타임아웃 (5초 초과)' : error.message;
          await say({
            text: `❌ 테스트 실패: ${msg}`,
            thread_ts: threadTs,
          });
        } finally {
          clearTimeout(timeoutId);
        }
        break;
      }

      default:
        await say({ text: WEBHOOK_USAGE, thread_ts: threadTs });
        break;
    }

    return { handled: true };
  }
}
