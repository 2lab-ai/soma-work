/**
 * T1 (SSOT 2026-10-23) — a cron fire names its session after the job.
 * `resolveCronOrigin` decides whether a skipDispatch event came from a cron
 * fire (structured `cron` field only) and which job; `skipDispatchTitle` is the title the bypass branch gives
 * a fresh session (the job name, or the old literal for every other caller).
 */
import { describe, expect, it } from 'vitest';
import { resolveCronOrigin, SKIP_DISPATCH_TITLE, skipDispatchTitle } from '../cron-origin';

describe('resolveCronOrigin', () => {
  it('reads the structured cron field of a skipDispatch event', () => {
    expect(
      resolveCronOrigin({
        skipDispatch: true,
        cron: { jobId: 'j-1', jobName: 'nightly-qa' },
        text: '[cron:nightly-qa] $full-deploy',
      }),
    ).toEqual({ jobId: 'j-1', jobName: 'nightly-qa' });
  });

  it('reads only the structured field — the [cron:<name>] text prefix alone is not an origin', () => {
    // One path (trinity D2): the injector and the pipeline ship together, so a
    // second, text-parsing path would only drift.
    expect(resolveCronOrigin({ skipDispatch: true, text: '[cron:nightly-report] summarize' })).toBeUndefined();
  });

  it('is undefined for a skipDispatch event that is not a cron fire (auto-resume, goal, incident)', () => {
    expect(resolveCronOrigin({ skipDispatch: true, text: 'Continue where you left off' })).toBeUndefined();
  });

  it('never trusts the prefix without skipDispatch — a user can type [cron:x]', () => {
    expect(resolveCronOrigin({ text: '[cron:fake] hi' })).toBeUndefined();
    expect(resolveCronOrigin({ cron: { jobId: 'j', jobName: 'x' }, text: 'hi' })).toBeUndefined();
  });

  it('ignores a blank job name', () => {
    expect(resolveCronOrigin({ skipDispatch: true, cron: { jobId: 'j', jobName: '  ' }, text: 'x' })).toBeUndefined();
  });
});

describe('skipDispatchTitle', () => {
  it('is the job name for a cron fire', () => {
    expect(skipDispatchTitle({ jobName: 'nightly-qa' })).toBe('nightly-qa');
  });
  it('keeps the old literal for every other bypass', () => {
    expect(skipDispatchTitle(undefined)).toBe(SKIP_DISPATCH_TITLE);
    expect(SKIP_DISPATCH_TITLE).toBe('Direct (skipDispatch)');
  });
});
