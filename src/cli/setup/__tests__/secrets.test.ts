import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../secrets';

describe('SecretStore', () => {
  let home: string;
  let configDir: string;
  let secretsFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-store-test-'));
    configDir = path.join(home, '.config', 'somawork', 'profiles', 'preview');
    secretsFile = path.join(configDir, 'secrets.env');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('read() returns an empty object before anything has been written', () => {
    const store = new SecretStore({ secretsFile });
    expect(store.read()).toEqual({});
  });

  it('write() then read() round-trips allowlisted keys', () => {
    const store = new SecretStore({ secretsFile });
    store.write({ SLACK_BOT_TOKEN: 'xoxb-1-2-3', SLACK_APP_TOKEN: 'xapp-1-2-3' });
    expect(store.read()).toEqual({ SLACK_BOT_TOKEN: 'xoxb-1-2-3', SLACK_APP_TOKEN: 'xapp-1-2-3' });
  });

  it('write() merges into previously written keys rather than clobbering them', () => {
    const store = new SecretStore({ secretsFile });
    store.write({ SLACK_BOT_TOKEN: 'xoxb-1-2-3' });
    store.write({ SLACK_APP_TOKEN: 'xapp-1-2-3' });
    expect(store.read()).toEqual({ SLACK_BOT_TOKEN: 'xoxb-1-2-3', SLACK_APP_TOKEN: 'xapp-1-2-3' });
  });

  it('write() rejects a key outside the strict allowlist', () => {
    const store = new SecretStore({ secretsFile });
    expect(() =>
      store.write({
        // @ts-expect-error intentionally not in SecretKey to prove the runtime allowlist check fires
        RANDOM_ENV_VAR: 'nope',
      }),
    ).toThrow();
  });

  it('write() rejects an empty value', () => {
    const store = new SecretStore({ secretsFile });
    expect(() => store.write({ SLACK_BOT_TOKEN: '' })).toThrow();
  });

  it('write() rejects a value containing a newline', () => {
    const store = new SecretStore({ secretsFile });
    // A newline would forge a second KEY=VALUE line in the env file.
    expect(() => store.write({ SLACK_BOT_TOKEN: 'xoxb-1-2-3\nSLACK_APP_TOKEN=xapp-evil' })).toThrow();
    expect(fs.existsSync(secretsFile)).toBe(false);
  });

  it('write() rejects a value containing a NUL byte', () => {
    const store = new SecretStore({ secretsFile });
    expect(() => store.write({ SLACK_BOT_TOKEN: 'xoxb-1-2-3\u0000trailing' })).toThrow();
  });

  it('writes secrets.env at mode 0600', () => {
    const store = new SecretStore({ secretsFile });
    store.write({ SLACK_BOT_TOKEN: 'xoxb-1-2-3' });
    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it('creates the profile config directory at mode 0700', () => {
    const store = new SecretStore({ secretsFile });
    store.write({ SLACK_BOT_TOKEN: 'xoxb-1-2-3' });
    expect(fs.statSync(configDir).mode & 0o777).toBe(0o700);
  });

  it('does not write JSON to secrets.env (plain KEY=VALUE bytes)', () => {
    const store = new SecretStore({ secretsFile });
    store.write({ SLACK_BOT_TOKEN: 'xoxb-1-2-3' });
    const raw = fs.readFileSync(secretsFile, 'utf-8');
    expect(() => JSON.parse(raw)).toThrow();
    expect(raw).toContain('SLACK_BOT_TOKEN=');
  });

  it('backs up the previous secrets.env to .bak on overwrite', () => {
    const store = new SecretStore({ secretsFile });
    store.write({ SLACK_BOT_TOKEN: 'xoxb-old' });
    store.write({ SLACK_BOT_TOKEN: 'xoxb-new' });
    expect(fs.existsSync(`${secretsFile}.bak`)).toBe(true);
  });
});
