/**
 * Tests for `${VAR}` env-var substitution applied to config.json on load.
 *
 * Coverage strategy: the substitution happens at parse-time on the JSON
 * value, before any structural validator runs. So the test surface is the
 * pure function `substituteEnvVars` (covers grammar) plus an integration
 * test through `loadConfig` (covers the wiring + warn dedupe).
 *
 * Secret-leak guard: assertions inspect the warn payload to make sure the
 * substituted value never appears in logs — only the placeholder NAME does.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetForTests,
  loadDotenvForConfig,
  substituteEnvVars,
  warnMissingPlaceholders,
} from '../config-env-substitution';

describe('substituteEnvVars', () => {
  // process.env mutations across tests would bleed; snapshot+restore.
  const envSnapshot = { ...process.env };
  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('substitutes a bare ${VAR} when set', () => {
    process.env.JIRA_PAT_TOKEN = 'abc123';
    const out = substituteEnvVars({
      headers: { Authorization: 'Basic ${JIRA_PAT_TOKEN}' },
    });
    expect(out.value).toEqual({ headers: { Authorization: 'Basic abc123' } });
    expect(out.missing).toEqual([]);
  });

  it('preserves ${VAR} verbatim and reports missing when unset', () => {
    delete process.env.UNSET_VAR;
    const out = substituteEnvVars({ token: 'Basic ${UNSET_VAR}' });
    expect(out.value).toEqual({ token: 'Basic ${UNSET_VAR}' });
    expect(out.missing).toEqual(['UNSET_VAR']);
  });

  it('${VAR:-default} uses default when var is unset', () => {
    delete process.env.MAYBE;
    const out = substituteEnvVars({ host: '${MAYBE:-localhost}' });
    expect(out.value).toEqual({ host: 'localhost' });
    expect(out.missing).toEqual([]);
  });

  it('${VAR:-default} uses default when var is set but empty', () => {
    process.env.EMPTY = '';
    const out = substituteEnvVars({ host: '${EMPTY:-fallback}' });
    expect(out.value).toEqual({ host: 'fallback' });
  });

  it('${VAR:-default} uses var value when set non-empty (default ignored)', () => {
    process.env.SET = 'real';
    const out = substituteEnvVars({ host: '${SET:-fallback}' });
    expect(out.value).toEqual({ host: 'real' });
  });

  it('${VAR:?msg} throws when unset, with operator-supplied message', () => {
    delete process.env.MUST_HAVE;
    expect(() => substituteEnvVars({ x: '${MUST_HAVE:?provide a token}' })).toThrow(/provide a token/);
  });

  it('${VAR:?} (empty msg) throws with a generic message naming the var', () => {
    delete process.env.NEEDED;
    expect(() => substituteEnvVars({ x: '${NEEDED:?}' })).toThrow(/required env var NEEDED is not set/);
  });

  it('$$ escapes to a literal $ and prevents placeholder match', () => {
    process.env.FOO = 'should-not-substitute';
    const out = substituteEnvVars({ x: '$${FOO}' });
    expect(out.value).toEqual({ x: '${FOO}' });
    expect(out.missing).toEqual([]);
  });

  it('walks arrays and nested objects, rewriting only string leaves', () => {
    process.env.A = 'aval';
    process.env.B = 'bval';
    const input = {
      mcpServers: {
        atlassian: {
          type: 'http',
          url: 'https://mcp.atlassian.com/v1/mcp',
          headers: { Authorization: 'Basic ${A}' },
          tags: ['${B}', 42, true, null],
        },
      },
    };
    const out = substituteEnvVars(input);
    expect(out.value).toEqual({
      mcpServers: {
        atlassian: {
          type: 'http',
          url: 'https://mcp.atlassian.com/v1/mcp',
          headers: { Authorization: 'Basic aval' },
          tags: ['bval', 42, true, null],
        },
      },
    });
  });

  it('does not mutate the input object', () => {
    process.env.K = 'v';
    const input = { a: '${K}', nested: { b: '${K}' } };
    const out = substituteEnvVars(input);
    expect(input).toEqual({ a: '${K}', nested: { b: '${K}' } });
    expect(out.value).not.toBe(input);
  });

  it('multiple placeholders in one string are all substituted', () => {
    process.env.SCHEME = 'https';
    process.env.HOST = 'mcp.example.com';
    const out = substituteEnvVars({ url: '${SCHEME}://${HOST}/v1/mcp' });
    expect(out.value).toEqual({ url: 'https://mcp.example.com/v1/mcp' });
  });

  it('reports missing placeholders deduplicated within a single call', () => {
    delete process.env.UNSET_A;
    const out = substituteEnvVars({
      one: '${UNSET_A}',
      two: '${UNSET_A}',
      three: '${UNSET_A}',
    });
    expect(out.missing).toEqual(['UNSET_A']);
  });
});

describe('warnMissingPlaceholders — dedupe + value-never-logged', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns at most once per process for the same missing var', () => {
    warnMissingPlaceholders(['FOO'], 'config.json');
    warnMissingPlaceholders(['FOO'], 'config.json');
    warnMissingPlaceholders(['FOO'], 'config.json');
    const fooWarnings = warnSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('${FOO}'),
    );
    expect(fooWarnings).toHaveLength(1);
  });

  it('warns the first time a new missing var appears', () => {
    warnMissingPlaceholders(['FOO'], 'config.json');
    warnMissingPlaceholders(['BAR'], 'config.json');
    const names = warnSpy.mock.calls
      .map((c: unknown[]) => (typeof c[0] === 'string' ? (c[0] as string) : ''))
      .filter((s: string) => s.includes('${'));
    expect(names.some((s: string) => s.includes('${FOO}'))).toBe(true);
    expect(names.some((s: string) => s.includes('${BAR}'))).toBe(true);
  });

  it('warn message contains placeholder NAME but never the resolved VALUE', () => {
    // Set the env var so substituteEnvVars wouldn't even mark it missing —
    // but we exercise warnMissingPlaceholders directly to assert the
    // contract that *no value* ever flows through this log path.
    process.env.SECRET_TOKEN = 'super-secret-do-not-leak';
    warnMissingPlaceholders(['SECRET_TOKEN'], 'config.json');
    delete process.env.SECRET_TOKEN;

    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        const s = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(s).not.toContain('super-secret-do-not-leak');
      }
    }
  });
});

describe('loadDotenvForConfig — priority cwd → config dir → parent', () => {
  let tmpRoot: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-env-priority-'));
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    __resetForTests();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('cwd .env wins over config-dir .env (first writer wins)', () => {
    const cwdDir = path.join(tmpRoot, 'cwd');
    const configDir = path.join(tmpRoot, 'cfg');
    fs.mkdirSync(cwdDir);
    fs.mkdirSync(configDir);

    fs.writeFileSync(path.join(cwdDir, '.env'), 'PRIORITY_TEST=from-cwd\n');
    fs.writeFileSync(path.join(configDir, '.env'), 'PRIORITY_TEST=from-config-dir\n');

    delete process.env.PRIORITY_TEST;
    process.chdir(cwdDir);
    loadDotenvForConfig(path.join(configDir, 'config.json'));

    expect(process.env.PRIORITY_TEST).toBe('from-cwd');
  });

  it('falls back to config-dir .env when cwd has none', () => {
    const cwdDir = path.join(tmpRoot, 'cwd');
    const configDir = path.join(tmpRoot, 'cfg');
    fs.mkdirSync(cwdDir);
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, '.env'), 'FROM_CFG=yes\n');

    delete process.env.FROM_CFG;
    process.chdir(cwdDir);
    loadDotenvForConfig(path.join(configDir, 'config.json'));

    expect(process.env.FROM_CFG).toBe('yes');
  });

  it('falls back to parent of config-dir .env when neither cwd nor config-dir has one', () => {
    const cwdDir = path.join(tmpRoot, 'cwd');
    const parentDir = path.join(tmpRoot, 'parent');
    const configDir = path.join(parentDir, 'cfg');
    fs.mkdirSync(cwdDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(parentDir, '.env'), 'FROM_PARENT=ok\n');

    delete process.env.FROM_PARENT;
    process.chdir(cwdDir);
    loadDotenvForConfig(path.join(configDir, 'config.json'));

    expect(process.env.FROM_PARENT).toBe('ok');
  });

  it('does NOT overwrite an env var already present in process.env (OS wins)', () => {
    const cwdDir = path.join(tmpRoot, 'cwd');
    fs.mkdirSync(cwdDir);
    fs.writeFileSync(path.join(cwdDir, '.env'), 'PREEXISTING=from-dotenv\n');

    process.env.PREEXISTING = 'from-os';
    process.chdir(cwdDir);
    loadDotenvForConfig(path.join(cwdDir, 'config.json'));

    expect(process.env.PREEXISTING).toBe('from-os');
  });

  it('does not re-load the same .env file across calls (per-process dedupe)', () => {
    const cwdDir = path.join(tmpRoot, 'cwd');
    fs.mkdirSync(cwdDir);
    fs.writeFileSync(path.join(cwdDir, '.env'), 'COUNTER=initial\n');

    delete process.env.COUNTER;
    process.chdir(cwdDir);
    loadDotenvForConfig(path.join(cwdDir, 'config.json'));
    expect(process.env.COUNTER).toBe('initial');

    // Mutate the file contents — second call should NOT re-parse it.
    fs.writeFileSync(path.join(cwdDir, '.env'), 'COUNTER=changed\n');
    loadDotenvForConfig(path.join(cwdDir, 'config.json'));
    expect(process.env.COUNTER).toBe('initial');
  });
});
