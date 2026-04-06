import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import type { McpManager } from '../../mcp-manager';
import type { RespondFn } from './types';

const logger = new Logger('PluginUpdateActionHandler');

interface PluginUpdateActionContext {
  mcpManager?: McpManager;
}

/**
 * Handles Ignore / Force Update button actions from the plugin update UI.
 *
 * When a plugin update fails (e.g. security gate block), the update result
 * message shows per-plugin action buttons. This handler processes those clicks.
 */
export class PluginUpdateActionHandler {
  constructor(private ctx: PluginUpdateActionContext) {}

  /**
   * Handle "Ignore" button — dismiss the failure, update the message.
   */
  async handleIgnore(body: any, respond: RespondFn): Promise<void> {
    const actorId = body.user?.id;
    if (!actorId || !isAdminUser(actorId)) {
      await respond({
        text: '⛔ 어드민만 이 버튼을 사용할 수 있습니다.',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    const rawValue = body.actions?.[0]?.value;
    let pluginName: string;
    try {
      pluginName = JSON.parse(rawValue).pluginName;
    } catch {
      logger.warn('Invalid plugin ignore payload', { rawValue });
      return;
    }

    logger.info('Plugin update ignored by admin', { pluginName, adminId: actorId });

    await respond({
      text: `⏭️ *${pluginName}* — 업데이트를 무시했습니다. 이전 버전을 유지합니다.`,
      replace_original: true,
    });
  }

  /**
   * Handle "Force Update" button — re-fetch with security gate bypassed.
   */
  async handleForceUpdate(body: any, respond: RespondFn): Promise<void> {
    const actorId = body.user?.id;
    if (!actorId || !isAdminUser(actorId)) {
      await respond({
        text: '⛔ 어드민만 이 버튼을 사용할 수 있습니다.',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    const rawValue = body.actions?.[0]?.value;
    let pluginName: string;
    try {
      pluginName = JSON.parse(rawValue).pluginName;
    } catch {
      logger.warn('Invalid plugin force update payload', { rawValue });
      return;
    }

    const pluginManager = this.ctx.mcpManager?.getPluginManager();
    if (!pluginManager) {
      await respond({
        text: '❌ Plugin system is not available.',
        replace_original: true,
      });
      return;
    }

    // Show progress
    await respond({
      text: `🔄 *${pluginName}* — 보안 검사를 건너뛰고 강제 업데이트 중...`,
      replace_original: true,
    });

    try {
      // Re-run forceRefresh for just this plugin with skipSecurityGate
      const result = await pluginManager.forceRefresh({
        [pluginName]: { skipSecurityGate: true },
      });

      // Find this plugin's result
      const detail = result.details.find(d => d.name === pluginName);

      if (detail && detail.status !== 'error') {
        const sha = detail.newSha || '-';
        await respond({
          text: `✅ *${pluginName}* — 강제 업데이트 완료 (\`${sha}\`)`,
          replace_original: true,
        });
        logger.info('Plugin force-updated successfully', { pluginName, sha, adminId: actorId });
      } else {
        const errorMsg = detail?.error || 'Unknown error during force update';
        await respond({
          text: `❌ *${pluginName}* — 강제 업데이트 실패: ${errorMsg}`,
          replace_original: true,
        });
        logger.error('Plugin force update failed', { pluginName, error: errorMsg });
      }
    } catch (error) {
      await respond({
        text: `❌ *${pluginName}* — 강제 업데이트 실패: ${(error as Error).message}`,
        replace_original: true,
      });
      logger.error('Plugin force update threw', { pluginName, error: (error as Error).message });
    }
  }
}
