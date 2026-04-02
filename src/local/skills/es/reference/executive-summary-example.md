# 🎯 PTN-3231 Executive Summary

## 0. SSOT
- SSOT
```
@Z [2026/03/30 11:52 AM] @사마중달 (Beta) 리서치 잡
의도:
- bonus scan이랑 vsports polling 등 병렬 실행할 수 있는 일들에 대한 서비스 분리 작업. 대부분 db read only 문맥을 주면 좋을듯 함
- 생각
  - 별도 bg worker jobs executers
  - 스케쥴된 일들을 주기적으로 실행하고 결과를 settlements_service api 호출로 종료함
  - replicated ro db에만 직접 접근 가능함
@Z [2026/03/30 12:49 PM] approve 했으니 니가 마무리해
```
- PTN-3231: https://insightquest.atlassian.net/browse/PTN-3231 - QA
- PR #1462: https://github.com/devinsightquest/Gucci/pull/1462 - Merged
- PR #1455: https://github.com/devinsightquest/Gucci/pull/1455 - Merged

## 1. 문제 배경

**VirtualSport 정산 파이프라인**에서 `NotifySettlements` 메시지가 SnapshotService에서 SettlementService/GucciService로 **WebSocket을 통해 전달되지 않는** 장애가 의심되었다.

**Impact Chain**:
```
VsportsResultFeedHostedService.ProcessResults()
  → VsportsSettlementEventBuilder.Build()
    → _snapshotServer.OnReceive(NotifySettlements, serialized)
      → SnapshotServer.NotifySettlements handler
        → FilterAndMapLivescoreForEvents (여기서 차단!)
          → broadcastEvents.Count == 0
            → BroadcastToSubscribers 스킵 (로그 없음!)
              → SettlementService.NotifySettlements 미수신
                → SettleFixture() 미호출
                → BigWinPublisher.PublishOnVirtualSportSettlement() 미호출
```

**비즈니스 영향**:
- **Bet 정산 누락**: VirtualSport 경기 결과에 대한 Bet 정산이 제때 이루어지지 않음
- **BigWinFeed 미발동**: 대박 당첨 알림이 발생하지 않아 운영/마케팅 피드 누락
- **장애 감지 불가**: 문제 발생 시 어떤 로그도 남지 않아(Silent Filter Drop) 운영자가 인지할 수 없음

## 2. 근본 원인 분석

### Jira 이슈 7대 장애 포인트 (우선순위순)

| # | 장애 포인트 | 위치 | 진단 |
|---|------------|------|------|
| 1 | AutoSettle 비활성화 | VsportsResultFeedHostedService.cs:290 | 설정 확인 필요 |
| 2 | VsportsConfig.Enabled=false | VsportsResultFeedHostedService.cs:61 | 설정 확인 필요 |
| 3 | SettlementService WS 미연결 | SnapshotServer.Impl.SubscribeServer.cs:38 | 연결 상태 확인 |
| 4 | ResultApiUrl 미설정 | VsportsResultFeedHostedService.cs:204 | 설정 확인 필요 |
| 5 | PublicationGate 중복 | VsportsResultFeedHostedService.cs:302 | 정상 동작 확인 |
| **6** | **Snapshot Fixture null 필터 (SILENT!)** | **SnapshotServer.Protein.Receive.cs:689** | **🔴 코드 결함 확인** |
| 7 | sport.Enabled=false | VsportsResultFeedHostedService.cs:137 | 설정 확인 필요 |

### 발견된 코드 결함 2건

**결함 A — Filter/Update 순서 오류 (Root Cause)**

4개 Notify 핸들러에서 `FilterAndMapLivescoreForEvents`(필터)가 `UpdateEventMessage`(스냅샷 갱신)보다 **먼저** 호출됨.

```
❌ AS-IS: Filter(stale snapshot) → Update
✅ TO-BE: Update(latest snapshot) → Filter
```

필터 내부의 `ShouldBroadcastEvent`가 `snapshotEvent.Fixture == null`을 검사하는데, 스냅샷이 아직 갱신되지 않은 상태에서 검사하니 VirtualSport 신규 Fixture가 항상 null → broadcast 차단.

`NotifyFixtureUpdate`만 올바른 순서(Update-First)였고, 나머지 4개가 잘못되어 있었다.

**결함 B — Silent Filter Drop (#6)**

`broadcastEvents.Count == 0`일 때 어떤 로그도 남기지 않고 broadcast를 스킵. 운영자가 장애를 인지할 수 없는 구조적 결함.

## 3. 수정 내역

### PR #1462 — Root Cause Fix (MERGED 2026-03-31 10:09 UTC)

| 항목 | 내용 |
|------|------|
| **변경** | 4개 핸들러의 `UpdateEventMessage`/`FilterAndMapLivescoreForEvents` 호출 순서를 Update-First로 통일 |
| **파일** | `SnapshotServer.Protein.Receive.cs` (+12 -12, 순서만 교환) |
| **효과** | NotifySettlements가 WebSocket으로 정상 broadcast → SettlementService 수신 → SettleFixture/BigWinFeed 복원 |
| **리뷰** | osun50s 리뷰 요청, squash merge |

### PR #1455 — Silent Filter Drop Logging (MERGED 2026-04-01 03:49 UTC)

| 항목 | 내용 |
|------|------|
| **변경** | 5개 Notify 핸들러에 `else` 분기 Warn 로그 추가 + `LogFilteredEventsDrop` 헬퍼 메서드 |
| **파일** | `SnapshotServer.Protein.Receive.cs` (+71 -10) |
| **품질** | Codex 리뷰 3회 루프: 83→92→**99/100** |
| **수정 사항** | Competition 로그 Warn→Debug(증폭 방지), FixtureIds→Distinct+Sample, 필드명 `SampleFixtureIds` |
| **리뷰** | icedac APPROVED, squash merge |

## 4. STV Verify 결과

| Spec Item | Status | 검증 방법 |
|-----------|--------|-----------|
| NotifySettlements WS 전송 복원 | ✅ | 코드 순서 확인, 빌드 0 Error |
| NotifyFixtureUpdate 정상 확인 | ✅ | 원래 Update-First — 변경 불필요 확인 |
| NotifyLivescoreUpdate 순서 수정 | ✅ | Update→Filter 순서 diff 확인 |
| NotifyMarketUpdate 순서 수정 | ✅ | Update→Filter 순서 diff 확인 |
| NotifyEventUpdate 순서 수정 | ✅ | Update→Filter 순서 diff 확인 |
| Silent Filter Drop 로깅 | ✅ | 5개 핸들러 else 분기 + 헬퍼 메서드 확인 |
| Bet정산/BigWinFeed 트리거 복원 | ✅ | NotifySettlements→BroadcastToSubscribers→Settlement 경로 확인 |

**Verdict: PASS** — 7/7 spec 항목 충족, Gap 0건

## 5. 타임라인

| 시각 (UTC) | 이벤트 |
|-----------|--------|
| 03/31 06:49 | 이전 세션에서 PTN-3231 작업 시작 |
| 03/31 07:14 | Jira PTN-3231 이슈 생성 (7개 장애포인트 분석) |
| 03/31 07:39 | PR #1455 생성 (Silent Filter Drop 로깅) |
| 03/31 08:48 | Z: "웹소켓으로 전달하라고 써있잖아" — 핵심 요구사항 명확화 |
| 03/31 09:19 | PR #1462 생성 (Filter/Update 순서 수정 — root cause fix) |
| 03/31 10:09 | **PR #1462 MERGED** |
| 03/31 10:43 | deploy/dev2 배포 PR #1470 merged |
| 04/01 02:53 | icedac PR #1455 APPROVED |
| 04/01 03:49 | **PR #1455 MERGED** |

## 6. 리스크 및 후속 조치

| 항목 | 상태 | 조치 |
|------|------|------|
| **이미 누락된 정산** | ⚠️ 미확인 | 배포 전 기간 동안 VirtualSport 정산이 누락됐을 수 있음. 운영팀이 reconciliation 확인 필요 |
| **dev2 배포 확인** | ✅ | PR #1462 포함된 deploy/dev2 (#1470) 이미 머지됨. PR #1455는 다음 배포에 포함 예정 |
| **모니터링** | 🔶 권장 | 배포 후 `notify_settlements_all_filtered` 로그 발생 빈도 모니터링 → 0이면 정상, 지속 발생 시 Jira 장애포인트 1~5,7 점검 |
| **Jira 장애포인트 1~5,7** | 🔶 미확인 | 설정 기반 장애포인트(AutoSettle, VsportsConfig 등)는 런타임 확인 필요. 코드 결함은 수정 완료 |
| **Jira PTN-3231** | QA | 배포 후 실제 정산 동작 QA 검증 필요 |

## 7. AS-IS → TO-BE 종합

| 구분 | AS-IS | TO-BE |
|------|-------|-------|
| **핸들러 순서** | 4개 핸들러 Filter→Update (stale snapshot) | ✅ 5개 핸들러 모두 Update→Filter (일관) |
| **WS Broadcast** | NotifySettlements 차단 (VirtualSport) | ✅ 정상 broadcast |
| **Bet 정산** | SettleFixture 미호출 | ✅ 정상 호출 |
| **BigWinFeed** | PublishOnVirtualSportSettlement 미호출 | ✅ 정상 호출 |
| **관찰성** | Silent Drop — 로그 없음 | ✅ 5개 핸들러 Warn + Competition Debug |
| **진단 도구** | 장애 원인 추적 불가 | ✅ GameType, Guid, SampleFixtureIds 포함 구조화 로그 |

## 8. 레퍼런스

- 