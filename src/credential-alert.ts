import { WebClient } from '@slack/web-api';
import { config } from './config';
import { Logger } from './logger';
import { getCredentialStatus, isCredentialManagerEnabled } from './credentials-manager';

const logger = new Logger('CredentialAlert');

let slackClient: WebClient | null = null;
let lastAlertTime: number = 0;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown between alerts

/**
 * Get or create Slack client
 */
function getSlackClient(): WebClient {
  if (!slackClient) {
    slackClient = new WebClient(config.slack.botToken);
  }
  return slackClient;
}

/**
 * Send credential missing alert to Slack channel
 */
export async function sendCredentialAlert(error?: string): Promise<void> {
  // Skip if credential manager is disabled
  if (!isCredentialManagerEnabled()) {
    logger.debug('Credential manager disabled, skipping alert');
    return;
  }

  // Check cooldown to avoid spamming
  const now = Date.now();
  if (now - lastAlertTime < ALERT_COOLDOWN_MS) {
    logger.debug('Alert cooldown active, skipping Slack notification');
    return;
  }

  const status = getCredentialStatus();
  const channelName = config.credentials.alertChannel;

  const message = buildAlertMessage(status, error);

  logger.error('Claude credentials missing - sending alert to Slack', {
    channel: channelName,
    status,
    error,
  });

  try {
    const client = getSlackClient();

    // Try to find channel by name if it starts with #
    let channelId = channelName;
    if (channelName.startsWith('#')) {
      const channelNameWithoutHash = channelName.substring(1);
      const result = await client.conversations.list({
        types: 'public_channel,private_channel',
        limit: 1000,
      });

      const channel = result.channels?.find(
        (ch) => ch.name === channelNameWithoutHash
      );

      if (channel?.id) {
        channelId = channel.id;
      } else {
        logger.warn('Could not find channel by name, using as-is', {
          channelName,
        });
      }
    }

    await client.chat.postMessage({
      channel: channelId,
      text: message,
      mrkdwn: true,
    });

    lastAlertTime = now;
    logger.info('Credential alert sent to Slack successfully', {
      channel: channelId,
    });
  } catch (slackError) {
    logger.error('Failed to send credential alert to Slack', slackError);
  }
}

/**
 * Build alert message
 */
function buildAlertMessage(
  status: {
    enabled: boolean;
    credentialsFileExists: boolean;
    backupFileExists: boolean;
    hasClaudeAiOauth: boolean;
    autoRestoreEnabled: boolean;
  },
  error?: string
): string {
  const lines: string[] = [
    '🚨 *Claude Credential Alert*',
    '',
    'Claude Code Slack Bot cannot authenticate with Claude.',
    '',
    '*Status:*',
    `• Credentials file exists: ${status.credentialsFileExists ? '✅' : '❌'}`,
    `• Backup file exists: ${status.backupFileExists ? '✅' : '❌'}`,
    `• Has claudeAiOauth: ${status.hasClaudeAiOauth ? '✅' : '❌'}`,
    `• Auto-restore enabled: ${status.autoRestoreEnabled ? '✅' : '❌'}`,
  ];

  if (error) {
    lines.push('', `*Error:* ${error}`);
  }

  lines.push(
    '',
    '*To fix this:*',
    '1. Log in to Claude manually: `claude login`',
    '2. Or enable auto-restore: Set `AUTOMATIC_RESTORE_CREDENTIAL=1` environment variable',
    '3. Ensure `~/.claude/credentials.json` backup file exists',
    '',
    '_This bot requires valid Claude credentials to function._'
  );

  return lines.join('\n');
}
