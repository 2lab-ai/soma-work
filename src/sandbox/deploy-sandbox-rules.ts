/**
 * What a deploy sandbox grant may contain — the one set of rules both of its
 * readers apply:
 *
 *   - `src/deploy/apply-deploy-sandbox.ts` (deploy time): validates the
 *     `DEPLOY_SANDBOX` repo secret and writes this runner's grant into
 *     `<target>/config.json#deploySandbox`. A value it rejects fails the deploy.
 *   - `./deploy-sandbox-grant.ts` (runtime): reads that key and drops whatever
 *     these rules reject before the grant reaches the SDK sandbox.
 *
 * Node built-ins only: the deploy step loads this before `npm ci` on the target
 * (the bundle carries no `node_modules`), through `apply-deploy-sandbox.ts`.
 */

import path from 'node:path';

/** The config.json key the deploy step writes and the runtime reads. */
export const DEPLOY_SANDBOX_KEY = 'deploySandbox';

export interface DeploySandboxGrant {
  /** Slack user IDs whose turns in a deploy-workflow session get the grant. */
  users: string[];
  /** Appended to `sandbox.network.allowedDomains` (only while that allowlist is active). */
  allowedDomains: string[];
  /** Appended to `sandbox.filesystem.allowWrite`. */
  allowWrite: string[];
}

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
/** One DNS label: lowercase letters, digits, inner hyphens, at most 63 characters. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** Two or more labels: a bare TLD or single-label name is never granted. */
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const ALL_DIGITS_RE = /^[0-9]+$/;
/**
 * Shared scratch space. Every session already writes its own `/tmp/<userId>`;
 * a grant under `/tmp` would reach the other users' directories. `/private/tmp`
 * is the same directory on macOS, where `/tmp` is a symlink to it.
 */
const TMP_ROOTS = ['/tmp', '/private/tmp'];

export function isSlackUserId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_USER_ID_RE.test(value);
}

/**
 * A hostname, or `*.` + hostname (the SDK's subdomain wildcard). Lowercase, no
 * scheme, port, path, or trailing dot, and never an IP literal: IPv6 cannot
 * match the label syntax, and IPv4 is caught by its all-digit last label (no
 * DNS top-level label is all digits).
 */
export function isGrantDomain(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const host = value.startsWith('*.') ? value.slice(2) : value;
  if (host.length > 253 || !HOSTNAME_RE.test(host)) return false;
  return !ALL_DIGITS_RE.test(host.slice(host.lastIndexOf('.') + 1));
}

/** An absolute, already-normalized directory path: not `/`, no `..`, nothing under `/tmp`. */
export function isGrantPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/') return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (value.endsWith('/') || path.posix.normalize(value) !== value) return false;
  if (value.split('/').includes('..')) return false;
  return !TMP_ROOTS.some((root) => value === root || value.startsWith(`${root}/`));
}
