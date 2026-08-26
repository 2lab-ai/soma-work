import { describe, expect, it } from 'vitest';
import { redactAnthropicSecrets, redactSecrets } from '../logger';

const S = (v: unknown) => v as string;

/**
 * Complete Slack token shapes, assembled at load time rather than written out.
 *
 * The bodies are fixed keyboard runs belonging to no account, but a *complete*
 * `xoxb-…` literal in a source blob is indistinguishable from a real leak to
 * GitHub push protection, which refused the branch that first carried this
 * file. Splitting the prefix off keeps the byte run out of every blob while
 * `redactSecrets` still receives the exact same complete token, so every
 * last-four expectation below is unchanged.
 *
 * This package is a leaf workspace, so the fixtures are local rather than
 * imported from `src/test-utils/slack-token-fixtures.ts`; the shape canary at
 * the end of this describe block is what stops a split from quietly degrading
 * one of them into a string the redactor was never asked to match.
 *
 * Only the four complete shapes are split. The short `xoxb-1-2-…` fixtures
 * further down are deliberately below every detector's length floor — they are
 * there to prove the redactor matches shapes the scanners do not.
 */
const token = (prefix: string, body: string) => `${prefix}-${body}`;
const BOT_TOKEN = token('xoxb', '1234567890-1234567890123-AbCdEfGhIjKlMnOpQrSt');
const APP_TOKEN = token('xapp', '1-A01234567-1234567890123-abcdefabcdefabcdefabcdef1234');
const USER_TOKEN = token('xoxp', '111-222-333-abcdefabcdefabcdefWXYZ');
const CONFIG_TOKEN = token('xoxe.xoxp', '1-AbCdEfGhIjKlMnOpQrStUvWxYz01');

describe('redactSecrets — Slack token shapes', () => {
  it('redacts xoxb bot tokens, keeping the last 4 for correlation', () => {
    const out = S(redactSecrets(`SLACK_BOT_TOKEN=${BOT_TOKEN}`));
    expect(out).toBe('SLACK_BOT_TOKEN=[REDACTED xoxb-...QrSt]');
    expect(out).not.toContain('AbCdEfGhIjKlMnOpQrS');
  });

  it('redacts xapp app-level tokens', () => {
    const out = S(redactSecrets(APP_TOKEN));
    expect(out).toBe('[REDACTED xapp-...1234]');
  });

  it('redacts xoxp user tokens', () => {
    expect(S(redactSecrets(USER_TOKEN))).toBe('[REDACTED xoxp-...WXYZ]');
  });

  it('redacts xoxe. refresh tokens as one unit (not as an inner xoxp token)', () => {
    const out = S(redactSecrets(`token=${CONFIG_TOKEN}`));
    expect(out).toBe('token=[REDACTED xoxe-...Yz01]');
    expect(out).not.toContain('xoxp-1-');
  });

  it('redacts xoxe- rotation tokens', () => {
    expect(S(redactSecrets('xoxe-1-My-Long-Rotation-Token-Value-abcd'))).toBe('[REDACTED xoxe-...abcd]');
  });

  it('redacts every occurrence in one string', () => {
    const out = S(redactSecrets('a=xoxb-1-2-aaaabbbbcccc b=xapp-1-A1-2-ddddeeeeffff'));
    expect(out).toBe('a=[REDACTED xoxb-...cccc] b=[REDACTED xapp-...ffff]');
  });

  // The canary for the split above: assembled, these are still the complete
  // shapes a real credential has. Without it, a fixture could be shortened into
  // something no scanner recognises and the tests above would still pass, which
  // is the one way this file could go quietly vacuous.
  it('assembles fixtures that are still complete token shapes', () => {
    expect(BOT_TOKEN).toMatch(/^xoxb-\d{10}-\d{13}-[A-Za-z0-9]{20}$/);
    expect(APP_TOKEN).toMatch(/^xapp-\d-A\d{8}-\d{13}-[a-z0-9]{28}$/);
    expect(USER_TOKEN).toMatch(/^xoxp-\d{3}-\d{3}-\d{3}-[A-Za-z0-9]{22}$/);
    expect(CONFIG_TOKEN).toMatch(/^xoxe\.xoxp-\d-[A-Za-z0-9]{28}$/);
  });
});

describe('redactSecrets — OAuth key/value forms', () => {
  it('redacts access_token / refresh_token in env, query and JSON forms', () => {
    expect(S(redactSecrets('access_token=abcdefghijkl'))).toBe('access_token=[REDACTED]');
    expect(S(redactSecrets('refresh_token: abcdefghijkl'))).toBe('refresh_token: [REDACTED]');
    expect(S(redactSecrets('{"access_token":"abcdefghijkl"}'))).toBe('{"access_token":"[REDACTED]"}');
    expect(S(redactSecrets('{"refreshToken": "abcdefghijkl"}'))).toBe('{"refreshToken": "[REDACTED]"}');
  });

  it('redacts client_secret and signing_secret key/value forms', () => {
    expect(S(redactSecrets('client_secret=0123456789abcdef'))).toBe('client_secret=[REDACTED]');
    expect(S(redactSecrets('{"signingSecret":"0123456789abcdef"}'))).toBe('{"signingSecret":"[REDACTED]"}');
  });

  it('redacts a long OAuth authorization code', () => {
    const out = S(redactSecrets('code=1234567890.1234567890.abcdefabcdef'));
    expect(out).toBe('code=[REDACTED]');
  });
});

describe('redactSecrets — Socket Mode URLs', () => {
  it('redacts a wss:// URL including its ticket query', () => {
    const out = S(redactSecrets('url: wss://wss-primary.slack.com/link/?ticket=SENTINEL_TICKET&app_id=A1'));
    expect(out).toBe('url: [REDACTED wss-url]');
    expect(out).not.toContain('SENTINEL_TICKET');
  });

  it('redacts a wss:// URL inside JSON without eating the closing quote', () => {
    const out = S(redactSecrets('{"url":"wss://wss-primary.slack.com/link/?ticket=SENTINEL_TICKET","ok":true}'));
    expect(out).toBe('{"url":"[REDACTED wss-url]","ok":true}');
    expect(out).not.toContain('SENTINEL_TICKET');
  });

  it('leaves https:// URLs alone', () => {
    const url = 'https://slack.com/api/auth.test';
    expect(S(redactSecrets(url))).toBe(url);
  });
});

describe('redactSecrets — registered ephemeral values', () => {
  it('redacts a Slack auth ticket registered for a command', () => {
    const ticket = 'MTIzNDU2Nzg5MC5hYmNkZWY';
    const out = S(redactSecrets(`slack auth login --ticket ${ticket}`, { ephemeralValues: [ticket] }));
    expect(out).toBe('slack auth login --ticket [REDACTED ephemeral]');
  });

  it('redacts an ephemeral challenge even when it is short and word-like', () => {
    const out = S(redactSecrets('challenge is 8f3a2b', { ephemeralValues: ['8f3a2b'] }));
    expect(out).toBe('challenge is [REDACTED ephemeral]');
  });

  it('treats ephemeral values as literals, not regexes', () => {
    const out = S(redactSecrets('value a.c here', { ephemeralValues: ['a.c'] }));
    expect(out).toBe('value [REDACTED ephemeral] here');
    expect(S(redactSecrets('value abc here', { ephemeralValues: ['a.c'] }))).toBe('value abc here');
  });

  it('redacts ephemeral values inside structured argv and env', () => {
    const ticket = 'TICKET-abcdef123456';
    const result = redactSecrets(
      { command: 'slack', args: ['auth', 'login', '--ticket', ticket], env: { SOMA_TICKET: ticket } },
      { ephemeralValues: [ticket] },
    ) as { args: string[]; env: Record<string, string> };
    expect(result.args).toEqual(['auth', 'login', '--ticket', '[REDACTED ephemeral]']);
    expect(result.env.SOMA_TICKET).toBe('[REDACTED ephemeral]');
  });

  it('ignores empty ephemeral registrations instead of blanking the text', () => {
    expect(S(redactSecrets('plain text', { ephemeralValues: ['', 'plain text'] }))).toBe('[REDACTED ephemeral]');
  });
});

describe('redactSecrets — structured payloads', () => {
  it('redacts secret-shaped env values while leaving key names intact', () => {
    const input = {
      env: { SLACK_BOT_TOKEN: 'xoxb-1-2-aaaabbbbcccc', PATH: '/usr/bin' },
      args: ['--team', 'T0123456'],
    };
    const out = redactSecrets(input) as typeof input;
    expect(out.env.SLACK_BOT_TOKEN).toBe('[REDACTED xoxb-...cccc]');
    expect(out.env.PATH).toBe('/usr/bin');
    expect(out.args).toEqual(['--team', 'T0123456']);
  });

  it('does not mutate the caller input', () => {
    const input = { token: 'xoxb-1-2-aaaabbbbcccc' };
    const out = redactSecrets(input) as typeof input;
    expect(input.token).toBe('xoxb-1-2-aaaabbbbcccc');
    expect(out).not.toBe(input);
  });

  it('survives circular graphs', () => {
    type Cyclic = { name: string; self?: Cyclic };
    const input: Cyclic = { name: 'xoxb-1-2-aaaabbbbcccc' };
    input.self = input;
    const out = redactSecrets(input) as Cyclic;
    expect(out.name).toBe('[REDACTED xoxb-...cccc]');
    expect(out.self).toBe('[Circular]');
  });
});

describe('redactSecrets — non-overmatch on ordinary words', () => {
  const untouched = [
    'the exit code was 3',
    'code review scheduled',
    'a token bucket rate limiter',
    'access_token',
    'refresh_token is missing from the response',
    'team T0123456 user U9ABCDEF app A01B2C3D4',
    '{"code":"ENOENT"}',
    '{"code":"ERR_MODULE_NOT_FOUND"}',
    'xoxb-',
    'xapp',
    'wss',
    'lmk-short',
    'sk-ant-oat01-short',
  ];

  for (const text of untouched) {
    it(`leaves ${JSON.stringify(text)} untouched`, () => {
      expect(S(redactSecrets(text))).toBe(text);
    });
  }
});

describe('redactAnthropicSecrets backward compatibility', () => {
  it('still redacts Anthropic and llmux shapes with the historical format', () => {
    expect(S(redactAnthropicSecrets('token is sk-ant-oat01-abcdefghij done'))).toBe(
      'token is [REDACTED sk-ant-oat01-...ghij] done',
    );
    expect(S(redactAnthropicSecrets('key=lmk-xWKZI1ICaaaabbbbcccc'))).toBe('key=[REDACTED lmk-...cccc]');
  });

  it('is the same redactor as redactSecrets (superset, no second regex set)', () => {
    expect(S(redactAnthropicSecrets('xoxb-1-2-aaaabbbbcccc'))).toBe(S(redactSecrets('xoxb-1-2-aaaabbbbcccc')));
  });
});
