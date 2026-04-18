# Spec: `/usage card` — Personal Usage Stats PNG

**Feature**: `usage-card`
**Owner**: @icedac (주군)
**Status**: Approved (Codex plan review v5 = 97/100 APPROVE, user signed off 2026-04-18)
**Size**: large (~100+ lines across ~10 files) + native dep + deploy workflow change

---

## 1. Why

기존 `/usage [today|7d|30d]` 는 단일 flat text 덤프 + 랭킹 top-10. 개인이 자신의 활동 패턴(시간대, 요일, 세션 길이, 연속성, 즐겨 쓰는 모델 등)을 한눈에 보기 어렵다. Claude Code 의 `/stats` 가 보여주는 식의 **개인 통계 시각화**가 필요하다.

Goal: 개인이 자기 "지표 카드"를 보고 (1) 자기 사용 패턴을 한눈에 이해, (2) 팀 내 자기 위치(랭킹 + 하이라이트) 를 파악, (3) Fun-fact 로 규모 감각(얼마나 많은 토큰을 썼는지)을 체감.

Non-Goal: 타인 통계 열람(privacy 이슈), 실시간 streaming, 월별 누적 이전 기록, 외부 export.

---

## 2. User Story

> As a soma-work Slack user,
> When I run `/usage card` in any channel,
> I see a PNG card posted publicly with my last 30-day usage stats — heatmap, hourly pattern, 24h/7d/30d totals, global ranking (my row highlighted), top sessions, and a fun-fact line.

---

## 3. Command Surface

| Command              | Behavior                                                                     | Change? |
| -------------------- | ---------------------------------------------------------------------------- | ------- |
| `/usage`             | 기존 기본 (이번 달) flat text                                                 | **없음** |
| `/usage today`       | 오늘 flat text + 랭킹 top-10                                                  | **없음** |
| `/usage 7d`          | 최근 7일 flat text                                                            | **없음** |
| `/usage 30d`         | 최근 30일 flat text                                                           | **없음** |
| `/usage card` (NEW)  | **개인 PNG 카드 public 포스트** (heatmap + rankings + sessions + fun-fact)    | **NEW** |

Rule: `card` subcommand 은 어떤 형태의 파라미터도 받지 않는다 (v1). 본인만 자기 카드를 볼 수 있다 (privacy gate = 기존 `parsed.userId !== user` reject 유지).

---

## 4. Architecture

```
Slack (/usage card)
    ↓
UsageHandler.handleCard(parsed, ctx)    ← DI seam: {aggregator, renderer, slackApi, clock}
    ↓
ReportAggregator.aggregateUsageCard({startDate, endDate, targetUserId, hourly, sessions, topN})
    ↓                                       ↑ reads metrics-events-*.jsonl (KST YYYY-MM-DD)
    UsageCardStats | {empty: true}
    ↓
UsageCardRenderer.render(stats): Buffer   ← ECharts SSR → SVG → @resvg/resvg-js → PNG
    ↓ (fun-facts lookup, fonts loaded lazily)
    PNG Buffer (1600×2200)
    ↓
SlackApi.filesUploadV2 + chat.postMessage(blocks: [image])
```

### 4.1 Data flow

- **Window**: 30일 고정 (startDate/endDate 은 Asia/Seoul YYYY-MM-DD 문자열)
- **Source**: 기존 `EventStore.iterateEvents()` 의 `token_usage` 이벤트만 필터
- **Rankings**: 글로벌 top-N (본인 userId 있으면 하이라이트), top-5 화면 표시, top-10 저장
- **Hourly**: 24-bin 배열 (0..23 KST hour)
- **Heatmap**: 7×6 고정 grid (30 real day + 12 blank padding cells), p95 기반 5단계 색 스케일
- **Sessions**: 토큰 top-3 + 활동기간(first event → last event) top-3

### 4.2 Empty-state short-circuit

`aggregateUsageCard` 가 30일간 `token_usage` 이벤트 0건을 보면 `{empty: true}` 리턴. handler 는 렌더 파이프라인 건너뛰고 ephemeral 텍스트 안내: "최근 30일간 기록된 사용량이 없습니다. `/usage`로 기본 집계를 먼저 확인하세요."

### 4.3 Render pipeline internals

- `echarts` (dep 추가, **non-dev**: SSR 모듈이 runtime 에 필요)
- `echarts.init(null, null, { renderer: 'svg', ssr: true, width: 1600, height: 2200 })`
- `chart.renderToSVGString()` → pure string (no DOM)
- `@resvg/resvg-js` (dep 추가, **non-dev**: platform-specific native binary 필요)
- Noto Sans KR TTF 2종(Regular/Bold) 번들, `resvg` `fontFiles` + ECharts `textStyle.fontFamily = 'Noto Sans KR'`
- Fun-fact 테이블: 정적 JSON, 토큰 총량을 유명 텍스트(Fahrenheit 451, Harry Potter #1, The Lord of the Rings 등) 근사치에 대응시켜 1줄 문구 생성

### 4.4 Error taxonomy

5개 `SafeOperationalError` 서브클래스만 catch → 텍스트 폴백 + DM 알림:

| Class                | When                                                |
| -------------------- | --------------------------------------------------- |
| `FontLoadError`      | TTF 파일 없음 / 읽기 실패                            |
| `EchartsInitError`   | ECharts init or renderToSVGString throw              |
| `ResvgNativeError`   | resvg native binding missing / render throw          |
| `SlackUploadError`   | `files.uploadV2` 실패                                |
| `SlackPostError`     | `chat.postMessage` 실패                              |

그 외 모든 에러는 re-throw (silent failure 금지). handler 의 outer catch 가 5개 sub-class 면 텍스트 fallback, 아니면 logger.error + re-throw.

### 4.5 Deploy

`.github/workflows/deploy.yml` 변경:

1. `node_modules` 번들링 제거 (native binary 는 빌드 머신 != 타깃 머신 문제)
2. 각 타깃에서 `npm ci --omit=dev` 실행 (darwin-arm64 mac-mini-dev, linux-x64 oudwood-dev)
3. smoke: `node -e "require('@resvg/resvg-js')"` 성공해야 배포 성공

### 4.6 DI seam

```ts
// Before
new UsageHandler(deps)

// After
new UsageHandler(deps, {
  aggregator?: ReportAggregator,
  renderer?: UsageCardRenderer,
  slackApi?: SlackApi,
  clock?: () => Date
})
```

기본값 셀프 구성 (backward compatible). 테스트 주입.

---

## 5. Decision Log

| Decision                               | Chosen                        | Alternatives considered                        | Rationale                                                                          |
| -------------------------------------- | ----------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Rendering backend                      | ECharts SVG SSR + resvg       | Satori (JSX), node-canvas, Puppeteer           | No JSX toolchain; native calendar heatmap; no headless chrome                      |
| Image format                           | PNG via resvg                 | SVG (slack 미지원), JPEG                       | Slack `files.uploadV2` + `image` block 호환, 고해상도                              |
| Command surface                        | `/usage card` subcommand      | Flag `/usage --card`, 기본 교체                 | 기존 text user 회귀 방지. 탐지 쉬움                                                 |
| Visibility                             | Public post                   | Ephemeral, DM only                             | 팀 공감/피어 비교 공개. 본인만 본인 카드 낼 수 있어 privacy 유지                     |
| Time window                            | 30 일 고정                    | 7d / 90d 선택                                  | 첫 버전은 단순 / Claude Code `/stats` 기준                                         |
| Rankings scope                         | 글로벌 + 본인 하이라이트       | 본인 절대값만, 친구만                            | Single-tenant 환경. 공개 랭킹이 의미 있음                                           |
| Session "longest" metric               | 토큰 Top-3 + 활동기간 Top-3   | 단일 "longest session"                         | `token_usage` 이벤트 간격만으로 duration 측정 부정확. 두 지표 병기                  |
| Heatmap layout                         | 7×6 고정(30 real + 12 blank)  | 7×5 + 내부 패딩                                 | Codex v4 에서 지적. grid 크기와 데이터 크기 일관성                                  |
| Zero activity                          | `{empty:true}` 단락 + 텍스트  | 빈 카드 렌더                                    | 의미 없는 "0으로 가득한 카드" 방지                                                  |
| Error handling                         | Whitelist 5 sub-class → 폴백  | Wildcard catch                                 | Silent failure 금지 룰                                                              |
| Font                                   | Noto Sans KR SIL OFL 1.1      | 시스템 fallback                                 | 배포 머신 한글 폰트 부재 가능                                                        |
| Deploy native mod                      | `npm ci --omit=dev` per 타깃  | `npm rebuild`                                   | arch mismatch 해결 확실                                                             |
| Tests                                  | vitest `*.test.ts` (spec 아님) | jest                                             | `vitest.config.ts` include = `src/**/*.test.ts`                                    |
| Fixture                                | JSONL under `__fixtures__/`   | Inline                                          | 실제 event-store 파일 포맷과 동일, re-usable                                         |

---

## 6. Acceptance Criteria

1. `/usage card` → 호출자의 30일 통계 PNG 카드가 해당 채널에 public 으로 포스트된다.
2. bare `/usage` / `/usage today` / `/usage 7d` / `/usage 30d` 기존 동작 불변 (회귀 없음).
3. 30일 토큰 사용량이 0 인 유저 → 빈 카드 대신 ephemeral 텍스트 안내.
4. 5개 `SafeOperationalError` catch → 텍스트 폴백 + DM 알림. 그 외 에러 re-throw.
5. `npm run test` 전체 통과 (신규 6개 포함).
6. `npm run build` 통과 (TypeScript strict).
7. darwin-arm64 (mac-mini-dev) + linux-x64 (oudwood-dev) 배포 후 `require('@resvg/resvg-js')` smoke 통과.
8. PR 본문에 staging proof 체크리스트 + 실제 카드 스크린샷 포함.

---

## 7. Out of Scope / Future

- 팀/서브셋 필터 (`/usage card @user` 금지 — privacy)
- 다국어 (v1 한국어 UI)
- 시계열 비교 (전주 대비 등)
- export (`.png` 파일 DM 보내기 등)
- 커스텀 테마/색상

---

## 8. References

- User request thread: 주군 지시 (Slack 원본 스레드)
- Codex plan reviews: v1(60) → v2(73) → v3(81) → v4(91) → v5(97 APPROVE)
- Claude Code `/stats` UI (영감의 원천)
- ECharts SSR docs: https://echarts.apache.org/handbook/en/how-to/cross-platform/server/
- resvg-js: https://github.com/yisibl/resvg-js
- Slack files.uploadV2: https://api.slack.com/methods/files.uploadV2
- Noto Sans KR: https://fonts.google.com/noto/specimen/Noto+Sans+KR (SIL OFL 1.1)
