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
    getSessionResourceSnapshotByKey: vi
      .fn()
      .mockReturnValue({ issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 5 }),
    modelCommandReceiptFile: vi.fn((c: string, t?: string) => `/data/model-command-receipts/${c}-${t}.json`),
    modelCommandReceiptFileByKey: vi.fn((k: string) => `/data/model-command-receipts/${k}.json`),
    writeModelCommandReceipt: vi.fn(),
    writeModelCommandReceiptByKey: vi.fn(),
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

  it('a Slack-less task: by its key', () => {
    const self = { sessionRegistry: registry() };
    const ctx = build(self, { title: 'T' }, undefined, { origin: 'task', sessionKey: 'task:k1', userId: 'U1' });
    expect(ctx.receiptFile).toBe('/data/model-command-receipts/task:k1.json');
    expect(self.sessionRegistry.writeModelCommandReceiptByKey).toHaveBeenCalledWith('task:k1');
  });

  it('no context (not Slack, not a task): nothing written', () => {
    const self = { sessionRegistry: registry() };
    expect(build(self, undefined, undefined, undefined)).toBeUndefined();
    expect(self.sessionRegistry.writeModelCommandReceipt).not.toHaveBeenCalled();
    expect(self.sessionRegistry.writeModelCommandReceiptByKey).not.toHaveBeenCalled();
  });
});
