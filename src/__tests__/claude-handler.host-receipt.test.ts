/**
 * #846 item 2 — every turn's model-command context names the session's host receipt file, and the host writes it
 * at that moment, so GET_SESSION can read the host's word from the first call of the turn.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeHandler } from '../claude-handler';

function registry() {
  return {
    getSessionResourceSnapshot: vi
      .fn()
      .mockReturnValue({ issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 2 }),
    modelCommandReceiptFile: vi.fn((c: string, t?: string) => `/data/model-command-receipts/${c}-${t}.json`),
    writeModelCommandReceipt: vi.fn(),
  };
}
const build = (self: { sessionRegistry: ReturnType<typeof registry> }, ...args: unknown[]) =>
  (ClaudeHandler.prototype as any).buildModelCommandContext.call(self, ...args);

describe('buildModelCommandContext — the host receipt', () => {
  it('a Slack turn: names the receipt file and writes it now', () => {
    const self = { sessionRegistry: registry() };
    const ctx = build(self, { title: 'T', workflow: 'default' }, { channel: 'C1', threadTs: '1.1', user: 'U1' });
    expect(ctx.receiptFile).toBe('/data/model-command-receipts/C1-1.1.json');
    expect(self.sessionRegistry.writeModelCommandReceipt).toHaveBeenCalledWith('C1', '1.1');
  });

  it('no Slack context: nothing written', () => {
    const self = { sessionRegistry: registry() };
    expect(build(self, undefined, undefined, undefined)).toBeUndefined();
    expect(self.sessionRegistry.writeModelCommandReceipt).not.toHaveBeenCalled();
  });
});
