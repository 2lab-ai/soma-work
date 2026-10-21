# 권한 규칙 — 단일 결정 파이프라인

`auth.md`는 *Claude API 인증*(누구로서 SDK를 부르나)을 다룬다. 이 문서는 **인가(authorization)** — *어떤 도구/행동을 허용하나* — 를 다룬다. 둘은 별개이며 섞지 않는다.

현재 인가 결정이 여러 위치 + MCP 권한서버 둘 + grant store 중복에 흩어져 있다(`docs/current/spec/architecture-map.md` §B). ADR 0002조차 "bypass-permission guard / dangerous-command filter / sensitive-path filter는 pass2+에서, 지금은 as-is"라고 미정리를 명시했다. 이 규칙이 그 수렴 목표를 고정한다.

## 절대 규칙

1. **모든 도구 허용/거부 판단은 단일 결정 함수를 통과한다.** 정식 진입점은 `agent-runtime/policy/tool-policy.ts`의 `evaluateToolPolicy`다. 새 권한 분기를 핸들러/훅/MCP 서버에 흩뿌리지 않는다 — 이 함수에 케이스를 추가한다.
2. **결정 계층 순서는 고정이며 우회 불가:** ① hard-deny(모드 무관) → ② grant 조회(영속) → ③ classifier(auto 모드, 위험 Bash) → ④ 사용자 프롬프트(fallback). 어느 핸들러도 이 순서를 건너뛰고 독자 허용하지 않는다.
3. **불확실하면 닫는다(fail-closed).** classifier 에러·타임아웃·미지 입력은 `ask`(또는 deny)로 귀결. 절대 fail-open 금지. 타임아웃은 실제 `AbortController`로 강제(선언만 하고 미연결 금지).
4. **grant store는 단일 구현 + 원자적.** `mcp-tool-grant-store`·`skill-grants`가 src/process-shared로 갈라지지 않게 한 곳으로. 읽고-수정-쓰기는 CAS, 저장은 `atomicWriteJson`(→ `config.md`).
5. **권한 결정의 기본값(default mode)은 한 곳에서만 정의한다.** `agent-runtime/policy/permission-mode.ts`. 다른 모듈이 자체 기본값을 재정의하지 않는다(현재 `mcp-config-builder`·`bypass-topic`·`user-settings-store`가 모드를 각자 해석 — 단일화 대상).

## 단일 파이프라인

```
도구 호출 요청
   │
   ▼
evaluateToolPolicy(tool, ctx, mode)         ← 유일한 결정 함수
   ├─ ① hard-deny tier (abort/ssh/민감경로/cross-user/…)         → DENY
   ├─ ② grant lookup (단일 grant store, 영속)                     → ALLOW
   ├─ ③ auto 모드 + 위험 Bash → safety-classifier (timeout=abort) → ALLOW | ASK
   └─ ④ 그 외                                                     → ASK(사용자 프롬프트)
   │
   ▼
PreToolUse 훅 / MCP 권한서버 = 위 결정의 **집행자**일 뿐, 독자 판단 금지
```

## 적용 범위

| 결정 종류 | 올바른 위치 | 비고 |
|---|---|---|
| 정적 hard-deny 규칙 | `policy/tool-policy.ts` | 모드 무관 1순위 |
| 위험 Bash 동적 판정 | `policy/safety-classifier.ts` | fail-closed, timeout=abort |
| 모드/기본값 해석 | `policy/permission-mode.ts` | 단일 정의 |
| grant 영속 | 단일 grant store | CAS + atomic |
| 집행(프롬프트/차단) | hooks · MCP 권한서버 · action handler | **결정 금지, 집행만** |

## 새 권한 분기 추가 시

1. 새 도구/행동을 막거나 허용해야 하면 → `evaluateToolPolicy`에 케이스 추가. 핸들러에서 즉석 분기 금지.
2. 사용자에게 grant를 묻는다면 → 단일 grant store + 단일 request store 사용, 응답 처리는 CAS(더블클릭 이중집행 방지).
3. classifier를 부른다면 → factory가 `AbortController`+timeout을 실제로 연결했는지 확인. 기본 모델은 싼 모델(세션 모델 상속 금지).

## 현재 위반 (수렴 대상)

- MCP 권한서버 둘(`mcp-servers/permission` + `mcp-servers/mcp-tool-permission`) — 역할 통합 또는 명확 분리 문서화.
- grant store 이중(`src/mcp-tool-grant-store.ts` ↔ `packages/process-shared/src/mcp-tool-grant-store.ts`), `click-classifier.ts` 이중(src ↔ @soma/slack) — 단일화.
- classifier 타임아웃 미연결(`safety-classifier-factory.ts:74-78`) — fail-closed 무력화. abort 연결.
- 모드 기본값이 `permission-mode`/`mcp-config-builder`/`bypass-topic`에 분산 — `permission-mode`로 단일화. (`off`→`auto` 의미역전, `false`→`auto` 무고지 강등도 여기서 정리.)
- 타입드 `goal`/스킬 명령 등 일부 경로가 owner guard를 건너뜀 — 모든 mutation을 동일 guard 통과.

## 검증

```bash
# 1) "허용" 결정이 정책 함수 밖에서 나는지 (정책/테스트 외 hits = 위반 후보)
rg -n "permissionDecision\s*[:=]\s*['\"]allow|behavior:\s*['\"]allow" src packages --type ts \
  -g '!*.test.ts' | rg -v "agent-runtime/policy/"

# 2) grant store / click-classifier 단일 구현 (각 1개여야)
rg -l "class .*GrantStore|mcp-tool-grant" src packages somalib --type ts -g '!*.test.ts'
rg -l "click-classifier" src packages --type ts -g '!*.test.ts' -g '!*import*'

# 3) classifier 타임아웃이 abort로 연결됐는지
rg -n "AbortController|timeoutMs" src/agent-runtime/policy/safety-classifier-factory.ts
```

계약 테스트로 고정: `permission-single-pipeline.contract.test.ts` — (a) `allow` 결정 소스가 `policy/` 밖에 없음, (b) grant/classifier store 단일, (c) classifier가 timeout 시 `ask`로 닫힘(주입 mock이 hang해도). ADR 0002 boundary 방식과 동일.
