/**
 * RED tests for the pending `cron run` permission-request store.
 *
 * A non-owner asking to fire someone else's cron job records a request here and
 * the owner gets a DM with buttons. The buttons carry ONLY a requestId; the
 * authoritative data (requester, owner, job, channel) is read back server-side
 * so a forged/replayed payload cannot fabricate a grant. Mirrors
 * `skill-permission-request-store` (same threat model, cron resource).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return tempDir;
  },
  IS_DEV: true,
}));

vi.mock('../logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

describe('cron-run-request-store', () => {
  let store: typeof import('../cron-run-request-store');

  const base = {
    requesterId: 'U_BOB',
    ownerId: 'U_ALICE',
    jobId: 'job-1',
    jobName: 'stage0-daily-deploy-0400kst',
    channel: 'C1',
    threadTs: '171.1',
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-cronreq-'));
    vi.resetModules();
    store = await import('../cron-run-request-store');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('persists a created request and reads it back by id', () => {
    const req = store.createCronRunRequest(base);
    expect(req.requestId).toBeTruthy();
    expect(req.handled).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'cron-run-requests.json'))).toBe(true);

    const read = store.getCronRunRequest(req.requestId);
    expect(read).toMatchObject({
      requesterId: 'U_BOB',
      ownerId: 'U_ALICE',
      jobName: 'stage0-daily-deploy-0400kst',
      channel: 'C1',
      threadTs: '171.1',
    });
  });

  it('dedupes an unhandled live request for the same (owner, job, requester)', () => {
    const a = store.createCronRunRequest(base);
    const b = store.createCronRunRequest(base);
    expect(b.requestId).toBe(a.requestId);
  });

  it('does not dedupe across different jobs', () => {
    const a = store.createCronRunRequest(base);
    const b = store.createCronRunRequest({ ...base, jobId: 'job-2', jobName: 'other-job' });
    expect(b.requestId).not.toBe(a.requestId);
  });

  // Consent is bound to the job identity, not to the name it had at ask time.
  it('dedupes on job id even after the job was renamed', () => {
    const a = store.createCronRunRequest(base);
    const b = store.createCronRunRequest({ ...base, jobName: 'renamed' });
    expect(b.requestId).toBe(a.requestId);
  });

  it('marks a request handled — replay guard', () => {
    const req = store.createCronRunRequest(base);
    store.markCronRunRequestHandled(req.requestId);
    expect(store.getCronRunRequest(req.requestId)?.handled).toBe(true);

    // A handled request no longer dedupes — a fresh ask creates a new request.
    const again = store.createCronRunRequest(base);
    expect(again.requestId).not.toBe(req.requestId);
  });

  it('returns null for an expired request', () => {
    const req = store.createCronRunRequest({ ...base, ttlMs: -1 });
    expect(store.getCronRunRequest(req.requestId)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(store.getCronRunRequest('nope')).toBeNull();
  });
});

describe('cron-run-request-store — re-ask behaviour (review fixes)', () => {
  let store: typeof import('../cron-run-request-store');

  const base = {
    requesterId: 'U_BOB',
    ownerId: 'U_ALICE',
    jobId: 'job-1',
    jobName: 'deploy',
    channel: 'C1',
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-cronreq2-'));
    vi.resetModules();
    store = await import('../cron-run-request-store');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('flags a reused request so the caller does not re-DM the owner', () => {
    expect(store.createCronRunRequest(base).reused).toBe(false);
    expect(store.createCronRunRequest(base).reused).toBe(true);
  });

  it('a reused request follows the requester to where they last asked', () => {
    const first = store.createCronRunRequest({ ...base, channel: 'C_OLD', threadTs: 'T_OLD' });
    const again = store.createCronRunRequest({ ...base, channel: 'C_NEW', threadTs: 'T_NEW' });
    expect(again.requestId).toBe(first.requestId);
    expect(again.channel).toBe('C_NEW');
    expect(again.threadTs).toBe('T_NEW');
    // …and the refresh is persisted, not just returned.
    expect(store.getCronRunRequest(first.requestId)).toMatchObject({ channel: 'C_NEW', threadTs: 'T_NEW' });
  });
});
