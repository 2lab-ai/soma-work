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

export class WebhookHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isWebhookCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const parsed = CommandParser.parseWebhookCommand(text);

    if (!parsed) {
      await say({
        text: `📋 *웹훅 사용법*\n\n\`webhook register <url>\` — 웹훅 URL 등록\n\`webhook remove\` — 웹훅 삭제\n\`webhook test\` — 테스트 페이로드 전송`,
        thread_ts: threadTs,
      });
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

        // Validate URL
        try {
          new URL(url);
        } catch {
          await say({
            text: `❌ 올바른 URL을 입력하세요: \`${url}\``,
            thread_ts: threadTs,
          });
          break;
        }

        userSettingsStore.patchNotification(user, { webhookUrl: url });
        await say({
          text: `✅ 웹훅이 등록되었습니다: \`${url}\``,
          thread_ts: threadTs,
        });
        break;
      }

      case 'remove':
        userSettingsStore.patchNotification(user, { webhookUrl: undefined });
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

        try {
          const testPayload = {
            event: 'turn_completed',
            category: 'WorkflowComplete',
            sessionId: 'test-session',
            userId: user,
            message: 'This is a test webhook payload',
            timestamp: new Date().toISOString(),
          };

          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload),
          });

          await say({
            text: `✅ 테스트 웹훅 발송 성공 (HTTP ${response.status})`,
            thread_ts: threadTs,
          });
        } catch (error: any) {
          await say({
            text: `❌ 테스트 실패: ${error.message}`,
            thread_ts: threadTs,
          });
        }
        break;
      }

      default:
        await say({
          text: `📋 *웹훅 사용법*\n\n\`webhook register <url>\` — 웹훅 URL 등록\n\`webhook remove\` — 웹훅 삭제\n\`webhook test\` — 테스트 페이로드 전송`,
          thread_ts: threadTs,
        });
        break;
    }

    return { handled: true };
  }
}
