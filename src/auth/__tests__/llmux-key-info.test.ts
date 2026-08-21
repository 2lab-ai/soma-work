import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { advertisedLlmuxBaseUrl, buildLlmuxKeyDmText } from '../llmux-key-info';

describe('advertisedLlmuxBaseUrl', () => {
  it('substitutes the machine hostname for loopback hosts (keeping port + scheme)', () => {
    const out = advertisedLlmuxBaseUrl('http://localhost:3456', {});
    expect(out).toBe(`http://${os.hostname()}:3456`);
    expect(advertisedLlmuxBaseUrl('http://127.0.0.1:3456', {})).toBe(`http://${os.hostname()}:3456`);
  });

  it('passes non-loopback URLs through (trailing slash stripped)', () => {
    expect(advertisedLlmuxBaseUrl('http://oudwood:3456/', {})).toBe('http://oudwood:3456');
  });

  it('prefers the LLMUX_ADVERTISED_BASE_URL override, normalized', () => {
    const env = { LLMUX_ADVERTISED_BASE_URL: 'http://fable-m5max.tailnet:3456/' };
    expect(advertisedLlmuxBaseUrl('http://localhost:3456', env)).toBe('http://fable-m5max.tailnet:3456');
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(advertisedLlmuxBaseUrl('not a url', {})).toBe('not a url');
  });
});

describe('buildLlmuxKeyDmText', () => {
  const input = {
    secret: 'lmk-secret-123',
    baseUrl: 'http://fable-m5max:3456',
    keyId: 'k-abc',
    keyPrefix: 'lmk-secr',
    keyName: 'Z (U123)',
    issuedAtMs: Date.UTC(2026, 7, 21),
  };

  it('carries the secret, the advertised address, and runnable claude code setup', () => {
    const text = buildLlmuxKeyDmText(input);
    expect(text).toContain('lmk-secret-123');
    expect(text).toContain('http://fable-m5max:3456');
    expect(text).toContain('ANTHROPIC_BASE_URL=http://fable-m5max:3456');
    expect(text).toContain('ANTHROPIC_API_KEY=lmk-secret-123');
    // the actual launch command
    expect(text).toMatch(/\bclaude\b/);
  });

  it('includes the llmux.json remote snippet with host (no scheme) + api_key', () => {
    const text = buildLlmuxKeyDmText(input);
    expect(text).toContain('"remote"');
    expect(text).toContain('"host": "fable-m5max:3456"');
    expect(text).toContain('"api_key": "lmk-secret-123"');
  });

  it('shows key attribution metadata when present', () => {
    const text = buildLlmuxKeyDmText(input);
    expect(text).toContain('k-abc');
  });

  it('still renders without optional metadata', () => {
    const text = buildLlmuxKeyDmText({ secret: 'lmk-x', baseUrl: 'http://h:3456' });
    expect(text).toContain('lmk-x');
    expect(text).toContain('http://h:3456');
  });
});
