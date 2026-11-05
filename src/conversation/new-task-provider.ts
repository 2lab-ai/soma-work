/**
 * Dashboard "New task" — production wiring of `DashboardNewTaskProvider`
 * (SSOT 2026-10-23). `src/index.ts` builds one with the Slack client and the
 * message pipeline; everything it reads is a live source:
 *
 *   models / efforts / autogoal   UserSettingsStore + representative models
 *   channels                      ChannelRegistry (repo mapping) ∩ the user's
 *                                 Slack memberships (`users.conversations`)
 *   default channel               LastCommandChannelStore, then the user's sessions
 *   battery                       llmux `/llmux/status` or the CCT TokenManager
 *
 * Membership is cached for a few minutes for the composer and re-read
 * (`fresh`) when a task is submitted. If it cannot be read, no channel is
 * offered — never a guess from history.
 */

import type { WebClient } from '@slack/web-api';
import { getAuthMode } from '../auth/auth-runtime';
import { fetchLlmuxStatus } from '../auth/llmux-client';
import {
  findChannelsForRepo,
  getAllChannels,
  getChannel,
  markChannelBeingMade,
  upsertChannel,
} from '../channel-registry';
import { config } from '../config';
import { getGitHubAppAuth } from '../github-auth';
import { getLastCommandChannelStore } from '../last-command-channel-store';
import { Logger } from '../logger';
import { allowedEffortsFor } from '../session/effort-menu';
import { productionModelCatalogDeps } from '../session/model-catalog-deps';
import { listRepresentativeModels } from '../session/model-switch';
import { getTokenManager } from '../token-manager';
import { EFFORT_LEVELS, userSettingsStore } from '../user-settings-store';
import type { DashboardNewTaskProvider } from './dashboard';
import {
  buildNewTaskContext,
  isSlackFileUrl,
  type NewTaskAttachment,
  newTaskModelOptions,
  type UsageAccountView,
} from './new-task';
import { ensureRepoChannel, type RepoChannelDeps } from './new-task-channel';
import {
  launchNewTask,
  type NewTaskEvent,
  type NewTaskSay,
  type SlackEventFile,
  slackEventFileFrom,
} from './new-task-launcher';
import { cctSlotsToUsage, createTtlCache, llmuxAccountsToUsage } from './new-task-usage';
import { createSteerUploader, type SteerUploaderOptions } from './steer-uploads';

const logger = new Logger('DashboardNewTask');

const MEMBERSHIP_TTL_MS = 5 * 60_000;
const USAGE_TTL_MS = 60_000;
const MAX_MEMBERSHIP_PAGES = 20;
/** How long the bot's own scopes are trusted — a reinstall that adds `channels:manage` shows within this. */
const SCOPES_TTL_MS = 10 * 60_000;
const GITHUB_CHECK_TIMEOUT_MS = 5_000;

/** The bot token's scopes (Slack sends them with every Web API answer). */
async function botScopes(client: WebClient): Promise<Set<string>> {
  const res = await client.auth.test();
  return new Set(res.response_metadata?.scopes ?? []);
}

/**
 * The repo as GitHub shows it to the bot — the GitHub App installation first (the identity its git and gh work
 * with), a PAT only where no App is configured: 404 = missing (or not readable — either way the bot could not work
 * on it); no credentials, a timeout or any other answer = unknown.
 */
export async function checkRepoOnGitHub(repo: string): Promise<'ok' | 'missing' | 'unknown'> {
  let token = '';
  const app = getGitHubAppAuth();
  if (app) {
    try {
      token = (await app.getInstallationToken()) ?? '';
    } catch (error) {
      logger.warn('New repo channel: no GitHub App token — repo not checked', { repo, error: String(error) });
      return 'unknown';
    }
  } else {
    token = config.github.token || '';
  }
  if (!token) return 'unknown';
  const [owner, name] = repo.split('/');
  try {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'soma-work',
      },
      signal: AbortSignal.timeout(GITHUB_CHECK_TIMEOUT_MS),
    });
    if (res.ok) return 'ok';
    if (res.status === 404) return 'missing';
    return 'unknown';
  } catch (error) {
    logger.warn('New repo channel: GitHub did not answer — repo not checked', { repo, error: String(error) });
    return 'unknown';
  }
}

/** The Slack and registry side of a new repo channel. */
export function repoChannelDeps(client: WebClient): RepoChannelDeps {
  return {
    checkRepo: checkRepoOnGitHub,
    mappedChannels: (repo) =>
      findChannelsForRepo(repo)
        .map((id) => getChannel(id))
        .filter((c): c is NonNullable<typeof c> => !!c && c.isArchived !== true)
        .sort((a, b) => a.repos.length - b.repos.length)
        .map((c) => ({ id: c.id, name: c.name, ...(c.isPrivate === undefined ? {} : { isPrivate: c.isPrivate }) })),
    create: async (name, isPrivate) => {
      const res = await client.conversations.create({ name, is_private: isPrivate });
      const id = res.channel?.id;
      if (!id) throw new Error('conversations.create answered without a channel id');
      return { id, name: res.channel?.name || name };
    },
    setPurpose: async (channel, purpose) => {
      await client.conversations.setPurpose({ channel, purpose });
    },
    invite: async (channel, user) => {
      await client.conversations.invite({ channel, users: user });
    },
    archive: async (channel) => {
      await client.conversations.archive({ channel });
    },
    register: (info) => {
      upsertChannel(info);
    },
    beginMaking: (name) => markChannelBeingMade(name),
  };
}

export interface NewTaskProviderDeps {
  client: WebClient;
  /** The owner's display name for the task's thread header. */
  getUserName?(userId: string): Promise<string | undefined>;
  handleMessage(event: NewTaskEvent, say: NewTaskSay): Promise<unknown>;
  getSessionKey(channel: string, threadTs: string): string;
  hasSession(sessionKey: string): boolean;
  /** The user's sessions (owned or last initiated), for the default-channel fallback. */
  listUserSessions(userId: string): Array<{ channelId: string; lastActivity: number }>;
}

async function memberChannelIds(client: WebClient, userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MEMBERSHIP_PAGES; page++) {
    const res = await client.users.conversations({
      user: userId,
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    for (const c of res.channels ?? []) if (c.id) ids.add(c.id);
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return ids;
}

async function loadUsage(): Promise<{ accounts: UsageAccountView[]; source: string; fetchedAt: number }> {
  const now = Date.now();
  if (getAuthMode() === 'llmux') {
    const status = await fetchLlmuxStatus({ timeoutMs: 3_000 });
    return { accounts: llmuxAccountsToUsage(status.accounts ?? [], now), source: 'llmux', fetchedAt: now };
  }
  const snapshot = await getTokenManager().getSnapshot();
  return { accounts: cctSlotsToUsage(Object.values(snapshot.state ?? {}), now), source: 'cct', fetchedAt: now };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Upload into the thread; the ids Slack gave the files, in order (all of them, or it throws). */
export async function uploadFileIds(
  client: WebClient,
  channel: string,
  threadTs: string,
  files: NewTaskAttachment[],
): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: FilesUploadV2Arguments is a tagged union the multi-file branch does not narrow to
  const result: any = await client.filesUploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    file_uploads: files.map((f) => ({ file: f.data, filename: f.name, title: f.name })),
  } as any);
  const ids: string[] = (result?.files ?? [])
    .flatMap((r: any) => (Array.isArray(r?.files) ? r.files : [r]))
    .map((f: any) => f?.id)
    .filter((id: unknown): id is string => typeof id === 'string');
  if (ids.length !== files.length) {
    throw new Error(`Slack accepted ${ids.length} of ${files.length} files`);
  }
  return ids;
}

/** Read an uploaded file back in the shape the message pipeline downloads from. */
export async function resolveUploadedFile(client: WebClient, id: string): Promise<SlackEventFile> {
  let info: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    info = (await client.files.info({ file: id }))?.file;
    if (info?.url_private_download) break;
    await sleep(500);
  }
  if (!info?.url_private_download) throw new Error(`Slack has no download URL for file ${id} yet`);
  // The pipeline fetches this URL with the bot token: only ever a Slack file host.
  if (!isSlackFileUrl(info.url_private_download))
    throw new Error(`Slack returned a non-Slack download URL for file ${id}`);
  return slackEventFileFrom(id, info);
}

/**
 * Upload into the thread, then read each file back in the shape the message
 * pipeline downloads from (a new task's attachments). The panel composer's
 * files go through `createSteerUploader` on the same two steps.
 */
export async function uploadFiles(
  client: WebClient,
  channel: string,
  threadTs: string,
  files: NewTaskAttachment[],
): Promise<SlackEventFile[]> {
  const ids = await uploadFileIds(client, channel, threadTs, files);
  const out: SlackEventFile[] = [];
  for (const id of ids) out.push(await resolveUploadedFile(client, id));
  return out;
}

/**
 * The panel composer's uploader (`injectDashboardMessage`): one Slack upload
 * per file, kept by id so a retry never uploads a file Slack already took (#488).
 */
export function createSlackSteerUploader(client: WebClient, opts?: SteerUploaderOptions) {
  return createSteerUploader(
    {
      upload: async (channel, threadTs, file) => (await uploadFileIds(client, channel, threadTs, [file]))[0],
      resolve: (id) => resolveUploadedFile(client, id),
    },
    opts,
  );
}

/**
 * The models the dialog offers `userId` (nickname → id), from the model catalog
 * and the user's settings alone — no Slack call, no usage fetch. A dashboard
 * task resolves its model with this (#640 R2).
 */
export function offeredNewTaskModels(userId: string): Array<{ nickname: string; model: string }> {
  const { representativeModels, userDefaultModel, userDefaultModelLabel } = newTaskModelInputs(userId);
  return newTaskModelOptions(representativeModels, userDefaultModel, userDefaultModelLabel).options.map((m) => ({
    nickname: m.nickname,
    model: m.model,
  }));
}

/** The dialog's model inputs — one source for the context and the task launcher (#640 R3). */
function newTaskModelInputs(userId: string): {
  representativeModels: Array<{ nickname: string; model: string; label: string; effortLevels?: string[] }>;
  userDefaultModel: string;
  userDefaultModelLabel: string;
  userDefaultModelEffortLevels?: string[];
} {
  let representativeModels: Array<{ nickname: string; model: string; label: string; effortLevels?: string[] }> = [];
  try {
    representativeModels = listRepresentativeModels(productionModelCatalogDeps(), userId);
  } catch (error) {
    logger.warn('New task: representative models unavailable', { error: String(error) });
  }
  const userDefaultModel = userSettingsStore.getUserDefaultModel(userId);
  const userDefaultModelEffortLevels = [...allowedEffortsFor(userDefaultModel)];
  return {
    representativeModels,
    userDefaultModel,
    userDefaultModelLabel: userSettingsStore.getModelDisplayName(userDefaultModel),
    ...(userDefaultModelEffortLevels ? { userDefaultModelEffortLevels } : {}),
  };
}

export function createNewTaskProvider(deps: NewTaskProviderDeps): DashboardNewTaskProvider {
  const { client } = deps;
  const membership = createTtlCache((userId: string) => memberChannelIds(client, userId), MEMBERSHIP_TTL_MS);
  const usage = createTtlCache((_: 'pool') => loadUsage(), USAGE_TTL_MS);
  const scopes = createTtlCache((_: 'bot') => botScopes(client), SCOPES_TTL_MS);

  return {
    async channelCreation() {
      try {
        const held = await scopes.get('bot');
        // channels:manage makes, describes, invites to and archives a public channel; groups:write a private one.
        return { public: held.has('channels:manage'), private: held.has('groups:write') };
      } catch (error) {
        logger.warn('New task: bot scopes unavailable — no new channel offered', { error: String(error) });
        return { public: false, private: false };
      }
    },

    async ensureChannel(userId, request) {
      const result = await ensureRepoChannel(userId, request, repoChannelDeps(client));
      // The admin was just invited: the composer offers the channel next time.
      membership.invalidate(userId);
      return result;
    },

    async context(userId, options = {}) {
      let members: Set<string> | null = null;
      try {
        members = await membership.get(userId, { fresh: options.fresh });
      } catch (error) {
        logger.warn('New task: channel membership unavailable — offering no channel', { userId, error: String(error) });
      }
      let pool: Awaited<ReturnType<typeof loadUsage>> | null = null;
      try {
        pool = await usage.get('pool');
      } catch (error) {
        logger.warn('New task: usage unavailable — battery unknown', { error: String(error) });
      }
      const { representativeModels, userDefaultModel, userDefaultModelLabel, userDefaultModelEffortLevels } =
        newTaskModelInputs(userId);
      return buildNewTaskContext({
        representativeModels,
        userDefaultModel,
        userDefaultModelLabel,
        userDefaultModelEffortLevels,
        userDefaultEffort: userSettingsStore.getUserDefaultEffort(userId),
        efforts: EFFORT_LEVELS,
        autogoalDefault: userSettingsStore.getUserAutoGoalEnabled(userId),
        registryChannels: getAllChannels().map((c) => ({ id: c.id, name: c.name, repos: [...c.repos] })),
        memberChannelIds: members,
        recentSessions: deps.listUserSessions(userId),
        lastCommandChannelId: getLastCommandChannelStore().get(userId),
        usageAccounts: pool?.accounts ?? null,
        usageSource: pool?.source ?? null,
        usageFetchedAt: pool?.fetchedAt ?? null,
      });
    },

    start(userId, submission) {
      return launchNewTask(userId, submission, {
        postMessage: async (channel, text, blocks, threadTs) => {
          const res = await client.chat.postMessage({
            channel,
            text,
            blocks: blocks as any,
            unfurl_links: false,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
          return { ts: res.ts };
        },
        getUserName: deps.getUserName,
        getSessionTheme: (owner) => userSettingsStore.getUserSessionTheme(owner),
        uploadFiles: (channel, threadTs, files) => uploadFiles(client, channel, threadTs, files),
        postThreadNotice: (channel, threadTs, text) => client.chat.postMessage({ channel, thread_ts: threadTs, text }),
        getPermalink: async (channel, ts) =>
          (await client.chat.getPermalink({ channel, message_ts: ts })).permalink ?? undefined,
        getSessionKey: deps.getSessionKey,
        hasSession: deps.hasSession,
        handleMessage: deps.handleMessage,
        makeSay: (channel, threadTs) => async (args: any) => {
          const res = await client.chat.postMessage({
            channel,
            text: (typeof args === 'string' ? args : args?.text) || ' ',
            thread_ts: typeof args === 'string' ? threadTs : args?.thread_ts || threadTs,
            blocks: typeof args === 'string' ? undefined : args?.blocks,
            attachments: typeof args === 'string' ? undefined : args?.attachments,
          });
          return { ts: res.ts };
        },
      });
    },
  };
}
