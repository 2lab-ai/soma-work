import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { LogLevel, WebClient } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock('../../logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = logWarn;
    debug = vi.fn();
    error = vi.fn();
  },
}));

import { DirectoryLookupMisconfigured } from '../oauth';
import { createSlackDirectoryLookup, slackDirectoryLookup } from '../slack-directory-lookup';

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

  // A missing scope is not "no such account" and retrying will not help: it is
  // a setup error only an admin can fix.
  it('missing_scope → rejects as misconfigured, with one warning naming users:read.email', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw platformError('missing_scope');
    });
    await expect(lookup('dana@x.com')).rejects.toBeInstanceOf(DirectoryLookupMisconfigured);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(String(logWarn.mock.calls[0][0])).toContain('users:read.email');
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('payload-marker');
  });

  // Anything but "no such user" or a missing scope says nothing about the
  // account, so it rejects: the login then reports Slack as unavailable instead
  // of "no matching account". The rejection carries the Slack code only; the
  // caller logs it.
  it('any other platform error → rejects with only the code', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw platformError('ratelimited');
    });
    await expect(lookup('dana@x.com')).rejects.toThrow(/^ratelimited$/);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('a non-platform error → rejects with only its code', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw Object.assign(new Error('socket hang up near payload-marker'), { code: 'slack_webapi_request_error' });
    });
    const error = await lookup('dana@x.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('slack_webapi_request_error');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('payload-marker');
  });

  it('an error with no code at all → rejects with "unknown"', async () => {
    const lookup = slackDirectoryLookup(async () => {
      throw 'payload-marker';
    });
    await expect(lookup('dana@x.com')).rejects.toThrow(/^unknown$/);
  });
});

/**
 * A local stand-in for the Slack Web API. Methods in `limited` answer 429 with
 * that Retry-After (seconds); every other method answers at once.
 */
async function startFakeSlack(
  limited: Record<string, number>,
): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const method = (req.url || '').split('?')[0].replace(/^\/api\//, '');
    seen.push(method);
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (method in limited) {
        res.statusCode = 429;
        res.setHeader('retry-after', String(limited[method]));
        res.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
        return;
      }
      res.end(JSON.stringify({ ok: true, user: { id: 'U_D', name: 'dana' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Resolves true when `promise` settles within `ms`, false otherwise. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

// The bot's shared WebClient pauses its whole request queue for Retry-After
// whenever any method is rate limited. Busy threads rate-limit chat.update
// often, so a login lookup on that client waited out the pause (10 s), passed
// the 5 s login timeout and failed. The login therefore gets its own client.
describe('createSlackDirectoryLookup (dedicated client)', () => {
  let slack: Awaited<ReturnType<typeof startFakeSlack>> | null = null;

  afterEach(async () => {
    await slack?.close();
    slack = null;
  });

  it('answers while the shared client is paused by another method’s 429', async () => {
    slack = await startFakeSlack({ 'chat.update': 3 });
    const shared = new WebClient('xoxb-test', {
      slackApiUrl: slack.url,
      retryConfig: { retries: 0 },
      logLevel: LogLevel.ERROR,
    });
    const update = shared.chat.update({ channel: 'C1', ts: '1.0', text: 'x' }).catch(() => undefined);
    await vi.waitFor(() => expect(slack?.seen).toContain('chat.update'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The incident: a lookup on the shared client is stuck behind the pause.
    const sharedLookup = shared.users.lookupByEmail({ email: 'dana@x.com' });
    expect(await settlesWithin(sharedLookup, 800)).toBe(false);

    // The fix: the dedicated client is not.
    const lookup = createSlackDirectoryLookup('xoxb-test', { slackApiUrl: slack.url });
    const dedicated = lookup('dana@x.com');
    expect(await settlesWithin(dedicated, 800)).toBe(true);
    expect(await dedicated).toEqual({ userId: 'U_D', name: 'dana' });

    await update;
    await sharedLookup;
  });

  it('is what the server wires for the login, not the bot client', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf8');
    expect(source).toContain('setOAuthDirectoryLookup(createSlackDirectoryLookup(config.slack.botToken))');
    expect(source).not.toMatch(/app\.client\.users\.lookupByEmail/);
  });

  it('fails fast on its own 429 instead of waiting out Retry-After', async () => {
    slack = await startFakeSlack({ 'users.lookupByEmail': 30 });
    const lookup = createSlackDirectoryLookup('xoxb-test', { slackApiUrl: slack.url });
    const pending = lookup('dana@x.com');
    expect(await settlesWithin(pending, 1000)).toBe(true);
    await expect(pending).rejects.toThrow(/rate_limited/);
  });
});
