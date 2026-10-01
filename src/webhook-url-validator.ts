/**
 * Webhook URL validation — SSRF prevention.
 *
 * Rules:
 * 1. Only HTTPS URLs allowed
 * 2. Private/reserved IP ranges blocked
 * 3. Loopback, link-local, metadata endpoints blocked
 * 4. DNS resolution validates resolved IPs (anti-rebinding)
 */

import { promises as dns } from 'node:dns';
import { Logger } from './logger.js';

const logger = new Logger('WebhookUrlValidator');

/** Hostnames that aren't IP addresses but should be blocked */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/**
 * The "Globally Reachable" column of the IANA special-purpose address registries, footnote markers
 * dropped. '' is the registry's own empty cell (terminated allocations).
 */
export type GloballyReachable = 'True' | 'False' | 'N/A' | '';

/** One address block of a special-purpose registry and its "Globally Reachable" value. */
export type RegistryRow = readonly [cidr: string, globallyReachable: GloballyReachable];

/**
 * IANA IPv4 Special-Purpose Address Registry, in registry order, as vendored in
 * verification/iana/iana-ipv4-special-registry-1.csv (fetched 2026-09-29). Its row listing two
 * blocks (192.0.0.170/32, 192.0.0.171/32) is two entries here. An address is blocked when the most
 * specific block containing it says anything but 'True'. The conformance test checks this table
 * against the vendored file; the Lean model carries the same rows
 * (verification/lean/SomaVerify/WebhookSsrf/Model.lean).
 */
export const IPV4_SPECIAL_PURPOSE: readonly RegistryRow[] = [
  ['0.0.0.0/8', 'False'],
  ['0.0.0.0/32', 'False'],
  ['10.0.0.0/8', 'False'],
  ['100.64.0.0/10', 'False'],
  ['127.0.0.0/8', 'False'],
  ['169.254.0.0/16', 'False'],
  ['172.16.0.0/12', 'False'],
  ['192.0.0.0/24', 'False'],
  ['192.0.0.0/29', 'False'],
  ['192.0.0.8/32', 'False'],
  ['192.0.0.9/32', 'True'],
  ['192.0.0.10/32', 'True'],
  ['192.0.0.170/32', 'False'],
  ['192.0.0.171/32', 'False'],
  ['192.0.2.0/24', 'False'],
  ['192.31.196.0/24', 'True'],
  ['192.52.193.0/24', 'True'],
  ['192.88.99.0/24', ''],
  ['192.88.99.2/32', 'False'],
  ['192.168.0.0/16', 'False'],
  ['192.175.48.0/24', 'True'],
  ['198.18.0.0/15', 'False'],
  ['198.51.100.0/24', 'False'],
  ['203.0.113.0/24', 'False'],
  ['240.0.0.0/4', 'False'],
  ['255.255.255.255/32', 'False'],
];

/** IANA IPv6 Special-Purpose Address Registry, the same way (iana-ipv6-special-registry-1.csv). */
export const IPV6_SPECIAL_PURPOSE: readonly RegistryRow[] = [
  ['::1/128', 'False'],
  ['::/128', 'False'],
  ['::ffff:0:0/96', 'False'],
  ['64:ff9b::/96', 'True'],
  ['64:ff9b:1::/48', 'False'],
  ['100::/64', 'False'],
  ['100:0:0:1::/64', 'False'],
  ['2001::/23', 'False'],
  ['2001::/32', 'N/A'],
  ['2001:1::1/128', 'True'],
  ['2001:1::2/128', 'True'],
  ['2001:1::3/128', 'True'],
  ['2001:2::/48', 'False'],
  ['2001:3::/32', 'True'],
  ['2001:4:112::/48', 'True'],
  ['2001:10::/28', ''],
  ['2001:20::/28', 'True'],
  ['2001:30::/28', 'True'],
  ['2001:db8::/32', 'False'],
  ['2002::/16', 'N/A'],
  ['2620:4f:8000::/48', 'True'],
  ['3fff::/20', 'False'],
  ['5f00::/16', 'False'],
  ['fc00::/7', 'False'],
  ['fe80::/10', 'False'],
];

/** IPv4 multicast (RFC 5771): blocked although the registry does not list it. */
const IPV4_ALSO_BLOCKED = ['224.0.0.0/4'];

/**
 * 2000::/3, the only "Global Unicast" allocation of the IANA IPv6 Address Space registry
 * (https://www.iana.org/assignments/ipv6-address-space/). IPv6 outside it is blocked, NAT64 aside:
 * that covers ::, ::1, IPv4-compatible and IPv4-mapped addresses, fc00::/7, fe80::/10, fec0::/10,
 * ff00::/8 and all reserved space. Inside it, the special-purpose registry decides.
 */
const IPV6_GLOBAL_UNICAST_CIDR = '2000::/3';

/**
 * NAT64 well-known prefix (RFC 6052), outside 2000::/3 and "Globally Reachable: True". It carries an
 * IPv4 address in its low 32 bits, and is blocked when that address is.
 */
const NAT64_WELL_KNOWN_CIDR = '64:ff9b::/96';

/** `a.b.c.d`, each part 1-3 decimal digits and at most 255, as a number below 2^32; else null. */
function parseIpv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256n + BigInt(octet);
  }
  return value;
}

/**
 * Colon-separated groups of 1-4 hex digits. With `ipv4Tail` the last field may instead be a dotted
 * quad, which counts as two groups. '' has no groups; an empty field is malformed (null).
 */
function parseGroups(part: string, ipv4Tail: boolean): number[] | null {
  if (part === '') return [];
  const fields = part.split(':');
  const groups: number[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (/^[0-9a-f]{1,4}$/i.test(fields[i])) {
      groups.push(Number.parseInt(fields[i], 16));
    } else if (ipv4Tail && i === fields.length - 1) {
      const ipv4 = parseIpv4(fields[i]);
      if (ipv4 === null) return null;
      groups.push(Number(ipv4 >> 16n), Number(ipv4 & 0xffffn));
    } else {
      return null;
    }
  }
  return groups;
}

/**
 * IPv6 text (RFC 4291 section 2.2: hex groups, at most one `::`, optionally a dotted-quad tail) as a
 * number below 2^128; null for anything else, zone IDs included.
 */
function parseIpv6(text: string): bigint | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0], halves.length === 1);
  const tail = halves.length === 2 ? parseGroups(halves[1], true) : [];
  if (head === null || tail === null) return null;
  const explicit = head.length + tail.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  const groups = [...head, ...new Array<number>(8 - explicit).fill(0), ...tail];
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

interface Block {
  base: bigint;
  length: number;
}

/** `address/length` from the tables above; they are constants, so a malformed entry is a bug. */
function parseBlock(cidr: string, bits: 32 | 128): Block {
  const [address, length] = cidr.split('/');
  const base = bits === 32 ? parseIpv4(address) : parseIpv6(address);
  const prefixLength = Number(length);
  if (base === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > bits) {
    throw new Error(`malformed address block: ${cidr}`);
  }
  return { base, length: prefixLength };
}

function inBlock(address: bigint, block: Block, bits: number): boolean {
  const shift = BigInt(bits - block.length);
  return address >> shift === block.base >> shift;
}

interface RegistryBlock extends Block {
  globallyReachable: GloballyReachable;
}

const IPV4_REGISTRY: readonly RegistryBlock[] = IPV4_SPECIAL_PURPOSE.map(([cidr, globallyReachable]) => ({
  ...parseBlock(cidr, 32),
  globallyReachable,
}));
const IPV6_REGISTRY: readonly RegistryBlock[] = IPV6_SPECIAL_PURPOSE.map(([cidr, globallyReachable]) => ({
  ...parseBlock(cidr, 128),
  globallyReachable,
}));
const IPV4_EXTRA: readonly Block[] = IPV4_ALSO_BLOCKED.map((cidr) => parseBlock(cidr, 32));
const IPV6_GLOBAL_UNICAST = parseBlock(IPV6_GLOBAL_UNICAST_CIDR, 128);
const NAT64_WELL_KNOWN = parseBlock(NAT64_WELL_KNOWN_CIDR, 128);

/**
 * Registry verdict: blocked when a block containing `address` is not "Globally Reachable: True" (N/A
 * and the empty cell fail closed) and no more specific block containing it is. No block, no verdict.
 */
function registryBlocks(address: bigint, registry: readonly RegistryBlock[], bits: number): boolean {
  const containing = registry.filter((block) => inBlock(address, block, bits));
  return containing.some(
    (block) =>
      block.globallyReachable !== 'True' &&
      !containing.some((other) => other.length > block.length && other.globallyReachable === 'True'),
  );
}

function isBlockedIpv4(address: bigint): boolean {
  return registryBlocks(address, IPV4_REGISTRY, 32) || IPV4_EXTRA.some((block) => inBlock(address, block, 32));
}

/**
 * A NAT64 address takes the verdict of the IPv4 address it carries. Any other IPv6 address is
 * blocked unless it is global unicast and the special-purpose registry does not block it.
 */
function isBlockedIpv6(address: bigint): boolean {
  if (inBlock(address, NAT64_WELL_KNOWN, 128)) return isBlockedIpv4(address & 0xffffffffn);
  return !inBlock(address, IPV6_GLOBAL_UNICAST, 128) || registryBlocks(address, IPV6_REGISTRY, 128);
}

/** `[::1]` → `::1`: URL hostnames keep IPv6 brackets. */
function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/**
 * Whether an IP address (IPv6 brackets allowed) is blocked; null when `hostname` is not one. Text
 * with a ':' can only be an IPv6 literal (DNS names never contain one), so if it does not parse
 * (a zone ID such as `fe80::1%eth0`, which net.isIP accepts, or garbage) it is blocked.
 */
function ipVerdict(hostname: string): boolean | null {
  const clean = stripBrackets(hostname);
  const ipv4 = parseIpv4(clean);
  if (ipv4 !== null) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(clean);
  if (ipv6 !== null) return isBlockedIpv6(ipv6);
  if (clean.includes(':')) return true;
  return null;
}

/**
 * Check if a hostname is a blocked IP address (private ranges, loopback, link-local, metadata).
 * IPv6 brackets are allowed. A hostname that is not an IP address is not blocked here; text with
 * a ':' that does not parse counts as an unreadable IPv6 literal and is blocked.
 */
export function isBlockedIp(hostname: string): boolean {
  return ipVerdict(hostname) === true;
}

/**
 * The hostname both checks examine: lower-cased, every trailing dot stripped (`localhost..` →
 * `localhost`). A loop, not `/\.+$/`, which backtracks quadratically on a long run of inner dots.
 */
function checkedHostname(parsed: URL): string {
  const hostname = parsed.hostname.toLowerCase();
  let end = hostname.length;
  while (end > 0 && hostname[end - 1] === '.') end--;
  return hostname.slice(0, end);
}

export interface WebhookUrlValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validate a webhook URL for registration (synchronous hostname check).
 * Returns { valid: true } or { valid: false, error: "reason" }.
 */
export function validateWebhookUrl(raw: string): WebhookUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, error: '올바른 URL 형식이 아닙니다.' };
  }

  // HTTPS only
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'HTTPS URL만 등록 가능합니다.' };
  }

  // Blocked hostnames — strip trailing dots (FQDN normalization: `localhost.` → `localhost`)
  const hostname = checkedHostname(parsed);
  // A host made only of dots leaves nothing to check.
  if (hostname === '') {
    return { valid: false, error: '올바른 URL 형식이 아닙니다.' };
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    logger.warn('Blocked webhook URL (hostname)', { hostname });
    return { valid: false, error: '내부 네트워크 주소는 등록할 수 없습니다.' };
  }

  // Blocked IP ranges
  if (isBlockedIp(hostname)) {
    logger.warn('Blocked webhook URL (private IP)', { hostname });
    return { valid: false, error: '내부 네트워크 주소는 등록할 수 없습니다.' };
  }

  return { valid: true };
}

/**
 * Validate webhook URL with DNS resolution — prevents DNS rebinding attacks.
 * Resolves the hostname and checks all returned IPs against blocked ranges.
 * Use this before actually fetching the URL.
 *
 * Known limitation (TOCTOU): DNS is resolved here for validation, but fetch()
 * performs its own DNS resolution independently. An attacker controlling a DNS
 * server could return a public IP during validation and a private IP during
 * fetch (DNS rebinding). Mitigations in place:
 * - HTTPS requirement makes exploitation harder (private IP needs valid TLS cert)
 * - redirect: 'error' on fetch prevents redirect-based SSRF bypass
 * Full fix would require a custom http.Agent with lookup callback for connect-time
 * IP re-validation — acceptable tradeoff for current threat model.
 */
export async function validateWebhookUrlWithDns(raw: string): Promise<WebhookUrlValidation> {
  // First pass: synchronous hostname/IP checks
  const staticCheck = validateWebhookUrl(raw);
  if (!staticCheck.valid) return staticCheck;

  // Skip DNS resolution only when the URL parser itself produced an IP literal, and an allowed one.
  // The parser canonicalizes IP hosts (`https://012.0.0.1./` has the hostname `10.0.0.1`), but a
  // dotted quad followed by two or more dots stays a DNS name (`1.2.3.4..`) and is resolved, even
  // though the first pass, which strips every trailing dot, examined it as an address.
  const parsed = new URL(raw);
  if (ipVerdict(parsed.hostname) === false) return { valid: true };
  // The resolvers take the hostname the first pass examined, without IPv6 brackets
  const hostname = stripBrackets(checkedHostname(parsed));

  // Resolve DNS and validate all returned IPs
  const [ipv4s, ipv6s] = await Promise.all([
    dns.resolve4(hostname).catch((err) => {
      logger.warn('DNS resolve4 failed', { hostname, code: err?.code });
      return [] as string[];
    }),
    dns.resolve6(hostname).catch((err) => {
      logger.warn('DNS resolve6 failed', { hostname, code: err?.code });
      return [] as string[];
    }),
  ]);

  const allIps = [...ipv4s, ...ipv6s];
  if (allIps.length === 0) {
    return { valid: false, error: 'DNS 확인 실패: 호스트를 찾을 수 없습니다.' };
  }

  // An answer that is not an IP address cannot be checked, so it blocks too (fail closed).
  for (const ip of allIps) {
    if (ipVerdict(ip) !== false) {
      logger.warn('Blocked webhook URL (DNS rebinding)', { hostname, resolvedIp: ip });
      return { valid: false, error: '내부 네트워크 주소로 확인되는 도메인은 등록할 수 없습니다.' };
    }
  }

  return { valid: true };
}
