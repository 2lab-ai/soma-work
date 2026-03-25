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

import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { userSettingsStore } from '../../user-settings-store';

export class NotifyHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isNotifyCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const parsed = CommandParser.parseNotifyCommand(text);

    if (!parsed) {
      await say({
        text: `📋 *알림 사용법*\n\n\`notify on\` — Slack DM 알림 활성화\n\`notify off\` — Slack DM 알림 비활성화\n\`notify status\` — 현재 설정 조회\n\`notify telegram <chat_id>\` — 텔레그램 알림 등록\n\`notify telegram off\` — 텔레그램 알림 해제`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    switch (parsed.action) {
      case 'on':
        try {
          userSettingsStore.patchNotification(user, { slackDm: true });
        } catch (error: any) {
          await say({ text: `❌ 설정 저장 실패: ${error.message}`, thread_ts: threadTs });
          break;
        }
        await say({
          text: `✅ Slack DM 알림이 활성화되었습니다.\n\nAI 턴 종료 시 DM으로 알림을 받습니다.`,
          thread_ts: threadTs,
        });
        break;

      case 'off':
        try {
          userSettingsStore.patchNotification(user, { slackDm: false });
        } catch (error: any) {
          await say({ text: `❌ 설정 저장 실패: ${error.message}`, thread_ts: threadTs });
          break;
        }
        await say({
          text: `✅ Slack DM 알림이 비활성화되었습니다.`,
          thread_ts: threadTs,
        });
        break;

      case 'status': {
        const settings = userSettingsStore.getUserSettings(user);
        const notif = settings?.notification;
        const lines = [
          `📋 *알림 설정 현황*`,
          ``,
          `• Slack DM: ${notif?.slackDm ? '✅ 활성화' : '❌ 비활성화'}`,
          `• 웹훅: ${notif?.webhookUrl ? `✅ \`${notif.webhookUrl}\`` : '❌ 미등록'}`,
          `• 텔레그램: ${notif?.telegramChatId ? `✅ Chat ID: \`${notif.telegramChatId}\`` : '❌ 미등록'}`,
        ];
        await say({
          text: lines.join('\n'),
          thread_ts: threadTs,
        });
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
        try {
          userSettingsStore.patchNotification(user, { telegramChatId: value });
        } catch (error: any) {
          await say({ text: `❌ 설정 저장 실패: ${error.message}`, thread_ts: threadTs });
          break;
        }
        await say({
          text: `✅ 텔레그램 알림이 등록되었습니다. Chat ID: ${value}`,
          thread_ts: threadTs,
        });
        break;
      }

      case 'telegram_off':
        try {
          userSettingsStore.patchNotification(user, { telegramChatId: undefined });
        } catch (error: any) {
          await say({ text: `❌ 설정 저장 실패: ${error.message}`, thread_ts: threadTs });
          break;
        }
        await say({
          text: `✅ 텔레그램 알림이 해제되었습니다.`,
          thread_ts: threadTs,
        });
        break;

      default:
        await say({
          text: `📋 *알림 사용법*\n\n\`notify on\` — Slack DM 알림 활성화\n\`notify off\` — Slack DM 알림 비활성화\n\`notify status\` — 현재 설정 조회\n\`notify telegram <chat_id>\` — 텔레그램 알림 등록\n\`notify telegram off\` — 텔레그램 알림 해제`,
          thread_ts: threadTs,
        });
        break;
    }

    return { handled: true };
  }
}
