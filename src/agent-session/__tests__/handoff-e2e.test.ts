/**
 * Issue #695 — end-to-end smoke test for the z handoff entrypoint flow.
 *
 * Exercises: CONTINUE_SESSION validation → runDispatch parse+persist →
 * SessionRegistry save + reload → handoffContext round-trip.
 *
 * Uses the PUBLIC validator entrypoint (`validateModelCommandRunArgs`) plus
 * a real SessionRegistry and SessionInitializer with a minimal ClaudeHandler
 * double. Slack surface is not exercised here — slack-handler integration is
 * covered in `src/slack-handler.test.ts`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep vi.mock hoisting-safe — inline the path construction.
vi.mock('../../env-paths', () => ({
  DATA_DIR: require('path').join(process.env.TMPDIR ?? require('os').tmpdir(), 'soma-work-handoff-e2e-test'),
}));

import { validateModelCommandRunArgs } from 'somalib/model-commands/validator';
import { SessionRegistry } from '../../session-registry';
import { SessionInitializer } from '../../slack/pipeline/session-initializer';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-handoff-e2e-test');

function planToWorkPayload() {
  const prompt = [
    '$z phase2 https://example.com/issue/42',
    '',
    '<z-handoff type="plan-to-work">',
    '## Issue',
    'https://example.com/issue/42',
    '## Parent Epic',
    'https://example.com/issue/10',
    '## Tier',
    'medium',
    '## Escape Eligible',
    'false',
    '## Issue Required By User',
    'true',
    '## Task List',
    '- [ ] step 1',
    '## Dependency Groups',
    'Group 1: [step-1]',
    '## Per-Task Dispatch Payloads',
    '### step-1',
    'Self-contained subagent prompt for step 1.',
    '</z-handoff>',
  ].join('\n');
  return {
    commandId: 'CONTINUE_SESSION',
    params: {
      prompt,
      resetSession: true,
      dispatchText: 'https://example.com/issue/42',
      forceWorkflow: 'z-plan-to-work',
    },
  };
}

describe('Handoff entrypoint end-to-end (#695)', () => {
  let registry: SessionRegistry;
  let initializer: SessionInitializer;

  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    registry = new SessionRegistry();

    // Minimal ClaudeHandler-like façade that delegates persistence to the
    // real SessionRegistry. runDispatch only needs getSession / getSessionKey
    // / needsDispatch / transitionToMain / saveSessions.
    const claudeHandlerDouble = {
      getSessionKey: (c: string, t: string) => `${c}:${t}`,
      getSession: (c: string, t: string) => registry.getSession(c, t),
      needsDispatch: (c: string, t: string) => registry.needsDispatch(c, t),
      transitionToMain: (c: string, t: string, workflow: any, title?: string) =>
        registry.transitionToMain(c, t, workflow, title),
      saveSessions: () => registry.saveSessions(),
    };

    initializer = new SessionInitializer({
      claudeHandler: claudeHandlerDouble as any,
      slackApi: {} as any,
      messageValidator: {} as any,
      workingDirManager: {} as any,
      reactionManager: {} as any,
      contextWindowManager: {} as any,
      requestCoordinator: {} as any,
    });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('accepts CONTINUE_SESSION → runDispatch persists handoffContext → SessionRegistry round-trips it', async () => {
    const payload = planToWorkPayload();

    // 1. Public validator entrypoint accepts payload.
    const validation = validateModelCommandRunArgs(payload);
    expect(validation.ok).toBe(true);

    // 2. Prime a live session, then mirror the slack-handler reset flow
    // (resetSessionContext → runDispatch) instead of mutating internals.
    const session = registry.createSession('U1', 'Tester', 'C1', '999.001');
    session.sessionId = 'prior-conversation-id';
    registry.transitionToMain('C1', '999.001', 'default', 'prior title');
    registry.resetSessionContext('C1', '999.001');
    void session; // reset went through the registry; we re-fetch below

    // 3. Run the dispatch flow as slack-handler onResetSession would.
    await initializer.runDispatch(
      'C1',
      '999.001',
      payload.params.dispatchText,
      'z-plan-to-work',
      payload.params.prompt,
    );

    // 4. In-memory assertions.
    const inMemory = registry.getSession('C1', '999.001');
    expect(inMemory?.workflow).toBe('z-plan-to-work');
    expect(inMemory?.state).toBe('MAIN');
    expect(inMemory?.handoffContext?.handoffKind).toBe('plan-to-work');
    expect(inMemory?.handoffContext?.sourceIssueUrl).toBe('https://example.com/issue/42');
    expect(inMemory?.handoffContext?.parentEpicUrl).toBe('https://example.com/issue/10');
    expect(inMemory?.handoffContext?.tier).toBe('medium');
    expect(inMemory?.handoffContext?.hopBudget).toBe(1);
    expect(inMemory?.handoffContext?.chainId).toMatch(/.+/);

    // 5. Force save (runDispatch already saved once; saveSessions is idempotent).
    registry.saveSessions();

    // 6. Reload from disk via a fresh registry instance.
    const reloadedRegistry = new SessionRegistry();
    const loaded = reloadedRegistry.loadSessions();
    expect(loaded).toBeGreaterThanOrEqual(1);
    const reloaded = reloadedRegistry.getSession('C1', '999.001');
    expect(reloaded?.handoffContext).toEqual(inMemory?.handoffContext);
    expect(reloaded?.workflow).toBe('z-plan-to-work');
  });

  it('validator rejects type-workflow mismatch before runtime', () => {
    const payload = planToWorkPayload();
    (payload.params as any).forceWorkflow = 'z-epic-update';

    const validation = validateModelCommandRunArgs(payload);
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error('unreachable');
    expect(validation.error.message).toContain('work-complete');
    expect(validation.error.message).toContain('plan-to-work');
  });

  it('validator rejects missing sentinel before runtime', () => {
    const payload = planToWorkPayload();
    (payload.params as any).prompt = 'plain prompt with no sentinel';

    const validation = validateModelCommandRunArgs(payload);
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error('unreachable');
    expect(validation.error.message).toContain('<z-handoff>');
  });
});
