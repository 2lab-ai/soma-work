/**
 * Dashboard "New task" — a new Slack channel for a repo (2026-11-05).
 *
 * An admin starting a task on a repo no channel is mapped to gets one made for
 * it, in this order:
 *
 *   1. the repo is checked on GitHub (a repo the bot cannot read is refused;
 *      GitHub not configured or not answering does not block);
 *   2. a channel the registry already maps to the repo is used instead — a
 *      second channel for the same repo only splits its work;
 *   3. `conversations.create`, then the purpose `https://github.com/<repo>` —
 *      the one thing that maps a channel to its repo (ChannelRegistry reads
 *      it) — then the admin is invited;
 *   4. the registry learns the channel from these values (no read back).
 *
 * A channel made but not described or not joined is archived and the launch
 * fails: half a channel is worse than none. Slack's refusals keep their
 * meaning as HTTP statuses (`name_taken` 409, `restricted_action` 403, a
 * missing scope 503). Every Slack / GitHub effect is injected
 * (`RepoChannelDeps`); the production wiring is in `new-task-provider.ts`.
 */

import { Logger } from '../logger';
import { type NewRepoChannelRequest, NewTaskError } from './new-task';

const logger = new Logger('DashboardNewTaskChannel');

export interface RepoChannelDeps {
  /** `ok`: GitHub has it and the bot reads it; `missing`: GitHub says 404 to the bot; `unknown`: not checked. */
  checkRepo(repo: string): Promise<'ok' | 'missing' | 'unknown'>;
  /** Channels the registry maps to the repo — the bot is a member of each. */
  mappedChannels(repo: string): Array<{ id: string; name: string }>;
  create(name: string, isPrivate: boolean): Promise<{ id: string; name: string }>;
  setPurpose(channelId: string, purpose: string): Promise<void>;
  invite(channelId: string, userId: string): Promise<void>;
  archive(channelId: string): Promise<void>;
  register(info: { id: string; name: string; purpose: string }): void;
}

export interface RepoChannelResult {
  channelId: string;
  channelName: string;
  /** false: a channel already mapped to the repo was used. */
  created: boolean;
}

/** Slack's error code of a failed Web API call (`name_taken`, `missing_scope`, …); '' when it is not one. */
export function slackErrorCode(error: unknown): string {
  const e = error as { data?: { error?: unknown }; code?: unknown } | null;
  const code = e?.data?.error;
  return typeof code === 'string' ? code : '';
}

/** The admin is in the channel already (or is the bot): nothing to do. */
const INVITE_ALREADY = new Set(['already_in_channel', 'cant_invite_self']);

function refusalFor(code: string, name: string): NewTaskError {
  if (code === 'name_taken') {
    return new NewTaskError(409, `#${name} 이름의 채널이 이미 있습니다 (보관된 채널 포함) — 다른 이름을 써 주세요`);
  }
  if (code.startsWith('invalid_name')) {
    return new NewTaskError(400, `#${name}은 Slack 채널 이름으로 쓸 수 없습니다 — 소문자·숫자·-·_ 80자 이내`);
  }
  if (code === 'restricted_action') {
    return new NewTaskError(403, '워크스페이스 설정이 봇의 채널 생성을 막고 있습니다');
  }
  if (code === 'missing_scope' || code === 'not_allowed_token_type') {
    return new NewTaskError(
      503,
      '봇에 채널을 만들 권한(channels:manage)이 없습니다 — Slack 앱 설정에서 권한을 추가하고 다시 설치해 주세요',
    );
  }
  return new NewTaskError(502, 'Slack 채널을 만들지 못했습니다');
}

/** Archive a channel this launch made and could not finish; a failure here is logged, the launch fails anyway. */
async function discard(channelId: string, deps: RepoChannelDeps, why: string): Promise<void> {
  try {
    await deps.archive(channelId);
    logger.warn('New repo channel archived: it could not be finished', { channelId, why });
  } catch (error) {
    logger.error('New repo channel could not be archived — it stays unmapped', {
      channelId,
      why,
      error: slackErrorCode(error) || String(error),
    });
  }
}

export async function ensureRepoChannel(
  userId: string,
  request: NewRepoChannelRequest,
  deps: RepoChannelDeps,
): Promise<RepoChannelResult> {
  const { repo, name, isPrivate } = request;

  // 1. The repo, as GitHub sees it from the bot.
  let found: 'ok' | 'missing' | 'unknown';
  try {
    found = await deps.checkRepo(repo);
  } catch (error) {
    logger.warn('New repo channel: GitHub check failed — not blocking', { repo, error: String(error) });
    found = 'unknown';
  }
  if (found === 'missing') {
    throw new NewTaskError(404, `GitHub에서 ${repo}를 찾을 수 없거나 봇이 읽을 수 없습니다`);
  }

  // 2. A channel the repo already has.
  const mapped = deps.mappedChannels(repo)[0];
  if (mapped) {
    try {
      await deps.invite(mapped.id, userId);
    } catch (error) {
      const code = slackErrorCode(error);
      if (!INVITE_ALREADY.has(code)) {
        logger.error('New repo channel: invite to the mapped channel failed', { channel: mapped.id, userId, code });
        throw new NewTaskError(502, `#${mapped.name}에 초대하지 못했습니다 — 채널에 직접 참여한 뒤 다시 시도해 주세요`);
      }
    }
    logger.info('New repo channel: the repo already has a channel', { repo, channel: mapped.id, userId });
    return { channelId: mapped.id, channelName: mapped.name, created: false };
  }

  // 3. A new channel, described and joined.
  let made: { id: string; name: string };
  try {
    made = await deps.create(name, isPrivate);
  } catch (error) {
    const code = slackErrorCode(error);
    logger.error('New repo channel: create failed', { repo, name, isPrivate, code: code || String(error) });
    throw refusalFor(code, name);
  }
  const purpose = `https://github.com/${repo}`;
  try {
    await deps.setPurpose(made.id, purpose);
  } catch (error) {
    await discard(made.id, deps, `purpose: ${slackErrorCode(error) || String(error)}`);
    throw new NewTaskError(502, `#${made.name}에 repo를 적지 못해 채널을 보관했습니다 — 다시 시도해 주세요`);
  }
  try {
    await deps.invite(made.id, userId);
  } catch (error) {
    const code = slackErrorCode(error);
    if (!INVITE_ALREADY.has(code)) {
      await discard(made.id, deps, `invite: ${code || String(error)}`);
      throw new NewTaskError(502, `#${made.name}에 초대하지 못해 채널을 보관했습니다 — 다시 시도해 주세요`);
    }
  }

  // 4. The registry knows it from now on: offered in the composer, its repo in every session's prompt.
  deps.register({ id: made.id, name: made.name, purpose });
  logger.info('New repo channel made', { repo, channel: made.id, name: made.name, isPrivate, userId, checked: found });
  return { channelId: made.id, channelName: made.name, created: true };
}
