import { describe, expect, it } from 'vitest';
import { classifySlackDeliveryError, definitiveRejectionCode } from '../slack-rejection';

const platform = (code: string) => Object.assign(new Error(code), { data: { ok: false, error: code } });

describe('definitiveRejectionCode', () => {
  it('returns the code only for the allow-listed "nothing was created" set, reading data.error only', () => {
    expect(definitiveRejectionCode(platform('not_in_channel'))).toBe('not_in_channel');
    expect(definitiveRejectionCode(platform('queue_overflow'))).toBe('queue_overflow');
    expect(definitiveRejectionCode(platform('ratelimited'))).toBeUndefined();
    expect(definitiveRejectionCode(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBeUndefined();
    expect(definitiveRejectionCode(undefined)).toBeUndefined();
  });
});

describe('classifySlackDeliveryError', () => {
  it('permanent: retrying can never succeed (definitive codes minus queue_overflow, plus update codes)', () => {
    for (const code of [
      'not_in_channel',
      'channel_not_found',
      'invalid_blocks',
      'message_not_found',
      'cant_update_message',
      'is_archived',
      'thread_not_found',
      'msg_too_long',
    ]) {
      expect(classifySlackDeliveryError(platform(code))).toEqual({ kind: 'permanent', code });
    }
  });

  it('transient: definitively not sent but a retry can succeed', () => {
    expect(classifySlackDeliveryError(platform('queue_overflow'))).toEqual({
      kind: 'transient',
      code: 'queue_overflow',
    });
    expect(classifySlackDeliveryError(platform('ratelimited'))).toEqual({ kind: 'transient', code: 'ratelimited' });
  });

  it('unknown: no Slack error code — the message may have been delivered', () => {
    expect(classifySlackDeliveryError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toEqual({
      kind: 'unknown',
    });
    expect(classifySlackDeliveryError(platform('internal_error'))).toEqual({ kind: 'unknown', code: 'internal_error' });
  });
});
