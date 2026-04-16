import { describe, expect, it, vi } from 'vitest';
import { HelpHandler } from './help-handler';
import type { CommandContext } from './types';

function makeCtx(overrides: Partial<CommandContext> = {}): { ctx: CommandContext; sayMock: ReturnType<typeof vi.fn> } {
  const sayMock = vi.fn().mockResolvedValue({ ts: '123.456', channel: 'C1' });
  const ctx: CommandContext = {
    user: 'U1',
    channel: 'C1',
    threadTs: '111.222',
    text: 'help',
    say: sayMock,
    ...overrides,
  };
  return { ctx, sayMock };
}

describe('HelpHandler.canHandle', () => {
  const h = new HelpHandler();
  it('matches bare help', () => {
    expect(h.canHandle('help')).toBe(true);
    expect(h.canHandle('HELP')).toBe(true);
    expect(h.canHandle('/help')).toBe(true);
  });
  it('rejects non-help', () => {
    expect(h.canHandle('new')).toBe(false);
    expect(h.canHandle('help me')).toBe(false);
  });
});

describe('HelpHandler.execute', () => {
  it('emits text fallback + Block Kit help card blocks', async () => {
    const { ctx, sayMock } = makeCtx();
    const result = await new HelpHandler().execute(ctx);
    expect(result.handled).toBe(true);
    expect(sayMock).toHaveBeenCalledOnce();
    const payload = sayMock.mock.calls[0][0];
    expect(typeof payload.text).toBe('string');
    expect(payload.text.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.blocks)).toBe(true);
    expect(payload.thread_ts).toBe('111.222');
  });

  it('help card blocks contain z_help_nav_* nav buttons', async () => {
    const { ctx, sayMock } = makeCtx();
    await new HelpHandler().execute(ctx);
    const blocks: any[] = sayMock.mock.calls[0][0].blocks;
    const actionIds: string[] = [];
    for (const b of blocks) {
      if (b.type === 'actions') for (const e of b.elements) actionIds.push(e.action_id);
    }
    // Every help nav button uses `z_help_nav_` prefix.
    expect(actionIds.length).toBeGreaterThan(0);
    for (const id of actionIds) expect(id.startsWith('z_help_nav_')).toBe(true);
    // Spot-check a couple of topics land in the card.
    expect(actionIds).toContain('z_help_nav_persona');
    expect(actionIds).toContain('z_help_nav_model');
    expect(actionIds).toContain('z_help_nav_bypass');
  });

  it('top-level block is a header with plain_text', async () => {
    const { ctx, sayMock } = makeCtx();
    await new HelpHandler().execute(ctx);
    const blocks: any[] = sayMock.mock.calls[0][0].blocks;
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.type).toBe('plain_text');
  });
});
