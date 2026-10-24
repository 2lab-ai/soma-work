# 12 — 크론 세션 표시(CRON 레인)와 LLM 가용량 쿨타임 타임라인

Status: shipped with this PR · Date: 2026-10-23 · 변경 전 기준 main `3c9576a`

증거 라벨: **[CODE]** = 이 저장소 `file:line` · **[REF]** = 리서치 출처 · **[TEST]** = 고정 테스트.

## 0. 한 줄 정의

크론이 만든 세션은 잡 이름으로 시작해 일이 이름을 얻으면 그 이름으로 바뀌고, 카드 머리에 CRON 뱃지를 달고 보드 위
CRON 레인에 잡별로 모인다. 통계 줄과 inbox 사이에는 llmux 프로바이더 그룹별 잔여율과, 지금부터 7일까지 각 계정이
언제 다시 채워지는지를 보여 주는 쿨타임 타임라인이 있다.

## 1. 요건 → 계약 (SSOT 2026-10-23, T1–T10)

| T | 요건 | 계약 |
|---|---|---|
| T1 | `Direct (skipDispatch)` 대신 잡 이름으로 시작 | 크론 발동 이벤트가 `cron:{jobId, jobName}`을 싣는다(`cronOrigin`, 주입·대기열·새 스레드 3경로). 디스패치 우회 분기에서 `resolveCronOrigin`(구조화 필드만, `[cron:…]` 텍스트 파싱 없음)이 있으면 제목 = 잡 이름, 세션에 `cronJob` 스탬프. 그 밖의 우회(오토 리줌·goal·인시던트)는 `Direct (skipDispatch)` 유지. 기존 세션에 주입된 크론은 그 세션을 스탬프하지 않는다. |
| T2 | 이름이 명확해지면 자연스럽게 교체 | 잡 이름 제목은 `titleProvisional`. 턴 요약 콜백(`canApplySummaryTitle`)과 링크 파생 제목(`setSessionTitle`)이 임시 제목을 교체하고 표식을 지운다. 명시적 제목 변경(`updateSessionTitle`: UPDATE_SESSION·PR·이슈)도 표식을 지운다. 교체 후 대시보드 카드를 즉시 푸시(`scheduleLiveSessionUpdate`)하고, 카드는 새 제목을 페이드인(`is-renamed`, reduced motion은 불투명도만). `cronJob`·`titleProvisional`은 재시작 후에도 남고 `cronJob`은 아카이브에도 남는다. |
| T3 | 좌측에 항상 CRON 뱃지 | `KanbanSession.cronJob`이 있는 카드는 머리 맨 앞이 ✦ 대신 시계 + `CRON` 뱃지(상태색, 툴팁 = 잡 이름). 제목이 바뀌어도 뱃지는 남는다. |
| T4 | 크론은 별도 상태 라인 | inbox 안, 칸 위 `#cron-lane`. 크론 카드는 NEEDS YOU / RUNNING / DONE에서 빠진다(`planCronLane`). 응답을 기다리는 잡이 레인 맨 앞이고 레인 머리에 `▲ 응답 필요 n` · `● 실행 중 n`. |
| T5 | 같은 잡을 묶고 클릭하면 지난 잡 | 잡 1개 = 타일 1개: 스케줄 문장(UTC cron, 시각은 보는 사람 시간대), 다음 실행, 최근 12회 막대(오래된→최신), 현재 상태, 그리고 잡의 최신 실행 카드(응답 대기 > 실행 중 > 최신). `지난 실행 N`·막대 클릭 = 오른쪽 서랍: 스케줄·다음 실행·실행 방식, 실행별 행(기호·시각·예약/▶수동·소요·토큰·비용·오류, 작업 로그/대화 기록/Slack). Esc·바깥 클릭으로 닫힘. 데이터 `GET /api/dashboard/cron?userId=`(프롬프트 비노출, 실행은 `executedAt` 최신순으로 다시 정렬, 세션은 라이브 레지스트리·14일 아카이브에서 연결, 토큰·비용은 그 잡이 만든 세션일 때만). 새 스레드 실행도 이제 `sessionKey`를 기록한다. |
| T6 | 크론 UI 리서치 | §3. |
| T7 | 서머리와 inbox 사이에 프로바이더 그룹별 가용량 + 다음 공급 | `#capacity` 섹션. `GET /api/dashboard/capacity` → `buildCapacityView`. llmux 조회 30초 캐시·single-flight, 실패는 고정 사유(`llmux unreachable` · `llmux admin credential required` · `llmux error (HTTP n)`)의 `available:false`, 500 없음. llmux를 쓰지 않는 배포(`ccp`)는 섹션 숨김. |
| T8 | 타임라인 UI 리서치 | §3. |
| T9 | 소진·부족 시 다음 공급 시각을 한눈에 | 그룹 상태 `empty`(가용 계정 0) · `low`(20% 미만) · `ok` · `unknown`. empty = `다음 복귀 <계정> · 2h 14m 후 (16:03) · 5h 창`을 앞세우고 지금→복귀 구간 빨간 음영, low = 다음 공급(복귀·리필 중 이른 것) + 호박색 음영. `nextRefill`(쓸 수 있는 계정의 창 리셋)과 `nextReturn`(차단 계정 복귀)은 따로 계산한다. 카운트다운은 분 단위 버림(3h59m은 `3h 59m`). |
| T10 | 구독 티어별 색 | llmux는 플랜을 주지 않는다(내부 tier = "max"뿐). 우선순위: `SOMA_LLMUX_ACCOUNT_TIERS`(`group:name=tier`) → llmux가 정확한 문자열(`default_claude_max_20x` 등)을 줄 때 그것 → 기본값(codex `ai1`·`ai2` = Pro $200, `ai5`·`ai6` = Pro $500) → 미지정. bare `max`로 추측하지 않는다. 색 = 프로바이더 안의 상위/하위(Okabe-Ito 주황 #E69F00 / 파랑 #0072B2), 미지정 = 회색 테두리, 마커에 티어 문자(`x20` · `$500`) 병기. |

## 2. 숫자의 정직성 (trinity 범위 합의 D5/D6)

- llmux `/llmux/status`는 창별 **사용률(0..1)과 리셋 시각**만 준다. 화면의 모든 수는 잔여율 %이고 "토큰량"이라 부르지 않는다.
- 계정 가용 = 묶이는 창(5h·7d) 중 작은 잔여. 모델별 주간 창(Fable 등)은 그 모델만 묶으므로 마커로만 보인다.
- 그룹 % = 측정된 계정의 **단순 평균**. 플랜 가격은 토큰 비율이 아니므로 티어는 색·문자일 뿐 가중치가 아니다.
- 리셋이 지난 창(오래된 스냅샷)과 측정값이 없는 계정은 **미확인** — 평균에서 빼고 `미확인 n`으로 센다.
- 차단 계정의 복귀 = 걸린 차단이 모두 풀리는 시각(소진 창 리셋들과 쿨다운 중 가장 늦은 것). 스케줄러 한도 차단은 가장 찬 창의 리셋. 인증 실패는 복귀 시각을 만들지 않는다(`복귀 미정`).
- 2분 이하의 쿨다운(llmux가 버스트 뒤 물러서는 `cooldown 6s` 류)은 공급 문제가 아니라 스로틀이다. 계정을 0으로 만들지 않고 복귀 마커도 만들지 않는다(`TRANSIENT_COOLDOWN_SECS`).
- llmux 계정 이름은 실제로 `group:local@domain`이다(`claude:ai7@…`). 타임라인 라벨은 `local`(`ai7`)이고, 같은 그룹에 `local`이 겹치면 도메인을 붙인다. 티어 키는 전체 이름·`group:local`·`local` 어느 형태로 써도 맞는다.

## 3. 리서치 → 결정 [REF]

크론 레인: Airflow DAG 목록·Dagster Automation(잡 1행 = 스케줄·다음 실행·최근 실행 막대), Uptime Kuma·Statuspage(최근 N회 막대 +
막대별 툴팁, 현재 상태는 막대와 별도), Cronitor·Healthchecks(실패와 누락을 다른 기호로), Airflow·GitHub Actions(수동/예약 트리거
표시), GitHub 워크플로·Temporal Schedules(잡 선택 → 실행 목록, 서랍이 보드를 가리지 않음). 색만으로 구분하지 않는다(OneUptime PR #4712).

타임라인: Claude 사용량 화면("Resets in 2h 15m")·Codex("% left · Resets in")·CodexBar(그룹 % + 다음 리셋 카운트다운),
Correll et al. CHI 2020(비선형 축은 경계 기호만으로 오독을 막지 못한다 → 모든 마커 툴팁에 실제 시각, 구간별 음영과 표시된 경계),
TimeSets·UW IDL 라벨 배치(가장 낮은 빈 줄, 안 들어가면 `+N`, 가장 이른 마커는 절대 숨기지 않음), Okabe-Ito(색각 이상 안전 2색),
게임 쿨다운 UI(숫자 + 스윕, 사용 불가 흐리게), 카운트다운 접근성(`role="timer"`, 매 틱 낭독 없음, 숨은 탭에서는 갱신 정지).

## 4. 범위 밖 (기록)

- 형제 인스턴스의 크론 잡·실행 기록은 읽지 않는다. 형제의 크론 카드는 보드 병합으로 들어와 `다른 인스턴스` 타일로 묶인다(스케줄 없음).
- 이 변경 전에 만들어진 크론 세션에는 `cronJob`이 없다(일반 칸에 남고, 다음 실행부터 레인으로 간다).
- Slack 스레드 헤더 제목은 같은 `title`을 쓰므로 잡 이름 → 실제 이름으로 함께 바뀐다. Slack 쪽 CRON 뱃지는 없다.
- Claude 계정의 x5/x20 매핑은 운영자가 `SOMA_LLMUX_ACCOUNT_TIERS`로 지정해야 색이 붙는다(llmux가 플랜을 주지 않음).

## 5. 검증 [TEST]

- `packages/slack/src/pipeline/__tests__/cron-origin.test.ts` · `src/slack/pipeline/__tests__/session-initializer-cron-origin.test.ts` — T1
- `src/__tests__/cron-session-title.test.ts` · `src/__tests__/cron-origin-event.test.ts` — T1/T2/T5 (영속, 새 스레드 sessionKey)
- `src/auth/__tests__/llmux-tiers.test.ts` · `src/conversation/__tests__/capacity-view.test.ts` — T7/T9/T10
- `src/conversation/__tests__/dashboard-cron-capacity{,-client}.test.ts` — 서버 라우트 + 클라이언트(뱃지·레인·서랍·축·마커·배치)
- `scripts/screenshot-cron-capacity.ts` — 실제 페이지 26개 검사(1280/390 × 라이트/다크, 배치 순서, 가로 스크롤 0, 서랍, Esc)
