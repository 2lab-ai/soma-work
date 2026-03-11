import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('./env-paths', () => ({
  ENV_FILE: '/tmp/test.env',
}));

describe('getConfiguredUpdateChannel', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    delete process.env.DEFAULT_UPDATE_CHANNEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEFAULT_UPDATE_CHANNEL;
  });

  it('recovers an unquoted Slack channel name from the env file when dotenv parsed it as empty', async () => {
    process.env.DEFAULT_UPDATE_CHANNEL = '';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      'DEFAULT_UPDATE_CHANNEL=#soma-work-dev\nDEBUG=true\n' as any,
    );

    const module = await import('./release-notifier');

    expect((module as any).getConfiguredUpdateChannel()).toBe('#soma-work-dev');
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
    const module = await import('./release-notifier');
    const client = {
      conversations: {
        list: vi.fn().mockRejectedValue(new Error('An API error occurred: missing_scope')),
      },
    };

    await expect(module.resolveChannel(client as any, '#soma-work-dev')).resolves.toBe('#soma-work-dev');
  });
});
