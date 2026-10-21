/**
 * DeployLaneTrigger — a deploy_completed directive fires the cron jobs whose
 * owner opted in with `onDeploy` for that repo + target branch, and says so in
 * the deploy thread.
 */

import type { DeployCompletedPayload } from '@soma/slack/directives/deploy-completed-directive';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { CronScheduler } from '../cron-scheduler';
import { DEPLOY_LANE_DEDUPE_MS, DeployLaneTrigger } from '../deploy-lanes';

const AFTER = '0123456789abcdef0123456789abcdef01234567';
const BEFORE = 'fedcba9876543210fedcba9876543210fedcba98';
/** Every ⚠️ line ends with what the owner can do about it. */
const RECOVERY = /\(owner: cron run [^)]+\)$/;

describe('DeployLaneTrigger', () => {
  let file: string;
  let storage: CronStorage;
  let runJobNow: Mock<CronScheduler['runJobNow']>;
  let clock: number;
  let replies: string[];
  let ctx: { channel: string; threadTs: string; user: string; reply: (line: string) => Promise<void> };

  function trigger(over: { scheduler?: null; settleMs?: number } = {}) {
    return new DeployLaneTrigger({
      storagePath: file,
      getScheduler: () => (over.scheduler === null ? null : { runJobNow }),
      now: () => clock,
      settleMs: over.settleMs ?? 20,
    });
  }

  function deploy(over: Partial<DeployCompletedPayload> = {}) {
    return {
      kind: 'completed' as const,
      payload: { repo: 'acme/app', target: 'deploy/dev2', after: AFTER, confirmed: true, ...over },
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
      onDeploy: [{ repo: 'acme/app', target: 'deploy/dev2' }],
      ...over,
    });
  }

  /** Let a late fire settle and its follow-up post. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    file = path.join(os.tmpdir(), `deploy-lanes-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    storage = new CronStorage(file);
    runJobNow = vi.fn<CronScheduler['runJobNow']>().mockResolvedValue({ ok: true, message: 'new_thread' });
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
    for (const f of [file, `${file}.tmp`, file.replace(/\.json$/, '-history.json')]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  it('fires a matching job as its owner in a new thread, tells it which deploy fired it, and says where it posts', async () => {
    addLane();
    await trigger().handle(deploy({ before: BEFORE }), ctx);

    expect(runJobNow).toHaveBeenCalledTimes(1);
    expect(runJobNow).toHaveBeenCalledWith('U_OWNER', 'qa-lane', {
      triggeredBy: 'U_DEPLOYER',
      forceNewThread: true,
      note: `\n\n[deploy_completed repo=acme/app target=deploy/dev2 before=${BEFORE} after=${AFTER} by=U_DEPLOYER]`,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('배포 레인 시작');
    expect(replies[0]).toContain('*qa-lane* → <#C_QA> 새 스레드');
    expect(replies[0]).toContain(`acme/app → deploy/dev2 (${AFTER.slice(0, 7)})`);
    expect(replies[0]).not.toContain('\n');
  });

  it('marks an unknown `before` with a dash in the note', async () => {
    addLane();
    await trigger().handle(deploy(), ctx);
    expect(runJobNow.mock.calls[0][2]?.note).toContain('before=- ');
  });

  it('normalizes the target: refs/heads/ on either side still matches', async () => {
    addLane({ onDeploy: [{ repo: 'acme/app', target: 'refs/heads/deploy/dev2' }] });
    const t = trigger();
    await t.handle(deploy({ after: 'aaaaaaa' }), ctx);
    await t.handle(deploy({ target: 'refs/heads/deploy/dev2', after: 'bbbbbbb' }), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('matches the repo case-insensitively', async () => {
    addLane({ onDeploy: [{ repo: 'Acme/App', target: 'deploy/dev2' }] });
    await trigger().handle(deploy({ repo: 'ACME/app' }), ctx);
    expect(runJobNow).toHaveBeenCalledTimes(1);
  });

  it('matches the target exactly; a near miss on the same repo names the registered targets', async () => {
    addLane();
    const t = trigger();
    await t.handle(deploy({ target: 'dev2' }), ctx);
    await t.handle(deploy({ target: 'Deploy/Dev2' }), ctx);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(replies).toEqual([
      'ℹ️ acme/app → dev2: 레인 없음 (등록: deploy/dev2)',
      'ℹ️ acme/app → Deploy/Dev2: 레인 없음 (등록: deploy/dev2)',
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
      `ℹ️ 배포 레인 이미 발동됨 18:00 KST — acme/app → deploy/dev2 (${AFTER.slice(0, 7)}): *qa-lane*`,
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
    expect(replies).toEqual(['⚠️ 배포 레인 미발동 — cron scheduler not running: *qa-lane* (owner: cron run qa-lane)']);
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
      `⚠️ 배포 레인 미발동 — acme/app → deploy/dev2 (${AFTER.slice(0, 7)}): *qa-lane* (delivery failed (new_thread)) (owner: cron run qa-lane)`,
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
      `⚠️ 배포 레인 실패 — acme/app → deploy/dev2 (${AFTER.slice(0, 7)}): *qa-lane* (delivery failed (new_thread)) (owner: cron run qa-lane)`,
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
    expect(replies[0]).toMatch(
      /^⚠️ 배포 레인 확인 불가 — acme\/app → deploy\/dev2 \(0123456\): cron jobs file unreadable/,
    );
    expect(replies[0]).toMatch(RECOVERY);
  });

  it('does not fire on an unconfirmed deploy and says which lanes did not start', async () => {
    addLane();
    await trigger().handle(deploy({ confirmed: false }), ctx);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(replies).toEqual([
      '⚠️ acme/app → deploy/dev2 머지됨, 배포 미확인 — 레인 미발동: *qa-lane* (owner: cron run qa-lane)',
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
      '⚠️ deploy_completed 무시됨 — Acme/App: after must be a 7-40 char hex sha; 레인 미발동 (owner: cron run qa-lane)',
      '⚠️ deploy_completed 무시됨 — unparseable JSON, or "type" is not the first key; 레인 미발동 (owner: cron run 레인 이름)',
    ]);
  });
});
