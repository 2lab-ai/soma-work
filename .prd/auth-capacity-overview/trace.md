# Auth capacity overview — ztrace (T1–T4)

Method: ztrace (scenario-driven callstack trace, `/opt/soma-work/dev/dist/local/skills/ztrace/SKILL.md`)
Scope: SSOT-TASK-TREE T1–T4 of [ssot.md](ssot.md), acceptance A1–A9 of [../06-auth-capacity-spec.md](../06-auth-capacity-spec.md) (lines 31–39; the workstream [spec.md](spec.md) is a pointer only)
Traced: 2026-09-16, branch `feat/auth-capacity-overview`, working tree (uncommitted diff on top of `5ab199b`)
Refreshed: 2026-09-16 (pass 2) after the legacy mutation-continuity source was finalized — adds the auth-origin codec / embedded-CCT paths to S3, current line refs, and the recovered T4 evidence. Read-only trace — no source was modified; this file is the only write.

Test run receipt (pass 2): `npx vitest run src/slack/auth src/slack/z/topics/__tests__/auth-topic.test.ts src/slack/z/topics/__tests__/auth-topic.ccp-embed.test.ts src/slack/cct/__tests__/auth-origin.test.ts src/slack/cct/__tests__/actions.auth-origin.test.ts` → 8 files, 102 tests, all passed (2026-09-16 19:29). No full-suite run is claimed (see [verification.md](verification.md) for the baseline caveat).

## Final delta verification — 2026-09-16

The parent verified two final review corrections after pass 2. Their current paths supersede the earlier line references below:

- S2/T2: `capacity.ts:60–87` now calls `invalidAbsoluteReset` in both `resetAt` and `remaining`. Present negative/non-finite/out-of-range/string timestamps make the reading unknown. Only omission/null/zero allow the relative fallback. Expired absolute timestamps are not revived. `capacity.reset.test.ts` records RED6 → GREEN10.
- S3/T2–T3: `auth/actions.ts:270–286` passes `refreshUsage` only for `auth_refresh`; `auth-topic.ts:128–150` invokes `fetchUsageForAllAttached({timeoutMs})` once without force, renders a visible cached notice on all-null/error, and passes `skipOnOpenFetch` to the legacy renderer. Management authority is unchanged. Actual registered-action/topic/builder test `overview.refresh.test.ts` proves fresh42% data, readonly ordinary/admin and explicit admin, one fetch, same page/view, failure/throttle notice, no readonly-pagination fetch and unchanged llmux path (7 passed).
- Final direct gate receipt: `npm run test:release` → 531 files passed +1 skipped; 10,583 tests passed +5 skipped. Typecheck and production build both exit0. See [verification](verification.md). These remain local, not live Slack, receipts.

## Phase 1 — Source map

| File | Role | Key symbols |
|---|---|---|
| `src/slack/auth/capacity.ts` (NEW) | Pure capacity/grouping/formatting helpers | `authText`:4, `accountGroup`:12, `providerName`:19, `groupAccounts`:23, `collectScopedWindows`:45, `hasSubscriptionWindows`:56, `resetAt`:60, `remaining`:69, `formatReset`:81, `windowLine`:94, `accountUnavailable`:101, `windowTotals`:111, `groupSummary`:117, `accountLines`:185 |
| `src/slack/auth/builder.ts` | Block Kit card builder | `maskSecret`:52, `buildAuthModeHeaderBlocks`:77, `buildAccountBlocks`:109, `PAGE_SIZE=8`:149, `boundedText`:151, `buildAuthNavigationBlocks`:155, `buildAuthCardBlocks`:176, modals:306/355/403 |
| `src/slack/auth/views.ts` | Stable action/view/block ids | `AUTH_ACTION_IDS`:9 (`viewer='auth_view_mode'`:28, `page='auth_page'`:30 are NEW), `AUTH_VIEW_IDS`:35, `AUTH_BLOCK_IDS`:41 |
| `src/slack/auth/actions.ts` | Bolt block_action / view_submission handlers (llmux card) | `parseNavState`:80, `effectiveViewerMode`:104, `requireAdmin`:109, `rerenderCard`:130, `rerenderCardAt`:167, `registerAuthActions`:200 (mode:202, switch:224, nav routes:263–287, modal opens:290/306/319, view submits:337/370/402) |
| `src/slack/cct/auth-origin.ts` (NEW) | Auth-origin wrapper codec (mutation continuity, T3 follow-up) | `CctAuthOrigin`:33, `encodeAuthOriginPayload`:45, `decodeAuthOriginPayload`:59 (strict `/^ao:(\d+)\|(.+)$/s`:41), `encodeAuthOriginMetadata`:66, `decodeAuthOriginMetadata`:77 |
| `src/slack/z/topics/cct-topic.ts` | CCT card renderer + NEW embed composition | `CctCardEmbed`:44, `stripCardLevelRefresh`:58, `stampAuthOriginOnActionValues`:78, `renderCctCard`:145 (embed param:151, slot windowing:187–194, embed strip/stamp/page-context:204–216, `embedSlotPage/Count` return:260) |
| `src/slack/cct/actions.ts` | CCT mutation handlers, now origin-aware | `decodeActionButtonValue`:846 (`authOrigin`:856), `cardSurfaceOf`:874, `renderAuthWrapperInPlace`:893, `rerenderAuthWrapperAt`:928; origin branches — add open:148, remove open:209, attach open:255, detach:290, next:319, activate:368, refresh-all:472, add submit:676, remove submit:729, attach submit:790, kind_radio metadata carry:167–176 |
| `src/slack/z/topics/auth-topic.ts` | Card renderer + mode apply + `/z` topic binding | `CCP_SLOT_PAGE_SIZE=8`:36, `renderAuthCard`:59 (demote:67, llmux branch:71–105, ccp embed branch:107–139), `applyAuthMode`:149, `createAuthTopicBinding`:176 |
| `src/slack/commands/auth-handler.ts` | Naked `auth` command handler | `canHandle`:45, `execute`:49 (status arm:82–84), `executeKey`:95 |
| `packages/slack/src/command-parser.ts` | Naked grammar | `isAuthCommand`:224, `parseAuthCommand`:231 |
| `packages/slack/src/commands/command-router.ts` | Router | `CommandRouter`:114, `route`:141 (`/z` strip+translate:149–163, handler loop:269–270, crash-consume guard:289–292) |
| `src/slack/commands/command-router.ts` | Handler wiring | `new AuthHandler(deps)`:89 |
| `packages/slack/src/z/router.ts` | `/z` → legacy translation | `parseTopic`:162, `translateToLegacy`:184 |
| `packages/slack/src/z/whitelist.ts` | Naked/DM gates | `SAFE_Z_TOPICS` incl. `auth`:94, DM naked `auth key` arm:126–128 |
| `src/auth/llmux-client.ts` | llmux HTTP client + wire types | `LlmuxWindow`:27, `LlmuxScopedWindow`:44, `LlmuxAccount`:50 (`usage_control`:73–79 NEW), `request`:109, `fetchLlmuxStatus`:168, `isLlmuxUp`:176, `switchLlmuxAccount`:220, `addLlmuxAccount`:225, `removeLlmuxAccount`:235 |
| `src/auth/auth-runtime.ts` | Persisted auth mode/settings | `persist` (tmp+rename):121–131, `getAuthMode`:139, `getAuthRuntimeSnapshot`:251, `setAuthMode`:260, `setLlmuxSettings`:272 |
| `src/admin-utils.ts` | Admin gate | `isAdminUser`:21 (env `ADMIN_USERS`, cached set:8–19) |
| `packages/slack/src/cct/render-in-place.ts` | Surface-aware card update | `classifyRenderInPlaceSurface`:~110, `renderInPlace`:152 (`chat.update`:~168–173) |
| `src/slack/actions/z-settings-actions.ts` | Shared `/z` chrome | cancel route `/^z_setting_(.+)_cancel$/`:200 (handles `z_setting_auth_cancel`) |
| Bootstrap | Registration | `src/slack/actions/index.ts`:175 → `packages/slack/src/actions/index.ts`:525 (`registerAuthActions`); CCT actions via `registerCctActions`:524; topic binding at `src/slack/z/topics/index.ts`:36 |

No SQL anywhere in this feature — external I/O is llmux HTTP (loopback by default), the local CCT token store (via `TokenManager`, no HTTP), and Slack Web API.

External effect map (complete):

| Call | Where | When |
|---|---|---|
| `GET {baseUrl}/llmux/status` | `llmux-client.ts:168` | every llmux-mode card render (naked `auth`, `/z auth`, refresh, page, viewer toggle, post-mutation re-render); 5s timeout:107 |
| `GET {baseUrl}/llmux/status` (probe, 1.5s) | `isLlmuxUp` `llmux-client.ts:176` | `applyAuthMode('llmux')` guard `auth-topic.ts:159`; llmux-settings submit probe `auth/actions.ts:356` |
| `POST {baseUrl}/llmux/switch` `{account}` | `llmux-client.ts:220` | admin Switch button `auth/actions.ts:233` / text `auth switch <name>` `auth-handler.ts:73` |
| `POST {baseUrl}/llmux/add-account` `{api_key,name?}` | `llmux-client.ts:225` | admin Add modal submit `auth/actions.ts:390` |
| `POST {baseUrl}/llmux/remove-account` `{name,confirm:true}` | `llmux-client.ts:235` | admin Remove modal submit `auth/actions.ts:414` |
| TokenManager `applyToken/detachOAuth/rotateToNext/addSlot/removeSlot/attachOAuth/refreshAll…` | `cct/actions.ts` mutation routes | embedded (ccp) legacy mutations — local token-store operations, no llmux HTTP |
| Slack `chat.postMessage` (`say`) | `auth-handler.ts:83` | initial card post (append-only) |
| Slack `chat.update` | `render-in-place.ts:~168`, `auth/actions.ts:177`, `cct/actions.ts:936` | in-place re-render on button click / modal submit |
| Slack `views.open` / `views.update` | `auth/actions.ts:297/313/327`, `cct/actions.ts` modal opens + kind_radio:170 | admin modal opens; kind flip carries `private_metadata` over |

All llmux requests carry `x-api-key: getLlmuxAdminKey(base)` (`llmux-client.ts:139`) — control-plane admin credential resolved against the request's own base URL so a candidate-URL probe never leaks the local key.

---

## Scenario S1 (T1) — naked `auth` and `/z auth` render the grouped provider overview

Trigger: user message `auth` (channel; naked whitelist) or `/z auth` (slash/DM).
State transition: (no card) → readonly overview message, page 0. No persistent state is touched.

```
Slack message event
└─ CommandRouter.route(ctx)                          [packages/slack/src/commands/command-router.ts:141]
   ├─ [text starts with /z] stripZPrefix → remainder [:149–150]
   │    ├─ [slash source + slash-forbidden combo] → hint, stop   [:152–158]  (auth is not forbidden)
   │    └─ ctx.text = translateToLegacy('auth') → 'auth'         [:162; packages/slack/src/z/router.ts:184]
   │       (DM gate: non-admin DM allows `/z auth` via SAFE_Z_TOPICS [packages/slack/src/z/whitelist.ts:94];
   │        naked `auth` in DM is NOT in the non-admin naked allowlist — only `auth key` is [:126–128])
   ├─ handler loop                                    [:269–270]
   │    └─ AuthHandler.canHandle('auth') → CommandParser.isAuthCommand [src/slack/commands/auth-handler.ts:45;
   │       packages/slack/src/command-parser.ts:224–228]  → true
   └─ AuthHandler.execute(ctx)                        [src/slack/commands/auth-handler.ts:49]
      ├─ parseAuthCommand('auth') → {action:'status'} [packages/slack/src/command-parser.ts:245]
      ├─ renderAuthCard({userId, issuedAt})           [:82; src/slack/z/topics/auth-topic.ts:59]
      │  ├─ canManage = isAdminUser(userId)           [auth-topic.ts:66; src/admin-utils.ts:21]
      │  ├─ viewerMode = (args.viewerMode==='admin' && canManage) ? 'admin' : 'readonly'  [auth-topic.ts:67]
      │  │    [no viewerMode arg] → 'readonly' for EVERYONE, admins included (A6)
      │  ├─ runtime = getAuthRuntimeSnapshot()        [auth-topic.ts:69; src/auth/auth-runtime.ts:251]
      │  ├─ [runtime.mode==='llmux']
      │  │  ├─ fetchLlmuxStatus() → GET /llmux/status [auth-topic.ts:75; src/auth/llmux-client.ts:168]
      │  │  │    ├─ [!res.ok] → LlmuxClientError('llmux GET /llmux/status → <status>: <detail>') [llmux-client.ts:155]
      │  │  │    ├─ [timeout 5s] AbortController abort → LlmuxClientError('llmux unreachable at <base> (…)') [:117–121,161]
      │  │  │    └─ [throw] caught → llmuxError, logger.warn; render continues with status=null [auth-topic.ts:76–79]
      │  │  ├─ buildAuthCardBlocks({runtime, llmuxStatus, llmuxError, viewerMode:'readonly', canManage, page:0, nowMs}) [auth-topic.ts:80–88]
      │  │  │  ├─ pageCount = max(1, ceil(accounts/8)); page clamped to [0, pageCount-1] [builder.ts:178–179]
      │  │  │  ├─ header + mode line; [viewerMode==='admin'] mode buttons — skipped here [builder.ts:92–104]
      │  │  │  ├─ [llmuxStatus] server context line (version · uptime · port · current) [builder.ts:185–194]
      │  │  │  │  [else] ❌ unreachable section; non-admin sees generic text, admin sees authText(error) [builder.ts:195–203]
      │  │  │  ├─ [viewerMode==='admin'] settings line — skipped (readonly never shows baseUrl/masked key) [builder.ts:206–220]
      │  │  │  ├─ groupAccounts(accounts)             [builder.ts:232; capacity.ts:23–43]
      │  │  │  │    ├─ key = group.trim().lowercase || (type∈{codex,grok,openrouter} ? type : 'claude') [capacity.ts:12–17]
      │  │  │  │    │    → older Codex creds with missing `group` still land under Codex (A1)
      │  │  │  │    ├─ group order: claude → codex → grok rank, then unknown groups alphabetical [capacity.ts:34–37]
      │  │  │  │    └─ in-group order: scheduler `order` asc, then natural name compare [capacity.ts:40]
      │  │  │  │       (new arrays built per group — the input `accounts` array is never mutated; pinned by test)
      │  │  │  ├─ per group:
      │  │  │  │    ├─ visible = accounts.slice(max(0, page*8-offset), max(0, (page+1)*8-offset)) [builder.ts:233–236]
      │  │  │  │    │    → global paging over the grouped order: each account appears on exactly one page (A9)
      │  │  │  │    ├─ [!visible && group∉{claude,codex,grok}] continue — unknown groups only on their page [builder.ts:240]
      │  │  │  │    │    → Claude/Codex/Grok provider totals stay visible on EVERY page (A2)
      │  │  │  │    ├─ current = current_by_group[group] ?? (group==='claude' ? current : undefined) [builder.ts:241]
      │  │  │  │    ├─ summary section: `*<Provider>* · N계정 · current` + groupSummary(all accounts of group) [builder.ts:242–250]
      │  │  │  │    │    (summary uses the COMPLETE group pool, not just the visible page slice)
      │  │  │  │    └─ per visible account: buildAccountBlocks with status promoted to 'active' ONLY when
      │  │  │  │       current===name && status==='ok' [builder.ts:251–258] — an auth_failed current keeps ⛔
      │  │  │  ├─ pool context line: `N slot(s) · page/pageCount · 조회 <ISO> · 공급자 측정 시각 미제공` [builder.ts:260–268]
      │  │  │  └─ nav: [🔄 Refresh][← 이전?][다음 →?] + ([어드민 모드] iff canManage, readonly card)
      │  │  │       every nav button value = JSON {viewerMode, page}     [builder.ts:282, 155–173]
      │  │  └─ push cancel actions block (z_setting_auth_cancel)         [auth-topic.ts:89–100]
      │  └─ return {text:'🔐 Auth: llmux (N slots, current: …)', blocks} [auth-topic.ts:101–104]
      └─ say({text, blocks, thread_ts})  → Slack chat.postMessage        [auth-handler.ts:83]
```

Both entry points converge on the same `renderAuthCard` (A8): naked `auth` directly, `/z auth` via `translateToLegacy` → the identical `AuthHandler` path. The `/z` topic binding (`createAuthTopicBinding().renderCard` [auth-topic.ts:184]) is a third convergence point used by the shared z-settings chrome. Convergence is now pinned end-to-end by `overview.integration.test.ts` (real `AuthHandler.execute` + real binding on the same fixture).

Error handling:
- llmux down → card still renders with ❌ section + Refresh guidance; non-admin never sees the raw error string (builder.ts:200).
- Handler throw inside `execute` → CommandRouter consumes the message (crash-consume guard, packages/slack/src/commands/command-router.ts:289–292) so the raw text can never fall through to session init.

Why it works (S1):
1. Single renderer convergence — the three surfaces (naked, `/z`, action re-render) cannot drift because they share `renderAuthCard`; grouping/ordering lives in one pure function (`groupAccounts`) with a deterministic comparator.
2. Provider totals are computed from the full group array while pagination slices only the account rows — totals stay correct and visible regardless of page (offset arithmetic guarantees partition, no duplication/loss).
3. Missing `group` degrades by credential `type`, defaulting to `claude` — matches llmux history (pre-group Codex creds) without a schema migration.

---

## Scenario S2 (T2) — remaining/reset honesty: unknown stays unknown, Grok synthetic never becomes a subscription reset

Trigger: same render path as S1; this scenario traces the data honesty branches inside `capacity.ts`.
State transition: none (pure computation over the `/llmux/status` snapshot + `nowMs`).

Key branch inventory (all in `src/slack/auth/capacity.ts`):

```
remaining(window, nowMs)                                 [:69–75]
├─ [!window || !isFinite(utilization) || util<0 || util>1] → undefined   (never a number from garbage)
├─ reset = resetAt(window, nowMs)                        [:60–67]
│   ├─ [isFinite(resets_at) && 0 < resets_at < 8.64e12] → resets_at      (absolute wins — A3)
│   ├─ [else isFinite(resets_in_secs) && 0 < x < 31_536_000] → now+x     (relative fallback ONLY when absolute missing)
│   └─ [else] → undefined
├─ [reset !== undefined && reset <= now] → undefined
│     "an elapsed absolute reset must not turn a stale ratio into a fresh allowance" [:61]
│     → expired window ≠ 100% remaining; it is UNKNOWN until re-observed (A3: never auto-replenish)
└─ else → 1 - utilization

windowLine(label, window, nowMs, timed)                  [:94–99]
├─ [remaining undefined] → '<label> · 잔여량 미제공' (+ ' / 재조회 필요' iff a window object exists)
└─ else → '<label> 잔여 X% (사용 Y%) · 리셋 <!date^epoch^…|UTC fallback> (Δ 후)'   — Slack-local absolute + delta (A3)
     [timed=false or no reset] → '리셋 시각 미제공'

hasSubscriptionWindows(account)                          [:56–58]
└─ group ∈ {claude, codex} && type !== 'apikey'
     → ONLY these have a known window duration in this contract.

accountLines(account, nowMs)                             [:185–231]
├─ [subscription] 5h + 7d windowLines (timed)
├─ [grok / apikey / openrouter] → windowLine('속도 한도', five_hour, timed=false)      [:189]
│     + fixed line '잔여 토큰·요청 수 미제공 · 리셋 시각 미제공'
│     → the llmux-synthesized rate window renders as a rate limit: NO 5h label, NO reset
│       timestamp, NO next-reset participation (A5; pinned by test 'never presents Grok
│       synthetic reset as a five-hour subscription reset'; the upstream synthetic 60s reset
│       horizon is verified against the pinned llmux source — verification.md §Upstream)
├─ scoped windows → '7d-<scope>' lines                   [collectScopedWindows :45–53
│     prefers scoped_limits[] (generic, labelled) over legacy fable_weekly]
├─ cooldown_until (finite, future, < 8.64e12) → '쿨다운 종료 …'
├─ status cooldown/auth_failed → explicit lines;  blocked → '차단: <reason>'
├─ usage_control (Codex manual resets, wire field llmux-client.ts:73–79)
│     counts printed ONLY for safe non-negative integers, else '미확인' — zero ≠ unknown (pinned);
│     last_error → '최근 조회 실패 · 이전 관측값'; pending_request_id → '결과 미확정';
│     '자동 사용하지 않습니다' (read-only surface, no POST exists for it in this repo)
└─ totals → '누적 사용: … (잔여량 아님)'
      → consumed-token telemetry is labelled consumed; never inverted into remaining

groupSummary(accounts, nowMs)                            [:117–183]
├─ known = subscriptions with BOTH 5h & 7d measured      [:119–121]
├─ available = known ∧ !accountUnavailable               [:122]
│     accountUnavailable [:101–109] = blocked || auth_failed || cooldown status ||
│     future cooldown_until || any of 5h/7d remaining === 0
│     → an account whose EARLIEST window resets is still unavailable while the other
│       window is exhausted (A4: overlapping windows; pinned by '공통 한도 여유 0/3' test)
├─ header [:124–130] branches on subscriptions.length (pass-2 change):
│     [subscription group] '공통 한도 여유 a/N (5h·7d 확인, 모델별 한도 별도) · 차단 b · 미확인 N-a-b'
│     [rate-limit-only group (Grok/API-key)] '속도 한도 측정 m/N · 차단 b · 구독 잔여량 미제공'
│       → even the group header never implies a subscription balance for Grok
├─ [subscriptions] 5h/7d/scoped windowTotals             [:131–156]
│     '<label> 잔여 합계 X.XX계정분 · 측정 m/N' — normalized account-equivalents (100% of one
│     account = 1), coverage numerator = measured windows only [:111–115]
│     + '합계는 차단 계정 포함 · 계정별 100%=1계정분, 플랜 가중치 없음 · 토큰 수가 아닙니다.' [:156] (A2)
│  [else] '총 잔여량 미제공 · 속도 한도는 구독 토큰 잔고가 아닙니다.' [:158] — Grok group total NEVER invented
└─ next reset [:160–181]: earliest future reset across subscription windows with amount<1
      → '다음 리셋: <name> <label> · <!date…> · +X%p' + conditional caveat
        '추가 사용 없을 때 해당 창만 회복 · 다른 한도·쿨다운·인증 상태는 별도 확인.' (A4:
        reclaimed amount = used %, only that window, no whole-account promise)
```

Error handling: there is none to handle — every helper is total (returns `undefined`/fixed strings for malformed input). The malformed-window test pins no `NaN`, no `Invalid Date`, no `잔여 100%`, no next-reset from garbage.

Why it works (S2):
1. Unknown is the fixed point: every invalid/missing/expired/out-of-range input collapses to `undefined` → '미제공', never to 0, 100%, or a synthesized balance. The system can only over-report *ignorance*, never capacity.
2. Reset validity gates remaining: `remaining` consults `resetAt` before answering, so a stale ratio with an elapsed reset cannot masquerade as fresh allowance — replenishment requires a fresh observation from llmux, not the passage of local time.
3. Provider semantics are typed, not guessed: `hasSubscriptionWindows` is the single predicate deciding whether a window has a duration; everything downstream (labels, totals, next-reset eligibility, and since pass 2 even the group header wording) branches on it, so Grok/API-key rate telemetry can never leak into subscription math.

---

## Scenario S3 (T3) — admin default overview → [어드민 모드] → management → refresh/page/return → forbidden mutation

Trigger chain: admin types `auth` → clicks 어드민 모드 → uses management → Refresh/paging/일반 보기; separately a non-admin replays/forges the same action payloads. In ccp (legacy) runtime mode "management" means the EMBEDDED CCT controls — traced in S3b below.
State transition (per message card): `readonly@0` → `admin@p` → (refresh: same) → (page: `admin@p±1`) → `readonly@p`. All state is message-embedded; nothing persists.

### S3a — llmux-mode card (unchanged since pass 1, refs current)

```
1. Initial render (admin): identical to S1 — renderAuthCard derives viewerMode='readonly'
   even though canManage=true [auth-topic.ts:66–67]. Builder receives {viewerMode:'readonly',
   canManage:true} and renders EXACTLY ONE admin affordance: the [어드민 모드] nav button
   (value {"viewerMode":"admin","page":p}) [builder.ts:171]. No mode/settings/switch/add/
   remove blocks exist in the payload (pinned). (A6)

2. Click [어드민 모드] → Bolt block_action 'auth_view_mode'
   app.action(viewer) [auth/actions.ts:263–287, registered via packages/slack/src/actions/index.ts:525]
   ├─ await ack()                                   [:270]  ← ALWAYS first (3s contract; pinned)
   ├─ state = parseNavState(value)                  [:274; :80–96]
   │    fail-safe: malformed JSON / legacy 'refresh' / negative page → {readonly, 0} — never wider
   ├─ viewerMode = effectiveViewerMode(state.viewerMode, userId)   [:280; :104–106]
   │    'admin' honored IFF isAdminUser(userId) — encoded card state is untrusted input
   ├─ rerenderCard → renderAuthCard({viewerMode:'admin', page})    [:130–160]
   │    renderAuthCard AGAIN demotes non-admin 'admin' [auth-topic.ts:67] — second, independent layer
   │    → fresh GET /llmux/status → admin card: mode buttons, settings line (base URL + maskSecret
   │      key [builder.ts:206–220]), per-account [Switch]/[Remove] [builder.ts:125–144],
   │      [➕ Add account], nav now shows [일반 보기] (value {"viewerMode":"readonly",page}) [builder.ts:170]
   └─ renderInPlace → chat.update on the SAME message [auth/actions.ts:152; packages/slack/src/cct/render-in-place.ts:152]

3. Management actions (admin llmux card):
   ├─ Switch  → 'auth_llmux_switch_account' [auth/actions.ts:224–250]: ack → requireAdmin →
   │    POST /llmux/switch {account} → banner | '❌ Switch failed: <409 scheduler reason>' →
   │    re-render ADMIN card (success AND failure; pinned)
   ├─ ⚙️ Edit / ➕ Add / Remove → modal opens [auth/actions.ts:290–334]: ack → requireAdmin →
   │    views.open with private_metadata = JSON {channel, ts(, name)}
   ├─ Settings submit → view 'auth_llmux_settings' [:337–367]: requireAdmin (non-admin: plain ack) →
   │    URL regex gate → [invalid] ack({response_action:'errors'}) → [valid] ack → isLlmuxUp(candidate)
   │    probe → setLlmuxSettings (persist tmp+rename, auth-runtime.ts:272,121–131) → admin re-render
   │    at stored surface with reachable/⚠️ banner — unreachable persists anyway, only warned
   ├─ Add submit → view 'auth_llmux_add_account' [:370–399]: requireAdmin → key required (errors ack) →
   │    POST /llmux/add-account → banner added/updated | '❌ Add failed: …' → admin re-render (pinned)
   └─ Remove submit → view 'auth_llmux_remove_account' [:402–423]: requireAdmin →
        POST /llmux/remove-account {confirm:true} → banner → admin re-render
   Mode switch buttons ('auth_mode_switch_llmux|ccp' [:202–221]) → applyAuthMode [auth-topic.ts:149–174]:
   internal isAdminUser re-check, llmux target probed first (refuse when down), setAuthMode persists.

4. Refresh / paging: 'auth_refresh' / 'auth_page_prev|next' route through the same nav loop
   [:263–287] — value {"viewerMode":"admin","page":p} retained, actor re-checked, fresh GET
   /llmux/status, page clamped to the CURRENT pageCount [builder.ts:179]. Regex
   ^auth_page(?:_(?:prev|next))?$ [:266] accepts bare 'auth_page' (back-compat) and rejects
   'auth_page_other' (pinned). Target page comes from the VALUE, never the id suffix.

5. Return: [일반 보기] → same viewer route with {"viewerMode":"readonly",page} → readonly card,
   page retained (pinned end-to-end by overview.integration.test.ts: open → toggle → page_next →
   refresh → toggle back, admin surface preserved through paging/refresh, gone after return).

6. Forbidden mutation (non-admin forges/replays payloads):
   ├─ nav routes with {"viewerMode":"admin"} → effectiveViewerMode demotes → READONLY re-render,
   │    page retained; the replayed card leaks neither settings, secrets ('test-secret'/'localhost'
   │    pinned absent) nor any mutating id (integration-pinned)
   ├─ mutating block_actions → ack → requireAdmin false → logger.warn → RETURN [auth/actions.ts:109–114]:
   │    no POST, no views.open, no re-render (silent swallow — log-only by design; see G4)
   └─ modal submits → requireAdmin false → plain ack() only: no llmux call, no chat.update (pinned)
```

### S3b — ccp (legacy) mode: embedded CCT card, mutation continuity via the auth-origin codec (pass-2 final)

Render side — `renderAuthCard` ccp branch [auth-topic.ts:107–139]:

```
renderAuthCard (runtime.mode==='ccp')
├─ headerBlocks = buildAuthModeHeaderBlocks(runtime, EFFECTIVE viewerMode)  [auth-topic.ts:122]
├─ cctCard = renderCctCard({userId, issuedAt, viewerMode, embed:{page, pageSize:8}})  [:123–128; CCP_SLOT_PAGE_SIZE :36]
│  └─ cct-topic.ts renderCctCard [:145]
│     ├─ visibleSlots = slots.filter(kind==='cct')                          [:177]
│     ├─ [embed] SLOT pagination — window the SLOTS, never truncate blocks  [:187–194]
│     │    pageCount = ceil(visible/8); page CLAMPED to last page (stale cards degrade to
│     │    the last page, never an empty window — pinned); renderSlots = window slice
│     ├─ buildCctCardBlocks({slots: renderSlots, …})                        [:196–202]
│     ├─ [embed] stripCardLevelRefresh(blocks)                              [:205; :58–76]
│     │    removes ONLY `cct_refresh_card` — its handler re-renders the BARE CCT card and
│     │    would wipe the wrapper; an emptied actions row is dropped entirely (Slack rejects
│     │    zero-element actions blocks — readonly cards have a refresh-only row). All other
│     │    legacy controls (Activate/Add/Remove/Attach/Detach/Next/Refresh-All) REMAIN (pinned).
│     ├─ [embed] stampAuthOriginOnActionValues(blocks, slotPage)            [:206; :78–101]
│     │    every `cm:<mode>|<inner>` button value → `cm:<mode>|ao:<page>|<inner>`
│     │    [auth-origin.ts encodeAuthOriginPayload :45]. The frozen cm codec is NOT extended —
│     │    the PAYLOAD is wrapped; decodeCctActionValue splits on the FIRST `|` only, so the
│     │    wrapper survives. Non-tagged values (cancel, auth-nav JSON) untouched (pinned).
│     ├─ [embed && pages>1] page context 'N slot(s) · p/P 페이지'            [:207–216]
│     └─ return {…, embedSlotPage, embedSlotPageCount}                      [:256–261]
└─ blocks = header + divider + cctCard.blocks + buildAuthNavigationBlocks(viewerMode, canManage,
     slotPage, slotPageCount)                                               [:129–138]
   Block budget: worst case 42 blocks/page (header 3 + divider 1 + chrome 2 + 8 slots × 4 +
   contexts 2 + cancel 1 + nav 1) ≤ 49 with the banner slot reserved [comment :113–121;
   pinned at 24 rich slots for both admin and readonly].
```

Click side — embedded mutation buttons land in the EXISTING CCT routes [cct/actions.ts]:

```
block_action (e.g. cct_activate_slot, value 'cm:admin|ao:2|slot-B')
├─ await ack()
├─ decoded = decodeActionButtonValue(body)            [:846–871]
│    decodeCctActionValue → {mode:'admin', payload:'ao:2|slot-B'}
│    decodeAuthOriginPayload peels the marker          [auth-origin.ts:59; strict /^ao:(\d+)\|(.+)$/s :41]
│    → {payload:'slot-B', cardMode:'admin', authOrigin:{page:2}}
│    [no ao: prefix / malformed 'ao:x|y','ao:-1|x','ao:1|'] → authOrigin:null, payload untouched
│    → DIRECT cards are byte-identical through this module (pinned)
├─ renderMode = resolveRenderMode(cardMode, actor)     (existing actor re-check, unchanged)
├─ tokenManager.applyToken('slot-B')                   (local token store — no llmux HTTP)
└─ [decoded.authOrigin] renderAuthWrapperInPlace({viewerMode: renderMode, page: origin.page})  [:368–377; :893–926]
     └─ renderAuthCard({userId, viewerMode, page}) → renderInPlace chat.update
        renderAuthCard re-checks authorization AND clamps the page — a forged/stale origin
        degrades to readonly / last page, never errors (same two-layer property as S3a)
   [else] renderCardInPlace(bare CCT card)             (existing path, unchanged — pinned)
   Same fork in: detach :290–298, next :319–326, refresh_usage_all :472–479 (banner PREPENDED
   to the wrapper render — 'nothing refreshed' all-failed banner pinned first-block)
```

Modal continuity — opens stamp metadata, submits re-render the wrapper at the stored surface:

```
modal open (remove :209–214 / attach :255–258 / add :148–151), when decoded.authOrigin:
  view.private_metadata = encodeAuthOriginMetadata({...origin, ...cardSurfaceOf(body)}, payload)
    [auth-origin.ts:66; cardSurfaceOf :874]  → JSON {cctAuthOrigin:{page,channel,ts}, payload}
  (direct card: metadata stays the bare keyId string — pinned byte-identical)
  kind_radio flip [:167–176]: views.update replaces the WHOLE view, so prior private_metadata is
  carried onto the next view — otherwise the submit would lose the origin (pinned).

view_submission (add :676 / remove :729 / attach :790):
  meta = decodeAuthOriginMetadata(private_metadata)    [auth-origin.ts:77 — bare strings and
    foreign JSON decode as {origin:null, payload:raw}, so direct-card submits are untouched]
  mutation runs on meta.payload (inner keyId / 'add')
  [meta.origin] rerenderAuthWrapperAt(client, origin, userId)   [:928–945]
    → renderAuthCard({viewerMode:'admin', page: origin.page}) → chat.update(origin.channel/ts)
      (view submissions carry no container — the surface travels IN the metadata;
       missing channel/ts → silent no-op return; chat.update failure → warn log)
  [else] postEphemeralCard(bare CCT card)              (existing path — pinned)
```

Why it works (S3):
1. Two independent authorization layers for VIEW state (`effectiveViewerMode` + the renderer demote) and a third for MUTATION (`requireAdmin` / `resolveRenderMode` / `applyAuthMode`): hiding buttons is UX; the server-side checks are the security boundary. The origin codec adds NO new authority — it only carries a page number and a surface, and every consumer re-derives authorization from the actor.
2. All nav AND origin state travels in the message (button values, modal `private_metadata`) — no per-user server session, no global admin-view flag, nothing persisted. Every click re-derives the card from (payload, actor, live snapshot); double-clicks are idempotent re-renders.
3. Compositional codec discipline: the frozen `cm:` codec is untouched — the origin wraps the PAYLOAD (`ao:<page>|<inner>`) and the strict digit-only regex makes accidental collisions (a keyId literally starting `ao:<digits>|`) the only theoretical false positive; malformed shapes fail back to plain payloads. Direct CCT cards never pass through the stamping path, so their flows are byte-identical (explicitly pinned, including the 51-block direct baseline — see G8).
4. Block budget by pagination, not truncation: the embed windows SLOTS through the wrapper's own page state, so every slot stays reachable (exactly-once per page, pinned) and Slack's 50-block cap is met structurally (≤ 42 + cancel + banner ≤ 49) instead of by dropping content.
5. Ack-before-work everywhere; llmux/token-store work happens after `ack()`; view submits ack after input validation only.

---

## Scenario S4 (T4) — `using-dotprd` availability

T4 is a skill invocation, not a code path. Evidence verified in this trace pass (read-only):

- Initial state (pass 1): no `using-dotprd` in `src/local/skills/` (30+ skills, none matching), `.claude/skills/` (only `update-docs`), the runtime skill registry exposed to this session, or GitHub code search — the Skill tool and MANAGE_SKILL both rejected it (ssot.md:46).
- Recovery (2026-09-16, coordinator-verified and recorded in ssot.md:48): the original definition was found by direct repository-tree lookup in `2lab-ai/zbrain` at commit `2fef422eb63070bc01f1b629faa1734a3b4a83a9` — `.claude/skills/using-dotprd/SKILL.md` plus its referenced `rules/DEV.md` — fetched, read and applied. The source is cached in session evidence, NOT installed into the runtime registry (still absent locally at this trace pass; `.claude/skills/` unchanged).
- Application on the artifact layout (verified on disk): the contract was promoted to the numbered documents `.prd/06-auth-capacity-spec.md` + `.prd/07-auth-capacity-architecture.md`; the workstream `spec.md` became a pointer; `loop.md` (work-unit ownership), `verification.md` (execution/verification receipts) and `review.md` now exist alongside `ssot.md` and this trace.
- Chronology is preserved, not rewritten: the earlier failed Skill invocation is still recorded as failed (ssot.md:48 "Do not claim that the earlier failed Skill invocation succeeded"); pass-1 work followed the manually derived `.prd` convention before the definition was found (ssot.md:50).
- Conclusion: T4's blocker is lifted at the *definition* level and its instructions are applied at the *artifact* level; it was never executed as a runtime Skill invocation, and this trace does not certify the skill's semantics beyond the layout it prescribes.

---

## Phase 3 — State machine synthesis

Per-card viewer state (message-embedded, zero server persistence; `page` means llmux account page in llmux mode and legacy SLOT page in ccp mode):

```
        `auth` / `/z auth` (any user)
                   │
                   ▼
        ┌──────────────────────┐  auth_view_mode {admin,p} ∧ isAdmin  ┌──────────────────────────────┐
        │  READONLY overview   │ ───────────────────────────────────▶ │  ADMIN management            │
        │  page p              │ ◀─────────────────────────────────── │  page p                      │
        └──────────────────────┘  auth_view_mode {readonly,p}         └──────────────────────────────┘
          │  ▲        │  ▲                                              │  ▲        │  ▲       │
          │  └────────┘  │ auth_refresh {readonly,p}                    │  └────────┘  │       │ [ccp] embedded CCT
          │ auth_page_*  │ (same state, fresh snapshot)                 │ auth_page_*  │       │ mutation, value
          ▼              │                                              ▼   auth_refresh       │ cm:admin|ao:p|…
        page p±1 (clamped to live pageCount)                          page p±1 (clamped)       ▼
                                                                             ADMIN page p re-render (wrapper,
                                                                             origin page; banner on failure)
  [ccp] embedded modal submit (origin metadata {page,channel,ts}) ──▶ ADMIN page p chat.update at stored surface
  ANY payload with viewerMode:'admin' from a non-admin ──▶ READONLY (demote; auth/actions.ts:104 + auth-topic.ts:67)
  malformed nav payload ──▶ READONLY page 0 (auth/actions.ts:80–96); malformed ao:/metadata ──▶ DIRECT-card path
  stale/out-of-range page ──▶ clamped to last page (builder.ts:179; cct-topic.ts:192)
  z_setting_auth_cancel ──▶ card dismissed (z-settings-actions.ts:200)
  mutating click by non-admin ──▶ NO transition (ack + warn log only)
  direct `cct` card flows ──▶ untouched by ALL of the above (no embed input → no stamp, bare re-render)
```

Persisted runtime state (`data/auth-runtime.json` + CCT token store — both pre-existing; T1–T3 nav/origin never writes them):

| Transition | Trigger | Guard | Code path |
|---|---|---|---|
| mode ccp → llmux | admin mode button / `auth llmux` | `isAdminUser` + `isLlmuxUp` probe (refuse when down) | auth-topic.ts:158–168 → auth-runtime.ts:260 |
| mode llmux → ccp | admin mode button / `auth cct` | `isAdminUser` (no probe needed) | auth-topic.ts:168 |
| llmux {baseUrl,apiKey} update | admin Settings modal submit | `requireAdmin` + URL syntax; candidate probed, persisted even if down (warned) | auth/actions.ts:337–367 → auth-runtime.ts:272 |
| (external) llmux pool membership | admin Add/Remove/Switch | `requireAdmin` + llmux's own `confirm:true` contract | auth/actions.ts:370–423 → llmux-client.ts:220–237 |
| (local) CCT slot registry | embedded/direct legacy mutations | existing CCT admin gates (`resolveRenderMode`/admin routes, unchanged) | cct/actions.ts mutation routes → TokenManager |

Invariants (and why they hold):

1. **No new persistent state.** `viewerMode`/`page` live in nav button JSON; the ccp mutation origin lives in `ao:<page>|` payload wrappers and modal `private_metadata` JSON — all message-embedded. Verified: nav routes [auth/actions.ts:263–287] and every origin branch [cct/actions.ts] call no store beyond the mutations that already existed; the only persistence writers are pre-existing `setAuthMode`/`setLlmuxSettings` (atomic tmp+rename) and the CCT TokenManager.
2. **Overview is GET-only.** Naked/`/z`/refresh/page/viewer paths perform exactly one llmux call (`GET /llmux/status`) in llmux mode and one token-store snapshot read in ccp mode. All mutations sit behind admin gates.
3. **Forged payloads cannot widen a surface.** Nav demotion happens in two places, mutation gating in a third; the origin codec carries no authority (page + surface only) and every consumer re-derives authorization from the actor; malformed nav → `readonly@0`, malformed origin → direct-card path.
4. **Unknown never becomes capacity.** All capacity math flows through `remaining`/`resetAt` whose only non-numeric answer is `undefined` → '미제공'; expired windows require re-observation to replenish; since pass 2 even the Grok group header says '구독 잔여량 미제공'.
5. **Grok/API-key telemetry never enters subscription math.** `hasSubscriptionWindows` is the single gate for totals, 5h/7d labels, next-reset eligibility and header wording.
6. **Payload bounded structurally.** llmux: PAGE_SIZE=8 + `boundedText` 2900-char clamp + builder ≤47 blocks (pinned) + cancel + banner ≤ 49. ccp: slot pagination (8/page) + embedded-Refresh removal → ≤ 42 + banner slot, pinned ≤ 49 at 24 rich slots. Pagination is windowing, never truncation — every account/slot reachable exactly once per pool (both pinned).
7. **Secrets contained.** Settings line renders only in admin mode; raw llmux error text only to admins; `authText` escapes upstream strings; non-admin replay of an admin toggle leaks neither `test-secret` nor `localhost` (integration-pinned); API keys transit modal→POST only.
8. **Composition never alters the composed.** Direct CCT rendering and flows are byte-identical with the origin module in place (no embed input → no windowing, no stamp, no metadata change) — pinned, including its pre-existing 51-block over-cap baseline (G8) so silent drift becomes visible.
9. **Append-only + in-place split.** Command entry posts a new message (`say`); every button/modal transition updates the same message (`chat.update`, surface carried in `private_metadata` for modals) — no card ever forks into two live copies.

## Phase 4 — Design principle summary

| Principle | Implementation |
|---|---|
| Single renderer, many entries | naked `auth`, `/z auth`, nav clicks, llmux modal submits AND embedded CCT mutations all end in `renderAuthCard` [auth-topic.ts:59] |
| Untrusted card state | `{viewerMode,page}` re-authorized per click [auth/actions.ts:104] and re-demoted in the renderer [auth-topic.ts:67]; origin carries no authority |
| Fail-closed / fail-unknown | nav decode → `readonly@0` [auth/actions.ts:80–96]; origin decode → direct-card path [auth-origin.ts:59,77]; capacity math → `undefined`/'미제공' [capacity.ts:60–75] |
| Enforcement at the boundary, UX at the surface | hidden buttons are UX; `requireAdmin` + `applyAuthMode` + existing CCT gates are the gate |
| Pure core, effectful shell | `capacity.ts` and `auth-origin.ts` are total & side-effect-free; HTTP/Slack/store effects only in actions/topics/client modules |
| Frozen-codec composition | `cm:` codec untouched — origin wraps the payload (`ao:<page>|`), strict-regex fallback keeps direct flows byte-identical [auth-origin.ts:41] |
| Budget by pagination, not truncation | llmux accounts and legacy slots are windowed through page state; nothing is dropped [builder.ts:233–236; cct-topic.ts:187–194] |
| Honest units | 계정분, '토큰 수가 아닙니다', consumed totals labelled '잔여량 아님', rate-limit headers labelled '구독 잔여량 미제공' |
| Ack-before-work | every Bolt handler acks first; llmux/token I/O after [auth/actions.ts:270; cct/actions.ts routes] |
| Stable ids + back-compat | `AUTH_ACTION_IDS`/`AUTH_VIEW_IDS` constants; legacy `'refresh'` values and bare `auth_page` regex tolerated [auth/actions.ts:266,:92] |

## Test coverage — actual expectations (traced, not assumed)

`src/slack/auth/__tests__/builder.capacity.test.ts` (13 tests, T1/T2):
- :33 provider order Claude<Codex<Grok + unknown after, in-group order by `order`, input array `toEqual` original (A1)
- :49 '1.50계정분', '측정 2/2', '잔여 75%', `<!date^…>` absolute + '1h' delta, '다음 리셋' '+25%p', '토큰 수가 아닙니다' (A2/A3/A4)
- :61 consumed totals never inverted: '잔여량 미제공' + '누적 사용' + no '잔여 0%'/'Infinity' (A5)
- :78 expired/NaN windows → '재조회 필요', no '잔여 100%'/'Invalid Date'/'NaN'/'다음 리셋:' (A3)
- :94 cooldown/auth_failed/exhausted-overlap → '공통 한도 여유 0/3' (A4)
- :108 Grok synthetic: '속도 한도', no '다음 리셋:', no `<!date^…60^`, no '5h 잔여', '리셋 시각 미제공' (A5)
- :117 `resets_in_secs` fallback only when `resets_at` missing (A3)
- :124 70 accounts × 9 pages: ≤47 blocks/page, all 70 names reached, every section ≤3000 chars (A9)
- :143 provider summaries on every page + full-pool total '9.00계정분' (A2)
- :156 auth_failed current not promoted to ✅
- :162 Codex `usage_control`: '보유 2회 · 현재 적용 가능 0회' vs '미확인' (zero ≠ unknown), '최근 조회 실패', '자동 사용하지 않습니다' (A5)
- :182 scoped exhaustion separate: '공통 한도 여유 1/1' + '7d-fable 잔여 0%' + '모델별 한도 별도' (A4)
- :191 `<!channel>` escaped, group fallback by type='codex' (A1/A9)

`src/slack/auth/__tests__/actions.test.ts` (26 tests, T3 llmux): registration of `auth_view_mode`/`auth_page`; forged-admin demotion with page retention on viewer/page/refresh; malformed → page 0; suffixed paging ids route and `auth_page_other` does NOT; legacy 'refresh' → readonly@0; ack-before-render (twice); non-admin mode/switch/modal-open/add-submit produce zero effect calls; admin mutations re-render ADMIN card on success AND failure with banner text asserted (A7/A8).

`src/slack/auth/__tests__/overview.integration.test.ts` (3 tests, NEW pass 2 — real `AuthHandler` + real renderer + real builder + registered actions, llmux mocked at the client seam):
- :107 naked `auth` and the `/z` topic binding emit the SAME readonly overview for an admin — '*Claude*', '7.50계정분', no settings/switch ids, [어드민 모드] button value contains 'admin' (A6/A8)
- :122 clicked journey: viewer toggle opens controls → `auth_page_next` retains admin + reaches '*ai10*' → refresh retains both → viewer toggle returns to overview; ack asserted before chat.update; no mutation calls (A7)
- :139 non-admin replaying the admin's own emitted toggle button: no controls, no settings, no viewer button, and neither 'test-secret' nor 'localhost' anywhere in the payload (A7/A9)

`src/slack/cct/__tests__/auth-origin.test.ts` (8 tests, NEW — pure codec): payload roundtrip 'ao:2|slot-B'; inner may contain `|`/`:`; plain payloads pass through origin:null; malformed shapes ('ao:|x','ao:x|y','ao:1','ao:-1|x','ao:1|') are NOT origins; encode rejects invalid pages/empty inner; metadata roundtrip {page,channel,ts}; bare keyId and foreign JSON decode with origin:null.

`src/slack/cct/__tests__/actions.auth-origin.test.ts` (14 tests, NEW — mutation continuity, renderers mocked):
- buttons: activate/detach/next with `cm:admin|ao:p|…` → inner payload drives the mutation, `renderAuthCard({viewerMode:'admin', page:p})`, `renderCctCard` NOT called, wrapper blocks land in chat.update; plain `cm:admin|slot-B` → bare CCT path unchanged; refresh-all all-failed → wrapper re-render with 'nothing refreshed' banner FIRST
- modal opens: remove/attach/add with origin value → `private_metadata` = exact `{cctAuthOrigin:{page,channel,ts},payload}` JSON; direct value → bare keyId metadata; kind_radio flip preserves metadata across views.update
- modal submits: remove/attach/add with origin metadata → mutation on inner payload + wrapper chat.update at stored {channel,ts}, NO ephemeral card; bare metadata → existing ephemeral path, no auth render

`src/slack/z/topics/__tests__/auth-topic.ccp-embed.test.ts` (13 tests, NEW — real cct-topic + real builders, token manager/runtime/llmux faked):
- block budget: 24 rich slots ≤ 49 blocks (admin AND readonly); 20 slots → every slot on EXACTLY one page (none dropped, none duplicated); stale page 99 clamps to last page with correct nav (prev yes, next no); paging buttons appear only for multi-page pools
- embedded refresh: composed card carries NO `cct_refresh_card` (auth_refresh present instead); readonly card drops the emptied actions row (no zero-element actions block); all six legacy mutation ids REMAIN on the embedded admin card
- stamping: every `cm:` value on page 1 matches `^cm:(admin|readonly)\|ao:1\|`, auth-nav JSON values untouched; direct `renderCctCard` output contains no `|ao:`
- direct baseline guard: direct card keeps `cct_refresh_card`, renders ALL 24 slots unpaginated, no '페이지' indicator, and measures exactly 51 blocks (pre-existing over-cap locked as baseline — see G8)

`src/slack/z/topics/__tests__/auth-topic.test.ts` (T3 + #803 baseline, unchanged pass 2): default render readonly for ADMIN; explicit admin renders full UI; non-admin demoted with `canManage:false`; page forwarded; account identity viewer-independent; readonly hides settings/base URL/masked key; ccp path passes EFFECTIVE viewerMode to `renderCctCard` and appends nav AFTER the CCT blocks (A6/A8).

`src/slack/auth/__tests__/builder.test.ts` (pre-existing, still green): admin/readonly block inventory, maskSecret, unreachable banner, ccp header, scoped-window rendering.

Run receipt: 8 files / 102 tests, all passed (pass 2). Cross-references: TDD red→green logs and the full-suite/typecheck caveats live in [verification.md](verification.md) — this trace does not claim a full-suite or clean-typecheck receipt.

## Defects / gaps (flagged, not certified)

- **G1 (doc integrity) — RESOLVED in pass 2**: `verification.md` now exists (with `loop.md` and `review.md`); the ssot Artifacts links resolve. The contract lives in `.prd/06-auth-capacity-spec.md` / `07-auth-capacity-architecture.md`; the workstream `spec.md` is a pointer by design.
- **G2 (minor accuracy, capacity.ts:148–155 + 111–115)**: scoped-window totals report coverage as `측정 m/subscriptions.length` — accounts that legitimately don't expose that scope count as unmeasured. Conservative direction (understates coverage), but '측정 1/2' can read as a data problem when it's scope-absence.
- **G3 (minor accuracy, capacity.ts:70–71 + 101–108)**: `utilization > 1` (over-quota emission) → `remaining` undefined → the account lands in '미확인', not '차단', though it is certainly not usable. Availability count stays correct (never counted available); flagging for review whether over-utilization should classify as unavailable.
- **G4 (UX decision, auth/actions.ts:109–114)**: non-admin clicks on llmux mutating routes are ack'd and swallowed with only a server-side warn log — no ephemeral notice. Deliberate (buttons don't exist on the readonly card; only forged/stale payloads arrive), but a stale pre-T3 admin card in channel history can present silently-dead buttons.
- **G5 (test coverage gaps — flagged, no certification of behavior)** — updated for pass 2:
  - RESOLVED: the naked-command → renderer → emitted-button → registered-action chain is now covered end-to-end (`overview.integration.test.ts`); ccp embed composition and CCT mutation continuity are covered (`auth-topic.ccp-embed.test.ts`, `actions.auth-origin.test.ts`, `auth-origin.test.ts`).
  - RESOLVED after restart on 2026-09-16: settings URL validation, reachable/unreachable probe→persist sequence, secret-free banner, settings/removal non-admin denial, missing removal name, successful/failed removal admin rerender at the original surface are now covered by 8 added cases in `auth/__tests__/actions.test.ts` (34 total passed). The signed Bolt HTTP journey also exercises actual handler registration, emitted values, real llmux HTTP and outbound Slack SDK requests with isolated fixtures (9 passed); it is not deployed acceptance.
  - STILL OPEN: `AuthHandler` text arms `auth llmux|cct` deny+apply and `auth switch` unpinned (status arm covered; `key` covered in `auth-handler.key.test.ts`). `z_setting_auth_cancel` dismissal still relies on the shared z-settings route without an auth-specific assertion.
- **G6 (disclosed edge, capacity.ts:160–174)**: '다음 리셋' candidates include windows of cooldown/auth_failed/blocked accounts, so the headline next-reset can belong to an account that remains unusable after that reset. The caveat line discloses this; acceptable under A4 but worth a product read.
- **G7 (naked-DM asymmetry, packages/slack/src/z/whitelist.ts:94 vs 126–128)**: non-admin DM allows `/z auth` (SAFE_Z_TOPICS) but not naked `auth` (only `auth key`). Pre-existing gate, not introduced by this change.
- **G8 (pre-existing, locked as baseline — NEW in pass 2)**: the DIRECT CCT card at 24 rich slots measures 51 blocks, already over Slack's 50-block hard cap without any auth wrapper (`buildCctCardBlocks` floor of 2 blocks/slot; the #701 budget contract only covers ≤ 15 slots). Out of scope for this feature — the embed path fixes it for the wrapper via slot pagination, and `auth-topic.ccp-embed.test.ts:276–291` pins the direct value at exactly 51 so any silent change to direct rendering becomes visible. Flagged for a separate fix (paginate or trim the direct card).
- **G9 (theoretical collision, auth-origin.ts:41 — NEW in pass 2, informational)**: a direct-card keyId beginning literally with `ao:<digits>|` would be misread as an origin wrapper. KeyIds are internally generated (`slot-…`) and never take this shape today; noted so a future keyId scheme change re-checks the codec.
