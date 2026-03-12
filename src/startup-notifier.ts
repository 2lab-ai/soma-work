import { WebClient } from '@slack/web-api';
import { Logger } from './logger';
import { formatTimestamp, getConfiguredUpdateChannel, resolveChannel, VersionInfo } from './release-notifier';

const logger = new Logger('StartupNotifier');

export const LEGACY_STARTUP_CHANNEL_ID = 'C0A25HMBC49';

export interface StartupNotificationOptions {
  loadedSessions: number;
  mcpNames: string[];
  versionInfo: VersionInfo | null;
}

function getStartupChannelConfig(): string {
  const configured = getConfiguredUpdateChannel();
  return configured || LEGACY_STARTUP_CHANNEL_ID;
}

export async function notifyStartup(
  client: WebClient,
  options: StartupNotificationOptions,
): Promise<boolean> {
  const channelConfig = getStartupChannelConfig();
  const channelId = await resolveChannel(client, channelConfig);
  if (!channelId) {
    logger.warn('Could not resolve startup notification channel', { channelConfig });
    return false;
  }

  const { loadedSessions, mcpNames, versionInfo } = options;
  const blocks: any[] = [];

  if (versionInfo) {
    const isUpgrade = versionInfo.previousVersion !== '0.0.0' &&
      versionInfo.version !== versionInfo.previousVersion;
    const isRollback = versionInfo.isRollback === true;
    const headerText = isRollback
      ? `⏪ v${versionInfo.version} Rollback (${versionInfo.previousVersion} → ${versionInfo.rollbackTargetVersion || 'previous'})`
      : isUpgrade
        ? `🚀 v${versionInfo.version} Started (${versionInfo.previousVersion} → ${versionInfo.version})`
        : `🚀 v${versionInfo.version} Started`;

    blocks.push(
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: headerText,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Version*\n\`${versionInfo.tag}\`` },
          { type: 'mrkdwn', text: `*Branch*\n\`${versionInfo.branch}\`` },
          { type: 'mrkdwn', text: `*Commit*\n\`${versionInfo.commitHashShort}\`` },
          { type: 'mrkdwn', text: `*Started*\n${formatTimestamp(new Date().toISOString())}` },
        ],
      },
    );
  } else {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: '🚀 soma-work Started (dev)', emoji: true },
    });
  }

  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*MCP*\n${mcpNames.length > 0 ? mcpNames.map(name => `\`${name}\``).join(', ') : '_none_'}` },
      { type: 'mrkdwn', text: `*Sessions*\n${loadedSessions} restored` },
    ],
  });

  if (versionInfo?.releaseNotes) {
    const isVersionChange = versionInfo.previousVersion !== '0.0.0' &&
      versionInfo.version !== versionInfo.previousVersion;
    const rollback = versionInfo.isRollback === true;
    const changelogLabel = rollback ? '*⏪ 롤백*' : '*📋 변경 사항*';
    const tagTransition = rollback
      ? ` _(${versionInfo.previousTag} → ${versionInfo.rollbackTargetTag || 'previous'})_`
      : isVersionChange
        ? ` _(${versionInfo.previousTag} → ${versionInfo.tag})_`
        : '';

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${changelogLabel}${tagTransition}\n\n${versionInfo.releaseNotes}`,
        },
      },
    );
  }

  const footerParts: string[] = [];
  if (versionInfo) {
    footerParts.push(`commit: \`${versionInfo.commitHash.substring(0, 12)}\``);
    footerParts.push(`built: ${formatTimestamp(versionInfo.buildTime)}`);
  }
  footerParts.push('_Reply to test events_');
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: footerParts.join(' | ') }],
  });

  try {
    await client.chat.postMessage({
      channel: channelId,
      text: versionInfo ? `Bot Started - v${versionInfo.version} (${versionInfo.branch})` : 'Bot Started',
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    logger.info('Startup notification sent', { channel: channelConfig, resolvedChannel: channelId });
    return true;
  } catch (error) {
    logger.warn('Failed to send startup notification', {
      error: (error as Error).message,
      channel: channelConfig,
      resolvedChannel: channelId,
    });
    return false;
  }
}
