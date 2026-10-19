/**
 * The test suite must never see the environment of a soma-work deployment.
 *
 * 2026-10-19: an agent session spawned by the dev bot inherited
 * `SOMA_CONFIG_DIR=/opt/soma-work/dev` and `DATA_DIR=/opt/soma-work/dev/data`.
 * `npm run test:release` then loaded the dev bot's `.env` (Slack/GitHub
 * credentials, `AUTH_MODE=llmux` — 23 tests failed on that alone) and wrote
 * fixture sessions/conversations into the live dev data directory.
 *
 * `hermetic-test-env.ts` is wired as a vitest `setupFiles` entry. These tests
 * pin both the policy (pure function) and the wiring (this very process).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isolateTestEnv } from '../hermetic-test-env';

const scratchDirs: string[] = [];

function makeScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-env-test-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function deploymentShellEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/operator',
    TMPDIR: '/var/folders/xx/T/',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    CI: 'true',
    NODE_ENV: 'test',
    VITEST: 'true',
    VITEST_POOL_ID: '1',
    npm_lifecycle_event: 'test:release',
    // Deployment state a bot-spawned shell carries.
    SOMA_CONFIG_DIR: '/opt/soma-work/dev',
    DATA_DIR: '/opt/soma-work/dev/data',
    SOMA_DATA_DIR: '/opt/soma-work/dev/data',
    SOMAWORK_HOME: '/opt/soma-work/dev/home',
    SOMA_HOME: '/opt/soma-work/dev/home',
    AUTH_MODE: 'llmux',
    ANTHROPIC_BASE_URL: 'http://localhost:3456',
    ANTHROPIC_API_KEY: 'sk-live',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-live',
    CLAUDE_CONFIG_DIR: '/opt/soma-work/dev/.claude',
    SLACK_BOT_TOKEN: 'xoxb-live',
    SLACK_APP_TOKEN: 'xapp-live',
    SLACK_SIGNING_SECRET: 'live',
    GITHUB_TOKEN: 'ghs_live',
    GITHUB_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----',
    BASE_DIRECTORY: '/tmp',
    ADMIN_USERS: 'U0001',
    SOMA_UI_5BLOCK_PHASE: '5',
  };
}

describe('isolateTestEnv', () => {
  it('removes every deployment variable, credentials included', () => {
    const env = deploymentShellEnv();
    isolateTestEnv(env, makeScratch());

    for (const key of [
      'SOMA_DATA_DIR',
      'SOMAWORK_HOME',
      'SOMA_HOME',
      'AUTH_MODE',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_SIGNING_SECRET',
      'GITHUB_TOKEN',
      'GITHUB_PRIVATE_KEY',
      'BASE_DIRECTORY',
      'ADMIN_USERS',
      'SOMA_UI_5BLOCK_PHASE',
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it('pins config and data resolution to an empty scratch directory', () => {
    const scratch = makeScratch();
    const env = deploymentShellEnv();
    isolateTestEnv(env, scratch);

    expect(env.SOMA_CONFIG_DIR).toBe(scratch);
    expect(env.DATA_DIR).toBe(path.join(scratch, 'data'));
    // No .env in the scratch dir → env-paths' dotenv.config() loads nothing.
    expect(fs.existsSync(path.join(scratch, '.env'))).toBe(false);
  });

  it('keeps generic process and tooling variables', () => {
    const env = deploymentShellEnv();
    isolateTestEnv(env, makeScratch());

    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/operator',
      TMPDIR: '/var/folders/xx/T/',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      CI: 'true',
      NODE_ENV: 'test',
      VITEST: 'true',
      VITEST_POOL_ID: '1',
      npm_lifecycle_event: 'test:release',
    });
  });
});

describe('vitest wiring (this process)', () => {
  it('runs every test file with config/data pinned outside any deployment', async () => {
    const configDir = process.env.SOMA_CONFIG_DIR;
    expect(configDir, 'setupFiles must pin SOMA_CONFIG_DIR').toBeTruthy();
    expect(path.basename(configDir as string)).toMatch(/^soma-work-test-/);
    expect(process.env.DATA_DIR).toBe(path.join(configDir as string, 'data'));
    expect(process.env.AUTH_MODE).toBeUndefined();
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();

    const envPaths = await import('../../env-paths');
    expect(envPaths.DATA_DIR).toBe(path.join(configDir as string, 'data'));
    expect(envPaths.ENV_FILE).toBe(path.join(configDir as string, '.env'));
  });
});
