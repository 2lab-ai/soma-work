/**
 * `model set <name>` failure text.
 *
 * A REFUSED id (the retired gpt-5.5, a fake grok `[1m]`) is not a typo: the
 * reply must carry the refusal reason and the id to use instead, not an
 * "Unknown Model" header plus an alias dump. A real typo keeps the alias list
 * — exactly once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelCatalog } from '../../../model-catalog';
import { ModelHandler } from '../model-handler';
import type { CommandContext, CommandDependencies } from '../types';

function makeHandler(): ModelHandler {
  const deps = { claudeHandler: { getSession: () => null } } as unknown as CommandDependencies;
  return new ModelHandler(deps);
}

async function replyTo(text: string): Promise<string> {
  const say = vi.fn().mockResolvedValue({ ts: 'm' });
  const ctx = { user: 'U_MODEL_SET', channel: 'C1', text, threadTs: '1700000000.000001', say };
  await makeHandler().execute(ctx as unknown as CommandContext);
  expect(say).toHaveBeenCalledTimes(1);
  return String(say.mock.calls[0]?.[0]?.text ?? '');
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('ModelHandler `model set` — refusals keep their reason', () => {
  it.each(['gpt-5.5', 'gpt5.5'])('`model set %s` names the retirement and suggests gpt-5.6-sol', async (value) => {
    const text = await replyTo(`model set ${value}`);
    expect(text).toContain('retired on 2026-11-19');
    expect(text).toContain('`gpt-5.6-sol`');
    expect(text).not.toContain('Unknown');
    expect(text).not.toContain('Available aliases');
  });

  it('`model set grok-4.6[1m]` keeps the grok refusal reason', async () => {
    const text = await replyTo('model set grok-4.6[1m]');
    expect(text).toContain('grok has no 1M variant');
    expect(text).toMatch(/use `grok-4\.6`/i);
    expect(text).not.toContain('Available aliases');
  });

  describe('gemini models (llmux refuses Claude Code → gemini, 2026-11-21)', () => {
    afterEach(() => {
      modelCatalog.__testReset();
    });

    it.each([
      'model neon',
      'model set neon',
      'model argon',
      'model set gemini-4-neon[1m]',
      'model gemini-3.8-flash-high',
    ])('`%s` says why and suggests the opus default', async (command) => {
      modelCatalog.__testSeed([
        { id: 'gemini-4-argon[1m]', aliases: ['argon'], name: 'Gemini 4 Argon', efforts: [], group: 'gemini' },
        { id: 'gemini-4-neon', aliases: ['neon'], name: 'Gemini 4 Neon', efforts: [], group: 'gemini' },
      ]);
      const text = await replyTo(command);
      expect(text).toContain('is a Gemini model');
      expect(text).toContain("does not forward Claude Code requests to Google's Antigravity backend");
      expect(text).toContain('`claude-opus-5-5[1m]`');
      expect(text).not.toContain('Unknown');
      expect(text).not.toContain('Available aliases');
    });
  });

  it('a typo still gets "Unknown model" and the alias list — once, not twice', async () => {
    const text = await replyTo('model set definitely-not-a-model');
    expect(text).toContain('Unknown model');
    expect(count(text, 'Available aliases')).toBe(1);
    expect(text).toContain('`model list`');
  });
});
