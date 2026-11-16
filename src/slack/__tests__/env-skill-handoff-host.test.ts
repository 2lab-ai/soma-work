import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillForceHandler } from '../commands/skill-force-handler';
import {
  captureSessionIdentity,
  createEnvSkillHandoffHost,
  envSkillWakeState,
  MAX_UNPRODUCTIVE_WAKES,
  inertSkillRefs,
} from '../env-skill-handoff-host';

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
  const wake = vi.fn((_w: { sessionKey: string; user: string; text: string; current: () => boolean }) => true);
  /** The requesting session as it was when the request came in: false once it was closed (or closed and reopened). */
  let sessionAlive = true;
  const order: string[] = [];
  const captureSession = vi.fn((_key: string) => {
    order.push('capture');
    return () => sessionAlive;
  });
  let handler: SkillForceHandler;
  let host: ReturnType<typeof createEnvSkillHandoffHost>;

  const request = (over: Partial<Parameters<typeof host>[0]> = {}) => ({
    toolUseId: `tu-${Math.random()}`,
    skill: '$acme-dev2:qa-dev2',
    text: 'QA 1.4.0..1.4.2',
    user: 'UADMIN',
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
      [
        ENV_SKILL,
        '/mock/data/U094/skills/deploy/SKILL.md',
        '/mock/data/UADMIN/skills/deploy/SKILL.md',
        '/mock/plugins/stv',
      ].includes(String(p)),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      throw new Error(`no read expected: ${String(p)}`);
    });
    sessionAlive = true;
    order.length = 0;
    wake.mockImplementation(() => true);
    runAsUser.mockImplementation(
      (input: { onOpened?: (ts: string) => void }) =>
        new Promise<string | undefined>((resolve) => {
          order.push('run');
          input.onOpened?.('900.1');
          finishRun = resolve;
        }),
    );
    handler = new SkillForceHandler(resolveUser, { slackApi: slackApi as any, runAsUser });
    host = createEnvSkillHandoffHost({ handler, slackApi, wake, captureSession });
  });

  it('an admin with a grant: runs as the environment user, ▶/⏹ in the thread, and the session wakes when the run ends', async () => {
    h.isAllowed.mockReturnValue(true);
    const outcome = await host(request());

    expect(outcome).toEqual({ status: 'started', owner: 'env:acme-dev2' });
    // The typed path, as the turn's user: the environment session gets the skill call and the request quoted.
    expect(runAsUser).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'env:acme-dev2',
        channel: 'C1',
        rootText: expect.stringContaining('<@UADMIN>'),
      }),
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
    expect(w).toMatchObject({ sessionKey: 'C1-171.1', user: 'UADMIN' });
    expect(w.text).toContain('[env-skill]');
    expect(w.text).toContain('env:acme-dev2');
    expect(w.text).toContain('https://slack.example/p900');
    expect(w.text).toMatch(/not the user/i);
  });

  it('an admin without a grant gets the admin card and no run — exactly what typing gets, no wider', async () => {
    const outcome = await host(request());

    expect(outcome).toEqual({ status: 'awaiting_admin', owner: 'env:acme-dev2' });
    expect(runAsUser).not.toHaveBeenCalled();
    expect(h.isAllowed).toHaveBeenCalledWith('env:acme-dev2', 'qa-dev2', 'UADMIN', expect.anything());
    expect(h.createReq).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'invoke',
        requesterId: 'UADMIN',
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

  // A non-admin's session is sandboxed; the environment user is an admin with no sandbox. Only a person's typed
  // request may cross that line — a model in a non-admin session (a prompt injection, say) must not, grant or not.
  it.each([
    ['with a lasting grant', true],
    ['without a grant', false],
  ])('a non-admin requester %s is refused: nothing posted, carded or run — the model is told to ask the user to type it', async (_label, granted) => {
    h.isAllowed.mockReturnValue(granted);
    const outcome = await host(request({ user: 'U1' }));

    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toMatch(/only for an admin/i);
    expect(outcome.reason).toContain('$acme-dev2:qa-dev2');
    expect(slackApi.postMessage).not.toHaveBeenCalled();
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(h.createReq).not.toHaveBeenCalled();
    expect(runAsUser).not.toHaveBeenCalled();
    expect(h.consumeOneTime).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toMatchObject({ user: 'U1' });
    expect(wake.mock.calls[0][0].text).toContain(inertSkillRefs(outcome.reason as string));
  });

  it.each([
    ['your own skill', { skill: '$user:deploy' }],
    ["another person's skill", { skill: '$Zhuge:deploy' }],
    ['a plugin skill', { skill: '$stv:new-task' }],
    ['a missing environment skill', { skill: '$acme-dev2:nope' }],
    ['text naming another skill', { text: 'then run $Zhuge:deploy' }],
    ['a session with no Slack thread', { channel: '', threadTs: '' }],
    ['a turn with no user', { user: '' }],
  ])("rejects an admin's request for %s: nothing posted, asked or run — the reason comes back as a host turn", async (_label, over) => {
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
    expect(wake.mock.calls[0][0].text).toContain(inertSkillRefs(outcome.reason as string));
  });

  it('the same tool result handled twice runs once', async () => {
    h.isAllowed.mockReturnValue(true);
    const req = request({ toolUseId: 'tu-same' });
    const first = await host(req);
    const second = await host(req);
    expect(second).toEqual(first);
    expect(runAsUser).toHaveBeenCalledTimes(1);
  });

  it('a run still going is never forgotten: a late duplicate of its tool result does not start a second run', async () => {
    h.isAllowed.mockReturnValue(true);
    const long = request({ toolUseId: 'tu-long' });
    await host(long);
    // Many other tool results later (more than the cache keeps) — all settled at once.
    for (let i = 0; i < 260; i++) await host(request({ skill: '$acme-dev2:nope' }));
    await host(long);
    expect(runAsUser).toHaveBeenCalledTimes(1);
  });

  it('the session is captured when the request comes in, before anything runs', async () => {
    h.isAllowed.mockReturnValue(true);
    await host(request());
    expect(captureSession).toHaveBeenCalledWith('C1-171.1');
    expect(order).toEqual(['capture', 'run']);
  });

  it('a session closed (and reopened) while the run went on is not woken with the old result', async () => {
    h.isAllowed.mockReturnValue(true);
    await host(request());
    sessionAlive = false;
    finishRun('900.1');
    await flush();
    await flush();
    expect(threadPosts().some((t) => t.startsWith('⏹'))).toBe(true);
    expect(wake).not.toHaveBeenCalled();
  });

  it('every wake carries the captured session, so a delivery that waits drops it once the session is replaced', async () => {
    await host(request());
    expect(wake).toHaveBeenCalledTimes(1);
    const { current } = wake.mock.calls[0][0];
    expect(current()).toBe(true);
    sessionAlive = false;
    expect(current()).toBe(false);
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

  // RoL #1308 r2 (maintainability P1): a run that never got going is no progress. Counted as progress, a launch that
  // keeps failing woke the session every time and the model could send the same request forever.
  it('runs that fail to launch count against the no-progress budget and do not reset it', async () => {
    h.isAllowed.mockReturnValue(true);
    runAsUser.mockImplementation(async () => {
      throw new Error('scheduler off');
    });
    for (let i = 0; i < MAX_UNPRODUCTIVE_WAKES + 2; i++) {
      await host(request());
      await flush();
      await flush();
    }
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);
    for (const [w] of wake.mock.calls) expect(w.text).toContain('scheduler off');
    // A rejection after them is still over the budget: the failed launches did not reset it.
    await host(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);
  });

  it('a host error anywhere becomes a rejection the model is told about — a submitted request never goes silent', async () => {
    vi.spyOn(handler, 'checkEnvironmentHandoff').mockImplementation(() => {
      throw new Error('resolver broke');
    });
    const outcome = await host(request());
    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toContain('resolver broke');
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].text).toContain('resolver broke');
  });

  it('rejected requests in a row wake the session only up to the cap; a started run resets it', async () => {
    for (let i = 0; i < MAX_UNPRODUCTIVE_WAKES + 2; i++) await host(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);

    // A run that starts (and ends) is progress: the count starts again.
    wake.mockClear();
    h.isAllowed.mockReturnValue(true);
    await host(request());
    finishRun('900.1');
    await flush();
    await flush();
    await host(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[0][0].text).toContain('https://slack.example/p900');
    expect(wake.mock.calls[1][0].text).toMatch(/`acme-dev2:nope` was rejected/);
  });

  it('waiting for an admin is not progress: it does not reset the count, and the same pending request wakes once', async () => {
    // The same ungranted request three times: one wake.
    for (let i = 0; i < 3; i++) await host(request());
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].text).toMatch(/admin/i);
    // Rejections after it still count against the same budget — the wait did not reset it.
    for (let i = 0; i < MAX_UNPRODUCTIVE_WAKES + 2; i++) await host(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);
    // Nor does a new pending request get past the budget.
    await host(request({ text: 'another range' }));
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);
  });

  // RoL #1308 r3 (reliability P1): the wake budget and the told-pending set belong to the session that asked, not to
  // its key. A thread closed and opened again is a new session: what the old one used up must not silence it.
  it('a session opened again at the same key starts with its own budget and pending set', async () => {
    let generation = 0;
    const captures: Array<{ alive: boolean }> = [];
    const generations = createEnvSkillHandoffHost({
      handler,
      slackApi,
      wake,
      captureSession: () => {
        const g = captures[generation] ?? { alive: true };
        captures[generation] = g;
        return () => g.alive;
      },
    });
    // Session A: the same ungranted request (told once), then rejections up to the budget.
    await generations(request());
    for (let i = 0; i < MAX_UNPRODUCTIVE_WAKES + 1; i++) await generations(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);

    // A is closed; B opens at the same key and sends the same pending request, then a bad one.
    captures[generation].alive = false;
    generation++;
    wake.mockClear();
    await generations(request());
    await generations(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[0][0].text).toMatch(/admin/i);
    expect(wake.mock.calls[1][0].text).toMatch(/`acme-dev2:nope` was rejected/);
  });

  // RoL #1308 r4 (tests P1): a run the closed session A started may end after B took the key — A's success must not
  // reset B's budget or its told-pending set.
  it("a run the old session started never resets the new session's budget when it ends", async () => {
    let generation = 0;
    const captures: Array<{ alive: boolean }> = [];
    const generations = createEnvSkillHandoffHost({
      handler,
      slackApi,
      wake,
      captureSession: () => {
        const g = captures[generation] ?? { alive: true };
        captures[generation] = g;
        return () => g.alive;
      },
    });
    // A starts a run that has not ended yet.
    h.isAllowed.mockReturnValue(true);
    await generations(request());
    const finishA = finishRun;
    // A closes; B takes the key and uses up its budget.
    captures[generation].alive = false;
    generation++;
    for (let i = 0; i < MAX_UNPRODUCTIVE_WAKES; i++) await generations(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);
    // A's run ends well: A is not woken, and B's budget stays spent.
    finishA('900.1');
    await flush();
    await flush();
    await generations(request({ skill: '$acme-dev2:nope' }));
    expect(wake).toHaveBeenCalledTimes(MAX_UNPRODUCTIVE_WAKES);
  });

  // RoL #1308 r5 (red-team P1): A's approval wait that returns after B took the key must not mark the request as told
  // in B's record — B sending the same request is still told it waits for an admin.
  it("an old session's late approval wait does not touch the new session's told-pending set", async () => {
    let generation = 0;
    const captures: Array<{ alive: boolean }> = [];
    const generations = createEnvSkillHandoffHost({
      handler,
      slackApi,
      wake,
      captureSession: () => {
        const g = captures[generation] ?? { alive: true };
        captures[generation] = g;
        return () => g.alive;
      },
    });
    // A's request is held while its card goes out; meanwhile A closes and B takes the key.
    let release: () => void = () => {};
    const execute = handler.execute.bind(handler);
    const slow = vi.spyOn(handler, 'execute').mockImplementationOnce(async (ctx) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return execute(ctx);
    });
    const late = generations(request());
    await flush();
    captures[generation].alive = false;
    generation++;
    // B opens with a request of its own first (so B holds the key's record), then A's wait lands.
    await generations(request({ skill: '$acme-dev2:nope' }));
    release();
    expect((await late).status).toBe('awaiting_admin');
    slow.mockRestore();
    wake.mockClear();
    // B sends the very request A was waiting on: B is told.
    expect((await generations(request())).status).toBe('awaiting_admin');
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].text).toMatch(/admin/i);
  });

  // RoL #1308 r4 (red-team P1): a request waiting for an admin keeps its dedupe entry while its card can still be
  // approved — however many other hand-offs come in meanwhile — so a late duplicate of the same tool result never
  // starts a second run once the approval lands.
  it('a request waiting for an admin keeps its dedupe entry past the result cap', async () => {
    const pending = request({ toolUseId: 'tu-pending' });
    expect((await host(pending)).status).toBe('awaiting_admin');
    for (let i = 0; i < 205; i++) await host(request({ skill: '$acme-dev2:nope', toolUseId: `tu-other-${i}` }));
    // The admin approved meanwhile: the same tool result arriving again must not run.
    h.isAllowed.mockReturnValue(true);
    runAsUser.mockClear();
    expect((await host(pending)).status).toBe('awaiting_admin');
    expect(runAsUser).not.toHaveBeenCalled();
  });

  // Belt to the verbatim injection: no wake text names the skill as a callable reference (`$env:skill` or a bare
  // `env:skill`), so even a path that routed it could not start the skill again.
  it('no wake text carries a callable skill reference', async () => {
    h.isAllowed.mockReturnValue(true);
    await host(request());
    finishRun('900.1');
    await flush();
    await flush();
    h.isAllowed.mockReturnValue(false);
    await host(request({ text: 'another range' }));
    await host(request({ skill: '$acme-dev2:nope' }));
    expect(wake.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [w] of wake.mock.calls) {
      expect(w.text).not.toMatch(/\$[\w.-]+:[a-z0-9]/);
      expect(w.text).not.toMatch(/(?:^|\s)[\w.-]+:[a-z0-9][a-z0-9-]*(?=\s|$|[.,!?)])/);
    }
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

describe('captureSessionIdentity (#1304)', () => {
  it('is true only while the same, unclosed session object holds the key', () => {
    const a = { terminated: false };
    const registry = new Map<string, { terminated?: boolean }>([['k', a]]);
    const same = captureSessionIdentity((key) => registry.get(key), 'k');
    expect(same()).toBe(true);
    // Closed and reopened at the same key: a different session.
    registry.set('k', { terminated: false });
    expect(same()).toBe(false);
    registry.set('k', a);
    a.terminated = true;
    expect(same()).toBe(false);
    registry.delete('k');
    expect(same()).toBe(false);
    expect(captureSessionIdentity((key) => registry.get(key), 'missing')()).toBe(false);
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
    // The session is captured at request time (in the host) and the delivery is bound to it.
    expect(index).toMatch(/captureSession: \(sessionKey\) =>\s*captureSessionIdentity\(/);
    expect(index).toMatch(/envSkillDelivery\.deliver\(sessionKey, text, undefined, current, user\)/);
  });

  // Live on the customer dev host (2026-11-16 06:46Z): the wake reached the requesting session, the command router
  // read the `$<env>:<skill>` in it as a skill call and ran the environment skill a second time — the model never got
  // the result. A host turn's own text is never a command: the wake goes in verbatim (no command routing).
  it('the wake is injected verbatim, so the command router never reads it as a skill call', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const path = await vi.importActual<typeof import('node:path')>('node:path');
    const index = realFs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    const block = index.slice(index.indexOf('const envSkillDelivery = createSettledDelivery('));
    const inject = block.slice(0, block.indexOf('logger,'));
    expect(inject).toMatch(/routeContext: \{[^}]*verbatimPrompt: true[^}]*hostTurn: true[^}]*\}/);
  });
});
