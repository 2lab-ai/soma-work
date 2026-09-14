import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSecretFree, type SetupState, SetupStateStore } from '../state';

describe('SetupStateStore', () => {
  let home: string;
  let stateDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-state-test-'));
    stateDir = path.join(home, '.local', 'state', 'somawork', 'preview');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('load() returns null before anything has been saved', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    expect(store.load()).toBeNull();
  });

  it('save() then load() round-trips the state', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    store.save({
      schemaVersion: 1,
      profile: 'preview',
      currentStep: 'slack-app',
      slackAppId: 'A123',
      slackTeamId: 'T123',
      completedSteps: [{ step: 'cli-install', completedAt: '2026-08-23T00:00:00.000Z' }],
      lastError: null,
    });

    const loaded = store.load();
    expect(loaded).toEqual({
      schemaVersion: 1,
      profile: 'preview',
      currentStep: 'slack-app',
      slackAppId: 'A123',
      slackTeamId: 'T123',
      completedSteps: [{ step: 'cli-install', completedAt: '2026-08-23T00:00:00.000Z' }],
      lastError: null,
    });
  });

  it('update() applies a mutator to a fresh default state when none exists yet', () => {
    const store = new SetupStateStore({ profile: 'production', stateDir });
    const next = store.update((current) => ({ ...current, currentStep: 'install' }));
    expect(next.currentStep).toBe('install');
    expect(next.profile).toBe('production');
    expect(store.load()?.currentStep).toBe('install');
  });

  it('update() applies a mutator on top of the previously saved state', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    store.update((current) => ({ ...current, currentStep: 'step-1' }));
    store.update((current) => ({ ...current, currentStep: 'step-2', lastError: 'boom' }));
    const loaded = store.load();
    expect(loaded?.currentStep).toBe('step-2');
    expect(loaded?.lastError).toBe('boom');
  });

  it('creates the state directory at mode 0700', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    store.update((current) => current);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it('writes a .bak file on the second save', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    store.update((current) => ({ ...current, currentStep: 'a' }));
    store.update((current) => ({ ...current, currentStep: 'b' }));
    const stateFile = path.join(stateDir, 'setup-state.json');
    expect(fs.existsSync(`${stateFile}.bak`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${stateFile}.bak`, 'utf-8')).currentStep).toBe('a');
  });

  it('recovers from .bak when the live state file is corrupted (interrupted write)', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    store.update((current) => ({ ...current, currentStep: 'good-1' }));
    store.update((current) => ({ ...current, currentStep: 'good-2' }));
    const stateFile = path.join(stateDir, 'setup-state.json');
    fs.writeFileSync(stateFile, '{not valid json, truncated by crash');

    const recovered = store.load();
    expect(recovered?.currentStep).toBe('good-1');
  });

  it('save() rejects a state whose lastError embeds a credential', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    expect(() =>
      store.update((current) => ({
        ...current,
        lastError: 'slack api error: invalid_auth token=xoxb-111-222-abcdef',
      })),
    ).toThrow();
  });

  it('save() rejects a state object carrying a secret-shaped field', () => {
    const store = new SetupStateStore({ profile: 'preview', stateDir });
    const badState: SetupState = {
      schemaVersion: 1,
      profile: 'preview' as const,
      currentStep: null,
      slackAppId: null,
      slackTeamId: null,
      completedSteps: [],
      lastError: null,
      // @ts-expect-error intentionally injecting a disallowed field for the RED/GREEN test
      token: 'xoxb-should-not-be-here',
    };
    expect(() => store.save(badState)).toThrow();
  });
});

describe('assertSecretFree', () => {
  it('allows plain, non-secret-shaped state', () => {
    expect(() =>
      assertSecretFree({
        schemaVersion: 1,
        profile: 'preview',
        currentStep: 'install',
        slackAppId: 'A123',
        slackTeamId: 'T123',
        completedSteps: [{ step: 'cli-install', completedAt: '2026-08-23T00:00:00.000Z' }],
        lastError: null,
      }),
    ).not.toThrow();
  });

  it('rejects a top-level "token" field', () => {
    expect(() => assertSecretFree({ token: 'abc' })).toThrow();
  });

  it('rejects a top-level "code" field (OAuth authorization code)', () => {
    expect(() => assertSecretFree({ code: 'abc123' })).toThrow();
  });

  it('rejects a nested "clientSecret" field', () => {
    expect(() => assertSecretFree({ slack: { clientSecret: 'abc' } })).toThrow();
  });

  it('rejects a nested field inside an array', () => {
    expect(() => assertSecretFree({ items: [{ ok: true }, { refreshToken: 'abc' }] })).toThrow();
  });

  it('rejects a Slack bot token-shaped string value regardless of key name', () => {
    expect(() => assertSecretFree({ note: 'xoxb-1234-5678-abcdef' })).toThrow();
  });

  it('rejects a Slack app token-shaped string value regardless of key name', () => {
    expect(() => assertSecretFree({ note: 'xapp-1-A123-456-abcdef' })).toThrow();
  });

  it('does not flag ordinary identifiers that merely resemble field names loosely', () => {
    expect(() => assertSecretFree({ slackAppId: 'A123', slackTeamId: 'T123', currentStep: 'install' })).not.toThrow();
  });

  // Regression: the value patterns used to be `^`-anchored, so a credential that
  // arrived inside free text -- exactly what `lastError` carries -- slipped through.
  // `lastError` is the only free-text field in SetupState, and once
  // validateSetupState has rejected unknown keys it is the whole remaining
  // leak surface for the "no credential in setup-state JSON" constraint.
  it('rejects a Slack bot token embedded mid-string in lastError', () => {
    expect(() => assertSecretFree({ lastError: 'slack api error: invalid_auth token=xoxb-111-222-abcdef' })).toThrow();
  });

  it('rejects a Slack app token embedded mid-string in lastError', () => {
    expect(() => assertSecretFree({ lastError: 'Error: request failed (xapp-1-A123-456-abcdef)' })).toThrow();
  });

  it('rejects an embedded credential after a leading word', () => {
    expect(() => assertSecretFree({ note: 'see xoxb-1-2-3' })).toThrow();
  });

  it('rejects an embedded GitHub token or JWT anywhere in free text', () => {
    expect(() => assertSecretFree({ lastError: 'push failed using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01' })).toThrow();
    expect(() => assertSecretFree({ lastError: 'bad jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig' })).toThrow();
  });

  // False-positive guard: detection keys off credential SHAPE, not the mere
  // presence of words like "token"/"secret" in an operator-facing message.
  it('does not flag ordinary error prose that has no credential shape', () => {
    for (const lastError of [
      'slack api error: invalid_auth (token missing)',
      'request failed with status 500 after 3 retries',
      'ENOENT: no such file or directory, open /Users/z/.config/somawork/profiles/preview/secrets.env',
      'signing secret was not configured for this workspace',
      'risk-analysis step timed out',
    ]) {
      expect(() => assertSecretFree({ lastError })).not.toThrow();
    }
  });

  it('rejects credential-shaped key names that survived the original tokenizer', () => {
    expect(() => assertSecretFree({ OAUTHTOKEN: 'x' })).toThrow();
    expect(() => assertSecretFree({ APITOKEN: 'x' })).toThrow();
    expect(() => assertSecretFree({ accessToken2: 'x' })).toThrow();
    expect(() => assertSecretFree({ token2: 'x' })).toThrow();
    expect(() => assertSecretFree({ oauthNonce: 'x' })).toThrow();
  });

  it('still accepts every legitimate SetupState field name after key hardening', () => {
    expect(() =>
      assertSecretFree({
        schemaVersion: 1,
        profile: 'preview',
        currentStep: 'install',
        slackAppId: 'A123',
        slackTeamId: 'T123',
        completedSteps: [{ step: 'cli-install', completedAt: '2026-08-23T00:00:00.000Z' }],
        lastError: 'deploy failed',
      }),
    ).not.toThrow();
  });
});
