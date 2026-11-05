/**
 * Dashboard "New task" — a new Slack channel for a repo (2026-11-05).
 *
 * An admin starting a task on a repo no channel is mapped to gets one made for
 * it, in this order:
 *
 *   1. the repo is checked on GitHub (a repo the bot cannot read is refused;
 *      GitHub not configured or not answering does not block);
 *   2. a live channel the registry already maps to the repo is used instead —
 *      a second channel for the same repo only splits its work. A private
 *      request never lands in a public one (refused: the admin decides);
 *   3. `conversations.create`, then the purpose `https://github.com/<repo>` —
 *      the one thing that maps a channel to its repo (ChannelRegistry reads
 *      it) — then the admin is invited;
 *   4. the registry learns the channel from these values (no read back).
 *
 * One repo is handled at a time (two admins at once would otherwise make two
 * channels). A channel made but not described or not joined is archived and
 * the launch fails: half a channel is worse than none — and when the archive
 * fails too, the answer says the channel is still there. Slack's refusals keep
 * their meaning as HTTP statuses (`name_taken` 409, `restricted_action` 403, a
 * missing scope 503) at every step. Every Slack / GitHub effect is injected
 * (`RepoChannelDeps`); the production wiring is in `new-task-provider.ts`.
 */

import { Logger } from '../logger';
import { type NewRepoChannelRequest, NewTaskError } from './new-task';

const logger = new Logger('DashboardNewTaskChannel');

/** A channel the registry maps to the repo. `isPrivate` undefined: not known. */
export interface MappedChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
}

export interface RepoChannelDeps {
  /** `ok`: GitHub has it and the bot reads it; `missing`: GitHub says 404 to the bot; `unknown`: not checked. */
  checkRepo(repo: string): Promise<'ok' | 'missing' | 'unknown'>;
  /** Live (not archived) channels the registry maps to the repo, the most specific first — the bot is in each. */
  mappedChannels(repo: string): MappedChannel[];
  create(name: string, isPrivate: boolean): Promise<{ id: string; name: string }>;
  setPurpose(channelId: string, purpose: string): Promise<void>;
  invite(channelId: string, userId: string): Promise<void>;
  archive(channelId: string): Promise<void>;
  register(info: { id: string; name: string; purpose: string; isPrivate: boolean }): void;
  /** Mark a channel name as being made (its creation join is ours to register); returns the unmark. */
  beginMaking?(name: string): () => void;
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
const MISSING_SCOPE =
  '봇에 채널을 만들 권한(channels:manage)이 없습니다 — Slack 앱 설정에서 권한을 추가하고 다시 설치해 주세요';
const RESTRICTED = '워크스페이스 설정이 봇의 채널 작업을 막고 있습니다';

/**
 * The refusal for a Slack error at any step: a missing scope and a workspace restriction keep their own status and
 * words; anything else is `fallback` (the step's own words, 502).
 */
function refusalFor(code: string, fallback: string): NewTaskError {
  if (code === 'missing_scope' || code === 'not_allowed_token_type') return new NewTaskError(503, MISSING_SCOPE);
  if (code === 'restricted_action') return new NewTaskError(403, RESTRICTED);
  return new NewTaskError(502, fallback);
}

function createRefusal(code: string, name: string): NewTaskError {
  if (code === 'name_taken') {
    return new NewTaskError(409, `#${name} 이름의 채널이 이미 있습니다 (보관된 채널 포함) — 다른 이름을 써 주세요`);
  }
  if (code.startsWith('invalid_name')) {
    return new NewTaskError(400, `#${name}은 Slack 채널 이름으로 쓸 수 없습니다 — 소문자·숫자·-·_ 80자 이내`);
  }
  return refusalFor(code, 'Slack 채널을 만들지 못했습니다');
}

/** Archive a channel this launch made and could not finish; true when it is archived. */
async function discard(channelId: string, deps: RepoChannelDeps, why: string): Promise<boolean> {
  try {
    await deps.archive(channelId);
    logger.warn('New repo channel archived: it could not be finished', { channelId, why });
    return true;
  } catch (error) {
    logger.error('New repo channel could not be archived — it stays, unmapped', {
      channelId,
      why,
      error: slackErrorCode(error) || String(error),
    });
    return false;
  }
}

/** The step's failure after a half-made channel was (or could not be) archived. */
async function abandon(
  made: { id: string; name: string },
  step: string,
  error: unknown,
  deps: RepoChannelDeps,
): Promise<never> {
  const code = slackErrorCode(error);
  const archived = await discard(made.id, deps, `${step}: ${code || String(error)}`);
  const what = step === 'purpose' ? 'repo를 적지 못해' : '초대하지 못해';
  // An archived channel keeps its name: a retry needs another one.
  const words = archived
    ? `#${made.name}에 ${what} 채널을 보관했습니다 — 보관된 채널이 이 이름을 계속 쓰니 다른 이름으로 다시 시도해 주세요`
    : `#${made.name}에 ${what} 작업을 시작하지 않았습니다 — 채널이 남아 있으니 직접 보관해 주세요`;
  const refusal = refusalFor(code, words);
  // A scope / restriction refusal keeps its own words; the channel's fate is told too.
  throw refusal.statusCode === 502 ? refusal : new NewTaskError(refusal.statusCode, `${refusal.message} (${words})`);
}

/** One repo at a time: the lookup, the creation and the registration of a repo never interleave. */
const repoLocks = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(repo: string, run: () => Promise<T>): Promise<T> {
  const before = repoLocks.get(repo) ?? Promise.resolve();
  const mine = before.then(run, run);
  const tail = mine.catch(() => undefined);
  repoLocks.set(repo, tail);
  try {
    return await mine;
  } finally {
    if (repoLocks.get(repo) === tail) repoLocks.delete(repo);
  }
}

export async function ensureRepoChannel(
  userId: string,
  request: NewRepoChannelRequest,
  deps: RepoChannelDeps,
): Promise<RepoChannelResult> {
  const { repo } = request;

  // 1. The repo, as GitHub sees it from the bot (outside the lock: it touches no channel).
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

  return withRepoLock(repo, () => ensureLocked(userId, request, deps, found));
}

async function ensureLocked(
  userId: string,
  request: NewRepoChannelRequest,
  deps: RepoChannelDeps,
  found: 'ok' | 'unknown',
): Promise<RepoChannelResult> {
  const { repo, name, isPrivate } = request;

  // 2. A channel the repo already has. A private request only ever goes to a channel known to be private; a
  //    public one in the way is the admin's call (409), never a silent landing.
  const mappedAll = deps.mappedChannels(repo);
  const candidates = isPrivate ? mappedAll.filter((c) => c.isPrivate === true) : mappedAll;
  for (const mapped of candidates) {
    try {
      await deps.invite(mapped.id, userId);
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'is_archived') {
        logger.warn('New repo channel: a mapped channel is archived — trying the next', { channel: mapped.id, repo });
        continue;
      }
      if (!INVITE_ALREADY.has(code)) {
        logger.error('New repo channel: invite to the mapped channel failed', { channel: mapped.id, userId, code });
        throw refusalFor(code, `#${mapped.name}에 초대하지 못했습니다 — 채널에 직접 참여한 뒤 다시 시도해 주세요`);
      }
    }
    logger.info('New repo channel: the repo already has a channel', { repo, channel: mapped.id, userId });
    return { channelId: mapped.id, channelName: mapped.name, created: false };
  }
  const inTheWay = isPrivate ? mappedAll.find((c) => c.isPrivate !== true) : undefined;
  if (inTheWay) {
    throw new NewTaskError(
      409,
      `이 repo에는 이미 공개 채널 #${inTheWay.name}이 있습니다 — 비공개를 끄고 그 채널에 올리거나, 그 채널을 쓰지 않을 거면 repo 연결을 먼저 정리해 주세요`,
    );
  }

  // 3. A new channel, described and joined. Its name is marked while we make it: Slack's creation join is ours.
  const done = deps.beginMaking?.(name) ?? (() => undefined);
  try {
    return await makeChannel(userId, request, deps, found);
  } finally {
    done();
  }
}

async function makeChannel(
  userId: string,
  request: NewRepoChannelRequest,
  deps: RepoChannelDeps,
  found: 'ok' | 'unknown',
): Promise<RepoChannelResult> {
  const { repo, name, isPrivate } = request;
  let made: { id: string; name: string };
  try {
    made = await deps.create(name, isPrivate);
  } catch (error) {
    const code = slackErrorCode(error);
    logger.error('New repo channel: create failed', { repo, name, isPrivate, code: code || String(error) });
    throw createRefusal(code, name);
  }
  const purpose = `https://github.com/${repo}`;
  try {
    await deps.setPurpose(made.id, purpose);
  } catch (error) {
    return abandon(made, 'purpose', error, deps);
  }
  try {
    await deps.invite(made.id, userId);
  } catch (error) {
    if (!INVITE_ALREADY.has(slackErrorCode(error))) return abandon(made, 'invite', error, deps);
  }

  // 4. The registry knows it from now on: offered in the composer, its repo in every session's prompt.
  deps.register({ id: made.id, name: made.name, purpose, isPrivate });
  logger.info('New repo channel made', { repo, channel: made.id, name: made.name, isPrivate, userId, checked: found });
  return { channelId: made.id, channelName: made.name, created: true };
}
