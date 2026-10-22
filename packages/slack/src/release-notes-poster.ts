/**
 * Release notes poster — the host side of the `release_notes` directive.
 *
 * Shape: a short root message (header "<Repo> <target> · <version>" + up to three
 * TL;DR bullets) and the full notes as replies in that root's thread.
 *
 * Where it goes is decided by the host from the operator's mapping
 * (SOMA_RELEASE_NOTES_CHANNELS → `ReleaseNotesRouting`, src/release-notes-routes.ts),
 * and only for deploy-workflow sessions; every other caller passes SESSION_ROUTING.
 *   - channel       → root in that channel; a link line in the deploy thread.
 *   - session       → root in the deploy session's channel (the behavior before routing).
 *   - deploy-thread → no channel root at all: header and notes as deploy-thread replies.
 * An unmatched deploy gets a notice in the deploy thread first (ℹ️, or ⚠️ when a
 * mapped branch is only spelled differently); malformed config entries get a ⚠️.
 *
 * Failure contract — the notes are never re-posted to another channel's root:
 *   - the root post in a mapped channel fails → warning + header + notes in the deploy thread;
 *   - a thread body chunk fails               → one retry, then warning + root link + the
 *                                               full notes in the deploy thread (no second header);
 *   - only the permalink is missing           → the link line names the channel, nothing re-posted.
 *
 * The body is posted as `markdown` blocks cut by `splitLossless`, never through
 * `markdownToBlocks`, which truncates long sections — the thread must hold every
 * character of the notes.
 */

import { Logger } from '@soma/common/logger';
import type { ReleaseNotesPayload } from './directives/release-notes-directive';
import { escapeSlackMrkdwn } from './mrkdwn-escape';

const logger = new Logger('ReleaseNotesPoster');

/** Slack caps header block text at 150 chars. */
const MAX_HEADER = 150;
/** One TL;DR bullet is a summary line, not a paragraph. */
const MAX_TLDR_LINE = 200;
/** Under the 12,000-char cap of a `markdown` block (per message), with headroom. */
const BODY_CHUNK = 10_000;
const ENV_NAME = 'SOMA_RELEASE_NOTES_CHANNELS';

export type ReleaseNotesDestination =
  | { kind: 'session' }
  | { kind: 'channel'; channel: string }
  | { kind: 'deploy-thread' };

export interface ReleaseNotesRouting {
  destination: ReleaseNotesDestination;
  /** No mapping matched exactly: the `*` fallback (or its absence) chose the destination. */
  unmapped: boolean;
  /** Configured mapping keys, for the notice. */
  keys: string[];
  /** Mapped keys whose branch is only spelled differently — diagnostic, never a destination. */
  nearMisses: Array<{ key: string; channel: string }>;
  /** Malformed config entries that were dropped. */
  invalid: string[];
}

/** The routing of a session that may not use the operator mapping: its own channel, no notice. */
export const SESSION_ROUTING: ReleaseNotesRouting = {
  destination: { kind: 'session' },
  unmapped: false,
  keys: [],
  nearMisses: [],
  invalid: [],
};

export interface ReleaseNotesSlackApi {
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[] },
  ): Promise<{ ts?: string; channel?: string; threadTs?: string; echoedMessage?: boolean }>;
  getPermalink(channel: string, messageTs: string): Promise<string | null>;
  deleteMessage(channel: string, ts: string): Promise<void>;
}

export interface ReleaseNotesPostRequest {
  payload: ReleaseNotesPayload;
  /** The deploy session's channel and thread. */
  sessionChannel: string;
  sessionThreadTs: string;
  routing: ReleaseNotesRouting;
}

/**
 * Cut `text` into chunks of at most `max` chars whose concatenation is `text`.
 * Cuts after a newline when one falls inside the window, else hard-cuts.
 */
export function splitLossless(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const newline = rest.lastIndexOf('\n', max - 1);
    const cut = newline >= 0 ? newline + 1 : max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Break Slack's notifying control sequences (`<!channel>`, `<!here>`,
 * `<!subteam^…>`, `<@U…>`) with a zero-width space so notes quoting them
 * (commit messages do) never ping anyone. Every visible character is kept.
 */
export function neutralizeSlackMentions(text: string): string {
  return text.replace(/<([!@])/g, '<\u200B$1');
}

/**
 * Post a reply under `threadTs`. Slack silently drops a dead `thread_ts` and
 * posts at the channel root instead (`SlackApiHelper.getThreadRootState`), so a
 * reply that came back unthreaded is deleted and reported as a failure — a
 * "thread only" destination must never become a channel-root post.
 */
async function postReply(
  slackApi: ReleaseNotesSlackApi,
  channel: string,
  threadTs: string,
  text: string,
  blocks?: any[],
): Promise<void> {
  const result = await slackApi.postMessage(channel, text, blocks ? { threadTs, blocks } : { threadTs });
  if (result.echoedMessage && result.threadTs !== threadTs) {
    if (result.ts) {
      await slackApi.deleteMessage(result.channel ?? channel, result.ts).catch((error) => {
        logger.error('release notes reply leaked to the channel root and could not be deleted', {
          channel,
          ts: result.ts,
          error: errorText(error),
        });
      });
    }
    throw new Error(`thread ${threadTs} is gone — the reply landed at the channel root and was removed`);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `<#C123>` for an ID, the name as written for `#name`. */
function mention(channel: string): string {
  return channel.startsWith('#') ? channel : `<#${channel}>`;
}

function errorText(error: unknown): string {
  return (error as any)?.data?.error || (error as Error)?.message || String(error);
}

export function buildReleaseNotesHeader(payload: ReleaseNotesPayload): { text: string; blocks: any[] } {
  const repoName = payload.repo.split('/').pop() || payload.repo;
  const fullTitle = `🚀 ${repoName} ${payload.target} · ${payload.version}`;
  const title = clip(fullTitle, MAX_HEADER);
  if (title !== fullTitle) {
    logger.warn('release notes header clipped to the Slack header limit', {
      repo: payload.repo,
      length: fullTitle.length,
    });
  }
  const bullets = payload.tldr.map((line) => `• ${escapeSlackMrkdwn(clip(line, MAX_TLDR_LINE))}`);
  return {
    text: escapeSlackMrkdwn(`${title} — ${payload.tldr.join(' / ')}`),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: bullets.join('\n') } },
    ],
  };
}

/** Post the full notes under `threadTs`; each chunk retried once. Returns false if a chunk was lost. */
async function postBody(
  slackApi: ReleaseNotesSlackApi,
  channel: string,
  threadTs: string,
  text: string,
): Promise<boolean> {
  for (const chunk of splitLossless(neutralizeSlackMentions(text), BODY_CHUNK)) {
    let posted = false;
    for (let attempt = 1; attempt <= 2 && !posted; attempt++) {
      try {
        await postReply(slackApi, channel, threadTs, chunk, [{ type: 'markdown', text: chunk }]);
        posted = true;
      } catch (error) {
        logger.warn('release notes body chunk failed', { channel, attempt, error: errorText(error) });
      }
    }
    if (!posted) return false;
  }
  return true;
}

/** Header + notes as replies in the deploy thread — the destination when no channel root may be used. */
async function postIntoDeployThread(slackApi: ReleaseNotesSlackApi, req: ReleaseNotesPostRequest): Promise<void> {
  const header = buildReleaseNotesHeader(req.payload);
  await postReply(slackApi, req.sessionChannel, req.sessionThreadTs, header.text, header.blocks);
  if (!(await postBody(slackApi, req.sessionChannel, req.sessionThreadTs, req.payload.text))) {
    throw new Error('release notes could not be posted in the deploy thread');
  }
}

async function notify(slackApi: ReleaseNotesSlackApi, channel: string, threadTs: string, line: string): Promise<void> {
  try {
    await postReply(slackApi, channel, threadTs, line);
  } catch (error) {
    logger.warn('release notes notice could not be posted in the deploy thread', { channel, error: errorText(error) });
  }
}

/** Last-resort line in the deploy thread when posting the notes failed outright (best-effort). */
export async function reportReleaseNotesFailure(
  slackApi: ReleaseNotesSlackApi,
  channel: string,
  threadTs: string,
  payload: ReleaseNotesPayload,
  error: unknown,
): Promise<void> {
  await notify(
    slackApi,
    channel,
    threadTs,
    `⚠️ \`${payload.repo}@${payload.target}\` 릴리즈노트를 올리지 못했습니다 (${errorText(error)}). 노트는 이 세션 로그에만 남아 있습니다.`,
  );
}

function describeDestination(destination: ReleaseNotesDestination): string {
  if (destination.kind === 'session') return '이 채널에 올립니다.';
  if (destination.kind === 'channel') return `${mention(destination.channel)}에 올립니다.`;
  return `어느 채널에도 올리지 않고 이 스레드에 남깁니다 — 매핑을 추가하거나 \`*=session\`으로 기본 목적지를 여세요.`;
}

export async function postReleaseNotes(slackApi: ReleaseNotesSlackApi, req: ReleaseNotesPostRequest): Promise<void> {
  const { payload, sessionChannel, sessionThreadTs, routing } = req;
  const key = `${payload.repo}@${payload.target}`;
  // Notices are best-effort: a failed notice must not cost the notes themselves.
  const say = (line: string) => notify(slackApi, sessionChannel, sessionThreadTs, line);
  const { destination } = routing;

  if (routing.invalid.length > 0) {
    await say(
      `⚠️ ${ENV_NAME}에서 읽을 수 없는 항목을 무시했습니다: ${routing.invalid.map((e) => `\`${e}\``).join(', ')}`,
    );
  }
  if (routing.unmapped) {
    const where = describeDestination(destination);
    if (routing.nearMisses.length > 0) {
      const near = routing.nearMisses.map((n) => `\`${n.key}\` → ${mention(n.channel)}`).join(', ');
      await say(
        `⚠️ 릴리즈노트 \`${key}\`가 매핑 ${near}와 철자만 다릅니다. 그 채널로는 보내지 않습니다 — ${where} target을 매핑과 같은 브랜치 이름으로 쓰거나 ${ENV_NAME}를 고치세요.`,
      );
    } else {
      const keys = routing.keys.length > 0 ? routing.keys.map((k) => `\`${k}\``).join(', ') : '없음';
      await say(`ℹ️ ${ENV_NAME}에 \`${key}\` 매핑이 없습니다 (설정된 키: ${keys}). ${where}`);
    }
  }

  if (destination.kind === 'deploy-thread') {
    await postIntoDeployThread(slackApi, req);
    return;
  }

  const target = destination.kind === 'channel' ? destination.channel : sessionChannel;
  const header = buildReleaseNotesHeader(payload);

  let root: { ts?: string; channel?: string };
  try {
    root = await slackApi.postMessage(target, header.text, { blocks: header.blocks });
    if (!root.ts) throw new Error('no ts returned');
  } catch (error) {
    if (destination.kind !== 'channel') throw error;
    await say(
      `⚠️ 릴리즈노트를 ${mention(target)}에 올리지 못했습니다 (${errorText(error)}). ` +
        `다른 채널에는 올리지 않고 이 스레드에 남깁니다 — 봇을 그 채널에 초대하거나 ${ENV_NAME}를 고치세요.`,
    );
    await postIntoDeployThread(slackApi, req);
    return;
  }

  const rootChannel = root.channel ?? target;
  const rootTs = root.ts as string;
  const bodyPosted = await postBody(slackApi, rootChannel, rootTs, payload.text);

  if (!bodyPosted) {
    const link = await slackApi.getPermalink(rootChannel, rootTs);
    await say(
      `⚠️ 릴리즈노트 헤더는 ${mention(rootChannel)}에 올렸지만 스레드에 전문을 올리지 못했습니다${link ? ` (${link})` : ''}. 전문을 이 스레드에 남깁니다.`,
    );
    if (!(await postBody(slackApi, sessionChannel, sessionThreadTs, payload.text))) {
      throw new Error('release notes body could not be posted anywhere');
    }
    return;
  }

  if (rootChannel !== sessionChannel) {
    const link = await slackApi.getPermalink(rootChannel, rootTs);
    await say(`📋 릴리즈노트를 ${mention(rootChannel)}에 올렸습니다${link ? `: ${link}` : ''}`);
  }
}
