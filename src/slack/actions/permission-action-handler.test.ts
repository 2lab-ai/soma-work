import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared-store', () => ({
  sharedStore: {
    storePermissionResponse: vi.fn().mockResolvedValue(undefined),
    getPendingApproval: vi.fn(),
  },
}));

import type { ClaudeHandler } from '../../claude-handler';
import { sharedStore } from '../../shared-store';
import { PermissionActionHandler } from './permission-action-handler';
import type { RespondFn } from './types';

function makeBody(actionId: string, value: string, userId = 'U_USER') {
  return {
    user: { id: userId },
    actions: [{ action_id: actionId, value }],
  };
}

describe('PermissionActionHandler.handleApproveDisableRule', () => {
  let respond: RespondFn;
  let respondMock: ReturnType<typeof vi.fn>;
  let sessionRegistry: {
    getSessionKey: ReturnType<typeof vi.fn>;
    disableDangerousRules: ReturnType<typeof vi.fn>;
  };
  let claudeHandler: Pick<ClaudeHandler, 'getSessionRegistry'>;

  beforeEach(() => {
    respondMock = vi.fn().mockResolvedValue(undefined);
    respond = respondMock as unknown as RespondFn;
    sessionRegistry = {
      getSessionKey: vi.fn((channel: string, threadTs?: string) => `${channel}-${threadTs ?? ''}`),
      disableDangerousRules: vi.fn(),
    };
    claudeHandler = {
      getSessionRegistry: vi.fn(() => sessionRegistry as unknown as ReturnType<ClaudeHandler['getSessionRegistry']>),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('approves and disables the matched rule ids on the session', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue({
      tool_name: 'Bash',
      input: { command: 'kill 1234' },
      channel: 'C123',
      thread_ts: '171.001',
      user: 'U_USER',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      rule_ids: ['kill'],
    });

    const handler = new PermissionActionHandler(claudeHandler as unknown as ClaudeHandler);
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_abc'), respond);

    expect(sessionRegistry.getSessionKey).toHaveBeenCalledWith('C123', '171.001');
    expect(sessionRegistry.disableDangerousRules).toHaveBeenCalledWith('C123-171.001', ['kill']);
    expect(sharedStore.storePermissionResponse).toHaveBeenCalledWith(
      'approval_abc',
      expect.objectContaining({ behavior: 'allow' }),
    );
  });

  it('falls back to plain approve when pending approval has no rule_ids', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue({
      tool_name: 'Bash',
      input: { command: 'ls' },
      channel: 'C123',
      thread_ts: '171.002',
      user: 'U_USER',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });

    const handler = new PermissionActionHandler(claudeHandler as unknown as ClaudeHandler);
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_no_rules'), respond);

    expect(sessionRegistry.disableDangerousRules).not.toHaveBeenCalled();
    expect(sharedStore.storePermissionResponse).toHaveBeenCalledWith(
      'approval_no_rules',
      expect.objectContaining({ behavior: 'allow' }),
    );
  });

  it('warns the user ephemerally when the pending approval is missing/expired', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(null);

    const handler = new PermissionActionHandler(claudeHandler as unknown as ClaudeHandler);
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_missing'), respond);

    expect(sessionRegistry.disableDangerousRules).not.toHaveBeenCalled();
    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', replace_original: false }),
    );
  });

  it('falls back to plain approve when constructed without a ClaudeHandler', async () => {
    const handler = new PermissionActionHandler();
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_no_handler'), respond);

    expect(sharedStore.getPendingApproval).not.toHaveBeenCalled();
    expect(sharedStore.storePermissionResponse).toHaveBeenCalledWith(
      'approval_no_handler',
      expect.objectContaining({ behavior: 'allow' }),
    );
  });

  it('rejects with ephemeral warning when approvalId is missing', async () => {
    const handler = new PermissionActionHandler(claudeHandler as unknown as ClaudeHandler);
    const body = { user: { id: 'U_USER' }, actions: [{}] };
    await handler.handleApproveDisableRule(body, respond);

    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });
});
