/** A cron job an environment user owns: an admin decides, and the job still fires as its owner. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getReq: vi.fn(),
  markHandled: vi.fn(),
  runJobNow: vi.fn().mockResolvedValue({ ok: true, message: 'fired' }),
}));
vi.mock('../../../cron-run-request-store', () => ({
  getCronRunRequest: h.getReq,
  markCronRunRequestHandled: h.markHandled,
}));
vi.mock('../../../cron-scheduler', () => ({ getActiveCronScheduler: vi.fn(() => ({ runJobNow: h.runJobNow })) }));
vi.mock('../../../admin-utils', () => ({ getAdminUsers: () => new Set(['UADMIN']) }));
vi.mock('../../../env-users', () => ({ isEnvironmentUser: (u: string) => u === 'env:acme-stage0' }));

import { VALUE_KIND_CRON_RUN_ONCE } from '../../cron-run-permission-blocks';
import { CronRunPermissionActionHandler } from '../cron-run-permission-action-handler';

let tmpFile: string;
let respond: any;
let handler: CronRunPermissionActionHandler;
const req: Record<string, any> = {
  requestId: 'r1',
  requesterId: 'U_BOB',
  ownerId: 'env:acme-stage0',
  jobId: '',
  jobName: 'stage0-daily-deploy',
  channel: 'C123',
  threadTs: 'T1',
  handled: false,
};
const body = (clicker: string) => ({
  actions: [{ type: 'button', value: JSON.stringify({ kind: VALUE_KIND_CRON_RUN_ONCE, requestId: 'r1' }) }],
  user: { id: clicker },
});

beforeEach(() => {
  vi.clearAllMocks();
  tmpFile = path.join(os.tmpdir(), `cron-run-env-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const storage = new CronStorage(tmpFile);
  req.jobId = storage.addJob({
    name: 'stage0-daily-deploy',
    expression: '0 19 * * *',
    prompt: '$full-deploy-stage',
    owner: 'env:acme-stage0',
    channel: 'C111',
    threadTs: null,
  }).id;
  respond = vi.fn().mockResolvedValue(undefined);
  handler = new CronRunPermissionActionHandler({
    slackApi: { postMessage: vi.fn().mockResolvedValue({ ts: 'x' }) } as any,
    storagePath: tmpFile,
  });
  h.getReq.mockReturnValue({ ...req });
});

afterEach(() => {
  for (const f of [tmpFile, `${tmpFile}.tmp`, tmpFile.replace(/\.json$/, '-history.json')])
    fs.rmSync(f, { force: true });
});

describe('CronRunPermissionActionHandler — environment user owner', () => {
  it('an admin approves and the job fires as the environment user', async () => {
    await handler.handleAction(body('UADMIN'), respond);
    expect(h.runJobNow).toHaveBeenCalledWith('env:acme-stage0', 'stage0-daily-deploy', { triggeredBy: 'U_BOB' });
  });

  it('a non-admin cannot approve', async () => {
    await handler.handleAction(body('U_BOB'), respond);
    expect(h.runJobNow).not.toHaveBeenCalled();
    expect(JSON.stringify(respond.mock.calls)).toContain('어드민');
  });
});
