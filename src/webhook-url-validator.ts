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

/** RFC1918 + loopback + link-local + metadata IP ranges */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '::0',
  'metadata.google.internal',
]);

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
    const [, ma, mb] = mappedDotted.map(Number);
    if (ma === 127 || ma === 10 || ma === 0) return true;
    if (ma === 172 && mb >= 16 && mb <= 31) return true;
    if (ma === 192 && mb === 168) return true;
    if (ma === 169 && mb === 254) return true;
    return false;
  }

  // IPv6-mapped IPv4 — hex form (::ffff:7f00:1) — Node's URL normalizes to this
  const mappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    // Reconstruct dotted IPv4 and recheck
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv4 checks
  const ipv4Match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 127.0.0.0/8 — loopback
    if (a === 127) return true;
    // 10.0.0.0/8 — private
    if (a === 10) return true;
    // 172.16.0.0/12 — private
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 — private
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 — link-local (AWS/GCP metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
  }

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
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.startsWith('::')) {
    return { valid: true };
  }

  // Resolve DNS and validate all returned IPs
  try {
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
  } catch (error: any) {
    logger.warn('DNS resolution failed for webhook URL', { hostname, error: error?.message });
    return { valid: false, error: 'DNS 확인 실패: 호스트를 찾을 수 없습니다.' };
  }

  return { valid: true };
}
