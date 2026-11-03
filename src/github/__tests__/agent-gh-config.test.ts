/**
 * #834 (epic #831) — `gh` in a bot session always has a live App token.
 *
 * The agent's env is a copy of the daemon's, taken once per turn. The App installation token lives an hour, so a `gh`
 * reading `GITHUB_TOKEN` from that copy fails with 401 once it expires — while `git` keeps working, because it re-reads
 * its config (rewritten on every refresh) on every call. That 401 is why bot sessions created PRs with raw REST, which
 * the task card could not see.
 *
 *   G1  every credential refresh writes a bot-owned `hosts.yml` (atomic, 0600) and serves its dir as GH_CONFIG_DIR
 *   G2  a token that is not a single safe token is refused (no YAML injection), and the dir is not served
 *   G3  GitCredentialsManager writes hosts.yml next to git's credentials; a failed write stops serving the old one
 *   G4  buildQueryEnv: with a served dir, agent shells get GH_CONFIG_DIR and no frozen GITHUB_TOKEN / GH_TOKEN;
 *       the operator's own claude.env still wins; with none (a PAT setup) the env passes through
 *   G5  TokenRefreshScheduler: a failed background refresh keeps retrying — also after the old token expired — and
 *       does not throw away the still-valid cached token while it retries
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-home-'));
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  return { ...real, default: { ...real, homedir: () => HOME }, homedir: () => HOME };
});
const gitCalls: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const spawn = (_cmd: string, args: string[]) => {
    gitCalls.push(args);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  };
  return { ...real, default: { ...real, spawn }, spawn };
});

import { buildQueryEnv, setQueryEnvAdditional } from '../../auth/query-env-builder';
import type { SlotAuthLease } from '../../credentials-manager';
import { clearAgentGhConfigDir, getAgentGhConfigDir, writeAgentGhHosts } from '../agent-gh-config';
import { GitCredentialsManager } from '../git-credentials-manager';
import { TokenRefreshScheduler } from '../token-refresh-scheduler';

const TOKEN = 'ghs_TESTTOKEN0000000000000000000000000000';
const lease: SlotAuthLease = {
  keyId: 'k',
  accessToken: 'oauth',
  kind: 'cct',
  async release() {},
  async heartbeat() {},
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-gh-'));
  clearAgentGhConfigDir();
  gitCalls.length = 0;
});
afterEach(() => {
  clearAgentGhConfigDir();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('agent gh config (#834)', () => {
  it('G1 — writes hosts.yml for the App token atomically, 0600, and serves its dir', async () => {
    const ghDir = path.join(dir, 'gh');
    await writeAgentGhHosts(ghDir, TOKEN);
    const file = path.join(ghDir, 'hosts.yml');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `github.com:\n    oauth_token: ${TOKEN}\n    user: x-access-token\n    git_protocol: https\n`,
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(ghDir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(ghDir)).toEqual(['hosts.yml']);
    expect(getAgentGhConfigDir()).toBe(ghDir);
    // A refresh rewrites it in place.
    await writeAgentGhHosts(ghDir, `${TOKEN}2`);
    expect(fs.readFileSync(file, 'utf8')).toContain(`oauth_token: ${TOKEN}2\n`);
    expect(fs.readdirSync(ghDir)).toEqual(['hosts.yml']);
  });

  it('G2 — a token that is not one safe word is refused and nothing is served', async () => {
    await expect(writeAgentGhHosts(dir, 'abc\n    user: evil')).rejects.toThrow();
    await expect(writeAgentGhHosts(dir, '')).rejects.toThrow();
    expect(getAgentGhConfigDir()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'hosts.yml'))).toBe(false);
  });

  it('G3 — GitCredentialsManager writes hosts.yml with git credentials; a failed write stops serving the old token', async () => {
    const ghDir = path.join(dir, 'gh');
    const manager = new GitCredentialsManager(ghDir);
    await manager.updateCredentials(`${TOKEN}\n`);
    expect(fs.readFileSync(path.join(ghDir, 'hosts.yml'), 'utf8')).toContain(`oauth_token: ${TOKEN}\n`);
    expect(getAgentGhConfigDir()).toBe(ghDir);
    expect(fs.readFileSync(path.join(HOME, '.git-credentials'), 'utf8')).toBe(
      `https://x-access-token:${TOKEN}@github.com\n`,
    );
    // The next write fails (the dir is now a file): gh must not keep reading a token that will expire.
    fs.rmSync(ghDir, { recursive: true });
    fs.writeFileSync(ghDir, 'not a dir');
    await manager.updateCredentials(`${TOKEN}3`);
    expect(getAgentGhConfigDir()).toBeUndefined();
    // Without a gh dir (a PAT setup), nothing is served.
    await new GitCredentialsManager().updateCredentials(TOKEN);
    expect(getAgentGhConfigDir()).toBeUndefined();
  });

  describe('G4 — buildQueryEnv', () => {
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    beforeEach(() => {
      process.env.GITHUB_TOKEN = 'ghs_FROZEN_COPY';
      process.env.GH_TOKEN = 'ghs_FROZEN_COPY_2';
      setQueryEnvAdditional({});
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      setQueryEnvAdditional({});
    });

    it('serves GH_CONFIG_DIR and drops the frozen tokens when the App token is written', async () => {
      await writeAgentGhHosts(dir, TOKEN);
      const { env } = buildQueryEnv(lease);
      expect(env.GH_CONFIG_DIR).toBe(dir);
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      // The daemon's own env is untouched.
      expect(process.env.GITHUB_TOKEN).toBe('ghs_FROZEN_COPY');
    });

    it("the operator's claude.env still wins", async () => {
      await writeAgentGhHosts(dir, TOKEN);
      setQueryEnvAdditional({ GH_TOKEN: 'ghp_operator' });
      expect(buildQueryEnv(lease).env.GH_TOKEN).toBe('ghp_operator');
    });

    it('with no served dir (a PAT setup) the env passes through', () => {
      const { env } = buildQueryEnv(lease);
      expect(env.GITHUB_TOKEN).toBe('ghs_FROZEN_COPY');
      expect(env.GH_CONFIG_DIR).toBeUndefined();
    });
  });
});

describe('G5 — TokenRefreshScheduler retries a failed refresh', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the valid token while it retries, and retries past expiry until a refresh succeeds', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const MIN = 60_000;
    const getInstallationToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'ghs_ONE', expiresAt: new Date(now + 10 * MIN) })
      // Fails at +5, +7, +9 and +11 minutes (the token expired at +10), then succeeds at +13.
      .mockRejectedValueOnce(new Error('github down'))
      .mockRejectedValueOnce(new Error('github down'))
      .mockRejectedValueOnce(new Error('github down'))
      .mockRejectedValueOnce(new Error('github down'))
      .mockResolvedValueOnce({ token: 'ghs_TWO', expiresAt: new Date(now + 70 * MIN) });
    const updateCredentials = vi.fn().mockResolvedValue(undefined);
    const scheduler = new TokenRefreshScheduler({ getInstallationToken } as any, { updateCredentials } as any, 42);
    expect(await scheduler.getToken()).toBe('ghs_ONE');

    // The background refresh at 5 minutes before expiry fails.
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(getInstallationToken).toHaveBeenCalledTimes(2);
    // The still-valid token is served without a new fetch.
    expect(await scheduler.getToken()).toBe('ghs_ONE');
    expect(getInstallationToken).toHaveBeenCalledTimes(2);

    // It keeps retrying every 2 minutes, also after the old token expired at +10.
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(getInstallationToken).toHaveBeenCalledTimes(5);
    expect(updateCredentials).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(getInstallationToken).toHaveBeenCalledTimes(6);
    expect(updateCredentials).toHaveBeenLastCalledWith('ghs_TWO');
    scheduler.stopAutoRefresh();
  });
});
