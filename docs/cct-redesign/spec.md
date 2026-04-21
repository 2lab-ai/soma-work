# CCT 카드 / Add·Attach / 구독 OAuth 사용량 UI 재설계

> Issue: https://github.com/2lab-ai/soma-work/issues/641
> Scope of this commit: **PR#1 = M1-S1 ~ M1-S4** (P0 긴급)
> Full roadmap (M1~M3, 15 scenarios, 5 PRs) captured in trace.md for future work.

## Why

관리자가 Slack `cct` 카드에서:
- 각 CCT 슬롯의 **5시간 / 7일 / 7일-sonnet 사용률**을 즉시 보고,
- 각 슬롯의 **구독 tier** (Max 5x / Max 20x / Pro)를 식별하고,
- 필요 시 **수동으로 usage refresh**를 트리거할 수 있어야 한다.

현재 상태 (AS-IS):
- `UsageSnapshot` 필드는 이미 TM에 존재하지만 **자동 갱신 루프가 없다** — 최초 attach 시점 이후 다시 fetch되지 않음.
- 카드는 `5h X% · 7d Y%` 한 줄 텍스트만 노출. `sevenDaySonnet`, `subscriptionType`, `rateLimitTier` 데이터는 렌더 경로에서 버려진다.
- 텍스트 `cct usage` 경로(`cct-handler.ts:renderUsageLines`)와 카드 경로(`builder.ts:buildSlotRow`)가 **포맷 로직을 중복**한다.
- 관리자가 수동 갱신할 UI가 없다.

목표 (TO-BE, PR#1):
- 부팅 시 `UsageRefreshScheduler` 가 5분마다 `tm.fetchUsageForAllAttached({ timeoutMs })` 를 pump.
- 카드의 active 슬롯 row에 **progress bar + reset countdown** 3줄 (5h/7d/7d-sonnet).
- subscription tier 배지 (`Max 5x`, `Max 20x`, `Pro`).
- 카드 상단 `🔄 Refresh all`, per-slot `Refresh usage` overflow 옵션.

Non-goals (이번 PR 아님):
- Usage detail modal (M1-S5, 다음 PR).
- 카드 UI 전면 리세팅 (legacy 버튼 제거 / Active·Inactive 분리 / overflow 메뉴 → M2, 별도 PR).
- Add 마법사 / Attach 통합 / Detach 확인 modal (M3, 별도 PR).
- `api_key` arm 활성화 — #633 의존, 이 PR과 무관.

## Who / Where

- Actor: Slack workspace admin.
- Surface: Slack slash command `cct` (slash) + `/z` 토픽 카드.
- 관련 서비스: Anthropic `platform.claude.com/v1/oauth/token` (refresh), `api.anthropic.com/api/oauth/usage`.

## Architecture Decisions

### A1. Scheduler는 새 모듈 (NOT TokenManager 내부)

이유:
- TM singleton은 이미 1392 lines, 책임이 많다. 주기적 pump는 얇은 래퍼로 분리.
- 테스트 주입성: fake clock을 생성자로 주입 가능 (`{ setInterval, clearInterval }`).
- 부팅 시 1회 start, shutdown path (`tokenManager.stop()` 옆)에서 1회 stop.

### A2. 새 config 섹션 `usage`

`src/config.ts` 에는 `parseIntEnv` 공용 헬퍼가 없고 필드별 inline parse 패턴(`parseFiveBlockPhase` 참고)을 쓴다. 이 PR에서도 inline 패턴을 유지하고, 방어적 파싱은 작은 file-local 헬퍼 `parsePositiveIntEnv(name, fallback)` 로 격리:

```ts
// src/config.ts (file-local helper, non-exported except for tests if needed)
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    logger.warn(`${name}="${raw}" invalid (expected positive integer); falling back to ${fallback}`);
    return fallback;
  }
  return n;
}

// Inside the `config` object (sibling of `credentials`, `ui`, etc.):
usage: {
  refreshEnabled: process.env.USAGE_REFRESH_DISABLED !== '1',
  refreshIntervalMs: parsePositiveIntEnv('USAGE_REFRESH_INTERVAL_MS', 5 * 60_000),
  fetchTimeoutMs: parsePositiveIntEnv('USAGE_FETCH_TIMEOUT_MS', 2_000),
},
```

기본 5분 선택 이유:
- `fetchUsage` 성공 시 `nextUsageFetchAllowedAt = now + 2min` 을 찍음 (`oauth/usage.ts`).
- 스케줄러 주기가 2분이면 tick과 gate가 타이밍 충돌. 5분이면 각 tick마다 gate 해제된 상태에서 실제 fetch 진행 → 일관된 리듬.
- Anthropic 서버 부담 감소.

### A3. `fetchAndStoreUsage(keyId, { force })` 시그니처 확장

`force: true` 는 `nextUsageFetchAllowedAt` **로컬 스로틀만** 우회. 서버 429 응답은 기존 경로와 동일하게 `consecutiveUsageFailures++` + backoff ladder 적용. "사용자 의도 표현"과 "서버 보호"를 분리.

**중요**: public `fetchAndStoreUsage` 는 `usageFetchInFlight` (per-keyId) dedupe wrapper 이고, 실제 gate 와 fetch 로직은 private `#doFetchAndStoreUsage` 에 있다 (`src/token-manager.ts:1213` 와 `:1226`). `opts.force` 를 widen 할 때 **둘 다** 시그니처 확장 필수:

```ts
async fetchAndStoreUsage(keyId: string, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null>
async #doFetchAndStoreUsage(keyId: string, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null>
```

Gate (`:1237-1239`) 에 `if (!opts.force)` 추가하는 위치는 private 메서드. public 은 `opts` 를 그대로 private 에 전달만.

### A3b. Scheduler 는 `force` 를 절대 전파하지 않는다

`UsageRefreshScheduler.tick()` 은 `tm.fetchUsageForAllAttached({ timeoutMs })` 만 호출 — `force` 전달 금지. scheduler 가 force 를 쓰면 `nextUsageFetchAllowedAt` gate 를 무력화해 Anthropic 에 DDoS 발생. Invariant 로 테스트에서 잠금.

### A4. Card 블록 IDs / Action IDs **append-only**

`CCT_BLOCK_IDS` / `CCT_ACTION_IDS` 는 `views.update` across stable contract. PR#1 에서는:
- NEW: `CCT_ACTION_IDS.refresh_usage_all`, `refresh_usage_slot`.
- 기존 ID 변경 없음.

### A5. 카드 레이아웃은 **최소 변경**

M2 (카드 UI 전면 재설계)는 다른 PR. 이번 PR#1 에서는:
- `buildSlotRow` 가 내부적으로 usage panel / subscription badge 를 추가 노출만.
- legacy `z_setting_cct_set_*` 버튼은 **건드리지 않는다** (M2-S1 에서).
- Active/Inactive 분리 렌더 **안 함** (M2-S2 에서).

**기존 usage 한 줄 제거**: `builder.ts:121-127` 의 `segments.push(`usage ${parts.join(' ')}`)` (현재 `5h X% 7d Y%` 포맷) 는 **삭제**. 새 3줄 progress-bar 패널이 대체. 남기면 시각 중복.

**Refresh 버튼 배치**: per-slot overflow 도입은 M2-S3. 이번 PR 에서는 inline button 으로 배치 — 이미 존재하는 `Remove/Rename/Attach|Detach` 옆에 `Refresh` 추가. 4 버튼은 데스크톱에선 수용 가능, 모바일에선 줄바꿈 — 허용 (M2-S3 가 overflow 로 정리).

### A6. 텍스트 경로와 포맷 공유

`cct-handler.ts:renderUsageLines` 와 카드 panel 은 동일한 `formatUsageBar(util, resetsAtIso, now, label)` helper 를 호출 → 포맷 drift 방지.

## Done (Acceptance Criteria — PR#1)

1. 부팅 시 scheduler 시작. `USAGE_REFRESH_DISABLED=1` 로 끌 수 있음.
2. Scheduler 가 5분 주기로 `fetchUsageForAllAttached({ timeoutMs: 2000 })` pump.
3. Shutdown path 에서 scheduler 정지 (`tokenManager.stop()` 옆).
4. 카드 active slot row 에:
   - `5h    ████████░░ 80% · resets in 2h 15m`
   - `7d    ███░░░░░░░ 28% · resets in 3d 8h`
   - `7d-sonnet ██░░░░░░░░ 18% · resets in 3d 8h`
   - subscription tier badge (`· Max 5x`, `· Pro`, …).
5. 카드 상단 action row 에 `🔄 Refresh all` 버튼 — 클릭 시 `fetchUsageForAllAttached({ force: true })`.
6. Per-slot action row 에 `Refresh` 버튼 — 클릭 시 `fetchAndStoreUsage(keyId, { force: true })`.
7. 텍스트 `cct usage` 출력이 동일 helper 를 사용해 카드와 포맷 일치.
8. `force: true` 는 로컬 스로틀만 우회 (서버 429 → 기존 backoff 적용).
9. `CCT_BLOCK_IDS` / 기존 `CCT_ACTION_IDS` 무변동.
10. 테스트: scheduler / formatUsageBar / action handler / fetchAndStoreUsage force gate 각각 RED → GREEN. **기존 `renderUsageLines` 테스트 (`cct-handler.test.ts`) 는 새 `formatUsageBar` 포맷으로 업데이트** — 그대로 두면 format drift regression 으로 실패.
11. Invariant test: scheduler 의 tick 이 `fetchUsageForAllAttached` 를 호출할 때 `force` 를 **전달하지 않음** (Anthropic DDoS 방지).

## Future Work (captured in trace.md)

| Milestone | Scenarios | Status |
|---|---|---|
| M1-S5 | Usage detail modal | Backlog (다음 PR) |
| M2-S1..S5 | Card UI 재설계 | Backlog (별도 PR) |
| M3-S1..S4 | Add/Attach/Detach/Rename 정상화 | Backlog (별도 PR) |
| M3-S5 | api_key arm gate | Blocked by #633 |

## Risks

- **Scheduler interval tuning**: 5분이 과도하게 조밀할 수 있음. ENV 로 오버라이드 가능 (`USAGE_REFRESH_INTERVAL_MS`).
- **429 storm**: 여러 slot 동시 attach 후 첫 tick이 대량 호출. `fetchUsageForAllAttached` 내부가 이미 `Promise.allSettled` + per-keyId dedupe 로 완화. 추가적인 stagger 없음 — 기존 backoff ladder 가 복구 보증.
- **Force button spam**: `usageFetchInFlight` dedupe + 서버 429 → backoff 로 흡수.
