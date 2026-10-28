/**
 * End-to-end flow of the environment-skill admin approval, with every real piece wired together:
 * SkillForceHandler (the `$plugin:skill` gate), requestEnvSkillPermission (the admin DM), the real
 * request and grant stores on disk, EnvSkillPermissionActionHandler (the admin's button), the
 * re-dispatch back through the gate, and evaluateToolPolicy step 6b with the real
 * checkEnvSkillAccess (the model's `Skill` / `Read` path). Only Slack is a fake: it records what
 * would have been posted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminUsersCache } from '../admin-utils';
import { evaluateToolPolicy, type ToolPolicyContext } from '../agent-runtime/policy/tool-policy';
import { DATA_DIR, PLUGINS_DIR } from '../env-paths';
import { checkEnvSkillAccess, envSkillRegistry } from '../env-skill-registry';
import { EnvSkillPermissionActionHandler } from '../slack/actions/env-skill-permission-action-handler';
import { SkillForceHandler } from '../slack/commands/skill-force-handler';

const ADMIN = 'UADMINFLOW1';
const REQUESTER = 'UREQFLOW01';
const THREAD = { channel: 'CFLOW00001', threadTs: '1793000000.000100' };
const OTHER_THREAD = { channel: 'CFLOW00001', threadTs: '1793000000.000999' };
const SKILL_BODY = '# acme post-deploy\nRun the environment QA profile.';

interface Posted {
  channel: string;
  text: string;
  opts?: { threadTs?: string; blocks?: any[] };
}

describe('environment-skill admin approval — full flow', () => {
  const posted: Posted[] = [];
  const updated: Array<{ channel: string; ts: string; text: string }> = [];
  const slackApi = {
    openDmChannel: vi.fn(async (user: string) => `D-${user}`),
    postMessage: vi.fn(async (channel: string, text: string, opts?: Posted['opts']) => {
      posted.push({ channel, text, opts });
      return { ts: `${posted.length}.0001`, channel };
    }),
    updateMessage: vi.fn(async (channel: string, ts: string, text: string) => {
      updated.push({ channel, ts, text });
    }),
  };
  const mcpManager = { getPluginManager: () => ({ getEnvPluginNames: () => new Set(['acme-env']) }) };
  const forceHandler = new SkillForceHandler(() => null, { slackApi: slackApi as any, mcpManager: mcpManager as any });
  const redispatched: Array<{ user: string; text: string; result: any }> = [];
  const messageHandler = vi.fn(async (event: any) => {
    // What the real message pipeline does first: route the re-sent text through the command router,
    // whose skill handler is the same gate.
    const result = await forceHandler.execute({
      user: event.user,
      channel: event.channel,
      threadTs: event.thread_ts,
      text: event.text,
      say: async () => ({}),
    } as any);
    redispatched.push({ user: event.user, text: event.text, result });
  });
  const actionHandler = new EnvSkillPermissionActionHandler({
    slackApi: slackApi as any,
    messageHandler,
    mcpManager: mcpManager as any,
  });

  const say = vi.fn(async () => ({}));
  const ask = (text: string, user = REQUESTER, where = THREAD) =>
    forceHandler.execute({ user, channel: where.channel, threadTs: where.threadTs, text, say } as any);

  /** The admin DM of the latest request, and the button value of `kind` in it. */
  function adminButton(kind: string): string {
    const dm = [...posted].reverse().find((p) => p.channel === `D-${ADMIN}` && Array.isArray(p.opts?.blocks));
    expect(dm, 'an admin DM with buttons').toBeTruthy();
    const actions = dm?.opts?.blocks?.find((b: any) => b.type === 'actions');
    const button = actions.elements.find((e: any) => e.action_id === `env_skill_perm_${kind}`);
    expect(button, `button ${kind}`).toBeTruthy();
    return button.value;
  }
  const click = (value: string, user = ADMIN) =>
    actionHandler.handleAction(
      { user: { id: user }, actions: [{ value }] },
      vi.fn(async () => ({})),
    );

  /** Step 6b as the stream hook evaluates it for the requester in `where`. */
  function policy(tool: string, input: Record<string, unknown>, where = THREAD) {
    const registry = envSkillRegistry(mcpManager.getPluginManager());
    const ctx: ToolPolicyContext = {
      user: REQUESTER,
      isAdmin: false,
      mode: 'bypass',
      aborted: false,
      isDangerousRuleDisabled: () => false,
      checkMcpToolPermission: () => null,
      checkEnvSkillPermission: (t, i) => checkEnvSkillAccess(t, i, REQUESTER, where, registry),
    };
    return evaluateToolPolicy(tool, input, ctx);
  }

  const skillFile = path.join(PLUGINS_DIR, 'acme-env', 'skills', 'post-deploy', 'SKILL.md');
  const savedAdmins = process.env.ADMIN_USERS;

  beforeAll(() => {
    process.env.ADMIN_USERS = ADMIN;
    resetAdminUsersCache();
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, SKILL_BODY);
    fs.rmSync(path.join(DATA_DIR, 'env-skill-grants.json'), { force: true });
    fs.rmSync(path.join(DATA_DIR, 'skill-perm-requests.json'), { force: true });
  });
  afterAll(() => {
    process.env.ADMIN_USERS = savedAdmins;
    resetAdminUsersCache();
  });
  beforeEach(() => {
    posted.length = 0;
    updated.length = 0;
    redispatched.length = 0;
    vi.clearAllMocks();
  });

  it('1회 허용: request → admin DM → click → turn re-sent and runs → same thread only', async () => {
    const text = '$acme-env:post-deploy --preflight repo=acme/app target=deploy/staging';

    // The non-admin is stopped; nothing of the skill leaks.
    const first = await ask(text);
    expect(first).toEqual({ handled: true, awaitingPermission: true });
    expect(JSON.stringify(posted)).not.toContain('Run the environment QA profile');
    // The model path is denied too, in every spelling.
    expect(policy('Skill', { skill: 'acme-env:post-deploy' }).decision).toBe('deny');
    expect(policy('Read', { file_path: skillFile }).decision).toBe('deny');

    // The admin got a DM; the requester got a notice in the thread.
    expect(slackApi.openDmChannel).toHaveBeenCalledWith(ADMIN);
    expect(posted.some((p) => p.channel === THREAD.channel && p.opts?.threadTs === THREAD.threadTs)).toBe(true);

    // A retry before the answer does not DM the admin again.
    await ask(text);
    expect(slackApi.openDmChannel).toHaveBeenCalledTimes(1);

    // A non-admin cannot answer the prompt.
    await click(adminButton('env_skill_once'), REQUESTER);
    expect(redispatched).toHaveLength(0);

    // The admin allows it once.
    await click(adminButton('env_skill_once'));
    expect(redispatched).toHaveLength(1);
    expect(redispatched[0].user).toBe(REQUESTER);
    expect(redispatched[0].text).toBe(text);
    // The re-sent turn passes the gate and the skill runs.
    expect(redispatched[0].result.continueWithPrompt).toContain('Run the environment QA profile');
    // The admin's DM prompt is closed (buttons replaced by the outcome).
    expect(updated.map((u) => u.channel)).toEqual([`D-${ADMIN}`]);

    // In that thread the model path is open now — repeat calls included (one deploy calls it 3 times).
    expect(policy('Skill', { skill: 'acme-env:post-deploy' }).decision).toBe('pass');
    expect(policy('Skill', { skill: 'acme-env:post-deploy' }).decision).toBe('pass');
    expect(policy('Read', { file_path: skillFile }).decision).toBe('allow');
    // Writing the skill stays closed.
    expect(policy('Write', { file_path: skillFile, content: 'x' }).decision).toBe('deny');

    // Another thread is a new ask.
    expect((await ask(text, REQUESTER, OTHER_THREAD)).awaitingPermission).toBe(true);
    expect(policy('Skill', { skill: 'acme-env:post-deploy' }, OTHER_THREAD).decision).toBe('deny');
  });

  it('per skill: an approval opens only that skill; the next skill asks the admin again', async () => {
    const where = { channel: 'CFLOW00005', threadTs: '1793000000.000500' };
    const qaFile = path.join(PLUGINS_DIR, 'acme-env', 'skills', 'dev2-qa', 'SKILL.md');
    fs.mkdirSync(path.dirname(qaFile), { recursive: true });
    fs.writeFileSync(qaFile, '# acme dev2-qa\nRun the dev QA profile.');

    await ask('$acme-env:post-deploy', REQUESTER, where);
    await click(adminButton('env_skill_once'));
    expect(policy('Skill', { skill: 'acme-env:post-deploy' }, where).decision).toBe('pass');

    // The approval named post-deploy only: dev2-qa in the same thread is still closed, on both paths.
    expect(policy('Skill', { skill: 'acme-env:dev2-qa' }, where).decision).toBe('deny');
    expect(policy('Read', { file_path: qaFile }, where).decision).toBe('deny');
    const second = await ask('$acme-env:dev2-qa', REQUESTER, where);
    expect(second.awaitingPermission).toBe(true);
    expect(JSON.stringify(posted)).not.toContain('Run the dev QA profile');

    // A second, separate admin DM names dev2-qa, and its own approval opens it.
    expect(slackApi.openDmChannel).toHaveBeenCalledTimes(2);
    const dms = posted.filter((p) => p.channel === `D-${ADMIN}` && Array.isArray(p.opts?.blocks));
    expect(dms).toHaveLength(2);
    expect(JSON.stringify(dms[1].opts?.blocks)).toContain('acme-env:dev2-qa');
    await click(adminButton('env_skill_once'));
    expect(redispatched[redispatched.length - 1]?.result.continueWithPrompt).toContain('Run the dev QA profile');
    expect(policy('Skill', { skill: 'acme-env:dev2-qa' }, where).decision).toBe('pass');
  });

  it('거부: no grant, no re-dispatch, a second click changes nothing', async () => {
    const where = { channel: 'CFLOW00002', threadTs: '1793000000.000200' };
    await ask('$acme-env:post-deploy', REQUESTER, where);
    const deny = adminButton('env_skill_deny');
    await click(deny);
    expect(redispatched).toHaveLength(0);
    expect(posted.some((p) => p.text.includes('거부'))).toBe(true);
    await click(adminButton('env_skill_once'));
    expect(redispatched).toHaveLength(0);
    expect(policy('Skill', { skill: 'acme-env:post-deploy' }, where).decision).toBe('deny');
  });

  it('항상 허용: the grant persists on disk and holds in every thread', async () => {
    const where = { channel: 'CFLOW00003', threadTs: '1793000000.000300' };
    await ask('$acme-env:post-deploy', REQUESTER, where);
    await click(adminButton('env_skill_always'));
    expect(redispatched).toHaveLength(1);
    expect(redispatched[0].result.continueWithPrompt).toContain('Run the environment QA profile');
    const grants = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'env-skill-grants.json'), 'utf8'));
    expect(grants.perSkill['acme-env:post-deploy']).toContain(REQUESTER);
    expect(policy('Skill', { skill: 'acme-env:post-deploy' }, { channel: 'CANY', threadTs: '1.1' }).decision).toBe(
      'pass',
    );
  });

  it('admins never ask', async () => {
    const result = await ask('$acme-env:post-deploy', ADMIN, { channel: 'CFLOW00004', threadTs: '1793000000.000400' });
    expect(result.continueWithPrompt).toContain('Run the environment QA profile');
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
  });
});
