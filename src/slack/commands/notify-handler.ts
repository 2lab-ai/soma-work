/**
 * Notify command handler — manages Slack DM and Telegram notification settings.
 * Trace: docs/turn-notification/trace.md, Scenario 5
 *
 * Commands:
 *   notify on              — Enable Slack DM notifications
 *   notify off             — Disable Slack DM notifications
 *   notify status          — Show current notification settings
 *   notify telegram <id>   — Register Telegram chat ID
 *   notify telegram off    — Remove Telegram chat ID
 */

import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { renderNotifyCard } from '../z/topics/notify-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

const NOTIFY_USAGE = `📋 *알림 사용법*\n\n\`notify on\` — Slack DM 알림 활성화\n\`notify off\` — Slack DM 알림 비활성화\n\`notify status\` — 현재 설정 조회\n\`notify telegram <chat_id>\` — 텔레그램 알림 등록\n\`notify telegram off\` — 텔레그램 알림 해제`;

export class NotifyHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isNotifyCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const parsed = CommandParser.parseNotifyCommand(text);

    if (!parsed) {
      await say({ text: NOTIFY_USAGE, thread_ts: threadTs });
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
      case 'on':
        if (!(await saveSetting({ slackDm: true }))) break;
        await say({
          text: `✅ Slack DM 알림이 활성화되었습니다.\n\nAI 턴 종료 시 DM으로 알림을 받습니다.`,
          thread_ts: threadTs,
        });
        break;

      case 'off':
        if (!(await saveSetting({ slackDm: false }))) break;
        await say({
          text: `✅ Slack DM 알림이 비활성화되었습니다.`,
          thread_ts: threadTs,
        });
        break;

      case 'status': {
        // Phase 2 (#507): render Block Kit card by default.
        try {
          const { text: fallback, blocks } = await renderNotifyCard({
            userId: user,
            issuedAt: Date.now(),
          });
          await say({ text: fallback ?? '🔔 Notifications', blocks, thread_ts: threadTs });
        } catch {
          // Fallback to plain-text status if card render fails.
          const settings = userSettingsStore.getUserSettings(user);
          const notif = settings?.notification;
          const lines = [
            `📋 *알림 설정 현황*`,
            ``,
            `• Slack DM: ${notif?.slackDm ? '✅ 활성화' : '❌ 비활성화'}`,
            `• 웹훅: ${notif?.webhookUrl ? `✅ \`${notif.webhookUrl}\`` : '❌ 미등록'}`,
            `• 텔레그램: ${notif?.telegramChatId ? `✅ Chat ID: \`${notif.telegramChatId}\`` : '❌ 미등록'}`,
          ];
          await say({ text: lines.join('\n'), thread_ts: threadTs });
        }
        break;
      }

      case 'telegram': {
        const value = parsed.value?.trim();
        if (!value) {
          await say({
            text: `📋 *알림 사용법*\n\n\`notify telegram <chat_id>\` — 텔레그램 알림 등록\n\`notify telegram off\` — 텔레그램 알림 해제`,
            thread_ts: threadTs,
          });
          break;
        }
        // Validate chatId format (numeric or negative numeric for groups, max 20 digits)
        if (!/^-?\d{1,20}$/.test(value)) {
          await say({
            text: `❌ 올바른 Chat ID를 입력하세요 (숫자만 허용): \`${value}\``,
            thread_ts: threadTs,
          });
          break;
        }
        if (!(await saveSetting({ telegramChatId: value }))) break;
        await say({
          text: `✅ 텔레그램 알림이 등록되었습니다. Chat ID: ${value}`,
          thread_ts: threadTs,
        });
        break;
      }

      case 'telegram_off':
        if (!(await saveSetting({ telegramChatId: undefined }))) break;
        await say({
          text: `✅ 텔레그램 알림이 해제되었습니다.`,
          thread_ts: threadTs,
        });
        break;

      default:
        await say({ text: NOTIFY_USAGE, thread_ts: threadTs });
        break;
    }

    return { handled: true };
  }
}
