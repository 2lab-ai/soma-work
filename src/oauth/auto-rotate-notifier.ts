/**
 * Auto CCT rotation Slack notifier (#737).
 *
 * Reuses `getConfiguredUpdateChannel` + `resolveChannel` from
 * `release-notifier.ts` so rotation messages land in the same operator
 * channel as deploy/rollback notes — the operator already watches it.
 *
 * Failure model: if the channel is unset or unresolvable, the notifier
 * logs at warn and returns `false`. The rotation itself has already
 * completed — `applyToken` is the source of truth, not the notify.
 */

import type { WebClient } from '@slack/web-api';
import { Logger } from '../logger';
import { getConfiguredUpdateChannel, resolveChannel } from '../release-notifier';
import type { ActiveSummary, RotationCandidate } from './auto-rotate';

const logger = new Logger('AutoRotateNotifier');

export interface RotationNotifyPayload {
  from: ActiveSummary | null;
  to: RotationCandidate;
}

/**
 * Format a utilization value (0..100 percent — store SSOT, see #685/#781)
 * as `XX.X%`. The `*100` scaling that used to live here was a birth
 * defect from #737 — the engine + store agreed on percent form, only
 * this renderer (and `cct-handler.pct`) carried the stale 0..1
 * assumption, producing four-digit "6300.0%" hourly notifications.
 */
function fmtPct(util: number | undefined): string {
  if (util === undefined || !Number.isFinite(util)) return '—';
  return `${util.toFixed(1)}%`;
}

function fmtResetsAt(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const ts = Math.floor(new Date(iso).getTime() / 1000);
    if (!Number.isFinite(ts)) return iso;
    return `<!date^${ts}^{date_short_pretty} {time}|${iso}>`;
  } catch {
    return iso;
  }
}

/**
 * Post a rotation notification. Returns true if the message was sent.
 *
 * The body is intentionally compact (one section + one fields block) so
 * the channel doesn't drown in vertical space — auto-rotation can fire
 * up to once per hour.
 */
export async function notifyAutoRotation(client: WebClient, payload: RotationNotifyPayload): Promise<boolean> {
  const channelConfig = getConfiguredUpdateChannel();
  if (!channelConfig) {
    logger.debug('DEFAULT_UPDATE_CHANNEL not set, skipping auto-rotate notification');
    return false;
  }
  const channelId = await resolveChannel(client, channelConfig);
  if (!channelId) {
    logger.warn('Could not resolve DEFAULT_UPDATE_CHANNEL for auto-rotate notify', { channelConfig });
    return false;
  }

  const fromText = payload.from
    ? `\`${payload.from.name}\` (5h ${fmtPct(payload.from.fiveHourUtilization)} · 7d ${fmtPct(payload.from.sevenDayUtilization)})`
    : '_없음_';
  const toText = `\`${payload.to.name}\` (5h ${fmtPct(payload.to.fiveHourUtilization)} · 7d ${fmtPct(payload.to.sevenDayUtilization)})`;

  const text = `:repeat: Auto CCT rotation: ${payload.from?.name ?? 'none'} → ${payload.to.name}`;

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:repeat: *Auto CCT rotation*\n*From:* ${fromText}\n*To:* ${toText}\n*Reason:* 7d resets soonest at ${fmtResetsAt(payload.to.sevenDayResetsAt)}`,
      },
    },
  ];

  try {
    await client.chat.postMessage({
      channel: channelId,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    logger.info('Auto-rotate notification sent', {
      channel: channelConfig,
      fromKeyId: payload.from?.keyId,
      toKeyId: payload.to.keyId,
    });
    return true;
  } catch (error) {
    logger.warn('Failed to send auto-rotate notification', {
      error: (error as Error).message,
      channel: channelConfig,
    });
    return false;
  }
}
