import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect the store's persistence into a temp dir so the handler tests
// don't spam errors trying to write to the production data dir.
vi.mock('../../../env-paths', () => ({
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'instr-confirm-handler-')),
}));

import type { ClaudeHandler } from '../../../claude-handler';
import type { ConversationSession, SessionResourceUpdateRequest } from '../../../types';
import type { SlackApiHelper } from '../../slack-api-helper';
import { InstructionConfirmActionHandler } from '../instruction-confirm-action-handler';
import { PendingInstructionConfirmStore } from '../pending-instruction-confirm-store';

function mkSession(partial: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U1',
    userId: 'U1',
    channelId: 'C1',
    threadTs: 'T1',
    isActive: true,
    lastActivity: new Date(),
    systemPrompt: 'cached-prompt',
    ...partial,
  } as ConversationSession;
}

function mkHandler() {
  const session = mkSession();
  // #755: handleYes routes through applyConfirmedLifecycle (sealed
  // one-tx). updateSessionResources is no longer the y-confirm seam.
  const applyConfirmedLifecycle = vi.fn(() => ({ ok: true, instructionId: 'instr-test' }));
  const recordRejectedLifecycle = vi.fn();
  const recordSupersededLifecycle = vi.fn();
  const getSessionByKey = vi.fn(() => session);
  const slackApi = {
    updateMessage: vi.fn(async () => {}),
  } as unknown as SlackApiHelper;
  const claudeHandler = {
    applyConfirmedLifecycle,
    recordRejectedLifecycle,
    recordSupersededLifecycle,
    getSessionByKey,
  } as unknown as ClaudeHandler;
  const store = new PendingInstructionConfirmStore();
  const handler = new InstructionConfirmActionHandler({ slackApi, claudeHandler, store });
  return {
    handler,
    session,
    store,
    claudeHandler,
    slackApi,
    applyConfirmedLifecycle,
    recordRejectedLifecycle,
    recordSupersededLifecycle,
    getSessionByKey,
  };
}

function mkRequest(): SessionResourceUpdateRequest {
  return { instructionOperations: [{ action: 'add', text: 'x' }] };
}

const respond = vi.fn(async () => {});

describe('InstructionConfirmActionHandler', () => {
  beforeEach(() => respond.mockClear());

  it('handleYes commits the request via applyConfirmedLifecycle, clears systemPrompt, updates the Slack message, deletes the entry', async () => {
    const { handler, session, store, slackApi, applyConfirmedLifecycle } = mkHandler();
    store.set({
      requestId: 'r1',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-1',
      request: mkRequest(),
      createdAt: Date.now(),
      requesterId: 'U1',
      type: 'add',
      by: { type: 'slack-user', id: 'U1' },
    });

    await handler.handleYes(
      { user: { id: 'U1' }, actions: [{ action_id: 'instr_confirm_y:r1', value: 'r1' }] },
      respond,
    );

    expect(applyConfirmedLifecycle).toHaveBeenCalledTimes(1);
    const metaArg = (applyConfirmedLifecycle.mock.calls[0] as unknown[])[1] as {
      requestId: string;
      type: string;
      by: { type: string; id: string };
    };
    expect(metaArg.requestId).toBe('r1');
    expect(metaArg.type).toBe('add');
    expect(metaArg.by).toEqual({ type: 'slack-user', id: 'U1' });
    expect(session.systemPrompt).toBeUndefined();
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(store.get('r1')).toBeUndefined();
  });

  it('handleNo sets pendingInstructionRejection, records rejected lifecycle, updates the Slack message, deletes the entry', async () => {
    const { handler, session, store, slackApi, recordRejectedLifecycle } = mkHandler();
    store.set({
      requestId: 'r2',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-2',
      request: mkRequest(),
      createdAt: Date.now(),
      requesterId: 'U1',
      type: 'add',
      by: { type: 'slack-user', id: 'U1' },
    });

    await handler.handleNo(
      { user: { id: 'U1' }, actions: [{ action_id: 'instr_confirm_n:r2', value: 'r2' }] },
      respond,
    );

    expect(session.pendingInstructionRejection).toBeDefined();
    expect(session.pendingInstructionRejection?.request.instructionOperations?.length).toBe(1);
    expect(recordRejectedLifecycle).toHaveBeenCalledTimes(1);
    const rejMeta = (recordRejectedLifecycle.mock.calls[0] as unknown[])[1] as {
      requestId: string;
      type: string;
    };
    expect(rejMeta.requestId).toBe('r2');
    expect(rejMeta.type).toBe('add');
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(store.get('r2')).toBeUndefined();
  });

  it('handleYes bails out when clicker is not the session owner', async () => {
    const { handler, session, store, applyConfirmedLifecycle } = mkHandler();
    store.set({
      requestId: 'r3',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-3',
      request: mkRequest(),
      createdAt: Date.now(),
      requesterId: 'U1',
      type: 'add',
      by: { type: 'slack-user', id: 'U1' },
    });

    await handler.handleYes(
      { user: { id: 'U-attacker' }, actions: [{ action_id: 'instr_confirm_y:r3', value: 'r3' }] },
      respond,
    );

    expect(applyConfirmedLifecycle).not.toHaveBeenCalled();
    expect(session.systemPrompt).toBe('cached-prompt');
    // Entry should still exist — the owner can still click later.
    expect(store.get('r3')).toBeDefined();
  });

  it('handleYes rejects a drifted currentInitiatorId even when session.currentInitiatorId now matches clicker', async () => {
    // Regression guard: before we snapshotted `requesterId` into the store,
    // a newer turn could flip `session.currentInitiatorId` to the attacker
    // and let that attacker approve someone else's pending write. The
    // entry's own requesterId ('U-original') is the only trusted anchor.
    const { handler, session, store, applyConfirmedLifecycle } = mkHandler();
    session.currentInitiatorId = 'U-attacker';
    store.set({
      requestId: 'r-drift',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-drift',
      request: mkRequest(),
      createdAt: Date.now(),
      requesterId: 'U-original',
      type: 'add',
      by: { type: 'slack-user', id: 'U-original' },
    });

    await handler.handleYes(
      { user: { id: 'U-attacker' }, actions: [{ action_id: 'instr_confirm_y:r-drift', value: 'r-drift' }] },
      respond,
    );

    expect(applyConfirmedLifecycle).not.toHaveBeenCalled();
    expect(session.systemPrompt).toBe('cached-prompt');
    expect(store.get('r-drift')).toBeDefined();
  });

  it('handleYes is a no-op for an unknown requestId', async () => {
    const { handler, applyConfirmedLifecycle } = mkHandler();
    await handler.handleYes(
      { user: { id: 'U1' }, actions: [{ action_id: 'instr_confirm_y:missing', value: 'missing' }] },
      respond,
    );
    expect(applyConfirmedLifecycle).not.toHaveBeenCalled();
  });
});
