import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock('../../logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = logWarn;
    debug = vi.fn();
    error = vi.fn();
  },
}));

import { slackDirectoryLookup } from '../slack-directory-lookup';

type LookupResponse = Awaited<ReturnType<Parameters<typeof slackDirectoryLookup>[0]>>;

/** A Slack Web API platform error as `@slack/web-api` throws it. */
function platformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code, response_metadata: { detail: 'payload-marker' } },
  });
}

describe('slackDirectoryLookup', () => {
  beforeEach(() => {
    logWarn.mockClear();
  });

  it('passes the email through and returns the Slack user', async () => {
    const lookupByEmail = vi.fn(async () => ({
      ok: true,
      user: { id: 'U_D', name: 'dana', real_name: 'Dana Real', profile: { display_name: 'Dana' } },
    }));
    const lookup = slackDirectoryLookup(lookupByEmail);

    expect(await lookup('dana@x.com')).toEqual({ userId: 'U_D', name: 'Dana' });
    expect(lookupByEmail).toHaveBeenCalledWith({ email: 'dana@x.com' });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it.each([
    ['display_name', { name: 'dana', real_name: 'Dana Real', profile: { display_name: 'Dana' } }, 'Dana'],
    [
      'real_name when display_name is empty',
      { name: 'dana', real_name: 'Dana Real', profile: { display_name: '' } },
      'Dana Real',
    ],
    ['name when there is no real_name', { name: 'dana', profile: {} }, 'dana'],
    ['the user id when nothing else is set', {}, 'U_D'],
  ])('names the user by %s', async (_label, fields, expected) => {
    const lookup = slackDirectoryLookup(async () => ({ ok: true, user: { id: 'U_D', ...fields } }));
    expect(await lookup('dana@x.com')).toEqual({ userId: 'U_D', name: expected });
  });

  it.each<[string, LookupResponse]>([
    ['no user in the response', {}],
    ['a deactivated user', { user: { id: 'U_D', deleted: true } }],
    ['a bot user', { user: { id: 'U_B', is_bot: true } }],
    ['a user without an id', { user: { name: 'dana' } }],
  ])('returns null for %s', async (_label, response) => {
    const lookup = slackDirectoryLookup(async () => response);
    expect(await lookup('dana@x.com')).toBeNull();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('users_not_found → null without a warning', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw platformError('users_not_found');
    });
    expect(await lookup('nobody@x.com')).toBeNull();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('missing_scope → null with one warning naming users:read.email', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw platformError('missing_scope');
    });
    expect(await lookup('dana@x.com')).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(String(logWarn.mock.calls[0][0])).toContain('users:read.email');
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('payload-marker');
  });

  it('any other platform error → null with a warning carrying only the code', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw platformError('ratelimited');
    });
    expect(await lookup('dana@x.com')).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(expect.any(String), { error: 'ratelimited' });
  });

  it('a non-platform error → null with a warning carrying only its code', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw Object.assign(new Error('socket hang up near payload-marker'), { code: 'slack_webapi_request_error' });
    });
    expect(await lookup('dana@x.com')).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(expect.any(String), { error: 'slack_webapi_request_error' });
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('payload-marker');
  });

  it('an error with no code at all → null with a warning carrying "unknown"', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw 'payload-marker';
    });
    expect(await lookup('dana@x.com')).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(expect.any(String), { error: 'unknown' });
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('payload-marker');
  });
});
