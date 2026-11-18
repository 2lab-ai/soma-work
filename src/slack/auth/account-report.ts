/**
 * [📋 계정별 리포트] — the per-account detail the `auth` card no longer lists
 * (2026-11-18). Posted as a NEW message in the card's thread (append-only), so
 * the card keeps its one-glance picture.
 *
 * Picture first (`infographic-svg.ts` account report, uploaded by the clicking
 * surface's bot); when it cannot be made or Slack refuses it, the read-only text
 * rows (`buildAccountReportTextBlocks`). Account identity is shown to every
 * viewer, the same rule as the card (#803).
 */

import type { WebClient } from '@slack/web-api';
import { getAuthMode } from '../../auth/auth-runtime';
import { fetchLlmuxStatus, type LlmuxStatus } from '../../auth/llmux-client';
import { getLlmuxAccountTiers } from '../../config';
import { buildCapacityView } from '../../conversation/capacity-view';
import { Logger } from '../../logger';
import { deliverImageCard, slackImageUploader } from '../slack-file-image';
import type { ZBlock } from '../z/types';
import { buildAccountReportTextBlocks } from './builder';
import { buildAccountReport, describeAccountReport } from './infographic-model';
import { renderAuthReportPng } from './infographic-publish';

const logger = new Logger('AuthAccountReport');

export interface AuthReportTarget {
  channel: string;
  /** The thread the card lives in (or the card itself when it is top-level). */
  threadTs: string;
  /** Set when the card is ephemeral: the report goes back through `respond`, to the clicker only. */
  respond?: (msg: Record<string, unknown>) => Promise<unknown>;
}

const TEXT = '📋 계정별 상세';

async function reportPicture(
  client: WebClient,
  status: LlmuxStatus,
  nowMs: number,
  header: ZBlock,
): Promise<ZBlock[] | undefined> {
  try {
    const view = buildCapacityView(status, getLlmuxAccountTiers(), nowMs);
    const report = buildAccountReport(status, view, nowMs);
    const png = await renderAuthReportPng(report);
    const fileId = await slackImageUploader(client)(png, `auth-accounts-${Math.floor(nowMs / 1000)}.png`);
    return [header, { type: 'image', slack_file: { id: fileId }, alt_text: describeAccountReport(report) }];
  } catch (err) {
    logger.warn('account report picture skipped, text rows only', {
      error: (err as Error)?.name,
      message: (err as Error)?.message,
    });
    return undefined;
  }
}

export async function postAuthAccountReport(args: {
  client: WebClient;
  target: AuthReportTarget;
  userId: string;
}): Promise<void> {
  const { client, target, userId } = args;
  const send = (blocks: unknown[], text = TEXT) =>
    target.respond
      ? target.respond({ response_type: 'ephemeral', replace_original: false, text, blocks })
      : client.chat.postMessage({ channel: target.channel, thread_ts: target.threadTs, text, blocks: blocks as never });

  try {
    if (getAuthMode() !== 'llmux') {
      await send([], '📋 계정별 리포트는 llmux 모드에서만 제공됩니다.');
      return;
    }
    let status: LlmuxStatus;
    try {
      status = await fetchLlmuxStatus();
    } catch (err) {
      logger.warn('account report: llmux status fetch failed', { message: (err as Error)?.message });
      await send([], '❌ llmux 상태를 불러오지 못해 계정별 리포트를 만들 수 없습니다. 잠시 후 다시 시도하세요.');
      return;
    }
    const nowMs = Date.now();
    const epoch = Math.floor(nowMs / 1000);
    const header: ZBlock = {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `📋 *계정별 상세* · <@${userId}> 요청 · <!date^${epoch}^{date_short_pretty} {time}|${new Date(nowMs).toISOString()}>`,
        },
      ],
    };
    const textBlocks = buildAccountReportTextBlocks(
      status,
      nowMs,
      (header.elements as Array<{ text: string }>)[0].text,
    );
    const picture = await reportPicture(client, status, nowMs, header);
    await deliverImageCard(
      picture ? { blocks: picture, fallbackBlocks: textBlocks } : { blocks: textBlocks },
      (blocks) => send(blocks),
    );
  } catch (err) {
    logger.warn('account report post failed', { message: (err as Error)?.message });
  }
}
