import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  MAX_AUTOSKILLS: 20,
  userSettingsStore: {
    getUserAutoskills: vi.fn(() => []),
    setUserAutoskills: vi.fn(),
  },
}));

vi.mock('../../../skill-locator', () => ({
  autoskillExists: vi.fn(),
}));

import { autoskillExists } from '../../../skill-locator';
import { userSettingsStore } from '../../../user-settings-store';
import { AutoskillHandler } from '../autoskill-handler';
import type { CommandContext } from '../types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_TEST',
    channel: 'C123',
    threadTs: 'thread123',
    text: '',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

describe('AutoskillHandler', () => {
  let handler: AutoskillHandler;

  beforeEach(() => {
    handler = new AutoskillHandler();
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue([]);
  });

  afterEach(() => vi.clearAllMocks());

  describe('canHandle', () => {
    it.each(['autoskill', 'set autoskill using-ssot'])('accepts "%s"', (t) => {
      expect(handler.canHandle(t)).toBe(true);
    });
    it.each(['skills list', 'set email a@b.com'])('rejects "%s"', (t) => {
      expect(handler.canHandle(t)).toBe(false);
    });
  });

  it('bare autoskill renders the management card', async () => {
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['using-ssot']);
    const ctx = makeCtx({ text: 'autoskill' });
    const result = await handler.execute(ctx);
    expect(result.handled).toBe(true);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: expect.any(Array), thread_ts: 'thread123' }),
    );
    expect(userSettingsStore.setUserAutoskills).not.toHaveBeenCalled();
  });

  it('set with valid skills stores them', async () => {
    vi.mocked(autoskillExists).mockReturnValue(true);
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['using-ssot', 'using-govuk']);
    const ctx = makeCtx({ text: 'set autoskill using-ssot, using-govuk' });
    const result = await handler.execute(ctx);
    expect(result.handled).toBe(true);
    expect(userSettingsStore.setUserAutoskills).toHaveBeenCalledWith('U_TEST', ['using-ssot', 'using-govuk']);
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('설정 완료') }));
  });

  it('set rejects unknown skills (no store write) when none resolve', async () => {
    vi.mocked(autoskillExists).mockReturnValue(false);
    const ctx = makeCtx({ text: 'set autoskill nope-skill' });
    const result = await handler.execute(ctx);
    expect(result.handled).toBe(true);
    expect(userSettingsStore.setUserAutoskills).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('찾지 못했습니다') }));
  });

  it('set stores only the valid subset and warns about unknowns', async () => {
    vi.mocked(autoskillExists).mockImplementation((name: string) => name === 'using-ssot');
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['using-ssot']);
    const ctx = makeCtx({ text: 'set autoskill using-ssot, bogus' });
    await handler.execute(ctx);
    expect(userSettingsStore.setUserAutoskills).toHaveBeenCalledWith('U_TEST', ['using-ssot']);
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('무시된') }));
  });

  it('set clear empties the list', async () => {
    const ctx = makeCtx({ text: 'set autoskill clear' });
    await handler.execute(ctx);
    expect(userSettingsStore.setUserAutoskills).toHaveBeenCalledWith('U_TEST', []);
    expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('비웠습니다') }));
  });
});
