import { describe, expect, it } from 'vitest';

import { detectLegacyNaked, isLegacyNaked, TOMBSTONE_HINTS } from '../tombstone';

describe('TOMBSTONE_HINTS', () => {
  it('each hint has match/title/oldForm/newForm', () => {
    for (const h of TOMBSTONE_HINTS) {
      expect(h.match).toBeInstanceOf(RegExp);
      expect(typeof h.title).toBe('string');
      expect(h.title.length).toBeGreaterThan(0);
      expect(typeof h.oldForm).toBe('string');
      expect(typeof h.newForm).toBe('string');
      expect(h.newForm).toMatch(/^\/z /); // newForm must point to /z
    }
  });

  it('no duplicate regex patterns', () => {
    const sources = TOMBSTONE_HINTS.map((h) => h.match.source);
    expect(new Set(sources).size).toBe(sources.length);
  });
});

describe('detectLegacyNaked — table-driven', () => {
  const POSITIVE: { input: string; expectedTitle: string }[] = [
    { input: 'help', expectedTitle: 'help' },
    { input: 'commands', expectedTitle: 'help' },
    { input: 'command', expectedTitle: 'help' },
    { input: 'show prompt', expectedTitle: 'prompt' },
    { input: 'show_prompt', expectedTitle: 'prompt' },
    { input: 'show instructions', expectedTitle: 'instructions' },
    { input: 'show email', expectedTitle: 'email' },
    { input: 'set email user@example.com', expectedTitle: 'email' },
    { input: 'persona', expectedTitle: 'persona' },
    { input: 'persona set linus', expectedTitle: 'persona' },
    { input: 'model sonnet', expectedTitle: 'model' },
    { input: 'verbosity high', expectedTitle: 'verbosity' },
    { input: 'bypass on', expectedTitle: 'bypass' },
    { input: 'sandbox off', expectedTitle: 'sandbox' },
    { input: 'notify on', expectedTitle: 'notify' },
    { input: 'notify telegram abc123', expectedTitle: 'notify' },
    { input: 'memory clear', expectedTitle: 'memory' },
    { input: 'webhook register https://x.y/z', expectedTitle: 'webhook' },
    { input: 'mcp', expectedTitle: 'mcp' },
    { input: 'mcp list', expectedTitle: 'mcp' },
    { input: 'servers', expectedTitle: 'mcp' },
    { input: 'plugins', expectedTitle: 'plugin' },
    { input: 'plugin', expectedTitle: 'plugin' },
    { input: '플러그인 업데이트', expectedTitle: 'plugin' },
    { input: 'marketplace add omc@soma', expectedTitle: 'marketplace' },
    { input: 'skills list', expectedTitle: 'skill' },
    { input: 'cwd', expectedTitle: 'cwd' },
    { input: 'set directory /tmp', expectedTitle: 'cwd' },
    { input: 'nextcct', expectedTitle: 'cct' },
    { input: 'set_cct cct2', expectedTitle: 'cct' },
    { input: 'cct', expectedTitle: 'cct' },
    { input: 'accept <@U123>', expectedTitle: 'admin' },
    { input: 'deny <@U123>', expectedTitle: 'admin' },
    { input: 'users', expectedTitle: 'admin' },
    { input: 'all_sessions', expectedTitle: 'admin' },
    { input: 'onboarding', expectedTitle: 'onboarding' },
    { input: 'context', expectedTitle: 'context' },
    { input: 'compact', expectedTitle: 'compact' },
    { input: 'link https://x/y', expectedTitle: 'link' },
    { input: 'close', expectedTitle: 'close' },
    { input: 'report', expectedTitle: 'report' },
    { input: 'restore', expectedTitle: 'restore' },
    { input: 'credentials', expectedTitle: 'restore' },
    { input: 'config KEY=VAL', expectedTitle: 'admin config' },
  ];

  POSITIVE.forEach(({ input, expectedTitle }) => {
    it(`detects "${input}" → title=${expectedTitle}`, () => {
      const h = detectLegacyNaked(input);
      expect(h).not.toBeNull();
      expect(h!.title).toBe(expectedTitle);
    });
  });

  const NEGATIVE: string[] = [
    '',
    '   ',
    'session', // whitelisted
    'sessions', // whitelisted
    'new', // whitelisted
    'new hello world', // whitelisted
    'renew', // whitelisted
    '$model sonnet', // whitelisted
    'theme dark', // whitelisted
    'hello claude', // prose
    'can you help me?', // prose even though contains "help"
    'write a program that prints hi', // prose
  ];

  NEGATIVE.forEach((input) => {
    it(`does not flag "${input}" as legacy`, () => {
      expect(detectLegacyNaked(input)).toBeNull();
      expect(isLegacyNaked(input)).toBe(false);
    });
  });

  it('is case-insensitive', () => {
    expect(detectLegacyNaked('PERSONA SET linus')?.title).toBe('persona');
    expect(detectLegacyNaked('Model Sonnet')?.title).toBe('model');
  });

  it('accepts leading slash prefix', () => {
    expect(detectLegacyNaked('/persona')?.title).toBe('persona');
    expect(detectLegacyNaked('/mcp list')?.title).toBe('mcp');
  });

  it('returns hint with correct newForm for Korean alias', () => {
    const h = detectLegacyNaked('플러그인 업데이트');
    expect(h).not.toBeNull();
    expect(h!.newForm).toBe('/z plugin update');
  });
});
