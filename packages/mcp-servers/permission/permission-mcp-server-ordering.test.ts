/**
 * The pending approval must be persisted BEFORE the Slack prompt is posted.
 *
 * The action handler only stores a click when the pending record exists and
 * the clicker is its requester (requester-only check). If the prompt is
 * visible before the record is written, a fast click lands in that window, is
 * rejected as "expired/unknown", and the request then times out to deny.
 */

import { sharedStore } from '@soma/process-shared/permission/shared-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('permission_prompt ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('stores the pending approval before posting the prompt, and cleans up if posting fails', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-ordering-test');
    vi.stubEnv('SLACK_CONTEXT', JSON.stringify({ channel: 'C1', threadTs: '1.000', user: 'U1' }));
    const { getPermissionServer } = await import('./permission-mcp-server.js');
    const server = getPermissionServer();

    const calls: string[] = [];
    vi.spyOn(sharedStore, 'storePendingApproval').mockImplementation(async () => {
      calls.push('store');
    });
    const cleanup = vi.spyOn(sharedStore, 'cleanup').mockImplementation(async () => {
      calls.push('cleanup');
    });
    const messenger = (server as unknown as { messenger: { sendPermissionRequest: () => Promise<unknown> } }).messenger;
    vi.spyOn(messenger, 'sendPermissionRequest').mockImplementation(async () => {
      calls.push('post');
      throw new Error('slack down');
    });

    const result = await server.handleTool('permission_prompt', { tool_name: 'Bash', input: { command: 'ls' } });

    expect(calls).toEqual(['store', 'post', 'cleanup']);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ behavior: 'deny' });
  });
});
