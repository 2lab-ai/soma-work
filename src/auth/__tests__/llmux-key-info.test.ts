import type * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { advertisedLlmuxBaseUrl, buildLlmuxKeyDmText, primaryLanIpv4 } from '../llmux-key-info';

/**
 * Fake os.networkInterfaces() output. Addresses are documentation/test values
 * only (RFC 5737 for public, arbitrary high RFC1918 for LAN) — never real
 * fleet addresses (the repo's sanitize scan forbids them).
 */
function fakeInterfaces(spec: Record<string, string[]>): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return Object.fromEntries(
    Object.entries(spec).map(([name, addrs]) => [
      name,
      addrs.map((address) => ({
        address,
        family: address.includes(':') ? 'IPv6' : 'IPv4',
        internal: name === 'lo0',
      })),
    ]),
  ) as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

const TYPICAL = fakeInterfaces({
  lo0: ['127.0.0.1'],
  utun3: ['100.100.7.7'], // tailscale CGNAT
  awdl0: ['169.254.10.20'], // link-local
  en0: ['fe80::1', '192.168.77.10'], // LAN
});

/** Probe that forces the enumeration fallback (as if the route lookup failed). */
const NO_ROUTE = { routeProbe: async () => null };

describe('primaryLanIpv4', () => {
  it('picks the RFC1918 LAN address, skipping loopback/link-local/tailscale CGNAT', () => {
    expect(primaryLanIpv4(TYPICAL)).toBe('192.168.77.10');
  });

  it('falls back to any other non-internal IPv4 when no RFC1918 address exists', () => {
    expect(primaryLanIpv4(fakeInterfaces({ en0: ['203.0.113.7'] }))).toBe('203.0.113.7');
  });

  it('returns null when only loopback/CGNAT/link-local exist', () => {
    expect(primaryLanIpv4(fakeInterfaces({ lo0: ['127.0.0.1'], utun3: ['100.100.7.7'] }))).toBeNull();
  });

  it('is deterministic across interface enumeration order (sorted names + addresses)', () => {
    const a = fakeInterfaces({ en0: ['192.168.77.10'], en5: ['10.9.8.7'] });
    const b = fakeInterfaces({ en5: ['10.9.8.7'], en0: ['192.168.77.10'] });
    expect(primaryLanIpv4(a)).toBe(primaryLanIpv4(b));
  });

  it('pins the CGNAT (100.64/10) boundaries exactly', () => {
    // inside the block → skipped entirely (only candidates below are outside)
    expect(primaryLanIpv4(fakeInterfaces({ x: ['100.64.0.1'] }))).toBeNull();
    expect(primaryLanIpv4(fakeInterfaces({ x: ['100.127.255.254'] }))).toBeNull();
    // outside the block → usable (lands in the non-RFC1918 bucket)
    expect(primaryLanIpv4(fakeInterfaces({ x: ['100.63.255.254'] }))).toBe('100.63.255.254');
    expect(primaryLanIpv4(fakeInterfaces({ x: ['100.128.0.1'] }))).toBe('100.128.0.1');
  });

  it('pins the 172.16/12 RFC1918 boundaries exactly', () => {
    // inside → preferred over a public candidate
    const inside = fakeInterfaces({ a: ['172.16.0.1'], b: ['203.0.113.7'] });
    expect(primaryLanIpv4(inside)).toBe('172.16.0.1');
    const insideHigh = fakeInterfaces({ a: ['172.31.255.254'], b: ['203.0.113.7'] });
    expect(primaryLanIpv4(insideHigh)).toBe('172.31.255.254');
    // outside → not treated as RFC1918 (public candidate sorts first here)
    const outside = fakeInterfaces({ a: ['172.15.0.1'], b: ['10.0.0.5'] });
    expect(primaryLanIpv4(outside)).toBe('10.0.0.5');
    const outsideHigh = fakeInterfaces({ a: ['172.32.0.1'], b: ['10.0.0.5'] });
    expect(primaryLanIpv4(outsideHigh)).toBe('10.0.0.5');
  });
});

describe('advertisedLlmuxBaseUrl', () => {
  it('prefers the default-route IP for loopback hosts (keeping port + scheme)', async () => {
    const out = await advertisedLlmuxBaseUrl(
      'http://localhost:3456',
      {},
      {
        routeProbe: async () => '192.168.77.99',
        interfaces: TYPICAL,
      },
    );
    expect(out).toBe('http://192.168.77.99:3456');
  });

  it('falls back to interface enumeration when the route probe fails', async () => {
    const out = await advertisedLlmuxBaseUrl('http://127.0.0.1:3456', {}, { ...NO_ROUTE, interfaces: TYPICAL });
    expect(out).toBe('http://192.168.77.10:3456');
  });

  it('returns null (NOT a hostname) when no advertisable IP exists — IP-only contract', async () => {
    const out = await advertisedLlmuxBaseUrl(
      'http://localhost:3456',
      {},
      {
        ...NO_ROUTE,
        interfaces: fakeInterfaces({ lo0: ['127.0.0.1'], utun3: ['100.100.7.7'] }),
      },
    );
    expect(out).toBeNull();
  });

  it('passes non-loopback URLs through (trailing slash stripped)', async () => {
    expect(await advertisedLlmuxBaseUrl('http://llmux-box:3456/', {}, NO_ROUTE)).toBe('http://llmux-box:3456');
  });

  it('prefers the LLMUX_ADVERTISED_BASE_URL override, normalized', async () => {
    const env = { LLMUX_ADVERTISED_BASE_URL: 'http://llmux.example.test:3456/' };
    expect(await advertisedLlmuxBaseUrl('http://localhost:3456', env, NO_ROUTE)).toBe('http://llmux.example.test:3456');
  });

  it('returns unparseable input unchanged rather than throwing', async () => {
    expect(await advertisedLlmuxBaseUrl('not a url', {}, NO_ROUTE)).toBe('not a url');
  });

  it('recognizes loopback aliases (trailing-dot FQDN, IPv4-mapped IPv6)', async () => {
    const probe = { routeProbe: async () => '10.9.8.7' };
    expect(await advertisedLlmuxBaseUrl('http://localhost.:3456', {}, probe)).toBe('http://10.9.8.7:3456');
    expect(await advertisedLlmuxBaseUrl('http://[::ffff:127.0.0.1]:3456', {}, probe)).toBe('http://10.9.8.7:3456');
  });
});

describe('buildLlmuxKeyDmText', () => {
  const input = {
    secret: 'lmk-secret-123',
    baseUrl: 'http://192.168.77.10:3456',
    keyId: 'k-abc',
    keyPrefix: 'lmk-secr',
    keyName: 'Z (U123)',
    issuedAtMs: Date.UTC(2026, 7, 21),
  };

  it('carries the secret, the advertised address, and runnable claude code setup', () => {
    const text = buildLlmuxKeyDmText(input);
    expect(text).toContain('lmk-secret-123');
    expect(text).toContain('http://192.168.77.10:3456');
    expect(text).toContain('ANTHROPIC_BASE_URL=http://192.168.77.10:3456');
    expect(text).toContain('ANTHROPIC_API_KEY=lmk-secret-123');
    // the actual launch command
    expect(text).toMatch(/\bclaude\b/);
  });

  it('includes the llmux.json remote snippet with host (no scheme) + api_key', () => {
    const text = buildLlmuxKeyDmText(input);
    expect(text).toContain('"remote"');
    expect(text).toContain('"host": "192.168.77.10:3456"');
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
