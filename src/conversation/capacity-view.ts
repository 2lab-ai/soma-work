/**
 * LLM capacity view for the dashboard cooldown timeline (SSOT 2026-10-23
 * T7/T9/T10; trinity scope consult D5/D6). Pure: an llmux `/llmux/status`
 * snapshot + the account → tier map + a clock → one row per provider group.
 *
 * Honest numbers only:
 *   - llmux reports window UTILIZATION (0..1), not tokens — every figure here
 *     is a remaining RATE (잔여율 %).
 *   - An account's availability is its BINDING window: the smaller remaining of
 *     5h and 7d. Model-scoped weekly windows (e.g. Fable) bind only their model,
 *     so they are shown as markers but never lower the account's availability.
 *   - A blocked / cooling / auth-failed account has 0 available.
 *   - The group % is the UNWEIGHTED mean over measured accounts. A plan price is
 *     not a token ratio, so the tier is colour + label only.
 *   - A window past its reset is stale and left out on its own; an account
 *     with no measurable binding window is unknown (미확인) and excluded.
 *   - `nextRefill` (a usable account's BINDING window resets: its
 *     availability rises) and `nextReturn` (a blocked account is usable
 *     again, every block lifted) are different events.
 */

import type { LlmuxAccount, LlmuxScopedWindow, LlmuxStatus, LlmuxWindow } from '../auth/llmux-client';
import { type LlmuxTierId, resolveAccountTier } from '../auth/llmux-tiers';
import { accountGroup, groupAccounts, providerName, remaining, resetAt } from '../slack/auth/capacity';

/** Below this group % a row reads "low". */
export const CAPACITY_LOW_PCT = 20;

export interface CapacityMarker {
  account: string;
  tier?: LlmuxTierId;
  /** '5h' · '7d' · '7d-<scope>' · 'cooldown'. */
  window: string;
  /** Epoch seconds. */
  at: number;
  /** Percentage points this window gives back when it resets (its utilization). */
  gainPct: number;
  /** The account is blocked and this is the moment it is usable again. */
  returns: boolean;
  /**
   * This reset raises the account's availability (it is the binding window,
   * or the account's return). A reset of a non-binding window — 5h while 7d
   * binds, a model-scoped window — is drawn but supplies nothing usable.
   */
  raises: boolean;
}

export interface CapacityAccountView {
  name: string;
  tier?: LlmuxTierId;
  status: string;
  /** Binding remaining in %, or null when unknown / stale. */
  availablePct: number | null;
  blocked: boolean;
  stale: boolean;
  /** Epoch seconds the account is usable again; absent when not blocked or unknown (auth failure). */
  returnAt?: number;
}

export interface CapacityEvent {
  account: string;
  tier?: LlmuxTierId;
  window: string;
  at: number;
}

export interface CapacityGroupView {
  group: string;
  label: string;
  availablePct: number | null;
  availableAccounts: number;
  unknownAccounts: number;
  totalAccounts: number;
  state: 'ok' | 'low' | 'empty' | 'unknown';
  nextRefill?: CapacityEvent;
  nextReturn?: CapacityEvent;
  markers: CapacityMarker[];
  accounts: CapacityAccountView[];
}

export interface CapacityView {
  available: boolean;
  reason?: string;
  /** When llmux was read (epoch ms). */
  fetchedAtMs: number;
  groups: CapacityGroupView[];
}

const EXHAUSTED = 1e-6;

function current0(pct: number | null): number | null {
  return pct === null ? null : pct / 100;
}

/** `kim.lee@corp.example` → `k***@corp.example` (only when llmux runs anonymous). */
function maskName(name: string, anonymous: boolean): string {
  if (!anonymous) return name;
  const at = name.indexOf('@');
  if (at <= 0) return name;
  return `${name[0]}***${name.slice(at)}`;
}

function scopedLabel(window: LlmuxScopedWindow, index: number): string {
  return `7d-${(window.scope_label ?? `scoped${index + 1}`).toLowerCase()}`;
}

interface WindowReading {
  label: string;
  window: LlmuxWindow;
  binding: boolean;
  remaining?: number;
  at?: number;
}

function readings(account: LlmuxAccount, nowMs: number): WindowReading[] {
  const out: WindowReading[] = [];
  const push = (label: string, window: LlmuxWindow | null | undefined, binding: boolean) => {
    if (!window) return;
    out.push({ label, window, binding, remaining: remaining(window, nowMs), at: resetAt(window, nowMs) });
  };
  push('5h', account.five_hour, true);
  push('7d', account.seven_day, true);
  const scoped = Array.isArray(account.scoped_limits) && account.scoped_limits.length > 0 ? account.scoped_limits : [];
  if (scoped.length) scoped.forEach((w, i) => push(scopedLabel(w, i), w, false));
  else if (account.fable_weekly) push('7d-fable', account.fable_weekly, false);
  return out;
}

function accountView(
  account: LlmuxAccount,
  tier: LlmuxTierId | undefined,
  name: string,
  nowMs: number,
): { view: CapacityAccountView; markers: CapacityMarker[] } {
  const nowS = nowMs / 1000;
  const all = readings(account, nowMs);
  const binding = all.filter((r) => r.binding);
  const stale = binding.some((r) => r.remaining === undefined);
  const measured = binding.filter((r) => r.remaining !== undefined);
  const authFailed = account.status === 'auth_failed';
  const cooling = Number.isFinite(account.cooldown_until) && (account.cooldown_until ?? 0) > nowS;
  const exhausted = measured.filter((r) => (r.remaining ?? 1) <= EXHAUSTED);
  const blocked = authFailed || cooling || account.status === 'cooldown' || !!account.blocked || exhausted.length > 0;

  let availablePct: number | null;
  if (blocked) availablePct = 0;
  // A window past its reset is left out on its own; the account is unknown
  // only when no binding window is measurable at all.
  else if (measured.length === 0) availablePct = null;
  else availablePct = Math.min(...measured.map((r) => r.remaining as number)) * 100;

  // When is a blocked account usable again? Only when EVERY block lifts, so
  // each block needs a known release time — otherwise no return is promised:
  //   - an exhausted 5h/7d window: its reset;
  //   - a cooldown: cooldown_until;
  //   - llmux's own reason: "5h …"/"7d …" (a utilization ceiling) lifts with
  //     that window's reset, "cooldown …" with cooldown_until, "fable …" with
  //     the Fable window's reset; "paused", "usage stale", an auth failure or
  //     any other reason has no time.
  let returnAt: number | undefined;
  let returnWindow: string | undefined;
  if (blocked) {
    const lifts: { at: number; label: string }[] = [];
    let unknown = authFailed;
    const liftAt = (label: string) => {
      const r = all.find((w) => w.label === label);
      if (r?.at && r.at > nowS) lifts.push({ at: r.at, label });
      else unknown = true;
    };
    for (const r of exhausted) liftAt(r.label);
    if (cooling) lifts.push({ at: account.cooldown_until as number, label: 'cooldown' });
    else if (account.status === 'cooldown') unknown = true;
    const reason = typeof account.blocked === 'string' ? account.blocked.trim().toLowerCase() : '';
    if (reason) {
      if (reason.startsWith('5h')) liftAt('5h');
      else if (reason.startsWith('7d')) liftAt('7d');
      else if (reason.startsWith('cooldown')) {
        if (!cooling) unknown = true;
      } else if (reason.startsWith('fable')) {
        const fable = all.find((w) => w.label === '7d-fable');
        if (fable) liftAt('7d-fable');
        else unknown = true;
      } else unknown = true;
    }
    const last = lifts.sort((a, b) => b.at - a.at)[0];
    if (last && !unknown) {
      returnAt = last.at;
      returnWindow = last.label;
    }
  }

  // Which resets raise a usable account's availability: replay its binding
  // windows' resets in time order (simultaneous ones together) — a reset
  // raises it when the binding minimum goes up at that moment. With 5h and 7d
  // both at 50%, the first reset changes nothing and the second does.
  const raisingAt = new Set<number>();
  if (current0(availablePct) !== null) {
    const state = new Map(measured.map((r) => [r.label, r.remaining as number]));
    const upcoming = measured.filter((r) => r.at && r.at > nowS).sort((a, b) => (a.at as number) - (b.at as number));
    let level = Math.min(...state.values());
    for (let i = 0; i < upcoming.length; ) {
      const at = upcoming[i].at as number;
      while (i < upcoming.length && upcoming[i].at === at) {
        state.set(upcoming[i].label, 1);
        i++;
      }
      const next = Math.min(...state.values());
      if (next - level >= 0.005) raisingAt.add(at);
      level = next;
    }
  }
  const raisesOnReset = (r: WindowReading): boolean => r.binding && !!r.at && raisingAt.has(r.at);

  const markers: CapacityMarker[] = [];
  if (blocked) {
    if (returnAt !== undefined && returnWindow) {
      const reading = all.find((r) => r.label === returnWindow);
      markers.push({
        account: name,
        tier,
        window: returnWindow,
        at: returnAt,
        gainPct: reading ? Math.round((1 - (reading.remaining ?? 0)) * 1000) / 10 : 0,
        returns: true,
        raises: true,
      });
    }
  } else {
    for (const r of all) {
      if (r.remaining === undefined || !r.at || r.at <= nowS) continue;
      const used = 1 - r.remaining;
      if (used < 0.01) continue; // nothing to give back
      markers.push({
        account: name,
        tier,
        window: r.label,
        at: r.at,
        gainPct: Math.round(used * 1000) / 10,
        returns: false,
        raises: raisesOnReset(r),
      });
    }
  }

  return {
    view: {
      name,
      tier,
      status: account.status,
      availablePct: availablePct === null ? null : Math.round(availablePct * 10) / 10,
      blocked,
      stale: stale && !blocked,
      ...(returnAt !== undefined ? { returnAt } : {}),
    },
    markers,
  };
}

function earliest(markers: CapacityMarker[]): CapacityEvent | undefined {
  const m = markers[0];
  return m ? { account: m.account, tier: m.tier, window: m.window, at: m.at } : undefined;
}

export function buildCapacityView(
  status: LlmuxStatus,
  tiers: Readonly<Record<string, LlmuxTierId>>,
  nowMs: number,
): CapacityView {
  const anonymous = status.email_anonymous === true;
  const groups: CapacityGroupView[] = [];
  for (const [group, accounts] of groupAccounts(status.accounts ?? [])) {
    const views: CapacityAccountView[] = [];
    const markers: CapacityMarker[] = [];
    for (const account of accounts) {
      const tier = resolveAccountTier(
        { name: account.name, group: accountGroup(account), rate_limit_tier: account.rate_limit_tier },
        tiers,
      );
      const { view, markers: own } = accountView(account, tier, maskName(account.name, anonymous), nowMs);
      views.push(view);
      markers.push(...own);
    }
    markers.sort((a, b) => a.at - b.at || a.account.localeCompare(b.account));
    const measured = views.filter((v) => v.availablePct !== null);
    const availablePct = measured.length
      ? Math.round((measured.reduce((sum, v) => sum + (v.availablePct as number), 0) / measured.length) * 100) / 100
      : null;
    const availableAccounts = views.filter((v) => !v.blocked && (v.availablePct ?? 0) > 0).length;
    const state: CapacityGroupView['state'] =
      availablePct === null
        ? 'unknown'
        : availableAccounts === 0
          ? 'empty'
          : availablePct < CAPACITY_LOW_PCT
            ? 'low'
            : 'ok';
    groups.push({
      group,
      label: providerName(group),
      availablePct,
      availableAccounts,
      unknownAccounts: views.length - measured.length,
      totalAccounts: views.length,
      state,
      nextRefill: earliest(markers.filter((m) => !m.returns && m.raises)),
      nextReturn: earliest(markers.filter((m) => m.returns)),
      markers,
      accounts: views,
    });
  }
  return { available: true, fetchedAtMs: nowMs, groups };
}
