import * as os from 'os';
import { describe, expect, it } from 'vitest';
import { getSomaHome, resolveDataDirOverride } from '../soma-paths';

describe('getSomaHome', () => {
  it('prefers the canonical SOMAWORK_HOME', () => {
    expect(getSomaHome({ SOMAWORK_HOME: '/canonical' })).toBe('/canonical');
  });

  it('accepts SOMA_HOME as a backwards-compatible alias', () => {
    expect(getSomaHome({ SOMA_HOME: '/legacy' })).toBe('/legacy');
  });

  it('lets SOMAWORK_HOME win when both are set', () => {
    expect(getSomaHome({ SOMAWORK_HOME: '/canonical', SOMA_HOME: '/legacy' })).toBe('/canonical');
  });

  it('skips an empty or whitespace value and falls through', () => {
    expect(getSomaHome({ SOMAWORK_HOME: '   ', SOMA_HOME: '/legacy' })).toBe('/legacy');
    expect(getSomaHome({ SOMAWORK_HOME: '', SOMA_HOME: '  ' })).toBe(os.homedir());
    expect(getSomaHome({})).toBe(os.homedir());
  });
});

describe('resolveDataDirOverride', () => {
  it('normalises a relative override to an absolute path', () => {
    expect(resolveDataDirOverride({ SOMA_DATA_DIR: 'rel/dir' })).toBe(`${process.cwd()}/rel/dir`);
  });

  it('returns null when unset, empty, or whitespace', () => {
    expect(resolveDataDirOverride({})).toBeNull();
    expect(resolveDataDirOverride({ SOMA_DATA_DIR: '' })).toBeNull();
    expect(resolveDataDirOverride({ SOMA_DATA_DIR: '   ' })).toBeNull();
  });
});
