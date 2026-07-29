/**
 * RED tests — `cron run <name>` on ANOTHER user's job.
 *
 * SSOT: "owner가 권한을 허락하면 다른 유저도 즉시 실행 처리할 수 있도록" —
 *   1. non-owner types `cron run <name>`
 *   2. the owner gets a DM asking for permission (skill-permission style)
 *   3. once granted, the job runs with OWNER privilege, and an allowlisted
 *      requester runs it directly next time (no re-ask).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  AVAILABLE_MODELS: [],
  userSettingsStore: {
    resolveModelInput: vi.fn(() => null),
    resolveModelInputWithRefresh: vi.fn(async () => null),
  },
}));

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn((u: string) => u === 'U_ADMIN'),
}));

const runJobNow = vi.fn().mockResolvedValue({ ok: true, message: 'fired' });
vi.mock('../../../cron-scheduler', () => ({
  getActiveCronScheduler: vi.fn(() => ({ runJobNow })),
}));

const createCronRunRequest = vi.fn((input: any) => ({ ...input, requestId: 'req-1', handled: false, reused: false }));
vi.mock('../../../cron-run-request-store', () => ({
  createCronRunRequest: (input: any) => createCronRunRequest(input),
}));

import { CronStorage } from 'somalib/cron/cron-storage';
import type { CommandContext } from '../types';

let tmpFile: string;
let storage: CronStorage;
let handler: any;
let slackApi: { openDmChannel: any; postMessage: any };

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_BOB',
    channel: 'C123',
    threadTs: 'thread123',
    text: '',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

function saidText(ctx: CommandContext): string {
  const calls = (ctx.say as any).mock.calls;
  return calls.map((c: any[]) => `${c[0].text ?? ''}\n${JSON.stringify(c[0].blocks ?? [])}`).join('\n');
}

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `cron-run-perm-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  slackApi = {
    openDmChannel: vi.fn().mockResolvedValue('D_ALICE'),
    postMessage: vi.fn().mockResolvedValue({ ts: '1.1' }),
  };
  const { CronCommandHandler } = await import('../cron-handler');
  handler = new CronCommandHandler(tmpFile, { slackApi: slackApi as any });
  runJobNow.mockClear();
  createCronRunRequest.mockClear();
});

afterEach(() => {
  for (const f of [tmpFile, tmpFile + '.tmp', tmpFile.replace(/\.json$/, '-history.json')]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  vi.clearAllMocks();
});

function seedAliceJob(over: Record<string, any> = {}) {
  return storage.addJob({
    name: 'stage0-daily-deploy-0400kst',
    expression: '0 19 * * *',
    prompt: 'deploy stage0',
    owner: 'U_ALICE',
    channel: 'C111',
    threadTs: null,
    ...over,
  });
}

describe('cron run — cross-user permission request', () => {
  it('does not run, and DMs the owner a permission prompt', async () => {
    seedAliceJob();
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);

    expect(runJobNow).not.toHaveBeenCalled();
    expect(createCronRunRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterId: 'U_BOB',
        ownerId: 'U_ALICE',
        jobName: 'stage0-daily-deploy-0400kst',
        channel: 'C123',
      }),
    );
    expect(slackApi.openDmChannel).toHaveBeenCalledWith('U_ALICE');
    const dm = slackApi.postMessage.mock.calls[0];
    expect(dm[0]).toBe('D_ALICE');
    expect(JSON.stringify(dm[2].blocks)).toContain('cron_run_perm_');
    expect(saidText(ctx)).toContain('권한');
  });

  it('falls back to an in-thread prompt when the DM fails', async () => {
    seedAliceJob();
    slackApi.openDmChannel.mockRejectedValueOnce(new Error('cannot_dm_bot'));
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);

    expect(runJobNow).not.toHaveBeenCalled();
    expect(saidText(ctx)).toContain('cron_run_perm_');
  });

  it('runs with OWNER privilege when the requester is on the job allowlist', async () => {
    seedAliceJob({ runAllowlist: ['U_BOB'] });
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);

    expect(runJobNow).toHaveBeenCalledWith('U_ALICE', 'stage0-daily-deploy-0400kst', { triggeredBy: 'U_BOB' });
    expect(createCronRunRequest).not.toHaveBeenCalled();
    expect(saidText(ctx)).toContain('실행 트리거');
  });

  it('an allowlist entry for a DIFFERENT user does not leak access', async () => {
    seedAliceJob({ runAllowlist: ['U_CAROL'] });
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(createCronRunRequest).toHaveBeenCalled();
  });

  it('the owner still runs their own job directly', async () => {
    seedAliceJob();
    const ctx = makeCtx({ user: 'U_ALICE', text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);
    expect(runJobNow).toHaveBeenCalledWith('U_ALICE', 'stage0-daily-deploy-0400kst', { triggeredBy: 'U_ALICE' });
    expect(createCronRunRequest).not.toHaveBeenCalled();
  });

  it('admin still runs any job directly — no permission round-trip', async () => {
    seedAliceJob();
    const ctx = makeCtx({ user: 'U_ADMIN', text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);
    expect(runJobNow).toHaveBeenCalledWith('U_ALICE', 'stage0-daily-deploy-0400kst', { triggeredBy: 'U_ADMIN' });
    expect(createCronRunRequest).not.toHaveBeenCalled();
  });

  it('asks for an explicit owner when the job name exists for several owners', async () => {
    seedAliceJob();
    seedAliceJob({ owner: 'U_CAROL' });
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);
    expect(createCronRunRequest).not.toHaveBeenCalled();
    expect(saidText(ctx)).toContain('<@owner>');
  });

  it('routes an explicit owner argument to that owner', async () => {
    seedAliceJob();
    seedAliceJob({ owner: 'U_CAROL' });
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst <@U_CAROL>' });
    await handler.execute(ctx);
    expect(createCronRunRequest).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'U_CAROL' }));
  });

  it('a repeated ask does not send the owner a second DM', async () => {
    seedAliceJob();
    createCronRunRequest.mockImplementationOnce((input: any) => ({
      ...input,
      requestId: 'req-1',
      handled: false,
      reused: true,
    }));
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);
    expect(slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(slackApi.postMessage).not.toHaveBeenCalled();
    expect(saidText(ctx)).toContain('대기 중');
  });

  it('fires with owner identity but records WHO pulled the trigger', async () => {
    seedAliceJob({ runAllowlist: ['U_BOB'] });
    await handler.execute(makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' }));
    expect(runJobNow).toHaveBeenCalledWith('U_ALICE', 'stage0-daily-deploy-0400kst', { triggeredBy: 'U_BOB' });
  });

  it('does not leak the owner list of colliding job names to a stranger', async () => {
    seedAliceJob();
    seedAliceJob({ owner: 'U_CAROL' });
    const ctx = makeCtx({ text: 'cron run stage0-daily-deploy-0400kst' });
    await handler.execute(ctx);
    const said = saidText(ctx);
    expect(said).toContain('<@owner>');
    expect(said).not.toContain('U_CAROL');
    expect(said).not.toContain('U_ALICE');
  });

  it('still reports not-found when no owner has the job', async () => {
    const ctx = makeCtx({ text: 'cron run ghost-job' });
    await handler.execute(ctx);
    expect(createCronRunRequest).not.toHaveBeenCalled();
    expect(saidText(ctx)).toContain('찾을 수 없습니다');
  });
});
