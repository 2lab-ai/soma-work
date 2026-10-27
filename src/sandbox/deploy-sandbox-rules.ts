/**
 * What a deploy sandbox grant may contain — the one set of rules both of its
 * readers apply:
 *
 *   - `src/deploy/apply-deploy-sandbox.ts` (deploy time): validates the
 *     `DEPLOY_SANDBOX` repo secret and writes this runner's grant into
 *     `<target>/config.json#deploySandbox`. A value it rejects fails the deploy.
 *   - `./deploy-sandbox-grant.ts` (runtime): reads that key and drops whatever
 *     these rules reject — plus any path that resolves through a symlink —
 *     before the grant reaches the SDK sandbox.
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
  /** Exact hostnames, appended to `sandbox.network.allowedDomains` (only while that allowlist is active). */
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
 * System and shared locations. A grant may not be one of them, lie under one,
 * or lie above one (`/private` would cover `/private/tmp`). `/tmp` matters
 * most: every session already writes its own `/tmp/<userId>`, and a grant
 * there would reach the others'. On macOS `/tmp`, `/var` and `/etc` are
 * symlinks into `/private`. The Linux system roots are listed for hosts that
 * sandbox with bubblewrap.
 */
const FORBIDDEN_ROOTS = [
  '/tmp',
  '/private/tmp',
  '/var',
  '/private/var',
  '/private',
  '/etc',
  '/private/etc',
  '/System',
  '/Library',
  '/usr',
  '/bin',
  '/sbin',
  '/opt',
  '/Applications',
  '/dev',
  '/proc',
  '/sys',
  '/root',
  '/boot',
  '/run',
  '/lib',
  '/lib64',
];
/**
 * Home roots: the root itself, anything above it, and a home directory itself
 * (`/Users/<name>`) are refused; a directory INSIDE a home directory
 * (`/Users/<name>/qa/lock`) is the ordinary case and stays valid.
 */
const HOME_ROOTS = ['/Users', '/home'];
/** `/srv/qa/lock`: a grant is never a top-level or second-level directory. */
const MIN_PATH_COMPONENTS = 3;

export function isSlackUserId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_USER_ID_RE.test(value);
}

/**
 * An exact hostname: lowercase, two or more labels, no wildcard, scheme, port,
 * path, or trailing dot, and never an IP literal (IPv6 cannot match the label
 * syntax; IPv4 is caught by its all-digit last label — no DNS top-level label
 * is all digits).
 */
export function isGrantDomain(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253 || !HOSTNAME_RE.test(value)) return false;
  return !ALL_DIGITS_RE.test(value.slice(value.lastIndexOf('.') + 1));
}

/**
 * Whether `value` (absolute, normalized) is a forbidden root, under one, or
 * above one, or is a home root, above one, or a home directory itself.
 * Compared case-insensitively: the default macOS volume is, so `/TMP/qa/x`
 * names the same directory as `/tmp/qa/x`.
 */
export function isForbiddenGrantLocation(value: string): boolean {
  const folded = value.toLowerCase();
  const isAbove = (root: string) => folded === '/' || root.startsWith(`${folded}/`);
  for (const root of FORBIDDEN_ROOTS.map((entry) => entry.toLowerCase())) {
    if (folded === root || folded.startsWith(`${root}/`) || isAbove(root)) return true;
  }
  for (const root of HOME_ROOTS.map((entry) => entry.toLowerCase())) {
    if (folded === root || isAbove(root)) return true;
    if (folded.startsWith(`${root}/`) && !folded.slice(root.length + 1).includes('/')) return true;
  }
  return false;
}

/**
 * An absolute, already-normalized directory path of at least three
 * components, with no control characters and no `..`, that is not a
 * forbidden location ({@link isForbiddenGrantLocation}). Lexical only: the
 * runtime additionally refuses a path that resolves through a symlink
 * (`deploy-sandbox-grant.ts`), which the deploy step cannot see.
 */
export function isGrantPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (value.endsWith('/') || path.posix.normalize(value) !== value) return false;
  const components = value.split('/').slice(1);
  if (components.length < MIN_PATH_COMPONENTS || components.includes('..')) return false;
  return !isForbiddenGrantLocation(value);
}
