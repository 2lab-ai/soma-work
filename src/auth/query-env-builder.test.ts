import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotAuthLease } from '../credentials-manager';
import { buildQueryEnv } from './query-env-builder';

function makeLease(
  slotId: string,
  accessToken: string,
  kind: SlotAuthLease['kind'] = 'setup_token',
  extras: Partial<Pick<SlotAuthLease, 'name' | 'configDir'>> = {},
): SlotAuthLease {
  return {
    slotId,
    name: extras.name ?? slotId,
    accessToken,
    kind,
    configDir: extras.configDir,
    async release() {
      /* no-op */
    },
    async heartbeat() {
      /* no-op */
    },
  };
}

describe('buildQueryEnv', () => {
  // Snapshot + restore process.env so cross-test pollution can't mask a real
  // mutation. If buildQueryEnv ever starts mutating process.env, these hooks
  // fail fast on the next test.
  let originalOauthToken: string | undefined;
  let originalFoo: string | undefined;

  beforeEach(() => {
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalFoo = process.env.__QENV_BUILDER_FIXTURE__;
    process.env.__QENV_BUILDER_FIXTURE__ = 'keep-me';
    // Intentionally set a "wrong" global token to prove the builder does NOT
    // depend on or propagate it.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'GLOBAL-WRONG-TOKEN';
  });

  afterEach(() => {
    if (originalOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    if (originalFoo === undefined) delete process.env.__QENV_BUILDER_FIXTURE__;
    else process.env.__QENV_BUILDER_FIXTURE__ = originalFoo;
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN to the lease accessToken (setup_token)', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-TOKEN-A', 'setup_token');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-TOKEN-A');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN to the lease accessToken (oauth_credentials)', () => {
    const lease = makeLease('slot-b', 'sk-ant-oat01-TOKEN-B', 'oauth_credentials');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-TOKEN-B');
  });

  it('does NOT mutate process.env', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-FRESH', 'setup_token');
    buildQueryEnv(lease);
    // The global token we pre-seeded must survive untouched.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('GLOBAL-WRONG-TOKEN');
  });

  it('preserves unrelated process.env variables in the returned env', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-X', 'setup_token');
    const { env } = buildQueryEnv(lease);
    expect(env.__QENV_BUILDER_FIXTURE__).toBe('keep-me');
    // The returned env shouldn't clobber PATH either — presence is enough here.
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  it('returns independent env objects for separate leases (concurrent isolation)', () => {
    const leaseA = makeLease('slot-a', 'TOKEN-A', 'setup_token');
    const leaseB = makeLease('slot-b', 'TOKEN-B', 'oauth_credentials');
    const { env: envA } = buildQueryEnv(leaseA);
    const { env: envB } = buildQueryEnv(leaseB);

    // Distinct object identity — no shared reference.
    expect(envA).not.toBe(envB);
    // And distinct token values, even though both derived from the same
    // process.env snapshot.
    expect(envA.CLAUDE_CODE_OAUTH_TOKEN).toBe('TOKEN-A');
    expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBe('TOKEN-B');

    // Mutating one result must not leak into the other.
    envA.CLAUDE_CODE_OAUTH_TOKEN = 'MUTATED-A';
    expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBe('TOKEN-B');
  });

  it('simulated concurrent dispatch: each query() call sees its own token', async () => {
    // Two leases dispatched "in parallel" — the env captured for each spawn
    // must carry ONLY its own token, regardless of ordering.
    const leaseA = makeLease('slot-a', 'PARALLEL-A', 'setup_token');
    const leaseB = makeLease('slot-b', 'PARALLEL-B', 'oauth_credentials');

    const [{ env: envA }, { env: envB }] = await Promise.all([
      Promise.resolve(buildQueryEnv(leaseA)),
      Promise.resolve(buildQueryEnv(leaseB)),
    ]);

    expect(envA.CLAUDE_CODE_OAUTH_TOKEN).toBe('PARALLEL-A');
    expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBe('PARALLEL-B');
    // The global must still be unchanged by the parallel builds.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('GLOBAL-WRONG-TOKEN');
  });

  it('returns a plain object whose values are all strings', () => {
    const lease = makeLease('slot-a', 'TOKEN', 'setup_token');
    const { env } = buildQueryEnv(lease);
    for (const v of Object.values(env)) {
      expect(typeof v).toBe('string');
    }
  });

  it('sets CLAUDE_CONFIG_DIR to lease.configDir when present (oauth_credentials)', () => {
    const lease = makeLease('slot-o', 'TOKEN', 'oauth_credentials', { configDir: '/var/soma/cct-store.dirs/slot-o' });
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/var/soma/cct-store.dirs/slot-o');
  });

  it('omits CLAUDE_CONFIG_DIR from the returned env when lease has no configDir', () => {
    const lease = makeLease('slot-a', 'TOKEN', 'setup_token');
    const { env } = buildQueryEnv(lease);
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
  });

  it('strips inherited process.env.CLAUDE_CONFIG_DIR when lease carries none', () => {
    // Simulate an operator-inherited CLAUDE_CONFIG_DIR that would otherwise
    // leak into subprocesses. With no configDir on the lease, buildQueryEnv
    // must DELETE the key so the subprocess falls back to the CLI's default.
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/inherited/config-dir';
    try {
      const lease = makeLease('slot-a', 'TOKEN', 'setup_token');
      const { env } = buildQueryEnv(lease);
      expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
      // And process.env itself must not be mutated.
      expect(process.env.CLAUDE_CONFIG_DIR).toBe('/inherited/config-dir');
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  });
});
