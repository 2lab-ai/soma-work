/**
 * Task 7 — Socket Mode signing-secret contract.
 *
 * A Slack signing secret verifies the `X-Slack-Signature` header on requests
 * Slack delivers over **HTTP**. Socket Mode receives events over an outbound
 * WebSocket authenticated by the app-level token (`xapp-…`), so no signature
 * is ever computed and no signing secret is required.
 *
 * These tests pin three things:
 *   1. The pure helpers (`normalizeSigningSecret` / `signingSecretOption` /
 *      `requireSigningSecret`).
 *   2. The two Bolt `App` construction sites omit the `signingSecret` key
 *      when no secret is configured. Bolt accepts an explicit `undefined`
 *      identically, so this is a canonical-shape contract, not a Bolt
 *      requirement: the option object must never carry a declared-but-empty
 *      secret. `toEqual` cannot see that, hence `hasOwnProp` throughout.
 *   3. An HTTP receiver fails closed: absent / blank / short all throw.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the options object handed to `new App(...)` so the multi-agent
// construction site can be asserted with `hasOwnProperty` (see §2 above).
const appConstructorOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@slack/bolt', () => ({
  App: class {
    constructor(options: Record<string, unknown>) {
      appConstructorOptions.push(options);
    }
    event = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  },
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
  SocketModeReceiver: class {
    client = {};
    constructor(public options: Record<string, unknown>) {}
  },
}));

import {
  normalizeSigningSecret,
  requireSigningSecret,
  SIGNING_SECRET_MIN_LENGTH,
  signingSecretOption,
} from '../slack-signing-secret';

/**
 * Own-property probe: is the key actually present, or merely `undefined`?
 *
 * Bolt itself does NOT distinguish the two — `App.js` destructures its options
 * as `{ signingSecret = undefined, … }`, and a destructuring default fires on
 * the value whether or not the key exists. The contract these tests pin is the
 * canonical SHAPE of the object we hand over: an options/config object must
 * never carry a declared-but-empty secret, so that serialization, diffing, and
 * any future receiver or config consumer read it unambiguously. `toEqual` and
 * `in` both blur exactly that distinction, so the assertions go through here.
 */
// biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn needs lib ES2022; tsconfig targets ES2020
const hasOwnProp = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

const VALID = 'a'.repeat(32);
const EXACTLY_MIN = 'b'.repeat(20);
const TOO_SHORT = 'c'.repeat(19);

describe('normalizeSigningSecret', () => {
  it('returns undefined for absent / non-string input', () => {
    expect(normalizeSigningSecret(undefined)).toBeUndefined();
    expect(normalizeSigningSecret(null)).toBeUndefined();
  });

  it('normalizes blank and whitespace-only values to undefined', () => {
    expect(normalizeSigningSecret('')).toBeUndefined();
    expect(normalizeSigningSecret('   ')).toBeUndefined();
    expect(normalizeSigningSecret('\n\t ')).toBeUndefined();
  });

  it('trims surrounding whitespace off a real value', () => {
    expect(normalizeSigningSecret(`  ${VALID}\n`)).toBe(VALID);
  });

  it('does not enforce a minimum length itself (that is the caller contract)', () => {
    expect(normalizeSigningSecret(TOO_SHORT)).toBe(TOO_SHORT);
  });
});

describe('signingSecretOption — conditional spread for Socket Mode', () => {
  it('omits the signingSecret OWN property when no secret is configured', () => {
    const options = signingSecretOption(undefined);
    expect(hasOwnProp(options, 'signingSecret')).toBe(false);
    expect(Object.keys(options)).toEqual([]);
  });

  it('omits the property for blank / whitespace-only input too', () => {
    expect(hasOwnProp(signingSecretOption(''), 'signingSecret')).toBe(false);
    expect(hasOwnProp(signingSecretOption('   '), 'signingSecret')).toBe(false);
  });

  it('includes the property when a secret is configured', () => {
    const options = signingSecretOption(VALID);
    expect(hasOwnProp(options, 'signingSecret')).toBe(true);
    expect(options.signingSecret).toBe(VALID);
  });
});

describe('requireSigningSecret — HTTP receiver fails closed', () => {
  // The two failure branches are asserted separately AND exclusively: an
  // absent secret must report "required", never be laundered into the length
  // branch as "0 chars". Collapsing them would let a caller that defaults the
  // value to '' still appear to fail closed while losing the real reason.
  it('throws "required" — not a length complaint — when the secret is absent', () => {
    expect(() => requireSigningSecret(undefined)).toThrow(/signingSecret is required/);
    expect(() => requireSigningSecret(undefined)).toThrow(/http receiver/);
    expect(() => requireSigningSecret(undefined)).not.toThrow(/too short/);
    expect(() => requireSigningSecret(undefined)).not.toThrow(/0 chars/);
  });

  it('throws "required" for blank or whitespace-only secrets too', () => {
    for (const blank of ['', '   ', '\n\t ']) {
      expect(() => requireSigningSecret(blank)).toThrow(/signingSecret is required/);
      expect(() => requireSigningSecret(blank)).not.toThrow(/too short/);
    }
  });

  it('throws "too short" when a provided secret is under the minimum', () => {
    expect(() => requireSigningSecret(TOO_SHORT)).toThrow(
      new RegExp(`too short.*19 chars.*minimum ${SIGNING_SECRET_MIN_LENGTH}`),
    );
    expect(() => requireSigningSecret(TOO_SHORT)).not.toThrow(/is required/);
  });

  it('returns the normalized secret when it is valid', () => {
    expect(requireSigningSecret(VALID)).toBe(VALID);
    expect(requireSigningSecret(EXACTLY_MIN)).toBe(EXACTLY_MIN);
    expect(requireSigningSecret(`  ${VALID}  `)).toBe(VALID);
  });

  it('names the receiver kind explicitly in the failure', () => {
    expect(() => requireSigningSecret(undefined, 'http')).toThrow(/http receiver/);
  });

  it('never leaks the secret value into the error message', () => {
    let message = '';
    try {
      requireSigningSecret(TOO_SHORT);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(TOO_SHORT);
    expect(message).toContain('19 chars');
  });
});

describe('main runtime App construction (SocketModeReceiver, src/index.ts)', () => {
  // Mirrors the option literal at src/index.ts — `new App({ token, ...opt,
  // receiver, logLevel })`. The entrypoint calls `start()` at module scope so
  // it cannot be imported; the source guard below pins that it really routes
  // through the helper rather than passing `signingSecret:` directly.
  function buildMainAppOptions(secret: string | undefined) {
    return {
      token: 'xoxb-main',
      ...signingSecretOption(secret),
      receiver: {},
      logLevel: 'info',
    };
  }

  it('omits signingSecret when the operator configured none', () => {
    const options = buildMainAppOptions(undefined);
    expect(hasOwnProp(options, 'signingSecret')).toBe(false);
    expect(hasOwnProp(options, 'receiver')).toBe(true);
  });

  it('carries a configured secret through without requiring it', () => {
    const options = buildMainAppOptions(VALID);
    expect(hasOwnProp(options, 'signingSecret')).toBe(true);
    expect((options as { signingSecret?: string }).signingSecret).toBe(VALID);
  });

  it('src/index.ts spreads the helper instead of passing signingSecret directly', () => {
    const source = readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    expect(source).toContain('...signingSecretOption(config.slack.signingSecret)');
    expect(source).not.toMatch(/\n\s*signingSecret:\s*config\.slack\.signingSecret/);
  });

  // The canonical Socket Mode snippet in the spec mirrors this exact block, and
  // a `Trace:`-style pointer is how a maintainer reaches it. Pin the negative
  // half only — the direct pass must not reappear in the published contract.
  // Deliberately one doc, not a repo scan: this file is the one that duplicates
  // the code under test.
  it('the published Socket Mode snippet does not show the direct signingSecret pass', () => {
    const doc = readFileSync(
      path.join(__dirname, '..', '..', 'docs', 'current', 'spec', '01-slack-integration.md'),
      'utf8',
    );
    expect(doc).not.toMatch(/\n\s*signingSecret:\s*config\.slack\.signingSecret/);
  });
});

describe('AgentInstance App construction (multi-agent Socket Mode)', () => {
  beforeEach(() => {
    appConstructorOptions.length = 0;
  });

  async function startAgent(config: Record<string, unknown>) {
    const { AgentInstance } = await import('../agent-instance');
    const instance = new AgentInstance('t7', config as never, {} as never);
    await instance.start();
    return appConstructorOptions[appConstructorOptions.length - 1];
  }

  it('omits the signingSecret OWN property when the agent declares none', async () => {
    const options = await startAgent({ slackBotToken: 'xoxb-a', slackAppToken: 'xapp-a' });
    expect(hasOwnProp(options, 'signingSecret')).toBe(false);
    expect(options.socketMode).toBe(true);
    expect(options.appToken).toBe('xapp-a');
  });

  it('includes the signingSecret OWN property when the agent declares a valid one', async () => {
    const options = await startAgent({ slackBotToken: 'xoxb-a', slackAppToken: 'xapp-a', signingSecret: VALID });
    expect(hasOwnProp(options, 'signingSecret')).toBe(true);
    expect(options.signingSecret).toBe(VALID);
  });
});
