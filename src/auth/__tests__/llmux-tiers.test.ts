/**
 * T10 (SSOT 2026-10-23) — subscription tiers per llmux account.
 * llmux /llmux/status carries no plan tier, so soma-work owns the mapping:
 * built-in defaults from the operator (codex ai5·ai6 = Pro $500, ai1·ai2 =
 * Pro $200) layered under SOMA_LLMUX_ACCOUNT_TIERS.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLMUX_ACCOUNT_TIERS,
  LLMUX_TIERS,
  llmuxAccountLocalName,
  parseLlmuxAccountTiers,
  resolveAccountTier,
} from '../llmux-tiers';

describe('tier catalog', () => {
  it('has the four subscription tiers the operator uses, two per provider', () => {
    expect(Object.keys(LLMUX_TIERS).sort()).toEqual([
      'chatgpt-pro-200',
      'chatgpt-pro-500',
      'claude-max-20x',
      'claude-max-5x',
    ]);
    expect(LLMUX_TIERS['claude-max-20x'].rank).toBe('high');
    expect(LLMUX_TIERS['claude-max-5x'].rank).toBe('low');
    expect(LLMUX_TIERS['chatgpt-pro-500'].rank).toBe('high');
    expect(LLMUX_TIERS['chatgpt-pro-200'].rank).toBe('low');
    expect(LLMUX_TIERS['claude-max-20x'].short).toBe('x20');
    expect(LLMUX_TIERS['chatgpt-pro-200'].short).toBe('$200');
  });

  it('defaults: codex ai5 ai6 = Pro $500, ai1 ai2 = Pro $200', () => {
    expect(DEFAULT_LLMUX_ACCOUNT_TIERS).toEqual({
      'codex:ai1': 'chatgpt-pro-200',
      'codex:ai2': 'chatgpt-pro-200',
      'codex:ai5': 'chatgpt-pro-500',
      'codex:ai6': 'chatgpt-pro-500',
    });
  });
});

describe('parseLlmuxAccountTiers', () => {
  it('parses group:name=tier and bare name=tier, with aliases', () => {
    const r = parseLlmuxAccountTiers('claude:ai7=x20, ai12=max-5x ,codex:ai3=pro500;claude:ai13=claude-max-20x');
    expect(r.invalid).toEqual([]);
    expect(r.tiers).toEqual({
      'claude:ai7': 'claude-max-20x',
      ai12: 'claude-max-5x',
      'codex:ai3': 'chatgpt-pro-500',
      'claude:ai13': 'claude-max-20x',
    });
  });

  it('reports malformed entries instead of guessing', () => {
    const r = parseLlmuxAccountTiers('ai7=ultra, =x5, ai8');
    expect(r.tiers).toEqual({});
    expect(r.invalid).toEqual(['ai7=ultra', '=x5', 'ai8']);
  });

  it('empty / unset is no entries', () => {
    expect(parseLlmuxAccountTiers(undefined)).toEqual({ tiers: {}, invalid: [] });
    expect(parseLlmuxAccountTiers('  ')).toEqual({ tiers: {}, invalid: [] });
  });
});

describe('resolveAccountTier — explicit → upstream → defaults → unknown', () => {
  const explicit = { 'codex:ai1': 'chatgpt-pro-500', ai7: 'claude-max-20x' } as const;

  it('explicit config: group:name first, then the bare name', () => {
    expect(resolveAccountTier({ name: 'ai1', group: 'codex' }, explicit)).toBe('chatgpt-pro-500');
    expect(resolveAccountTier({ name: 'ai7', group: 'claude' }, explicit)).toBe('claude-max-20x');
  });

  it('a name mapped under another group does not leak across groups', () => {
    expect(resolveAccountTier({ name: 'ai1', group: 'claude' }, explicit)).toBeUndefined();
  });

  it('then a validated tier string llmux reports itself', () => {
    expect(resolveAccountTier({ name: 'ai9', group: 'claude', rate_limit_tier: 'default_claude_max_5x' }, {})).toBe(
      'claude-max-5x',
    );
    // explicit config still wins over upstream
    expect(
      resolveAccountTier({ name: 'ai7', group: 'claude', rate_limit_tier: 'default_claude_max_5x' }, explicit),
    ).toBe('claude-max-20x');
  });

  it('then the built-in defaults', () => {
    expect(resolveAccountTier({ name: 'ai5', group: 'codex' }, {})).toBe('chatgpt-pro-500');
    expect(resolveAccountTier({ name: 'ai2', group: 'codex' }, {})).toBe('chatgpt-pro-200');
  });

  it('a bare-name operator entry beats a scoped built-in default', () => {
    expect(resolveAccountTier({ name: 'ai1', group: 'codex' }, { ai1: 'chatgpt-pro-500' })).toBe('chatgpt-pro-500');
  });

  // Live llmux (2026-10-23) names accounts `group:local@domain`, e.g.
  // `codex:ai5@corp.example` — every key form must still match.
  it('matches llmux account names of the form group:local@domain', () => {
    expect(resolveAccountTier({ name: 'codex:ai5@corp.example', group: 'codex' }, {})).toBe('chatgpt-pro-500');
    expect(resolveAccountTier({ name: 'codex:ai1@corp.example', group: 'codex' }, {})).toBe('chatgpt-pro-200');
    expect(resolveAccountTier({ name: 'claude:ai7@corp.example', group: 'claude' }, explicit)).toBe('claude-max-20x');
    expect(
      resolveAccountTier({ name: 'claude:ai9@corp.example', group: 'claude' }, { 'claude:ai9': 'claude-max-5x' }),
    ).toBe('claude-max-5x');
    // the full name still works as a key
    expect(
      resolveAccountTier(
        { name: 'claude:ai9@corp.example', group: 'claude' },
        { 'claude:ai9@corp.example': 'claude-max-20x' },
      ),
    ).toBe('claude-max-20x');
    // and still never leaks across groups
    expect(resolveAccountTier({ name: 'claude:ai1@corp.example', group: 'claude' }, {})).toBeUndefined();
  });

  // trinity round 6 (fable P2): live llmux has ai5 / ai6 / ai2 in both the
  // claude and the codex group — a tier only ever applies to its own provider.
  it("a tier never lands on another provider's account, however the key is written", () => {
    expect(resolveAccountTier({ name: 'claude:ai5@corp.example', group: 'claude' }, { ai5: 'chatgpt-pro-500' })).toBe(
      undefined,
    );
    expect(resolveAccountTier({ name: 'ai5', group: 'claude' }, { ai5: 'chatgpt-pro-500' })).toBeUndefined();
    expect(
      resolveAccountTier({ name: 'claude:ai5@corp.example', group: 'claude' }, { 'claude:ai5': 'chatgpt-pro-500' }),
    ).toBeUndefined();
    // the same bare key still serves its own provider
    expect(resolveAccountTier({ name: 'codex:ai5@corp.example', group: 'codex' }, { ai5: 'chatgpt-pro-500' })).toBe(
      'chatgpt-pro-500',
    );
    // and a mismatched bare key does not hide the provider's own default
    expect(resolveAccountTier({ name: 'codex:ai1@corp.example', group: 'codex' }, { ai1: 'claude-max-20x' })).toBe(
      'chatgpt-pro-200',
    );
  });

  it('llmuxAccountLocalName strips the group prefix and the domain', () => {
    expect(llmuxAccountLocalName('claude:ai7@corp.example', 'claude')).toBe('ai7');
    expect(llmuxAccountLocalName('ai7', 'claude')).toBe('ai7');
    expect(llmuxAccountLocalName('kim.lee@corp.example', 'claude')).toBe('kim.lee');
  });

  it('never guesses x5/x20 from a bare "max" — unknown instead', () => {
    expect(resolveAccountTier({ name: 'ai12', group: 'claude', tier: 'max' }, {})).toBeUndefined();
    expect(resolveAccountTier({ name: 'ai12', group: 'claude', rate_limit_tier: 'max' }, {})).toBeUndefined();
  });
});
