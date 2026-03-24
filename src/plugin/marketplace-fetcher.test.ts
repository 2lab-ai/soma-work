import { describe, it, expect } from 'vitest';
import {
  gitUrlToRepo,
  normalisePluginSource,
  validateOfficialManifest,
  normaliseOfficialManifest,
} from './marketplace-fetcher';
import { EXTERNAL_PLUGIN_PATH, OfficialMarketplaceManifest } from './types';

// ---------------------------------------------------------------------------
// gitUrlToRepo
// ---------------------------------------------------------------------------
describe('gitUrlToRepo', () => {
  it('parses owner/repo format', () => {
    expect(gitUrlToRepo('2lab-ai/soma-work')).toBe('2lab-ai/soma-work');
  });

  it('parses https GitHub URL', () => {
    expect(gitUrlToRepo('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses https GitHub URL without .git', () => {
    expect(gitUrlToRepo('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses SSH-style GitHub URL', () => {
    expect(gitUrlToRepo('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('returns null for non-GitHub URL', () => {
    expect(gitUrlToRepo('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('returns null for invalid format', () => {
    expect(gitUrlToRepo('just-a-name')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalisePluginSource
// ---------------------------------------------------------------------------
describe('normalisePluginSource', () => {
  it('converts string path to local path entry', () => {
    const result = normalisePluginSource('./plugins/stv');
    expect(result).toEqual({ path: 'plugins/stv' });
  });

  it('strips leading ./ from string path', () => {
    const result = normalisePluginSource('./my-plugin');
    expect(result).toEqual({ path: 'my-plugin' });
  });

  it('keeps path without ./ prefix unchanged', () => {
    const result = normalisePluginSource('plugins/foo');
    expect(result).toEqual({ path: 'plugins/foo' });
  });

  it('converts url source to external entry', () => {
    const result = normalisePluginSource({
      source: 'url',
      url: 'https://github.com/org/plugin.git',
      sha: 'abc123',
    });
    expect(result).toEqual({
      path: EXTERNAL_PLUGIN_PATH,
      externalUrl: 'https://github.com/org/plugin.git',
      externalSha: 'abc123',
    });
  });

  it('converts git-subdir source to external entry', () => {
    const result = normalisePluginSource({
      source: 'git-subdir',
      url: 'https://github.com/org/monorepo',
      path: 'packages/plugin-a',
      ref: 'v2',
      sha: 'def456',
    });
    expect(result).toEqual({
      path: EXTERNAL_PLUGIN_PATH,
      externalUrl: 'https://github.com/org/monorepo',
      externalSubdir: 'packages/plugin-a',
      externalRef: 'v2',
      externalSha: 'def456',
    });
  });

  it('returns null for unknown source type', () => {
    const result = normalisePluginSource({ source: 'unknown' } as never);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateOfficialManifest
// ---------------------------------------------------------------------------
describe('validateOfficialManifest', () => {
  it('returns valid manifest with correct shape', () => {
    const input = {
      name: 'test-marketplace',
      plugins: [
        { name: 'p1', source: './plugins/p1' },
        { name: 'p2', source: { source: 'url', url: 'https://github.com/org/p2' } },
      ],
    };
    const result = validateOfficialManifest(input);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('test-marketplace');
    expect(result!.plugins).toHaveLength(2);
  });

  it('returns null for non-object input', () => {
    expect(validateOfficialManifest(null)).toBeNull();
    expect(validateOfficialManifest('string')).toBeNull();
    expect(validateOfficialManifest(42)).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(validateOfficialManifest({ plugins: [] })).toBeNull();
  });

  it('returns null when plugins is not an array', () => {
    expect(validateOfficialManifest({ name: 'test', plugins: {} })).toBeNull();
  });

  it('filters out entries without name', () => {
    const input = {
      name: 'test',
      plugins: [
        { name: 'valid', source: './path' },
        { source: './no-name' },
      ],
    };
    const result = validateOfficialManifest(input);
    expect(result!.plugins).toHaveLength(1);
    expect(result!.plugins[0].name).toBe('valid');
  });

  it('filters out entries without source', () => {
    const input = {
      name: 'test',
      plugins: [
        { name: 'valid', source: './path' },
        { name: 'no-source' },
      ],
    };
    const result = validateOfficialManifest(input);
    expect(result!.plugins).toHaveLength(1);
  });

  it('filters out url source entries missing url field', () => {
    const input = {
      name: 'test',
      plugins: [
        { name: 'bad-url', source: { source: 'url' } },
        { name: 'good', source: './local' },
      ],
    };
    const result = validateOfficialManifest(input);
    expect(result!.plugins).toHaveLength(1);
    expect(result!.plugins[0].name).toBe('good');
  });

  it('filters out git-subdir source entries missing required fields', () => {
    const input = {
      name: 'test',
      plugins: [
        { name: 'bad-subdir', source: { source: 'git-subdir', url: 'https://example.com' } },
        { name: 'good', source: './local' },
      ],
    };
    const result = validateOfficialManifest(input);
    expect(result!.plugins).toHaveLength(1);
    expect(result!.plugins[0].name).toBe('good');
  });

  it('preserves optional fields (description, owner, metadata)', () => {
    const input = {
      name: 'test',
      description: 'A marketplace',
      owner: { name: 'Test Org' },
      metadata: { version: '1.0.0' },
      plugins: [],
    };
    const result = validateOfficialManifest(input);
    expect(result!.description).toBe('A marketplace');
    expect(result!.metadata?.version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// normaliseOfficialManifest
// ---------------------------------------------------------------------------
describe('normaliseOfficialManifest', () => {
  it('converts array-based plugins to Record-based format', () => {
    const official: OfficialMarketplaceManifest = {
      name: 'test-mkt',
      plugins: [
        { name: 'local-plugin', source: './plugins/local-plugin' },
        {
          name: 'remote-plugin',
          description: 'A remote one',
          source: { source: 'url', url: 'https://github.com/org/remote', sha: 'abc' },
        },
      ],
    };

    const result = normaliseOfficialManifest(official);
    expect(result.name).toBe('test-mkt');
    expect(Object.keys(result.plugins)).toEqual(['local-plugin', 'remote-plugin']);
    expect(result.plugins['local-plugin'].path).toBe('plugins/local-plugin');
    expect(result.plugins['remote-plugin'].path).toBe(EXTERNAL_PLUGIN_PATH);
    expect(result.plugins['remote-plugin'].externalUrl).toBe('https://github.com/org/remote');
    expect(result.plugins['remote-plugin'].description).toBe('A remote one');
  });

  it('skips plugins with unsupported source types', () => {
    const official: OfficialMarketplaceManifest = {
      name: 'test-mkt',
      plugins: [
        { name: 'good', source: './path' },
        { name: 'bad', source: { source: 'ftp' } as never },
      ],
    };

    const result = normaliseOfficialManifest(official);
    expect(Object.keys(result.plugins)).toEqual(['good']);
  });

  it('uses metadata.version as manifest version', () => {
    const official: OfficialMarketplaceManifest = {
      name: 'test',
      metadata: { version: '2.0.0' },
      plugins: [],
    };

    const result = normaliseOfficialManifest(official);
    expect(result.version).toBe('2.0.0');
  });
});
