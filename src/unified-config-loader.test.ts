import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveUnifiedConfig, UnifiedConfig } from './unified-config-loader';

describe('saveUnifiedConfig', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-test-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves config to file with correct JSON format (2-space indent, trailing newline)', () => {
    const config: UnifiedConfig = {
      mcpServers: {
        'test-server': {
          command: 'node',
          args: ['server.js'],
        } as any,
      },
      plugin: {
        marketplace: [{ name: 'test', repo: 'org/repo' }],
        plugins: ['test@test'],
      } as any,
    };

    saveUnifiedConfig(configFile, config);

    const written = fs.readFileSync(configFile, 'utf-8');
    expect(written).toBe(JSON.stringify(config, null, 2) + '\n');
  });

  it('uses atomic write (no leftover .tmp file after success)', () => {
    const config: UnifiedConfig = { mcpServers: {} };

    saveUnifiedConfig(configFile, config);

    // After successful save, no .tmp file should remain
    const tmpFile = configFile + '.tmp';
    expect(fs.existsSync(tmpFile)).toBe(false);

    // Final file exists with correct content
    expect(fs.existsSync(configFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(config);
  });

  it('preserves UnifiedConfig structure through round-trip', () => {
    const config: UnifiedConfig = {
      mcpServers: {
        'server-a': { command: 'npx', args: ['-y', 'some-mcp'] } as any,
        'server-b': { command: 'python', args: ['serve.py'] } as any,
      },
      plugin: {
        marketplace: [{ name: 'official', repo: 'anthropics/plugins', ref: 'v1.0.0' }],
        plugins: ['omc@official'],
        localOverrides: ['./src/local'],
      } as any,
    };

    saveUnifiedConfig(configFile, config);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(config);
  });

  it('overwrites existing config file', () => {
    const initial: UnifiedConfig = { mcpServers: { old: { command: 'old' } as any } };
    const updated: UnifiedConfig = { mcpServers: { new: { command: 'new' } as any } };

    saveUnifiedConfig(configFile, initial);
    saveUnifiedConfig(configFile, updated);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(updated);
    expect(parsed.mcpServers).not.toHaveProperty('old');
  });

  it('handles empty config', () => {
    const config: UnifiedConfig = {};

    saveUnifiedConfig(configFile, config);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual({});
  });
});
