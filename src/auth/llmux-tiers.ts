/**
 * Subscription tier per llmux account (SSOT 2026-10-23 T10).
 *
 * llmux `/llmux/status` carries no plan tier — its own `tier` is the bare
 * credential `subscriptionType` ("max"), which cannot tell Max x5 from x20, and
 * Codex accounts carry none. soma-work therefore owns the mapping:
 *
 *   explicit config (SOMA_LLMUX_ACCOUNT_TIERS) → a validated tier string llmux
 *   reports itself → built-in defaults → unknown.
 *
 * The tier is display data (colour + label on the dashboard cooldown timeline).
 * It never weighs the capacity percentage: a plan price is not a token ratio.
 */

export type LlmuxTierId = 'claude-max-5x' | 'claude-max-20x' | 'chatgpt-pro-200' | 'chatgpt-pro-500';

export interface LlmuxTierInfo {
  id: LlmuxTierId;
  provider: 'claude' | 'codex';
  /** Full label, e.g. "Max x20". */
  label: string;
  /** Marker label, e.g. "x20" / "$500". */
  short: string;
  /** Higher or lower plan of its provider — the colour key. */
  rank: 'high' | 'low';
}

export const LLMUX_TIERS: Record<LlmuxTierId, LlmuxTierInfo> = {
  'claude-max-5x': { id: 'claude-max-5x', provider: 'claude', label: 'Max x5', short: 'x5', rank: 'low' },
  'claude-max-20x': { id: 'claude-max-20x', provider: 'claude', label: 'Max x20', short: 'x20', rank: 'high' },
  'chatgpt-pro-200': { id: 'chatgpt-pro-200', provider: 'codex', label: 'Pro ($200)', short: '$200', rank: 'low' },
  'chatgpt-pro-500': { id: 'chatgpt-pro-500', provider: 'codex', label: 'Pro ($500)', short: '$500', rank: 'high' },
};

/**
 * Operator-supplied defaults (2026-10-23): Codex ai5 · ai6 are ChatGPT Pro
 * ($500), ai1 · ai2 Pro ($200). Claude accounts have no default — an unmapped
 * one shows as "티어 미지정" until SOMA_LLMUX_ACCOUNT_TIERS names it.
 */
export const DEFAULT_LLMUX_ACCOUNT_TIERS: Readonly<Record<string, LlmuxTierId>> = Object.freeze({
  'codex:ai1': 'chatgpt-pro-200',
  'codex:ai2': 'chatgpt-pro-200',
  'codex:ai5': 'chatgpt-pro-500',
  'codex:ai6': 'chatgpt-pro-500',
});

const TIER_ALIASES: Record<string, LlmuxTierId> = {
  'claude-max-5x': 'claude-max-5x',
  'claude-max-20x': 'claude-max-20x',
  'chatgpt-pro-200': 'chatgpt-pro-200',
  'chatgpt-pro-500': 'chatgpt-pro-500',
  'max-5x': 'claude-max-5x',
  'max-20x': 'claude-max-20x',
  max5: 'claude-max-5x',
  max20: 'claude-max-20x',
  x5: 'claude-max-5x',
  x20: 'claude-max-20x',
  pro200: 'chatgpt-pro-200',
  pro500: 'chatgpt-pro-500',
  'pro-200': 'chatgpt-pro-200',
  'pro-500': 'chatgpt-pro-500',
};

/**
 * Upstream tier strings that name the plan exactly (Anthropic's
 * `rate_limit_tier` values). A bare "max" is deliberately absent.
 */
const UPSTREAM_TIERS: Record<string, LlmuxTierId> = {
  default_claude_max_5x: 'claude-max-5x',
  default_claude_max_20x: 'claude-max-20x',
  claude_max_5x: 'claude-max-5x',
  claude_max_20x: 'claude-max-20x',
  max_5x: 'claude-max-5x',
  max_20x: 'claude-max-20x',
};

/**
 * Parse `SOMA_LLMUX_ACCOUNT_TIERS`: entries separated by `,` or `;`, each
 * `group:name=tier` (one group) or `name=tier` (any group). Malformed entries
 * are reported, never guessed.
 */
export function parseLlmuxAccountTiers(raw: string | undefined): {
  tiers: Record<string, LlmuxTierId>;
  invalid: string[];
} {
  const tiers: Record<string, LlmuxTierId> = {};
  const invalid: string[] = [];
  if (!raw || !raw.trim()) return { tiers, invalid };
  for (const part of raw.split(/[,;]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const key = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : '';
    const tier =
      eq > 0
        ? TIER_ALIASES[
            entry
              .slice(eq + 1)
              .trim()
              .toLowerCase()
          ]
        : undefined;
    if (!key || !tier || !/^([a-z0-9_-]+:)?[^:=\s]+$/.test(key)) {
      invalid.push(entry);
      continue;
    }
    tiers[key] = tier;
  }
  return { tiers, invalid };
}

export interface TierLookupAccount {
  name: string;
  group?: string;
  /** An exact plan string llmux may report (Anthropic `rate_limit_tier`). */
  rate_limit_tier?: string;
  /** llmux's own coarse tier ("max") — read by nothing here: it cannot tell x5 from x20. */
  tier?: string;
}

/**
 * The short name of an llmux account. llmux names accounts
 * `group:local@domain` (e.g. `claude:ai7@corp.example`); the timeline labels
 * them `ai7`, and operator keys may use that short form.
 */
export function llmuxAccountLocalName(name: string, group?: string): string {
  let local = name;
  const prefix = group ? `${group}:` : '';
  if (prefix && local.toLowerCase().startsWith(prefix.toLowerCase())) local = local.slice(prefix.length);
  const at = local.indexOf('@');
  return at > 0 ? local.slice(0, at) : local;
}

/** The account's tier, or undefined when nothing knows it. */
export function resolveAccountTier(
  account: TierLookupAccount,
  explicit: Readonly<Record<string, LlmuxTierId>>,
  defaults: Readonly<Record<string, LlmuxTierId>> = DEFAULT_LLMUX_ACCOUNT_TIERS,
): LlmuxTierId | undefined {
  const group = (account.group || '').toLowerCase();
  const full = account.name.toLowerCase();
  const local = llmuxAccountLocalName(full, group);
  // Most specific first: the exact name, then its short form; each scoped to
  // the group before bare. A key never matches across groups.
  const keys = [...new Set([`${group}:${full}`, full, `${group}:${local}`, local])];
  const lookup = (map: Readonly<Record<string, LlmuxTierId>>) => {
    for (const k of keys) if (map[k]) return map[k];
    return undefined;
  };
  const fromExplicit = lookup(explicit);
  if (fromExplicit) return fromExplicit;
  const upstream =
    typeof account.rate_limit_tier === 'string' ? UPSTREAM_TIERS[account.rate_limit_tier.toLowerCase()] : undefined;
  if (upstream) return upstream;
  return lookup(defaults);
}
