/**
 * RED tests — the owner-facing 3 buttons of the `cron run` permission prompt.
 *
 * Owner-bound: only the job owner may grant. The button carries only a
 * requestId; the request is read back server-side. A grant fires the job
 * through the real scheduler path AS THE OWNER, and "항상 허용" persists the
 * requester on the job's own allowlist so the next ask never happens.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getReq: vi.fn(),
  markHandled: vi.fn(),
  runJobNow: vi.fn().mockResolvedValue({ ok: true, message: 'fired' }),
  isAdmin: vi.fn(() => false),
}));

vi.mock('../../../cron-run-request-store', () => ({
  getCronRunRequest: h.getReq,
  markCronRunRequestHandled: h.markHandled,
}));
vi.mock('../../../cron-scheduler', () => ({
  getActiveCronScheduler: vi.fn(() => ({ runJobNow: h.runJobNow })),
}));
vi.mock('../../../admin-utils', () => ({ isAdminUser: h.isAdmin }));

import {
  VALUE_KIND_CRON_RUN_ALWAYS,
  VALUE_KIND_CRON_RUN_DENY,
  VALUE_KIND_CRON_RUN_ONCE,
} from '../../cron-run-permission-blocks';
import { CronRunPermissionActionHandler } from '../cron-run-permission-action-handler';

let tmpFile: string;
let storage: CronStorage;
let slackApi: any;
let respond: any;
let handler: CronRunPermissionActionHandler;

const baseReq = {
  requestId: 'r1',
  requesterId: 'U_BOB',
  ownerId: 'U_ALICE',
  jobName: 'stage0-daily-deploy-0400kst',
  channel: 'C123',
  threadTs: 'T1',
  handled: false,
};

const body = (kind: string, clicker = 'U_ALICE') => ({
  actions: [{ type: 'button', value: JSON.stringify({ kind, requestId: 'r1' }) }],
  user: { id: clicker },
});

beforeEach(() => {
  vi.clearAllMocks();
  tmpFile = path.join(os.tmpdir(), `cron-run-act-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  storage.addJob({
    name: 'stage0-daily-deploy-0400kst',
    expression: '0 19 * * *',
    prompt: 'deploy',
    owner: 'U_ALICE',
    channel: 'C111',
    threadTs: null,
  });
  slackApi = { postMessage: vi.fn().mockResolvedValue({ ts: 'x' }) };
  respond = vi.fn().mockResolvedValue(undefined);
  handler = new CronRunPermissionActionHandler({ slackApi, storagePath: tmpFile });
  h.getReq.mockReturnValue({ ...baseReq });
  h.runJobNow.mockResolvedValue({ ok: true, message: 'fired' });
});

afterEach(() => {
  for (const f of [tmpFile, tmpFile + '.tmp', tmpFile.replace(/\.json$/, '-history.json')]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
});

describe('CronRunPermissionActionHandler', () => {
  it('once: fires the job as the OWNER without persisting an allowlist entry', async () => {
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_ONCE), respond);
    expect(h.runJobNow).toHaveBeenCalledWith('U_ALICE', 'stage0-daily-deploy-0400kst', { triggeredBy: 'U_BOB' });
    expect(h.markHandled).toHaveBeenCalledWith('r1');
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist ?? []).toEqual([]);
    // The requester learns the outcome in the channel they asked from.
    expect(slackApi.postMessage.mock.calls[0][0]).toBe('C123');
    expect(JSON.stringify(slackApi.postMessage.mock.calls[0])).toContain('U_BOB');
  });

  it('always: persists the requester on the job allowlist and fires the job', async () => {
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_ALWAYS), respond);
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist).toEqual(['U_BOB']);
    expect(h.runJobNow).toHaveBeenCalledWith('U_ALICE', 'stage0-daily-deploy-0400kst', { triggeredBy: 'U_BOB' });
  });

  it('deny: neither grants nor runs, and tells the requester', async () => {
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_DENY), respond);
    expect(h.runJobNow).not.toHaveBeenCalled();
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist ?? []).toEqual([]);
    expect(h.markHandled).toHaveBeenCalledWith('r1');
    expect(slackApi.postMessage).toHaveBeenCalled();
  });

  it('owner-bound: a non-owner clicker cannot grant', async () => {
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_ALWAYS, 'U_MALLORY'), respond);
    expect(h.runJobNow).not.toHaveBeenCalled();
    expect(h.markHandled).not.toHaveBeenCalled();
    expect(JSON.stringify(respond.mock.calls)).toContain('U_ALICE');
  });

  it('replay guard: an already-handled request does nothing', async () => {
    h.getReq.mockReturnValue({ ...baseReq, handled: true });
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_ONCE), respond);
    expect(h.runJobNow).not.toHaveBeenCalled();
  });

  it('expired/unknown request: reports and does not run', async () => {
    h.getReq.mockReturnValue(null);
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_ONCE), respond);
    expect(h.runJobNow).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalled();
  });

  it('job deleted since the ask: marks handled and does not run', async () => {
    storage.removeJob('U_ALICE', 'stage0-daily-deploy-0400kst');
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_ALWAYS), respond);
    expect(h.runJobNow).not.toHaveBeenCalled();
    expect(h.markHandled).toHaveBeenCalledWith('r1');
  });

  it('surfaces a failed fire instead of claiming success', async () => {
    h.runJobNow.mockResolvedValue({ ok: false, message: 'delivery failed' });
    await handler.handleAction(body(VALUE_KIND_CRON_RUN_ONCE), respond);
    expect(JSON.stringify(slackApi.postMessage.mock.calls)).toContain('delivery failed');
  });
});
