/**
 * Webhook command handler — manages webhook URL registration.
 * Trace: docs/turn-notification/trace.md, Scenario 6
 *
 * Commands:
 *   webhook register <url>  — Register webhook URL
 *   webhook remove          — Remove registered webhook URL
 *   webhook test            — Send test payload to registered URL
 */

import { userSettingsStore } from '../../user-settings-store';
import { validateWebhookUrl, validateWebhookUrlWithDns } from '../../webhook-url-validator';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

const WEBHOOK_USAGE = `📋 *웹훅 사용법*\n\n\`webhook register <url>\` — 웹훅 URL 등록\n\`webhook remove\` — 웹훅 삭제\n\`webhook test\` — 테스트 페이로드 전송`;

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

    /** Save notification setting; returns false and reports error on failure. */
    async function saveSetting(patch: Parameters<typeof userSettingsStore.patchNotification>[1]): Promise<boolean> {
      try {
        userSettingsStore.patchNotification(user, patch);
        return true;
      } catch (error: any) {
        await say({ text: `❌ 설정 저장 실패: ${error.message}`, thread_ts: threadTs });
        return false;
      }
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

        // Validate URL (SSRF prevention: HTTPS only + private IP block)
        const validation = validateWebhookUrl(url);
        if (!validation.valid) {
          await say({
            text: `❌ ${validation.error}: \`${url}\``,
            thread_ts: threadTs,
          });
          break;
        }

        if (!(await saveSetting({ webhookUrl: url }))) break;
        await say({
          text: `✅ 웹훅이 등록되었습니다: \`${url}\``,
          thread_ts: threadTs,
        });
        break;
      }

      case 'remove':
        if (!(await saveSetting({ webhookUrl: undefined }))) break;
        await say({
          text: `✅ 웹훅이 삭제되었습니다.`,
          thread_ts: threadTs,
        });
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

        // SSRF defense: validate stored URL before test fetch (including DNS resolution)
        const testValidation = await validateWebhookUrlWithDns(webhookUrl);
        if (!testValidation.valid) {
          await say({
            text: `❌ 등록된 URL이 보안 정책에 위반됩니다: ${testValidation.error}`,
            thread_ts: threadTs,
          });
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
              text: `⚠️ 웹훅 응답 오류 (HTTP ${response.status})`,
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
