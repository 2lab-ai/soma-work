import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadUnifiedConfig } from './unified-config-loader';

describe('loadUnifiedConfig', () => {
  let tmpDir: string;
  let configFile: string;
  let mcpFallback: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-test-'));
    configFile = path.join(tmpDir, 'config.json');
    mcpFallback = path.join(tmpDir, 'mcp-servers.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads unified config with mcpServers and plugin sections', () => {
    fs.writeFileSync(configFile, JSON.stringify({
      mcpServers: {
        jira: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' },
      },
      plugin: {
        marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work' }],
        plugins: ['omc@soma-work'],
        localOverrides: ['./src/local'],
      },
    }));

    const result = loadUnifiedConfig(configFile, mcpFallback);

    expect(result.mcpServers).toBeDefined();
    expect(result.mcpServers!.jira).toBeDefined();
    expect(result.plugin).toBeDefined();
    expect(result.plugin!.marketplace).toHaveLength(1);
    expect(result.plugin!.plugins).toEqual(['omc@soma-work']);
    expect(result.plugin!.localOverrides).toEqual(['./src/local']);
  });

  it('loads unified config with only mcpServers', () => {
    fs.writeFileSync(configFile, JSON.stringify({
      mcpServers: {
        jira: { type: 'sse', url: 'https://example.com' },
      },
    }));

    const result = loadUnifiedConfig(configFile, mcpFallback);

    expect(result.mcpServers).toBeDefined();
    expect(result.plugin).toBeUndefined();
  });

  it('falls back to mcp-servers.json when config.json missing', () => {
    fs.writeFileSync(mcpFallback, JSON.stringify({
      mcpServers: {
        github: { command: 'github-mcp' },
      },
    }));

    const result = loadUnifiedConfig(configFile, mcpFallback);

    expect(result.mcpServers).toBeDefined();
    expect(result.mcpServers!.github).toBeDefined();
    expect(result.plugin).toBeUndefined();
  });

  it('returns empty object when neither file exists', () => {
    const result = loadUnifiedConfig(configFile, mcpFallback);
    expect(result).toEqual({});
  });

  it('prefers config.json over mcp-servers.json', () => {
    fs.writeFileSync(configFile, JSON.stringify({
      mcpServers: { fromConfig: { type: 'sse', url: 'https://config.com' } },
    }));
    fs.writeFileSync(mcpFallback, JSON.stringify({
      mcpServers: { fromFallback: { command: 'fallback' } },
    }));

    const result = loadUnifiedConfig(configFile, mcpFallback);

    expect(result.mcpServers!.fromConfig).toBeDefined();
    expect(result.mcpServers!.fromFallback).toBeUndefined();
  });

  it('falls back on invalid config.json', () => {
    fs.writeFileSync(configFile, 'not json');
    fs.writeFileSync(mcpFallback, JSON.stringify({
      mcpServers: { fallback: { command: 'test' } },
    }));

    const result = loadUnifiedConfig(configFile, mcpFallback);

    expect(result.mcpServers!.fallback).toBeDefined();
  });

  it('validates plugin config and filters invalid entries', () => {
    fs.writeFileSync(configFile, JSON.stringify({
      plugin: {
        marketplace: [
          { name: 'valid', repo: 'org/repo' },
          { name: 'invalid' }, // missing repo
        ],
        plugins: ['omc@valid', 'bad-format'],
        localOverrides: ['./src/local', '', 42],
      },
    }));

    const result = loadUnifiedConfig(configFile, mcpFallback);

    expect(result.plugin!.marketplace).toHaveLength(1);
    expect(result.plugin!.plugins).toEqual(['omc@valid']);
    expect(result.plugin!.localOverrides).toEqual(['./src/local']);
  });
});
