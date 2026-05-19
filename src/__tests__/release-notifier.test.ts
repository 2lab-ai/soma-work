import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getConfiguredUpdateChannel', () => {
  let tempConfigDir: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DEFAULT_UPDATE_CHANNEL;
    delete process.env.SOMA_CONFIG_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempConfigDir) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = undefined;
    }
    delete process.env.DEFAULT_UPDATE_CHANNEL;
    delete process.env.SOMA_CONFIG_DIR;
  });

  it('recovers an unquoted Slack channel name from the env file when dotenv parsed it as empty', async () => {
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-release-notifier-'));
    fs.writeFileSync(path.join(tempConfigDir, '.env'), 'DEFAULT_UPDATE_CHANNEL=#soma-work-dev\nDEBUG=true\n');

    process.env.SOMA_CONFIG_DIR = tempConfigDir;
    process.env.DEFAULT_UPDATE_CHANNEL = '';

    const module = await import('../release-notifier');

    expect(module.getConfiguredUpdateChannel()).toBe('#soma-work-dev');
  });
});

describe('resolveChannel', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to the provided channel name when conversations.list is missing read scope', async () => {
    const module = await import('../release-notifier');
    const client = {
      conversations: {
        list: vi.fn().mockRejectedValue(new Error('An API error occurred: missing_scope')),
      },
    };

    const typedClient = client as unknown as Parameters<typeof module.resolveChannel>[0];

    await expect(module.resolveChannel(typedClient, '#soma-work-dev')).resolves.toBe('#soma-work-dev');
  });
});
