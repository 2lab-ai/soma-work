/**
 * Source Thread Summary — posts work summary back to the original thread
 * when a mid-thread-created session completes (PR merge or session close).
 *
 * Bauhaus Block Kit design: form follows function, grid-based fields,
 * functional color only, zero decorative emoji.
 */

import { Logger } from '../logger';
import type { ConversationSession } from '../types';
import type { SlackApiHelper } from './slack-api-helper';
import { ThreadHeaderBuilder } from './thread-header-builder';

const logger = new Logger('SourceThreadSummary');

/**
 * Build Block Kit blocks for the "request start" message posted to
 * the original thread when a mid-thread mention creates a new work session.
 *
 * Layout (Bauhaus — 2 blocks):
 *   header: session title
 *   section: text(목표) + fields(상태/담당/실행) + accessory(스레드 button)
 */
export function buildRequestStartBlocks(
  session: ConversationSession,
  workThreadPermalink?: string | null
): { text: string; blocks: any[] } {
  const title = session.title || 'Session';
  const model = session.model ? ThreadHeaderBuilder.formatModelName(session.model) : undefined;
  const workflow = session.workflow || 'default';

  const fields: any[] = [
    { type: 'mrkdwn', text: '*상태*\n시작' },
  ];

  if (session.ownerId) {
    fields.push({ type: 'mrkdwn', text: `*담당*\n<@${session.ownerId}>` });
  }

  const envParts = [`\`${workflow}\``];
  if (model) envParts.push(`\`${model}\``);
  fields.push({ type: 'mrkdwn', text: `*실행*\n${envParts.join(' · ')}` });

  const section: any = {
    type: 'section',
    text: { type: 'mrkdwn', text: `*목표*\n${title}` },
    fields,
  };

  if (workThreadPermalink) {
    section.accessory = {
      type: 'button',
      text: { type: 'plain_text', text: '스레드', emoji: true },
      url: workThreadPermalink,
      action_id: 'source_open_thread',
    };
  }

  return {
    text: `${title} — 시작`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title } },
      section,
    ],
  };
}

/**
 * Build Block Kit blocks for the "request complete" message posted back
 * to the original thread when a session closes or a PR is merged.
 *
 * Layout (Bauhaus — up to 7 blocks):
 *   header: session title (invariant)
 *   section: text(결론) + fields(상태/소요/담당/실행/검증)
 *   divider
 *   section: Issue text + fields(원인/영향)    [if issue linked]
 *   section: PR text + fields(수정/테스트)     [if PR linked]
 *   section: 다음 작업
 *   actions: PR button (primary) + Issue button + 스레드 button
 */
export function buildRequestCompleteBlocks(
  session: ConversationSession,
  trigger: 'merged' | 'closed',
  options?: {
    workThreadPermalink?: string | null;
    turnSummary?: string;
    executiveSummary?: string;
    verifyResult?: string;
    issueContext?: { cause?: string; impact?: string };
    prContext?: { fix?: string; test?: string };
  }
): { text: string; blocks: any[] } {
  const title = session.title || 'Session';
  const model = session.model ? ThreadHeaderBuilder.formatModelName(session.model) : undefined;
  const workflow = session.workflow || 'default';
  const statusLabel = trigger === 'merged' ? '머지 완료' : '완료';

  // Parse turn summary for elapsed time
  const elapsed = options?.turnSummary?.match(/⏱\s*(.+?)(?:\s*·|$)/)?.[1]?.trim();

  // ── Hero section ──
  const heroFields: any[] = [
    { type: 'mrkdwn', text: `*상태*\n${statusLabel}` },
  ];

  if (elapsed) {
    heroFields.push({ type: 'mrkdwn', text: `*소요*\n${elapsed}` });
  }

  if (session.ownerId) {
    heroFields.push({ type: 'mrkdwn', text: `*담당*\n<@${session.ownerId}>` });
  }

  const envParts = [`\`${workflow}\``];
  if (model) envParts.push(`\`${model}\``);
  heroFields.push({ type: 'mrkdwn', text: `*실행*\n${envParts.join(' · ')}` });

  if (options?.verifyResult) {
    heroFields.push({ type: 'mrkdwn', text: `*검증*\n${options.verifyResult}` });
  }

  // Build conclusion text
  const conclusionParts: string[] = [];
  if (options?.executiveSummary) {
    conclusionParts.push(`*결론*\n${options.executiveSummary}`);
  }

  const heroText = conclusionParts.length > 0
    ? conclusionParts.join('\n\n')
    : `*결론*\n${title} ${statusLabel}`;

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: title } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: heroText },
      fields: heroFields,
    },
  ];

  // ── Issue section ──
  const hasIssue = session.links?.issue?.url;
  const hasPR = session.links?.pr?.url;

  if (hasIssue || hasPR) {
    blocks.push({ type: 'divider' });
  }

  if (hasIssue) {
    const issueLabel = session.links!.issue!.label || 'Issue';
    const issueUrl = session.links!.issue!.url;
    const issueTitle = session.links!.issue!.title;
    const issueText = issueTitle
      ? `*Issue* <${issueUrl}|${issueLabel}>\n${issueTitle}`
      : `*Issue* <${issueUrl}|${issueLabel}>`;

    const issueSection: any = {
      type: 'section',
      text: { type: 'mrkdwn', text: issueText },
    };

    if (options?.issueContext?.cause || options?.issueContext?.impact) {
      issueSection.fields = [];
      if (options.issueContext.cause) {
        issueSection.fields.push({ type: 'mrkdwn', text: `*원인*\n${options.issueContext.cause}` });
      }
      if (options.issueContext.impact) {
        issueSection.fields.push({ type: 'mrkdwn', text: `*영향*\n${options.issueContext.impact}` });
      }
    }

    blocks.push(issueSection);
  }

  // ── PR section ──
  if (hasPR) {
    const prLabel = session.links!.pr!.label || 'PR';
    const prUrl = session.links!.pr!.url;
    const prTitle = session.links!.pr!.title;
    const prText = prTitle
      ? `*PR* <${prUrl}|${prLabel}>\n${prTitle}`
      : `*PR* <${prUrl}|${prLabel}>`;

    const prSection: any = {
      type: 'section',
      text: { type: 'mrkdwn', text: prText },
    };

    if (options?.prContext?.fix || options?.prContext?.test) {
      prSection.fields = [];
      if (options.prContext.fix) {
        prSection.fields.push({ type: 'mrkdwn', text: `*수정*\n${options.prContext.fix}` });
      }
      if (options.prContext.test) {
        prSection.fields.push({ type: 'mrkdwn', text: `*테스트*\n${options.prContext.test}` });
      }
    }

    blocks.push(prSection);
  }

  // ── Actions row ──
  const actionElements: any[] = [];

  if (hasPR) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: session.links!.pr!.label || 'PR', emoji: true },
      url: session.links!.pr!.url,
      action_id: 'source_open_pr',
      style: 'primary',
    });
  }

  if (hasIssue) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: session.links!.issue!.label || 'Issue', emoji: true },
      url: session.links!.issue!.url,
      action_id: 'source_open_issue',
    });
  }

  if (options?.workThreadPermalink) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '스레드', emoji: true },
      url: options.workThreadPermalink,
      action_id: 'source_open_thread',
    });
  }

  if (actionElements.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actionElements,
    });
  }

  return {
    text: `${title} — ${statusLabel}`,
    blocks,
  };
}

/**
 * Post a work summary to the original (source) thread.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * @param slackApi - Slack API helper
 * @param session - The session that completed
 * @param trigger - What triggered the summary ('merged' | 'closed')
 */
export async function postSourceThreadSummary(
  slackApi: SlackApiHelper,
  session: ConversationSession,
  trigger: 'merged' | 'closed',
): Promise<void> {
  if (!session.sourceThread) {
    return;
  }

  try {
    const { channel, threadTs } = session.sourceThread;

    // Get work thread permalink
    const sessionChannel = session.channelId;
    const sessionThreadTs = session.threadRootTs || session.threadTs;
    let workThreadPermalink: string | null = null;
    if (sessionChannel && sessionThreadTs) {
      workThreadPermalink = await slackApi.getPermalink(sessionChannel, sessionThreadTs);
      if (!workThreadPermalink) {
        logger.warn('Failed to get permalink for work thread in summary', {
          sessionChannel,
          sessionThreadTs,
        });
      }
    }

    // Parse turn summary for metrics
    const turnSummary = session.actionPanel?.summaryBlocks
      ? undefined // summaryBlocks exist but we don't parse them here
      : undefined;

    const payload = buildRequestCompleteBlocks(session, trigger, {
      workThreadPermalink,
      turnSummary,
    });

    await slackApi.postMessage(channel, payload.text, {
      threadTs,
      blocks: payload.blocks,
    });

    logger.info('Posted source thread summary (Block Kit)', {
      trigger,
      sourceChannel: channel,
      sourceThreadTs: threadTs,
      title: session.title,
      blockCount: payload.blocks.length,
    });
  } catch (error) {
    logger.error('Failed to post source thread summary', error);
  }
}
