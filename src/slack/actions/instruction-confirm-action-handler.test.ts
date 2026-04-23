import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect the store's persistence into a temp dir so the handler tests
// don't spam errors trying to write to the production data dir.
vi.mock('../../env-paths', () => ({
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'instr-confirm-handler-')),
}));

import type { ClaudeHandler } from '../../claude-handler';
import type { ConversationSession, SessionResourceUpdateRequest } from '../../types';
import type { SlackApiHelper } from '../slack-api-helper';
import { InstructionConfirmActionHandler } from './instruction-confirm-action-handler';
import { PendingInstructionConfirmStore } from './pending-instruction-confirm-store';

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
  const updateSessionResources = vi.fn(() => ({
    ok: true,
    snapshot: { issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 1 },
  }));
  const getSessionByKey = vi.fn(() => session);
  const slackApi = {
    updateMessage: vi.fn(async () => {}),
  } as unknown as SlackApiHelper;
  const claudeHandler = {
    updateSessionResources,
    getSessionByKey,
  } as unknown as ClaudeHandler;
  const store = new PendingInstructionConfirmStore();
  const handler = new InstructionConfirmActionHandler({ slackApi, claudeHandler, store });
  return { handler, session, store, claudeHandler, slackApi, updateSessionResources, getSessionByKey };
}

function mkRequest(): SessionResourceUpdateRequest {
  return { instructionOperations: [{ action: 'add', text: 'x' }] };
}

const respond = vi.fn(async () => {});

describe('InstructionConfirmActionHandler', () => {
  beforeEach(() => respond.mockClear());

  it('handleYes commits the request, clears systemPrompt, updates the Slack message, deletes the entry', async () => {
    const { handler, session, store, slackApi, updateSessionResources } = mkHandler();
    store.set({
      requestId: 'r1',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-1',
      request: mkRequest(),
      createdAt: Date.now(),
    });

    await handler.handleYes(
      { user: { id: 'U1' }, actions: [{ action_id: 'instr_confirm_y:r1', value: 'r1' }] },
      respond,
    );

    expect(updateSessionResources).toHaveBeenCalledTimes(1);
    expect(session.systemPrompt).toBeUndefined();
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(store.get('r1')).toBeUndefined();
  });

  it('handleNo sets pendingInstructionRejection, updates the Slack message, deletes the entry', async () => {
    const { handler, session, store, slackApi } = mkHandler();
    store.set({
      requestId: 'r2',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-2',
      request: mkRequest(),
      createdAt: Date.now(),
    });

    await handler.handleNo(
      { user: { id: 'U1' }, actions: [{ action_id: 'instr_confirm_n:r2', value: 'r2' }] },
      respond,
    );

    expect(session.pendingInstructionRejection).toBeDefined();
    expect(session.pendingInstructionRejection?.request.instructionOperations?.length).toBe(1);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(store.get('r2')).toBeUndefined();
  });

  it('handleYes bails out when clicker is not the session owner', async () => {
    const { handler, session, store, updateSessionResources } = mkHandler();
    store.set({
      requestId: 'r3',
      sessionKey: 'C1|T1',
      channelId: 'C1',
      threadTs: 'T1',
      messageTs: 'ts-3',
      request: mkRequest(),
      createdAt: Date.now(),
    });

    await handler.handleYes(
      { user: { id: 'U-attacker' }, actions: [{ action_id: 'instr_confirm_y:r3', value: 'r3' }] },
      respond,
    );

    expect(updateSessionResources).not.toHaveBeenCalled();
    expect(session.systemPrompt).toBe('cached-prompt');
    // Entry should still exist — the owner can still click later.
    expect(store.get('r3')).toBeDefined();
  });

  it('handleYes is a no-op for an unknown requestId', async () => {
    const { handler, updateSessionResources } = mkHandler();
    await handler.handleYes(
      { user: { id: 'U1' }, actions: [{ action_id: 'instr_confirm_y:missing', value: 'missing' }] },
      respond,
    );
    expect(updateSessionResources).not.toHaveBeenCalled();
  });
});
