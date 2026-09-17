import type { LlmuxAccount, LlmuxScopedWindow, LlmuxWindow } from '../../auth/llmux-client';

/** Keep upstream strings from becoming Slack mentions/links or formatting. */
export function authText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[*_`~]/g, '​$&​');
}

export function accountGroup(account: LlmuxAccount): string {
  return (
    account.group?.trim().toLowerCase() ||
    (['codex', 'grok', 'openrouter'].includes(account.type) ? account.type : 'claude')
  );
}

export function providerName(group: string): string {
  return ({ claude: 'Claude', codex: 'Codex', grok: 'Grok' } as Record<string, string>)[group] ?? authText(group);
}

export function groupAccounts(accounts: LlmuxAccount[]): Map<string, LlmuxAccount[]> {
  const priority = ['claude', 'codex', 'grok'];
  const groups = new Map<string, LlmuxAccount[]>();
  for (const account of accounts) {
    const key = accountGroup(account);
    const rows = groups.get(key) ?? [];
    rows.push(account);
    groups.set(key, rows);
  }
  return new Map(
    [...groups]
      .sort(([a], [b]) => {
        const rank = (key: string) => (priority.includes(key) ? priority.indexOf(key) : priority.length);
        return rank(a) - rank(b) || a.localeCompare(b);
      })
      .map(([key, rows]) => [
        key,
        rows.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'en', { numeric: true })),
      ]),
  );
}

export function collectScopedWindows(account: LlmuxAccount): { label: string; window: LlmuxScopedWindow }[] {
  if (Array.isArray(account.scoped_limits) && account.scoped_limits.length > 0) {
    return account.scoped_limits.map((window, i) => ({
      label: `7d-${(window.scope_label ?? `scoped${i + 1}`).toLowerCase()}`,
      window,
    }));
  }
  return account.fable_weekly ? [{ label: '7d-fable', window: account.fable_weekly }] : [];
}

/** Only subscription windows have a known duration in this status contract. */
export function hasSubscriptionWindows(account: LlmuxAccount): boolean {
  return ['claude', 'codex'].includes(accountGroup(account)) && account.type !== 'apikey';
}

function invalidAbsoluteReset(window: LlmuxWindow): boolean {
  // Older snapshots use 0/null/omission for an unreported reset, not an invalid one.
  const at = window.resets_at;
  return at != null && at !== 0 && (!Number.isFinite(at) || at < 0 || at >= 8.64e12);
}

export function resetAt(window: LlmuxWindow, nowMs: number): number | undefined {
  // Invalid or elapsed absolute resets must never be replaced with a fresh forecast.
  if (invalidAbsoluteReset(window)) return undefined;
  if (window.resets_at > 0) return window.resets_at;
  if (Number.isFinite(window.resets_in_secs) && window.resets_in_secs > 0 && window.resets_in_secs < 31_536_000) {
    return Math.floor(nowMs / 1000) + window.resets_in_secs;
  }
  return undefined;
}

export function remaining(window: LlmuxWindow | null | undefined, nowMs: number): number | undefined {
  if (
    !window ||
    !Number.isFinite(window.utilization) ||
    window.utilization < 0 ||
    window.utilization > 1 ||
    invalidAbsoluteReset(window)
  )
    return undefined;
  const reset = resetAt(window, nowMs);
  if (reset !== undefined && reset <= nowMs / 1000) return undefined;
  return 1 - window.utilization;
}

function percent(ratio: number): string {
  return String(Math.round(ratio * 1000) / 10);
}

export function formatReset(epoch: number, nowMs: number): string {
  const seconds = Math.max(0, epoch - nowMs / 1000);
  const minutes = Math.ceil(seconds / 60);
  const delta =
    minutes >= 1440
      ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`;
  const fallback = new Date(epoch * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  return `<!date^${Math.floor(epoch)}^{date_short_pretty} {time}|${fallback}> (${delta} 후)`;
}

export function windowLine(label: string, window: LlmuxWindow | null | undefined, nowMs: number, timed = true): string {
  const amount = remaining(window, nowMs);
  if (amount === undefined) return `${authText(label)} · 잔여량 미제공${window ? ' / 재조회 필요' : ''}`;
  const reset = window && resetAt(window, nowMs);
  return `${authText(label)} 잔여 ${percent(amount)}% (사용 ${percent(1 - amount)}%) · ${timed && reset ? `리셋 ${formatReset(reset, nowMs)}` : '리셋 시각 미제공'}`;
}

export function accountUnavailable(account: LlmuxAccount, nowMs: number): boolean {
  return (
    !!account.blocked ||
    account.status === 'auth_failed' ||
    account.status === 'cooldown' ||
    (Number.isFinite(account.cooldown_until) && (account.cooldown_until ?? 0) > nowMs / 1000) ||
    [account.five_hour, account.seven_day].some((w) => remaining(w, nowMs) === 0)
  );
}

function windowTotals(label: string, rows: (LlmuxWindow | null | undefined)[], total: number, nowMs: number): string {
  const measured = rows.map((w) => remaining(w, nowMs)).filter((n): n is number => n !== undefined);
  if (!measured.length) return `${authText(label)} 잔여량 미제공 · 측정 0/${total}`;
  return `${authText(label)} 잔여 합계 ${measured.reduce((a, b) => a + b, 0).toFixed(2)}계정분 · 측정 ${measured.length}/${total}`;
}

export function groupSummary(accounts: LlmuxAccount[], nowMs: number): string[] {
  const subscriptions = accounts.filter(hasSubscriptionWindows);
  const known = subscriptions.filter(
    (a) => remaining(a.five_hour, nowMs) !== undefined && remaining(a.seven_day, nowMs) !== undefined,
  );
  const available = known.filter((a) => !accountUnavailable(a, nowMs)).length;
  const blocked = accounts.filter((a) => accountUnavailable(a, nowMs)).length;
  const lines = subscriptions.length
    ? [
        `공통 한도 여유 ${available}/${accounts.length} (5h·7d 확인, 모델별 한도 별도) · 차단 ${blocked} · 미확인 ${accounts.length - available - blocked}`,
      ]
    : [
        `속도 한도 측정 ${accounts.filter((a) => remaining(a.five_hour, nowMs) !== undefined).length}/${accounts.length} · 차단 ${blocked} · 구독 잔여량 미제공`,
      ];
  if (subscriptions.length) {
    lines.push(
      windowTotals(
        '5h',
        subscriptions.map((a) => a.five_hour),
        subscriptions.length,
        nowMs,
      ),
    );
    lines.push(
      windowTotals(
        '7d',
        subscriptions.map((a) => a.seven_day),
        subscriptions.length,
        nowMs,
      ),
    );
    const scopes = new Map<string, LlmuxScopedWindow[]>();
    for (const account of subscriptions)
      for (const { label, window } of collectScopedWindows(account)) {
        const rows = scopes.get(label) ?? [];
        rows.push(window);
        scopes.set(label, rows);
      }
    for (const [label, rows] of scopes) lines.push(windowTotals(label, rows, subscriptions.length, nowMs));
    lines.push('합계는 차단 계정 포함 · 계정별 100%=1계정분, 플랜 가중치 없음 · 토큰 수가 아닙니다.');
  } else {
    lines.push('총 잔여량 미제공 · 속도 한도는 구독 토큰 잔고가 아닙니다.');
  }
  const resets = subscriptions
    .flatMap((account) =>
      [
        { label: '5h', window: account.five_hour },
        { label: '7d', window: account.seven_day },
        ...collectScopedWindows(account),
      ].flatMap(({ label, window }) => {
        const at = window && resetAt(window, nowMs);
        const amount = remaining(window, nowMs);
        return at && at > nowMs / 1000 && amount !== undefined && amount < 1
          ? [{ name: account.name, label, at, recovered: 1 - amount }]
          : [];
      }),
    )
    .sort((a, b) => a.at - b.at);
  if (resets[0]) {
    const next = resets[0];
    lines.push(
      `다음 리셋: ${authText(next.name)} ${authText(next.label)} · ${formatReset(next.at, nowMs)} · +${percent(next.recovered)}%p`,
    );
    lines.push('추가 사용 없을 때 해당 창만 회복 · 다른 한도·쿨다운·인증 상태는 별도 확인.');
  }
  return lines;
}

export function accountLines(account: LlmuxAccount, nowMs: number): string[] {
  const timed = hasSubscriptionWindows(account);
  const lines = timed
    ? [windowLine('5h', account.five_hour, nowMs), windowLine('7d', account.seven_day, nowMs)]
    : [windowLine('속도 한도', account.five_hour, nowMs, false), '잔여 토큰·요청 수 미제공 · 리셋 시각 미제공'];
  for (const { label, window } of collectScopedWindows(account)) lines.push(windowLine(label, window, nowMs, timed));
  if (
    account.cooldown_until &&
    Number.isFinite(account.cooldown_until) &&
    account.cooldown_until > nowMs / 1000 &&
    account.cooldown_until < 8.64e12
  )
    lines.push(`쿨다운 종료 ${formatReset(account.cooldown_until, nowMs)}`);
  if (account.status === 'cooldown') lines.push('쿨다운 · 현재 사용 불가');
  if (account.status === 'auth_failed') lines.push('인증 실패 · 재인증 필요');
  if (account.blocked) lines.push(`차단: ${authText(account.blocked)}`);
  if (account.in_flight !== undefined && Number.isFinite(account.in_flight))
    lines.push(`처리 중 ${account.in_flight}건`);
  if (account.usage_control) {
    const control = account.usage_control;
    const count = (n: number | undefined) =>
      n !== undefined && Number.isSafeInteger(n) && n >= 0 ? `${n}회` : '미확인';
    lines.push(
      `수동 리셋: 보유 ${count(control.available_resets)} · 현재 적용 가능 ${count(control.applicable_resets)} · 자동 사용하지 않습니다`,
    );
    if (control.last_error) lines.push('수동 리셋 정보 최근 조회 실패 · 이전 관측값');
    if (control.pending_request_id) lines.push('수동 리셋 결과 미확정 · llmux에서 확인 필요');
    if (
      control.last_refresh_ms &&
      Number.isFinite(control.last_refresh_ms) &&
      control.last_refresh_ms > 0 &&
      control.last_refresh_ms < 8.64e15
    ) {
      const epoch = Math.floor(control.last_refresh_ms / 1000);
      lines.push(
        `리셋 정보 확인 <!date^${epoch}^{date_short_pretty} {time}|${new Date(control.last_refresh_ms).toISOString()}>`,
      );
    }
  }
  if (account.totals) {
    const count = (n: number) => (Number.isFinite(n) && n >= 0 ? n.toLocaleString('en-US') : '미확인');
    lines.push(
      `누적 사용: 요청 ${count(account.totals.requests)}건 · 입력 ${count(account.totals.input_tokens)} / 출력 ${count(account.totals.output_tokens)} 토큰 (잔여량 아님)`,
    );
  }
  return lines;
}
