/**
 * RED tests — the per-job run allowlist that lives ON the cron job itself.
 *
 * SSOT: "해당 cron task에 allowlist가 있음" — the grant belongs to the job, so a
 * rename carries it and a delete disposes of it. `isRunAllowed` is the single
 * authority both the `cron run` command and the ▶ card button consult.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CronStorage, isRunAllowed } from 'somalib/cron/cron-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpFile: string;
let storage: CronStorage;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `cron-allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  storage = new CronStorage(tmpFile);
  storage.addJob({
    name: 'deploy',
    expression: '0 19 * * *',
    prompt: 'p',
    owner: 'U_ALICE',
    channel: 'C1',
    threadTs: null,
  });
});

afterEach(() => {
  for (const f of [tmpFile, tmpFile + '.tmp']) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
});

describe('cron run allowlist', () => {
  it('owner is always allowed; a stranger is not', () => {
    const job = storage.getJobsByOwner('U_ALICE')[0];
    expect(isRunAllowed(job, 'U_ALICE')).toBe(true);
    expect(isRunAllowed(job, 'U_BOB')).toBe(false);
  });

  it('allowRun persists the user and is idempotent', () => {
    expect(storage.allowRun('U_ALICE', 'deploy', 'U_BOB')?.runAllowlist).toEqual(['U_BOB']);
    storage.allowRun('U_ALICE', 'deploy', 'U_BOB');
    const job = storage.getJobsByOwner('U_ALICE')[0];
    expect(job.runAllowlist).toEqual(['U_BOB']);
    expect(isRunAllowed(job, 'U_BOB')).toBe(true);
  });

  it('allowRun on a missing job returns null', () => {
    expect(storage.allowRun('U_ALICE', 'ghost', 'U_BOB')).toBeNull();
  });

  it('the allowlist survives a rename and dies with the job', () => {
    storage.allowRun('U_ALICE', 'deploy', 'U_BOB');
    storage.updateJob('U_ALICE', 'deploy', { name: 'deploy2' });
    expect(storage.getJobsByOwner('U_ALICE')[0].runAllowlist).toEqual(['U_BOB']);
    storage.removeJob('U_ALICE', 'deploy2');
    expect(storage.getJobsByOwner('U_ALICE')).toHaveLength(0);
  });

  it('updateJob can clear the allowlist with null', () => {
    storage.allowRun('U_ALICE', 'deploy', 'U_BOB');
    const updated = storage.updateJob('U_ALICE', 'deploy', { runAllowlist: null });
    expect(updated?.runAllowlist).toBeUndefined();
  });
});
