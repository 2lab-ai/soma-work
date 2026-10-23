/**
 * DeployLaneTrigger — a deploy_completed directive fires the lanes registered
 * for that repo + target branch — cron jobs whose owner opted in with
 * `onDeploy`, and deploy-only lanes in deploy-lanes.json — and says so in the
 * deploy thread.
 */

import type { DeployCompletedPayload } from '@soma/slack/directives/deploy-completed-directive';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { CronScheduler } from '../cron-scheduler';
import { DEPLOY_LANE_DEDUPE_MS, DeployLaneTrigger } from '../deploy-lanes';
import { Logger } from '../logger';

// Pass-through by default; a test makes one read fail the way a real lookup can.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync), readFileSync: vi.fn(actual.readFileSync) };
});
let realFs: typeof import('fs');
beforeAll(async () => {
  realFs = await vi.importActual<typeof import('fs')>('fs');
});

const AFTER = '0123456789abcdef0123456789abcdef01234567';
const BEFORE = 'fedcba9876543210fedcba9876543210fedcba98';
/** Every ⚠️ line ends with what the owner can do about it — and pings the owner when the lane is known. */
const RECOVERY = /\(<@U_OWNER> cron run qa-lane\)$/;
const GENERIC_RECOVERY = /\(owner: cron run 레인 이름\)$/;
/** A deploy-only lane is not a cron job: its recovery is running its prompt by hand. */
const LANE_RECOVERY = /\(<@U_OWNER> 직접 실행: `QA the deployed PRs`\)$/;

describe('DeployLaneTrigger', () => {
  let file: string;
  let registry: string;
  let storage: CronStorage;
  let runJobNow: Mock<CronScheduler['runJobNow']>;
  let fireDeployLane: Mock<CronScheduler['fireDeployLane']>;
  let clock: number;
  let replies: string[];
  let ctx: { channel: string; threadTs: string; user: string; reply: (line: string) => Promise<void> };

  function trigger(over: { scheduler?: null; settleMs?: number } = {}) {
    return new DeployLaneTrigger({
      storagePath: file,
      registryPath: registry,
      getScheduler: () => (over.scheduler === null ? null : { runJobNow, fireDeployLane }),
      now: () => clock,
      settleMs: over.settleMs ?? 20,
    });
  }

  function deploy(over: Partial<DeployCompletedPayload> = {}) {
    return {
      kind: 'completed' as const,
      payload: { repo: 'acme/app', target: 'deploy/staging', after: AFTER, confirmed: true, ...over },
    };
  }

  function addLane(over: Record<string, any> = {}) {
    return storage.addJob({
      name: 'qa-lane',
      expression: '0 0 31 2 *',
      prompt: 'QA the deployed PRs',
      owner: 'U_OWNER',
      channel: 'C_QA',
      threadTs: null,
      onDeploy: [{ repo: 'acme/app', target: 'deploy/staging' }],
      ...over,
    });
  }

  /** A deploy-only lane entry (deploy-lanes.json), defaults matching `addLane`. */
  function registryLane(over: Record<string, unknown> = {}) {
    return {
      name: 'qa-lane',
      owner: 'U_OWNER',
      channel: 'C_QA',
      prompt: 'QA the deployed PRs',
      onDeploy: [{ repo: 'acme/app', target: 'deploy/staging' }],
      ...over,
    };
  }

  function writeRegistry(lanes: unknown[]) {
    fs.writeFileSync(registry, JSON.stringify({ lanes }));
  }

  /** Let a late fire settle and its follow-up post. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync);
    vi.mocked(fs.readFileSync).mockImplementation(realFs.readFileSync);
    file = path.join(os.tmpdir(), `deploy-lanes-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    registry = file.replace(/\.json$/, '-registry.json');
    storage = new CronStorage(file);
    runJobNow = vi.fn<CronScheduler['runJobNow']>().mockResolvedValue({ ok: true, message: 'new_thread' });
    fireDeployLane = vi.fn<CronScheduler['fireDeployLane']>().mockResolvedValue({ ok: true, message: 'new_thread' });
    clock = Date.UTC(2026, 9, 21, 9, 0, 0);
    replies = [];
    ctx = {
      channel: 'C_DEPLOY',
      threadTs: '111.222',
      user: 'U_DEPLOYER',
      reply: async (line) => {
        replies.push(line);
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const f of [file, `${file}.tmp`, file.replace(/\.json$/, '-history.json'), registry]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  it('fires a matching job as its owner in a new thread, tells it which deploy fired it and where the deploy thread is, and says where it posts', async () => {
    addLane();
    await trigger().handle(deploy({ before: BEFORE }), ctx);

    expect(runJobNow).toHaveBeenCalledTimes(1);
    expect(runJobNow).toHaveBeenCalledWith('U_OWNER', 'qa-lane', {
      triggeredBy: 'U_DEPLOYER',
      forceNewThread: true,
      note: `\n\n[deploy_completed repo=acme/app target=deploy/staging before=${BEFORE} after=${AFTER} by=U_DEPLOYER channel=C_DEPLOY thread=111.222]`,
    });
    expect(fireDeployLane).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('배포 레인 시작');
    expect(replies[0]).toContain('*qa-lane* → <#C_QA> 새 스레드');
    expect(replies[0]).toContain(`acme/app → deploy/staging (${AFTER.slice(0, 7)})`);
    expect(replies[0]).not.toContain('\n');
  });

  it('marks an unknown `before` with a dash in the note', async () => {
    addLane();
    await trigger().handle(deploy(), ctx);
    expect(runJobNow.mock.calls[0][2]?.note).toContain('before=- ');
  });

  it('normalizes the target: refs/heads/ on either side still matches', async () => {
    addLane({ onDeploy: [{ repo: 'acme/app', target: 'refs/heads/deploy/staging' }] });
    const t = trigger();
    await t.handle(deploy({ after: 'aaaaaaa' }), ctx);
    await t.handle(deploy({ target: 'refs/heads/deploy/staging', after: 'bbbbbbb' }), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('matches the repo case-insensitively', async () => {
    addLane({ onDeploy: [{ repo: 'Acme/App', target: 'deploy/staging' }] });
    await trigger().handle(deploy({ repo: 'ACME/app' }), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(1);
  });

  it('matches the target exactly; a near miss on the same repo names the registered targets', async () => {
    addLane();
    const t = trigger();
    await t.handle(deploy({ target: 'staging' }), ctx);
    await t.handle(deploy({ target: 'Deploy/Staging' }), ctx);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(replies).toEqual([
      'ℹ️ acme/app → staging: 레인 없음 (등록: deploy/staging)',
      'ℹ️ acme/app → Deploy/Staging: 레인 없음 (등록: deploy/staging)',
    ]);
  });

  it('stays quiet for a repo no lane lists', async () => {
    addLane();
    storage.addJob({
      name: 'plain-cron',
      expression: '0 9 * * *',
      prompt: 'no opt-in',
      owner: 'U_OWNER',
      channel: 'C_QA',
      threadTs: null,
    });
    await trigger().handle(deploy({ repo: 'acme/other' }), ctx);
    expect(replies).toEqual([]);
    expect(runJobNow).not.toHaveBeenCalled();
  });

  it('answers a repeat of the same (job, after) within the window with an already-fired line', async () => {
    addLane();
    const t = trigger();
    await t.handle(deploy(), ctx);
    clock += 5 * 60 * 1000;
    await t.handle(deploy({ after: AFTER.toUpperCase() }), ctx);

    expect(runJobNow).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(2);
    // 09:00Z fire = 18:00 KST.
    expect(replies[1]).toBe(
      `ℹ️ 배포 레인 이미 발동됨 18:00 KST — acme/app → deploy/staging (${AFTER.slice(0, 7)}): *qa-lane*`,
    );
  });

  it('fires again for a different merge commit', async () => {
    addLane();
    const t = trigger();
    await t.handle(deploy({ after: 'aaaaaaa' }), ctx);
    await t.handle(deploy({ after: 'bbbbbbb' }), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('forgets a fired (job, after) once the dedupe window has passed', async () => {
    addLane();
    const t = trigger();
    await t.handle(deploy(), ctx);
    clock += DEPLOY_LANE_DEDUPE_MS + 1;
    await t.handle(deploy(), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('says a matched lane did not start when no scheduler is running', async () => {
    addLane();
    await trigger({ scheduler: null }).handle(deploy(), ctx);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(replies).toEqual([
      '⚠️ 배포 레인 미발동 — cron scheduler not running: *qa-lane* (<@U_OWNER> cron run qa-lane)',
    ]);
  });

  it('stays quiet without a scheduler when no lane matches', async () => {
    await trigger({ scheduler: null }).handle(deploy(), ctx);
    expect(replies).toEqual([]);
  });

  it('fires every matching job (different owners) and names them all in one line', async () => {
    addLane();
    addLane({ name: 'smoke-lane', owner: 'U_OTHER', channel: 'C_SMOKE', target: 'dm' });
    await trigger().handle(deploy(), ctx);
    expect(runJobNow).toHaveBeenCalledWith('U_OWNER', 'qa-lane', expect.objectContaining({ forceNewThread: true }));
    expect(runJobNow).toHaveBeenCalledWith('U_OTHER', 'smoke-lane', expect.objectContaining({ forceNewThread: true }));
    expect(replies).toHaveLength(1);
    // A dm-target job still opens a thread in its channel: deploy fires are forced there.
    expect(replies[0]).toContain('*qa-lane* → <#C_QA> 새 스레드, *smoke-lane* → <#C_SMOKE> 새 스레드');
  });

  it('reports why a matched job did not start, with the recovery, and lets the same commit retry', async () => {
    addLane();
    runJobNow.mockResolvedValueOnce({ ok: false, message: 'delivery failed (new_thread)' });
    const t = trigger();
    await t.handle(deploy(), ctx);

    expect(replies[0]).toBe(
      `⚠️ 배포 레인 미발동 — acme/app → deploy/staging (${AFTER.slice(0, 7)}): *qa-lane* (delivery failed (new_thread)) (<@U_OWNER> cron run qa-lane)`,
    );
    expect(replies[0]).toMatch(RECOVERY);

    await t.handle(deploy(), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
    expect(replies[1]).toContain('배포 레인 시작');
  });

  it('treats a thrown fire as a failure without an unhandled rejection', async () => {
    addLane();
    runJobNow.mockRejectedValue(new Error('boom'));
    await trigger().handle(deploy(), ctx);
    expect(replies[0]).toContain('(boom)');
    expect(replies[0]).toMatch(RECOVERY);
  });

  it('does not wait for a lane turn: a fire still running after the settle window counts as started', async () => {
    addLane();
    runJobNow.mockReturnValue(new Promise(() => {}));
    await trigger({ settleMs: 10 }).handle(deploy(), ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('배포 레인 시작');
    expect(replies[0]).not.toContain('⚠️');
  });

  it('follows up in the thread when a started lane fails after the settle window, and frees the commit for a retry', async () => {
    addLane();
    let finish: (value: { ok: boolean; message: string }) => void = () => {};
    runJobNow.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const t = trigger({ settleMs: 10 });
    await t.handle(deploy(), ctx);
    expect(replies).toHaveLength(1);

    finish({ ok: false, message: 'delivery failed (new_thread)' });
    await flush();

    expect(replies).toHaveLength(2);
    expect(replies[1]).toBe(
      `⚠️ 배포 레인 실패 — acme/app → deploy/staging (${AFTER.slice(0, 7)}): *qa-lane* (delivery failed (new_thread)) (<@U_OWNER> cron run qa-lane)`,
    );

    await t.handle(deploy(), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('never calls a queued fire "started"', async () => {
    addLane();
    runJobNow.mockResolvedValue({ ok: true, message: 'busy_queue' });
    await trigger().handle(deploy(), ctx);
    expect(replies[0]).not.toContain('시작 —');
    expect(replies[0]).toContain('*qa-lane* 대기열 등록(아직 시작 안 됨)');
  });

  it('reports an unreadable cron file instead of "no lane"', async () => {
    fs.writeFileSync(file, '{ not json');
    await trigger().handle(deploy(), ctx);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    // Generic text only: the parse error carries the server's absolute path.
    expect(replies[0]).toBe(
      `⚠️ 배포 레인 확인 불가 — acme/app → deploy/staging (${AFTER.slice(0, 7)}): cron 설정 파일을 읽지 못함 (owner: cron run 레인 이름)`,
    );
    expect(replies[0]).not.toContain(file);
    expect(replies[0]).toMatch(GENERIC_RECOVERY);
  });

  it('skips hand-edited entries that are not jobs instead of throwing', async () => {
    const lane = addLane();
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.jobs = [null, 'junk', 7, raw.jobs[0]];
    fs.writeFileSync(file, JSON.stringify(raw));

    await trigger().handle(deploy(), ctx);

    expect(runJobNow).toHaveBeenCalledTimes(1);
    expect(runJobNow).toHaveBeenCalledWith(lane.owner, lane.name, expect.objectContaining({ forceNewThread: true }));
    expect(replies[0]).toContain('배포 레인 시작');

    await trigger().handle(
      { kind: 'rejected', rejections: [{ problem: 'after must be a 7-40 char hex sha', repo: 'acme/app' }] },
      ctx,
    );
    expect(replies[1]).toMatch(RECOVERY);
  });

  it('pings each owner of the lanes that did not start', async () => {
    addLane();
    addLane({ name: 'smoke-lane', owner: 'U_OTHER', channel: 'C_SMOKE' });
    await trigger({ scheduler: null }).handle(deploy(), ctx);
    expect(replies).toEqual([
      '⚠️ 배포 레인 미발동 — cron scheduler not running: *qa-lane*, *smoke-lane* (<@U_OWNER> cron run qa-lane · <@U_OTHER> cron run smoke-lane)',
    ]);
  });

  it('does not fire on an unconfirmed deploy and says which lanes did not start', async () => {
    addLane();
    await trigger().handle(deploy({ confirmed: false }), ctx);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(replies).toEqual([
      '⚠️ acme/app → deploy/staging 머지됨, 배포 미확인 — 레인 미발동: *qa-lane* (<@U_OWNER> cron run qa-lane)',
    ]);
  });

  it('stays quiet on an unconfirmed deploy of a repo no lane lists', async () => {
    await trigger().handle(deploy({ repo: 'acme/other', confirmed: false }), ctx);
    expect(replies).toEqual([]);
  });

  it('makes a rejected directive visible, naming the lanes of its repo when it can', async () => {
    addLane();
    const t = trigger();
    await t.handle(
      {
        kind: 'rejected',
        rejections: [{ problem: 'after must be a 7-40 char hex sha', repo: 'Acme/App', after: 'nope' }],
      },
      ctx,
    );
    await t.handle(
      { kind: 'rejected', rejections: [{ problem: 'unparseable JSON, or "type" is not the first key' }] },
      ctx,
    );

    expect(runJobNow).not.toHaveBeenCalled();
    expect(replies).toEqual([
      '⚠️ deploy_completed 무시됨 — Acme/App: after must be a 7-40 char hex sha; 레인 미발동 (<@U_OWNER> cron run qa-lane)',
      '⚠️ deploy_completed 무시됨 — unparseable JSON, or "type" is not the first key; 레인 미발동 (owner: cron run 레인 이름)',
    ]);
  });

  // A deploy-only lane (DATA_DIR/deploy-lanes.json) is not a cron job: no
  // schedule, not in `cron list`. It fires only on a deploy, through
  // CronScheduler.fireDeployLane, and reports back into the deploy thread the
  // note names.
  describe('deploy-only lanes (deploy-lanes.json)', () => {
    const SHA7 = AFTER.slice(0, 7);
    const NOTE = `\n\n[deploy_completed repo=acme/app target=deploy/staging before=${BEFORE} after=${AFTER} by=U_DEPLOYER channel=C_DEPLOY thread=111.222]`;

    it('fires a registry lane through fireDeployLane — never runJobNow — with a root line naming the deploy thread and the same note', async () => {
      writeRegistry([registryLane({ modelConfig: { type: 'opus' } })]);
      await trigger().handle(deploy({ before: BEFORE }), ctx);

      expect(runJobNow).not.toHaveBeenCalled();
      expect(fireDeployLane).toHaveBeenCalledTimes(1);
      const [lane, opts] = fireDeployLane.mock.calls[0];
      expect(lane).toMatchObject({
        name: 'qa-lane',
        owner: 'U_OWNER',
        channel: 'C_QA',
        prompt: 'QA the deployed PRs',
        modelConfig: { type: 'opus' },
      });
      expect(opts).toEqual({
        triggeredBy: 'U_DEPLOYER',
        note: NOTE,
        rootText: `▶ acme/app → deploy/staging (${SHA7}) 배포 후 레인 *qa-lane* — 배포 스레드: <#C_DEPLOY>`,
      });
      expect(opts.rootText).not.toMatch(/cron/i);
      expect(replies).toEqual([
        `▶ 배포 레인 시작 — acme/app → deploy/staging (${SHA7}): *qa-lane* → <#C_QA> 새 스레드`,
      ]);
    });

    it('fires the cron jobs and the registry lanes of one deploy together, with one note, in one line', async () => {
      addLane({ name: 'cron-lane' });
      writeRegistry([registryLane({ channel: 'C_SMOKE' })]);
      await trigger().handle(deploy({ before: BEFORE }), ctx);

      expect(runJobNow).toHaveBeenCalledWith('U_OWNER', 'cron-lane', {
        triggeredBy: 'U_DEPLOYER',
        forceNewThread: true,
        note: NOTE,
      });
      expect(fireDeployLane).toHaveBeenCalledWith(expect.objectContaining({ name: 'qa-lane' }), expect.anything());
      expect(fireDeployLane.mock.calls[0][1].note).toBe(NOTE);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('*cron-lane* → <#C_QA> 새 스레드, *qa-lane* → <#C_SMOKE> 새 스레드');
    });

    it('matches like onDeploy: repo case-insensitive, refs/heads/ dropped, target exact', async () => {
      writeRegistry([registryLane({ onDeploy: [{ repo: 'Acme/App', target: 'refs/heads/deploy/staging' }] })]);
      const t = trigger();
      await t.handle(deploy({ repo: 'ACME/app', after: 'aaaaaaa' }), ctx);
      await t.handle(deploy({ target: 'staging', after: 'bbbbbbb' }), ctx);

      expect(fireDeployLane).toHaveBeenCalledTimes(1);
      expect(replies[1]).toBe('ℹ️ acme/app → staging: 레인 없음 (등록: deploy/staging)');
    });

    it('names the targets of both sources in the near-miss line', async () => {
      addLane({ name: 'cron-lane', onDeploy: [{ repo: 'acme/app', target: 'develop' }] });
      writeRegistry([registryLane()]);
      await trigger().handle(deploy({ target: 'main' }), ctx);
      expect(replies).toEqual(['ℹ️ acme/app → main: 레인 없음 (등록: develop, deploy/staging)']);
    });

    it('stays quiet without the file, and for a repo no lane lists', async () => {
      await trigger().handle(deploy(), ctx);
      writeRegistry([registryLane()]);
      await trigger().handle(deploy({ repo: 'acme/other' }), ctx);
      expect(replies).toEqual([]);
      expect(fireDeployLane).not.toHaveBeenCalled();
    });

    it('skips entries that are not lanes with a warning — never throws — and fires the valid one', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      writeRegistry([
        null,
        'junk',
        7,
        [],
        registryLane({ name: '' }),
        registryLane({ name: 'no-owner', owner: undefined }),
        registryLane({ name: 'no-channel', channel: 7 }),
        registryLane({ name: 'no-prompt', prompt: '   ' }),
        registryLane({ name: 'no-on-deploy', onDeploy: undefined }),
        registryLane({ name: 'bad-repo', onDeploy: [{ repo: 'app', target: 'deploy/staging' }] }),
        registryLane({ name: 'bad-target', onDeploy: [{ repo: 'acme/app', target: 'deploy staging' }] }),
        registryLane({ name: 'bad-model', modelConfig: 'opus' }),
        registryLane({ name: 'unknown-model-type', modelConfig: { type: 'sonnet' } }),
        registryLane({ name: 'custom-without-model', modelConfig: { type: 'custom' } }),
        registryLane(),
        // (owner, name) is the identity: a second entry for it is skipped, not fired twice.
        registryLane({ prompt: 'a second qa-lane of the same owner' }),
      ]);

      await trigger().handle(deploy(), ctx);

      expect(fireDeployLane).toHaveBeenCalledTimes(1);
      expect(fireDeployLane.mock.calls[0][0]).toMatchObject({ name: 'qa-lane', prompt: 'QA the deployed PRs' });
      expect(replies).toEqual([
        `▶ 배포 레인 시작 — acme/app → deploy/staging (${SHA7}): *qa-lane* → <#C_QA> 새 스레드`,
      ]);
      const skipped = warn.mock.calls.filter(([message]) => message === 'deploy-lanes.json entry skipped');
      expect(skipped).toHaveLength(15);
    });

    // Lanes are independent: a source that cannot be read gets its own ⚠️ line
    // and contributes no lanes; the other source's lanes still fire.
    const REGISTRY_UNREADABLE = `⚠️ 배포 레인 확인 불가 — acme/app → deploy/staging (${SHA7}): deploy-lanes.json을 읽지 못함 (owner: 레인 프롬프트 직접 실행)`;
    const CRON_LANE_STARTED = `▶ 배포 레인 시작 — acme/app → deploy/staging (${SHA7}): *cron-lane* → <#C_QA> 새 스레드`;

    it('reports an unreadable file with a line of its own and still fires the cron lanes', async () => {
      addLane({ name: 'cron-lane' });
      fs.writeFileSync(registry, '{ not json');
      await trigger().handle(deploy(), ctx);

      expect(runJobNow).toHaveBeenCalledWith('U_OWNER', 'cron-lane', expect.objectContaining({ forceNewThread: true }));
      expect(fireDeployLane).not.toHaveBeenCalled();
      // Generic text only: the parse error carries the server's absolute path.
      expect(replies).toEqual([REGISTRY_UNREADABLE, CRON_LANE_STARTED]);
      expect(replies[0]).not.toContain(registry);
    });

    it('reports an unreadable cron file with a line of its own and still fires the registry lanes', async () => {
      fs.writeFileSync(file, '{ not json');
      writeRegistry([registryLane()]);
      await trigger().handle(deploy(), ctx);

      expect(runJobNow).not.toHaveBeenCalled();
      expect(fireDeployLane).toHaveBeenCalledTimes(1);
      expect(replies).toEqual([
        `⚠️ 배포 레인 확인 불가 — acme/app → deploy/staging (${SHA7}): cron 설정 파일을 읽지 못함 (owner: cron run 레인 이름)`,
        `▶ 배포 레인 시작 — acme/app → deploy/staging (${SHA7}): *qa-lane* → <#C_QA> 새 스레드`,
      ]);
    });

    it('drops the near-miss line while a source cannot be read — it would name half the targets', async () => {
      addLane({ name: 'cron-lane', onDeploy: [{ repo: 'acme/app', target: 'develop' }] });
      fs.writeFileSync(registry, '{ not json');
      await trigger().handle(deploy(), ctx);

      expect(runJobNow).not.toHaveBeenCalled();
      expect(replies).toEqual([REGISTRY_UNREADABLE]);
    });

    // Only a missing file is "no lanes". A lookup that fails any other way also
    // makes existsSync() say false — it must read as unreadable, not as empty,
    // or the matching cron jobs fire with no word about the registry.
    it('reads a registry that cannot be accessed (EACCES) as unreadable, not as absent', async () => {
      addLane({ name: 'cron-lane' });
      writeRegistry([registryLane()]);
      // What an unreadable parent dir does: the lookup fails, so existsSync says false and the read throws.
      vi.mocked(fs.existsSync).mockImplementation((target) => target !== registry && realFs.existsSync(target));
      vi.mocked(fs.readFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
        if (target === registry) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${registry}'`), { code: 'EACCES' });
        }
        return realFs.readFileSync(target, options as BufferEncoding);
      }) as typeof fs.readFileSync);

      await trigger().handle(deploy(), ctx);

      expect(runJobNow).toHaveBeenCalledTimes(1);
      expect(fireDeployLane).not.toHaveBeenCalled();
      expect(replies).toEqual([REGISTRY_UNREADABLE, CRON_LANE_STARTED]);
      expect(replies[0]).not.toContain(registry);
    });

    it('reads a registry path that cannot be looked up (ENOTDIR) as unreadable, not as absent', async () => {
      addLane({ name: 'cron-lane' });
      const notADir = `${registry}.file`;
      fs.writeFileSync(notADir, '');
      registry = path.join(notADir, 'deploy-lanes.json');
      try {
        await trigger().handle(deploy(), ctx);
      } finally {
        fs.unlinkSync(notADir);
      }

      expect(runJobNow).toHaveBeenCalledTimes(1);
      expect(replies).toEqual([REGISTRY_UNREADABLE, CRON_LANE_STARTED]);
    });

    it.each([
      ['a top-level array', '[]'],
      ['lanes that is not an array', '{ "lanes": {} }'],
      ['no lanes key', '{ "jobs": [] }'],
      ['null', 'null'],
    ])('reads a file holding %s as unreadable', async (_label, raw) => {
      writeRegistry([]);
      fs.writeFileSync(registry, raw);
      await trigger().handle(deploy(), ctx);
      expect(replies).toEqual([REGISTRY_UNREADABLE]);
    });

    it('names both files in one line when neither can be read, and fires nothing', async () => {
      fs.writeFileSync(file, '{ not json');
      fs.writeFileSync(registry, '{ not json');
      await trigger().handle(deploy(), ctx);
      expect(runJobNow).not.toHaveBeenCalled();
      expect(fireDeployLane).not.toHaveBeenCalled();
      expect(replies).toEqual([
        `⚠️ 배포 레인 확인 불가 — acme/app → deploy/staging (${SHA7}): cron 설정 파일, deploy-lanes.json을 읽지 못함 (owner: cron run 레인 이름 · 레인 프롬프트 직접 실행)`,
      ]);
    });

    it('ends a failure with running the prompt by hand — on one line — not `cron run`, and lets the same commit retry', async () => {
      writeRegistry([registryLane({ prompt: 'QA the\n  deployed\tPRs' })]);
      fireDeployLane.mockResolvedValueOnce({ ok: false, message: 'thread creation returned no ts' });
      const t = trigger();
      await t.handle(deploy(), ctx);

      expect(replies[0]).toBe(
        `⚠️ 배포 레인 미발동 — acme/app → deploy/staging (${SHA7}): *qa-lane* (thread creation returned no ts) (<@U_OWNER> 직접 실행: \`QA the deployed PRs\`)`,
      );
      expect(replies[0]).toMatch(LANE_RECOVERY);
      expect(replies[0]).not.toContain('cron run');
      // The lane itself still gets its prompt as written.
      expect(fireDeployLane.mock.calls[0][0].prompt).toBe('QA the\n  deployed\tPRs');

      await t.handle(deploy(), ctx);
      expect(fireDeployLane).toHaveBeenCalledTimes(2);
      expect(replies[1]).toContain('배포 레인 시작');
    });

    it('gives each lane its own recovery when a deploy is unconfirmed or the scheduler is down', async () => {
      addLane({ name: 'cron-lane' });
      writeRegistry([registryLane()]);
      await trigger().handle(deploy({ confirmed: false }), ctx);
      await trigger({ scheduler: null }).handle(deploy(), ctx);

      expect(runJobNow).not.toHaveBeenCalled();
      expect(fireDeployLane).not.toHaveBeenCalled();
      expect(replies).toEqual([
        '⚠️ acme/app → deploy/staging 머지됨, 배포 미확인 — 레인 미발동: *cron-lane*, *qa-lane* (<@U_OWNER> cron run cron-lane · <@U_OWNER> 직접 실행: `QA the deployed PRs`)',
        '⚠️ 배포 레인 미발동 — cron scheduler not running: *cron-lane*, *qa-lane* (<@U_OWNER> cron run cron-lane · <@U_OWNER> 직접 실행: `QA the deployed PRs`)',
      ]);
    });

    it('dedupes by (owner, name, after) across re-reads of the file, apart from a cron job of the same name', async () => {
      addLane();
      writeRegistry([registryLane()]);
      const t = trigger();
      await t.handle(deploy(), ctx);
      expect(runJobNow).toHaveBeenCalledTimes(1);
      expect(fireDeployLane).toHaveBeenCalledTimes(1);

      clock += 5 * 60 * 1000;
      await t.handle(deploy({ after: AFTER.toUpperCase() }), ctx);
      expect(runJobNow).toHaveBeenCalledTimes(1);
      expect(fireDeployLane).toHaveBeenCalledTimes(1);
      expect(replies[1]).toBe(
        `ℹ️ 배포 레인 이미 발동됨 18:00 KST — acme/app → deploy/staging (${SHA7}): *qa-lane*, *qa-lane*`,
      );

      await t.handle(deploy({ after: 'bbbbbbb' }), ctx);
      expect(fireDeployLane).toHaveBeenCalledTimes(2);
    });

    it('follows up when a started registry lane fails after the settle window, and frees the commit for a retry', async () => {
      writeRegistry([registryLane()]);
      let finish: (value: { ok: boolean; message: string }) => void = () => {};
      fireDeployLane.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const t = trigger({ settleMs: 10 });
      await t.handle(deploy(), ctx);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('배포 레인 시작');

      finish({ ok: false, message: 'turn failed' });
      await flush();

      expect(replies[1]).toBe(
        `⚠️ 배포 레인 실패 — acme/app → deploy/staging (${SHA7}): *qa-lane* (turn failed) (<@U_OWNER> 직접 실행: \`QA the deployed PRs\`)`,
      );
      await t.handle(deploy(), ctx);
      expect(fireDeployLane).toHaveBeenCalledTimes(2);
    });

    it('names the registry lanes of a rejected directive, and its generic hint covers them', async () => {
      writeRegistry([registryLane()]);
      const t = trigger();
      await t.handle(
        { kind: 'rejected', rejections: [{ problem: 'after must be a 7-40 char hex sha', repo: 'acme/app' }] },
        ctx,
      );
      await t.handle(
        { kind: 'rejected', rejections: [{ problem: 'unparseable JSON, or "type" is not the first key' }] },
        ctx,
      );

      expect(fireDeployLane).not.toHaveBeenCalled();
      expect(replies).toEqual([
        '⚠️ deploy_completed 무시됨 — acme/app: after must be a 7-40 char hex sha; 레인 미발동 (<@U_OWNER> 직접 실행: `QA the deployed PRs`)',
        '⚠️ deploy_completed 무시됨 — unparseable JSON, or "type" is not the first key; 레인 미발동 (owner: 레인 프롬프트 직접 실행)',
      ]);
    });

    it('still names the cron lanes of a rejected directive when the registry file cannot be read', async () => {
      addLane({ name: 'cron-lane' });
      fs.writeFileSync(registry, '{ not json');
      await trigger().handle({ kind: 'rejected', rejections: [{ problem: 'bad sha', repo: 'acme/app' }] }, ctx);
      expect(replies).toEqual([
        '⚠️ deploy_completed 무시됨 — acme/app: bad sha; 레인 미발동 (<@U_OWNER> cron run cron-lane)',
      ]);
    });
  });
});
