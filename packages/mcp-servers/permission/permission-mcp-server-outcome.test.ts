/**
 * C3 (Z 2026-11-02, D1-A): every permission question leaves one line with its
 * outcome — answered or timed out, how long the person was waited on, the rules
 * and the AI's advice — so the questions an auto-mode change saves can be
 * counted from the log. (Who answered is in the work log: #754.)
 */

import { sharedStore } from '@soma/process-shared/permission/shared-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function ask(response: { behavior: 'allow' | 'deny'; message?: string }) {
  vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-outcome-test');
  vi.stubEnv('SLACK_CONTEXT', JSON.stringify({ channel: 'C1', threadTs: '1.000', user: 'U1' }));
  const { getPermissionServer } = await import('./permission-mcp-server.js');
  const server = getPermissionServer();
  vi.spyOn(sharedStore, 'storePendingApproval').mockResolvedValue(undefined);
  vi.spyOn(sharedStore, 'cleanup').mockResolvedValue(undefined);
  vi.spyOn(sharedStore, 'waitForPermissionResponse').mockResolvedValue(response);
  const internals = server as unknown as {
    messenger: { sendPermissionRequest: () => Promise<unknown> };
    slack: { chat: { delete: () => Promise<unknown> } };
    logger: { info: (...a: unknown[]) => void };
  };
  vi.spyOn(internals.messenger, 'sendPermissionRequest').mockResolvedValue({ ts: '2.000', channel: 'C1' });
  vi.spyOn(internals.slack.chat, 'delete').mockResolvedValue({});
  const info = vi.spyOn(internals.logger, 'info');
  await server.handleTool('permission_prompt', { tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' } });
  return info;
}

describe('permission_prompt outcome line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('logs an answered question: behavior, tool, wait time', async () => {
    const info = await ask({ behavior: 'allow', message: 'Approved by user' });
    expect(info).toHaveBeenCalledWith(
      'Permission prompt outcome',
      expect.objectContaining({ tool: 'Bash', behavior: 'allow', timedOut: false, waitedMs: expect.any(Number) }),
    );
  });

  it('logs a question nobody answered as timed out', async () => {
    const info = await ask({ behavior: 'deny', message: 'Permission request timed out' });
    expect(info).toHaveBeenCalledWith(
      'Permission prompt outcome',
      expect.objectContaining({ behavior: 'deny', timedOut: true }),
    );
  });
});
