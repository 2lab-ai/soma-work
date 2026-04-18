# Spec: `/usage card` v2 — Dark-theme + Period Carousel

**Feature**: `usage-card-dark`
**Owner**: @icedac (주군)
**Status**: Draft rev-2 (post-review; awaiting final plan approval)
**Size**: large (~150+ lines across ~10 files) — extends v1 (`docs/usage-card/spec.md`)
**Supersedes**: v1 render path (keeps v1 DI seam, aggregator contract; extends only)
**Reviewers**: local:reviewer (Linus) SIMPLIFY + local:oracle 88/100 REQUEST_CHANGES — P0s resolved inline (see §13)

---

## 1. Why

v1(`/usage card`, PR #561)은 단일 30일 PNG 한 장. 주군 실사용 피드백:

> "card 잘 안보여 검은배경으로 눈에 잘띄게 해줘 지금 보다 더 다양한 내용 여러 페이지로줘 /
>  1. 지난 24시간 내용 / 2. 지난 7일 내용 / 3. 지난 30일 내용 / 4. 지난 1년 내용 / 이미지 참조"

두 가지 요구:

1. **가독성**: 흰 배경 → 어두운 배경 + terracotta accent (Claude Code `/stats` 참조)
2. **맥락 전환**: 한 시점 30일만이 아니라 24h / 7d / 30d / 전체(All time) 4기간을 _한 카드_ 안에서 **버튼으로 전환**

Goal:

- 개인이 한 메시지 안에서 **시간 해상도 4단계**로 자기 패턴 인지(시간대 vs 요일 vs 월)
- `/stats` 스타일 **다크 + terracotta** 로 채널 내 시각적 인지도 확보
- v1 스펙의 _집계·fallback·font·DI_ 기반 그대로 재사용 (최소 surgical change)

Non-Goal:

- 타인 카드 열람 (v1 privacy gate 유지)
- Models 탭 렌더 (v2에 defer — Overview만 v1 범위)
- 실시간 streaming, 월별 누적 이전 기록, 외부 export

---

## 2. User Story

> As a soma-work Slack user,
> When I run `/usage card`, I see a dark-theme PNG carousel posted publicly with 4 period tabs
> (`24h · 7d · 30d · All time`). The initial view is **30d**. Clicking a tab replaces the image
> in-place (no new message) and highlights the selected tab. Each page shows heatmap/hourly +
> metric grid (favorite model, total tokens, sessions, active days, most active day, longest
> session, longest streak, current streak) + one fun-fact line.

---

## 3. Command Surface

| Command             | Behavior                                                        | Change?   |
| ------------------- | --------------------------------------------------------------- | --------- |
| `/usage`            | 기존 bare text                                                   | **없음**  |
| `/usage today`      | 오늘 flat text + 랭킹                                             | **없음**  |
| `/usage 7d`         | 7일 flat text                                                    | **없음**  |
| `/usage 30d`        | 30일 flat text                                                   | **없음**  |
| `/usage card`       | v1 호환 — 초기 **30d** 다크 카드 posted + 3개 전환 버튼             | **변경** |
| `usage_card_tab`    | Block Kit action — 탭 클릭 시 `client.chat.update` 으로 이미지 교체 | **NEW**  |

Env flag (rollback path):

- `USAGE_CARD_V2=false` (or unset) → v1 단일 30d PNG 유지 (이전 경로 로딩, v2 코드 inert)
- `USAGE_CARD_V2=true` → carousel 경로 활성화 (staging 먼저 → main → prod 단계적)

Rule: `card` 에는 파라미터 없음 (v1과 동일). 캐러셀 탭 선택은 Slack action 으로만.

---

## 4. Architecture

```
Slack (/usage card)
    ↓
UsageHandler.handleCard(parsed, ctx)
    ├─ DI seam: {aggregator, renderer, slackApi, clock, tabCache}
    ├─ step 1: aggregateCarousel({targetUserId, now}) → CarouselStats (4 periods in one call)
    ├─ step 2: renderCarousel(CarouselStats, selectedTab='30d') → {pngs: Record<tabId, Buffer>}
    ├─ step 3: filesUploadV2 × 4 (parallel, channel_id=undefined) → Record<tabId, slackFileId>
    │         ├─ NO channels passed → Slack does NOT auto-post file messages (orphan guard)
    │         └─ slack_file.id 가 즉시 블록에서 사용 가능할 때까지 500ms 짧은 재시도 내장 (cold-cache race guard)
    └─ step 4: chat.postMessage({channel, blocks: buildCarouselBlocks(fileIds, '30d')})
         ↓
         messageTs = chatPostMessage.ts  // await 된 후 확정
         tabCache.set(messageTs, {fileIds, userId, expiresAt})  // TTL 24h in-memory

Slack button click (action_id='usage_card_tab', value='24h'|'7d'|'30d'|'all')
    ↓
ActionHandlers.onUsageCardTab({ack, body, client})
    ├─ ack()  // < 3s
    ├─ messageTs = body.container.message_ts  // Bolt 제공; block_id embed 불필요
    ├─ channel  = body.container.channel_id
    ├─ entry    = tabCache.get(messageTs, now)
    ├─ miss     → respond({response_type:'ephemeral', replace_original:false, text:'세션 만료'})
    ├─ gate: body.user.id === entry.userId
    │        fail → respond({response_type:'ephemeral', replace_original:false, text:'본인만 가능'})
    ├─ blocks = buildCarouselBlocks(entry.fileIds, selectedTab, entry.userId)
    └─ await client.chat.update({channel, ts: messageTs, blocks})  // bot token — 30min/5-call 제한 없음
```

### 4.1 Data flow (new)

- **CarouselStats** ≝ `Record<'24h'|'7d'|'30d'|'all', UsageCardStats | {empty: true}>`
- 한 번의 aggregator 호출에서 4개 윈도우 동시 계산 (파일 스캔 1회 → 분기)
- v1 `aggregateUsageCard` 는 `{startDate, endDate}` 기반 — 4회 호출해도 되지만 **동일 이벤트 재스캔 비용 4배**. v2 에서는 `aggregateCarousel({targetUserId, now})` 가 단일 루프에서 4개 윈도우 동시 누적.
- 각 period 는 독립 UsageCardStats (empty 가능)

**Active days / Longest streak / Current streak 계산 (신규)**

- `activeDays`: period 내 **distinct KST YYYY-MM-DD** 개수
- `longestStreak`: 활동일 연속 최대 런 (같은 period 내)
- `currentStreak`: `endDate` 부터 역방향으로 거슬러 올라가며 비활동일 만날 때까지 run — 단, **오늘 활동이 없으면 0** (의도된 사양: 클로드 코드 `/stats` 동작과 일치. 한국 시간 00:03에 카드 열면 "current streak: 0" 표시되는 것이 정상 — "streak 끊지 마" 행동 유도 목적)
- Sessions 의 `Longest session`: 기존 sessions[0].durationMs 를 `Xd Yh Zm` 포맷으로 표기

### 4.2 Period 정의

| Tab       | startDate (KST)               | endDate (KST) | Heatmap 축                       | Hourly? |
| --------- | ----------------------------- | ------------- | -------------------------------- | ------- |
| `24h`     | now - 24h                     | now           | **없음** (hourly 24-bin 전용)       | ✅       |
| `7d`      | endDate - 6 day               | today         | 7 days × 24 hours (세로 day)      | ✅       |
| `30d`     | endDate - 29 day              | today         | 7 cols × 5 rows (week matrix)    | —       |
| `all`     | earliest event day (lazy)     | today         | **최대 12 months × 7 weekdays**    | —       |

- `all` 탭은 이벤트 보유 범위 내에서만 표시. 현재 retention 24일치 → 1개월치 matrix. 시간 지남에 따라 자연스럽게 12월치 채움.
- CleanShot 참조의 12개월×요일 heatmap 은 `all` 탭 한정.

### 4.3 Layout (per page PNG 1600×2200)

```
┌─────────────────────────────────────────────────┐
│ [📊 /usage card]              Zhuge · 2026-04-18 │  ← header (terracotta title + meta right)
├─────────────────────────────────────────────────┤
│ Overview | Models(v2)     ← 서브탭 (Models grey) │
├─────────────────────────────────────────────────┤
│ [24h]  [7d]  [30d●]  [All time]                  │  ← period tabs (Block Kit buttons — PNG에도 상태 시각화)
├─────────────────────────────────────────────────┤
│                                                 │
│     Heatmap / Hourly bar (period 에 따라)        │  ← main chart (height ≈ 900)
│                                                 │
├─────────────────────────────────────────────────┤
│ Favorite model: qwen3.5:32b    Total tokens: 4.5m │
│ Sessions: 164                  Active days: 18    │
│ Most active day: Apr 12        Longest session:   │  ← metric grid 2 cols × 4 rows
│                                15d 8h 51m        │
│ Longest streak: 7 days         Current streak: 3  │
├─────────────────────────────────────────────────┤
│ 💡 You've used ~75× more tokens than Fahrenheit 451 │  ← fun fact line
├─────────────────────────────────────────────────┤
│ Ranking (global) — #12 of 37 · ▓▓▓░              │  ← my rank row + micro bar
└─────────────────────────────────────────────────┘
```

### 4.4 Dark palette

| Token             | Hex        | Usage                           |
| ----------------- | ---------- | ------------------------------- |
| `bg`              | `#1A1A1A`  | canvas                          |
| `surface`         | `#242424`  | tab/card panel                  |
| `accent`          | `#CD7F5C`  | active tab, heatmap max, title  |
| `accentSoft`      | `#8F5B45`  | heatmap mid                     |
| `accentBg`        | `#3A231C`  | heatmap low                     |
| `text`            | `#F0E8E0`  | primary                         |
| `textMuted`       | `#8F8880`  | labels, footer                  |
| `grid`            | `#2E2E2E`  | chart gridlines                 |

Heatmap 5-step scale (**luminance-monotonic**, Y = 0.299R + 0.587G + 0.114B):

| step | hex        | luminance |
| ---- | ---------- | --------- |
| 0    | `#1F1F1F`  | 31.0      |
| 1    | `#3A231C`  | 41.1      |
| 2    | `#6B3F30`  | 72.9      |
| 3    | `#A06048`  | 109.7     |
| 4    | `#CD7F5C`  | 143.4     |

Luminance는 엄격히 단조증가. v1 draft 의 `#2A2A2A` (L=42.0)는 step 1(`#3A231C`, L=41.1)보다 **밝아서** monotonicity 깨짐 → `#1F1F1F` 로 확정. `dark-palette.test.ts` 가 이 규칙을 enforce.

### 4.5 Block Kit contract (carousel)

```jsonc
// initial post
[
  {type:'header', text:{type:'plain_text', text:'📊 Usage Card — @Zhuge'}},
  {type:'image', slack_file:{id:'F_30d'}, alt_text:'Usage card · 30d'},
  {type:'actions', block_id:'usage_card_tabs', elements:[
    {type:'button', action_id:'usage_card_tab', value:'24h',  text:{type:'plain_text', text:'24h'}},
    {type:'button', action_id:'usage_card_tab', value:'7d',   text:{type:'plain_text', text:'7d'}},
    {type:'button', action_id:'usage_card_tab', value:'30d',  text:{type:'plain_text', text:'30d'}, style:'primary'},
    {type:'button', action_id:'usage_card_tab', value:'all',  text:{type:'plain_text', text:'All time'}},
  ]},
]
```

- `value` ∈ `{24h, 7d, 30d, all}`
- 선택된 탭은 `style:'primary'` — 나머지 기본
- `block_id` 는 **정적 상수** (`'usage_card_tabs'`). messageTs 를 embed 하지 않음 — Slack 은 action 이벤트에 `body.container.message_ts` 를 이미 제공하므로 불필요. (v1 draft 의 `usage_card_tabs_<messageTs>` 는 chicken-and-egg: messageTs 는 `postMessage` 반환 후에야 알려짐.)
- Non-owner 클릭 → `respond({response_type:'ephemeral', replace_original:false, text:'본인 카드만 조작할 수 있습니다.'})`
- Owner 클릭 → `await client.chat.update({channel, ts: messageTs, blocks})` (bot token — `response_url` 30min/5-call 제한 회피)

### 4.6 tabCache

- 구현: `Map<string, {fileIds: Record<tabId,string>, userId: string, expiresAt: number}>` in-process
- TTL: 24h (오래된 엔트리 LRU purge on-insert, cap 500)
- **Deployment assumption (PINNED)**: soma-work 프로덕션은 **단일 인스턴스** 배포 (`/opt/soma-work/dev/` 단일 systemd unit, CCT credential pairs로 수평 스케일 대체). Load-balanced multi-instance 인 경우 tabCache miss 100%. 멀티인스턴스 전환 시점에 Redis-backed TabCache 로 교체 (별도 이슈).
- 인스턴스 재시작 시 유실 → 클릭 미동작; fallback: 만료 메시지 respond(ephemeral "세션이 만료되었습니다. `/usage card` 다시 실행해 주세요.")
- 영속 저장 필요 없음 (재실행이 싸다, session cache 가 단순)
- LRU cap 500 근거: 500 유저 × 1 카드/일 = 활성 워크스페이스 하루치. 그 이상 보존 가치 낮음.

---

## 5. Component surface

### 5.1 New

- `src/metrics/usage-render/dark-palette.ts` — 색상/폰트 토큰
- `src/metrics/usage-render/buildCarouselOption.ts` — 탭별 ECharts option builder
- `src/metrics/usage-render/carousel-renderer.ts` — `renderCarousel(stats, clock): {tab24h, tab7d, tab30d, tabAll}` (4 PNG)
- `src/metrics/report-aggregator.ts` — 신규 `aggregateCarousel({targetUserId, now})` (기존 `aggregateUsageCard` 유지)
- `src/slack/commands/usage-carousel-cache.ts` — `TabCache` class + default instance
- `src/slack/action-handlers.ts` — `usage_card_tab` handler 등록 (기존 파일에 추가)

### 5.2 Modified

- `src/slack/commands/usage-handler.ts` — `handleCard` 를 carousel 경로로 확장 (DI 에 `tabCache` 추가, v1 rendering path 제거)
- `src/slack/z/topics/usage-topic.ts` — help 문구 "최근 30일" → "4기간 캐러셀"
- `package.json` — 새 의존 없음 (echarts/resvg 재사용)

### 5.3 Removed

- v1 단일 렌더 경로 (`handleCard` 의 30d-only branch) — carousel 로 완전 교체

---

## 6. Error / empty-state

- v1 의 5-whitelist `SafeOperationalError` subclass catch → 텍스트 폴백 **그대로 계승**
  (`FontLoadError`, `EchartsInitError`, `ResvgNativeError`, `SlackUploadError`, `SlackPostError`)
- **Partial empty**: 4기간 중 일부만 비어있으면 — 해당 탭은 `{empty: true}` 스텁 PNG("활동 없음" 중앙 터미널 스타일) 로 렌더. 전부 비었을 때만 v1 식 텍스트 ephemeral 폴백.
- **TabCache miss**: 버튼 클릭 시 캐시 없음 → ephemeral "세션 만료. `/usage card` 다시 실행해 주세요.", replace_original=false
- **Non-owner click**: ephemeral "본인 카드만 조작할 수 있습니다.", replace_original=false

---

## 7. Test surface (vitest `*.test.ts` — SVG DOM grep 금지)

| File                                                 | RED → GREEN assertion                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `report-aggregator.test.ts` (extend)                 | `aggregateCarousel({now})` returns 4 UsageCardStats, active days/streaks exact         |
| `buildCarouselOption.test.ts`                        | 탭별 series/xAxis/yAxis 값 정합 — heatmap(all) vs hourly(24h) vs week-matrix(30d)         |
| `dark-palette.test.ts`                               | 8 token hex pinned, heatmap 5-step scale monotonic                                      |
| `carousel-renderer.test.ts`                          | `renderCarousel(fixture)` → 4 non-empty Buffers, font loaded, selected tab state baked |
| `usage-carousel-cache.test.ts`                       | TTL eviction, LRU cap, lookup by messageTs, userId gate                                 |
| `usage-handler.test.ts` (extend)                     | `handleCard` → 4 uploads + 1 post, Block Kit 구조, tabCache populated                     |
| `action-handlers.test.ts` (extend)                   | `usage_card_tab` — 4 values valid, non-owner ephemeral, miss-cache ephemeral             |
| `streaks.test.ts`                                    | longest/current streak edge cases (empty, gap, today-inactive)                          |
| `empty.test.ts` (extend)                             | partial empty → stub PNG, all empty → text fallback                                    |

- 스냅샷 테스트 금지 (PNG byte 비교 불안정)
- Block Kit JSON은 구조 + action_id + value 필드 단위 assertion

---

## 8. Acceptance

1. `/usage card` → 다크 카드 30d 퍼블릭 포스트, 4 탭 버튼 노출
2. 24h / 7d / all 탭 클릭 → in-place 이미지 교체, selected 탭 primary highlight
3. 비-소유자 클릭 → ephemeral 거절
4. bare `/usage`, `/usage 30d`, `/usage 7d`, `/usage today` 동작 불변 (regression 없음)
5. `all` 탭: 활동 없는 영역 blank, 있는 영역 terracotta gradient
6. Partial empty 시 해당 탭만 "활동 없음" stub, 다른 탭 정상
7. 모든 whitelist error → 기존 텍스트 폴백
8. `npm run test` 전체 통과
9. `npm run build` 통과 + resvg smoke OK
10. Staging 에서 실제 `/usage card` 결과 PNG 4장 PR 본문 첨부 (증거)

---

## 9. Non-negotiables

- v1 text command 모두 불변 (회귀 0)
- vitest `*.test.ts` only (spec 아님)
- 5 whitelist subclass catch → fallback; 그 외 re-throw (silent failure 금지)
- Noto Sans KR TTF 그대로 재사용 (v1 번들)
- DI seam 유지 (fake clock/aggregator/slackApi test 용)
- 모든 커밋에 `Co-Authored-By: Zhuge <z@2lab.ai>`
- git identity `-c user.name="Zhuge" -c user.email="z@2lab.ai" -c commit.gpgsign=false` 인라인만 (global config 금지)
- `.github/workflows/` 변경 시 gh CLI (MCP push 금지)
- Deploy workflow 변경 없음 (v1 번들 재사용)

---

## 10. Out of scope (v2 defer)

- **Models 탭 렌더** — Block Kit 서브탭 스켈레톤만 grey, click disabled
- **보존기간 365일 확장** — JSONL rotate 정책은 별도 이슈
- **공유/copy 링크** — Slack 네이티브 공유로 충분
- **타인 카드 열람** — privacy gate 고정

---

## 11. Open decisions (resolved via UIAskUserQuestion 2026-04-18)

| 결정                              | 선택                                       |
| --------------------------------- | ------------------------------------------ |
| 4페이지 전환 메커니즘              | `carousel_chat_update` (Block Kit button)   |
| 1년 탭 처리                       | `all_time_label` (`전체` 레이블)             |
| 콘텐츠 풍부화 범위                | `full_ref_overview` (Overview 풀 + Models v2) |

---

## 12. Rollout

- `USAGE_CARD_V2` env flag: staging 먼저 true, main merge 후 prod true
- 단일 PR (`feat/usage-card-dark`) — branch 제목 확정 후 작성
- staging deploy 후 주군 실사 `/usage card` 캡쳐 4장 (24h/7d/30d/all 각 1장)
- 메인 머지 → 자동 deploy → env flag 단계적 활성화 → live 검증 → close
- 회귀 발생 시 `USAGE_CARD_V2=false` 한 줄 revert, 코드 롤백 불필요

---

## 13. Review resolution log (2026-04-18)

Pre-approval 리뷰: `local:reviewer` (Linus) + `local:oracle` 병렬. 두 결과 통합:

### P0 (blocking) — 모두 spec/trace 에서 해결

| # | 출처         | 이슈                                                              | 해결                                                                 |
| - | ------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1 | Linus P0/#1 + Oracle P0/#3 | `respond({replace_original})` 는 response_url 30min/5-call 제한      | `client.chat.update({channel, ts, blocks})` 로 교체 (bot token, 무제한)   |
| 2 | Linus P0/#2  | Multi-instance 시 tabCache miss 100%                                 | §4.6 에 "single-instance deployment" 가정 PIN. Redis 백업은 별도 이슈 |
| 3 | Linus P0/#3  | `block_id: 'usage_card_tabs_<messageTs>'` chicken-and-egg            | `block_id` 정적화. `body.container.message_ts` 직접 사용              |
| 4 | Oracle P0/#1 | `filesUploadV2` 시 `channels` 인자 누수 → 고아 메시지 4개 포스트       | `channel_id: undefined` 명시, upload args 감시 테스트 추가             |
| 5 | Oracle P0/#2 | `slack_file.id` cold-cache race (업로드 직후 블록에서 사용 실패 가능) | 500ms×3 retry 내장; 실패 시 `SlackUploadError` 폴백                   |
| 6 | Oracle P0/#4 | `currentStreak` KST 자정 엣지 케이스                                   | "today-inactive=0" 의도된 사양임을 §4.1 에 명시 (클로드 `/stats` 파리티) |

### P1 — 모두 해결

- **Luminance RED 실패 필연 (Oracle P1)**: `#2A2A2A` (L=42.0) 가 step 1(`#3A231C`, L=41.1) 보다 밝음 → `#1F1F1F` (L=31.0) 로 확정. §4.4 luminance 표로 명문화.
- **Bitwise-identical PNG 출력 (Oracle NIT)**: resvg+zlib 가 타임스탬프 non-deterministic → trace §10 에서 "PNG magic bytes + width/height" 로 완화.
- **Stub PNG 대역폭 낭비 (Linus NIT + Oracle P1)**: 빈 탭은 PNG 대신 context block 텍스트 고려도 했으나, 4-탭 일관성(모든 탭이 이미지) 유지가 사용자 인지 비용 더 낮음. 작은 stub (200KB 이하) 로 제한.

### Pushback (수용하지 않음)

- **Linus "파일 6 → 4 로 줄여라"**: dark-palette.ts + streaks.ts 는 테스트 분리 목적 유지. 총 5 impl 파일 (palette 병합 후) 로 타협. 11 file plan 은 test 파일 포함 수치였음 — 혼선.
- **Linus "aggregateCarousel single-scan 측정 없음"**: 프로파일링은 구현 후에만 유의미. RED 테스트는 `iterateEvents` spy count === 1 로 structural 검증.

### MISSING 처리 (follow-up 티켓)

- Slack file retention (7일 후 slack_file.id 만료) — tabCache TTL 이 24h 이므로 자연 회피
- Concurrency double-click — `ack()` 후 동시 2 update 는 Slack side 에서 tie-break; 영향 경미
- Actions button overflow (5+ 버튼) — 현재 4 버튼, 향후 Models 탭 추가 시 재검토
- Deploy.yml SHA guard — 본 PR 은 workflow 변경 없음
