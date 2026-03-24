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
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

/** Check if the first two octets (a.b) fall in a private/reserved range. */
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true;       // loopback, private, unspecified
  if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                  // 192.168.0.0/16
  if (a === 169 && b === 254) return true;                  // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true;        // 100.64.0.0/10 CGNAT (RFC 6598)
  if (a === 198 && (b === 18 || b === 19)) return true;     // 198.18.0.0/15 benchmarking
  return false;
}

/**
 * Check if a hostname is a blocked IP address (private ranges, loopback, link-local, metadata).
 */
export function isBlockedIp(hostname: string): boolean {
  // Remove brackets for IPv6
  const clean = hostname.replace(/^\[|\]$/g, '');

  // Pure IPv6 loopback/unspecified
  if (clean === '::1' || clean === '::0' || clean === '::') return true;

  // IPv6-mapped IPv4 — dotted form (::ffff:A.B.C.D)
  const mappedDotted = clean.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (mappedDotted) {
    const [, a, b] = mappedDotted.map(Number);
    return isPrivateIpv4(a, b);
  }

  // IPv6-mapped IPv4 — hex form (::ffff:7f00:1) — Node's URL normalizes to this
  const mappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    return isPrivateIpv4(a, b);
  }

  // IPv4 checks
  const ipv4Match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    return isPrivateIpv4(a, b);
  }

  // IPv6-native private ranges
  const lower = clean.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;  // ULA fc00::/7
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;  // link-local fe80::/10

  return false;
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

  // Blocked hostnames
  const hostname = parsed.hostname.toLowerCase();
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
 */
export async function validateWebhookUrlWithDns(raw: string): Promise<WebhookUrlValidation> {
  // First pass: synchronous hostname/IP checks
  const staticCheck = validateWebhookUrl(raw);
  if (!staticCheck.valid) return staticCheck;

  const parsed = new URL(raw);
  const hostname = parsed.hostname.toLowerCase();

  // Skip DNS resolution for IP literals — already checked by isBlockedIp
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname)) {
    return { valid: true };
  }

  // Resolve DNS and validate all returned IPs
  const [ipv4s, ipv6s] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);

  const allIps = [...ipv4s, ...ipv6s];
  if (allIps.length === 0) {
    return { valid: false, error: 'DNS 확인 실패: 호스트를 찾을 수 없습니다.' };
  }

  for (const ip of allIps) {
    if (isBlockedIp(ip)) {
      logger.warn('Blocked webhook URL (DNS rebinding)', { hostname, resolvedIp: ip });
      return { valid: false, error: '내부 네트워크 주소로 확인되는 도메인은 등록할 수 없습니다.' };
    }
  }

  return { valid: true };
}
