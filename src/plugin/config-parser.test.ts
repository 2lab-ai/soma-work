import { describe, expect, it } from 'vitest';
import { isSafeName, parsePluginRef, validateMarketplaceEntry, validatePluginConfig } from './config-parser';

describe('parsePluginRef', () => {
  it('parses valid "name@marketplace" format', () => {
    const result = parsePluginRef('omc@soma-work');
    expect(result).toEqual({ pluginName: 'omc', marketplaceName: 'soma-work' });
  });

  it('handles plugin names with hyphens', () => {
    const result = parsePluginRef('super-powers@official-repo');
    expect(result).toEqual({ pluginName: 'super-powers', marketplaceName: 'official-repo' });
  });

  it('returns null for missing @', () => {
    expect(parsePluginRef('omc')).toBeNull();
  });

  it('returns null for @ at start', () => {
    expect(parsePluginRef('@marketplace')).toBeNull();
  });

  it('returns null for @ at end', () => {
    expect(parsePluginRef('omc@')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePluginRef('')).toBeNull();
  });

  it('rejects path traversal in plugin name', () => {
    expect(parsePluginRef('../../../etc@marketplace')).toBeNull();
  });

  it('rejects dots in plugin name', () => {
    expect(parsePluginRef('plugin.name@marketplace')).toBeNull();
  });

  it('rejects slashes in plugin name', () => {
    expect(parsePluginRef('path/to/plugin@marketplace')).toBeNull();
  });

  it('rejects unsafe marketplace name', () => {
    expect(parsePluginRef('omc@../bad')).toBeNull();
  });
});

describe('isSafeName', () => {
  it('accepts alphanumeric', () => {
    expect(isSafeName('omc')).toBe(true);
  });

  it('accepts hyphens and underscores', () => {
    expect(isSafeName('super-powers_v2')).toBe(true);
  });

  it('rejects dots', () => {
    expect(isSafeName('plugin.name')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafeName('path/traversal')).toBe(false);
  });

  it('rejects parent directory', () => {
    expect(isSafeName('..')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeName('')).toBe(false);
  });
});

describe('validateMarketplaceEntry', () => {
  it('accepts valid entry', () => {
    expect(validateMarketplaceEntry({ name: 'soma-work', repo: '2lab-ai/soma-work' })).toBe(true);
  });

  it('accepts entry with ref', () => {
    expect(validateMarketplaceEntry({ name: 'official', repo: 'anthropics/plugins', ref: 'v1.0.0' })).toBe(true);
  });

  it('rejects missing name', () => {
    expect(validateMarketplaceEntry({ repo: 'org/repo' })).toBe(false);
  });

  it('rejects missing repo', () => {
    expect(validateMarketplaceEntry({ name: 'test' })).toBe(false);
  });

  it('rejects repo without slash', () => {
    expect(validateMarketplaceEntry({ name: 'test', repo: 'no-slash' })).toBe(false);
  });

  it('rejects unsafe marketplace name', () => {
    expect(validateMarketplaceEntry({ name: '../bad', repo: 'org/repo' })).toBe(false);
  });

  it('rejects null', () => {
    expect(validateMarketplaceEntry(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(validateMarketplaceEntry('string')).toBe(false);
  });
});

describe('validatePluginConfig', () => {
  it('returns empty config for null', () => {
    expect(validatePluginConfig(null)).toEqual({});
  });

  it('returns empty config for non-object', () => {
    expect(validatePluginConfig('string')).toEqual({});
  });

  it('validates full config', () => {
    const raw = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work', ref: 'main' }],
      plugins: ['omc@soma-work'],
      localOverrides: ['./src/local'],
    };

    const result = validatePluginConfig(raw);
    expect(result.marketplace).toHaveLength(1);
    expect(result.plugins).toEqual(['omc@soma-work']);
    expect(result.localOverrides).toEqual(['./src/local']);
  });

  it('filters invalid marketplace entries', () => {
    const raw = {
      marketplace: [
        { name: 'valid', repo: 'org/repo' },
        { name: 'invalid' }, // missing repo
      ],
    };

    const result = validatePluginConfig(raw);
    expect(result.marketplace).toHaveLength(1);
    expect(result.marketplace![0].name).toBe('valid');
  });

  it('filters invalid plugin refs', () => {
    const raw = {
      plugins: ['valid@marketplace', 'invalid-no-at', 123],
    };

    const result = validatePluginConfig(raw);
    expect(result.plugins).toEqual(['valid@marketplace']);
  });

  it('filters empty localOverrides entries', () => {
    const raw = {
      localOverrides: ['./src/local', '', 42, './other'],
    };

    const result = validatePluginConfig(raw);
    expect(result.localOverrides).toEqual(['./src/local', './other']);
  });
});
