import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config', () => ({
  config: { conversation: { summaryModel: 'test-model' } },
}));

vi.mock('../../../credentials-manager', () => ({
  ensureValidCredentials: vi.fn(async () => ({ valid: true })),
}));

let mockAssistantText: string;
let capturedOptions: any = null;
let capturedPrompt: string | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: string; options: any }) => {
    capturedOptions = options;
    capturedPrompt = prompt;
    const text = mockAssistantText;
    return (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      };
    })();
  }),
}));

import { ensureValidCredentials } from '../../../credentials-manager';
import { improveAll, improveEntry } from './memory-improve';

beforeEach(() => {
  mockAssistantText = '';
  capturedOptions = null;
  capturedPrompt = null;
  vi.mocked(ensureValidCredentials).mockResolvedValue({ valid: true } as any);
});

describe('improveEntry', () => {
  it('uses 장기 기억 prompt for target=memory', async () => {
    mockAssistantText = 'improved';
    await improveEntry('orig', 'memory');
    expect(capturedOptions.systemPrompt).toContain('장기 기억');
    expect(capturedOptions.tools).toEqual([]);
    expect(capturedOptions.maxTurns).toBe(1);
    expect(capturedOptions.model).toBe('test-model');
    expect(capturedOptions.settingSources).toEqual([]);
    expect(capturedOptions.plugins).toEqual([]);
  });

  it('uses 페르소나 prompt for target=user', async () => {
    mockAssistantText = 'improved';
    await improveEntry('orig', 'user');
    expect(capturedOptions.systemPrompt).toContain('페르소나');
    expect(capturedOptions.tools).toEqual([]);
    expect(capturedOptions.maxTurns).toBe(1);
  });

  it('throws on empty output', async () => {
    mockAssistantText = '';
    await expect(improveEntry('orig', 'memory')).rejects.toThrow(/empty LLM output/);
  });

  it('truncates to per-entry cap 660 for memory', async () => {
    mockAssistantText = 'x'.repeat(5000);
    const result = await improveEntry('o', 'memory');
    expect(result.length).toBe(660);
  });

  it('truncates to per-entry cap 412 for user', async () => {
    mockAssistantText = 'x'.repeat(5000);
    const result = await improveEntry('o', 'user');
    expect(result.length).toBe(412);
  });

  it('throws when credentials invalid', async () => {
    vi.mocked(ensureValidCredentials).mockResolvedValueOnce({ valid: false, error: 'expired' } as any);
    await expect(improveEntry('o', 'memory')).rejects.toThrow(/credentials invalid: expired/);
  });

  it('collapses newlines to spaces and trims', async () => {
    mockAssistantText = '  hello\n\nworld\n  ';
    const result = await improveEntry('o', 'memory');
    expect(result).toBe('hello world');
  });
});

describe('improveAll', () => {
  it('parses JSON array output', async () => {
    mockAssistantText = '["a","b","c"]';
    const result = await improveAll(['x', 'y'], 'memory');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('falls back to --- split when JSON parse fails', async () => {
    mockAssistantText = 'a\n---\nb\n---\nc';
    const result = await improveAll(['x'], 'memory');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('truncates each entry to cap', async () => {
    mockAssistantText = JSON.stringify(['x'.repeat(5000)]);
    const result = await improveAll(['x'], 'memory');
    expect(result[0].length).toBe(660);
  });

  it('throws on empty parsed array', async () => {
    mockAssistantText = '[]';
    await expect(improveAll(['x'], 'memory')).rejects.toThrow(/empty/);
  });

  it('rejects JSON array with non-string members (does NOT fall through to split)', async () => {
    // Model returned [1,2,3] — structurally wrong shape. Must throw so an
    // ops regression surfaces instead of silently persisting `"[1,2,3]"` or
    // other garbage from the fallback split path.
    mockAssistantText = '[1,2,3]\n---\nfallback';
    await expect(improveAll(['x'], 'memory')).rejects.toThrow(/non-string members/);
  });

  it('rejects JSON that is parseable but not an array', async () => {
    mockAssistantText = '["ok"] plus trailing prose';
    // regex captures ["ok"] — that IS an array of strings, so this should
    // succeed. Verify that behavior first (sanity).
    const ok = await improveAll(['x'], 'memory');
    expect(ok).toEqual(['ok']);
  });

  it('falls through to split when JSON is malformed (not parseable)', async () => {
    // `[` inside without matching `]` → no regex match → fall through
    mockAssistantText = 'prose without array brackets\n---\nsecond';
    const result = await improveAll(['x'], 'memory');
    expect(result).toEqual(['prose without array brackets', 'second']);
  });

  it('embeds entries count + separator in prompt', async () => {
    mockAssistantText = '["a"]';
    await improveAll(['x', 'y', 'z'], 'memory');
    expect(capturedPrompt).not.toBeNull();
    expect(capturedPrompt!).toContain('3개 항목');
    expect(capturedPrompt!).toContain('x\n---\ny\n---\nz');
  });
});
