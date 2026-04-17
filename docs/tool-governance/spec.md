# Tool Governance Classifier — Spec

> STV Spec | Created: 2026-04-17
> Related: docs/governance-db/spec.md (persists this spec's output)
> Reference: mkurman/tamux @ `06cb904b33f6e881f5b3bd3e7a147984a8d9ff4f`

## 1. Overview

### Proposal
- **Why**: 현재 `src/dangerous-command-filter.ts` (113줄)는 **binary** 분류(위험 / 비위험)만 하고, Bash 명령 문자열만 검사한다. MCP 툴 인자(`write_file({path: '~/.ssh/id_rsa'})`, `send_slack_message({message: '@everyone …'})`) 전부 무검사 통과. 승인 UI도 "dangerous-regex 매치 → Slack 버튼, 아니면 무심사"의 이분법이라 승인 피로와 감사 누락을 동시에 유발.
- **What Changes**: 툴별(per-MCP-tool) 4-클래스 결정적 분류기 + LLM 재검증 slow path를 도입. `src/claude-handler.ts:570-803`의 `PreToolUse` hook 배열에 새 hook 블록으로 플러그인. 분류 결과(`class`, `reasons[]`, `policy_fingerprint`)를 감사용으로 반환.
- **Capabilities**: 툴 인자 기반 위험 감지, suspicion reasons 감사 로그, LLM 재검증 경로(의심 사유 있을 때만), 정책 지문(fingerprint) 기반 승인 재사용 가능성.
- **Impact**: 새 디렉토리 `src/tool-governance/`. `src/claude-handler.ts` hook 배열에 블록 추가 (~30줄). `src/dangerous-command-filter.ts`는 유지하되 shell-suspicion 서브루틴으로 호출됨. BREAKING 없음 (기본 동작은 현재와 동일: classifier 비활성 시 AllowDirect).

현재 gate는 regex 12개 + 사용자 승인 버튼 조합뿐이다. 멀티테넌트 Slack SaaS에서 이는 공격 표면 확대와 승인 피로 확대를 동시에 만든다. tamux의 WELES-style 구조를 그대로가 아니라 soma-work의 실제 MCP 툴 inventory에 맞춰 이식한다. 데몬 프로세스는 도입하지 않는다 (SPOF 회피).

## 2. User Stories

- As a **멀티테넌트 운영자**, I want 툴 호출에 대한 위험 verdict가 감사 로그에 기록되길 원한다, so that SOC2/GDPR/고객 감사 요청에 답할 수 있다.
- As a **Slack 유저**, I want bypass 모드에서 진짜 위험한 경우에만 승인 프롬프트가 뜨길 원한다, so that 기계적 승인 클릭을 멈출 수 있다.
- As a **보안 담당자**, I want `write_file`, `send_slack_message`, `switch_model` 등 bash 이외의 툴도 자동 차단/재검증되길 원한다, so that 공격 표면이 bash 외 경로로 새지 않는다.
- As a **개발자**, I want 새 MCP 툴을 추가할 때 분류 규칙을 한 곳에 등록할 수 있다, so that 거버넌스가 툴 증가와 함께 drift 하지 않는다.

## 3. Acceptance Criteria

- [ ] `classifyToolCall(toolName, args): { class, reasons[] }` 순수 함수 제공 — 4-클래스 verdict (`AllowDirect` / `GuardIfSuspicious` / `GuardAlways` / `RejectBypass`).
- [ ] 분류 테이블이 soma-work의 실제 MCP 툴 inventory를 커버 — slack-mcp (send_thread_message, send_file, send_media), model-command (SAVE_MEMORY, MANAGE_SKILL, SAVE_CONTEXT_RESULT), server-tools (db_query, redis_query 등), mcp-tool-permission (request_permission, revoke_permission), agent (chat, chat-reply), llm (chat, cancel), cron (cron_create, cron_delete).
- [ ] Built-in 툴(Bash/Read/Write/Edit/Glob/Grep)도 분류 대상 — Write/Edit의 `file_path`, Bash의 `command`, Read의 `file_path`를 검사.
- [ ] Suspicion extractor — 최소 아래 4개 커버:
    - shell: pipe-to-shell (`| sh`, `| bash`), 네트워크 (`curl/wget/http(s)://`), destructive (`rm -rf/chmod/chown/>`), 기존 `dangerous-command-filter` 패턴 흡수
    - file: `.env / credential / token / .ssh / id_rsa / authorized_keys / /etc/ / config.json` 경로 매치
    - messaging (slack-mcp): `@everyone / @here` broadcast mention 토큰 검출
    - delegation: `agent.chat` 재귀 호출 depth ≥2, 동시 subagent fan-out (별도 stv-내부 상태 필요 시 Phase 2 이연)
- [ ] `decide(classification): { decision, needsLLMReview, blockMessage? }` 순수 함수 — verdict + reasons → `'allow' | 'deny' | 'ask'` (+ async re-verify 필요 여부).
- [ ] `src/claude-handler.ts`의 `PreToolUse` hook 배열에 새 블록 추가 — `matcher: 'mcp__'`, Bash/Write/Edit 별도 matcher. 결과에 따라 `permissionDecision` 설정.
- [ ] 각 분류 결과는 `GovernanceEvaluation` 객체로 표준화되어 governance-db 저장 훅으로 전달 — 저장 로직 자체는 Issue B가 담당하되, hook point는 본 Issue에서 노출.
- [ ] Policy fingerprint 해시 알고리즘 정의 — `sha256(tool_name + normalized_args_schema + rule_version)`의 hex prefix 16. governance-db가 이 지문을 저장/조회에 사용.
- [ ] LLM 재검증 경로 — `GuardAlways` 또는 `GuardIfSuspicious`+reasons 일 때 `llm_chat` MCP에 2-turn prompt ("is this action safe given these reasons?"). **기본 timeout 3초, 실패 시 fail-safe → ask**.
- [ ] 기존 admin bypass/cross-user isolation/sensitive-path 가드는 그대로 유지 — classifier는 이들 **뒤에** 실행 (deny가 먼저 이기면 classifier 호출도 생략).
- [ ] 설정 파일 `classification-rules.json` (또는 TS 상수) 한 곳 — 툴명 → class/reasons-extractor 매핑. 새 MCP 툴 추가 시 이 테이블만 업데이트.
- [ ] Unit test 각 툴 카테고리 최소 3케이스 (통과/의심/차단) + soma-work 특이 케이스 (`~/.ssh`, `@everyone`, `SAVE_MEMORY`+민감 키워드).

## 4. Scope

### In-Scope
- `src/tool-governance/classifier.ts` — 분류 dispatch + suspicion extractors (~250줄)
- `src/tool-governance/decide.ts` — decision router + LLM re-verify trigger (~100줄)
- `src/tool-governance/fingerprint.ts` — policy fingerprint 해시 (~40줄)
- `src/tool-governance/rules.ts` — 툴 → 분류 매핑 테이블 (~150줄, soma-work 툴 inventory 전체)
- `src/tool-governance/types.ts` — `GovernanceClass`, `ToolClassification`, `GovernanceEvaluation`, `GovernanceDecision` (~80줄)
- `src/claude-handler.ts` — `PreToolUse` hook 배열에 classifier 블록 추가 (~40줄 delta)
- `src/dangerous-command-filter.ts` — 기존 export 유지, 내부는 `classifier.ts`의 shell-suspicion 함수를 호출하도록 점진 마이그레이션 (이번 이슈에선 호출만, 제거는 Phase 2)
- LLM 재검증 호출은 기존 `llm_chat` MCP 재사용 — 새 인프라 0
- Hook point → `GovernanceEvaluation` 객체 emit (governance-db가 구독)

### Out-of-Scope (다른 이슈)
- SQLite 저장 레이어 → `docs/governance-db/`
- UI: Slack 승인 버튼 메시지 개선 → 현재 `permission-mcp-server.ts` 재사용
- `dangerous-command-filter.ts` 완전 제거 — Phase 2
- Policy fingerprint 기반 **auto-approve** 로직 → governance-db가 조회/매칭 담당
- Debate/consensus/metacognition (tamux 서브시스템) — 가치 대비 복잡도 부적합
- Slavic 신명 브랜딩 — 의미 없음
- tamux `WELES_CONTEXT_MARKER` 방식의 프롬프트 JSON 덤프 — 토큰 낭비, 2-turn tight prompt로 대체

## 5. Architecture

### 5.1 Layer Structure

```
Claude Agent SDK PreToolUse hook 
    ├── [existing] abort guard
    ├── [existing] SSH restriction (non-admin)
    ├── [existing] sensitive path guard (Bash/Read/Glob/Grep)
    ├── [existing] cross-user tmp isolation
    ├── [existing] bypass Bash gate (dangerous-command-filter)
    ├── [existing] MCP tool grant check (permission-mcp-server)
    │
    └── [NEW] Tool Governance Classifier
            │
            ├── classifyToolCall(tool, args) → Classification {class, reasons[]}
            ├── computePolicyFingerprint(tool, args) → string
            ├── decide(classification) → {decision, needsLLMReview}
            │
            ├── if needsLLMReview: llmReverify(args, reasons) (3s timeout)
            │
            ├── emit GovernanceEvaluation → (Issue B: writes to SQLite)
            │
            └── return hookSpecificOutput: {permissionDecision: allow|deny|ask}
```

### 5.2 Data Flow

```
tool_call (from Claude) 
  → SDK → PreToolUse hook chain
  → reaches classifier hook
  → classifyToolCall dispatch by tool_name:
       "mcp__slack-mcp__send_thread_message" → messagingRules
       "mcp__model-command__run"             → modelCommandRules (inspect args.name)
       "Write" / "Edit"                      → patchRules (file_path)
       "Bash"                                → shellRules (command string)
       "mcp__server-tools__db_query"         → dbQueryRules (read-only allow)
       "mcp__mcp-tool-permission__revoke"    → adminOnlyRules
       ...
  → classification {class, reasons[]}
  → fingerprint = sha256(tool + normalized_args_shape + RULES_VERSION)[:16]
  → decide(classification):
       AllowDirect               → {decision:'allow', needsLLMReview:false}
       GuardIfSuspicious+no-reasons → {decision:'allow', needsLLMReview:false}
       GuardIfSuspicious+reasons → {decision:'ask',   needsLLMReview:true}
       GuardAlways               → {decision:'ask',   needsLLMReview:true}
       RejectBypass              → {decision:'deny',  needsLLMReview:false}
  → if needsLLMReview:
       llmReverify(args, reasons) via llm_chat MCP (3s timeout)
       verdict='safe' → decision='allow'
       verdict='unsafe' or timeout → decision='ask' (Slack button)
  → emit GovernanceEvaluation { fingerprint, class, reasons, llmVerdict?, timestamp, user, tool }
  → return {hookSpecificOutput:{permissionDecision}}
```

### 5.3 File Structure

```
src/tool-governance/
├── types.ts            # GovernanceClass enum, ToolClassification, GovernanceEvaluation, GovernanceDecision
├── rules.ts            # TOOL_RULES: Map<tool_name_or_matcher, {class, extractor?}>
├── classifier.ts       # classifyToolCall + per-category suspicion extractors
├── fingerprint.ts      # computePolicyFingerprint(tool, args): string (hex16)
├── decide.ts           # decide(classification) → GovernanceDecision; llmReverify()
├── emitter.ts          # emitGovernanceEvaluation(eval) — subscribed by governance-db
└── *.test.ts           # per-module unit tests

src/claude-handler.ts
   └── [edit] PreToolUse hooks array → push classifier hook block
```

### 5.4 Type Definitions

```typescript
// src/tool-governance/types.ts

export type GovernanceClass = 
  | 'AllowDirect'
  | 'GuardIfSuspicious'
  | 'GuardAlways'
  | 'RejectBypass';

export interface ToolClassification {
  readonly class: GovernanceClass;
  readonly reasons: readonly string[];
}

export interface GovernanceEvaluation {
  readonly id: string;                    // uuid v7 for ordered keys
  readonly toolName: string;
  readonly toolArgs: unknown;             // will be JSON-stringified by emitter
  readonly classification: ToolClassification;
  readonly policyFingerprint: string;     // sha256 hex16
  readonly llmReverifyResult?: 'safe' | 'unsafe' | 'timeout' | 'error';
  readonly finalDecision: 'allow' | 'deny' | 'ask';
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly threadTs?: string;
  readonly createdAt: number;             // ms since epoch
}

export interface GovernanceDecision {
  readonly decision: 'allow' | 'deny' | 'ask';
  readonly needsLLMReview: boolean;
  readonly blockMessage?: string;         // for 'deny' UI surface
}
```

### 5.5 Rule Table Shape (Adaptation Example)

```typescript
// src/tool-governance/rules.ts (excerpt)
export const TOOL_RULES: Record<string, ToolRule> = {
  // Claude SDK built-ins
  'Bash': { class: 'GuardIfSuspicious', extractor: shellReasons },
  'Write': { class: 'GuardIfSuspicious', extractor: patchReasons },
  'Edit': { class: 'GuardIfSuspicious', extractor: patchReasons },
  'Read': { class: 'AllowDirect' },              // already gated by sensitive-path guard

  // slack-mcp
  'mcp__slack-mcp__send_thread_message': { class: 'GuardIfSuspicious', extractor: slackMsgReasons },
  'mcp__slack-mcp__send_file':           { class: 'GuardIfSuspicious', extractor: slackFileReasons },
  'mcp__slack-mcp__send_media':          { class: 'GuardIfSuspicious', extractor: slackMsgReasons },
  'mcp__slack-mcp__get_thread_messages': { class: 'AllowDirect' },
  'mcp__slack-mcp__download_thread_file':{ class: 'AllowDirect' },

  // server-tools (SELECT-only enforced inline — still audit)
  'mcp__server-tools__db_query':       { class: 'AllowDirect' },
  'mcp__server-tools__redis_query':    { class: 'AllowDirect' },
  'mcp__server-tools__mongodb_query':  { class: 'AllowDirect' },
  'mcp__server-tools__clickhouse_query':{ class: 'AllowDirect' },

  // model-command (state mutation)
  'mcp__model-command__run':   { class: 'GuardIfSuspicious', extractor: modelCommandReasons },
  'mcp__model-command__list':  { class: 'AllowDirect' },

  // agent (fan-out)
  'mcp__agent__chat':       { class: 'GuardIfSuspicious', extractor: delegationReasons },
  'mcp__agent__chat-reply': { class: 'AllowDirect' },

  // llm
  'mcp__llm__chat':       { class: 'AllowDirect' },
  'mcp__llm__cancel':     { class: 'GuardAlways' },
  'mcp__llm__chat-reply': { class: 'AllowDirect' },
  'mcp__llm__status':     { class: 'AllowDirect' },
  'mcp__llm__result':     { class: 'AllowDirect' },

  // cron (scheduling mutation)
  'mcp__cron__cron_create': { class: 'GuardAlways' },
  'mcp__cron__cron_delete': { class: 'GuardAlways' },
  'mcp__cron__cron_list':   { class: 'AllowDirect' },
  'mcp__cron__cron_history':{ class: 'AllowDirect' },

  // mcp-tool-permission (grant mutation)
  'mcp__mcp-tool-permission__request_permission': { class: 'GuardIfSuspicious', extractor: grantReasons },
  'mcp__mcp-tool-permission__check_permission':   { class: 'AllowDirect' },
  'mcp__mcp-tool-permission__revoke_permission':  { class: 'GuardAlways' },  // admin-only enforced upstream
};
```

### 5.6 LLM Re-verify Prompt (tight, 2-turn)

```
System: You are a tool-call safety reviewer. Given the tool name, arguments, 
and suspicion reasons, reply with a single JSON object: 
{"verdict": "safe" | "unsafe", "reason": string}.
Be strict. If unsure, reply "unsafe".

User: tool=mcp__slack-mcp__send_thread_message
args={"message": "@everyone DEPLOYMENT EMERGENCY", "channel": "CXXX"}
reasons=["message contains broadcast-style mention"]
```

Cost budget per call: ~200 input tokens + ~30 output tokens. Timeout: 3s. Fail-safe: `'ask'`.

## 6. Performance / Non-Functional

- Classifier dispatch: O(1) map lookup + O(n) regex list per extractor (12-20 patterns per category). p50 < 1ms, p95 < 5ms.
- LLM re-verify: only triggered for `GuardAlways` (rare) + `GuardIfSuspicious` with non-empty reasons. Expected < 10% of all tool calls. Latency p95 < 3s (timeout).
- Emitter (governance-db write) must be **non-blocking** — fire-and-forget with logger.error on failure. Tool call latency must not depend on DB write.

## 7. Security Model

- Classifier runs **inside the SDK hook chain**, so decision is enforced before tool dispatch. No race window.
- Rules are **deploy-time static** (TS constants) — no runtime rule injection. Rule changes require code review + redeploy.
- LLM re-verify prompt escapes user-provided `toolArgs` as JSON — no prompt injection via argument values.
- Fail-safe: classifier exception → `'ask'` (never `'allow'`).

## 8. Open Questions

1. **Delegation fan-out tracking** — tamux uses `current_depth` and `capability_tags`. soma-work has no depth tracker for `agent.chat` recursion. Defer to Phase 2 or introduce `X-Soma-Agent-Depth` context header now? **Decision gate threshold: small. Autonomous: defer — add a TODO placeholder that always returns no-reasons, revisit when autonomous agent chains are more prevalent.**
2. **`rules.ts` vs config file** — compile-time TS constant OR JSON file in `{CONFIG_FILE}` dir? **Autonomous: TS constant — prevents tampering, reviewable in PRs, no hot-reload complexity.**
3. **LLM re-verify inside PreToolUse hook** — hooks block the tool call. 3s timeout is acceptable per Claude SDK docs. Confirmed safe (existing MCP grant check hook already does async round-trip).

## 9. Rollout Plan

- Phase A (this issue): classifier active but `emitGovernanceEvaluation` is noop (governance-db not yet ready). Shadow mode — log verdicts to file `{DATA_DIR}/governance-shadow.jsonl`.
- Phase B (governance-db issue merged): emitter writes to SQLite. Tool governance becomes the authoritative gate.
- Phase C (later): `dangerous-command-filter.ts` internals replaced by classifier call; public surface preserved.

## 10. Dependencies

- **Blocks**: Issue B (governance-db) — B needs A's `GovernanceEvaluation` shape + `policyFingerprint` algorithm to persist correctly.
- **Blocked by**: None. A can ship standalone in shadow mode.
- **Related**: `docs/mcp-tool-permission/` — existing grant system remains in front of classifier. A does NOT replace grant logic; it adds finer-grained risk scoring on top.
