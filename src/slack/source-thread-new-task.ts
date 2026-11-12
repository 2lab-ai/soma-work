/**
 * SSOT 2026-11-12 — an instruction given in a source thread is new work.
 *
 * A source thread is a thread whose earlier mention moved to its own work thread. A later mention there used to get
 * the linked session's status card and nothing else: the instruction was dropped. Now its sender is asked by DM
 * whether to run it as a new task. On 새 작업으로 진행 the original message runs exactly as a first mention there
 * would: a new work thread, linked back to the same source thread (one source thread, several work threads), whose
 * result is reported back to the source thread when the work completes.
 *
 * The DM button carries only where the instruction is (channel, thread, message ts, sender). The words are read back
 * from Slack on the click, so nothing is stored and a restart between the DM and the click loses nothing.
 */

import type { SourceThreadNewTaskRequest } from '@soma/slack/event-router';
import { Logger } from '../logger';
import type { MessageEvent, MessageHandler, RespondFn, SayFn } from './actions/types';

const logger = new Logger('SourceThreadNewTask');

export const NEW_TASK_ACTION_PREFIX = 'src_new_task_';
const START_ACTION = `${NEW_TASK_ACTION_PREFIX}start`;
const CANCEL_ACTION = `${NEW_TASK_ACTION_PREFIX}cancel`;

/** Slack section text limit is 3000; the quote leaves room for the heading. */
const QUOTE_LIMIT = 2000;

/** Where the instruction is and who sent it — all a click needs. */
export interface NewTaskRef {
  channel: string;
  threadTs: string;
  ts: string;
  user: string;
}

export interface SourceThreadNewTaskSlackApi {
  openDmChannel(userId: string): Promise<string>;
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[]; attachments?: any[] },
  ): Promise<{ ts?: string; channel?: string } | undefined>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<unknown>;
  getPermalink(channel: string, ts: string): Promise<string | null>;
  getThreadMessage(channel: string, threadTs: string, ts: string): Promise<any | null>;
  getBotUserId(): Promise<string>;
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quote(text: string): string {
  const clipped = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
  return escapeMrkdwn(clipped)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function section(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/** The DM: the instruction, the work threads it would sit beside, and the two buttons. */
export function buildNewTaskOfferMessage(
  request: SourceThreadNewTaskRequest,
  sourceLink: string | null,
): { text: string; blocks: any[] } {
  const value = JSON.stringify({ c: request.channel, t: request.threadTs, m: request.ts, u: request.user });
  const thread = sourceLink ? `<${sourceLink}|소스 스레드>` : '소스 스레드';
  const blocks: any[] = [section(`*${thread}에 남긴 지시를 새 작업으로 진행할까요?*\n${quote(request.text)}`)];
  if (request.linked.length > 0) {
    const lines = request.linked.map(
      (s) => `• "${escapeMrkdwn(s.title || 'Untitled')}" — ${escapeMrkdwn(s.activityState || 'unknown')}`,
    );
    blocks.push(section(`이 스레드에서 이미 진행된 작업:\n${lines.join('\n')}`.slice(0, 3000)));
  }
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `새 작업으로 진행하면 새 작업 스레드를 만들어 작업하고, 끝나면 결과를 ${thread}에 보고합니다.`,
      },
    ],
  });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: START_ACTION,
        style: 'primary',
        text: { type: 'plain_text', text: '새 작업으로 진행', emoji: true },
        value,
      },
      {
        type: 'button',
        action_id: CANCEL_ACTION,
        text: { type: 'plain_text', text: '취소', emoji: true },
        value,
      },
    ],
  });
  return { text: '소스 스레드에 남긴 지시를 새 작업으로 진행할까요?', blocks };
}

/** A click on one of the DM's buttons, or undefined when it is not one. */
export function parseNewTaskAction(body: any): { decision: 'start' | 'cancel'; ref: NewTaskRef } | undefined {
  const action = body?.actions?.[0];
  const decision =
    action?.action_id === START_ACTION ? 'start' : action?.action_id === CANCEL_ACTION ? 'cancel' : undefined;
  if (!decision || typeof action.value !== 'string') return undefined;
  try {
    const v = JSON.parse(action.value);
    const fields = [v?.c, v?.t, v?.m, v?.u];
    if (!fields.every((f) => typeof f === 'string' && f.length > 0)) return undefined;
    return { decision, ref: { channel: v.c, threadTs: v.t, ts: v.m, user: v.u } };
  } catch {
    return undefined;
  }
}

export class SourceThreadNewTask {
  /** Instructions already answered in this process — a second click never starts a second task. */
  private readonly answered = new Set<string>();

  constructor(
    private readonly deps: {
      slackApi: SourceThreadNewTaskSlackApi;
      /** The normal message entry (`SlackHandler.handleMessage`) — what a first mention goes through. */
      messageHandler: MessageHandler;
    },
  ) {}

  /** DM the sender the start / cancel choice. True when the DM was posted. Never throws. */
  async offer(request: SourceThreadNewTaskRequest): Promise<boolean> {
    try {
      const link = await this.deps.slackApi.getPermalink(request.channel, request.threadTs).catch(() => null);
      const dm = await this.deps.slackApi.openDmChannel(request.user);
      const message = buildNewTaskOfferMessage(request, link);
      const posted = await this.deps.slackApi.postMessage(dm, message.text, { blocks: message.blocks });
      logger.info('Offered a source-thread instruction as a new task', {
        channel: request.channel,
        threadTs: request.threadTs,
        ts: request.ts,
        user: request.user,
      });
      return !!posted?.ts;
    } catch (error) {
      logger.warn('Could not DM the new-task offer', {
        channel: request.channel,
        threadTs: request.threadTs,
        user: request.user,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async handleAction(body: any, respond: RespondFn): Promise<void> {
    const parsed = parseNewTaskAction(body);
    if (!parsed) {
      logger.warn('src_new_task: unrecognised payload');
      return;
    }
    const { decision, ref } = parsed;
    const actor = typeof body?.user?.id === 'string' ? body.user.id : undefined;
    if (actor !== ref.user) {
      await this.tell(respond, '🚫 지시를 남긴 사람만 응답할 수 있습니다.');
      return;
    }
    const key = `${ref.channel}:${ref.ts}`;
    if (this.answered.has(key)) {
      await this.tell(respond, 'ℹ️ 이미 응답한 요청입니다.');
      return;
    }
    this.answered.add(key);
    const dm = {
      channel: body?.container?.channel_id ?? body?.channel?.id,
      ts: body?.container?.message_ts ?? body?.message?.ts,
    };
    const link = await this.deps.slackApi.getPermalink(ref.channel, ref.threadTs).catch(() => null);
    const thread = link ? `<${link}|소스 스레드>` : '소스 스레드';

    if (decision === 'cancel') {
      await this.updateDm(dm, `취소했습니다 — ${thread}의 이 지시는 실행하지 않습니다.`);
      return;
    }

    // The words come from Slack, not the button: the message must still be there and still be the sender's.
    const original = await this.deps.slackApi.getThreadMessage(ref.channel, ref.threadTs, ref.ts);
    if (!original || original.user !== ref.user || typeof original.text !== 'string') {
      await this.updateDm(dm, `⚠️ ${thread}에서 원본 지시를 찾을 수 없어 시작하지 못했습니다 — 다시 멘션해 주세요.`);
      return;
    }
    const botId = await this.deps.slackApi.getBotUserId().catch(() => undefined);
    const text = (botId ? original.text.replace(new RegExp(`<@${botId}>`, 'g'), '') : original.text).trim();
    if (!text) {
      await this.updateDm(dm, `⚠️ 지시 내용이 없어 시작하지 않았습니다 — ${thread}`);
      return;
    }

    await this.updateDm(dm, `✅ 새 작업으로 시작합니다 — 새 작업 스레드는 ${thread}에 안내됩니다.`);
    logger.info('Starting a source-thread instruction as a new task', {
      channel: ref.channel,
      threadTs: ref.threadTs,
      ts: ref.ts,
    });

    // Exactly a first mention in the source thread: the pipeline makes the new work thread and links it back.
    // `team` rides along as on the live event — the channel stream (`chat.startStream`) needs the recipient team.
    const event: MessageEvent & { team?: string } = {
      channel: ref.channel,
      thread_ts: ref.threadTs,
      ts: ref.ts,
      user: ref.user,
      text,
      ...(typeof original.team === 'string' && original.team ? { team: original.team } : {}),
    };
    const say: SayFn = async (args: any) =>
      this.deps.slackApi.postMessage(ref.channel, (typeof args === 'string' ? args : args?.text) || ' ', {
        threadTs: (typeof args === 'string' ? undefined : args?.thread_ts) || ref.threadTs,
        blocks: typeof args === 'string' ? undefined : args?.blocks,
        attachments: typeof args === 'string' ? undefined : args?.attachments,
      });
    // Not awaited to its end: the turn runs on after the click is answered.
    void this.deps
      .messageHandler(event, say)
      .catch((error) => logger.error('New task from a source thread failed to start', { key, error }));
  }

  private async updateDm(dm: { channel?: string; ts?: string }, text: string): Promise<void> {
    if (!dm.channel || !dm.ts) return;
    try {
      await this.deps.slackApi.updateMessage(dm.channel, dm.ts, text, [section(text)]);
    } catch (error) {
      logger.warn('src_new_task: could not update the DM', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async tell(respond: RespondFn, text: string): Promise<void> {
    try {
      await respond({ response_type: 'ephemeral', replace_original: false, text });
    } catch (error) {
      logger.warn('src_new_task: could not reply to the click', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
