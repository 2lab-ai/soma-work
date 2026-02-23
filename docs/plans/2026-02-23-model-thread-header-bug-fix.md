# Model/Thread Header Regression Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 사용자 기본 모델 설정과 실제 대화 모델 간 불일치, 그리고 스레드 헤더/워크플로우 메시지 이상 현상을 최근 회귀 지점 기준으로 원인 분석 후 바로잡는다.

**Architecture:** `SessionInitializer -> SessionRegistry/ClaudeHandler -> StreamExecutor/ThreadHeaderBuilder` 흐름을 따라 모델/워크플로우 값이 어디서 고정되는지 추적하고, 사용자 기본값 갱신 경로와 새 스레드 헤더 생성 경로를 단일 정책으로 정렬한다.

**Tech Stack:** TypeScript, Vitest, Slack Block Kit, 파일 기반 설정/세션 저장소.

### Task 1: 모델 경로와 최근 회귀 범위 고정

**Files:**
- Modify: `src/slack/pipeline/session-initializer.ts`
- Modify: `src/claude-handler.ts`
- Modify: `src/session-registry.ts`
- Modify: `src/user-settings-store.ts`
- Modify: `src/slack/pipeline/session-initializer-routing.test.ts`
- Modify: `src/slack/pipeline/session-initializer-onboarding.test.ts`

**Step 1: Write the failing test**
`src/slack/pipeline/session-initializer-routing.test.ts`에 "세션 생성·강제 워크플로우 전환 후에도 세션.model이 사용자 기본값과 다르면 정상 갱신되어야 한다" 시나리오를 추가한다.

**Step 2: Run test to verify it fails**
Run: `npm test src/slack/pipeline/session-initializer-routing.test.ts src/slack/pipeline/session-initializer-onboarding.test.ts`
Expected: model 불일치 테스트에서 실패.

**Step 3: Write minimal implementation**
모델 선택을 `session.model || userDefaultModel`에서, 세션 상태(새 세션/재시작/강제 전환/온보딩 리셋) 규칙에 맞춰 보정하는 최소 수정으로 정렬한다.

**Step 4: Run test to verify it passes**
Run: `npm test src/slack/pipeline/session-initializer-routing.test.ts src/slack/pipeline/session-initializer-onboarding.test.ts`

### Task 2: thread-header/workflow 텍스트 정책 정합성 점검

**Files:**
- Modify: `src/slack/thread-header-builder.ts`
- Modify: `src/slack/pipeline/session-initializer.ts`
- Modify: `src/slack/thread-header-builder.test.ts`
- Modify: `src/slack/pipeline/session-initializer-routing.test.ts`

**Step 1: Write the failing test**
`thread-header-builder.test.ts`에 `workflow`가 fallback(`default`)로 고정되거나 제목/소유자 누락 시 메시지가 예상과 달라지는 케이스를 추가한다.

**Step 2: Run test to verify it fails**
Run: `npm test src/slack/thread-header-builder.test.ts`

**Step 3: Write minimal implementation**
헤더 빌드 시 workflow/제목/소유자/링크 노출 규칙을 명확히 정리하고, 최근 회귀로 인해 사라진/왜곡된 필드를 복원해야 할지 정책을 코드에 반영한다.

**Step 4: Run test to verify it passes**
Run: `npm test src/slack/thread-header-builder.test.ts`

### Task 3: 회귀 동작 E2E 검증 케이스

**Files:**
- Modify: `src/slack/pipeline/stream-executor.ts` (기존 콜백/로그 포인트 점검 필요 시만)
- Modify: `src/slack/pipeline/session-initializer.ts` (필요한 경우)
- Add: `src/slack/pipeline/session-init-header-workflow.spec.ts` (선택)

**Step 1: Write the failing test**
워크플로우 분류→헤더 생성→실제 메시지 posting 순서에서 `default` 고정/잘못된 workflow 표시를 잡는 통합 테스트를 추가한다.

**Step 2: Run test to verify it fails**
Run: `npm test src/slack/pipeline/session-init-header-workflow.spec.ts`

**Step 3: Write minimal implementation**
흐름상 어떤 단계에서 `workflow`가 바뀌는지 로그 포인트(혹은 mock assertion) 기준으로 보정한다.

**Step 4: Run test to verify it passes**
Run: `npm test src/slack/pipeline/session-init-header-workflow.spec.ts`

### Task 4: 회귀 방지 테스트 묶음 정리

**Files:**
- Modify: `src/slack/thread-header-builder.test.ts`
- Modify: `src/slack/pipeline/session-initializer-onboarding.test.ts`
- Modify: `src/slack/pipeline/session-initializer-routing.test.ts`

**Step 1: Write the failing test**
온보딩 강제 전환 및 새 스레드 생성 시 헤더/모델 동작이 기본값 정책을 따르는지 통합 검증 케이스를 보강한다.

**Step 2: Run test to verify it fails**
Run: `npm test src/slack/pipeline/session-initializer-routing.test.ts src/slack/pipeline/session-initializer-onboarding.test.ts`

**Step 3: Write minimal implementation**
테스트 기준을 충족하는 최소 수정으로 끝내고, 기존 동작(이미 통과한 워크플로우 라우팅)을 건드리지 않는다.

**Step 4: Run test to verify it passes**
Run: `npm test`
