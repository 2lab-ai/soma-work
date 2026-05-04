import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotAuthLease } from '../../credentials-manager';
import { buildQueryEnv, getQueryEnvAdditional, RESERVED_LEASE_KEYS, setQueryEnvAdditional } from '../query-env-builder';

function makeLease(keyId: string, accessToken: string, kind: SlotAuthLease['kind'] = 'cct'): SlotAuthLease {
  return {
    keyId,
    accessToken,
    kind,
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
    // Reset module-level additional env between tests — the setter is a
    // shared singleton and any leftover state would cross-pollinate cases.
    setQueryEnvAdditional({});
  });

  afterEach(() => {
    if (originalOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    if (originalFoo === undefined) delete process.env.__QENV_BUILDER_FIXTURE__;
    else process.env.__QENV_BUILDER_FIXTURE__ = originalFoo;
    setQueryEnvAdditional({});
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN to the lease accessToken (cct slot without attachment)', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-TOKEN-A', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-TOKEN-A');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN to lease.accessToken verbatim (format-agnostic)', () => {
    const lease = makeLease('slot-b', 'sk-ant-oat01-TOKEN-B', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-TOKEN-B');
  });

  it('does NOT mutate process.env', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-FRESH', 'cct');
    buildQueryEnv(lease);
    // The global token we pre-seeded must survive untouched.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('GLOBAL-WRONG-TOKEN');
  });

  it('preserves unrelated process.env variables in the returned env', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-X', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.__QENV_BUILDER_FIXTURE__).toBe('keep-me');
    // The returned env shouldn't clobber PATH either — presence is enough here.
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  it('returns independent env objects for separate leases (concurrent isolation)', () => {
    const leaseA = makeLease('slot-a', 'TOKEN-A', 'cct');
    const leaseB = makeLease('slot-b', 'TOKEN-B', 'cct');
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
    const leaseA = makeLease('slot-a', 'PARALLEL-A', 'cct');
    const leaseB = makeLease('slot-b', 'PARALLEL-B', 'cct');

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
    const lease = makeLease('slot-a', 'TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    for (const v of Object.values(env)) {
      expect(typeof v).toBe('string');
    }
  });

  // ===== claude.env / setQueryEnvAdditional =====

  it('overlays setQueryEnvAdditional values on top of process.env', () => {
    setQueryEnvAdditional({ FOO: 'bar', __QENV_BUILDER_FIXTURE__: 'overridden' });
    const lease = makeLease('slot-a', 'TOKEN-A', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.FOO).toBe('bar');
    // Operator override wins over the inherited process.env value.
    expect(env.__QENV_BUILDER_FIXTURE__).toBe('overridden');
    // process.env itself remains untouched.
    expect(process.env.FOO).toBeUndefined();
    expect(process.env.__QENV_BUILDER_FIXTURE__).toBe('keep-me');
  });

  it('lease token override beats additional env even if it tries to set CLAUDE_CODE_OAUTH_TOKEN (defense in depth)', () => {
    // Bypass the load-time denylist by calling the setter directly with
    // a poisoned key. The build-time override must still win.
    setQueryEnvAdditional({ CLAUDE_CODE_OAUTH_TOKEN: 'EVIL' });
    const lease = makeLease('slot-a', 'GENUINE-LEASE-TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('GENUINE-LEASE-TOKEN');
  });

  it('setQueryEnvAdditional defensively clones — caller mutation does not leak', () => {
    const input: Record<string, string> = { FOO: 'initial' };
    setQueryEnvAdditional(input);
    // Mutate the caller's object after registration.
    input.FOO = 'mutated';
    input.NEW = 'sneak-in';
    const lease = makeLease('slot-a', 'TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.FOO).toBe('initial');
    expect(env.NEW).toBeUndefined();
  });

  it('getQueryEnvAdditional returns a clone, not the live state', () => {
    setQueryEnvAdditional({ FOO: 'bar' });
    const snapshot = getQueryEnvAdditional();
    snapshot.FOO = 'mutated-snapshot';
    snapshot.NEW = 'sneak-in';
    // Subsequent build still sees the original state.
    const lease = makeLease('slot-a', 'TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.FOO).toBe('bar');
    expect(env.NEW).toBeUndefined();
  });

  it('RESERVED_LEASE_KEYS is frozen and contains the auth/proxy/provider slots', () => {
    expect(Object.isFrozen(RESERVED_LEASE_KEYS)).toBe(true);
    // Spot-check the canonical entries — full list pinned by the parser
    // tests in unified-config-loader.test.ts.
    expect(RESERVED_LEASE_KEYS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(RESERVED_LEASE_KEYS).toContain('ANTHROPIC_API_KEY');
    expect(RESERVED_LEASE_KEYS).toContain('CLAUDE_CONFIG_DIR');
    expect(RESERVED_LEASE_KEYS).toContain('HTTPS_PROXY');
    expect(RESERVED_LEASE_KEYS).toContain('NODE_EXTRA_CA_CERTS');
  });
});
