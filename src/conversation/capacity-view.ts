/**
 * LLM capacity view v2 (2026-10-25; trinity mockup review r1–r4). Pure: an
 * llmux `/llmux/status` snapshot + the account → tier map + a clock → one
 * row per provider group that answers the dashboard's two questions:
 *
 *   1. How many max accounts' worth is left — usable NOW and THIS WEEK?
 *   2. What comes back, when, and through which reset (weekly, or a block lifting)?
 *
 * There is no 5-hour window (owner, 2026-11-10: no provider reports one). A
 * `five_hour` an older llmux still sends is not read; the weekly window is the
 * one measure of every provider.
 *
 * Honest numbers only:
 *   - llmux reports window UTILIZATION, not tokens. "계정분" (account-
 *     equivalents) = Σ tier weight × remaining ratio — a normalised estimate.
 *   - Per account: now = weekly remaining unless a block is active (then 0);
 *     week = weekly remaining. The group's bar is the weekly one; its state
 *     (ok / low / empty) reads "now", so a pool held back by blocks is empty.
 *   - Blocks are tracked on their own — weekly ceiling (lifts at the weekly
 *     reset), cooldown over 120 s (cooldown_until),
 *     model-scoped ceiling such as "fable …" (that window's reset). A block
 *     whose lift time is unknown — paused, auth failure, a cooldown with no
 *     end, any other reason — is HELD: out of the totals, no return drawn.
 *   - A reset that already passed counts the window as full and is flagged
 *     as an estimate.
 *   - Held and no weekly measurement stay out of the totals. An untiered Claude
 *     account counts as Max x20 (`tierAssumed`); an untiered Codex account stays out.
 *   - The forecast replays each account's events in time order (at one instant
 *     block lifts first, then the weekly reset; nothing is merged). Each event
 *     carries its own weighted before/after deltas.
 */

import type { LlmuxAccount, LlmuxSaveMode, LlmuxScopedWindow, LlmuxStatus, LlmuxWindow } from '../auth/llmux-client';
import { LLMUX_TIERS, type LlmuxTierId, llmuxAccountLocalName, resolveAccountTier } from '../auth/llmux-tiers';
import { accountGroup, groupAccounts, providerName, remaining, resetAt } from '../slack/auth/capacity';

/** Below this share of the group's total, the primary measure reads "low". */
export const CAPACITY_LOW_PCT = 20;
/** A cooldown at most this long is throttling, not a block (seconds). */
export const TRANSIENT_COOLDOWN_SECS = 120;
/** The forecast reaches one weekly window ahead (seconds). */
export const CAPACITY_HORIZON_SECS = 7 * 86400;

export type CapacityCause = '7d' | 'release';
/** `saved` = held by llmux save mode (its `blocked` reads "saved …") until the cutoff. */
export type CapacityHeld = 'paused' | 'saved' | 'auth' | 'other';
export type CapacityExclusion = 'held' | 'noMeasure' | 'unknownTier';

export interface CapacityBlocks {
  /** Weekly ceiling ("7d …"), lifts at the weekly reset. */
  weekly: boolean;
  /** A cooldown longer than a throttle: lifts at this epoch second. */
  cooldownUntil?: number;
  /** A model-scoped ceiling ("fable …"): lifts at this epoch second. */
  scopedUntil?: number;
}

export interface CapacityUnit {
  /** Short label (`ai7`); masked when llmux runs anonymous. */
  name: string;
  tier?: LlmuxTierId;
  /** Share of the provider's top plan; null when the tier is unknown. */
  weight: number | null;
  /** Counted on {@link ASSUMED_TIER} — no configured or reported tier (operator, 2026-10-26). */
  tierAssumed?: true;
  status: string;
  /** Usable now, 0..1 of this account (unweighted). */
  now: number;
  /** This week's remaining, 0..1 of this account (unweighted). */
  week: number;
  blocked: boolean;
  held?: CapacityHeld;
  blocks: CapacityBlocks;
  /** A passed reset decides a number this account contributes. */
  estimated: boolean;
  counted: boolean;
  excluded?: CapacityExclusion;
  /** Epoch seconds every block has lifted (blocked, counted accounts). */
  returnAt?: number;
}

export interface CapacityEvent {
  account: string;
  tier?: LlmuxTierId;
  /** The account's tier is assumed ({@link ASSUMED_TIER}), not configured. */
  tierAssumed?: true;
  cause: CapacityCause;
  /** Epoch seconds. */
  at: number;
  /** Weighted change to "now" (account-equivalents). */
  dNow: number;
  /** Weighted change to "this week" (account-equivalents). */
  dWeek: number;
}

export interface CapacityGroupView {
  group: string;
  label: string;
  accountCount: number;
  countedAccounts: number;
  /** Σ weight of the counted accounts (account-equivalents). */
  total: number;
  /** Usable now: the weekly remaining of the accounts no block holds back. Decides `state`. */
  now: number;
  /** Left this week — the group's measure. */
  week: number;
  excluded: { unknownTier: number; held: number; noMeasure: number };
  /** Counted accounts whose tier is assumed ({@link ASSUMED_TIER}), not configured. */
  tierAssumed: number;
  estimated: number;
  state: 'ok' | 'low' | 'empty' | 'unknown';
  /** Oldest llmux measurement among the counted accounts (epoch seconds). */
  oldestRefreshAt?: number;
  /** Replayed forecast, time order, within {@link CAPACITY_HORIZON_SECS}. */
  events: CapacityEvent[];
  units: CapacityUnit[];
}

export interface CapacityView {
  available: boolean;
  reason?: string;
  /** When llmux was read (epoch ms). */
  fetchedAtMs: number;
  groups: CapacityGroupView[];
  /** llmux save mode as llmux reports it; absent when llmux has no save mode (older daemon). */
  saveMode?: LlmuxSaveMode;
}

const EPS = 1e-9;
/** Providers with plan tiers (and so a max-account unit). */
const PLAN_GROUPS = new Set(Object.values(LLMUX_TIERS).map((t) => t.provider as string));
const ORDER: Record<CapacityCause, number> = { release: 0, '7d': 1 };
/**
 * The tier an untiered account is counted as, per provider. Operator's rule
 * (2026-10-26, after a dev host read "계산 불가" for want of SOMA_LLMUX_ACCOUNT_TIERS):
 * a Claude account with no configured or reported plan counts as Max x20, and the
 * view says so (`tierAssumed`). Codex has no such rule — its untiered accounts stay out.
 */
export const ASSUMED_TIER: Readonly<Record<string, LlmuxTierId>> = Object.freeze({ claude: 'claude-max-20x' });

const round = (x: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

/** `kim.lee@corp.example` → `k***@corp.example` (only when llmux runs anonymous). */
function maskName(name: string, anonymous: boolean): string {
  if (!anonymous) return name;
  const at = name.indexOf('@');
  if (at <= 0) return name;
  return `${name[0]}***${name.slice(at)}`;
}

/**
 * Timeline labels: the account's short name (`claude:ai7@corp.example` →
 * `ai7`, the operator's own `[ai7]`). When two accounts of a group share a
 * short name, those keep their domain. Anonymous llmux masks either form.
 */
function accountLabels(accounts: LlmuxAccount[], group: string, anonymous: boolean): string[] {
  const locals = accounts.map((a) => llmuxAccountLocalName(a.name, group));
  const seen = new Map<string, number>();
  for (const l of locals) seen.set(l, (seen.get(l) ?? 0) + 1);
  return accounts.map((a, i) => {
    if ((seen.get(locals[i]) ?? 0) === 1) {
      const emailShaped = a.name.indexOf('@') > 0;
      return anonymous && emailShaped ? `${locals[i][0]}***` : locals[i];
    }
    const prefix = `${group}:`;
    const full = a.name.toLowerCase().startsWith(prefix.toLowerCase()) ? a.name.slice(prefix.length) : a.name;
    return maskName(full, anonymous);
  });
}

interface WindowRead {
  /** Remaining 0..1; undefined when not measurable. */
  rem?: number;
  /** Known reset, epoch seconds. */
  at?: number;
  /** The reset already passed: the window is full by estimate. */
  passed: boolean;
}

function readWindow(window: LlmuxWindow | null | undefined, nowMs: number): WindowRead | undefined {
  if (!window) return undefined;
  const at = resetAt(window, nowMs);
  if (at !== undefined && at <= nowMs / 1000) return { rem: 1, at, passed: true };
  return { rem: remaining(window, nowMs), at, passed: false };
}

/** The scoped window a "<scope> …" block names, e.g. "fable 99.0% > 98%". */
function scopedWindow(account: LlmuxAccount, scope: string): LlmuxScopedWindow | undefined {
  const list = Array.isArray(account.scoped_limits) ? account.scoped_limits : [];
  const hit = list.find((w) => (w.scope_label ?? '').toLowerCase() === scope);
  if (hit) return hit;
  return scope === 'fable' && account.fable_weekly ? account.fable_weekly : undefined;
}

interface AccountState {
  unit: CapacityUnit;
  weight: number;
  rem7: number;
  r7?: number;
  bWeek: boolean;
  bCool: number;
  bScoped: number;
}

const isBlocked = (s: AccountState): boolean => s.bWeek || s.bCool > 0 || s.bScoped > 0;
const usable = (s: AccountState): number => (isBlocked(s) ? 0 : s.rem7);

function initAccount(
  account: LlmuxAccount,
  name: string,
  tier: LlmuxTierId | undefined,
  tierAssumed: boolean,
  nowMs: number,
): { unit: CapacityUnit; state?: AccountState; refreshedAt?: number } {
  const nowS = nowMs / 1000;
  const reason = typeof account.blocked === 'string' ? account.blocked.trim().toLowerCase() : '';
  const seven = readWindow(account.seven_day, nowMs);
  const blocks: CapacityBlocks = { weekly: false };

  // Blocks, each with its own lift. A block whose lift time is unknown is held.
  let held: CapacityHeld | undefined;
  const hold = (why: CapacityHeld) => {
    held = held ?? why;
  };
  if (account.status === 'auth_failed') hold('auth');
  if (account.status === 'paused' || reason.startsWith('paused')) hold('paused');
  if (reason.startsWith('saved')) hold('saved');
  const scope = reason.split(/\s+/)[0] ?? '';
  if (reason.startsWith('7d')) {
    if (seven?.at === undefined) hold('other');
    else blocks.weekly = !seven.passed; // a passed weekly reset already lifted it
  } else if (
    reason.startsWith('cooldown') ||
    reason.startsWith('paused') ||
    reason.startsWith('saved') ||
    reason === ''
  ) {
    // handled below / above
  } else {
    const w = scopedWindow(account, scope);
    const at = w ? resetAt(w, nowMs) : undefined;
    if (at === undefined) hold('other');
    else if (at > nowS) blocks.scopedUntil = at;
  }
  // 0 / negative = no end time reported (a "cooldown" with it is held), not an expired one.
  const cd =
    Number.isFinite(account.cooldown_until) && (account.cooldown_until as number) > 0
      ? (account.cooldown_until as number)
      : undefined;
  if (cd !== undefined) {
    // A throttle (≤ 120 s) or a cooldown already over never blocks.
    if (cd - nowS > TRANSIENT_COOLDOWN_SECS) blocks.cooldownUntil = cd;
  } else if (account.status === 'cooldown' || reason.startsWith('cooldown')) hold('other');

  const weight = tier ? LLMUX_TIERS[tier].weight : null;
  const unit: CapacityUnit = {
    name,
    ...(tier ? { tier } : {}),
    weight,
    status: account.status,
    now: 0,
    week: 0,
    blocked: false,
    ...(held ? { held } : {}),
    blocks,
    estimated: false,
    counted: false,
  };
  const refreshed = Number.isFinite(account.last_refresh_ms) && (account.last_refresh_ms as number) > 0;
  const refreshedAt = refreshed ? Math.floor((account.last_refresh_ms as number) / 1000) : undefined;

  // An account left out is not counted on an assumed plan: nothing is assumed about it.
  const unassume = () => {
    if (!tierAssumed) return;
    delete unit.tier;
    unit.weight = null;
  };
  if (held) {
    unit.blocked = true;
    unit.excluded = 'held';
    unassume();
    return { unit };
  }
  if (seven?.rem === undefined) {
    unit.excluded = 'noMeasure';
    unassume();
    return { unit };
  }
  if (weight === null) {
    unit.excluded = 'unknownTier';
    return { unit };
  }

  const state: AccountState = {
    unit,
    weight,
    rem7: seven.rem,
    r7: seven.at !== undefined && seven.at > nowS ? seven.at : undefined,
    bWeek: blocks.weekly,
    bCool: blocks.cooldownUntil ?? 0,
    bScoped: blocks.scopedUntil ?? 0,
  };
  unit.counted = true;
  if (tierAssumed) unit.tierAssumed = true;
  unit.blocked = isBlocked(state);
  unit.now = usable(state);
  unit.week = state.rem7;
  unit.estimated = seven.passed;
  return { unit, state, refreshedAt };
}

interface PendingEvent {
  s: AccountState;
  cause: CapacityCause;
  at: number;
  lift?: 'cooldown' | 'scoped';
}

function eventsOf(s: AccountState, horizon: number): PendingEvent[] {
  const out: PendingEvent[] = [];
  if (s.r7 !== undefined) out.push({ s, cause: '7d', at: s.r7 });
  if (s.bCool) out.push({ s, cause: 'release', at: s.bCool, lift: 'cooldown' });
  if (s.bScoped) out.push({ s, cause: 'release', at: s.bScoped, lift: 'scoped' });
  return out.filter((e) => e.at <= horizon);
}

/** Apply one event; false when it changes nothing (a window already full). */
function apply(e: PendingEvent): boolean {
  const s = e.s;
  if (e.cause === '7d') {
    const changed = s.rem7 < 1 || s.bWeek;
    s.rem7 = 1;
    s.bWeek = false;
    return changed;
  }
  // A release lifts a block; it adds no quota.
  if (e.lift === 'scoped') s.bScoped = 0;
  else s.bCool = 0;
  return true;
}

function buildGroup(
  group: string,
  accounts: LlmuxAccount[],
  tiers: Readonly<Record<string, LlmuxTierId>>,
  anonymous: boolean,
  nowMs: number,
): CapacityGroupView {
  const nowS = nowMs / 1000;
  const labels = accountLabels(accounts, group, anonymous);
  const units: CapacityUnit[] = [];
  const states: AccountState[] = [];
  const refreshes: number[] = [];
  for (const [i, account] of accounts.entries()) {
    const known = resolveAccountTier(
      {
        name: account.name,
        group: accountGroup(account),
        rate_limit_tier: account.rate_limit_tier,
        plan_type: account.plan_type,
      },
      tiers,
    );
    const tier = known ?? ASSUMED_TIER[group];
    const { unit, state, refreshedAt } = initAccount(account, labels[i], tier, !known && !!tier, nowMs);
    units.push(unit);
    if (state) {
      states.push(state);
      if (refreshedAt !== undefined) refreshes.push(refreshedAt);
    }
  }

  const sum = (f: (s: AccountState) => number) => states.reduce((t, s) => t + s.weight * f(s), 0);
  const total = round(states.reduce((t, s) => t + s.weight, 0));
  const now = round(sum(usable));
  const week = round(sum((s) => s.rem7));
  const excluded = {
    unknownTier: units.filter((u) => u.excluded === 'unknownTier').length,
    held: units.filter((u) => u.excluded === 'held').length,
    noMeasure: units.filter((u) => u.excluded === 'noMeasure').length,
  };

  // Replay. Each account is independent, so the global time order keeps every
  // account's own order; at one instant: release → weekly.
  const pending = states.flatMap((s) => eventsOf(s, nowS + CAPACITY_HORIZON_SECS));
  pending.sort((a, b) => a.at - b.at || ORDER[a.cause] - ORDER[b.cause] || a.s.unit.name.localeCompare(b.s.unit.name));
  const events: CapacityEvent[] = [];
  for (const e of pending) {
    const wasBlocked = isBlocked(e.s);
    const n0 = usable(e.s);
    const w0 = e.s.rem7;
    if (!apply(e)) continue;
    if (wasBlocked && !isBlocked(e.s)) {
      // A return is promised only when the account has something to use then.
      if (e.s.unit.returnAt === undefined && usable(e.s) > EPS) e.s.unit.returnAt = e.at;
    }
    events.push({
      account: e.s.unit.name,
      ...(e.s.unit.tier ? { tier: e.s.unit.tier } : {}),
      ...(e.s.unit.tierAssumed ? { tierAssumed: true as const } : {}),
      cause: e.cause,
      at: e.at,
      dNow: round(e.s.weight * (usable(e.s) - n0), 6),
      dWeek: round(e.s.weight * (e.s.rem7 - w0), 6),
    });
  }

  // The state reads what can run NOW (trinity PR #1180 review, grok P1): a pool whose every account is held
  // back by a cooldown or a model ceiling is empty even with weekly quota left — the card then counts down to
  // the first return. With nothing blocked, now equals week.
  const state: CapacityGroupView['state'] =
    total <= EPS ? 'unknown' : now <= EPS ? 'empty' : (now / total) * 100 < CAPACITY_LOW_PCT ? 'low' : 'ok';
  return {
    group,
    label: providerName(group),
    accountCount: accounts.length,
    countedAccounts: states.length,
    total,
    now,
    week,
    excluded,
    tierAssumed: units.filter((u) => u.counted && u.tierAssumed).length,
    estimated: units.filter((u) => u.estimated).length,
    state,
    ...(refreshes.length ? { oldestRefreshAt: Math.min(...refreshes) } : {}),
    events,
    units,
  };
}

export function buildCapacityView(
  status: LlmuxStatus,
  tiers: Readonly<Record<string, LlmuxTierId>>,
  nowMs: number,
): CapacityView {
  const anonymous = status.email_anonymous === true;
  const groups: CapacityGroupView[] = [];
  for (const [group, accounts] of groupAccounts(status.accounts ?? [])) {
    // Only subscription providers have plan windows to count in max accounts;
    // an API-key pool (grok, openrouter) could only ever read "계산 불가".
    if (!PLAN_GROUPS.has(group)) continue;
    groups.push(buildGroup(group, accounts, tiers, anonymous, nowMs));
  }
  const view: CapacityView = { available: true, fetchedAtMs: nowMs, groups };
  const saveMode = readSaveMode(status.save_mode);
  if (saveMode) view.saveMode = saveMode;
  return view;
}

/** llmux's `save_mode` block, kept only when it has the documented shape. */
export function readSaveMode(raw: unknown): LlmuxSaveMode | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { until?: unknown; active?: unknown; held?: unknown };
  const until = typeof r.until === 'number' && Number.isFinite(r.until) && r.until > 0 ? r.until : null;
  const held = typeof r.held === 'number' && Number.isFinite(r.held) && r.held >= 0 ? Math.floor(r.held) : 0;
  return { until, active: r.active === true && until !== null, held };
}
