import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('somalib/permission/shared-store', () => ({
  sharedStore: {
    storePermissionResponse: vi.fn().mockResolvedValue(undefined),
    getPendingApproval: vi.fn(),
  },
}));

import { sharedStore } from 'somalib/permission/shared-store';
import type { SessionRegistry } from '../../../session-registry';
import { PermissionActionHandler } from '../permission-action-handler';
import type { RespondFn } from '../types';

function makeBody(actionId: string, value: string, userId = 'U_USER') {
  return {
    user: { id: userId },
    actions: [{ action_id: actionId, value }],
  };
}

describe('PermissionActionHandler.handleApproveDisableRule', () => {
  let respond: RespondFn;
  let respondMock: ReturnType<typeof vi.fn>;
  let sessionRegistryMock: {
    getSessionKey: ReturnType<typeof vi.fn>;
    disableDangerousRules: ReturnType<typeof vi.fn>;
  };
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    respondMock = vi.fn().mockResolvedValue(undefined);
    respond = respondMock as unknown as RespondFn;
    sessionRegistryMock = {
      getSessionKey: vi.fn((channel: string, threadTs?: string) => `${channel}-${threadTs ?? ''}`),
      disableDangerousRules: vi.fn(),
    };
    sessionRegistry = sessionRegistryMock as unknown as SessionRegistry;
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

    const handler = new PermissionActionHandler(sessionRegistry);
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_abc'), respond);

    expect(sessionRegistryMock.getSessionKey).toHaveBeenCalledWith('C123', '171.001');
    expect(sessionRegistryMock.disableDangerousRules).toHaveBeenCalledWith('C123-171.001', ['kill']);
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

    const handler = new PermissionActionHandler(sessionRegistry);
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_no_rules'), respond);

    expect(sessionRegistryMock.disableDangerousRules).not.toHaveBeenCalled();
    expect(sharedStore.storePermissionResponse).toHaveBeenCalledWith(
      'approval_no_rules',
      expect.objectContaining({ behavior: 'allow' }),
    );
  });

  it('warns the user ephemerally when the pending approval is missing/expired', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(null);

    const handler = new PermissionActionHandler(sessionRegistry);
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_missing'), respond);

    expect(sessionRegistryMock.disableDangerousRules).not.toHaveBeenCalled();
    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: 'ephemeral', replace_original: false }),
    );
  });

  it('falls back to plain approve when constructed without a SessionRegistry', async () => {
    // The requester check still runs first — the fallback only skips the rule disable.
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue({
      tool_name: 'Bash',
      input: { command: 'kill 1234' },
      channel: 'C123',
      thread_ts: '171.003',
      user: 'U_USER',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      rule_ids: ['kill'],
    });
    const handler = new PermissionActionHandler();
    await handler.handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_no_handler'), respond);

    expect(sharedStore.storePermissionResponse).toHaveBeenCalledWith(
      'approval_no_handler',
      expect.objectContaining({ behavior: 'allow' }),
    );
  });

  it('rejects with ephemeral warning when approvalId is missing', async () => {
    const handler = new PermissionActionHandler(sessionRegistry);
    const body = { user: { id: 'U_USER' }, actions: [{}] };
    await handler.handleApproveDisableRule(body, respond);

    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });
});

/**
 * Click authorization. The prompt is an ordinary thread message
 * (`SlackPermissionMessenger.sendPermissionRequest` → `chat.postMessage`), so
 * every member of the channel sees — and can click — its buttons. Only the
 * user the request was raised for (`PendingApproval.user`, the turn's Slack
 * user) may answer it, matching the other in-thread grant prompts (cron-run
 * and skill permission handlers are owner-bound the same way). Anything else,
 * including an unknown requester or a missing/expired record, fails closed:
 * no response is stored, so the MCP server keeps waiting and times out to deny.
 */
describe('PermissionActionHandler click authorization — requester only', () => {
  const REQUESTER = 'U_REQUESTER';
  const INTRUDER = 'U_INTRUDER';
  let respondMock: ReturnType<typeof vi.fn>;
  let respond: RespondFn;
  let sessionRegistryMock: { getSessionKey: ReturnType<typeof vi.fn>; disableDangerousRules: ReturnType<typeof vi.fn> };

  function pending(overrides: Record<string, unknown> = {}) {
    return {
      tool_name: 'Bash',
      input: { command: 'kill 1234' },
      channel: 'C123',
      thread_ts: '171.001',
      user: REQUESTER,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      rule_ids: ['kill'],
      ...overrides,
    };
  }

  function handler() {
    return new PermissionActionHandler(sessionRegistryMock as unknown as SessionRegistry);
  }

  const simpleActions = [
    { name: 'approve_tool', run: (h: PermissionActionHandler, b: any) => h.handleApprove(b, respond) },
    { name: 'deny_tool', run: (h: PermissionActionHandler, b: any) => h.handleDeny(b, respond) },
    { name: 'explain_tool', run: (h: PermissionActionHandler, b: any) => h.handleExplain(b, respond) },
  ];

  beforeEach(() => {
    respondMock = vi.fn().mockResolvedValue(undefined);
    respond = respondMock as unknown as RespondFn;
    sessionRegistryMock = {
      getSessionKey: vi.fn((channel: string, threadTs?: string) => `work:${channel}:${threadTs ?? 'direct'}`),
      disableDangerousRules: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(simpleActions)('$name from another user stores no response and tells the clicker who may answer', async ({
    name,
    run,
  }) => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(pending());

    await run(handler(), makeBody(name, 'approval_x', INTRUDER));

    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        replace_original: false,
        text: expect.stringContaining(`<@${REQUESTER}>`),
      }),
    );
  });

  it('approve_disable_rule_session from another user neither disables rules nor approves', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(pending());

    await handler().handleApproveDisableRule(makeBody('approve_disable_rule_session', 'approval_x', INTRUDER), respond);

    expect(sessionRegistryMock.disableDangerousRules).not.toHaveBeenCalled();
    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });

  it('approve_disable_rule_session from another user is refused even without a SessionRegistry', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(pending());

    await new PermissionActionHandler().handleApproveDisableRule(
      makeBody('approve_disable_rule_session', 'approval_x', INTRUDER),
      respond,
    );

    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
  });

  it.each(simpleActions)('$name from the requester stores the response', async ({ name, run }) => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(pending());

    await run(handler(), makeBody(name, 'approval_ok', REQUESTER));

    expect(sharedStore.storePermissionResponse).toHaveBeenCalledWith(
      'approval_ok',
      expect.objectContaining({ behavior: name === 'approve_tool' ? 'allow' : 'deny' }),
    );
  });

  it('fails closed when the request records no requester', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(pending({ user: undefined }));

    await handler().handleApprove(makeBody('approve_tool', 'approval_anon', REQUESTER), respond);

    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
  });

  it('fails closed when the click carries no user id', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(pending());

    await handler().handleApprove({ actions: [{ action_id: 'approve_tool', value: 'approval_nouser' }] }, respond);

    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
  });

  it('stores nothing for a missing/expired request and says so ephemerally', async () => {
    vi.mocked(sharedStore.getPendingApproval).mockResolvedValue(null);

    await handler().handleApprove(makeBody('approve_tool', 'approval_gone', REQUESTER), respond);

    expect(sharedStore.storePermissionResponse).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });
});
