/**
 * SSOT_2 #3 (T8.2/T8.3): one warning event → the Slack thread card and the
 * dashboard work-log entry. The two are independent: Slack failing still records
 * the dashboard entry, and nothing here throws back into the hook.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PermissionWarningEvent } from '../../agent-runtime/policy/permission-warning';
import { publishPermissionWarning } from '../permission-warning-publisher';

const WARNING: PermissionWarningEvent = {
  user: 'U1',
  channel: 'C1',
  threadTs: '1700000000.0001',
  conversationId: 'conv-1',
  toolName: 'Bash',
  toolInput: { command: 'kill 4242' },
  command: 'kill 4242',
  rules: [{ id: 'kill', label: 'kill process', description: 'Sends a signal' }],
  reason: 'owner asked to stop the preview server',
};

describe('publishPermissionWarning', () => {
  it('posts the buttonless warning card into the thread and records the dashboard entry', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '1.2' });
    const recordWorkLog = vi.fn();
    await publishPermissionWarning(WARNING, { postMessage, recordWorkLog });

    expect(postMessage).toHaveBeenCalledOnce();
    const [channel, text, options] = postMessage.mock.calls[0];
    expect(channel).toBe('C1');
    expect(text).toContain('Permission warning');
    expect(options.threadTs).toBe('1700000000.0001');
    expect(options.blocks[0].text.text).toBe('⚠️ Permission Warning — Bash');
    expect(options.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(false);

    expect(recordWorkLog).toHaveBeenCalledWith('conv-1', {
      kind: 'permission_warning',
      text: 'kill 4242',
      tool: 'Bash',
      // Review gate r2 (fable P3): the row always opens to the full command.
      raw: 'kill 4242',
      warning: { rules: WARNING.rules, reason: WARNING.reason },
    });
  });

  it('still records the dashboard entry when Slack fails, and does not throw', async () => {
    const recordWorkLog = vi.fn();
    await expect(
      publishPermissionWarning(WARNING, {
        postMessage: vi.fn().mockRejectedValue(new Error('ratelimited')),
        recordWorkLog,
      }),
    ).resolves.toBeUndefined();
    expect(recordWorkLog).toHaveBeenCalledOnce();
  });

  it('posts to Slack only when the session has no dashboard conversation', async () => {
    const postMessage = vi.fn().mockResolvedValue({});
    const recordWorkLog = vi.fn();
    await publishPermissionWarning({ ...WARNING, conversationId: undefined }, { postMessage, recordWorkLog });
    expect(postMessage).toHaveBeenCalledOnce();
    expect(recordWorkLog).not.toHaveBeenCalled();
  });
});
