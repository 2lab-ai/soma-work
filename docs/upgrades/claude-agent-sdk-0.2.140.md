# Claude Agent SDK Upgrade Guide: 0.2.111 → 0.2.140

> **현재**: `@anthropic-ai/claude-agent-sdk@^0.2.111`
> **목표**: `@anthropic-ai/claude-agent-sdk@^0.2.140`
> **작성일**: 2026-05-13
> **상위 변경**: Claude Code v2.1.112 → v2.1.140

---

## Executive Summary

29개 패치 버전 범위. 메이저/마이너 변경 없음. 신규 기능 9개, 비파괴 deprecation 4개,
SDK CHANGELOG에 **BREAKING으로 명시된 변경 1개**(`options.env` 시멘틱 — 우리 호출 패턴에는 영향 없음).

| 축 | 요약 | soma-work 영향도 |
|---|---|---|
| `options.env` 시멘틱 복원 (0.2.113) | overlay → replacement (다시 원래대로) | 🟢 **None** — `buildQueryEnv()`가 이미 `{...process.env, ...overrides}` 패턴 |
| `'Skill'` allowedTools deprecated (0.2.133) | `skills` 옵션으로 대체 | 🟡 **Soft** — `mcp-config-builder.ts:526`에서 push 중. 런타임 동작 정상, 경고만 |
| `TodoWrite` deprecated (0.2.136) | 향후 Task 도구로 분리 | 🟢 **None** — `src/`에서 직접 호출 없음 |
| `updatedMCPToolOutput` deprecated (0.2.121) | `updatedToolOutput`로 통일 | 🟢 **None** — 사용처 없음 |
| `unstable_v2_*` deprecated (0.2.133) | `query()` 단일 진입점 | 🟢 **None** — 사용처 없음 |
| 신규 옵션 (`skills`, `forwardSubagentText`, `sessionStore`, `managedSettings`, `title` 등) | 선택 채택 | 🟢 **None** — 옵트인 |

### 결론

코드 수정 없이 `package.json` 한 줄 + `npm install`로 안전하게 올라간다.
별도 PR에서 `Skill` → `skills` 마이그레이션을 권장 (런타임 영향 없는 정리 작업).

---

## soma-work 사용처 매핑

`@anthropic-ai/claude-agent-sdk`를 **직접 import하는 모듈은 9개 (src) + 7개 (테스트)**.
추가로 SDK를 import하지 않고 **도구 이름 문자열만 참조하는 결합점** 1곳.

### Import 결합 (TypeScript)

| 파일 | 사용 심볼 | 영향 |
|---|---|---|
| `src/claude-handler.ts` | `query`, `Options`, `SDKMessage`, hook types, `env` 옵션 | 영향 없음 (env 시멘틱 안전) |
| `src/conversation/summarizer.ts` | `Options`, `query` | 영향 없음 |
| `src/conversation/instructions-summarizer.ts` | `Options`, `query` | 영향 없음 |
| `src/conversation/title-generator.ts` | `Options`, `query` | 영향 없음 |
| `src/slack/z/topics/memory-improve.ts` | `Options`, `query` | 영향 없음 |
| `src/slack/stream-processor.ts` | `SDKMessage` | 영향 없음 |
| `src/slack/hooks/compact-hooks.ts` | `PostCompactHookInput`, `PreCompactHookInput`, `SessionStartHookInput` | 영향 없음 |
| `src/hooks/pr-issue-guard.ts` | `HookInput`, `HookJSONOutput` | 영향 없음 |
| `src/hooks/bypass-permission-guard.ts` | `HookInput`, `HookJSONOutput` | 영향 없음 |

테스트 import 7개: `claude-handler.integration`, `bypass-permission-guard`, `compact-hooks`,
`compact-fallback`, `stream-executor-compact`, `summarizer-thinking` (vi.mock), `session-summary-title` (vi.mock).

### 문자열 결합 (SDK import 없음, 런타임 surface)

| 파일 | 결합 | 영향 |
|---|---|---|
| `src/mcp-config-builder.ts:526` | `allowedTools.push('Skill')` — 도구 이름 문자열 | ⚠️ **deprecated 경고** (0.2.133) — 별도 PR 권장 |

이 모듈은 `@anthropic-ai/claude-agent-sdk`를 import하지 않으며, deprecation은 SDK
런타임이 옵션을 검사할 때만 발생한다 (TypeScript 빌드 단계에서는 감지 불가).

---

## 1. `options.env` 시멘틱 복원 (0.2.113) — Breaking이지만 사실상 No-op

### 변경 내용

> **Breaking**: `options.env` once again replaces `process.env` for the CLI
> subprocess instead of overlaying it. To add or override individual variables,
> pass `env: { ...process.env, MY_VAR: "x" }`

### soma-work 영향

soma-work는 이미 이 패턴을 **선제적으로** 적용해 둔 상태다. `src/auth/query-env-builder.ts:122-144`:

```ts
export function buildQueryEnv(lease: SlotAuthLease): QueryEnvResult {
  // Shallow-copy process.env into a plain record.
  for (const [key, value] of Object.entries(process.env)) {
    // ... copy
  }
  // Then add lease-specific overrides (token, CLAUDE_CONFIG_DIR, ...).
  ...
}
```

호출부 (`src/claude-handler.ts:693`):

```ts
const { env: queryEnv } = buildQueryEnv(lease);
const options: Options = {
  settingSources: ['project'],
  plugins: this.getEffectivePluginPaths(),
  env: queryEnv, // already a full {...process.env, ...overrides}
};
```

`docs/cct-token-rotation/spike-sdk-env.md`에서 spike로 검증된 설계대로다. 0.2.113의
"breaking change"는 우리에게는 **시멘틱 복원**이며, 런타임 동작에 변화 없다.

### 검증 결과

- `src/auth/__tests__/query-env-builder.test.ts` 15케이스 모두 통과 (0.2.111 / 0.2.140 동일)
- `claude-handler.integration.test.ts` 통과
- `npm ls @anthropic-ai/claude-agent-sdk` → `0.2.140` 확인

---

## 2. `'Skill'` in `allowedTools` deprecated (0.2.133) — Follow-up 권장

### 변경 내용

> Deprecated passing `'Skill'` in `allowedTools` — use the `skills` option instead.

### soma-work 위치

`src/mcp-config-builder.ts:525-526`:

```ts
// Add Skill tool for local plugins
allowedTools.push('Skill');
```

### 마이그레이션 방향 (별도 PR)

```ts
const options: Options = {
  // ... 기존 옵션
  skills: 'all', // 모든 등록된 skill 활성화
  // 또는
  skills: ['superpower:using-superpower', 'stv:new-task', /* ... */],
};
```

0.2.120에서 추가된 `skills: string[] | 'all'` 옵션이 정식 경로다. 기존
`allowedTools.push('Skill')`는 0.2.140에서 여전히 동작하지만 deprecation 경고
출력. 0.3.x에서 제거될 가능성 있으므로, 다음 정리 PR에서 다음 순서로 처리:

1. `mcp-config-builder.ts`의 `allowedTools.push('Skill')` 제거
2. `Options`에 `skills: 'all'` 추가 (또는 명시적 화이트리스트)
3. `mcp-config-builder.test.ts`, `mcp-config-builder-bypass-allowed-tools.test.ts`에서
   `expect(config.allowedTools).toContain('Skill')` 어서션 업데이트
4. `bypass-permission-guard.test.ts:49`의 `'Skill'` 토큰 제외 검증 유지

> **현재 PR 범위에서는 손대지 않음**. 런타임 동작 동일.

---

## 3. 신규 옵션 — 선택 채택

### 3.1 `skills` 옵션 (0.2.120, 0.2.133에서 정식 권장)

```ts
const options: Options = {
  skills: 'all' | string[],
};
```

`allowedTools.push('Skill')` 대체. 위 §2 참고.

### 3.2 `forwardSubagentText` (0.2.119)

```ts
const options: Options = {
  forwardSubagentText: true, // 서브에이전트 텍스트 델타를 메인 스트림으로 forward
};
```

소마-work는 현재 서브에이전트 출력을 별도 처리하지 않으므로 채택 불필요.
추후 Task 도구 기반 서브에이전트 UI 표시 시 검토.

### 3.3 `sessionStore` (0.2.113, alpha)

```ts
import { InMemorySessionStore, importSessionToStore } from '@anthropic-ai/claude-agent-sdk';

const store = new InMemorySessionStore();
const options: Options = { sessionStore: store };
```

세션 트랜스크립트를 외부 스토리지로 미러링. soma-work는 이미 자체 세션 영속화
(`session-registry.ts`)가 있어 직접 채택 불필요. 단, `SDKMirrorErrorMessage`
(`subtype: 'mirror_error'`) 메시지 타입이 `SDKMessage` union에 추가되었으므로,
스트림 핸들러가 unknown subtype을 안전하게 무시하는지 점검 권장 (현재 통과 확인).

### 3.4 `managedSettings` (0.2.118)

```ts
const options: Options = {
  managedSettings: { /* policy-tier settings */ },
};
```

IT-managed 정책 설정을 임베더가 in-memory로 주입. SaaS 운영 측면에서는 의미가 적음.

### 3.5 `title` (0.2.113)

```ts
const options: Options = { title: 'My Session' };
```

세션 자동 제목 생성 스킵. 우리는 `title-generator.ts`가 별도로 처리하므로
선택 채택 가능 — 자동 제목 생성을 SDK가 아닌 우리 쪽이 하기 때문이다.

### 3.6 `updatedToolOutput` in PostToolUseHook (0.2.121)

```ts
const hookReturn: PostToolUseHookSpecificOutput = {
  updatedToolOutput: 'new content', // 모든 도구의 출력 교체 가능 (MCP 한정 X)
};
```

`updatedMCPToolOutput`은 deprecated. 우리는 `compact-hooks.ts` 등에서 hook을
쓰지만 output 교체는 사용하지 않음 → 영향 없음.

### 3.7 `origin` on `SDKResultSuccess`/`SDKResultError` (0.2.126)

```ts
if (msg.type === 'result') {
  // msg.origin: 'user-prompt' | 'task-notification' | ...
}
```

`stream-processor.ts`에서 result 메시지 처리 시 user-prompt 결과와 task-notification
결과를 구분할 수 있게 됨. 현재 우리는 모든 result를 동일 처리 → 선택 채택.

### 3.8 `resolveSettings()` (0.2.136, alpha)

CLI를 실제로 spawn하지 않고 머지된 설정을 검사. 디버깅용. 현재 채택 불필요.

### 3.9 OpenTelemetry trace context propagation (0.2.113)

호출자의 active trace context가 CLI subprocess로 자동 전파됨. soma-work에 OTel
계측이 들어가면 자동으로 분산 추적이 동작. 코드 변경 불필요.

---

## 4. Reliability 개선 (0.2.119)

### 4.1 MCP 서버 자동 재연결

> Long-running SDK sessions now reconnect claude.ai-proxied MCP servers
> after a transport-stream abort.

장기 세션에서 MCP 서버 transport가 끊긴 경우 자동 복구. soma-work의 장기 백그라운드
세션(예: cron, deepwork)에서 안정성 향상 기대. 코드 변경 불필요.

### 4.2 `SessionStore.append()` 재시도

> SessionStore.append() failures are now retried up to 3 times with short
> backoff before the batch is dropped and `mirror_error` is emitted.

`sessionStore` 옵션을 쓰는 경우에만 해당. 우리는 미사용.

### 4.3 `excludeDynamicSections` 캐시 친화 개선

> `excludeDynamicSections` now keeps static auto-memory instructions in
> the cacheable system-prompt block; only the per-user memory directory
> path and per-machine environment values are relocated to the first
> user message.

프롬프트 캐시 적중률 개선. 우리가 `excludeDynamicSections`를 명시적으로 쓰지는
않지만, SDK 내부 캐시 친화도가 개선되어 비용 절감 가능.

---

## 5. 버전별 변경 (Verbatim, 0.2.112 → 0.2.140)

```text
0.2.112: Updated to parity with Claude Code v2.1.112
0.2.113: ★ Native Claude Code binary spawn (optional dep per-platform)
         ★ sessionStore option (alpha) + InMemorySessionStore + importSessionToStore + deleteSession
         ★ SDKMirrorErrorMessage subtype 추가
         ⚠ BREAKING: options.env replaces (not overlays) process.env
         ★ title option (skip auto-generate)
         ★ OpenTelemetry trace context propagation
0.2.114: parity v2.1.114
0.2.115: parity v2.1.115
0.2.116: parity v2.1.116
0.2.117: parity v2.1.117
0.2.118: ★ Options.managedSettings (policy-tier settings)
0.2.119: ★ forwardSubagentText option
         ★ excludeDynamicSections cache-friendly relocation
         ★ MCP reconnect after transport-stream abort
         ★ SessionStore.append() retry x3 with backoff
0.2.120: ★ skills option (string[] | 'all')
0.2.121: ★ updatedToolOutput in PostToolUseHookSpecificOutput
         ⚠ DEPRECATED: updatedMCPToolOutput
0.2.122: parity v2.1.122
0.2.123: parity v2.1.123
0.2.124: parity v2.1.124
0.2.125: parity v2.1.125
0.2.126: ★ origin on SDKResultSuccess/SDKResultError
0.2.127: parity v2.1.127
0.2.128: parity v2.1.128
0.2.129: parity v2.1.129
0.2.130: parity v2.1.130
0.2.131: parity v2.1.131
0.2.132: ★ applyFlagSettings() documented + null support to clear overrides
0.2.133: ⚠ DEPRECATED: unstable_v2_createSession / unstable_v2_resumeSession / unstable_v2_prompt
         ⚠ DEPRECATED: 'Skill' in allowedTools (use skills option)
0.2.134: parity v2.1.134
0.2.135: parity v2.1.135
0.2.136: ★ resolveSettings() (alpha) — inspect merged settings without spawn
         ⚠ DEPRECATED: TodoWrite tool (future: Task tools)
0.2.137: parity v2.1.137
0.2.138: parity v2.1.138
0.2.139: parity v2.1.139
0.2.140: parity v2.1.140
```

원본: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md

---

## 6. 검증 결과

### 6.1 의존성

```bash
$ npm ls @anthropic-ai/claude-agent-sdk --depth=0
soma-work@1.0.0
└── @anthropic-ai/claude-agent-sdk@0.2.140
```

`peerDependencies.zod ^4.0.0` 호환성 확인:

```bash
$ npm ls zod
soma-work@1.0.0
├── @anthropic-ai/claude-agent-sdk@0.2.140
│   ├── @anthropic-ai/sdk@0.81.0 → zod@4.3.6 (deduped)
│   └── zod@4.3.6
└── @modelcontextprotocol/sdk@1.29.0 → zod@4.3.6 (deduped)
```

soma-work는 `zod`를 직접 선언하지 않고, MCP SDK와 Agent SDK가 동일한 `zod@4.3.6`로
deduplication 됨. v3/v4 split 없음.

SDK의 `engines.node`는 `>=18.0.0`. soma-work는 `engines` 미지정 → 운영 환경(Node 20+)에서 충족.

### 6.2 Typecheck

```bash
$ npx tsc --noEmit
# (exit 0, no errors)
```

### 6.3 SDK 사용처 테스트 (508 tests)

```bash
$ npx vitest run src/auth src/conversation/__tests__ src/__tests__/claude-handler.integration.test.ts \
  src/slack/hooks/__tests__ src/slack/__tests__/summary-service.test.ts \
  src/hooks/__tests__/bypass-permission-guard.test.ts src/slack/z/topics/__tests__ \
  src/__tests__/mcp-config-builder.test.ts src/__tests__/mcp-config-builder-bypass-allowed-tools.test.ts
# Test Files  35 passed | 1 skipped (36)
#      Tests  508 passed | 5 skipped (513)
```

### 6.4 전체 테스트 baseline 동등성

`0.2.111` 베이스라인과 `0.2.140` 업그레이드 후의 전체 vitest 결과가 동일:

| | 0.2.111 (baseline) | 0.2.140 (upgrade) |
|---|---|---|
| Test Files | 4 failed / 299 passed / 1 skipped | 4 failed / 299 passed / 1 skipped |
| Tests | 37 failed / 6268 passed / 5 skipped | 37 failed / 6268 passed / 5 skipped |

37건의 실패는 `src/slack/pipeline/__tests__/session-initializer-workspace.test.ts`의
`statusManager.isEnabled is not a function` 목 누락 이슈로, main 브랜치에 이미
존재하며 SDK 업그레이드와 무관하다.

---

## 7. Out of scope

### 7.1 `2lab-ai/soma` (텔레그램 봇)

`2lab-ai/soma`도 `^0.2.111`을 사용 중. 동일 업그레이드 가능. 별도 PR로 진행 권장
— 본 PR 범위는 `soma-work`만.

### 7.2 `Skill` → `skills` 마이그레이션

`mcp-config-builder.ts:526`의 deprecated 패턴은 본 PR에서 손대지 않음.
런타임 영향 없는 정리 PR로 분리 권장 (§2 참고).

---

## 부록: PR-A `buildQueryEnv` 설계가 0.2.113 breaking change에 얼마나 잘 맞는지

`docs/cct-token-rotation/spike-sdk-env.md`에서 PR-A 단계에 이미 다음을 검증했다:

> "TL;DR: it reads from our arg, provided we pass the full env (or at
> least preserve PATH and the other vars the child process needs). The
> SDK does not merge process.env on top of our arg."

당시(`^0.2.x`의 초기) SDK는 이미 `child_process.spawn`의 native semantics —
`options.env`가 명시되면 process.env 머지 없음 — 을 따르고 있었고, 우리 설계는
"SDK가 환경을 inherit해 줄 거라 가정하지 말고 항상 풀 env를 만들어 넘기자"였다.

0.2.113은 이 native semantics를 명시적으로 다시 채택한 것이고, 우리는 이미 이
"방어적" 설계로 작성되어 있어 그대로 통과한다. **PR-A 설계의 사후적 정당화**.
