# Slack 세션 처리 경로 — Pseudocode

**관계:** [`spec.md`](./spec.md)의 5개 경로를 pseudocode로 압축. 용어는 [`terminology.md`](./terminology.md).
**기준 커밋:** `a66d3f78a` (2026-04-18).

## 표기 규약

- `event` = Slack Events API 원본 페이로드. 필드: `type`, `channel`, `channel_type`, `user`, `ts`, `thread_ts?`, `subtype?`, `text`, `files?`.
- `ctx` = soma-work 내부 처리 컨텍스트. 필드: `channelId`, `threadTs?`, `mentionTs?`, `userId`, `text`, `sourceThread?`.
- `session` = `ConversationSession` 인스턴스 — [src/session-registry.ts:56](../../src/session-registry.ts).
- `//` 주석은 서술. `->` 는 전이. `=>` 는 산출.
- 함수 참조: `file:line` 표기.

---

## 공통 유틸

```pseudo
// 세션 키 공식 — src/session-registry.ts:216
function getSessionKey(channelId, threadTs):
    return `${channelId}-${threadTs || 'direct'}`

// 미드-스레드 판별 — src/mcp-config-builder.ts:94
function isMidThreadMention(ctx):
    return !!ctx.mentionTs && ctx.mentionTs !== ctx.threadTs

// dispatch classifier — src/dispatch-service.ts:125
function dispatch(userMessage) -> { workflowType, meta }:
    return claudeHandler.dispatchOneShot(loadDispatchPrompt(), userMessage)

// dispatch 락 (AS-IS, 30s timeout) — src/slack/pipeline/session-initializer.ts:29, 309
function acquireDispatchLock(sessionKey) -> boolean:
    if dispatchInFlight.has(sessionKey):
        wait up to 30s for promise to resolve
        if still in-flight: return false    // drop
    dispatchInFlight.set(sessionKey, newPromise)
    return true

function releaseDispatchLock(sessionKey):
    dispatchInFlight.delete(sessionKey)    // src/slack/pipeline/session-initializer.ts:724
```

---

## 경로 1 — 일반 세션 (채널 top-level 멘션)

```pseudo
INPUT:  event = { type:'app_mention', channel:Cxxx, user:Uxxx, ts:T1, thread_ts:undefined, text:'@bot …' }
OUTPUT: session { channelId:Cxxx, threadTs:Troot, threadModel:'bot-initiated', threadRootTs:Troot }
        + chat.postMessage(channel=Cxxx, thread_ts=undefined) → Troot  // 새 top-level

// src/slack/event-router.ts:111 app.event('app_mention')
on app_mention(event):
    if event.files && event.files.length > 0:
        -> handleFileUpload(event); return

    text := stripBotMention(event.text)            // event-router.ts:131-138
    if startsWith(text, '/z'):
        if maybeRouteAppMentionViaZRouter(event, text) == TERMINAL: return
                                                    // event-router.ts:150-156
    // thread_ts 없음 → 경로 1
    ctx := { channelId: event.channel, threadTs: undefined,
             mentionTs: event.ts, userId: event.user, text: text }
    -> messageHandler.handle(ctx, event)

function messageHandler.handle(ctx, event):
    if CommandRouter.route(ctx).handled && !continueWithPrompt:
        return                                      // 경로 3
    sessionKey := getSessionKey(ctx.channelId, undefined)  // Cxxx-direct 일 수도, 여기선 신규
    if !acquireDispatchLock(sessionKey): return

    { workflowType } := dispatch(ctx.text)
    -> initializeSession(ctx, event, workflowType)  // session-initializer.ts

function initializeSession(ctx, event, workflow):
    // PR 라우팅 가능성 체크 — session-initializer.ts:347 PR_ROUTABLE_WORKFLOWS
    routable := workflow ∈ PR_ROUTABLE_WORKFLOWS

    // 양쪽 브랜치 모두 migrate — session-initializer.ts:492 (OK), :514 (SKIP)
    rootResult := chat.postMessage(channel=ctx.channelId, text=headerText, blocks=[...], thread_ts=undefined)
    session := createSession(ctx.userId, ctx.userName,
                             ctx.channelId, rootResult.ts,  // threadTs = 새 루트
                             model=workflow.model)
    session.threadModel := 'bot-initiated'
    session.threadRootTs := rootResult.ts
    // 기존 'direct' 세션 있으면 terminateSession
    // 원본 스레드는 없음(top-level) → cleanup 생략

    releaseDispatchLock(sessionKey)
    => session, Troot = rootResult.ts

// 이후 응답
on followup(event, session):
    workThreadTs := session.threadRootTs || session.threadTs   // event-router.ts:788
    chat.postMessage(channel=ctx.channelId, thread_ts=workThreadTs, text=reply)
```

**slack-mcp 등록 여부:** `isMidThreadMention(ctx) == false` → 등록 안 됨.

---

## 경로 2 — 미드-스레드 멘션

```pseudo
INPUT:  event = { type:'app_mention', channel:Cxxx, user:Uxxx, ts:T2, thread_ts:Tparent, text:'@bot …' }
        // T2 !== Tparent 보장 (아니면 Slack이 app_mention 발송 안 함에 가까움)
OUTPUT: session { threadTs:Tnew_root, threadModel:'bot-initiated', threadRootTs:Tnew_root,
                  sourceThread: { channel:Cxxx, threadTs:Tparent } }
        + 새 스레드 루트 Tnew_root
        + slack-mcp 등록 (mcp__slack-mcp__get_thread_messages 접근 가능)

on app_mention(event) with event.thread_ts:
    // 경로 1과 동일한 전처리
    ...
    // 원본 스레드의 linked session 조회 — event-router.ts:166-174
    linked := findSessionBySourceThread(event.channel, event.thread_ts)
    if linked: post linked session card to thread; return   // 중복 생성 방지

    ctx := { channelId: event.channel,
             threadTs: event.thread_ts,    // 원본 parent
             mentionTs: event.ts,           // reply ts
             userId: event.user, text: stripBotMention(event.text) }
    -> messageHandler.handle(ctx, event)

function messageHandler.handle(ctx, event):
    if CommandRouter.route(ctx).handled && !continueWithPrompt: return
    sessionKey := getSessionKey(ctx.channelId, ctx.threadTs)
    if !acquireDispatchLock(sessionKey): return

    { workflowType } := dispatch(ctx.text)
    -> initializeSession_midThread(ctx, event, workflowType)

function initializeSession_midThread(ctx, event, workflow):
    // MCP 등록 조건 — mcp-config-builder.ts:94, 188
    if isMidThreadMention(ctx):
        mcpServers += slack-mcp with env SLACK_MCP_CONTEXT = {
            channel: ctx.channelId,
            threadTs: ctx.threadTs,
            mentionTs: ctx.mentionTs,
            sourceThreadTs: ctx.threadTs,
            sourceChannel: ctx.channelId
        }                                            // mcp-config-builder.ts:466
        allowlist += ['mcp__slack-mcp__*']            // mcp-config-builder.ts:539

    // 경로 1과 동일한 createBotInitiatedThread — session-initializer.ts:752
    rootResult := chat.postMessage(channel=ctx.channelId, thread_ts=undefined, ...)
    session := createSession(ctx.userId, ctx.userName,
                             ctx.channelId, rootResult.ts,
                             model=workflow.model)
    session.threadModel := 'bot-initiated'
    session.threadRootTs := rootResult.ts
    session.sourceThread := { channel: ctx.channelId, threadTs: ctx.threadTs }
    terminateSession(getSessionKey(ctx.channelId, ctx.threadTs))  // 있었다면
    // 원본 스레드에 🧵 링크만 남김
    chat.postMessage(channel=ctx.channelId, thread_ts=ctx.threadTs,
                     text='🧵 new thread: <link to Tnew_root>')

    releaseDispatchLock(getSessionKey(ctx.channelId, ctx.threadTs))
    => session, Tnew_root
```

**경로 1과의 핵심 차이:**
1. `sourceThread` 필드에 원본 스레드 기록.
2. `slack-mcp` 서버 등록 — 모델이 원본 스레드 히스토리 읽기 가능.
3. 원본 스레드에 🧵 링크 post.

---

## 경로 3 — 커맨드 처리

```pseudo
INPUT:  event = any message with first-token-is-command or prefix ∈ {'/','$','%','!','/z'}
OUTPUT: 커맨드 결과를 **원본 이니시에이션 스레드**에 say()로 회신. 세션 생성 없음(new 예외 제외).

// CommandRouter 등록 — command-router.ts:48-91
// (LlmChatHandler REMOVED in #639 together with the llmChatConfigStore subsystem.)
router := [
    AdminCommandHandler, PromptHandler, ..., SkillForceHandler ($local:*),
    SessionCommandHandler ($ prefix), ..., NewHandler, CompactHandler, LinkHandler,
    CloseHandler, ..., SessionHandler
]

function CommandRouter.route(ctx) -> { handled, continueWithPrompt? }:
    text := stripZPrefix(ctx.originalText)          // command-router.ts:112
                                                    //  '/z <cmd>' -> '<cmd>'
    for handler in router:                          // priority order
        if handler.canHandle(text):
            result := handler.execute({ ...ctx, text })
            return { handled: true, continueWithPrompt: result.continueWithPrompt }
                                                    // command-router.ts:140-161
    if looksLikeCommand(text):
        return { handled: true }                    // Claude 진입 차단

    return { handled: false }

// 호출부 — slack-handler.ts:360-381
function messageHandler.handle(ctx, event):
    cmdResult := CommandRouter.route(ctx)
    if cmdResult.handled:
        if cmdResult.continueWithPrompt:
            // 'new <prompt>' 경로 — slack-handler.ts:381
            -> continueWithPrompt(ctx, event); return
        // 🤖 → ⚡ 이모지 교체 — slack-handler.ts:360-366
        swapReaction(event, '🤖', '⚡')
        return     // 세션 생성 안 함

// 응답
handler.execute():
    say(text=result)    // Bolt say는 수신 context의 thread_ts 자동 상속
                        // → 이니시에이션 스레드에 정확히 회신
```

**특수 prefix:**
- `!` → abort (`handleAbort` — slack-handler.ts:301-329). 실행 중 세션 중단.
- `$` → `SessionCommandHandler` (세션 설정 토글).
- `$local:<skill>` → `SkillForceHandler`.
- `%...` → whitelist regex 통과시 비-admin DM에서도 허용 — slack/z/whitelist.ts:93.

---

## 경로 4 — 인라인 세션 (**TO-BE** 신규)

```pseudo
INPUT:  event = { type:'app_mention', thread_ts:Tparent, ts:T2, ... }  with skipBotInitiatedThread=true
OUTPUT: session { threadTs:Tparent, threadModel:'user-initiated', threadRootTs:undefined }
        // 새 스레드 **생성 안 함** - 원본 스레드 안에서 계속

// 트리거 진입
// (a) 단발 커맨드: '/z inline <prompt>' 또는 '$inline <prompt>'
// (b) 세션 설정: '$threadModel=user-initiated' (SessionCommandHandler)
function resolveThreadPolicy(ctx, userPrefs) -> skipBotInitiatedThread:
    if ctx.text startsWith '$inline' or '/z inline': return true
    if userPrefs.threadModelDefault == 'user-initiated': return true
    return false                                    // 기본: bot-initiated migrate

// initializeSession 분기 확장
function initializeSession_withOption(ctx, event, workflow, skipMigrate):
    sessionKey := getSessionKey(ctx.channelId, ctx.threadTs)
    if !acquireDispatchLock(sessionKey): return

    // MCP 등록은 경로 2와 동일 조건 (isMidThreadMention 충족 시 자동)
    if isMidThreadMention(ctx):
        attachSlackMcp(ctx)

    if skipMigrate:
        // 신규 분기
        threadTs := ctx.threadTs || event.ts  // 원본 스레드 유지, 없으면 이벤트 ts
        session := createSession(ctx.userId, ctx.userName,
                                 ctx.channelId, threadTs,
                                 model=workflow.model)
        session.threadModel := 'user-initiated'
        // threadRootTs 세팅 안 함
        // terminateSession 없음 - 기존 세션과 공존할 수 있도록 할지 여부는 Q2 FIFO와 맞물려 결정
    else:
        // 기존 경로 1/2와 동일
        -> createBotInitiatedThread(ctx, event, workflow)

    releaseDispatchLock(sessionKey)
    => session

// 응답 — event-router.ts:788은 변경 없음
workThreadTs := session.threadRootTs || session.threadTs
             // user-initiated일 때 threadRootTs=undefined이므로 threadTs(=원본)로 fallback
```

**변경 파일(예상):**
- [src/slack/pipeline/session-initializer.ts](../../src/slack/pipeline/session-initializer.ts) — `skipBotInitiatedThread` 플래그 도입, 호출 분기 [L492, L514](../../src/slack/pipeline/session-initializer.ts).
- [src/slack/commands/command-router.ts](../../src/slack/commands/command-router.ts) — SessionCommandHandler에 `$threadModel` 서브커맨드 추가.

---

## 경로 5 — DM 세션

```pseudo
INPUT:  event = { type:'message', channel:Dxxx, channel_type:'im', user:Uxxx, ts:T1, thread_ts?:Tparent, text, subtype:undefined }
OUTPUT (AS-IS):  session { threadTs:Tparent||'direct', threadModel:'bot-initiated' }
OUTPUT (TO-BE):  session { threadTs:event.thread_ts || event.ts }
                 + 봇 첫 응답이 thread_ts=event.ts로 thread 승격

// AS-IS — event-router.ts:91-108
on app.message(event):
    if !event.channel.startsWith('D'): return
    if event.subtype: return
    -> messageHandler.handle(ctx, event)            // ctx.threadTs = event.thread_ts (없으면 undefined)

// AS-IS (중복 방지) — event-router.ts:636-654
on app.event('message'):
    if event.channel_type === 'im': return          // Issue #553

// AS-IS messageHandler — slack-handler.ts:252
function messageHandler.handleDm(ctx, event):
    if isDmCleanupRequest(ctx.text):
        -> handleDmCleanupRequest(ctx); return      // slack-handler.ts:256
    if !isAdmin(ctx.userId) && !isDmAllowedForNonAdmin(ctx.text):
        reply("not allowed"); return                // slack-handler.ts:269-275
    if stripZPrefix(ctx.text) != null:
        -> routeDmViaZRouter(ctx); return            // slack-handler.ts:284-294, 598
    if !isAdmin(ctx.userId): reject; return          // slack-handler.ts:374-378
    sessionKey := getSessionKey(ctx.channelId, ctx.threadTs)    // thread_ts 없으면 Dxxx-direct
    -> initializeSession(ctx, event, workflow)
```

### TO-BE Q3: DM 1-per-thread (Slack Assistant pattern)

```pseudo
// TO-BE 패치 — event-router.ts:91-108
on app.message(event):
    if !event.channel.startsWith('D'): return
    if event.subtype: return
    // 새 로직: thread_ts 없으면 event.ts로 승격
    effectiveThreadTs := event.thread_ts || event.ts
    ctx := { channelId: event.channel,
             threadTs: effectiveThreadTs,
             mentionTs: event.ts,
             userId: event.user, text: event.text }
    -> messageHandler.handle(ctx, event)

// 봇 응답 post 시 항상 thread_ts 명시
function postDmReply(channel, threadTs, text):
    chat.postMessage(channel, text, thread_ts=threadTs, ...)
```

**효과:**
- 세션 키 `${Dxxx}-${event.ts}` — 메시지별로 분리된 세션 가능.
- 기존 `'direct'` 세션에 붙어 있던 기존 유저: alive면 그대로 두고 **다음 새 DM 메시지부터 thread 승격**. 마이그레이션 0.
- 스키마 변경 없음. 세션 키 공식 `${channelId}-${threadTs||'direct'}` 그대로.

---

## Q2 TO-BE: FIFO 큐 Pseudocode

```pseudo
// AS-IS 자료구조 — session-initializer.ts:29
dispatchInFlight: Map<sessionKey, Promise<void>>

// TO-BE 신규 필드
dispatchQueue: Map<sessionKey, Array<QueuedRequest>>
QUEUE_MAX := 5

type QueuedRequest = { ctx, event, enqueuedAt, statusMessageTs }

// 진입 — session-initializer.ts:309 변경
function enqueueOrExecute(ctx, event):
    sessionKey := getSessionKey(ctx.channelId, ctx.threadTs)
    if dispatchInFlight.has(sessionKey):
        queue := dispatchQueue.get(sessionKey) || []
        if queue.length >= QUEUE_MAX:
            oldest := queue.shift()
            notify(oldest, "timeout: too many pending requests")
        statusTs := addReaction(event, '🕒')
                    + postEphemeral("대기열: " + (queue.length+1) + "/" + QUEUE_MAX)
        queue.push({ ctx, event, enqueuedAt: now(), statusMessageTs: statusTs })
        dispatchQueue.set(sessionKey, queue)
        return QUEUED

    -> executeNow(ctx, event)

// 해제 — session-initializer.ts:724 변경
function onDispatchComplete(sessionKey):
    dispatchInFlight.delete(sessionKey)
    queue := dispatchQueue.get(sessionKey) || []
    if queue.length > 0:
        next := queue.shift()
        dispatchQueue.set(sessionKey, queue)
        removeReaction(next.event, '🕒')
        -> executeNow(next.ctx, next.event)

// per-request 30s 타임아웃: 기존 로직 유지 (큐에서 대기하는 시간은 타임아웃 제외)
```

**관측성:**
- 각 큐 push/pop 시 metric `slack.dispatch.queue.length` 기록.
- 큐 진입 알림 메시지(Block Kit)에 "N/5" 상태 라인.

---

## 부록: 이벤트 → 경로 결정 트리

```pseudo
function classifyEvent(event) -> path:
    if event.channel.startsWith('D'):
        return 'path-5-dm'
    if event.type == 'app_mention':
        if event.thread_ts && event.thread_ts != event.ts:
            return 'path-2-mid-thread'     // Gap 2
        return 'path-1-general'
    if event.type == 'message':
        if event.subtype == 'file_share':
            return 'file-upload'             // 본 문서 비대상
        if event.thread_ts:
            return 'thread-message'          // handleThreadMessage
        return 'ignored'                     // 멘션 없는 채널 메시지

// 커맨드 판별은 경로 결정 후 messageHandler 내부에서 — 경로 1/2/5 모두 통과 가능
function isCommand(text) -> boolean:
    text := stripZPrefix(text)
    return commandRouter.canHandle(text)     // command-router.ts:140
```
