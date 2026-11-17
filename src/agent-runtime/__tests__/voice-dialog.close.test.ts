/**
 * .prd/31-phone-calls-architecture.md §3.1 — a call's dialog lives exactly as long as the call. Ending the prompt
 * stream is only EOF (a reply being written would still finish), so close() must stop the query itself and drop
 * what was queued.
 */
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ closed: 0, prompts: [] as unknown[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    fake.prompts.push(prompt);
    return {
      async *[Symbol.asyncIterator]() {},
      interrupt: async () => undefined,
      close: () => {
        fake.closed++;
      },
    };
  },
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
}));
vi.mock('../claude-child-process-registry', () => ({ createTrackedClaudeProcessSpawner: () => undefined }));

import { openVoiceDialog } from '../voice-dialog';

describe('openVoiceDialog().close()', () => {
  it('stops the query (and its CLI) and drops what was still queued', async () => {
    const dialog = openVoiceDialog({ model: 'm', systemPrompt: 's', env: {}, tools: [] });
    dialog.send('첫 말');
    dialog.send('둘째 말');
    dialog.close();
    expect(fake.closed).toBe(1);
    const left: unknown[] = [];
    for await (const m of fake.prompts[0] as AsyncIterable<unknown>) left.push(m);
    expect(left).toEqual([]);
    expect(dialog.send('늦은 말')).toBe(false);
  });
});
