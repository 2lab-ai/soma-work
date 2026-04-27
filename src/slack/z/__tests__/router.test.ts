import { describe, expect, it, vi } from 'vitest';
import type { LegacyCommandRouter, TombstoneStore } from '../router';
import { parseTopic, translateToLegacy, ZRouter } from '../router';
import type { ZInvocation, ZRespond } from '../types';

function makeRespond(overrides: Partial<ZRespond> = {}): ZRespond {
  return {
    source: 'slash',
    send: vi.fn().mockResolvedValue({}),
    replace: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ZRespond;
}

function makeInv(overrides: Partial<ZInvocation> = {}): ZInvocation {
  return {
    source: 'slash',
    remainder: '',
    rawText: '',
    isLegacyNaked: false,
    whitelistedNaked: false,
    userId: 'U1',
    channelId: 'C1',
    teamId: 'T1',
    respond: makeRespond(),
    ...overrides,
  } as ZInvocation;
}

function makeDeps(legacyOverride: Partial<LegacyCommandRouter> = {}, storeOverride: Partial<TombstoneStore> = {}) {
  const legacyRouter: LegacyCommandRouter = {
    route: vi.fn().mockResolvedValue({ handled: true }),
    ...legacyOverride,
  };
  const tombstoneStore: TombstoneStore = {
    markMigrationHintShown: vi.fn().mockResolvedValue(true),
    hasMigrationHintShown: vi.fn().mockReturnValue(false),
    ...storeOverride,
  };
  return { legacyRouter, tombstoneStore };
}

describe('parseTopic', () => {
  const CASES: { input: string; expected: { topic: string; verb?: string; arg?: string } }[] = [
    { input: 'help', expected: { topic: 'help', verb: undefined, arg: undefined } },
    { input: 'persona set linus', expected: { topic: 'persona', verb: 'set', arg: 'linus' } },
    { input: 'PERSONA  SET   linus', expected: { topic: 'persona', verb: 'set', arg: 'linus' } },
    { input: 'plugins add foo', expected: { topic: 'plugin', verb: 'add', arg: 'foo' } }, // alias
    { input: 'skills list', expected: { topic: 'skill', verb: 'list', arg: undefined } },
    { input: 'sessions public', expected: { topic: 'session', verb: 'public', arg: undefined } },
    { input: '', expected: { topic: '' } },
  ];
  CASES.forEach(({ input, expected }) => {
    it(`parses "${input}"`, () => {
      expect(parseTopic(input)).toEqual(expected);
    });
  });
});

describe('translateToLegacy', () => {
  const CASES: { input: string; expected: string }[] = [
    { input: 'help', expected: 'help' },
    { input: 'prompt', expected: 'show prompt' },
    { input: 'instructions', expected: 'show instructions' },
    { input: 'instruction', expected: 'show instructions' },
    { input: 'email', expected: 'show email' },
    { input: 'email set me@x.com', expected: 'set email me@x.com' },
    { input: 'verbosity set 3', expected: 'verbosity 3' },
    { input: 'bypass set on', expected: 'bypass on' },
    { input: 'sandbox set off', expected: 'sandbox off' },
    { input: 'sandbox network set on', expected: 'sandbox network on' },
    { input: 'notify set on', expected: 'notify on' },
    { input: 'notify telegram set abc123', expected: 'notify telegram abc123' },
    { input: 'webhook add https://x/y', expected: 'webhook register https://x/y' },
    { input: 'mcp', expected: 'mcp' },
    { input: 'mcp list', expected: 'mcp list' },
    { input: 'mcp info', expected: 'mcp list' },
    { input: 'plugin', expected: 'plugins' },
    { input: 'plugins update', expected: 'plugins update' },
    { input: 'skill list', expected: 'skills list' },
    { input: 'cwd set /tmp', expected: 'cwd /tmp' },
    { input: 'cct', expected: 'cct' },
    { input: 'cct next', expected: 'cct next' },
    { input: 'cct set cct2', expected: 'cct set cct2' },
    { input: 'admin accept <@U1>', expected: 'accept <@U1>' },
    { input: 'admin deny <@U1>', expected: 'deny <@U1>' },
    { input: 'admin users', expected: 'users' },
    { input: 'admin session list', expected: 'all_sessions' },
    { input: 'admin sessions list', expected: 'all_sessions' },
    { input: 'admin config', expected: 'config show' },
    { input: 'admin config set KEY VALUE', expected: 'config KEY=VALUE' },
    { input: 'session set model sonnet', expected: '$model sonnet' },
    { input: 'session set verbosity 3', expected: '$verbosity 3' },
    // pass-through for unknown
    { input: 'unknown topic foo', expected: 'unknown topic foo' },
    { input: '', expected: '' },
  ];

  CASES.forEach(({ input, expected }) => {
    it(`translates "${input}" → "${expected}"`, () => {
      expect(translateToLegacy(input)).toBe(expected);
    });
  });
});

describe('ZRouter.dispatch', () => {
  it('whitelisted naked → routes to legacy', async () => {
    const { legacyRouter, tombstoneStore } = makeDeps();
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const inv = makeInv({ whitelistedNaked: true, remainder: 'session', rawText: 'session' });

    const r = await router.dispatch(inv);
    expect(r.handled).toBe(true);
    expect(legacyRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'session', user: 'U1', channel: 'C1' }),
    );
  });

  it('legacy naked → shows tombstone and marks CAS', async () => {
    const markFn = vi.fn().mockResolvedValue(true);
    const { legacyRouter, tombstoneStore } = makeDeps({}, { markMigrationHintShown: markFn });
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const send = vi.fn().mockResolvedValue({});
    const inv = makeInv({
      isLegacyNaked: true,
      remainder: 'persona set linus',
      rawText: 'persona set linus',
      respond: makeRespond({ send }),
    });

    const r = await router.dispatch(inv);
    expect(r.handled).toBe(true);
    expect(r.consumed).toBe(true);
    expect(markFn).toHaveBeenCalledWith('U1');
    expect(send).toHaveBeenCalled();
    expect(legacyRouter.route).not.toHaveBeenCalled();
  });

  it('legacy naked + already-shown → silent (no tombstone)', async () => {
    const markFn = vi.fn().mockResolvedValue(false); // already shown
    const { legacyRouter, tombstoneStore } = makeDeps({}, { markMigrationHintShown: markFn });
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const send = vi.fn().mockResolvedValue({});
    const inv = makeInv({
      isLegacyNaked: true,
      remainder: 'model sonnet',
      rawText: 'model sonnet',
      respond: makeRespond({ send }),
    });

    const r = await router.dispatch(inv);
    expect(r.handled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(legacyRouter.route).not.toHaveBeenCalled();
  });

  it('empty remainder → shows help card', async () => {
    const { legacyRouter, tombstoneStore } = makeDeps();
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const send = vi.fn().mockResolvedValue({});
    const inv = makeInv({ remainder: '', respond: makeRespond({ send }) });

    const r = await router.dispatch(inv);
    expect(r.handled).toBe(true);
    expect(r.consumed).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.any(Array),
        ephemeral: true,
      }),
    );
  });

  it('slash + forbidden topic → rejects with SLASH_FORBIDDEN_MESSAGE', async () => {
    const { legacyRouter, tombstoneStore } = makeDeps();
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const send = vi.fn().mockResolvedValue({});
    const inv = makeInv({ source: 'slash', remainder: 'new hello', respond: makeRespond({ send }) });

    await router.dispatch(inv);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('스레드 컨텍스트') }));
    expect(legacyRouter.route).not.toHaveBeenCalled();
  });

  it('dm + forbidden topic → allowed (not slash)', async () => {
    const { legacyRouter, tombstoneStore } = makeDeps();
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const inv = makeInv({ source: 'dm', remainder: 'new hello', rawText: '/z new hello' });

    await router.dispatch(inv);
    expect(legacyRouter.route).toHaveBeenCalledWith(expect.objectContaining({ text: 'new hello' }));
  });

  it('session set model → translates to $model', async () => {
    const { legacyRouter, tombstoneStore } = makeDeps();
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const inv = makeInv({ source: 'dm', remainder: 'session set persona linus' });

    await router.dispatch(inv);
    expect(legacyRouter.route).toHaveBeenCalledWith(expect.objectContaining({ text: '$persona linus' }));
  });

  it('admin accept <@U> → translates to accept', async () => {
    const { legacyRouter, tombstoneStore } = makeDeps();
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const inv = makeInv({ source: 'slash', remainder: 'admin accept <@U999>' });

    await router.dispatch(inv);
    expect(legacyRouter.route).toHaveBeenCalledWith(expect.objectContaining({ text: 'accept <@U999>' }));
  });

  it('legacy router error → dispatch returns error', async () => {
    const routeFn = vi.fn().mockRejectedValue(new Error('boom'));
    const { legacyRouter, tombstoneStore } = makeDeps({ route: routeFn });
    const router = new ZRouter({ legacyRouter, tombstoneStore });
    const inv = makeInv({ source: 'dm', remainder: 'persona set linus' });

    const r = await router.dispatch(inv);
    expect(r.handled).toBe(false);
    expect(r.error).toBe('boom');
  });
});
