/**
 * Dashboard lifecycle-propose handler (#758 PR4 fix loop #2 P1).
 *
 * The dashboard `[⋯]` menu posts to
 *   POST /api/dashboard/instructions/:id/propose-lifecycle
 * which forwards to a host-supplied `lifecycleProposeHandler`. Pre-fix the
 * production handler in `src/index.ts` synthesised a malformed pending entry:
 *   - `payload.instructionOperations` was missing → `applyConfirmedLifecycle`
 *     built `ops = []` → `INVALID_OP` on the user's y-click.
 *   - `by.type` was `'user'`, NOT in the sealed enum
 *     (`'slack-user' | 'system' | 'migration'`) → audit row malformed.
 *   - No Slack y/n message was posted → user could never confirm.
 *
 * This suite drives a module-level factory `createDashboardLifecycleProposeHandler`
 * which the production wiring uses. The factory takes minimal duck-typed
 * deps so we can drive it without booting the whole app.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-dash-propose-boot-'));
  return { dir };
});

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return state.dir;
  },
}));

import { createDashboardLifecycleProposeHandler } from '../dashboard-lifecycle-propose';
import { SessionRegistry } from '../session-registry';
import { PendingInstructionConfirmStore } from '../slack/actions/pending-instruction-confirm-store';
import { initUserSessionStore, type UserSessionDoc } from '../user-session-store';

let TEST_DATA_DIR: string;

beforeEach(() => {
  TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-dash-propose-'));
  state.dir = TEST_DATA_DIR;
  initUserSessionStore(TEST_DATA_DIR);
});

afterEach(() => {
  if (TEST_DATA_DIR && fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

function writeUserDoc(userId: string, doc: UserSessionDoc): void {
  const userDir = path.join(TEST_DATA_DIR, 'users', userId);
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'user-session.json'), JSON.stringify(doc, null, 2));
}

describe('createDashboardLifecycleProposeHandler — sealed pending shape (#758 PR4)', () => {
  it('complete: writes pending entry with instructionOperations + by.type=slack-user, posts Slack y/n', async () => {
    const userId = 'U-dash-complete';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-X',
          text: 'ship the dashboard',
          status: 'active',
          linkedSessionIds: ['C-A:T-A'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    // The handler resolves the channelId/threadTs from the linked session
    // so it can post the y/n message in the original Slack thread.
    reg.createSession(userId, 'Tester', 'C-A', 'T-A');
    const sessionKey = reg.getSessionKey('C-A', 'T-A');

    const store = new PendingInstructionConfirmStore();

    const postedMessages: Array<{ channel: string; text: string; options: any }> = [];
    const slackApi = {
      postMessage: vi.fn(async (channel: string, text: string, options: any) => {
        postedMessages.push({ channel, text, options });
        return { ts: 'ts-xyz', channel };
      }),
    };

    const handler = createDashboardLifecycleProposeHandler({
      pendingStore: store,
      sessionRegistry: reg,
      slackApi: slackApi as any,
    });

    const result = await handler({
      userId,
      instructionId: 'inst-X',
      op: 'complete',
    });

    expect(result.requestId).toMatch(/^dash-/);

    const entry = store.get(result.requestId);
    expect(entry).toBeDefined();
    if (!entry) throw new Error('entry missing');
    // Sealed actor: dashboard click is a slack-authenticated user.
    expect(entry.by).toEqual({ type: 'slack-user', id: userId });
    // Sealed payload: instructionOperations carries the action for the tx.
    expect(entry.payload.instructionOperations).toEqual([
      { action: 'complete', id: 'inst-X', evidence: expect.any(String) },
    ]);
    // sessionKey resolved to the instruction's first linked session.
    expect(entry.sessionKey).toBe(sessionKey);
    // Pending lifecycle type matches op.
    expect(entry.type).toBe('complete');

    // Slack post was made on the linked session's thread.
    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(postedMessages[0].channel).toBe('C-A');
    expect(postedMessages[0].options.threadTs).toBe('T-A');
    // The post had y/n action buttons (blocks) so the user can click.
    expect(Array.isArray(postedMessages[0].options.blocks)).toBe(true);
    expect(entry.messageTs).toBe('ts-xyz');

    // Critical: the resulting pending entry must apply cleanly. Pre-fix the
    // tx returned INVALID_OP because instructionOperations was missing.
    const session = reg.getSessionByKey(sessionKey);
    if (!session) throw new Error('session missing');
    const applyResult = reg.applyConfirmedLifecycle(session, {
      requestId: entry.requestId,
      type: entry.type,
      by: entry.by,
      ops: entry.payload.instructionOperations ?? [],
    });
    expect(applyResult.ok).toBe(true);
    expect(applyResult.reason).not.toBe('INVALID_OP');
  });

  it('cancel: pending entry has cancel op, applyConfirmedLifecycle succeeds', async () => {
    const userId = 'U-dash-cancel';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-Y',
          text: 'feature stub',
          status: 'active',
          linkedSessionIds: ['C-B:T-B'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    reg.createSession(userId, 'Tester', 'C-B', 'T-B');
    const sessionKey = reg.getSessionKey('C-B', 'T-B');
    const store = new PendingInstructionConfirmStore();
    const slackApi = {
      postMessage: vi.fn(async () => ({ ts: 'ts-cancel', channel: 'C-B' })),
    };

    const handler = createDashboardLifecycleProposeHandler({
      pendingStore: store,
      sessionRegistry: reg,
      slackApi: slackApi as any,
    });

    const result = await handler({
      userId,
      instructionId: 'inst-Y',
      op: 'cancel',
    });

    const entry = store.get(result.requestId);
    if (!entry) throw new Error('entry missing');
    expect(entry.payload.instructionOperations).toEqual([{ action: 'cancel', id: 'inst-Y' }]);

    const session = reg.getSessionByKey(sessionKey);
    if (!session) throw new Error('session missing');
    const applyResult = reg.applyConfirmedLifecycle(session, {
      requestId: entry.requestId,
      type: entry.type,
      by: entry.by,
      ops: entry.payload.instructionOperations ?? [],
    });
    expect(applyResult.ok).toBe(true);
  });

  it('rename: pending entry carries new text in op, applyConfirmedLifecycle succeeds', async () => {
    const userId = 'U-dash-rename';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-Z',
          text: 'old',
          status: 'active',
          linkedSessionIds: ['C-C:T-C'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    reg.createSession(userId, 'Tester', 'C-C', 'T-C');
    const sessionKey = reg.getSessionKey('C-C', 'T-C');
    const store = new PendingInstructionConfirmStore();
    const slackApi = {
      postMessage: vi.fn(async () => ({ ts: 'ts-rename', channel: 'C-C' })),
    };

    const handler = createDashboardLifecycleProposeHandler({
      pendingStore: store,
      sessionRegistry: reg,
      slackApi: slackApi as any,
    });

    const result = await handler({
      userId,
      instructionId: 'inst-Z',
      op: 'rename',
      payload: { text: 'new title' },
    });

    const entry = store.get(result.requestId);
    if (!entry) throw new Error('entry missing');
    expect(entry.payload.instructionOperations).toEqual([
      { action: 'rename', id: 'inst-Z', text: 'new title' },
    ]);

    const session = reg.getSessionByKey(sessionKey);
    if (!session) throw new Error('session missing');
    const applyResult = reg.applyConfirmedLifecycle(session, {
      requestId: entry.requestId,
      type: entry.type,
      by: entry.by,
      ops: entry.payload.instructionOperations ?? [],
    });
    expect(applyResult.ok).toBe(true);
  });

  it('returns 501-equivalent error when instruction has no linked session (no thread to post to)', async () => {
    const userId = 'U-no-thread';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-NL',
          text: 'orphan',
          status: 'active',
          linkedSessionIds: [],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });
    const reg = new SessionRegistry();
    const store = new PendingInstructionConfirmStore();
    const slackApi = { postMessage: vi.fn() };

    const handler = createDashboardLifecycleProposeHandler({
      pendingStore: store,
      sessionRegistry: reg,
      slackApi: slackApi as any,
    });

    await expect(
      handler({ userId, instructionId: 'inst-NL', op: 'complete' }),
    ).rejects.toThrow(/no linked session|cannot post/i);
    // No silent pending entry on failure — the dashboard caller surfaces 5xx.
    expect(store.list()).toHaveLength(0);
  });
});
