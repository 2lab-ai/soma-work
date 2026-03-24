/**
 * Webhook URL validation — SSRF prevention.
 *
 * Rules:
 * 1. Only HTTPS URLs allowed
 * 2. Private/reserved IP ranges blocked
 * 3. Loopback, link-local, metadata endpoints blocked
 */

import { Logger } from './logger.js';

const logger = new Logger('WebhookUrlValidator');

/** RFC1918 + loopback + link-local + metadata IP ranges */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '[::0]',
  'metadata.google.internal',
]);

/**
 * Check if a hostname is a blocked IP address (private ranges, loopback, link-local, metadata).
 */
function isBlockedIp(hostname: string): boolean {
  // Remove brackets for IPv6
  const clean = hostname.replace(/^\[|\]$/g, '');

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
 * Validate a webhook URL for registration.
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
