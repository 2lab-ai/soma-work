import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandHandler, type CommandResult, CommandRouter, setCommandRouterProviders } from '../command-router';

/**
 * Ingress classification for the follow-up queue (`.prd/slack-agent-ui` §3.1).
 *
 * The question under test is NOT "is this a known command" but "what happens to
 * this text while a turn is running": an instruction must be queued verbatim, an
 * immediate control must keep working live, and a command that would ALSO
 * dispatch must be queued (running it live supersedes the turn the queue exists
 * to protect).
 *
 * The classifier must never execute a handler — `execute` here throws, so any
 * call fails the test.
 */

function handler(name: string, canHandle: (text: string, user?: string) => boolean): CommandHandler {
  return {
    canHandle: vi.fn(canHandle),
    execute: vi.fn(async (): Promise<CommandResult> => {
      throw new Error(`${name}.execute must not run during classification`);
    }),
  };
}

describe('CommandRouter.classifyText / isCommand — follow-up ingress', () => {
  let helpHandler: CommandHandler;
  let cwdHandler: CommandHandler;
  let sessionHandler: CommandHandler;
  let skillForceHandler: CommandHandler;
  let goalHandler: CommandHandler;
  let newHandler: CommandHandler;
  let adminOnlyHandler: CommandHandler;
  let router: CommandRouter;

  beforeEach(() => {
    helpHandler = handler('help', (text) => /^\/?help\b/i.test(text.trim()));
    cwdHandler = handler('cwd', (text) => /^\/?cwd\b/i.test(text.trim()));
    // Mirrors SessionCommandHandler: `%`, `%model <v>`, … (no free remainder).
    sessionHandler = handler('session', (text) =>
      /^[%$](?:model|verbosity|effort|thinking_summary|thinking)?(?:\s+\S+)?$/i.test(text.trim()),
    );
    skillForceHandler = handler('skill', (text) => /(^|\s)\$[\w-]+/.test(text.trim()));
    goalHandler = handler('goal', (text) => /^\/?goal\b/i.test(text.trim()));
    newHandler = handler('new', (text) => /^\/?new\b/i.test(text.trim()));
    adminOnlyHandler = handler('admin', (text, user) => /^\/?prompt\b/i.test(text.trim()) && user === 'U_ADMIN');

    setCommandRouterProviders({
      createHandlers: () => ({
        handlers: [
          adminOnlyHandler,
          helpHandler,
          cwdHandler,
          sessionHandler,
          skillForceHandler,
          newHandler,
          goalHandler,
        ],
        newHandler,
        skillForceHandler,
        goalHandler,
        hasActiveSession: () => true,
      }),
    });
    router = new CommandRouter({});
  });

  it('treats an ordinary instruction — including a status question — as queueable', () => {
    expect(router.classifyText('배포 스크립트 좀 고쳐줘')).toBe('instruction');
    // Answer-and-consume is forbidden (ssot §3.1): the harness must not answer
    // this itself, so it is NOT a command.
    expect(router.classifyText('진행중인거 알려줘?')).toBe('instruction');
    expect(router.isCommand('진행중인거 알려줘?')).toBe(false);
  });

  it('keeps bare controls as immediate controls', () => {
    expect(router.classifyText('help')).toBe('control');
    expect(router.classifyText('/cwd')).toBe('control');
    expect(router.classifyText('%')).toBe('control');
    expect(router.classifyText('%model fable')).toBe('control');
    expect(router.classifyText('goal status')).toBe('control');
    expect(router.classifyText('new')).toBe('control');
  });

  it('queues an inline directive that carries an instruction, but not a bare one', () => {
    // `%model fable <instruction>` is two actions in one message; the remainder
    // is the user's turn, so the RAW text must be queued.
    expect(router.classifyText('%model fable 로그 좀 봐줘')).toBe('instruction');
    expect(router.classifyText('%nogoal 로그 좀 봐줘')).toBe('instruction');
    expect(router.classifyText('%nogoal')).toBe('control');
  });

  it('classifies a command that also dispatches as control-with-dispatch', () => {
    expect(router.classifyText('new 테스트 하나 써줘')).toBe('control-with-dispatch');
    expect(router.classifyText('goal 릴리즈 준비')).toBe('control-with-dispatch');
    expect(router.classifyText('$deploy stage2')).toBe('control-with-dispatch');
    expect(router.classifyText('onboarding')).toBe('control-with-dispatch');
    expect(router.classifyText('renew')).toBe('control-with-dispatch');
  });

  it('normalizes `/z …` exactly like route before probing the handlers', () => {
    // `/z cwd` → legacy `cwd`: the same handler answers it, so it is a control.
    expect(router.classifyText('/z cwd')).toBe('control');
    // Bare `/z` prints the help card — consumed, never dispatched.
    expect(router.classifyText('/z')).toBe('control');
  });

  it('uses the user id, so an admin-gated command is not mistaken for an instruction', () => {
    expect(router.classifyText('prompt', 'U_ADMIN')).toBe('control');
    // Same text from a non-admin: no handler claims it and `prompt` is not a
    // known keyword (only `show prompt` is — `command-parser.ts` COMMAND_KEYWORDS),
    // so the router lets it through to the model. Classifying it as an
    // instruction is what actually happens to it, not a convenience.
    expect(router.classifyText('prompt', 'U_OTHER')).toBe('instruction');
    expect((adminOnlyHandler.canHandle as any).mock.calls.some((call: any[]) => call[1] === 'U_ADMIN')).toBe(true);
  });

  it('is side-effect free — no handler is executed', () => {
    router.classifyText('help');
    router.classifyText('new 테스트');
    router.classifyText('배포해줘');
    for (const candidate of [helpHandler, cwdHandler, sessionHandler, skillForceHandler, goalHandler, newHandler]) {
      expect(candidate.execute).not.toHaveBeenCalled();
    }
  });

  it('reuses the SAME handler instances the router routes with', () => {
    router.classifyText('cwd');
    expect(cwdHandler.canHandle).toHaveBeenCalledWith('cwd', undefined);
  });

  it('treats empty text as nothing to classify', () => {
    expect(router.classifyText('')).toBe('instruction');
    expect(router.isCommand('')).toBe(false);
  });
});
