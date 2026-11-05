/**
 * Dashboard "New task" — a new Slack channel for a repo (2026-11-05).
 *
 *   - the pure half: what an admin may type for the repo and the channel's
 *     name (`workspace-<repo>` by default), and how a submission carries it;
 *   - the Slack half (`ensureRepoChannel`): GitHub check → a channel the repo
 *     already has → create → purpose (the repo URL) → invite → registry, with
 *     a half-made channel archived and Slack's refusals kept as statuses.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  defaultRepoChannelName,
  isValidChannelName,
  type NewTaskContext,
  NewTaskError,
  normalizeRepo,
  parseNewRepoChannel,
  parseNewTaskSubmission,
  toChannelName,
} from '../new-task';
import { ensureRepoChannel, type RepoChannelDeps, slackErrorCode } from '../new-task-channel';

/** A Slack Web API failure as @slack/web-api throws it. */
function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code },
  });
}

function deps(overrides: Partial<RepoChannelDeps> = {}): RepoChannelDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    checkRepo: vi.fn(async () => 'ok' as const),
    mappedChannels: vi.fn(() => []),
    create: vi.fn(async (name: string) => ({ id: 'C_NEW', name })),
    setPurpose: vi.fn(async () => undefined),
    invite: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    register: vi.fn(),
    ...overrides,
  } as RepoChannelDeps & Record<string, ReturnType<typeof vi.fn>>;
}

const REQUEST = { repo: '2lab-ai/new-repo', name: 'workspace-new-repo', isPrivate: false };

describe('repo and channel name rules', () => {
  it('normalizeRepo takes owner/name, any github.com address and the ssh form, lowercased', () => {
    expect(normalizeRepo('2lab-ai/Soma-Work')).toBe('2lab-ai/soma-work');
    expect(normalizeRepo(' https://github.com/2lab-ai/soma-work ')).toBe('2lab-ai/soma-work');
    expect(normalizeRepo('https://github.com/2lab-ai/soma-work/tree/main/src')).toBe('2lab-ai/soma-work');
    expect(normalizeRepo('github.com/2lab-ai/soma-work.git')).toBe('2lab-ai/soma-work');
    expect(normalizeRepo('git@github.com:2lab-ai/soma-work.git')).toBe('2lab-ai/soma-work');
    expect(normalizeRepo('https://github.com/2lab-ai/soma-work?tab=readme')).toBe('2lab-ai/soma-work');
  });

  it('normalizeRepo refuses what is no repo', () => {
    for (const bad of ['', 'soma-work', 'a/b/c', 'https://gitlab.com/a/b', 'a b/c', '2lab-ai/..', 42, null]) {
      expect(normalizeRepo(bad)).toBeNull();
    }
  });

  it('the default name is workspace-<repo name> in Slack’s alphabet', () => {
    expect(defaultRepoChannelName('2lab-ai/soma-work')).toBe('workspace-soma-work');
    expect(defaultRepoChannelName('acme/My.Repo_v2')).toBe('workspace-my-repo_v2');
    expect(defaultRepoChannelName(`acme/${'x'.repeat(120)}`)).toHaveLength(80);
    expect(toChannelName('--Hello  World!--')).toBe('hello-world');
  });

  it('isValidChannelName is Slack’s rule: a-z 0-9 - _, 1..80, not only punctuation', () => {
    expect(isValidChannelName('workspace-soma-work')).toBe(true);
    expect(isValidChannelName('Workspace')).toBe(false);
    expect(isValidChannelName('---')).toBe(false);
    expect(isValidChannelName('')).toBe(false);
    expect(isValidChannelName('a'.repeat(81))).toBe(false);
    expect(isValidChannelName('한글')).toBe(false);
  });

  it('parseNewRepoChannel: an empty name is the default one; private is opt-in', () => {
    expect(parseNewRepoChannel({ repo: 'https://github.com/2lab-ai/soma' })).toEqual({
      ok: true,
      value: { repo: '2lab-ai/soma', name: 'workspace-soma', isPrivate: false },
    });
    expect(parseNewRepoChannel({ repo: '2lab-ai/soma', name: ' ', private: true })).toEqual({
      ok: true,
      value: { repo: '2lab-ai/soma', name: 'workspace-soma', isPrivate: true },
    });
    expect(parseNewRepoChannel({ repo: '2lab-ai/soma', name: 'My Channel' }).ok).toBe(false);
    expect(parseNewRepoChannel({ repo: 'not a repo' }).ok).toBe(false);
    expect(parseNewRepoChannel({ repo: '2lab-ai/soma', private: 'yes' }).ok).toBe(false);
    expect(parseNewRepoChannel('2lab-ai/soma').ok).toBe(false);
  });
});

describe('parseNewTaskSubmission with a new repo channel', () => {
  const ctx = (extra: Partial<NewTaskContext> = {}): NewTaskContext => ({
    models: [
      {
        nickname: 'opus',
        model: 'claude-opus',
        label: 'Opus',
        battery: { level: null, best: null, windows: [], accounts: { measured: 0, total: 0, available: 0 } },
      },
    ],
    defaultModel: 'opus',
    efforts: ['high'],
    defaultEffort: 'high',
    channels: [{ id: 'C_A', name: 'workspace-a', repos: ['acme/a'] }],
    defaultChannelId: 'C_A',
    membershipUnknown: false,
    autogoalDefault: false,
    usage: { scope: 'shared-pool', source: null, fetchedAt: null },
    limits: { maxPromptChars: 12000, maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 1 },
    ...extra,
  });
  const body = (extra: Record<string, unknown>) => ({
    requestId: 'req-0123456789',
    prompt: 'go',
    model: 'opus',
    effort: 'high',
    autogoal: false,
    autoz: false,
    ...extra,
  });

  it('offered (channelCreate): the submission carries the request and no channel id yet', () => {
    const parsed = parseNewTaskSubmission(body({ newChannel: { repo: 'acme/b' } }), ctx({ channelCreate: true }));
    expect(parsed).toMatchObject({
      ok: true,
      value: { channelId: '', newChannel: { repo: 'acme/b', name: 'workspace-b', isPrivate: false } },
    });
  });

  it('not offered → refused; a channel id beside it → refused; private without the scope → refused', () => {
    expect(parseNewTaskSubmission(body({ newChannel: { repo: 'acme/b' } }), ctx()).ok).toBe(false);
    expect(
      parseNewTaskSubmission(body({ channelId: 'C_A', newChannel: { repo: 'acme/b' } }), ctx({ channelCreate: true }))
        .ok,
    ).toBe(false);
    expect(
      parseNewTaskSubmission(body({ newChannel: { repo: 'acme/b', private: true } }), ctx({ channelCreate: true })).ok,
    ).toBe(false);
    expect(
      parseNewTaskSubmission(
        body({ newChannel: { repo: 'acme/b', private: true } }),
        ctx({ channelCreate: true, channelCreatePrivate: true }),
      ).ok,
    ).toBe(true);
  });

  it('an offered channel still works as before', () => {
    expect(parseNewTaskSubmission(body({ channelId: 'C_A' }), ctx({ channelCreate: true }))).toMatchObject({
      ok: true,
      value: { channelId: 'C_A' },
    });
  });
});

describe('ensureRepoChannel', () => {
  it('makes the channel, writes the repo URL as its purpose, invites the admin, registers it — in that order', async () => {
    const order: string[] = [];
    const d = deps({
      create: vi.fn(async (name: string, isPrivate: boolean) => {
        order.push(`create:${name}:${isPrivate}`);
        return { id: 'C_NEW', name };
      }),
      setPurpose: vi.fn(async (id: string, purpose: string) => {
        order.push(`purpose:${id}:${purpose}`);
      }),
      invite: vi.fn(async (id: string, user: string) => {
        order.push(`invite:${id}:${user}`);
      }),
      register: vi.fn((info) => {
        order.push(`register:${info.id}:${info.purpose}`);
      }),
    });
    const result = await ensureRepoChannel('U_ADMIN', REQUEST, d);
    expect(result).toEqual({ channelId: 'C_NEW', channelName: 'workspace-new-repo', created: true });
    expect(order).toEqual([
      'create:workspace-new-repo:false',
      'purpose:C_NEW:https://github.com/2lab-ai/new-repo',
      'invite:C_NEW:U_ADMIN',
      'register:C_NEW:https://github.com/2lab-ai/new-repo',
    ]);
    expect(d.register).toHaveBeenCalledWith({
      id: 'C_NEW',
      name: 'workspace-new-repo',
      purpose: 'https://github.com/2lab-ai/new-repo',
      isPrivate: false,
    });
    expect(d.archive).not.toHaveBeenCalled();
  });

  it('a repo that already has a channel: no second channel — the admin is invited there', async () => {
    const d = deps({
      mappedChannels: vi.fn(() => [{ id: 'C_OLD', name: 'workspace-new-repo' }]),
      invite: vi.fn(async () => {
        throw slackError('already_in_channel');
      }),
    });
    const result = await ensureRepoChannel('U_ADMIN', REQUEST, d);
    expect(result).toEqual({ channelId: 'C_OLD', channelName: 'workspace-new-repo', created: false });
    expect(d.create).not.toHaveBeenCalled();
  });

  it('GitHub says the bot cannot see the repo → 404, nothing made; GitHub unknown does not block', async () => {
    const missing = deps({ checkRepo: vi.fn(async () => 'missing' as const) });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, missing)).rejects.toMatchObject({ statusCode: 404 });
    expect(missing.create).not.toHaveBeenCalled();

    const unknown = deps({ checkRepo: vi.fn(async () => 'unknown' as const) });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, unknown)).resolves.toMatchObject({ created: true });
    const thrown = deps({
      checkRepo: vi.fn(async () => {
        throw new Error('network');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, thrown)).resolves.toMatchObject({ created: true });
  });

  it.each([
    ['name_taken', 409],
    ['invalid_name_specials', 400],
    ['restricted_action', 403],
    ['missing_scope', 503],
    ['fatal_error', 502],
  ])("Slack's %s on create → %i, nothing to archive", async (code, status) => {
    const d = deps({
      create: vi.fn(async () => {
        throw slackError(code);
      }),
    });
    const error = await ensureRepoChannel('U_ADMIN', REQUEST, d).catch((e) => e);
    expect(error).toBeInstanceOf(NewTaskError);
    expect(error.statusCode).toBe(status);
    expect(d.archive).not.toHaveBeenCalled();
    expect(d.register).not.toHaveBeenCalled();
  });

  it('a channel made but not described is archived and the launch fails', async () => {
    const d = deps({
      setPurpose: vi.fn(async () => {
        throw slackError('too_long');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, d)).rejects.toMatchObject({ statusCode: 502 });
    expect(d.archive).toHaveBeenCalledWith('C_NEW');
    expect(d.invite).not.toHaveBeenCalled();
    expect(d.register).not.toHaveBeenCalled();
  });

  it('a channel the admin could not be invited to is archived; already in it is fine', async () => {
    const failed = deps({
      invite: vi.fn(async () => {
        throw slackError('user_not_found');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, failed)).rejects.toMatchObject({ statusCode: 502 });
    expect(failed.archive).toHaveBeenCalledWith('C_NEW');
    expect(failed.register).not.toHaveBeenCalled();

    const already = deps({
      invite: vi.fn(async () => {
        throw slackError('already_in_channel');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, already)).resolves.toMatchObject({ created: true });
    expect(already.archive).not.toHaveBeenCalled();
  });

  it('an archive that fails too still fails the launch (the channel stays, unmapped, and is logged)', async () => {
    const d = deps({
      setPurpose: vi.fn(async () => {
        throw slackError('fatal_error');
      }),
      archive: vi.fn(async () => {
        throw slackError('not_in_channel');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, d)).rejects.toMatchObject({ statusCode: 502 });
  });

  // Review (astra-zhuge, PR #959) P1 — a private request never lands in a channel not known to be private.
  it('a private request for a repo whose channel is public (or not known private) → 409, nothing touched', async () => {
    for (const mapped of [
      { id: 'C_PUB', name: 'workspace-new-repo', isPrivate: false },
      { id: 'C_UNK', name: 'workspace-new-repo' },
    ]) {
      const d = deps({ mappedChannels: vi.fn(() => [mapped]) });
      await expect(ensureRepoChannel('U_ADMIN', { ...REQUEST, isPrivate: true }, d)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(d.invite).not.toHaveBeenCalled();
      expect(d.create).not.toHaveBeenCalled();
    }
    // Round 2: a public mapping listed first does not hide a private one.
    const both = deps({
      mappedChannels: vi.fn(() => [
        { id: 'C_PUB', name: 'team', isPrivate: false },
        { id: 'C_PRIV2', name: 'project', isPrivate: true },
      ]),
    });
    await expect(ensureRepoChannel('U_ADMIN', { ...REQUEST, isPrivate: true }, both)).resolves.toMatchObject({
      channelId: 'C_PRIV2',
      created: false,
    });
    expect(both.invite).toHaveBeenCalledTimes(1);
    expect(both.invite).toHaveBeenCalledWith('C_PRIV2', 'U_ADMIN');
    const priv = deps({ mappedChannels: vi.fn(() => [{ id: 'C_PRIV', name: 'workspace-new-repo', isPrivate: true }]) });
    await expect(ensureRepoChannel('U_ADMIN', { ...REQUEST, isPrivate: true }, priv)).resolves.toEqual({
      channelId: 'C_PRIV',
      channelName: 'workspace-new-repo',
      created: false,
    });
  });

  it('a mapped channel that turns out archived is passed over: the next one, else a new channel', async () => {
    const archived = vi.fn(async (id: string) => {
      if (id === 'C_ARCH') throw slackError('is_archived');
    });
    const next = deps({
      mappedChannels: vi.fn(() => [
        { id: 'C_ARCH', name: 'old' },
        { id: 'C_LIVE', name: 'live' },
      ]),
      invite: archived,
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, next)).resolves.toMatchObject({
      channelId: 'C_LIVE',
      created: false,
    });
    const none = deps({ mappedChannels: vi.fn(() => [{ id: 'C_ARCH', name: 'old' }]), invite: archived });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, none)).resolves.toMatchObject({
      channelId: 'C_NEW',
      created: true,
    });
  });

  it('a missing scope or a restriction keeps its status at every step, not only create', async () => {
    const purpose = deps({
      setPurpose: vi.fn(async () => {
        throw slackError('missing_scope');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, purpose)).rejects.toMatchObject({ statusCode: 503 });
    expect(purpose.archive).toHaveBeenCalledWith('C_NEW');
    const invite = deps({
      invite: vi.fn(async () => {
        throw slackError('restricted_action');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, invite)).rejects.toMatchObject({ statusCode: 403 });
    const mapped = deps({
      mappedChannels: vi.fn(() => [{ id: 'C_OLD', name: 'old' }]),
      invite: vi.fn(async () => {
        throw slackError('missing_scope');
      }),
    });
    await expect(ensureRepoChannel('U_ADMIN', REQUEST, mapped)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('when the archive fails too, the answer says the channel is still there — never that it was archived', async () => {
    const d = deps({
      setPurpose: vi.fn(async () => {
        throw slackError('fatal_error');
      }),
      archive: vi.fn(async () => {
        throw slackError('not_in_channel');
      }),
    });
    const error = await ensureRepoChannel('U_ADMIN', REQUEST, d).catch((e) => e);
    expect(error.statusCode).toBe(502);
    expect(error.message).toMatch(/남아 있으니 직접 보관/);
    expect(error.message).not.toMatch(/보관했습니다/);
  });

  it('two admins at once on one repo: one channel — the second finds the first', async () => {
    const registered: Array<{ id: string; name: string; isPrivate?: boolean }> = [];
    let n = 0;
    const shared = (): RepoChannelDeps & Record<string, ReturnType<typeof vi.fn>> =>
      deps({
        mappedChannels: vi.fn(() => [...registered]),
        create: vi.fn(async (name: string) => {
          await new Promise((r) => setTimeout(r, 5));
          n += 1;
          return { id: `C_${n}`, name };
        }),
        register: vi.fn((info) => {
          registered.push({ id: info.id, name: info.name, isPrivate: info.isPrivate });
        }),
      });
    const a = shared();
    const b = shared();
    const [ra, rb] = await Promise.all([
      ensureRepoChannel('U_A', REQUEST, a),
      ensureRepoChannel('U_B', { ...REQUEST, name: 'other-name' }, b),
    ]);
    expect(n).toBe(1);
    expect(ra).toMatchObject({ channelId: 'C_1', created: true });
    expect(rb).toMatchObject({ channelId: 'C_1', created: false });
  });

  it('the name is marked as being made for exactly the making — released on success and on failure', async () => {
    const released: string[] = [];
    const marking = () =>
      vi.fn((name: string) => {
        return () => released.push(name);
      });
    const ok = deps({ beginMaking: marking() });
    await ensureRepoChannel('U_ADMIN', REQUEST, ok);
    expect(ok.beginMaking).toHaveBeenCalledWith('workspace-new-repo');
    const failed = deps({
      beginMaking: marking(),
      create: vi.fn(async () => {
        throw slackError('name_taken');
      }),
    });
    await ensureRepoChannel('U_ADMIN', REQUEST, failed).catch(() => undefined);
    expect(released).toEqual(['workspace-new-repo', 'workspace-new-repo']);
    const reused = deps({ beginMaking: marking(), mappedChannels: vi.fn(() => [{ id: 'C_OLD', name: 'old' }]) });
    await ensureRepoChannel('U_ADMIN', REQUEST, reused);
    expect(reused.beginMaking).not.toHaveBeenCalled();
  });

  it('an archived half-made channel keeps its name: the answer asks for another name, not a plain retry', async () => {
    const d = deps({
      setPurpose: vi.fn(async () => {
        throw slackError('fatal_error');
      }),
    });
    const error = await ensureRepoChannel('U_ADMIN', REQUEST, d).catch((e) => e);
    expect(error.message).toMatch(/다른 이름으로 다시 시도/);
  });

  it('slackErrorCode reads the Web API error code, nothing else', () => {
    expect(slackErrorCode(slackError('name_taken'))).toBe('name_taken');
    expect(slackErrorCode(new Error('boom'))).toBe('');
    expect(slackErrorCode(null)).toBe('');
  });
});
