import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import { userSettingsStore } from '../../user-settings-store';
import type { SlackApiHelper } from '../slack-api-helper';
import type { RespondFn } from './types';

interface UserAcceptanceDeps {
  slackApi: SlackApiHelper;
}

/**
 * Handles Accept/Deny button actions from admin DM notifications.
 */
export class UserAcceptanceActionHandler {
  private logger = new Logger('UserAcceptanceActionHandler');

  constructor(private deps: UserAcceptanceDeps) {}

  async handleAccept(body: any, respond: RespondFn): Promise<void> {
    const targetUser = body.actions?.[0]?.value;
    const adminUser = body.user?.id;

    if (!targetUser || !adminUser) {
      this.logger.warn('Invalid accept payload', { targetUser, adminUser });
      return;
    }

    if (!isAdminUser(adminUser)) {
      await respond({
        text: '⛔ Admin only action',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    userSettingsStore.acceptUser(targetUser, adminUser);

    await respond({
      text: `✅ <@${targetUser}> accepted by <@${adminUser}>`,
      replace_original: true,
    });

    try {
      await this.deps.slackApi.postMessage(targetUser, '✅ 사용이 승인되었습니다! 메시지를 보내서 시작하세요.', {});
    } catch (error) {
      this.logger.error('Failed to notify accepted user', { targetUser, error });
    }
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    const targetUser = body.actions?.[0]?.value;
    const adminUser = body.user?.id;

    if (!targetUser || !adminUser) {
      this.logger.warn('Invalid deny payload', { targetUser, adminUser });
      return;
    }

    if (!isAdminUser(adminUser)) {
      await respond({
        text: '⛔ Admin only action',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    userSettingsStore.removeUserSettings(targetUser);

    await respond({
      text: `❌ <@${targetUser}> denied by <@${adminUser}>`,
      replace_original: true,
    });

    try {
      await this.deps.slackApi.postMessage(targetUser, '❌ 사용 요청이 거부되었습니다. 관리자에게 문의하세요.', {});
    } catch (error) {
      this.logger.error('Failed to notify denied user', { targetUser, error });
    }
  }
}
