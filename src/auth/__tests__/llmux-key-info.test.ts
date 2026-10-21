import { spawnSync } from 'node:child_process';
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

/** The fenced (```) block whose body contains `marker` — selected by content, not position. */
function fencedBlock(text: string, marker: string): string {
  const blocks = text.split('```').filter((_, i) => i % 2 === 1);
  const matches = blocks.filter((block) => block.includes(marker));
  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Runs a DM shell block under bash with `fn` stubbed to print its argv + `envKeys` as one JSON line. */
function runShellBlock(block: string, fn: string, envKeys: string[]) {
  const env = envKeys.map((k) => `${k}:process.env.${k}`).join(',');
  const probe = `${fn}() { node -e 'console.log(JSON.stringify({args:process.argv.slice(1),${env}}))' -- "$@"; }`;
  const result = spawnSync('/bin/bash', ['-c', `${probe}\n${block}`], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  // the probe's single JSON line is the ONLY output — nothing in the block was evaluated
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, unknown> & { args: string[] };
}

/** Hostile values: quotes, `$(...)`, backslash — a shell that evaluated them would print `injected`. */
const HOSTILE_SECRET = "lmk-'$(printf injected)-fixture";

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
    expect(text).toContain("export ANTHROPIC_BASE_URL='http://192.168.77.10:3456'");
    expect(text).toContain("export ANTHROPIC_API_KEY='lmk-secret-123'");
    // the actual launch command
    expect(text).toMatch(/\bclaude\b/);
  });

  it('includes environment-based Codex setup with an explicit Responses provider', () => {
    const text = buildLlmuxKeyDmText(input);
    expect(text).toContain("export OPENAI_BASE_URL='http://192.168.77.10:3456/v1'");
    expect(text).toContain("export OPENAI_API_KEY='lmk-secret-123'");
    expect(text).toContain('codex --model gpt-6.1-sol');
    expect(text).toContain('model_provider="llmux_env"');
    expect(text).toContain('model_providers.llmux_env.env_key="OPENAI_API_KEY"');
    expect(text).toContain('model_providers.llmux_env.wire_api="responses"');
    expect(text).toContain('model_providers.llmux_env.requires_openai_auth=false');
    expect(text).toContain('model_providers.llmux_env.base_url="http://192.168.77.10:3456/v1"');
    expect(text).not.toMatch(/codex (?:login|logout)/);
  });

  it.each([
    'http://h:3456/',
    'http://h:3456/v1',
    'http://h:3456/v1/',
    'http://h:3456/V1',
    'http://h:3456/v1/v1',
    'http://h:3456/v1?x=1#frag',
    'http://h:3456/?x=1',
  ])('normalizes the Codex and Claude base URLs for %s (query/fragment dropped)', (baseUrl) => {
    const text = buildLlmuxKeyDmText({ secret: 'lmk-x', baseUrl });
    const codex = fencedBlock(text, 'codex --model');
    expect(codex).toContain("export OPENAI_BASE_URL='http://h:3456/v1'");
    expect(codex).toContain('model_providers.llmux_env.base_url="http://h:3456/v1"');
    expect(codex).not.toMatch(/\/v1\/v1/i);
    expect(codex).not.toContain('?x=1');
    expect(codex).not.toContain('#frag');
    // Claude Code appends `/v1/messages` itself → the server root, never `.../v1`
    expect(fencedBlock(text, 'ANTHROPIC_BASE_URL')).toContain("export ANTHROPIC_BASE_URL='http://h:3456'\n");
    // the server line shows the same root the command blocks use
    expect(text).toContain('• 서버: `http://h:3456`\n');
  });

  it('keeps a non-API path prefix while stripping the trailing /v1', () => {
    const text = buildLlmuxKeyDmText({ secret: 'lmk-x', baseUrl: 'http://h:3456/llmux/V1/' });
    expect(text).toContain("export OPENAI_BASE_URL='http://h:3456/llmux/v1'");
    expect(text).toContain("export ANTHROPIC_BASE_URL='http://h:3456/llmux'");
    expect(text).toContain('• 서버: `http://h:3456/llmux`\n');
  });

  it.each([
    'not a url/v1/v1',
    'not a url/V1?x=1#frag',
    'not a url//V1/#f',
  ])('normalizes an unparseable %s at string level like a parsed URL', (baseUrl) => {
    const text = buildLlmuxKeyDmText({ secret: 'lmk-x', baseUrl });
    expect(text).toContain('• 서버: `not a url`\n');
    expect(text).toContain("export ANTHROPIC_BASE_URL='not a url'\n");
    const codex = fencedBlock(text, 'codex --model');
    expect(codex).toContain("export OPENAI_BASE_URL='not a url/v1'\n");
    expect(codex).toContain(`-c 'model_providers.llmux_env.base_url="not a url/v1"' \\\n`);
    expect(codex).not.toContain('?x=1');
    expect(codex).not.toContain('#');
  });

  it('reads a scheme-less override (`host:port`) as http so host, port, and every line agree', async () => {
    const env = { LLMUX_ADVERTISED_BASE_URL: 'llmux-box:3456/' };
    const baseUrl = await advertisedLlmuxBaseUrl('http://localhost:3456', env, NO_ROUTE);
    expect(baseUrl).toBe('llmux-box:3456');
    const text = buildLlmuxKeyDmText({ secret: 'lmk-x', baseUrl: baseUrl as string });
    expect(text).toContain('• 서버: `http://llmux-box:3456`\n');
    expect(text).toContain("export ANTHROPIC_BASE_URL='http://llmux-box:3456'");
    expect(text).toContain("export OPENAI_BASE_URL='http://llmux-box:3456/v1'");
    expect(text).toContain('model_providers.llmux_env.base_url="http://llmux-box:3456/v1"');
    expect(JSON.parse(fencedBlock(text, '"remote"')).remote.host).toBe('llmux-box:3456');
  });

  it.each([
    ['http://h:3456', 'h:3456'],
    ['llmux-box:3456', 'llmux-box:3456'],
    ['llmux-box:3456/v1', 'llmux-box:3456'],
    ['llmux-box', 'llmux-box'],
    ['203.0.113.7:3456', '203.0.113.7:3456'],
    ['[::1]:3456', '[::1]:3456'],
    ['HTTPS://Gateway.Example/v1', 'gateway.example'],
    ['not a url', 'not a url'],
  ])('derives the llmux.json remote host from %s as %s', (baseUrl, host) => {
    const text = buildLlmuxKeyDmText({ secret: 'lmk-x', baseUrl });
    expect(JSON.parse(fencedBlock(text, '"remote"')).remote.host).toBe(host);
  });

  it('keeps the Codex TOML base_url valid for unparseable input carrying DEL and a lone surrogate', () => {
    const text = buildLlmuxKeyDmText({ secret: 'lmk-x', baseUrl: 'not a url\u007f\ud800/v1' });
    const tomlLine = fencedBlock(text, 'codex --model')
      .split('\n')
      .find((line) => line.includes('base_url='));
    // DEL is escaped (TOML forbids it raw); the lone surrogate becomes U+FFFD, as URL serialization does
    expect(tomlLine).toBe('  -c \'model_providers.llmux_env.base_url="not a url\\u007f\uFFFD/v1"\' \\');
    expect(tomlLine).not.toMatch(/\\u[dD][89abAB]/);
  });

  it.each([
    {
      // parseable: WHATWG turns `\` into `/` and percent-encodes `"` and space; `$(` survives literally
      baseUrl: 'http://gateway.example:3456/a"b\\c$(printf injected)',
      root: 'http://gateway.example:3456/a%22b/c$(printf%20injected)',
    },
    {
      // unparseable (reachable: unparseable config and the env override pass through) → string fallback
      baseUrl: 'not a url "b\\c$(printf injected)/v1',
      root: 'not a url "b\\c$(printf injected)',
    },
  ])('passes the Codex environment and provider to the shell without evaluating values ($baseUrl)', ({
    baseUrl,
    root,
  }) => {
    const text = buildLlmuxKeyDmText({ secret: HOSTILE_SECRET, baseUrl });
    const captured = runShellBlock(fencedBlock(text, 'codex --model'), 'codex', ['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
    expect(captured.OPENAI_API_KEY).toBe(HOSTILE_SECRET);
    expect(captured.OPENAI_BASE_URL).toBe(`${root}/v1`);
    expect(captured.args).toContain(`model_providers.llmux_env.base_url=${JSON.stringify(`${root}/v1`)}`);
    expect(captured.args).not.toContain(HOSTILE_SECRET);
    expect(captured.args).toContain('model_providers.llmux_env.requires_openai_auth=false');
  });

  it.each([
    {
      baseUrl: 'http://gateway.example:3456/a"b\\c$(printf injected)/v1',
      root: 'http://gateway.example:3456/a%22b/c$(printf%20injected)',
    },
    { baseUrl: 'not a url "b\\c$(printf injected)', root: 'not a url "b\\c$(printf injected)' },
  ])('passes the Claude Code environment to the shell without evaluating values ($baseUrl)', ({ baseUrl, root }) => {
    const text = buildLlmuxKeyDmText({ secret: HOSTILE_SECRET, baseUrl });
    const captured = runShellBlock(fencedBlock(text, 'ANTHROPIC_BASE_URL'), 'claude', [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
    ]);
    expect(captured.ANTHROPIC_API_KEY).toBe(HOSTILE_SECRET);
    expect(captured.ANTHROPIC_BASE_URL).toBe(root);
    expect(captured.args).toEqual([]);
  });

  it('includes the llmux.json remote snippet with host (no scheme) + api_key', () => {
    const text = buildLlmuxKeyDmText(input);
    expect(text).toContain('"remote"');
    expect(text).toContain('"host": "192.168.77.10:3456"');
    expect(text).toContain('"api_key": "lmk-secret-123"');
  });

  it('renders the llmux.json remote snippet as valid JSON for secrets with quotes and backslashes', () => {
    const secret = 'lmk-"q\\b"-fixture';
    const text = buildLlmuxKeyDmText({ secret, baseUrl: 'http://192.168.77.10:3456/v1' });
    const parsed = JSON.parse(fencedBlock(text, '"remote"'));
    expect(parsed).toEqual({ remote: { host: '192.168.77.10:3456', api_key: secret } });
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
