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

// ── BlockKit type interfaces ──

interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

interface SlackField {
  type: 'mrkdwn';
  text: string;
}

interface SlackBlock {
  type: string;
  text?: SlackTextObject;
  fields?: SlackField[];
  accessory?: Record<string, unknown>;
  elements?: Record<string, unknown>[];
}

// ── Slack text truncation helpers ──

/** Slack Block Kit text limits */
const SLACK_LIMITS = {
  HEADER_TEXT: 150,
  SECTION_TEXT: 3000,
  FIELD_TEXT: 2000,
  BUTTON_TEXT: 75,
} as const;

/** Truncate text to a max length, appending '...' if truncated. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

/** Escape mrkdwn special characters in user-provided text. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build common metadata fields (owner + execution environment). */
function buildMetaFields(
  session: ConversationSession,
  workflow: string,
  model?: string
): SlackField[] {
  const fields: SlackField[] = [];
  if (session.ownerId) {
    fields.push({ type: 'mrkdwn', text: truncate(`*담당*\n<@${session.ownerId}>`, SLACK_LIMITS.FIELD_TEXT) });
  }
  const envParts = [`\`${workflow}\``];
  if (model) envParts.push(`\`${model}\``);
  fields.push({ type: 'mrkdwn', text: truncate(`*실행*\n${envParts.join(' · ')}`, SLACK_LIMITS.FIELD_TEXT) });
  return fields;
}

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
): { text: string; blocks: SlackBlock[] } {
  const title = session.title || 'Session';
  const safeTitle = truncate(title, SLACK_LIMITS.HEADER_TEXT);
  const model = session.model ? ThreadHeaderBuilder.formatModelName(session.model) : undefined;
  const workflow = session.workflow || 'default';

  const fields: SlackField[] = [
    { type: 'mrkdwn', text: truncate('*상태*\n시작', SLACK_LIMITS.FIELD_TEXT) },
  ];

  fields.push(...buildMetaFields(session, workflow, model));

  const section: SlackBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: truncate(`*목표*\n${escapeMrkdwn(title)}`, SLACK_LIMITS.SECTION_TEXT) },
    fields,
  };

  if (workThreadPermalink) {
    section.accessory = {
      type: 'button',
      text: { type: 'plain_text', text: truncate('스레드', SLACK_LIMITS.BUTTON_TEXT), emoji: true },
      url: workThreadPermalink,
      action_id: 'source_open_thread',
    };
  }

  return {
    text: `${safeTitle} — 시작`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: safeTitle } },
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
): { text: string; blocks: SlackBlock[] } {
  const title = session.title || 'Session';
  const safeTitle = truncate(title, SLACK_LIMITS.HEADER_TEXT);
  const model = session.model ? ThreadHeaderBuilder.formatModelName(session.model) : undefined;
  const workflow = session.workflow || 'default';
  const statusLabel = trigger === 'merged' ? '머지 완료' : '완료';

  // Parse turn summary for elapsed time
  const elapsed = options?.turnSummary?.match(/⏱\s*(.+?)(?:\s*·|$)/)?.[1]?.trim();

  // ── Hero section ──
  const heroFields: SlackField[] = [
    { type: 'mrkdwn', text: truncate(`*상태*\n${statusLabel}`, SLACK_LIMITS.FIELD_TEXT) },
  ];

  if (elapsed) {
    heroFields.push({ type: 'mrkdwn', text: truncate(`*소요*\n${elapsed}`, SLACK_LIMITS.FIELD_TEXT) });
  }

  heroFields.push(...buildMetaFields(session, workflow, model));

  if (options?.verifyResult) {
    heroFields.push({ type: 'mrkdwn', text: truncate(`*검증*\n${escapeMrkdwn(options.verifyResult)}`, SLACK_LIMITS.FIELD_TEXT) });
  }

  // Build conclusion text
  const conclusionParts: string[] = [];
  if (options?.executiveSummary) {
    conclusionParts.push(`*결론*\n${escapeMrkdwn(options.executiveSummary)}`);
  }

  const heroText = conclusionParts.length > 0
    ? conclusionParts.join('\n\n')
    : `*결론*\n${escapeMrkdwn(title)} ${statusLabel}`;

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: safeTitle } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(heroText, SLACK_LIMITS.SECTION_TEXT) },
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
      ? `*Issue* <${issueUrl}|${escapeMrkdwn(issueLabel)}>\n${escapeMrkdwn(issueTitle)}`
      : `*Issue* <${issueUrl}|${escapeMrkdwn(issueLabel)}>`;

    const issueSection: SlackBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(issueText, SLACK_LIMITS.SECTION_TEXT) },
    };

    if (options?.issueContext?.cause || options?.issueContext?.impact) {
      issueSection.fields = [];
      if (options.issueContext.cause) {
        issueSection.fields.push({ type: 'mrkdwn', text: truncate(`*원인*\n${escapeMrkdwn(options.issueContext.cause)}`, SLACK_LIMITS.FIELD_TEXT) });
      }
      if (options.issueContext.impact) {
        issueSection.fields.push({ type: 'mrkdwn', text: truncate(`*영향*\n${escapeMrkdwn(options.issueContext.impact)}`, SLACK_LIMITS.FIELD_TEXT) });
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
      ? `*PR* <${prUrl}|${escapeMrkdwn(prLabel)}>\n${escapeMrkdwn(prTitle)}`
      : `*PR* <${prUrl}|${escapeMrkdwn(prLabel)}>`;

    const prSection: SlackBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(prText, SLACK_LIMITS.SECTION_TEXT) },
    };

    if (options?.prContext?.fix || options?.prContext?.test) {
      prSection.fields = [];
      if (options.prContext.fix) {
        prSection.fields.push({ type: 'mrkdwn', text: truncate(`*수정*\n${escapeMrkdwn(options.prContext.fix)}`, SLACK_LIMITS.FIELD_TEXT) });
      }
      if (options.prContext.test) {
        prSection.fields.push({ type: 'mrkdwn', text: truncate(`*테스트*\n${escapeMrkdwn(options.prContext.test)}`, SLACK_LIMITS.FIELD_TEXT) });
      }
    }

    blocks.push(prSection);
  }

  // ── Actions row ──
  const actionElements: Record<string, unknown>[] = [];

  if (hasPR) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: truncate(session.links!.pr!.label || 'PR', SLACK_LIMITS.BUTTON_TEXT), emoji: true },
      url: session.links!.pr!.url,
      action_id: 'source_open_pr',
      style: 'primary',
    });
  }

  if (hasIssue) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: truncate(session.links!.issue!.label || 'Issue', SLACK_LIMITS.BUTTON_TEXT), emoji: true },
      url: session.links!.issue!.url,
      action_id: 'source_open_issue',
    });
  }

  if (options?.workThreadPermalink) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: truncate('스레드', SLACK_LIMITS.BUTTON_TEXT), emoji: true },
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
    text: `${safeTitle} — ${statusLabel}`,
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
      try {
        workThreadPermalink = await slackApi.getPermalink(sessionChannel, sessionThreadTs);
      } catch (permalinkError) {
        logger.warn('getPermalink failed, continuing without permalink', { error: permalinkError });
      }
      if (!workThreadPermalink) {
        logger.warn('Failed to get permalink for work thread in summary', {
          sessionChannel,
          sessionThreadTs,
        });
      }
    }

    const payload = buildRequestCompleteBlocks(session, trigger, {
      workThreadPermalink,
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
