/**
 * Legacy naked command detection + tombstone hint state.
 *
 * See: plan/MASTER-SPEC.md §3-6, §7, §8-3.
 *
 * Behaviour:
 *  - Multi-word "legacy" naked commands (e.g. `persona set linus`, `show prompt`)
 *    no longer execute. Instead the ZRouter shows a tombstone card.
 *  - The hint is shown at most once per user — state is persisted in
 *    user-settings-store via `migrationHintShown` + CAS (see commit 7).
 *  - Whitelisted naked commands (session/new/renew/$…) bypass this entirely.
 */

import { isWhitelistedNaked } from './whitelist';

/**
 * Tombstone mapping: { old naked form → suggested `/z` form }.
 *
 * These are the canonical migration examples shown in the tombstone card.
 * The router will attempt prefix matching in order — first match wins.
 */
export interface TombstoneHint {
  readonly match: RegExp;
  readonly title: string;
  readonly oldForm: string;
  readonly newForm: string;
}

// Ordered most-specific → least-specific.
export const TOMBSTONE_HINTS: readonly TombstoneHint[] = [
  { match: /^\/?help\b/i, title: 'help', oldForm: 'help', newForm: '/z help' },
  { match: /^\/?commands?\b/i, title: 'help', oldForm: 'commands', newForm: '/z help' },
  { match: /^\/?show[_ ]prompt\b/i, title: 'prompt', oldForm: 'show prompt', newForm: '/z prompt' },
  {
    match: /^\/?show[_ ]instructions\b/i,
    title: 'instructions',
    oldForm: 'show instructions',
    newForm: '/z instructions',
  },
  { match: /^\/?show\s+email\b/i, title: 'email', oldForm: 'show email', newForm: '/z email' },
  { match: /^\/?set\s+email\b/i, title: 'email', oldForm: 'set email <x>', newForm: '/z email set <x>' },
  {
    match: /^\/?config\b/i,
    title: 'admin config',
    oldForm: 'config KEY=VAL',
    newForm: '/z admin config set <KEY> <VAL>',
  },
  { match: /^\/?persona\b/i, title: 'persona', oldForm: 'persona set <n>', newForm: '/z persona set <n>' },
  { match: /^\/?model\b/i, title: 'model', oldForm: 'model set <n>', newForm: '/z model set <n>' },
  { match: /^\/?verbosity\b/i, title: 'verbosity', oldForm: 'verbosity <l>', newForm: '/z verbosity set <l>' },
  { match: /^\/?bypass\b/i, title: 'bypass', oldForm: 'bypass on|off', newForm: '/z bypass set on|off' },
  { match: /^\/?sandbox\b/i, title: 'sandbox', oldForm: 'sandbox on|off', newForm: '/z sandbox set on|off' },
  {
    match: /^\/?notify\s+telegram\b/i,
    title: 'notify',
    oldForm: 'notify telegram <token>',
    newForm: '/z notify telegram set <token>',
  },
  { match: /^\/?notify\b/i, title: 'notify', oldForm: 'notify on|off', newForm: '/z notify set on|off' },
  { match: /^\/?memory\b/i, title: 'memory', oldForm: 'memory clear', newForm: '/z memory clear' },
  {
    match: /^\/?webhook\s+register\b/i,
    title: 'webhook',
    oldForm: 'webhook register <url>',
    newForm: '/z webhook add <url>',
  },
  { match: /^\/?webhook\b/i, title: 'webhook', oldForm: 'webhook <verb>', newForm: '/z webhook <verb>' },
  { match: /^\/?servers\b/i, title: 'mcp', oldForm: 'servers', newForm: '/z mcp list' },
  { match: /^\/?mcp\b/i, title: 'mcp', oldForm: 'mcp [list|reload]', newForm: '/z mcp [list|reload]' },
  {
    match: /^\/?플러그인\s*업데이트/i,
    title: 'plugin',
    oldForm: '플러그인 업데이트',
    newForm: '/z plugin update',
  },
  { match: /^\/?plugins?\b/i, title: 'plugin', oldForm: 'plugins <verb>', newForm: '/z plugin <verb>' },
  {
    match: /^\/?marketplace\b/i,
    title: 'marketplace',
    oldForm: 'marketplace add <x>',
    newForm: '/z marketplace add <x>',
  },
  { match: /^\/?skills\b/i, title: 'skill', oldForm: 'skills list', newForm: '/z skill list' },
  { match: /^\/?cwd\b/i, title: 'cwd', oldForm: 'cwd', newForm: '/z cwd' },
  {
    match: /^\/?set\s+directory\b/i,
    title: 'cwd',
    oldForm: 'set directory <p>',
    newForm: '/z cwd set <p>',
  },
  { match: /^\/?nextcct\b/i, title: 'cct', oldForm: 'nextcct', newForm: '/z cct next' },
  { match: /^\/?set_cct\b/i, title: 'cct', oldForm: 'set_cct <n>', newForm: '/z cct set <n>' },
  { match: /^\/?cct\b/i, title: 'cct', oldForm: 'cct', newForm: '/z cct' },
  { match: /^\/?accept\b/i, title: 'admin', oldForm: 'accept <@U>', newForm: '/z admin accept <@U>' },
  { match: /^\/?deny\b/i, title: 'admin', oldForm: 'deny <@U>', newForm: '/z admin deny <@U>' },
  { match: /^\/?users\b/i, title: 'admin', oldForm: 'users', newForm: '/z admin users' },
  { match: /^\/?all_sessions\b/i, title: 'admin', oldForm: 'all_sessions', newForm: '/z admin session list' },
  { match: /^\/?onboarding\b/i, title: 'onboarding', oldForm: 'onboarding', newForm: '/z onboarding' },
  { match: /^\/?context\b/i, title: 'context', oldForm: 'context', newForm: '/z context' },
  { match: /^\/?compact\b/i, title: 'compact', oldForm: 'compact', newForm: '/z compact' },
  { match: /^\/?link\b/i, title: 'link', oldForm: 'link <type> <url>', newForm: '/z link <type> <url>' },
  { match: /^\/?close\b/i, title: 'close', oldForm: 'close', newForm: '/z close' },
  { match: /^\/?report\b/i, title: 'report', oldForm: 'report', newForm: '/z report' },
  { match: /^\/?restore\b/i, title: 'restore', oldForm: 'restore', newForm: '/z restore' },
  {
    match: /^\/?credentials?\b/i,
    title: 'restore',
    oldForm: 'credentials',
    newForm: '/z restore',
  },
  { match: /^\/?prompt\b/i, title: 'prompt', oldForm: 'prompt', newForm: '/z prompt' },
  {
    match: /^\/?instructions?\b/i,
    title: 'instructions',
    oldForm: 'instructions',
    newForm: '/z instructions',
  },
];

/**
 * Detect a legacy naked command. Whitelisted naked commands return `null`
 * (they are not "legacy" — they still work).
 *
 * @returns the best-matching hint, or `null` if `text` is empty /
 *          whitelisted / not recognised as a legacy command.
 */
export function detectLegacyNaked(text: string): TombstoneHint | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  if (isWhitelistedNaked(trimmed)) return null;
  for (const hint of TOMBSTONE_HINTS) {
    if (hint.match.test(trimmed)) return hint;
  }
  return null;
}

/** True if the input looks like a legacy naked command. */
export function isLegacyNaked(text: string): boolean {
  return detectLegacyNaked(text) !== null;
}
