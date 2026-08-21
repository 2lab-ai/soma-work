import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { advertisedLlmuxBaseUrl, buildLlmuxKeyDmText, primaryLanIpv4 } from '../llmux-key-info';

/** Fake os.networkInterfaces() output: lo0 + tailscale (CGNAT) + LAN. */
const FAKE_INTERFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  utun3: [{ address: '100.101.150.73', family: 'IPv4', internal: false }], // tailscale
  awdl0: [{ address: '169.254.10.20', family: 'IPv4', internal: false }], // link-local
  en0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.168.50.49', family: 'IPv4', internal: false }, // LAN
  ],
} as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

describe('primaryLanIpv4', () => {
  it('picks the RFC1918 LAN address, skipping loopback/link-local/tailscale CGNAT', () => {
    expect(primaryLanIpv4(FAKE_INTERFACES)).toBe('192.168.50.49');
  });

  it('falls back to any non-internal IPv4 when no RFC1918 address exists', () => {
    const pub = {
      en0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    expect(primaryLanIpv4(pub)).toBe('203.0.113.7');
  });

  it('returns null when only loopback/CGNAT/link-local exist', () => {
    const none = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun3: [{ address: '100.101.150.73', family: 'IPv4', internal: false }],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    expect(primaryLanIpv4(none)).toBeNull();
  });
});

describe('advertisedLlmuxBaseUrl', () => {
  it('substitutes the LAN IP for loopback hosts (keeping port + scheme) — NOT the hostname', () => {
    const out = advertisedLlmuxBaseUrl('http://localhost:3456', {}, FAKE_INTERFACES);
    expect(out).toBe('http://192.168.50.49:3456');
    expect(advertisedLlmuxBaseUrl('http://127.0.0.1:3456', {}, FAKE_INTERFACES)).toBe('http://192.168.50.49:3456');
    expect(out).not.toContain(os.hostname());
  });

  it('falls back to os.hostname() only when no LAN IPv4 exists', () => {
    const none = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    expect(advertisedLlmuxBaseUrl('http://localhost:3456', {}, none)).toBe(`http://${os.hostname()}:3456`);
  });

  it('passes non-loopback URLs through (trailing slash stripped)', () => {
    expect(advertisedLlmuxBaseUrl('http://oudwood:3456/', {}, FAKE_INTERFACES)).toBe('http://oudwood:3456');
  });

  it('prefers the LLMUX_ADVERTISED_BASE_URL override, normalized', () => {
    const env = { LLMUX_ADVERTISED_BASE_URL: 'http://fable-m5max.tailnet:3456/' };
    expect(advertisedLlmuxBaseUrl('http://localhost:3456', env, FAKE_INTERFACES)).toBe(
      'http://fable-m5max.tailnet:3456',
    );
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(advertisedLlmuxBaseUrl('not a url', {}, FAKE_INTERFACES)).toBe('not a url');
  });

  it('recognizes loopback aliases (trailing-dot FQDN, IPv4-mapped IPv6)', () => {
    expect(advertisedLlmuxBaseUrl('http://localhost.:3456', {}, FAKE_INTERFACES)).toBe('http://192.168.50.49:3456');
    expect(advertisedLlmuxBaseUrl('http://[::ffff:127.0.0.1]:3456', {}, FAKE_INTERFACES)).toBe(
      'http://192.168.50.49:3456',
    );
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
