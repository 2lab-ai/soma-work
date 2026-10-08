import { createSocket } from 'node:dgram';
import * as os from 'node:os';

/**
 * Rendering helpers for the personal llmux key DM (`key` / `auth key`).
 *
 * The DM tells a Slack user how to run a LOCAL Claude Code or Codex against the llmux
 * daemon soma-work itself dispatches through, using the SAME per-user client
 * key `ensureTenantKey` issued for their Slack dispatches — so llmux meters
 * their bot usage and their local usage as one tenant.
 *
 * No logging anywhere in this module (the inputs contain a plaintext secret;
 * that is what makes "the secret only ever travels inside the DM payload"
 * auditable at the call site). The only I/O is {@link defaultRouteIpv4}'s
 * local routing-table lookup — it never transmits, logs, or sees the secret.
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

const LINK_LOCAL_RE = /^169\.254\./;
/** Carrier-grade NAT 100.64.0.0/10 — what Tailscale assigns. */
const CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const RFC1918_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Whether `address` is worth advertising to a coworker's machine. Rejects
 * loopback, link-local, and Tailscale CGNAT — a tailnet-only address is
 * exactly what the DM must NOT advertise (only tailscale-connected users can
 * reach it; 2026-08-21 user directive: advertise the IP, hostname-like
 * tailnet handles don't resolve for everyone).
 */
function isAdvertisableIpv4(address: string): boolean {
  return !address.startsWith('127.') && !LINK_LOCAL_RE.test(address) && !CGNAT_RE.test(address);
}

/**
 * The IPv4 the default route egresses from — the routing table's own answer
 * to "which of my addresses do peers reach me at". A UDP `connect()` performs
 * the route lookup locally and binds the local address WITHOUT sending any
 * packet, so this works offline-config-free and never touches the network.
 * `null` on failure/timeout or when the selected address is not advertisable
 * (e.g. the default route egresses over the tailnet).
 */
export function defaultRouteIpv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 300);
    timer.unref?.();
    socket.on('error', () => done(null));
    try {
      socket.connect(53, '1.1.1.1', () => {
        clearTimeout(timer);
        try {
          const address = socket.address().address;
          done(address && isAdvertisableIpv4(address) ? address : null);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

/**
 * Deterministic interface-enumeration fallback: every advertisable IPv4,
 * RFC1918 preferred over the rest, ties broken by sorted interface name and
 * sorted address — same interface set in any enumeration order yields the
 * same answer. This is a POLICY fallback, not a routing decision; when a host
 * has several private NICs (VM bridges, secondary LANs) the route-aware
 * {@link defaultRouteIpv4} is authoritative and operators with exotic
 * topologies should pin `LLMUX_ADVERTISED_BASE_URL`.
 */
export function primaryLanIpv4(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const rfc1918: string[] = [];
  const other: string[] = [];
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!isAdvertisableIpv4(info.address)) continue;
      (RFC1918_RE.test(info.address) ? rfc1918 : other).push(info.address);
    }
  }
  rfc1918.sort();
  other.sort();
  return rfc1918[0] ?? other[0] ?? null;
}

/** Test seam for {@link advertisedLlmuxBaseUrl}'s two IP sources. */
export interface AdvertiseProbes {
  routeProbe?: () => Promise<string | null>;
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

/**
 * The llmux address to ADVERTISE to a user's own machine — always an IP for
 * loopback deployments, or `null` when none can be determined.
 *
 * soma-work reaches llmux at `auth.llmux.baseUrl`, which in every current
 * deployment is loopback (`http://localhost:3456`) — an address that means
 * "this bot host", not "the llmux server", when pasted into someone else's
 * terminal. Resolution order:
 *   1. `LLMUX_ADVERTISED_BASE_URL` env — operator override per deployment,
 *      normalized (trailing slashes stripped).
 *   2. Non-loopback `baseUrl` — already externally meaningful; passed through.
 *   3. Loopback `baseUrl` — host swapped for the default-route IPv4
 *      ({@link defaultRouteIpv4}), else the deterministic enumeration pick
 *      ({@link primaryLanIpv4}). Hostnames are NEVER substituted: tailnet/mDNS
 *      host names only resolve for tailscale/mDNS-capable clients, and sending
 *      one would ship instructions that fail on a plain office network. No IP →
 *      `null`; the caller reports a configuration error instead of a card.
 * Unparseable input is returned unchanged — the DM degrades to showing what
 * the operator configured instead of throwing away the whole card.
 */
export async function advertisedLlmuxBaseUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  probes?: AdvertiseProbes,
): Promise<string | null> {
  const override = env.LLMUX_ADVERTISED_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (!isLoopbackHost(url.hostname)) return url.toString().replace(/\/+$/, '');
    const ip = (await (probes?.routeProbe ?? defaultRouteIpv4)()) ?? primaryLanIpv4(probes?.interfaces);
    if (!ip) return null;
    url.hostname = ip;
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

/** A `scheme://` prefix. Without one, WHATWG reads `llmux-box:3456` as scheme `llmux-box:` with an empty host. */
const SCHEME_PREFIX_RE = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * Parses an advertised llmux address; a scheme-less value (e.g. a
 * `LLMUX_ADVERTISED_BASE_URL=llmux-box:3456` override) is read as `http://`.
 * Throws when the input is not a URL even then.
 */
function parseAdvertisedUrl(baseUrl: string): URL {
  return new URL(SCHEME_PREFIX_RE.test(baseUrl) ? baseUrl : `http://${baseUrl}`);
}

/** `host[:port]` form (no scheme) — what llmux.json `remote.host` expects. */
function hostForRemoteConfig(baseUrl: string): string {
  try {
    const url = parseAdvertisedUrl(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

/** Trailing `/v1` API segments (any case, repeated) plus trailing slashes at the end of a path. */
const TRAILING_API_PATH_RE = /(?:\/+v1)*\/*$/i;

/**
 * The llmux server root (no trailing slash, no `/v1`) — Claude Code appends
 * `/v1/messages` itself and the Codex URL is this root plus `/v1`, so an
 * advertised `…/v1`, `…/V1/` or `…/v1/v1` must collapse to one root. Query and
 * fragment are dropped: clients append API paths to a base URL, so neither can
 * survive. WHATWG serialization also percent-encodes control/non-ASCII
 * characters. Unparseable input gets the same query/fragment drop and `/v1`
 * strip at string level.
 */
function llmuxRootUrl(baseUrl: string): string {
  try {
    const url = parseAdvertisedUrl(baseUrl);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(TRAILING_API_PATH_RE, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl.split(/[?#]/, 1)[0].replace(TRAILING_API_PATH_RE, '');
  }
}

/** A lone UTF-16 surrogate — with the `u` flag a valid pair is one code point and never matches. */
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/gu;

/**
 * TOML basic string. JSON string syntax is TOML's except that JSON leaves
 * U+007F raw and writes lone surrogates as `\uD8xx` escapes, both invalid
 * TOML: DEL is escaped and a lone surrogate becomes U+FFFD (as URL
 * serialization does). Only an unparseable address can carry either.
 */
function tomlBasicString(value: string): string {
  return JSON.stringify(value.replace(LONE_SURROGATE_RE, '\uFFFD')).replace(/\u007f/g, '\\u007f');
}

/** POSIX shell literal: values from operator config must never become shell code. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * The Slack-markdown DM body: key identity, local Claude Code / Codex
 * setup, the llmux CLI remote snippet, and handling guidance.
 */
export function buildLlmuxKeyDmText(input: LlmuxKeyDmInput): string {
  const { secret, baseUrl } = input;
  const remoteHost = hostForRemoteConfig(baseUrl);
  const rootUrl = llmuxRootUrl(baseUrl);
  const codexBaseUrl = `${rootUrl}/v1`;
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
    `• 서버: \`${rootUrl}\``,
    '',
    '*로컬에서 Claude Code 실행하기*',
    '```',
    `export ANTHROPIC_BASE_URL=${shellQuote(rootUrl)}`,
    `export ANTHROPIC_API_KEY=${shellQuote(secret)}`,
    'claude',
    '```',
    '',
    '*로컬에서 Codex 실행하기* — bash/zsh 터미널에 복사하세요:',
    '```',
    `export OPENAI_BASE_URL=${shellQuote(codexBaseUrl)}`,
    `export OPENAI_API_KEY=${shellQuote(secret)}`,
    'codex --model gpt-6.1-sol \\',
    `  -c 'model_provider="llmux_env"' \\`,
    `  -c 'model_providers.llmux_env.name="llmux"' \\`,
    `  -c ${shellQuote(`model_providers.llmux_env.base_url=${tomlBasicString(codexBaseUrl)}`)} \\`,
    `  -c 'model_providers.llmux_env.env_key="OPENAI_API_KEY"' \\`,
    `  -c 'model_providers.llmux_env.wire_api="responses"' \\`,
    `  -c 'model_providers.llmux_env.requires_openai_auth=false' \\`,
    `  -c 'model_providers.llmux_env.supports_websockets=false'`,
    '```',
    '환경변수는 현재 터미널에 적용됩니다. 위 `-c` 옵션까지 함께 실행하면 기존 로그인 대신 이 키를 사용하며, Codex 설정 파일과 로그인 정보는 덮어쓰지 않습니다. llmux를 쓰는 동안에는 같은 명령으로 시작하세요.',
    '',
    '*llmux CLI를 원격으로 쓰려면* — 클라이언트 머신의 `llmux.json`:',
    '```',
    `{ "remote": { "host": ${JSON.stringify(remoteHost)}, "api_key": ${JSON.stringify(secret)} } }`,
    '```',
    '',
    ':lock: 이 키는 비밀입니다. 채널·코드·커밋에 붙여넣지 마세요. 유출이 의심되면 관리자에게 로테이션(`llmux key rotate`)을 요청하세요 — 로테이션되면 이 DM의 키는 무효가 되고, `key`를 다시 호출하면 새 키를 받습니다.',
  ].join('\n');
}
