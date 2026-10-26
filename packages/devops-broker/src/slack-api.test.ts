import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSlackApi, type SlackApi, SlackApiError } from './slack-api.js';

// The broker app's Slack Web API client (.prd/16-devops-tools-architecture.md §5) against a local fake
// (`__fixtures__/fake-slack.cjs`). The token rides only in the Authorization header and never shows up in
// an error.

interface FakeRequest {
  method: string;
  params: Record<string, unknown>;
  auth: string | undefined;
  contentType: string | undefined;
  at: number;
}
interface FakeSlack {
  apiBase: string;
  requests: FakeRequest[];
  calls(method: string): FakeRequest[];
  enqueue(
    method: string,
    response: { status?: number; headers?: Record<string, string>; body?: unknown },
    when?: (params: Record<string, unknown>) => boolean,
  ): void;
  react(channel: string, ts: string, name: string, user: string): void;
  close(): Promise<void>;
}
const { startFakeSlack } = createRequire(__filename)('./__fixtures__/fake-slack.cjs') as {
  startFakeSlack(opts: { token: string }): Promise<FakeSlack>;
};

// Assembled at load time so no token-shaped literal sits in the file.
const TOKEN = ['xoxb', 'fake', 'broker', 'app', 'not', 'real'].join('-');

let fake: FakeSlack;
let slack: SlackApi;

beforeEach(async () => {
  fake = await startFakeSlack({ token: TOKEN });
  slack = createSlackApi({ token: TOKEN, apiBase: fake.apiBase });
});
afterEach(async () => {
  await fake.close();
});

async function caught(promise: Promise<unknown>): Promise<SlackApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SlackApiError);
    return err as SlackApiError;
  }
  throw new Error('expected a SlackApiError');
}

function expectNoToken(err: unknown): void {
  const e = err as Error;
  for (const text of [e.message, String(e), e.stack ?? '', JSON.stringify(e)]) {
    expect(text).not.toContain(TOKEN);
  }
}

describe('createSlackApi', () => {
  it('opens a DM with a bearer token and returns the channel id', async () => {
    await expect(slack.openDm('U000ADMIN')).resolves.toBe('D000ADMIN');
    const [call] = fake.calls('conversations.open');
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    expect(call.params).toMatchObject({ users: 'U000ADMIN' });
    expect(JSON.stringify(call.params)).not.toContain(TOKEN);
  });

  it('posts a message as JSON with blocks and an optional thread', async () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'card' } }];
    const { ts } = await slack.postMessage('D000ADMIN', { text: 'fallback', blocks });
    expect(ts).toMatch(/^\d+\.\d+$/);
    await slack.postMessage('D000ADMIN', { text: 'reply', threadTs: ts });
    const [first, second] = fake.calls('chat.postMessage');
    expect(first.contentType).toMatch(/^application\/json/);
    expect(first.params).toEqual({ channel: 'D000ADMIN', text: 'fallback', blocks });
    expect(second.params).toEqual({ channel: 'D000ADMIN', text: 'reply', thread_ts: ts });
  });

  it('updates a message in place', async () => {
    const { ts } = await slack.postMessage('D000ADMIN', { text: 'before' });
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'after' } }];
    await slack.updateMessage('D000ADMIN', ts, { text: 'after', blocks });
    expect(fake.calls('chat.update')[0].params).toEqual({ channel: 'D000ADMIN', ts, text: 'after', blocks });
  });

  it('always asks reactions.get for the full user list', async () => {
    const { ts } = await slack.postMessage('D000ADMIN', { text: 'card' });
    await expect(slack.getReactions('D000ADMIN', ts)).resolves.toEqual([]);
    fake.react('D000ADMIN', ts, 'white_check_mark', 'U000OTHER');
    fake.react('D000ADMIN', ts, 'white_check_mark', 'U000ADMIN');
    fake.react('D000ADMIN', ts, 'x', 'U000OTHER');
    await expect(slack.getReactions('D000ADMIN', ts)).resolves.toEqual([
      { name: 'white_check_mark', users: ['U000OTHER', 'U000ADMIN'] },
      { name: 'x', users: ['U000OTHER'] },
    ]);
    const calls = fake.calls('reactions.get');
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.params).toMatchObject({ channel: 'D000ADMIN', timestamp: ts, full: 'true' });
  });

  it('turns ok:false into SlackApiError with the Slack error code', async () => {
    fake.enqueue('chat.postMessage', { body: { ok: false, error: 'channel_not_found' } });
    const err = await caught(slack.postMessage('D000ADMIN', { text: 'x' }));
    expect(err.code).toBe('channel_not_found');
    expect(err.retryAfterSeconds).toBeUndefined();
    expectNoToken(err);
  });

  it('turns HTTP 429 into ratelimited with the Retry-After seconds', async () => {
    fake.enqueue('reactions.get', {
      status: 429,
      headers: { 'Retry-After': '7' },
      body: { ok: false, error: 'ratelimited' },
    });
    const err = await caught(slack.getReactions('D000ADMIN', '1700000000.000001'));
    expect(err.code).toBe('ratelimited');
    expect(err.retryAfterSeconds).toBe(7);
    expectNoToken(err);
  });

  it('keeps ok:false ratelimited with a Retry-After header as ratelimited', async () => {
    fake.enqueue('reactions.get', { headers: { 'Retry-After': '3' }, body: { ok: false, error: 'ratelimited' } });
    const err = await caught(slack.getReactions('D000ADMIN', '1700000000.000001'));
    expect(err.code).toBe('ratelimited');
    expect(err.retryAfterSeconds).toBe(3);
  });

  it('turns an HTTP 500 into an http error code', async () => {
    fake.enqueue('reactions.get', { status: 500, body: 'oops' });
    const err = await caught(slack.getReactions('D000ADMIN', '1700000000.000001'));
    expect(err.code).toBe('http_500');
    expectNoToken(err);
  });

  it('rejects a body that is not JSON', async () => {
    fake.enqueue('conversations.open', { body: 'not json' });
    const err = await caught(slack.openDm('U000ADMIN'));
    expect(err.code).toBe('invalid_response');
  });

  it('rejects a success answer missing the field it needs', async () => {
    fake.enqueue('conversations.open', { body: { ok: true } });
    expect((await caught(slack.openDm('U000ADMIN'))).code).toBe('invalid_response');
    fake.enqueue('chat.postMessage', { body: { ok: true, channel: 'D000ADMIN' } });
    expect((await caught(slack.postMessage('D000ADMIN', { text: 'x' }))).code).toBe('invalid_response');
  });

  it('never echoes a Slack error string it does not recognise as a code', async () => {
    fake.enqueue('chat.update', { body: { ok: false, error: `bad ${TOKEN} <@U1>` } });
    const err = await caught(slack.updateMessage('D000ADMIN', '1700000000.000001', { text: 'x' }));
    expect(err.code).toBe('unknown_error');
    expectNoToken(err);
  });

  it('maps a refused connection to network_error without the token', async () => {
    await fake.close();
    const err = await caught(slack.openDm('U000ADMIN'));
    expect(err.code).toBe('network_error');
    expectNoToken(err);
    fake = await startFakeSlack({ token: TOKEN });
  });

  it('accepts an apiBase with a trailing slash', async () => {
    const withSlash = createSlackApi({ token: TOKEN, apiBase: `${fake.apiBase}/` });
    await expect(withSlash.openDm('U000ADMIN')).resolves.toBe('D000ADMIN');
    expect(fake.calls('conversations.open')).toHaveLength(1);
  });

  it('uses the injected fetch and the real Slack base by default', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true, channel: { id: 'D1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await createSlackApi({ token: TOKEN, fetchImpl }).openDm('U000ADMIN');
    expect(urls).toEqual(['https://slack.com/api/conversations.open']);
  });
});

describe('install/slack-app-manifest.json', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'install', 'slack-app-manifest.json'), 'utf8'),
  ) as Record<string, Record<string, unknown>>;

  it('asks for exactly chat:write, im:write and reactions:read as bot scopes, and no user scopes', () => {
    const scopes = manifest.oauth_config.scopes as Record<string, string[]>;
    expect([...scopes.bot].sort()).toEqual(['chat:write', 'im:write', 'reactions:read']);
    expect(Object.keys(scopes)).toEqual(['bot']);
  });

  it('has no event subscriptions, interactivity, socket mode or slash commands', () => {
    const settings = manifest.settings;
    expect(settings.event_subscriptions).toBeUndefined();
    expect(settings.interactivity).toEqual({ is_enabled: false });
    expect(settings.socket_mode_enabled).toBe(false);
    expect(manifest.features.slash_commands).toBeUndefined();
    expect(manifest.features.shortcuts).toBeUndefined();
    expect(Object.keys(manifest.features)).toEqual(['bot_user']);
  });
});
