/**
 * DeployLaneTrigger — a deploy_completed directive fires the cron jobs whose
 * owner opted in with `onDeploy` for that repo + target branch.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { CronScheduler } from '../cron-scheduler';
import { DEPLOY_LANE_DEDUPE_MS, DeployLaneTrigger } from '../deploy-lanes';

const AFTER = '0123456789abcdef0123456789abcdef01234567';
const ctx = { channel: 'C_DEPLOY', threadTs: '111.222', user: 'U_DEPLOYER' };

describe('DeployLaneTrigger', () => {
  let file: string;
  let storage: CronStorage;
  let runJobNow: Mock<CronScheduler['runJobNow']>;
  let clock: number;

  function trigger(over: { scheduler?: null; settleMs?: number } = {}) {
    return new DeployLaneTrigger({
      storagePath: file,
      getScheduler: () => (over.scheduler === null ? null : { runJobNow }),
      now: () => clock,
      settleMs: over.settleMs ?? 20,
    });
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

  beforeEach(() => {
    file = path.join(os.tmpdir(), `deploy-lanes-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    storage = new CronStorage(file);
    runJobNow = vi.fn<CronScheduler['runJobNow']>().mockResolvedValue({ ok: true, message: 'new_thread' });
    clock = Date.UTC(2026, 9, 21, 9, 0, 0);
  });

  afterEach(() => {
    for (const f of [file, `${file}.tmp`, file.replace(/\.json$/, '-history.json')]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  it('fires a matching job as its owner, attributed to the deployer, and says where it posts', async () => {
    addLane();
    const line = await trigger().handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);

    expect(runJobNow).toHaveBeenCalledTimes(1);
    expect(runJobNow).toHaveBeenCalledWith('U_OWNER', 'qa-lane', { triggeredBy: 'U_DEPLOYER' });
    expect(line).toContain('qa-lane');
    expect(line).toContain('<#C_QA>');
    expect(line).toContain('acme/app');
    expect(line).toContain('deploy/dev2');
    expect(line).toContain(AFTER.slice(0, 7));
    expect(line).not.toContain('\n');
  });

  it('normalizes the target: refs/heads/ on either side still matches', async () => {
    addLane({ onDeploy: [{ repo: 'acme/app', target: 'refs/heads/deploy/dev2' }] });
    const t = trigger();
    await t.handle({ repo: 'acme/app', target: 'deploy/dev2', after: 'aaaaaaa' }, ctx);
    await t.handle({ repo: 'acme/app', target: 'refs/heads/deploy/dev2', after: 'bbbbbbb' }, ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('matches the repo case-insensitively', async () => {
    addLane({ onDeploy: [{ repo: 'Acme/App', target: 'deploy/dev2' }] });
    await trigger().handle({ repo: 'ACME/app', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(runJobNow).toHaveBeenCalledTimes(1);
  });

  it('matches the target exactly (no prefix or env-nickname match)', async () => {
    addLane();
    const t = trigger();
    expect(await t.handle({ repo: 'acme/app', target: 'dev2', after: AFTER }, ctx)).toBeUndefined();
    expect(await t.handle({ repo: 'acme/app', target: 'deploy/dev', after: AFTER }, ctx)).toBeUndefined();
    expect(await t.handle({ repo: 'acme/app', target: 'Deploy/Dev2', after: AFTER }, ctx)).toBeUndefined();
    expect(runJobNow).not.toHaveBeenCalled();
  });

  it('ignores a second payload for the same (job, after) within the dedupe window', async () => {
    addLane();
    const t = trigger();
    await t.handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    const second = await t.handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER.toUpperCase() }, ctx);
    expect(runJobNow).toHaveBeenCalledTimes(1);
    expect(second).toBeUndefined();
  });

  it('fires again for a different merge commit', async () => {
    addLane();
    const t = trigger();
    await t.handle({ repo: 'acme/app', target: 'deploy/dev2', after: 'aaaaaaa' }, ctx);
    await t.handle({ repo: 'acme/app', target: 'deploy/dev2', after: 'bbbbbbb' }, ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('forgets a fired (job, after) once the dedupe window has passed', async () => {
    addLane();
    const t = trigger();
    await t.handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    clock += DEPLOY_LANE_DEDUPE_MS + 1;
    await t.handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(runJobNow).toHaveBeenCalledTimes(2);
  });

  it('is a no-op without a running scheduler', async () => {
    addLane();
    const line = await trigger({ scheduler: null }).handle(
      { repo: 'acme/app', target: 'deploy/dev2', after: AFTER },
      ctx,
    );
    expect(line).toBeUndefined();
    expect(runJobNow).not.toHaveBeenCalled();
  });

  it('does not reply when nothing matched', async () => {
    addLane();
    storage.addJob({
      name: 'plain-cron',
      expression: '0 9 * * *',
      prompt: 'no opt-in',
      owner: 'U_OWNER',
      channel: 'C_QA',
      threadTs: null,
    });
    const line = await trigger().handle({ repo: 'acme/other', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(line).toBeUndefined();
    expect(runJobNow).not.toHaveBeenCalled();
  });

  it('fires every matching job (different owners) and names them all in one line', async () => {
    addLane();
    addLane({ name: 'smoke-lane', owner: 'U_OTHER', channel: 'C_SMOKE', target: 'dm' });
    const line = await trigger().handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(runJobNow).toHaveBeenCalledWith('U_OWNER', 'qa-lane', { triggeredBy: 'U_DEPLOYER' });
    expect(runJobNow).toHaveBeenCalledWith('U_OTHER', 'smoke-lane', { triggeredBy: 'U_DEPLOYER' });
    expect(line).toContain('qa-lane');
    expect(line).toContain('smoke-lane');
    expect(line).toContain('<@U_OTHER>'); // dm target posts to the owner
    expect(line).not.toContain('\n');
  });

  it('reports why nothing fired when the matched job failed to start', async () => {
    addLane();
    runJobNow.mockResolvedValue({ ok: false, message: 'delivery failed (new_thread)' });
    const line = await trigger().handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(line).toContain('qa-lane');
    expect(line).toContain('delivery failed (new_thread)');
    expect(line).toContain('⚠️');
  });

  it('treats a thrown fire as a failure without an unhandled rejection', async () => {
    addLane();
    runJobNow.mockRejectedValue(new Error('boom'));
    const line = await trigger().handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(line).toContain('boom');
  });

  it('does not wait for a lane turn: a fire still running after the settle window counts as started', async () => {
    addLane();
    runJobNow.mockReturnValue(new Promise(() => {})); // the lane turn never ends within the test
    const line = await trigger({ settleMs: 10 }).handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(line).toContain('qa-lane');
    expect(line).not.toContain('⚠️');
  });

  it('keeps going when the cron file is unreadable', async () => {
    fs.writeFileSync(file, '{ not json');
    const line = await trigger().handle({ repo: 'acme/app', target: 'deploy/dev2', after: AFTER }, ctx);
    expect(line).toBeUndefined();
    expect(runJobNow).not.toHaveBeenCalled();
  });
});
