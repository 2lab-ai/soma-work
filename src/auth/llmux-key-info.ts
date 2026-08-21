import * as os from 'node:os';

/**
 * Rendering helpers for the personal llmux key DM (`key` / `auth key`).
 *
 * The DM tells a Slack user how to run a LOCAL Claude Code against the llmux
 * daemon soma-work itself dispatches through, using the SAME per-user client
 * key `ensureTenantKey` issued for their Slack dispatches — so llmux meters
 * their bot usage and their local usage as one tenant.
 *
 * Pure functions — no I/O, no logging (the inputs contain a plaintext secret;
 * keeping this module side-effect-free is what makes "the secret only ever
 * travels inside the DM payload" auditable at the call site).
 */

/** Loopback hosts that are only reachable from the bot machine itself. */
function isLoopbackHost(host: string): boolean {
  // Strip brackets (IPv6 URL form), a trailing FQDN dot (`localhost.`), and
  // the IPv4-mapped IPv6 prefix. WHATWG URL normalizes `[::ffff:127.0.0.1]`
  // to hex (`[::ffff:7f00:1]`), so match the 127.0.0.0/8 block in both forms.
  const h = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
    .replace(/^::ffff:/, '');
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.startsWith('127.') || /^7f[0-9a-f]{2}:/.test(h);
}

/**
 * The bot machine's primary LAN IPv4 — the address a coworker's laptop can
 * actually reach — or `null` when none exists.
 *
 * Skipped outright:
 *   - internal/loopback interfaces
 *   - link-local (`169.254/16`)
 *   - CGNAT `100.64/10` — that block is what Tailscale assigns, and a
 *     tailnet-only address is exactly what the DM must NOT advertise (only
 *     tailscale-connected users could resolve it; 2026-08-21 user directive:
 *     "iq-64는 tailscale 접속한 유저 사용할때만 가능", advertise the IP).
 * RFC1918 (10/8, 172.16/12, 192.168/16) wins over anything else; a public
 * IPv4 is the fallback.
 */
export function primaryLanIpv4(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const rfc1918: string[] = [];
  const other: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const address = info.address;
      if (/^169\.254\./.test(address)) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) rfc1918.push(address);
      else other.push(address);
    }
  }
  return rfc1918[0] ?? other[0] ?? null;
}

/**
 * The llmux address to ADVERTISE to a user's own machine.
 *
 * soma-work reaches llmux at `auth.llmux.baseUrl`, which in every current
 * deployment is loopback (`http://localhost:3456`) — an address that means
 * "this bot host", not "the llmux server", when pasted into someone else's
 * terminal. Resolution order:
 *   1. `LLMUX_ADVERTISED_BASE_URL` env — operator override per deployment
 *      (e.g. a tailnet name), normalized (trailing slashes stripped).
 *   2. Non-loopback `baseUrl` — already externally meaningful; passed through.
 *   3. Loopback `baseUrl` — host swapped for the machine's LAN IPv4
 *      ({@link primaryLanIpv4}). An IP works for every office peer; hostnames
 *      (`iq-64`, mDNS `.local`) only resolve for tailnet/mDNS-capable
 *      clients, so `os.hostname()` is the last resort only.
 * Unparseable input is returned unchanged — the DM degrades to showing what
 * the operator configured instead of throwing away the whole card.
 */
export function advertisedLlmuxBaseUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string {
  const override = env.LLMUX_ADVERTISED_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (isLoopbackHost(url.hostname)) url.hostname = primaryLanIpv4(interfaces) ?? os.hostname();
    return url.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl;
  }
}

/** Everything the DM shows. Only `secret` + `baseUrl` are required. */
export interface LlmuxKeyDmInput {
  /** Plaintext `lmk-…` secret. The DM is the ONLY place this may appear. */
  secret: string;
  /** Advertised llmux base URL (see {@link advertisedLlmuxBaseUrl}). */
  baseUrl: string;
  keyId?: string;
  keyName?: string;
  issuedAtMs?: number;
  rotatedAtMs?: number;
}

/** `host[:port]` form (no scheme) — what llmux.json `remote.host` expects. */
function hostForRemoteConfig(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

/**
 * The Slack-markdown DM body: key identity, the two-line local Claude Code
 * setup, the llmux CLI remote snippet, and handling guidance.
 */
export function buildLlmuxKeyDmText(input: LlmuxKeyDmInput): string {
  const { secret, baseUrl } = input;
  const remoteHost = hostForRemoteConfig(baseUrl);
  const identity: string[] = [];
  if (input.keyName) identity.push(`이름 \`${input.keyName}\``);
  if (input.keyId) identity.push(`id \`${input.keyId}\``);
  if (input.rotatedAtMs) {
    identity.push(`로테이션 ${new Date(input.rotatedAtMs).toISOString().slice(0, 10)}`);
  } else if (input.issuedAtMs) {
    identity.push(`발급 ${new Date(input.issuedAtMs).toISOString().slice(0, 10)}`);
  }

  return [
    ':key: *당신의 llmux 클라이언트 키*',
    '',
    '이 키는 당신 전용입니다 — 봇에서의 사용량과 아래 로컬 사용량이 전부 이 키(테넌트)로 계측됩니다. 같은 유저는 항상 같은 키를 받습니다.',
    '',
    `• 키: \`${secret}\`${identity.length > 0 ? ` (${identity.join(', ')})` : ''}`,
    `• 서버: \`${baseUrl}\``,
    '',
    '*로컬에서 Claude Code 실행하기*',
    '```',
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    `export ANTHROPIC_API_KEY=${secret}`,
    'claude',
    '```',
    '',
    '*llmux CLI를 원격으로 쓰려면* — 클라이언트 머신의 `llmux.json`:',
    '```',
    `{ "remote": { "host": "${remoteHost}", "api_key": "${secret}" } }`,
    '```',
    '',
    ':lock: 이 키는 비밀입니다. 채널·코드·커밋에 붙여넣지 마세요. 유출이 의심되면 관리자에게 로테이션(`llmux key rotate`)을 요청하세요 — 로테이션되면 이 DM의 키는 무효가 되고, `key`를 다시 호출하면 새 키를 받습니다.',
  ].join('\n');
}
