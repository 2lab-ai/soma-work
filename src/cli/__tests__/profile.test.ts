import { getSomaHome } from '@soma/common/env-paths';
import os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileResolutionError, profilePaths, type RuntimeInstall, resolveProfile } from '../profile';

describe('resolveProfile', () => {
  it('returns the explicitly requested profile', () => {
    expect(resolveProfile({ requested: 'production', installed: [] })).toBe('production');
  });

  it('rejects an invalid requested profile', () => {
    expect(() => resolveProfile({ requested: 'staging', installed: [] })).toThrow(ProfileResolutionError);
  });

  it('infers the profile when exactly one runtime is installed', () => {
    const installed: RuntimeInstall[] = [{ profile: 'preview', root: '/opt/somawork/preview', version: '1.0.0' }];
    expect(resolveProfile({ installed })).toBe('preview');
  });

  it('rejects ambiguously when both profiles are installed and none is requested', () => {
    const installed: RuntimeInstall[] = [
      { profile: 'preview', root: '/opt/somawork/preview', version: '1.0.0' },
      { profile: 'production', root: '/opt/somawork/production', version: '1.0.0' },
    ];
    expect(() => resolveProfile({ installed })).toThrow(ProfileResolutionError);
  });

  it('rejects when nothing is installed and none is requested', () => {
    expect(() => resolveProfile({ installed: [] })).toThrow(ProfileResolutionError);
  });
});

describe('profilePaths', () => {
  const home = '/tmp/somawork-home';

  it('computes exact preview paths', () => {
    expect(profilePaths(home, 'preview')).toEqual({
      configDir: '/tmp/somawork-home/.config/somawork/profiles/preview',
      secretsFile: '/tmp/somawork-home/.config/somawork/profiles/preview/secrets.env',
      dataDir: '/tmp/somawork-home/.local/share/somawork/preview',
      stateDir: '/tmp/somawork-home/.local/state/somawork/preview',
      serviceLabel: 'ai.2lab.somawork.preview',
    });
  });

  it('computes exact production paths', () => {
    expect(profilePaths(home, 'production')).toEqual({
      configDir: '/tmp/somawork-home/.config/somawork/profiles/production',
      secretsFile: '/tmp/somawork-home/.config/somawork/profiles/production/secrets.env',
      dataDir: '/tmp/somawork-home/.local/share/somawork/production',
      stateDir: '/tmp/somawork-home/.local/state/somawork/production',
      serviceLabel: 'ai.2lab.somawork.production',
    });
  });
});

describe('getSomaHome (SOMA_HOME env override, injected for hermetic setup tests)', () => {
  const ORIGINAL = process.env.SOMA_HOME;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.SOMA_HOME;
    } else {
      process.env.SOMA_HOME = ORIGINAL;
    }
  });

  it('returns the injected SOMA_HOME override', () => {
    process.env.SOMA_HOME = '/tmp/somawork-home';
    expect(getSomaHome()).toBe('/tmp/somawork-home');
    expect(profilePaths(getSomaHome(), 'preview').configDir).toBe(
      '/tmp/somawork-home/.config/somawork/profiles/preview',
    );
  });

  it('falls back to the OS home directory when unset', () => {
    delete process.env.SOMA_HOME;
    expect(getSomaHome()).toBe(os.homedir());
  });
});
