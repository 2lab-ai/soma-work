import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillForceHandler } from '../commands/skill-force-handler';
import { createEnvSkillHandoffHost, envSkillWakeState } from '../env-skill-handoff-host';

vi.mock('node:fs');

vi.mock('../../env-paths', () => ({ PLUGINS_DIR: '/mock/plugins', DATA_DIR: '/mock/data' }));
vi.mock('../../path-utils', () => ({
  isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
}));

const h = vi.hoisted(() => ({
  isAllowed: vi.fn((_o: string, _s: string, _r: string) => false),
  hasOneTime: vi.fn((_o: string, _s: string, _r: string) => false),
  consumeOneTime: vi.fn((_o: string, _s: string, _r: string) => true),
  addOneTime: vi.fn(),
  createReq: vi.fn((i: any) => ({ requestId: 'req-1', ...i })),
  markHandled: vi.fn(),
  retire: vi.fn(),
}));
vi.mock('../../user-skill-grants-store', () => ({
  isSkillUseAllowed: h.isAllowed,
  hasOneTimeGrant: h.hasOneTime,
  consumeOneTimeGrant: h.consumeOneTime,
  addOneTimeGrant: h.addOneTime,
}));
vi.mock('../../skill-permission-request-store', () => ({
  createPermissionRequest: h.createReq,
  markRequestHandled: h.markHandled,
  retirePendingRequests: h.retire,
}));
vi.mock('../../admin-utils', () => ({
  isAdminUser: (u: string) => u === 'UADMIN' || u === 'env:acme-dev2',
  getAdminUsers: () => new Set(['UADMIN']),
}));
vi.mock('../../env-users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../env-users')>()),
  isEnvironmentUser: (u: string) => u === 'env:acme-dev2',
}));

const ENV_SKILL = '/mock/data/env:acme-dev2/skills/qa-dev2/SKILL.md';

/** Settle every pending promise callback. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * #1304 — the host side of RUN_ENV_SKILL: the model's request goes through the REAL `SkillForceHandler`, as the
 * turn's user, in the session's thread — the path a typed `$acme-dev2:qa-dev2 …` takes. The outcome comes back to the
 * model as a host turn.
 */
describe('env-skill hand-off host (#1304)', () => {
  const resolveUser = (t: string): string | null =>
    t === 'acme-dev2' ? 'env:acme-dev2' : t === 'Zhuge' ? 'U094' : null;
  let finishRun: (rootTs: string | undefined) => void;
  const runAsUser = vi.fn(
    (input: { onOpened?: (ts: string) => void }) =>
      new Promise<string | undefined>((resolve) => {
        input.onOpened?.('900.1');
        finishRun = resolve;
      }),
  );
  const slackApi = {
    openDmChannel: vi.fn(async (u: string) => `D-${u}`),
    postMessage: vi.fn(async (_channel: string, _text: string, _opts?: unknown) => ({ ts: '5' })),
    getPermalink: vi.fn(async () => 'https://slack.example/p900'),
  };
  const wake = vi.fn((_w: { sessionKey: string; user: string; text: string }) => true);
  let host: ReturnType<typeof createEnvSkillHandoffHost>;

  const request = (over: Partial<Parameters<typeof host>[0]> = {}) => ({
    toolUseId: `tu-${Math.random()}`,
    skill: '$acme-dev2:qa-dev2',
    text: 'QA 1.4.0..1.4.2',
    user: 'U1',
    channel: 'C1',
    threadTs: '171.1',
    sessionKey: 'C1-171.1',
    ...over,
  });
  /** Everything posted into the requester's thread (the typed path's `say`). */
  const threadPosts = () =>
    slackApi.postMessage.mock.calls.filter(([channel]) => channel === 'C1').map(([, text]) => String(text));

  beforeEach(() => {
    vi.clearAllMocks();
    h.isAllowed.mockReturnValue(false);
    h.hasOneTime.mockReturnValue(false);
    h.createReq.mockImplementation((i: any) => ({ requestId: 'req-1', ...i }));
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      [ENV_SKILL, '/mock/data/U094/skills/deploy/SKILL.md', '/mock/plugins/stv'].includes(String(p)),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      throw new Error(`no read expected: ${String(p)}`);
    });
    const handler = new SkillForceHandler(resolveUser, { slackApi: slackApi as any, runAsUser });
    host = createEnvSkillHandoffHost({ handler, slackApi, wake });
  });

  it('a granted requester: runs as the environment user, ▶/⏹ in the thread, and the session wakes when the run ends', async () => {
    h.isAllowed.mockReturnValue(true);
    const outcome = await host(request());

    expect(outcome).toEqual({ status: 'started', owner: 'env:acme-dev2' });
    // The typed path, as the turn's user: the environment session gets the skill call and the request quoted.
    expect(runAsUser).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'env:acme-dev2', channel: 'C1', rootText: expect.stringContaining('<@U1>') }),
    );
    const sent = (runAsUser.mock.calls[0]?.[0] as unknown as { text: string }).text;
    expect(sent.split('\n')[0]).toBe('$acme-dev2:qa-dev2');
    expect(sent).toContain('＄acme-dev2:qa-dev2 QA 1.4.0..1.4.2');
    await flush();
    expect(threadPosts().some((t) => t.startsWith('▶'))).toBe(true);
    // No wake while the environment user's turn runs.
    expect(wake).not.toHaveBeenCalled();

    finishRun('900.1');
    await flush();
    await flush();
    expect(threadPosts().some((t) => t.startsWith('⏹'))).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
    const w = wake.mock.calls[0][0];
    expect(w).toMatchObject({ sessionKey: 'C1-171.1', user: 'U1' });
    expect(w.text).toContain('[env-skill]');
    expect(w.text).toContain('env:acme-dev2');
    expect(w.text).toContain('https://slack.example/p900');
    expect(w.text).toMatch(/not the user/i);
  });

  it('a requester without a grant gets the admin card and no run — exactly what typing gets', async () => {
    const outcome = await host(request());

    expect(outcome).toEqual({ status: 'awaiting_admin', owner: 'env:acme-dev2' });
    expect(runAsUser).not.toHaveBeenCalled();
    expect(h.createReq).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'invoke',
        requesterId: 'U1',
        ownerId: 'env:acme-dev2',
        skillName: 'qa-dev2',
        channel: 'C1',
        threadTs: '171.1',
        // What runs on approval is the message the model's request stands for.
        originalText: '$acme-dev2:qa-dev2 QA 1.4.0..1.4.2',
      }),
    );
    expect(slackApi.openDmChannel).toHaveBeenCalledWith('UADMIN');
    expect(JSON.stringify(slackApi.postMessage.mock.calls)).toContain('perm_yes_once');
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].text).toMatch(/admin/i);
  });

  it('an admin without a grant also gets the card — the model command is no wider than typing', async () => {
    const outcome = await host(request({ user: 'UADMIN' }));
    expect(outcome.status).toBe('awaiting_admin');
    expect(runAsUser).not.toHaveBeenCalled();
    expect(h.isAllowed).toHaveBeenCalledWith('env:acme-dev2', 'qa-dev2', 'UADMIN', expect.anything());
  });

  it.each([
    ['your own skill', { skill: '$user:deploy', user: 'U094' }],
    ["another person's skill", { skill: '$Zhuge:deploy' }],
    ['a plugin skill', { skill: '$stv:new-task' }],
    ['a missing environment skill', { skill: '$acme-dev2:nope' }],
    ['text naming another skill', { text: 'then run $Zhuge:deploy' }],
    ['a session with no Slack thread', { channel: '', threadTs: '' }],
    ['a turn with no user', { user: '' }],
  ])('rejects %s: nothing posted, asked or run — the reason comes back as a host turn', async (_label, over) => {
    h.isAllowed.mockReturnValue(true);
    const outcome = await host(request(over));

    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toBeTruthy();
    expect(slackApi.postMessage).not.toHaveBeenCalled();
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(runAsUser).not.toHaveBeenCalled();
    expect(h.createReq).not.toHaveBeenCalled();
    if ((over as { channel?: string }).channel === '' || (over as { user?: string }).user === '') {
      // Nowhere to wake (no thread) or nobody to wake as.
      return;
    }
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].text).toContain('[env-skill]');
    expect(wake.mock.calls[0][0].text).toContain(outcome.reason as string);
  });

  it('the same tool result handled twice runs once', async () => {
    h.isAllowed.mockReturnValue(true);
    const req = request({ toolUseId: 'tu-same' });
    const first = await host(req);
    const second = await host(req);
    expect(second).toEqual(first);
    expect(runAsUser).toHaveBeenCalledTimes(1);
  });

  it('a run that fails wakes the session with why it did not run', async () => {
    h.isAllowed.mockReturnValue(true);
    runAsUser.mockImplementationOnce(async () => {
      throw new Error('scheduler off');
    });
    const outcome = await host(request());
    expect(outcome.status).toBe('started');
    await flush();
    await flush();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].text).toContain('scheduler off');
  });

  it('a model that keeps sending rejected requests stops getting host turns for them', async () => {
    for (let i = 0; i < 5; i++) await host(request({ skill: '$acme-dev2:nope' }));
    expect(wake.mock.calls.length).toBeLessThan(5);
    expect(wake.mock.calls.length).toBeGreaterThan(0);
    // An accepted request starts the count again.
    wake.mockClear();
    await host(request());
    await host(request({ skill: '$acme-dev2:nope' }));
    expect(wake.mock.calls[wake.mock.calls.length - 1]?.[0].text).toContain('[env-skill]');
  });

  it('a wake the session cannot take (gone, asleep) is dropped without an error', async () => {
    h.isAllowed.mockReturnValue(true);
    wake.mockReturnValue(false);
    await expect(host(request())).resolves.toMatchObject({ status: 'started' });
    finishRun('900.1');
    await flush();
    await flush();
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

describe('envSkillWakeState (#1304)', () => {
  const awake = { channelId: 'C1', threadTs: '171.1', isActive: true, state: 'MAIN', activityState: 'idle' };

  it('wakes only an awake, settled session', () => {
    expect(envSkillWakeState(undefined, () => true)).toBe('gone');
    expect(envSkillWakeState({ ...awake, terminated: true }, () => true)).toBe('gone');
    expect(envSkillWakeState({ ...awake, isActive: false }, () => true)).toBe('gone');
    expect(envSkillWakeState({ ...awake, state: 'SLEEPING' }, () => true)).toBe('gone');
    expect(envSkillWakeState({ ...awake, channelId: '' }, () => true)).toBe('gone');
    expect(envSkillWakeState({ ...awake, activityState: 'working' }, () => true)).toBe('busy');
    expect(envSkillWakeState(awake, () => false)).toBe('busy');
    expect(envSkillWakeState(awake, () => true)).toBe('ready');
  });
});

describe('entry point wiring (#1304)', () => {
  it('the daemon hands RUN_ENV_SKILL to this host and wakes through a settled delivery, as the requester', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const path = await vi.importActual<typeof import('node:path')>('node:path');
    const index = realFs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    expect(index).toContain('handOffEnvironmentSkill: createEnvSkillHandoffHost(');
    expect(index).toContain('envSkillWakeState(');
    // The host turn is injected as the user it was told for (the requester), synthetic — never the user's answer.
    expect(index).toMatch(/envSkillDelivery = createSettledDelivery\(\{[\s\S]*?user: as \?\? [\s\S]*?synthetic: true/);
  });
});
