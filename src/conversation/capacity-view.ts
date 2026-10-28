/**
 * LLM capacity view v2 (2026-10-25; trinity mockup review r1–r4). Pure: an
 * llmux `/llmux/status` snapshot + the account → tier map + a clock → one
 * row per provider group that answers the dashboard's two questions:
 *
 *   1. How many max accounts' worth is left — usable NOW and THIS WEEK?
 *   2. What comes back, when, and through which reset (5h vs weekly)?
 *
 * Honest numbers only:
 *   - llmux reports window UTILIZATION, not tokens. "계정분" (account-
 *     equivalents) = Σ tier weight × remaining ratio — a normalised estimate.
 *   - Per account: now = min(5h remaining, weekly remaining) unless a block is
 *     active; week = weekly remaining. A group with no five_hour data at all
 *     (Codex today) has one measure: now = week.
 *   - Blocks are tracked on their own — weekly ceiling (lifts at the weekly
 *     reset), 5h ceiling (5h reset), cooldown over 120 s (cooldown_until),
 *     model-scoped ceiling such as "fable …" (that window's reset). A block
 *     whose lift time is unknown — paused, auth failure, a cooldown with no
 *     end, any other reason — is HELD: out of the totals, no return drawn.
 *   - A reset that already passed counts the window as full and is flagged
 *     as an estimate only where it moves a number. An unblocked account with
 *     no 5h measurement adds nothing to "now" (counted apart).
 *   - Held and no weekly measurement stay out of the totals. An untiered Claude
 *     account counts as Max x20 (`tierAssumed`); an untiered Codex account stays out.
 *   - The forecast replays each account's events in time order (at one instant
 *     block lifts first, then the 5h reset, then the weekly reset; nothing is
 *     merged). Each event carries its own weighted before/after deltas.
 */

import type { LlmuxAccount, LlmuxScopedWindow, LlmuxStatus, LlmuxWindow } from '../auth/llmux-client';
import { LLMUX_TIERS, type LlmuxTierId, llmuxAccountLocalName, resolveAccountTier } from '../auth/llmux-tiers';
import { accountGroup, groupAccounts, providerName, remaining, resetAt } from '../slack/auth/capacity';

/** Below this share of the group's total, the primary measure reads "low". */
export const CAPACITY_LOW_PCT = 20;
/** A cooldown at most this long is throttling, not a block (seconds). */
export const TRANSIENT_COOLDOWN_SECS = 120;
/** The forecast reaches one weekly window ahead (seconds). */
export const CAPACITY_HORIZON_SECS = 7 * 86400;

export type CapacityCause = '5h' | '7d' | 'release';
export type CapacityHeld = 'paused' | 'auth' | 'other';
export type CapacityExclusion = 'held' | 'noMeasure' | 'unknownTier';

export interface CapacityBlocks {
  /** Weekly ceiling ("7d …"), lifts at the weekly reset. */
  weekly: boolean;
  /** 5h ceiling ("5h …"), lifts at the 5h reset. */
  fiveHour: boolean;
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
  /** Unblocked, 5h group, but no 5h measurement: adds nothing to "now". */
  unmeasured5h: boolean;
  counted: boolean;
  excluded?: CapacityExclusion;
  /** Which window caps a usable account. */
  binding?: '5h' | '7d';
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
  /** The group has 5h data: two measures. Otherwise "now" equals "week". */
  has5h: boolean;
  accountCount: number;
  countedAccounts: number;
  /** Σ weight of the counted accounts (account-equivalents). */
  total: number;
  now: number;
  week: number;
  /** Usable accounts by the window that caps them. */
  binding: { fiveHour: number; weekly: number };
  excluded: { unknownTier: number; held: number; noMeasure: number };
  /** Counted accounts whose tier is assumed ({@link ASSUMED_TIER}), not configured. */
  tierAssumed: number;
  estimated: number;
  unmeasured5h: number;
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
}

const EPS = 1e-9;
const FIVE_HOURS = 5 * 3600;
/** Providers whose plans always carry a 5h window. */
const FIVE_HOUR_GROUPS = new Set(['claude']);
/** Providers with plan tiers (and so a max-account unit). */
const PLAN_GROUPS = new Set(Object.values(LLMUX_TIERS).map((t) => t.provider as string));
const ORDER: Record<CapacityCause, number> = { release: 0, '5h': 1, '7d': 2 };
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
  /** What the stale reading said before that passed reset (when it was valid). */
  before?: number;
}

function readWindow(window: LlmuxWindow | null | undefined, nowMs: number): WindowRead | undefined {
  if (!window) return undefined;
  const at = resetAt(window, nowMs);
  if (at !== undefined && at <= nowMs / 1000) {
    const u = window.utilization;
    const before = Number.isFinite(u) && u >= 0 && u <= 1 ? 1 - u : undefined;
    return { rem: 1, at, passed: true, ...(before !== undefined ? { before } : {}) };
  }
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
  rem5: number | null;
  rem7: number;
  r5?: number;
  r7?: number;
  bWeek: boolean;
  b5h: boolean;
  bCool: number;
  bScoped: number;
  unmeasured5: boolean;
  /**
   * Blocked with no 5h measurement: full only if it will have sat idle a whole
   * 5h window by the time it lifts (trinity r4, astra); otherwise unmeasured.
   */
  idle5: boolean;
}

const isBlocked = (s: AccountState): boolean => s.bWeek || s.b5h || s.bCool > 0 || s.bScoped > 0;
const usable = (s: AccountState): number => (isBlocked(s) || s.unmeasured5 ? 0 : Math.min(s.rem5 ?? 1, s.rem7));

function initAccount(
  account: LlmuxAccount,
  name: string,
  tier: LlmuxTierId | undefined,
  tierAssumed: boolean,
  has5h: boolean,
  nowMs: number,
): { unit: CapacityUnit; state?: AccountState; refreshedAt?: number } {
  const nowS = nowMs / 1000;
  const reason = typeof account.blocked === 'string' ? account.blocked.trim().toLowerCase() : '';
  const five = readWindow(account.five_hour, nowMs);
  const seven = readWindow(account.seven_day, nowMs);
  const blocks: CapacityBlocks = { weekly: false, fiveHour: false };

  // Blocks, each with its own lift. A block whose lift time is unknown is held.
  let held: CapacityHeld | undefined;
  const hold = (why: CapacityHeld) => {
    held = held ?? why;
  };
  if (account.status === 'auth_failed') hold('auth');
  if (account.status === 'paused' || reason.startsWith('paused')) hold('paused');
  const scope = reason.split(/\s+/)[0] ?? '';
  if (reason.startsWith('7d')) {
    if (seven?.at === undefined) hold('other');
    else blocks.weekly = !seven.passed; // a passed weekly reset already lifted it
  } else if (reason.startsWith('5h')) {
    if (five?.at === undefined) hold('other');
    else blocks.fiveHour = !five.passed;
  } else if (reason.startsWith('cooldown') || reason.startsWith('paused') || reason === '') {
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
    unmeasured5h: false,
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
    rem5: null,
    rem7: seven.rem,
    r5: five?.at !== undefined && five.at > nowS ? five.at : undefined,
    r7: seven.at !== undefined && seven.at > nowS ? seven.at : undefined,
    bWeek: blocks.weekly,
    b5h: blocks.fiveHour,
    bCool: blocks.cooldownUntil ?? 0,
    bScoped: blocks.scopedUntil ?? 0,
    unmeasured5: false,
    idle5: false,
  };
  let est5 = false;
  let before5: number | undefined;
  if (has5h) {
    if (five?.rem !== undefined) {
      state.rem5 = five.rem;
      est5 = five.passed;
      before5 = five.before;
    } else if (isBlocked(state)) {
      // Decided when it lifts: full only after a whole idle 5h window.
      state.rem5 = 1;
      state.idle5 = true;
    } else {
      state.rem5 = 1;
      state.unmeasured5 = true;
    }
  }
  const blocked = isBlocked(state);
  unit.counted = true;
  if (tierAssumed) unit.tierAssumed = true;
  unit.blocked = blocked;
  unit.now = usable(state);
  unit.week = state.rem7;
  unit.unmeasured5h = state.unmeasured5;
  // An estimate counts only where it decides a number: any weekly guess, or a
  // 5h guess on the minimum of a usable account.
  // A 5h guess decides "now" when the stale reading would have been the minimum
  // (trinity PR review, astra): it lifts min from that reading to the weekly or to full.
  const est5Moves = before5 !== undefined ? before5 < state.rem7 - EPS : (state.rem5 ?? 1) <= state.rem7 + EPS;
  unit.estimated = seven.passed || (est5 && !blocked && !state.unmeasured5 && est5Moves);
  // A usable account has something left: an exhausted window is not "usable".
  if (!blocked && !state.unmeasured5 && usable(state) > EPS) {
    unit.binding = has5h && (state.rem5 ?? 1) < state.rem7 - EPS ? '5h' : '7d';
  }
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
  if (s.r5 !== undefined && s.rem5 !== null) out.push({ s, cause: '5h', at: s.r5 });
  if (s.r7 !== undefined) out.push({ s, cause: '7d', at: s.r7 });
  if (s.bCool) out.push({ s, cause: 'release', at: s.bCool, lift: 'cooldown' });
  if (s.bScoped) out.push({ s, cause: 'release', at: s.bScoped, lift: 'scoped' });
  return out.filter((e) => e.at <= horizon);
}

/** Apply one event; false when it changes nothing (a window already full). */
function apply(e: PendingEvent): boolean {
  const s = e.s;
  if (e.cause === '5h') {
    const changed = (s.rem5 ?? 1) < 1 || s.b5h || s.unmeasured5;
    s.rem5 = 1;
    s.b5h = false;
    s.unmeasured5 = false;
    s.idle5 = false;
    return changed;
  }
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
  // Claude always has a 5h window — a pool with no 5h reading must not lose its
  // "now" line (trinity r4, astra). Others: only when llmux reports one.
  const has5h = FIVE_HOUR_GROUPS.has(group) || accounts.some((a) => !!a.five_hour);
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
    const { unit, state, refreshedAt } = initAccount(account, labels[i], tier, !known && !!tier, has5h, nowMs);
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
  const live = units.filter((u) => u.binding);
  const excluded = {
    unknownTier: units.filter((u) => u.excluded === 'unknownTier').length,
    held: units.filter((u) => u.excluded === 'held').length,
    noMeasure: units.filter((u) => u.excluded === 'noMeasure').length,
  };

  // Replay. Each account is independent, so the global time order keeps every
  // account's own order; at one instant: release → 5h → weekly.
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
      if (e.s.idle5) {
        // Idle a whole 5h window by now → full (estimate); a shorter block → unknown.
        e.s.idle5 = false;
        if (e.at - nowS < FIVE_HOURS) e.s.unmeasured5 = true;
      }
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

  const primary = has5h ? now : week;
  // Nothing usable only because no usable account has a 5h reading is "unknown", not "empty".
  const unmeasuredOnly = has5h && primary <= EPS && live.length === 0 && units.some((u) => u.unmeasured5h);
  const state: CapacityGroupView['state'] =
    total <= EPS || unmeasuredOnly
      ? 'unknown'
      : primary <= EPS
        ? 'empty'
        : (primary / total) * 100 < CAPACITY_LOW_PCT
          ? 'low'
          : 'ok';
  return {
    group,
    label: providerName(group),
    has5h,
    accountCount: accounts.length,
    countedAccounts: states.length,
    total,
    now,
    week,
    binding: {
      fiveHour: live.filter((u) => u.binding === '5h').length,
      weekly: live.filter((u) => u.binding === '7d').length,
    },
    excluded,
    tierAssumed: units.filter((u) => u.counted && u.tierAssumed).length,
    estimated: units.filter((u) => u.estimated).length,
    unmeasured5h: units.filter((u) => u.unmeasured5h).length,
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
  return { available: true, fetchedAtMs: nowMs, groups };
}
