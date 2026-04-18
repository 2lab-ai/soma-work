# Trace: `/usage card`

> Phase-2 artifact per STV. Each scenario = one work unit for `stv:do-work` / `local:zwork`.

Spec: `docs/usage-card/spec.md`

---

## Implementation Status

| #  | Scenario                                                   | Size   | Depends | Status | RED test                                       |
| -- | ---------------------------------------------------------- | ------ | ------- | ------ | ---------------------------------------------- |
| 1  | Subcommand parser: `card` subcommand                       | tiny   | -       | Ready  | `usage-handler.test.ts` (subcommand routing)   |
| 2  | `aggregateUsageCard()` on ReportAggregator                 | medium | 1       | Ready  | `report-aggregator.test.ts`                    |
| 3  | `UsageCardStats` + `{empty:true}` return type              | tiny   | 2       | Ready  | (part of #2)                                   |
| 4  | Fun-fact table + selector                                  | tiny   | -       | Ready  | `fun-facts.test.ts`                            |
| 5  | ECharts buildOption helper                                 | medium | 3,4     | Ready  | `renderer.test.ts` (buildOption value tests)   |
| 6  | SVG→PNG via resvg + Noto Sans KR fonts                     | small  | 5       | Ready  | `renderer.test.ts` (PNG buffer smoke)          |
| 7  | 5 `SafeOperationalError` subclasses                        | tiny   | -       | Ready  | `errors.test.ts`                               |
| 8  | DI seam on `UsageHandler`                                  | small  | -       | Ready  | `usage-handler.test.ts`                        |
| 9  | `handleCard(parsed, ctx)` — happy path                     | medium | 1,2,5,6,8 | Ready | `usage-handler.test.ts` (happy)                |
| 10 | Slack `files.uploadV2` + Block Kit image post              | small  | 9       | Ready  | `usage-handler.test.ts` (mocked WebClient)     |
| 11 | Zero-activity short-circuit                                | tiny   | 2,9     | Ready  | `empty.test.ts`                                |
| 12 | Error fallback path (5 whitelisted errors → text)          | small  | 7,9     | Ready  | `usage-handler.test.ts` (error fallback)       |
| 13 | deploy.yml: remove node_modules bundling + per-target ci   | small  | -       | Ready  | Staging smoke on both archs                    |
| 14 | Font assets bundled + LICENSE                              | tiny   | -       | Ready  | Visual parity                                  |
| 15 | Register help text update                                  | tiny   | 1,9     | Ready  | manual                                         |

Total: 15 scenarios. Most are tiny/small. Medium: 2, 5, 9.

---

## Vertical Trace per Scenario

### Scenario 1 — Subcommand parser

**Entry**: `src/slack/commands/usage-handler.ts::UsageHandler.handle(parsed, ctx)`
**Edit**: subcommand router. If `parsed.args[0] === 'card'` → `handleCard`, else fallthrough existing path.
**Contract**: bare `/usage` / `today` / `7d` / `30d` 불변.
**RED**: `handle({args:['card']}, ctx)` should invoke injected `cardHandlerSpy`.

### Scenario 2 — `aggregateUsageCard`

**Entry**: `src/metrics/report-aggregator.ts::ReportAggregator.aggregateUsageCard(opts)`
**Input**: `{startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', targetUserId, hourly=true, sessions=true, topN=10}` (Asia/Seoul)
**Output**: `UsageCardStats | {empty: true}`
**Internals**:
- 30d window: iterate event-store files `metrics-events-${dateStr}.jsonl`
- filter `eventType==='token_usage'`
- accumulate per-day totals, per-hour totals, per-model breakdown, per-session (group by sessionKey)
- compute rankings (global): sort users by totalTokens desc, slice topN
- if no events in window → return `{empty: true}`
**RED**:
- fixture with 0 events in range → `{empty:true}`
- fixture with synthetic 30d → return shape asserted (totalsByWindow, heatmap[42], hourly[24], rankings, sessions.tokenTop3, sessions.spanTop3)

### Scenario 3 — `UsageCardStats` type

**Location**: `src/metrics/usage-render/types.ts`
**Fields**: see #9 render contract. Export type union `UsageCardResult = UsageCardStats | EmptyStats`.
**RED**: TS compile check only (covered by #2).

### Scenario 4 — Fun-fact table

**Location**: `src/metrics/usage-render/fun-facts.ts`
**Content**: static array `[{name, tokens, emoji?}]` (화씨 451, 해리포터 1권, 반지의 제왕 3부, 백과사전 등)
**Function**: `pickFunFact(totalTokens): string` — largest entry whose tokens ≤ totalTokens → "~12x 해리포터 1권 분량" 포맷
**RED**: 0 tokens → "아직 첫 문단 분량"; 1M → 특정 책; 1B → 특정 대형 책.

### Scenario 5 — ECharts buildOption

**Location**: `src/metrics/usage-render/buildOption.ts`
**Input**: `UsageCardStats`
**Output**: ECharts `EChartsOption` with multiple `grid`s: title, KPI strip, heatmap, hourly bar, rankings list, sessions list, fun-fact footer.
**RED**: 검증 대상은 option **객체 값** (title.text, series length, grid count, heatmap data length = 42, visualMap pieces, colors from palette `#ebedf0 #9be9a8 #40c463 #30a14e #216e39`). SVG DOM grep 금지.

### Scenario 6 — SVG→PNG renderer

**Location**: `src/metrics/usage-render/renderer.ts`
**API**: `renderUsageCard(stats: UsageCardStats): Promise<Buffer>`
**Flow**:
1. load TTF fonts lazily (cached module-level Promise)
2. `echarts.init(null, null, { renderer:'svg', ssr:true, width:1600, height:2200 })`
3. setOption(buildOption(stats))
4. `svg = chart.renderToSVGString()`
5. `new Resvg(svg, { fitTo:{mode:'original'}, font:{ fontFiles:[...ttfs], defaultFontFamily:'Noto Sans KR' }})`
6. `resvg.render().asPng()`
**Errors**: font load → `FontLoadError`; step 2-4 → `EchartsInitError`; step 5-6 → `ResvgNativeError`.
**RED**: happy path → returns Buffer with PNG magic bytes `89 50 4E 47`. Mock font missing → `FontLoadError`.

### Scenario 7 — Error subclasses

**Location**: `src/metrics/usage-render/errors.ts`
**Content**: `class SafeOperationalError extends Error` (base) + 5 subclasses (`FontLoadError`, `EchartsInitError`, `ResvgNativeError`, `SlackUploadError`, `SlackPostError`). `isSafeOperational(err): err is SafeOperationalError`.
**RED**: instanceof checks; `isSafeOperational` type narrowing.

### Scenario 8 — DI seam

**Edit**: `UsageHandler` constructor signature — optional second arg `{aggregator?, renderer?, slackApi?, clock?}`. Defaults self-constructed. All existing callers unchanged.
**RED**: `new UsageHandler(deps, { aggregator: fake })` — handler uses `fake`.

### Scenario 9 — handleCard happy path

**Entry**: `src/slack/commands/usage-handler.ts::UsageHandler.handleCard(parsed, ctx)`
**Flow**:
1. privacy gate (`parsed.userId !== user` reject)
2. compute `{startDate, endDate}` from `clock()` in Asia/Seoul (30d window)
3. `stats = await aggregator.aggregateUsageCard({...})`
4. if `stats.empty` → ephemeral text + return
5. `png = await renderer.renderUsageCard(stats)`
6. `fileId = await slackApi.filesUploadV2({...png})`
7. `await slackApi.postMessage({ blocks:[{ type:'image', slack_file:{id:fileId}, alt_text:... }], channel })`
8. logger.info metrics (renderTime, pngBytes)
**RED**: happy E2E with DI mocks → assert order of calls + payload shape.

### Scenario 10 — Slack upload + post

**Internals** (covered in #9 but focused test):
- uses `this.slack.filesUploadV2({filename, file: png, channels: undefined, request_file_info: false})` → returns file id
- then `chat.postMessage({channel, blocks})`
- error from uploadV2 → `SlackUploadError`; from postMessage → `SlackPostError`
**RED**: mock WebClient throwing in each step → correct subclass emitted.

### Scenario 11 — Zero-activity short-circuit

**RED**: fixture with 0 events → `handleCard` posts ephemeral text, never calls renderer/slackApi upload. Assert renderer `called == 0`.

### Scenario 12 — Error fallback

**RED**: renderer throws each of 5 subclasses in turn → handler logs + sends ephemeral text "카드 생성 실패, 잠시 후 다시 시도해 주세요." + DM 알림. Non-subclass error (e.g. `RangeError`) → re-throw (handler does NOT swallow).

### Scenario 13 — deploy.yml

**Edit**: `.github/workflows/deploy.yml`
- `Prepare` job: drop `node_modules` from rsync payload, keep `package.json` + `package-lock.json`
- `Deploy` matrix job: on target, `npm ci --omit=dev` + `node -e "require('@resvg/resvg-js')"` smoke step
- Must be pushed via gh CLI (MCP push_files cannot modify `.github/workflows/`)
**RED**: n/a — verified by successful deploy staging run on both targets.

### Scenario 14 — Font assets

**New**: `src/metrics/usage-render/assets/NotoSansKR-Regular.ttf`, `NotoSansKR-Bold.ttf`, `LICENSE` (SIL OFL 1.1 text)
**Build**: `package.json` build script 에 `cp -r src/metrics/usage-render/assets dist/metrics/usage-render/` 추가
**RED**: test 가 `existsSync(path)` 확인.

### Scenario 15 — Register help text

**Edit**: `src/slack/commands/register.ts` (or wherever `/usage` help is registered) — add `card` to usage hint.

---

## Suggested Ordering (for zwork)

```
[1,3,4,7,14]   (standalone tiny pieces, parallelizable)
  ↓
[2]            (data layer; blocks many)
  ↓
[5,6,8]        (render + DI; parallelizable once 2-4 done)
  ↓
[9,10]         (handler wiring)
  ↓
[11,12,15]     (polish)
  ↓
[13]           (deploy — last, gh CLI push)
```
