/**
 * `auth` infographic model — the numbers behind the two pictures the `auth`
 * card shows (2026-11-18, owner: "한눈에 토큰이 얼마나 남았고 앞으로 토큰이
 * 언제 생길지 + 계정별 디테일은 추가로 리포트").
 *
 *   - Summary (one per card): per provider, how much is usable NOW, what a
 *     block holds back, what is used, and the replayed forecast — the next
 *     step, the next 24 h, each KST day of the week ahead, when it is full.
 *   - Account report (on demand): every account, one row — state, weekly and
 *     model-scoped remaining, reset / return time, in-flight, measurement age.
 *
 * Every number comes from the capacity view (`conversation/capacity-view.ts`,
 * the dashboard's SSOT): the unit is "계정분" — a provider's top plan's
 * weekly limit = 1. llmux reports utilization, never token counts.
 *
 * Pure: no I/O, no clock — `nowMs` is passed in. Times are KST (the owner's
 * clock, the same zone the usage reports use); a picture cannot localise.
 */

import type { LlmuxAccount, LlmuxStatus } from '../../auth/llmux-client';
import { LLMUX_TIERS, llmuxAccountLocalName } from '../../auth/llmux-tiers';
import type { CapacityGroupView, CapacityUnit, CapacityView } from '../../conversation/capacity-view';
import { collectScopedWindows, groupAccounts, remaining, resetAt } from './capacity';

const EPS = 1e-9;
const DAY = 86_400;
/** Asia/Seoul is UTC+9 with no daylight saving. */
const KST_OFFSET = 9 * 3600;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
/** The forecast horizon: one weekly window. */
export const FORECAST_SECS = 7 * DAY;

const round = (x: number, places = 4): number => Math.round(x * 10 ** places) / 10 ** places;

/** `Claude` · `Codex` · `Grok`, else the group name capitalised (`gemini` → `Gemini`). Drawn as text, not mrkdwn. */
export function providerLabel(group: string): string {
  const known: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', openrouter: 'OpenRouter' };
  return known[group] ?? group.charAt(0).toUpperCase() + group.slice(1);
}

/** Epoch seconds of the KST midnight that starts `at`'s day. */
function kstDayStart(at: number): number {
  return Math.floor((at + KST_OFFSET) / DAY) * DAY - KST_OFFSET;
}

function kstParts(at: number): { month: number; day: number; weekday: string; hh: string; mm: string } {
  const d = new Date((at + KST_OFFSET) * 1000);
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: WEEKDAYS[d.getUTCDay()],
    hh: String(d.getUTCHours()).padStart(2, '0'),
    mm: String(d.getUTCMinutes()).padStart(2, '0'),
  };
}

/** `오늘 21:00` · `내일 06:00` · `1/17 (일) 17:00` — KST. */
export function formatKstMoment(at: number, nowS: number): string {
  const p = kstParts(at);
  const dayDiff = Math.round((kstDayStart(at) - kstDayStart(nowS)) / DAY);
  const time = `${p.hh}:${p.mm}`;
  if (dayDiff === 0) return `오늘 ${time}`;
  if (dayDiff === 1) return `내일 ${time}`;
  return `${p.month}/${p.day} (${p.weekday}) ${time}`;
}

/** `11/18 (화) 17:35` — KST, for headers. */
export function formatKstStamp(at: number): string {
  const p = kstParts(at);
  return `${p.month}/${p.day} (${p.weekday}) ${p.hh}:${p.mm}`;
}

/** `3시간 전` · `2일 전` — the age of a measurement. */
export function formatAge(at: number, nowS: number): string {
  const secs = Math.max(0, nowS - at);
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}분 전`;
  if (secs < DAY) return `${Math.floor(secs / 3600)}시간 전`;
  return `${Math.floor(secs / DAY)}일 전`;
}

/** `5일 22시간 후` · `3시간 10분 후` · `25분 후`. */
export function formatIn(at: number, nowS: number): string {
  const mins = Math.max(0, Math.ceil((at - nowS) / 60));
  if (mins >= 1440) return `${Math.floor(mins / 1440)}일 ${Math.floor((mins % 1440) / 60)}시간 후`;
  if (mins >= 60) return `${Math.floor(mins / 60)}시간 ${mins % 60}분 후`;
  return `${mins}분 후`;
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

export interface ForecastPoint {
  at: number;
  /** Projected usable amount from `at` on (account-equivalents). */
  value: number;
}

export interface ForecastDay {
  start: number;
  end: number;
  /** `오늘`, then `토 16` (weekday + day of month). */
  label: string;
  /** Usable amount that comes back during this day. */
  gain: number;
}

export interface RecoveryMoment {
  at: number;
  gain: number;
  accounts: string[];
}

export interface ScopedSummary {
  /** The model the window limits, as llmux names it (`Fable`). */
  label: string;
  /** Σ weight × min(weekly, scoped remaining) over the accounts that run now. */
  now: number;
  /** Accounts whose scoped window was measured. */
  measured: number;
}

export interface GroupInfographic {
  group: string;
  label: string;
  accountCount: number;
  /** Σ weight of the counted accounts. */
  total: number;
  /** Usable now. */
  now: number;
  /** Weekly quota a block (cooldown, model ceiling) holds back now. */
  waiting: number;
  /** total − weekly remaining. */
  used: number;
  state: CapacityGroupView['state'];
  counts: { usable: number; drained: number; held: number; noMeasure: number; unknownTier: number };
  /** Counted accounts on an assumed plan. */
  tierAssumed: number;
  scoped: ScopedSummary[];
  /** Step series: the first point is now. */
  points: ForecastPoint[];
  days: ForecastDay[];
  next?: RecoveryMoment;
  within24h: number;
  /** When the projected usable amount reaches the total; absent when already full or never within the horizon. */
  fullAt?: number;
  /** Oldest llmux measurement among the counted accounts (epoch seconds). */
  oldestRefreshAt?: number;
}

export interface AuthInfographic {
  nowS: number;
  version?: string;
  groups: GroupInfographic[];
  /** Providers without plan windows: not in the totals. */
  others: { label: string; accounts: number }[];
}

/** Accounts of `group`, in the order the capacity view built its units. */
function accountsOf(status: LlmuxStatus, group: string): LlmuxAccount[] {
  return groupAccounts(status.accounts ?? []).get(group) ?? [];
}

function scopedSummaries(accounts: LlmuxAccount[], units: CapacityUnit[], nowMs: number): ScopedSummary[] {
  if (accounts.length !== units.length) return [];
  const byLabel = new Map<string, ScopedSummary>();
  accounts.forEach((account, i) => {
    const unit = units[i];
    for (const { window } of collectScopedWindows(account)) {
      const label = (window.scope_label ?? '').trim() || 'scoped';
      const rem = remaining(window, nowMs);
      const row = byLabel.get(label) ?? { label, now: 0, measured: 0 };
      if (rem !== undefined) {
        row.measured += 1;
        if (unit.counted && !unit.blocked && unit.weight !== null) row.now += unit.weight * Math.min(unit.week, rem);
      }
      byLabel.set(label, row);
    }
  });
  return [...byLabel.values()].map((s) => ({ ...s, now: round(s.now) }));
}

function forecastDays(nowS: number, events: { at: number; dNow: number }[]): ForecastDay[] {
  const end = nowS + FORECAST_SECS;
  const days: ForecastDay[] = [];
  let start = nowS;
  while (start < end) {
    const next = Math.min(kstDayStart(start) + DAY, end);
    const p = kstParts(start);
    days.push({ start, end: next, label: days.length === 0 ? '오늘' : `${p.weekday} ${p.day}`, gain: 0 });
    start = next;
  }
  for (const e of events) {
    const day = days.find((d) => e.at >= d.start && e.at < d.end) ?? (e.at === end ? days[days.length - 1] : undefined);
    if (day) day.gain += e.dNow;
  }
  return days.map((d) => ({ ...d, gain: round(d.gain) }));
}

function groupInfographic(view: CapacityGroupView, accounts: LlmuxAccount[], nowMs: number): GroupInfographic {
  const nowS = Math.floor(nowMs / 1000);
  const counted = view.units.filter((u) => u.counted);
  const points: ForecastPoint[] = [{ at: nowS, value: view.now }];
  let value = view.now;
  let fullAt: number | undefined;
  let next: RecoveryMoment | undefined;
  for (const e of view.events) {
    if (e.dNow <= EPS) continue;
    value = round(value + e.dNow);
    const last = points[points.length - 1];
    if (last && last.at === e.at) last.value = value;
    else points.push({ at: e.at, value });
    if (fullAt === undefined && view.total > EPS && value >= view.total - 1e-6) fullAt = e.at;
    if (!next) next = { at: e.at, gain: 0, accounts: [] };
    if (next.at === e.at) {
      next.gain = round(next.gain + e.dNow);
      next.accounts.push(e.account);
    }
  }
  const within24h = round(view.events.filter((e) => e.at <= nowS + DAY).reduce((t, e) => t + Math.max(0, e.dNow), 0));
  return {
    group: view.group,
    label: view.label,
    accountCount: view.accountCount,
    total: view.total,
    now: view.now,
    waiting: round(Math.max(0, view.week - view.now)),
    used: round(Math.max(0, view.total - view.week)),
    state: view.state,
    counts: {
      usable: counted.filter((u) => u.now > EPS).length,
      drained: counted.filter((u) => u.now <= EPS).length,
      held: view.excluded.held,
      noMeasure: view.excluded.noMeasure,
      unknownTier: view.excluded.unknownTier,
    },
    tierAssumed: view.tierAssumed,
    scoped: scopedSummaries(accounts, view.units, nowMs),
    points,
    days: forecastDays(nowS, view.events),
    ...(next ? { next } : {}),
    within24h,
    ...(fullAt !== undefined ? { fullAt } : {}),
    ...(view.oldestRefreshAt !== undefined ? { oldestRefreshAt: view.oldestRefreshAt } : {}),
  };
}

export function buildAuthInfographic(status: LlmuxStatus, view: CapacityView, nowMs: number): AuthInfographic {
  const planGroups = new Set(view.groups.map((g) => g.group));
  const others = [...groupAccounts(status.accounts ?? [])]
    .filter(([group]) => !planGroups.has(group))
    .map(([group, accounts]) => ({ label: providerLabel(group), accounts: accounts.length }));
  return {
    nowS: Math.floor(nowMs / 1000),
    ...(status.version ? { version: status.version } : {}),
    groups: view.groups.map((g) => groupInfographic(g, accountsOf(status, g.group), nowMs)),
    others,
  };
}

/* ------------------------------------------------------------------ *
 * Account report
 * ------------------------------------------------------------------ */

export type AccountRowState = 'usable' | 'blocked' | 'drained' | 'held' | 'auth' | 'unmeasured';

export interface AccountReportRow {
  /** Short label (`ai43`), the capacity view's own (masked when llmux is anonymous). */
  name: string;
  current: boolean;
  /** `x20` · `x5` · `$500` · `$200`; a trailing `*` = assumed, not configured. */
  plan?: string;
  state: AccountRowState;
  stateLabel: string;
  /** Weekly remaining, 0..1 of this account. */
  week?: number;
  scoped?: { label: string; remaining?: number };
  /** Weekly reset (epoch seconds). */
  resetAt?: number;
  /** When a blocked account can run again. */
  returnAt?: number;
  inFlight?: number;
  measuredAt?: number;
}

export interface AccountReportGroup {
  group: string;
  label: string;
  rows: AccountReportRow[];
}

export interface AccountReport {
  nowS: number;
  version?: string;
  groups: AccountReportGroup[];
}

const STATE_ORDER: Record<AccountRowState, number> = {
  usable: 0,
  blocked: 1,
  drained: 2,
  held: 3,
  auth: 4,
  unmeasured: 5,
};

function heldLabel(account: LlmuxAccount): { state: AccountRowState; label: string } {
  const reason = typeof account.blocked === 'string' ? account.blocked.trim().toLowerCase() : '';
  if (account.status === 'auth_failed') return { state: 'auth', label: '인증 실패' };
  if (account.status === 'paused' || reason.startsWith('paused')) return { state: 'held', label: '일시정지' };
  if (reason.startsWith('saved')) return { state: 'held', label: '절약 모드 보류' };
  if (account.status === 'cooldown' || reason.startsWith('cooldown'))
    return { state: 'held', label: '쿨다운 (종료 미상)' };
  return { state: 'held', label: '보류' };
}

function blockLabel(unit: CapacityUnit, scopedLabel: string | undefined): string {
  if (unit.blocks.scopedUntil) return `${scopedLabel ?? '모델'} 한도 막힘`;
  if (unit.blocks.cooldownUntil) return '쿨다운';
  return '막힘';
}

function scopedOf(account: LlmuxAccount, nowMs: number): AccountReportRow['scoped'] {
  const [first] = collectScopedWindows(account);
  if (!first) return undefined;
  const rem = remaining(first.window, nowMs);
  return {
    label: (first.window.scope_label ?? '').trim() || 'scoped',
    ...(rem !== undefined ? { remaining: rem } : {}),
  };
}

function baseRow(account: LlmuxAccount, name: string, current: boolean, nowMs: number): AccountReportRow {
  const week = remaining(account.seven_day, nowMs);
  const reset = account.seven_day ? resetAt(account.seven_day, nowMs) : undefined;
  const refreshed = Number.isFinite(account.last_refresh_ms) && (account.last_refresh_ms as number) > 0;
  const scoped = scopedOf(account, nowMs);
  return {
    name,
    current,
    state: 'unmeasured',
    stateLabel: '미측정',
    ...(week !== undefined ? { week } : {}),
    ...(scoped ? { scoped } : {}),
    ...(reset !== undefined && reset > nowMs / 1000 ? { resetAt: reset } : {}),
    ...(Number.isFinite(account.in_flight) ? { inFlight: account.in_flight } : {}),
    ...(refreshed ? { measuredAt: Math.floor((account.last_refresh_ms as number) / 1000) } : {}),
  };
}

function planRow(account: LlmuxAccount, unit: CapacityUnit, current: boolean, nowMs: number): AccountReportRow {
  const row = baseRow(account, unit.name, current, nowMs);
  if (unit.tier) row.plan = `${LLMUX_TIERS[unit.tier].short}${unit.tierAssumed ? '*' : ''}`;
  if (unit.excluded === 'held') {
    const h = heldLabel(account);
    return { ...row, state: h.state, stateLabel: h.label };
  }
  if (unit.excluded === 'noMeasure') return row;
  if (unit.excluded === 'unknownTier') {
    // Not in the totals, but llmux still measured it.
    const usable = (row.week ?? 0) > EPS && !account.blocked;
    return { ...row, state: usable ? 'usable' : 'drained', stateLabel: usable ? '사용 가능 (플랜 미상)' : '주간 소진' };
  }
  row.week = unit.week;
  if (unit.now > EPS) return { ...row, state: 'usable', stateLabel: '사용 가능' };
  if (unit.week <= EPS) return { ...row, state: 'drained', stateLabel: '주간 소진' };
  return {
    ...row,
    state: 'blocked',
    stateLabel: blockLabel(unit, row.scoped?.label),
    ...(unit.returnAt !== undefined ? { returnAt: unit.returnAt } : {}),
  };
}

function rawRow(account: LlmuxAccount, name: string, current: boolean, nowMs: number): AccountReportRow {
  // No scoped column here: such a provider can list a window per model, and picking the first would be arbitrary.
  const { scoped: _scoped, ...row } = baseRow(account, name, current, nowMs);
  if (
    account.status === 'auth_failed' ||
    account.status === 'paused' ||
    account.status === 'cooldown' ||
    account.blocked
  ) {
    const h = heldLabel(account);
    return { ...row, state: h.state, stateLabel: h.label };
  }
  if (row.week === undefined) return { ...row, state: 'usable', stateLabel: '사용 가능 (잔여량 미제공)' };
  return row.week > EPS
    ? { ...row, state: 'usable', stateLabel: '사용 가능' }
    : { ...row, state: 'drained', stateLabel: '주간 소진' };
}

function sortRows(rows: AccountReportRow[]): AccountReportRow[] {
  const key = (r: AccountReportRow): number => {
    if (r.state === 'usable') return -(r.week ?? 0);
    if (r.state === 'blocked') return r.returnAt ?? Number.MAX_SAFE_INTEGER;
    if (r.state === 'drained') return r.resetAt ?? Number.MAX_SAFE_INTEGER;
    return 0;
  };
  return [...rows].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      Number(b.current) - Number(a.current) ||
      key(a) - key(b) ||
      a.name.localeCompare(b.name, 'en', { numeric: true }),
  );
}

export function buildAccountReport(status: LlmuxStatus, view: CapacityView, nowMs: number): AccountReport {
  const planViews = new Map(view.groups.map((g) => [g.group, g]));
  const groups: AccountReportGroup[] = [];
  for (const [group, accounts] of groupAccounts(status.accounts ?? [])) {
    const current = status.current_by_group?.[group] ?? (group === 'claude' ? status.current : null) ?? null;
    const planView = planViews.get(group);
    const aligned = planView && planView.units.length === accounts.length;
    const rows = accounts.map((account, i) => {
      const isCurrent = current === account.name;
      return aligned
        ? planRow(account, planView.units[i], isCurrent, nowMs)
        : rawRow(account, llmuxAccountLocalName(account.name, group), isCurrent, nowMs);
    });
    groups.push({ group, label: providerLabel(group), rows: sortRows(rows) });
  }
  return {
    nowS: Math.floor(nowMs / 1000),
    ...(status.version ? { version: status.version } : {}),
    groups,
  };
}

/* ------------------------------------------------------------------ *
 * Alt text
 * ------------------------------------------------------------------ */

const one = (n: number): string => (Math.abs(n) < 0.05 ? '0' : (Math.round(n * 10) / 10).toFixed(1));

/**
 * The summary picture in words — the image block's `alt_text` (screen readers,
 * notifications, clients that do not load images). One clause per provider.
 */
export function describeAuthInfographic(info: AuthInfographic): string {
  const parts = info.groups.map((g) => {
    if (g.total <= 0) return `${g.label} 집계할 계정 없음`;
    const bits = [`${g.label} 지금 ${one(g.now)}/${one(g.total)} 계정분(${Math.round((g.now / g.total) * 100)}%)`];
    if (g.next) bits.push(`다음 +${one(g.next.gain)} ${formatKstMoment(g.next.at, info.nowS)}`);
    if (g.fullAt !== undefined) bits.push(`전부 회복 ${formatKstMoment(g.fullAt, info.nowS)}`);
    return bits.join(', ');
  });
  const text = `LLM 남은 용량 (${formatKstStamp(info.nowS)} KST): ${parts.join(' / ') || '집계할 공급자 없음'}`;
  return text.length <= 2000 ? text : `${text.slice(0, 1997)}...`;
}

/** The account report picture in words — its `alt_text`. One clause per provider. */
export function describeAccountReport(report: AccountReport): string {
  const parts = report.groups.map((g) => {
    const count = (state: AccountRowState) => g.rows.filter((r) => r.state === state).length;
    const bits = [`사용 가능 ${count('usable')}`];
    if (count('blocked')) bits.push(`막힘 ${count('blocked')}`);
    if (count('drained')) bits.push(`주간 소진 ${count('drained')}`);
    if (count('held') + count('auth')) bits.push(`보류 ${count('held') + count('auth')}`);
    return `${g.label} ${g.rows.length}계정 (${bits.join(', ')})`;
  });
  const text = `계정별 상세 (${formatKstStamp(report.nowS)} KST): ${parts.join(' / ') || '계정 없음'}`;
  return text.length <= 2000 ? text : `${text.slice(0, 1997)}...`;
}
