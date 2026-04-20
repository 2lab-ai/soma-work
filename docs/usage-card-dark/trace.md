# Trace: `/usage card` v2 (dark-theme + carousel)

> STV Phase 2. Each scenario = one work unit for `stv:do-work` / `local:zwork`.
> Follows v1 style (`docs/usage-card/trace.md`) — compact Entry/Flow/Contract/RED blocks, not the generic 7-section HTTP form (this is Slack action + file upload, no HTTP path).

Spec: `docs/usage-card-dark/spec.md`
Issue: [#591](https://github.com/2lab-ai/soma-work/issues/591)
Supersedes v1 render path from: [#557](https://github.com/2lab-ai/soma-work/issues/557) / PR #561 (merged)

---

## Implementation Status

| #  | Scenario                                                             | Size   | Depends     | Status | RED test                                                   |
| -- | -------------------------------------------------------------------- | ------ | ----------- | ------ | ---------------------------------------------------------- |
| 1  | `/usage card` happy path — dark 30d post + 4 tab buttons             | medium | 2,6,7,8,10  | Ready  | `usage-handler.test.ts` (carousel happy)                   |
| 2  | `aggregateCarousel({targetUserId, now})` single-scan → 4 periods     | medium | —           | Ready  | `report-aggregator.test.ts` (carousel 4-period)            |
| 3  | Period layout contract — 24h/7d/30d/all axis shapes                  | small  | 2           | Ready  | `buildCarouselOption.test.ts`                              |
| 4  | `activeDays` = distinct KST YYYY-MM-DD per period                    | small  | 2           | Ready  | `streaks.test.ts`                                          |
| 5  | `longestStreak` = max run of consecutive active days                 | small  | 2           | Ready  | `streaks.test.ts`                                          |
| 6  | `currentStreak` = run to today; today-inactive → 0                   | small  | 2           | Ready  | `streaks.test.ts`                                          |
| 7  | `TabCache` set/get with TTL 24h + LRU cap 500                        | small  | —           | Ready  | `usage-carousel-cache.test.ts`                             |
| 8  | `usage_card_tab` action → `client.chat.update({channel, ts, blocks})`| small  | 1,7         | Ready  | `action-handlers.test.ts` (usage_card_tab happy)           |
| 9  | Non-owner click → ephemeral reject (no replace_original)             | tiny   | 8           | Ready  | `action-handlers.test.ts` (usage_card_tab non-owner)       |
| 10 | `carousel-renderer.renderCarousel(stats,selected)` → 4 PNG Buffers   | medium | 3,14        | Ready  | `carousel-renderer.test.ts`                                |
| 11 | TabCache miss (restart) → ephemeral "session expired"                | tiny   | 7,8         | Ready  | `action-handlers.test.ts` (usage_card_tab miss)            |
| 12 | Partial empty — per-tab stub PNG; all empty → v1 text fallback       | small  | 2,10        | Ready  | `empty.test.ts` (partial+all)                              |
| 13 | 5 whitelist `SafeOperationalError` subclass catch → text fallback    | small  | 1           | Ready  | `usage-handler.test.ts` (carousel error fallback)          |
| 14 | Dark palette 8 hex tokens pinned + heatmap 5-step monotonic scale    | tiny   | —           | Ready  | `dark-palette.test.ts`                                     |
| 15 | Regression — bare `/usage`, `/usage 7d|30d|today` unchanged          | tiny   | 1           | Ready  | `usage-handler.test.ts` (regression matrix)                |

Total: 15 scenarios. Medium: 1, 2, 10. Rest small/tiny. Surgical delta over v1.

---

## Vertical Trace per Scenario

### Scenario 1 — `/usage card` happy path

**Entry**: `src/slack/commands/usage-handler.ts::UsageHandler.handleCard(ctx)`
**Feature flag**: 없음. `/usage card` 는 단일 carousel 경로. (v1 legacy 및 env gate 는 `refactor/usage-card-drop-legacy` 에서 완전 제거 — see Changelog rev-3.)

**Flow**:
1. strict param gate + privacy gate
2. `now = clock()`; compute 4 `{startDate,endDate}` windows (24h / 7d / 30d / all — all starts at earliest event day, lazily from aggregator)
3. `carouselStats = await aggregator.aggregateCarousel({ targetUserId: user, now })` — single scan, 4 `TabResult` per-tab
4. if **all 4** empty → text ephemeral fallback (Scenario 12)
5. `pngMap = await renderer.renderCarousel(carouselStats, '30d')` → `{ '24h': Buffer, '7d': Buffer, '30d': Buffer, 'all': Buffer }`
6. upload 4 PNGs in parallel via `Promise.all([filesUploadV2 × 4])` → `fileIds: Record<tabId, string>`
   - `filesUploadV2` args: `{ filename, file: buffer }` — **no `channels` / `channel_id`** (guard against Slack auto-posting orphan file messages)
   - `request_file_info: false`, `initial_comment: undefined`
   - post-upload retry loop: if first `chat.postMessage` with embedded `slack_file.id` returns `invalid_blocks` referencing unknown file → wait 500ms, retry ≤ 3× (cold-cache race)
7. `messageTs = (await slackApi.postMessage({ channel, blocks: buildCarouselBlocks(fileIds, '30d', user) })).ts`
8. `tabCache.set(messageTs, { fileIds, userId: user, expiresAt: now + 24h })`
9. logger.info `{ renderMs, uploadMs, bytesTotal, userId }`

**Contract**:
- `postMessage` call count = 1; `filesUploadV2` call count = 4
- every `filesUploadV2` invocation's args have **no `channels` / `channel_id`** key set (spy assertion)
- initial `blocks[1].type === 'image' && blocks[1].slack_file.id === fileIds['30d']`
- `blocks[2].type === 'actions'` with `block_id === 'usage_card_tabs'` (static, not messageTs-embedded), 4 buttons, value set = `{24h, 7d, 30d, all}`, 30d button has `style:'primary'`
- tabCache has entry keyed by messageTs with userId === ctx.user

**RED**: `usage-handler.test.ts` describe `handleCard (carousel)` — DI mocks for aggregator (4 non-empty), renderer (4 buffers), slackApi (track calls), clock (fixed ts). Assert call order + payload shape + tabCache populated.

**File touch**:
- Modify: `src/slack/commands/usage-handler.ts` (replace v1 body of `handleCard` — keep gates)
- Modify: `src/slack/commands/usage-handler.test.ts` (rewrite happy path)
- New: `src/slack/commands/usage-carousel-blocks.ts` (`buildCarouselBlocks` helper — pure fn)
- Untouched: DI `UsageCardOverrides` interface (extend with `tabCache?`, `renderer?` remains)

---

### Scenario 2 — `aggregateCarousel` single scan

**Entry**: `src/metrics/report-aggregator.ts::ReportAggregator.aggregateCarousel(opts)`
**Input**: `{ targetUserId: string, now: Date }`
**Output**: `CarouselStats = { '24h': TabResult, '7d': TabResult, '30d': TabResult, 'all': TabResult }`
  (`TabResult = CarouselTabStats | EmptyTabStats` — tab-specific types; v1 type union was removed in rev-3.)

**Internals**:
1. one pass over `metrics-events-*.jsonl` files — do NOT invoke a single-window aggregator 4× (would cost 4× disk I/O)
2. per event: compute KST timestamp + day key + hour key
3. for each of 4 windows, if event falls inside, accumulate into that window's mutable builder: totals, per-hour, per-day, per-model, per-session, activeDays Set
4. after scan: convert each builder → `CarouselTabStats` (or `EmptyTabStats` = `{empty:true}` if 0 events)
5. rankings: global top-N using **period=30d** only (v1 parity — carousel tabs share rankings; shown on card footer)

**Contract**:
- `all` window start = min(event.ts, 365d ago) — never more than 365 days of data even if retention grows
- `24h` window: `[now - 24h, now]` inclusive; uses hour bins, not day bins
- `7d`: `[endDate - 6, endDate]` day range; hourly enabled
- `30d`: `[endDate - 29, endDate]`; no hourly
- empty window = `{ empty: true }` when that window's builder sees 0 events

**RED**: `report-aggregator.test.ts` describe `aggregateCarousel` — synthetic fixture with events straddling windows. Assert:
- 4 keys present (`'24h'|'7d'|'30d'|'all'`)
- disjoint counts — 24h only contains events in last 24h
- single disk read (spy on `iterateEvents` call count === 1)

**File touch**:
- Modify: `src/metrics/report-aggregator.ts` (add method, reuse private helpers)
- Modify: `src/metrics/report-aggregator.test.ts`

---

### Scenario 3 — Period layout contract

**Entry**: `src/metrics/usage-render/buildCarouselOption.ts::buildTabOption(period, stats)`
**Contract (option shape per period — values, NOT SVG DOM)**:

| Period | Main chart     | grid series[0].type | xAxis       | yAxis       | data length |
| ------ | -------------- | ------------------- | ----------- | ----------- | ----------- |
| `24h`  | hourly bar     | `bar`               | 24 hour nums| tokens      | 24          |
| `7d`   | day×hour heat  | `heatmap`           | 24 hours    | 7 days      | ≤ 168       |
| `30d`  | week matrix    | `heatmap`           | 7 cols      | 5 rows      | ≤ 35        |
| `all`  | month×weekday  | `heatmap`           | ≤ 12 months | 7 weekdays  | ≤ 84        |

**Contract**:
- 색상 팔레트: dark palette `accentBg → accentSoft → accent` (monotonic)
- `visualMap.pieces` = 5 steps, upper bound = p95 or max (whichever finite)
- title text embeds selected tab badge — option is keyed by `selectedTab` param

**RED**: `buildCarouselOption.test.ts` — fixture per period, assert data length + series[0].type + xAxis tick count + visualMap piece count === 5. SVG DOM grep 금지.

**File touch**:
- New: `src/metrics/usage-render/buildCarouselOption.ts` (exports `buildTabOption(period, stats, palette)` and `buildOptionForPeriod`)
- New: `src/metrics/usage-render/buildCarouselOption.test.ts`

---

### Scenario 4 — `activeDays`

**Entry**: `src/metrics/usage-render/streaks.ts::activeDays(events, windowStart, windowEnd)`
**Definition**: count of distinct KST `YYYY-MM-DD` strings among events whose ts ∈ [windowStart, windowEnd].
**Contract**:
- events spanning same UTC day but different KST days → counted separately (timezone boundary correctness)
- empty event array → 0

**RED**: `streaks.test.ts` describe `activeDays` — fixture with 3 events on 2026-04-10 KST, 1 event on 2026-04-11 KST → 2. One UTC event at 14:30Z on 2026-04-09 (which is 2026-04-09 23:30 KST) + another at 15:30Z (2026-04-10 00:30 KST) → 2.

**File touch**:
- New: `src/metrics/usage-render/streaks.ts`
- New: `src/metrics/usage-render/streaks.test.ts`

---

### Scenario 5 — `longestStreak`

**Entry**: `src/metrics/usage-render/streaks.ts::longestStreak(activeDaySet, windowStart, windowEnd)`
**Definition**: maximum run length of consecutive days (calendar) where every day is in `activeDaySet`.
**Contract**:
- empty set → 0
- single day → 1
- gap in middle → split into runs, return max

**RED**: `streaks.test.ts` describe `longestStreak` —
  - `['2026-04-10', '2026-04-11', '2026-04-12']` → 3
  - `['2026-04-10', '2026-04-12']` → 1 (gap)
  - `['2026-04-10', '2026-04-11', '2026-04-13', '2026-04-14', '2026-04-15']` → 3

**File touch**: `src/metrics/usage-render/streaks.ts` (same file as #4)

---

### Scenario 6 — `currentStreak`

**Entry**: `src/metrics/usage-render/streaks.ts::currentStreak(activeDaySet, today)`
**Definition**:
- if today ∉ activeDaySet → **0** (break rule)
- else walk backwards from today, counting consecutive active days, stop at first gap

**Contract**:
- today = '2026-04-18', set = `['2026-04-15', '2026-04-16', '2026-04-17']` → 0 (today missing)
- today = '2026-04-18', set = `['2026-04-16', '2026-04-17', '2026-04-18']` → 3
- today = '2026-04-18', set = `['2026-04-17', '2026-04-18']` → 2 (run length 2, gap at 04-16)

**RED**: `streaks.test.ts` describe `currentStreak` — 3 cases above.

**File touch**: `src/metrics/usage-render/streaks.ts` (same file)

---

### Scenario 7 — `TabCache` set/get

**Entry**: `src/slack/commands/usage-carousel-cache.ts::TabCache`
**API**:
```ts
class TabCache {
  set(messageTs: string, entry: { fileIds: Record<TabId,string>; userId: string; expiresAt: number }): void;
  get(messageTs: string, now: number): CacheEntry | undefined;
  constructor(opts?: { cap?: number; now?: () => number });
}
```
**Contract**:
- TTL 24h — `get()` returns undefined if `now >= entry.expiresAt`
- LRU cap 500 — insert beyond cap evicts oldest (Map iteration order — delete + reinsert on read to move to end)
- expired entries are purged lazily on next `get()` hitting them + opportunistically on `set()` (scan first N=10)
- no persistence — fresh `new TabCache()` has 0 entries

**RED**: `usage-carousel-cache.test.ts` — injected fake `now`. Cases:
  - set → get within TTL → returns entry
  - set → advance now +25h → get returns undefined, internal map size = 0
  - insert 501 entries → size = 500, first-inserted entry gone
  - re-set same key updates entry (not duplicate)

**File touch**:
- New: `src/slack/commands/usage-carousel-cache.ts`
- New: `src/slack/commands/usage-carousel-cache.test.ts`

---

### Scenario 8 — `usage_card_tab` action → client.chat.update

**Entry**: `src/slack/action-handlers.ts::ActionHandlers.registerHandlers(app)` — register `app.action('usage_card_tab', handler)`
**Flow on click** (`{ack, body, client, respond}`):
1. `ack()` (< 3s, before any other work)
2. `messageTs = body.container.message_ts` — Bolt-provided on block_actions payload
3. `channel = body.container.channel_id`
4. look up `entry = tabCache.get(messageTs, now)`
   - miss → Scenario 11 path (ephemeral via `respond`)
5. gate: `body.user.id === entry.userId` → fail → Scenario 9 path
6. `selectedTab = body.actions[0].value` ∈ `{'24h','7d','30d','all'}`
7. `blocks = buildCarouselBlocks(entry.fileIds, selectedTab, entry.userId)`
8. `await client.chat.update({ channel, ts: messageTs, blocks })` — bot token path; **not** `respond({replace_original:true})` (response_url has 30min/5-call limit).

**Contract**:
- `client.chat.update` called exactly once with `{channel, ts: messageTs, blocks}` — spy on Bolt `client` proxy
- `respond` NOT called in happy path (ack-only)
- selected tab button has `style:'primary'`, others plain
- image block slack_file.id === `entry.fileIds[selectedTab]`
- `block_id === 'usage_card_tabs'` (static, not messageTs-embedded)

**RED**: `action-handlers.test.ts` describe `usage_card_tab` happy — fake tabCache with populated entry, body.user.id matches entry.userId, body.actions[0].value='7d', body.container={message_ts:'X', channel_id:'C1'}. Assert `client.chat.update` called with `{channel:'C1', ts:'X', blocks:<7d-selected>}`. Assert `respond` NOT called.

**File touch**:
- Modify: `src/slack/action-handlers.ts` (add handler + bind to injected tabCache + client from DI)
- Modify: `src/slack/action-handlers.test.ts`

---

### Scenario 9 — Non-owner click

**Flow**: gate fails → `await respond({ response_type: 'ephemeral', replace_original: false, text: '⚠️ 본인 카드만 조작할 수 있습니다.' })`. Note: `respond` (not `client.chat.update`) is correct here — ephemeral reject is single-shot, within response_url limits.

**Contract**:
- `body.user.id !== entry.userId` → ephemeral via `respond` with `replace_original:false`
- `client.chat.update` NOT called (original message untouched)
- tabCache left **untouched** (no eviction)

**RED**: `action-handlers.test.ts` describe `usage_card_tab non-owner` — entry.userId='U111', body.user.id='U999'. Assert `respond` called with `response_type:'ephemeral'` + `replace_original:false`. Assert `client.chat.update` NOT called. Assert tabCache still has entry.

---

### Scenario 10 — `renderCarousel`

**Entry**: `src/metrics/usage-render/carousel-renderer.ts::renderCarousel(stats: CarouselStats, selectedTab: TabId): Promise<Record<TabId, Buffer>>`
**Flow** (extends v1 `renderer.ts`):
1. for each of 4 periods (parallel — `Promise.all`):
   - if `stats[period].empty` → render stub PNG (`buildStubOption(period, palette)`, same resvg path, compact layout)
   - else → `buildTabOption(period, stats[period], palette, selectedTab === period)` → ECharts SSR → SVG → resvg PNG
2. fonts loaded once (module-level lazy promise — reuse v1 cache)
3. each output PNG 1600×2200, dark background

**Errors** (re-thrown typed):
- font load → `FontLoadError` (once, shared)
- ECharts init per-tab → `EchartsInitError`
- resvg per-tab → `ResvgNativeError`

**Contract**:
- returned object has exactly 4 keys `{'24h','7d','30d','all'}`
- every value is a Buffer with PNG magic bytes `89 50 4E 47`
- PNG width = 1600, height = 2200 (parsed from IHDR chunk bytes 16-23)
- selected tab's Buffer differs from non-selected tab's Buffer for same period stats (selection state baked into image)
- **NOT** asserting bitwise-identical across runs — resvg+zlib embed timestamp-dependent data; determinism guarantee is out of scope

**RED**: `carousel-renderer.test.ts` — fixture `CarouselStats` with all 4 periods non-empty. Call `renderCarousel(stats, '30d')`. Assert:
- 4 Buffers returned
- each has PNG magic + 1600×2200 dims
- `renderCarousel(stats, '30d')` ≠ `renderCarousel(stats, '7d')` (at byte level — selection state baked)

**File touch**:
- New: `src/metrics/usage-render/carousel-renderer.ts`
- New: `src/metrics/usage-render/carousel-renderer.test.ts`
- Deleted (rev-3): `src/metrics/usage-render/renderer.ts`, `buildOption.ts` — v1 path completely removed

---

### Scenario 11 — TabCache miss → ephemeral

**Contract**:
- `tabCache.get(ts, now)` returns undefined (TTL expired, LRU evicted, or process restart)
- handler responds `{ response_type: 'ephemeral', replace_original: false, text: '⌛ 세션이 만료되었습니다. `/usage card` 를 다시 실행해 주세요.' }`
- no exception thrown

**RED**: `action-handlers.test.ts` describe `usage_card_tab miss` — empty tabCache, any body. Assert respond called with `response_type:'ephemeral'` + `replace_original:false`, text contains "만료".

---

### Scenario 12 — Partial empty / all empty

**Partial empty** (some period has events, at least one is empty):
- `renderCarousel` renders empty tab as **stub PNG** (dark background + centered message "최근 {period} 활동 없음" + muted icon)
- non-empty tabs render normally
- handler still uploads 4 PNGs + posts carousel (user can cycle)

**All empty**:
- `aggregateCarousel` returns all 4 `{empty:true}`
- handler skips render + upload entirely
- posts v1 text ephemeral: "최근 30일간 기록된 사용량이 없습니다. `/usage` 로 기본 집계를 먼저 확인하세요."
- logger.info `{ event:'carousel_all_empty', userId }`

**RED**: `empty.test.ts` —
- partial: fixture with 24h=empty, rest populated → `renderCarousel` returns 4 buffers, 24h buffer is stub (compare to baseline stub rendered in isolation)
- all: fixture with 0 events → `handleCard` issues text ephemeral only, renderer never called, upload never called

**File touch**: `src/metrics/usage-render/empty.test.ts` (may already exist — extend)

---

### Scenario 13 — 5 whitelist errors → text fallback

**Flow in `handleCard`** try/catch:
- catch block checks `isSafeOperational(err)` (v1 `errors.ts` predicate, reused)
- if yes → logger.warn + ephemeral text "카드 생성 실패, 잠시 후 다시 시도해 주세요." + return `{handled:true}`
- if no → `throw err` (silent failure 금지)

**Contract**:
- renderer throws `FontLoadError` / `EchartsInitError` / `ResvgNativeError` / upload throws `SlackUploadError` / postMessage throws `SlackPostError` → each → ephemeral text, no throw escapes
- renderer throws `RangeError` (non-subclass) → re-throws, handler does NOT swallow

**RED**: `usage-handler.test.ts` describe `handleCard error fallback` — parametrized over 5 subclasses + 1 non-subclass. Assert ephemeral text path for whitelist, assert throw for non-whitelist.

---

### Scenario 14 — Dark palette + heatmap scale

**Entry**: `src/metrics/usage-render/dark-palette.ts::DARK_PALETTE`
**Content**:
```ts
export const DARK_PALETTE = {
  bg:         '#1A1A1A',
  surface:    '#242424',
  accent:     '#CD7F5C',
  accentSoft: '#8F5B45',
  accentBg:   '#3A231C',
  text:       '#F0E8E0',
  textMuted:  '#8F8880',
  grid:       '#2E2E2E',
} as const;

// luminance-monotonic: 31.0 → 41.1 → 72.9 → 109.7 → 143.4
export const HEATMAP_SCALE = ['#1F1F1F', '#3A231C', '#6B3F30', '#A06048', '#CD7F5C'] as const;
```

**Contract**:
- 8 keys present, hex strings matching `/^#[0-9A-Fa-f]{6}$/`
- HEATMAP_SCALE length = 5
- HEATMAP_SCALE luminance **strictly increasing** — `Y = 0.299R + 0.587G + 0.114B`, each step > previous (not merely ≥; strict monotonicity catches the `#2A2A2A` regression from rev-1 draft)
- expected luminances: `[31.0, 41.1, 72.9, 109.7, 143.4]` within ±1.0 rounding tolerance

**RED**: `dark-palette.test.ts`:
- hex regex per token (all 8)
- scale length check (=== 5)
- strict monotonic luminance (`for i in 1..4: Y[i] > Y[i-1]`)
- explicit values pinned: expect `Y[0] ≈ 31.0`, `Y[4] ≈ 143.4` — catch anyone swapping `#1F1F1F` back to a brighter value.

**File touch**:
- New: `src/metrics/usage-render/dark-palette.ts`
- New: `src/metrics/usage-render/dark-palette.test.ts`

---

### Scenario 15 — Regression: text commands unchanged

**Contract**: none of the following paths are modified:
- `UsageHandler.execute(ctx)` when `!isCardSubcommand(text)` — falls through to existing `aggregateTokenUsage` + `formatReport` + `postSystemMessage`
- `/usage` (no period), `/usage today`, `/usage 7d`, `/usage 30d`, `/usage @user` — all plain-text responses identical byte-for-byte to pre-carousel behavior

**RED**: `usage-handler.test.ts` describe `UsageHandler subcommand routing` —
- run 4 text commands (`usage`, `usage today`, `usage 7d`, `usage 30d`) through handler
- assert `handleCard` spy never fires
- assert `aggregateCarousel` never called (card path not taken)
- `/usage <@OTHER_USER>` → privacy gate reached (`postSystemMessage` called with "다른 사용자") instead of card path

**File touch**: `src/slack/commands/usage-handler.test.ts` (routing describe — no production code change beyond refactor)

---

## Suggested Ordering (for zwork)

```
[4,5,6,7,14]   standalone pieces — streaks / TabCache / palette (parallelizable)
  ↓
[2]            aggregateCarousel (needs streaks helpers from 4-6)
  ↓
[3,10]         buildCarouselOption + carousel-renderer (needs #2 output type)
  ↓
[1,8]          handleCard wiring + usage_card_tab action (needs 2,10,7)
  ↓
[9,11,12,13]   edge cases + fallbacks (polish)
  ↓
[15]           regression assertions (final safety net)
```

---

## Auto-Decisions (per STV Decision Gate — all small/below, no user prompt)

| Decision                                                           | Choice                                                           | Rationale                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `TabId` union ordering in code                                     | `'24h' \| '7d' \| '30d' \| 'all'` (spec §3 order)                | Match button render order; consistent lookup                                  |
| `buildCarouselBlocks` location                                     | new file `src/slack/commands/usage-carousel-blocks.ts`           | Pure fn, reused by both `handleCard` and `usage_card_tab` handler             |
| TabCache singleton vs DI                                           | singleton module default + DI override in `UsageHandlerOverrides`| Matches v1 pattern (renderer/aggregator do the same)                          |
| `tabCache.get` staleness vs `get`-then-set reinsertion for LRU     | reinsert on hit (move-to-end via delete+set)                     | Pure map-based LRU is simpler than doubly-linked list, perf enough at cap 500 |
| `aggregateCarousel` rankings source                                | 30d window (v1 parity) shared across tabs                        | Spec §4.3 "Ranking row" uses single global window                             |
| Stub PNG per-empty-tab: dedicated builder or full renderer reuse   | `buildStubOption(period, palette)` — minimal ECharts, same pipe  | Keeps 1 render pipe (easier font reuse, resvg reuse), avoids raw PNG bundling |
| Stub text copy                                                     | `"최근 {period} 활동 없음"`                                        | Mirrors v1 empty text voice                                                   |
| Persistent LRU on disk                                             | No                                                               | In-process is enough (see spec §4.6)                                          |
| New npm deps                                                       | None                                                              | echarts + resvg + fonts all reused                                            |
| deploy.yml change                                                  | None                                                              | No new native dep, no new bundle path                                         |
| Tab swap mechanism                                                 | `client.chat.update({channel, ts, blocks})` (bot token)          | response_url has 30min/5-call limit — unreliable for 24h window; Oracle P0 #3 + Linus P0 #1 |
| `block_id` for actions block                                       | Static `'usage_card_tabs'` (no messageTs embed)                  | messageTs unknown pre-postMessage; `body.container.message_ts` already provided by Bolt — Linus P0 #3 |
| Multi-instance readiness                                           | Single-instance assumption PINNED (§4.6); Redis migration = separate ticket | Current prod = single systemd unit; Redis-backed TabCache premature — Linus P0 #2 |
| `filesUploadV2` auto-post risk                                     | `channel_id: undefined` + contract test spies upload args         | Passing `channels` would post 4 orphan file messages — Oracle P0 #1            |
| Heatmap scale step 0 hex                                           | `#1F1F1F` (L=31.0) replacing `#2A2A2A` (L=42.0)                   | strict monotonicity over `#3A231C` (L=41.1) — Oracle P1                        |
| Dual-path env feature flag                                         | **Removed** (rev-3 — see Changelog for identifier + history)     | Env flag was single-point-of-failure — dropped with v1 legacy in refactor/usage-card-drop-legacy |

---

## File Touch Map (aggregate)

### New (7 files)

- `src/metrics/usage-render/dark-palette.ts`
- `src/metrics/usage-render/dark-palette.test.ts`
- `src/metrics/usage-render/buildCarouselOption.ts`
- `src/metrics/usage-render/buildCarouselOption.test.ts`
- `src/metrics/usage-render/carousel-renderer.ts`
- `src/metrics/usage-render/carousel-renderer.test.ts`
- `src/metrics/usage-render/streaks.ts`
- `src/metrics/usage-render/streaks.test.ts`
- `src/slack/commands/usage-carousel-cache.ts`
- `src/slack/commands/usage-carousel-cache.test.ts`
- `src/slack/commands/usage-carousel-blocks.ts`

### Modified (5 files)

- `src/metrics/report-aggregator.ts` (+ `aggregateCarousel`; v1 single-window aggregator deleted in rev-3 — see Changelog)
- `src/metrics/report-aggregator.test.ts` (extend)
- `src/slack/commands/usage-handler.ts` (`handleCard` body replaced — gates kept)
- `src/slack/commands/usage-handler.test.ts` (extend + regression describe)
- `src/slack/action-handlers.ts` (register `usage_card_tab`)
- `src/slack/action-handlers.test.ts` (extend)
- `src/slack/z/topics/usage-topic.ts` (help text reflects "4기간 캐러셀" not "30일")

### Existing test files extended

- `src/metrics/usage-render/empty.test.ts` (partial + all-empty cases)

### Untouched (explicit)

- `.github/workflows/deploy.yml` — no workflow change needed
- `package.json` / `package-lock.json` — no new deps
- `src/metrics/usage-render/assets/*` — fonts reused as-is
- `src/metrics/usage-render/errors.ts` — error taxonomy reused across carousel path
- `src/metrics/usage-render/types.ts` — carousel types (`CarouselStats`/`TabResult`/`CarouselTabStats`/`EmptyTabStats`/etc.); v1 type union removed in rev-3 (see Changelog)

---

## Changelog

### 2026-04-19 (rev-3) — v1 legacy removal, feature flag deleted

Live incident: `/opt/soma-work/dev/.env` 에 `USAGE_CARD_V2` 미주입 상태로 배포되어 주군이 carousel 을 보지 못함. "롤백 가드" 명목으로 추가된 dual path + env flag 가 오히려 배포 사고의 원인이었음. 단일 경로 refactor.

#### MODIFIED Scenarios

- **Scenario 1 — `/usage card` happy path**
  - **Before**: `USAGE_CARD_V2=true` 일 때만 carousel, 아니면 v1 single-render 경로
  - **After**: feature flag 제거. `/usage card` → 단일 carousel 경로 (`handleCard` 한 몸으로 합쳐짐)
  - **Trigger**: dev 배포 사고 (env flag 미주입 → carousel 미노출) + v2 is superset of v1
  - **Contract tests updated**: `flag off → v1 path` 테스트 삭제; routing invariant 만 유지

- **Scenario 15 — Regression: text commands unchanged**
  - **Before**: `USAGE_CARD_V2` flag on/off matrix 9-parametrized cases (`it.each` 2회)
  - **After**: 단일 routing invariant — bare `/usage` / today / 7d / 30d 는 `handleCard` 미진입 (flag 언급 없음)
  - **Trigger**: flag 자체가 사라져 matrix 불필요
  - **Contract tests updated**: `process.env.USAGE_CARD_V2` 조작 제거, 단일 `describe('UsageHandler subcommand routing')` 로 축소

#### REMOVED Scenarios

None (Scenario 15 축소만; 카운트 불변).

#### Code + Docs deleted (moved to `trash/`)

- `src/metrics/usage-render/renderer.ts` — v1 단일 PNG 렌더러
- `src/metrics/usage-render/buildOption.ts` — v1 ECharts option builder
- `src/metrics/usage-render/renderer.test.ts`, `buildOption.test.ts` — v1 전용 테스트
- `src/metrics/usage-card-aggregation.test.ts` — v1 aggregator 테스트
- `src/slack/commands/usage-handler.ts::handleCardV1` 메서드
- `src/metrics/report-aggregator.ts::aggregateUsageCard` 메서드
- `src/metrics/usage-render/types.ts` 의 `UsageCardStats` / `UsageCardResult` / `EmptyStats` / `UsageCardRanking` / `UsageCardSession` 타입
- `src/slack/commands/usage-handler.ts` 의 `UsageCardOverrides.aggregator.aggregateUsageCard`, `.renderer` 필드
- `docs/usage-card/` 전체 디렉토리 (v1 spec/trace/proof/deploy-patch)

#### Rollout change

- `USAGE_CARD_V2` env flag 제거. `.env` 에 아무것도 추가하지 않아도 `/usage card` → carousel.
- 회귀 시 code revert (단일 경로 — revert 로 전체 원복)

### 2026-04-18 (rev-2) — Linus + Oracle review integration

Applied P0/P1 findings from parallel local:reviewer (SIMPLIFY) + local:oracle (88/100 REQUEST_CHANGES). All P0 resolved; no scenario count change, contracts tightened.

#### MODIFIED Scenarios

- **Scenario 1 — `/usage card` happy path**
  - **Before**: `filesUploadV2` args unspecified re: `channels`; post-upload race unhandled; `block_id` embedded messageTs
  - **After**: explicit `no channels/channel_id` contract; 500ms×3 retry on `invalid_blocks` race; static `block_id='usage_card_tabs'`; `USAGE_CARD_V2` feature flag branch added
  - **Trigger**: Oracle P0 #1 (orphan post), Oracle P0 #2 (cold-cache race), Linus P0 #3 (block_id chicken-and-egg), Oracle MISSING (rollback path)
  - **Contract tests updated**: upload args spy, flag off → v1 path

- **Scenario 8 — `usage_card_tab` action**
  - **Before**: `respond({replace_original:true, blocks})` — uses response_url (30min/5-call limit)
  - **After**: `client.chat.update({channel, ts: messageTs, blocks})` — bot token, unlimited; `respond` reserved for ephemeral rejects only; `messageTs` from `body.container.message_ts` (static block_id)
  - **Trigger**: Linus P0 #1, Oracle P0 #3
  - **Contract tests updated**: `client.chat.update` spy replaces `respond` happy assertion

- **Scenario 9 — Non-owner click**
  - **Before**: `respond({replace_original:false, ...})` — consistent with happy path
  - **After**: same `respond` call, but clarifying note that ephemeral rejects STILL use response_url (single-shot within limits), while happy path now uses `client.chat.update`
  - **Trigger**: clarification from Scenario 8 change
  - **Contract tests updated**: assert `client.chat.update` NOT called

- **Scenario 10 — renderCarousel**
  - **Before**: "running twice with same input yields bitwise-identical output" (determinism asserted)
  - **After**: determinism NOT asserted (resvg+zlib non-deterministic); replaced with PNG magic + 1600×2200 dims + selected-tab byte-level differentiation
  - **Trigger**: Oracle NIT
  - **Contract tests updated**: IHDR parse for width/height; removed bitwise-identical assertion

- **Scenario 14 — Dark palette + heatmap scale**
  - **Before**: `HEATMAP_SCALE = ['#2A2A2A', '#3A231C', '#6B3F30', '#A06048', '#CD7F5C']` (L = [42.0, 41.1, 72.9, 109.7, 143.4] — step 0→1 DECREASING)
  - **After**: `HEATMAP_SCALE = ['#1F1F1F', '#3A231C', '#6B3F30', '#A06048', '#CD7F5C']` (L = [31.0, 41.1, 72.9, 109.7, 143.4] — strictly increasing); contract tightened to `strictly increasing` + explicit pinned luminance values
  - **Trigger**: Oracle P1 (RED test would fail immediately as written)
  - **Contract tests updated**: strict `>` instead of `≥`; pinned `Y[0]≈31.0`, `Y[4]≈143.4`

- **Auto-Decisions table**: 6 new rows added for tab swap mechanism, block_id strategy, multi-instance, filesUploadV2 args, heatmap step 0, feature flag

#### ADDED Scenarios

None (P0/P1 all resolvable within existing 15 scenarios).

#### REMOVED Scenarios

None.

#### Pushback (not adopted)

- Linus "reduce 6 new impl files to 4": partial — palette kept separate for testing; streaks kept separate (3 functions, distinct edge cases). Total impl files: 5 (palette, buildCarouselOption, carousel-renderer, streaks, carousel-cache) + 1 pure helper (carousel-blocks) = 6. Retained.
- Linus "aggregateCarousel single-scan unmeasured": profiling post-implementation only; structural test (`iterateEvents` spy count === 1) is sufficient RED gate.
- Oracle MISSING "deploy.yml SHA guard": PR changes no workflow file.

### 2026-04-18 — Initial v2 trace

Initial creation from `docs/usage-card-dark/spec.md` (main approved via UIAskUserQuestion `approve_as_is`). 15 scenarios across carousel rendering, tab cache, streak metrics, dark palette, partial-empty fallback, action handler, and regression.

## Next Step

→ `local:zwork` — implementation following the suggested ordering above. RED tests listed per scenario.
