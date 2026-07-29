/**
 * RED tests — the ▶ card button, clicked by a NON-owner.
 *
 * The cron card is posted in a channel, so anyone can click ▶ on someone
 * else's job. Same contract as the `cron run` command: allowlisted → fire as
 * the owner; otherwise DM the owner for permission instead of a flat reject.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { CronActionHandler } from '../cron-action-handler';

let tmpFile: string;
let storage: CronStorage;
let handler: CronActionHandler;
let slackApi: any;
let respond: any;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `cron-act-run-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  storage.addJob({
    name: 'daily-report',
    expression: '0 9 * * 1-5',
    prompt: 'morning report',
    owner: 'U_ALICE',
    channel: 'C111',
    threadTs: null,
  });
  slackApi = {
    updateMessage: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue({ ts: 'x' }),
    openDmChannel: vi.fn().mockResolvedValue('D_ALICE'),
  };
  respond = vi.fn().mockResolvedValue(undefined);
  handler = new CronActionHandler({ slackApi, storagePath: tmpFile });
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

function runBody(user: string) {
  return {
    user: { id: user },
    channel: { id: 'C_CARD' },
    message: { ts: '111.222' },
    actions: [{ action_id: 'cron_run::U_ALICE::daily-report', type: 'button' }],
  };
}

describe('▶ run button — non-owner', () => {
  it('asks the owner by DM instead of rejecting', async () => {
    await handler.handleAction(runBody('U_BOB'), respond);
    expect(runJobNow).not.toHaveBeenCalled();
    expect(createCronRunRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requesterId: 'U_BOB', ownerId: 'U_ALICE', jobName: 'daily-report' }),
    );
    expect(slackApi.openDmChannel).toHaveBeenCalledWith('U_ALICE');
    expect(JSON.stringify(slackApi.postMessage.mock.calls)).toContain('cron_run_perm_');
    expect(JSON.stringify(respond.mock.calls)).toContain('권한');
  });

  it('fires as the owner once allowlisted', async () => {
    storage.allowRun('U_ALICE', 'daily-report', 'U_BOB');
    await handler.handleAction(runBody('U_BOB'), respond);
    expect(runJobNow).toHaveBeenCalledWith('U_ALICE', 'daily-report', { triggeredBy: 'U_BOB' });
    expect(createCronRunRequest).not.toHaveBeenCalled();
  });

  it('non-run actions from a non-owner are still rejected outright', async () => {
    const body = {
      user: { id: 'U_BOB' },
      channel: { id: 'C_CARD' },
      message: { ts: '111.222' },
      actions: [{ action_id: 'cron_delete::U_ALICE::daily-report', type: 'button' }],
    };
    await handler.handleAction(body, respond);
    expect(storage.getJobsByOwner('U_ALICE')).toHaveLength(1);
    expect(createCronRunRequest).not.toHaveBeenCalled();
  });
});
