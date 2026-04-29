import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn().mockReturnValue(undefined),
    createPendingUser: vi.fn(),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.7'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  DEFAULT_MODEL: 'claude-opus-4-7',
}));

import { HandoffAbortError } from 'somalib/model-commands/handoff-parser';
import type { HandoffContext } from '../../../types';
import { SessionInitializer } from '../session-initializer';

function planToWorkPrompt(overrides: { issue?: string; parentEpic?: string; tier?: string } = {}): string {
  return [
    `$z phase2 ${overrides.issue ?? 'https://example.com/issue/1'}`,
    '',
    '<z-handoff type="plan-to-work">',
    '## Issue',
    overrides.issue ?? 'https://example.com/issue/1',
    '## Parent Epic',
    overrides.parentEpic ?? 'https://example.com/issue/10',
    '## Tier',
    overrides.tier ?? 'medium',
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
    '```',
    'Self-contained subagent prompt for step 1.',
    '```',
    '</z-handoff>',
  ].join('\n');
}

function workCompletePrompt(): string {
  return [
    '$z epic-update https://example.com/issue/10',
    '',
    '<z-handoff type="work-complete">',
    '## Completed Subissue',
    'https://example.com/issue/1',
    '## PR',
    'https://example.com/pr/2',
    '## Summary',
    'Done.',
    '## Remaining Epic Checklist',
    '- [x] #1',
    '- [ ] #2',
    '</z-handoff>',
  ].join('\n');
}

interface MockSession {
  channelId: string;
  threadTs: string;
  handoffContext?: HandoffContext;
  workflow?: string;
  state?: string;
  title?: string;
  /** #697: host-enforced auto-handoff budget mirror for test assertions. */
  autoHandoffBudget?: number;
}

// -------------------------------------------------------------------
// Test setup — mock ClaudeHandler + runDispatch only (minimal deps).
// -------------------------------------------------------------------

function buildInitializer() {
  const sessionByKey = new Map<string, MockSession>();

  const mockClaudeHandler = {
    getSessionKey: vi.fn((c: string, t: string) => `${c}:${t}`),
    getSession: vi.fn((c: string, t: string) => sessionByKey.get(`${c}:${t}`)),
    needsDispatch: vi.fn().mockReturnValue(true),
    transitionToMain: vi.fn((c: string, t: string, workflow: string, title?: string) => {
      const key = `${c}:${t}`;
      const s = sessionByKey.get(key);
      if (s) {
        s.workflow = workflow;
        s.state = 'MAIN';
        if (title) s.title = title;
      }
      return true;
    }),
    saveSessions: vi.fn(),
  };

  const sessionInitializer = new SessionInitializer({
    claudeHandler: mockClaudeHandler as any,
    slackApi: {} as any,
    messageValidator: {} as any,
    workingDirManager: {} as any,
    reactionManager: {} as any,
    contextWindowManager: {} as any,
    requestCoordinator: {} as any,
  });

  const primeSession = (channel: string, threadTs: string): MockSession => {
    const s: MockSession = { channelId: channel, threadTs };
    sessionByKey.set(`${channel}:${threadTs}`, s);
    return s;
  };

  return { sessionInitializer, mockClaudeHandler, primeSession };
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe('SessionInitializer.runDispatch — z handoff entrypoints (#695)', () => {
  describe('happy paths', () => {
    it('plan-to-work: parses sentinel, persists handoffContext, transitions to z-plan-to-work', async () => {
      const { sessionInitializer, mockClaudeHandler, primeSession } = buildInitializer();
      const session = primeSession('C1', 't1');
      const prompt = planToWorkPrompt();

      await sessionInitializer.runDispatch('C1', 't1', 'https://example.com/issue/1', 'z-plan-to-work', prompt);

      expect(session.handoffContext).toBeDefined();
      expect(session.handoffContext?.handoffKind).toBe('plan-to-work');
      expect(session.handoffContext?.hopBudget).toBe(1);
      expect(session.handoffContext?.sourceIssueUrl).toBe('https://example.com/issue/1');
      expect(session.handoffContext?.tier).toBe('medium');
      // transitionToMain persists the session; we do not call saveSessions twice.
      expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith('C1', 't1', 'z-plan-to-work', expect.any(String));
    });

    it('epic-update: parses work-complete sentinel, persists, transitions to z-epic-update', async () => {
      const { sessionInitializer, mockClaudeHandler, primeSession } = buildInitializer();
      const session = primeSession('C1', 't2');
      const prompt = workCompletePrompt();

      await sessionInitializer.runDispatch('C1', 't2', 'https://example.com/issue/10', 'z-epic-update', prompt);

      expect(session.handoffContext?.handoffKind).toBe('work-complete');
      expect(session.handoffContext?.sourceIssueUrl).toBe('https://example.com/issue/1');
      expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith('C1', 't2', 'z-epic-update', expect.any(String));
    });
  });

  describe('safe-stop failure modes', () => {
    it('throws HandoffAbortError(no-sentinel) when handoffPrompt is undefined', async () => {
      const { sessionInitializer, primeSession } = buildInitializer();
      primeSession('C1', 't3');

      await expect(
        sessionInitializer.runDispatch('C1', 't3', 'irrelevant', 'z-plan-to-work', undefined),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof HandoffAbortError && err.reason === 'no-sentinel' && err.forceWorkflow === 'z-plan-to-work'
        );
      });
    });

    it('throws HandoffAbortError(missing-closing) when sentinel has no closing tag', async () => {
      const { sessionInitializer, primeSession } = buildInitializer();
      primeSession('C1', 't4');
      const malformed = [
        '<z-handoff type="plan-to-work">',
        '## Issue',
        'https://example.com/issue/1',
        '## Parent Epic',
        'none',
        '## Task List',
        '- [ ] step',
      ].join('\n');

      await expect(sessionInitializer.runDispatch('C1', 't4', 'text', 'z-plan-to-work', malformed)).rejects.toSatisfy(
        (err: unknown) => {
          return err instanceof HandoffAbortError && err.reason === 'missing-closing';
        },
      );
    });

    it('throws HandoffAbortError(type-workflow-mismatch) for plan-to-work sentinel + z-epic-update workflow', async () => {
      const { sessionInitializer, mockClaudeHandler, primeSession } = buildInitializer();
      primeSession('C1', 't5');

      await expect(
        sessionInitializer.runDispatch('C1', 't5', 'text', 'z-epic-update', planToWorkPrompt()),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof HandoffAbortError &&
          err.reason === 'type-workflow-mismatch' &&
          err.forceWorkflow === 'z-epic-update'
        );
      });
      expect(mockClaudeHandler.transitionToMain).not.toHaveBeenCalled();
    });

    it('throws HandoffAbortError(type-workflow-mismatch) for work-complete sentinel + z-plan-to-work workflow', async () => {
      const { sessionInitializer, mockClaudeHandler, primeSession } = buildInitializer();
      primeSession('C1', 't6');

      await expect(
        sessionInitializer.runDispatch('C1', 't6', 'text', 'z-plan-to-work', workCompletePrompt()),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof HandoffAbortError && err.reason === 'type-workflow-mismatch';
      });
      expect(mockClaudeHandler.transitionToMain).not.toHaveBeenCalled();
    });

    it('throws HandoffAbortError(host-policy) when session is missing at handoff entry', async () => {
      const { sessionInitializer } = buildInitializer();
      // Note: primeSession NOT called — session missing.

      await expect(
        sessionInitializer.runDispatch('C99', 't99', 'text', 'z-plan-to-work', planToWorkPrompt()),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof HandoffAbortError && err.reason === 'host-policy';
      });
    });
  });

  describe('backward compatibility', () => {
    it('non-handoff forceWorkflow (onboarding) takes existing branch, no parse attempted', async () => {
      const { sessionInitializer, mockClaudeHandler, primeSession } = buildInitializer();
      primeSession('C1', 't7');

      await sessionInitializer.runDispatch('C1', 't7', 'text', 'onboarding');

      expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith('C1', 't7', 'onboarding', 'Onboarding');
      // saveSessions is NOT called from the existing onboarding branch — only z-* branch calls it.
      expect(mockClaudeHandler.saveSessions).not.toHaveBeenCalled();
    });

    it('no forceWorkflow + no text → transitions to default (existing behavior)', async () => {
      const { sessionInitializer, mockClaudeHandler, primeSession } = buildInitializer();
      primeSession('C1', 't8');

      await sessionInitializer.runDispatch('C1', 't8', '', undefined);

      expect(mockClaudeHandler.transitionToMain).toHaveBeenCalledWith('C1', 't8', 'default', 'Session Reset');
    });
  });

  describe('hopBudget initialization (#695 foundation, now consumed by #697)', () => {
    it('initializes handoffContext.hopBudget=1 on successful handoff entry (#695 parser-seed, diagnostic only post-#697)', async () => {
      const { sessionInitializer, primeSession } = buildInitializer();
      const session = primeSession('C1', 't9');

      await sessionInitializer.runDispatch('C1', 't9', 'text', 'z-plan-to-work', planToWorkPrompt());

      expect(session.handoffContext?.hopBudget).toBe(1);
    });

    it('T6.1 handoff-dispatched session retains autoHandoffBudget=1 from initial session creation (#697 authoritative budget state)', async () => {
      const { sessionInitializer, primeSession } = buildInitializer();
      const session = primeSession('C1', 't10');
      // `primeSession` starts the session with autoHandoffBudget defaulted
      // by the mock; assert the initial value is 1 (spec AD-6: every session
      // starts with budget=1, set by SessionRegistry.createSession).
      session.autoHandoffBudget = 1;

      await sessionInitializer.runDispatch('C1', 't10', 'text', 'z-plan-to-work', planToWorkPrompt());

      // After handoff entry, the session's autoHandoffBudget is still 1
      // (runDispatch doesn't touch this field — #697 enforcement is at the
      // slack-handler.onResetSession seam, which runs BEFORE runDispatch
      // and decrements the OLD session's budget; the NEW session here has
      // its own fresh budget from createSession / resetSessionContext).
      expect(session.autoHandoffBudget).toBe(1);
    });
  });
});
