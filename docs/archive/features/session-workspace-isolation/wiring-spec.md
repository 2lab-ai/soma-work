# Session Workspace Isolation — Wiring Integration Spec

> STV Spec | Created: 2026-03-25
> Parent: docs/session-workspace-isolation/spec.md (PR #77 infrastructure)
> Issue: #78 | PR: #77

## 1. Overview

PR #77은 세션 격리 인프라를 완성했으나 실제 세션 흐름에 연결하지 않았다.
이 spec은 **인프라 → 세션 파이프라인 연결(wiring)** 만 다룬다.

핵심 문제: `createSessionWorkingDir()`가 테스트에서만 호출되고, 실제 세션의 `cwd`는 여전히 고정 경로 `getWorkingDirectory()` → `/tmp/{userId}/`를 사용한다.

## 2. AS-IS (PR #77 상태)

```
SlackHandler.handleMessage()
  → SessionInitializer.validateWorkingDirectory(event)
    → MessageValidator.validateWorkingDirectory(userId, channelId, threadTs)
      → WorkingDirectoryManager.getWorkingDirectory()  ← 고정: /tmp/{userId}/
    → returns { workingDirectory: "/tmp/{userId}/" }
  → SessionInitializer.initialize(event, workingDirectory)
    → SessionInitResult { workingDirectory: "/tmp/{userId}/" }
  → StreamExecutor.execute({ workingDirectory: "/tmp/{userId}/" })
    → ClaudeHandler.streamQuery(prompt, session, abort, "/tmp/{userId}/", slackContext)
      → options.cwd = "/tmp/{userId}/"   ← 모든 세션이 동일 경로
```

**결과**: 같은 유저의 2개 세션이 동시에 `/tmp/{userId}/`에서 작업 → git 충돌 발생.

## 3. TO-BE

```
SlackHandler.handleMessage()
  → SessionInitializer.validateWorkingDirectory(event)
    → 기존과 동일 (base dir 검증)
  → SessionInitializer.initialize(event, workingDirectory)
    → [NEW] 새 세션이면 session-unique cwd 생성
    → [NEW] session.sessionWorkingDir = "/tmp/{userId}/session_{epochMs}_{counter}/"
    → SessionInitResult { workingDirectory: session.sessionWorkingDir }
  → StreamExecutor.execute({ workingDirectory: session.sessionWorkingDir })
    → ClaudeHandler.streamQuery(..., session.sessionWorkingDir, ...)
      → options.cwd = "/tmp/{userId}/session_{epochMs}_{counter}/"  ← 세션별 유니크
```

**핵심 변경**: 새 세션 생성 시 유니크 cwd를 자동 생성하여 세션 수명과 함께 관리한다.

## 4. Design Decisions

### D1: 모든 세션에 유니크 cwd vs repo-work 세션만

**결정**: 모든 세션에 유니크 cwd 부여.
- 이유: 워크플로우 타입은 dispatch 이후에 결정되지만, cwd는 dispatch 전에 필요
- 추가 비용: mkdir 1회 (< 1ms)
- 이점: 세션 간 간섭 원천 차단

### D2: 유니크 cwd 패턴

**결정**: `/tmp/{userId}/session_{epochMs}_{counter}/`
- `createSessionWorkingDir()`는 repoUrl/prName이 필요하므로 세션 base dir 용도로 부적합
- 새 메서드 `createSessionBaseDir(slackId)` 추가
- 모델이 이 cwd 안에서 `createSessionWorkingDir()` 패턴으로 repo 클론

### D3: 기존 세션 backward compatibility

**결정**: 기존 세션(sessionWorkingDir 없는)은 `getWorkingDirectory()` 폴백 유지.
- session.sessionWorkingDir가 있으면 사용
- 없으면 기존 getWorkingDirectory() 결과 사용
- 무중단 배포 가능

### D4: sessionWorkingDir과 sourceWorkingDirs 관계

**결정**: sessionWorkingDir은 자동으로 sourceWorkingDirs에 등록.
- 세션 종료 시 sessionWorkingDir도 cleanup 대상
- 별도 directive 없이 자동 관리

## 5. Acceptance Criteria

- [ ] 새 세션의 cwd가 `/tmp/{userId}/session_{epochMs}_{counter}/` 패턴
- [ ] 같은 유저의 2개 동시 세션이 서로 다른 cwd 사용
- [ ] 기존 세션(sessionWorkingDir 없는)이 정상 동작 (하위 호환)
- [ ] 세션 종료 시 sessionWorkingDir 자동 cleanup
- [ ] sessionWorkingDir이 session.sourceWorkingDirs에 자동 등록

## 6. Scope

### In-Scope
| 컴포넌트 | 변경 |
|----------|------|
| `src/types.ts` | `ConversationSession`에 `sessionWorkingDir?: string` 추가 |
| `src/working-directory-manager.ts` | `createSessionBaseDir(slackId)` 메서드 추가 |
| `src/slack/pipeline/session-initializer.ts` | 새 세션 시 sessionWorkingDir 생성 + sourceWorkingDirs 등록 |
| `src/slack-handler.ts` | sessionResult.workingDirectory 우선순위 반영 |

### Out-of-Scope
- `createSessionWorkingDir()` 변경 (기존 그대로 — 모델이 repo 클론 시 사용)
- 프롬프트 변경 (common.prompt는 이미 유니크 폴더 지시 포함)
- MCP filesystem 제한 (PR #77에서 이미 구현)

## 7. Risk

| 리스크 | 완화 |
|--------|------|
| session 직렬화/역직렬화 시 sessionWorkingDir 손실 | SessionRegistry 직렬화에 필드 포함 확인 |
| 디스크 용량 증가 (세션당 빈 폴더) | cleanup이 이미 구현됨. 빈 폴더는 4KB |
| 기존 테스트 regression | backward compat 보장 |
