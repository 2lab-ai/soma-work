# Session Workspace Isolation — Spec

> STV Spec | Created: 2026-03-25

## 1. Overview

현재 soma-work의 워킹 폴더는 `{BASE_DIRECTORY}/{userId}/`로 유저당 하나의 고정 디렉토리를 사용한다. 같은 유저의 복수 세션이 동일 폴더에서 동시 작업하면 git 커밋이 충돌한다. filesystem MCP는 BASE_DIRECTORY 전체에 접근 권한을 열어두어 유저 간 격리가 없다. macOS의 `/tmp` → `/private/tmp` 심볼릭 링크로 인해 bash와 MCP 사이에 경로 불일치가 발생한다.

이 기능은 세션별 유니크 워킹 폴더를 코드 레벨에서 강제하고, MCP filesystem 권한을 유저 범위로 동적 제한하며, /tmp 경로 정규화를 단일 지점에서 처리한다.

## 2. User Stories

- As a **soma-work 유저**, I want 각 세션이 독립된 워킹 폴더에서 작업하도록, so that 복수 세션의 git 커밋이 충돌하지 않는다.
- As a **soma-work 관리자**, I want 세션의 filesystem MCP 접근이 해당 유저의 /tmp/{slackId} 하위로 제한되도록, so that 다른 유저의 작업물에 접근할 수 없다.
- As a **soma-work 개발자**, I want /tmp 경로 정규화가 한 곳에서 처리되도록, so that bash와 MCP 간 경로 불일치 버그가 사라진다.

## 3. Acceptance Criteria

- [ ] 같은 유저의 2개 세션이 동시에 같은 repo에 대해 작업해도 서로 다른 디렉토리를 사용한다
- [ ] 워킹 폴더 경로가 `/tmp/{slackId}/{repoName}_{timestamp}_{prName}` 패턴을 따른다
- [ ] filesystem MCP의 allowed directory가 세션별로 `/tmp/{slackId}`로 제한된다
- [ ] 다른 유저의 `/tmp/{otherSlackId}` 폴더에 filesystem MCP로 접근 시 거부된다
- [ ] `/tmp`와 `/private/tmp` 어느 쪽을 사용하든 동일하게 동작한다
- [ ] 세션 종료 시 워킹 폴더가 자동 정리된다 (기존 sourceWorkingDirs 메커니즘 활용)
- [ ] 기존 `getWorkingDirectory()` 호출처가 정상 동작한다 (하위 호환)

## 4. Scope

### In-Scope
- `WorkingDirectoryManager.createSessionWorkingDir()` 추가
- `/tmp` 경로 정규화 유틸리티 (`normalizeTmpPath()`)
- `McpConfigBuilder.buildConfig()`에서 filesystem MCP args 동적 교체
- `McpServerFactory`에서 유저별 filesystem 서버 설정 지원
- 기존 `sourceWorkingDirs` cleanup 메커니즘과 연동

### Out-of-Scope
- 기존 `BASE_DIRECTORY` 기반 워킹 폴더 완전 제거 (하위 호환 유지)
- Bash 명령에 대한 경로 접근 제어 (Bash는 cwd 기반, 별도 보안 레이어)
- 워킹 폴더 용량 제한/모니터링
- 세션 간 워킹 폴더 공유 기능

## 5. Architecture

### 5.1 Layer Structure

```
세션 생성 (slack-handler)
  → WorkingDirectoryManager.createSessionWorkingDir(slackId, repoUrl, prName)
    → normalizeTmpPath() 로 경로 정규화
    → 유니크 디렉토리 생성 → 경로 반환
  → McpConfigBuilder.buildConfig(slackContext)
    → filesystem MCP args를 /tmp/{slackId} 로 동적 교체
  → ClaudeHandler.streamQuery(prompt, session, ..., workingDirectory)
    → options.cwd = workingDirectory (세션별 유니크 경로)
  → session-registry: sourceWorkingDirs에 경로 등록
    → 세션 종료 시 cleanup
```

### 5.2 Key Components

#### 5.2.1 normalizeTmpPath() — 경로 정규화

```typescript
// 위치: src/path-utils.ts (새 파일) 또는 session-registry.ts 내부
export function normalizeTmpPath(inputPath: string): string {
  // /private/tmp → /tmp 으로 통일 (또는 그 반대)
  // fs.realpathSync 활용하되, 존재하지 않는 경로도 처리
  // 한 번만 수행, 이후 모든 비교/저장은 정규화된 경로 사용
}
```

**결정**: macOS에서 `/tmp`는 `/private/tmp`의 심볼릭 링크. `fs.realpathSync('/tmp')`는 `/private/tmp`를 반환. 정규화 방향은 **`/private/tmp` → `/tmp`** (짧은 쪽으로 통일). 이유:
- bash에서 사람이 입력하는 경로는 `/tmp/...`
- 시스템 프롬프트/directive에서 사용하는 경로도 `/tmp/...`
- `/private/tmp`는 macOS 내부 구현 디테일

#### 5.2.2 WorkingDirectoryManager.createSessionWorkingDir()

```typescript
createSessionWorkingDir(slackId: string, repoName: string, prName: string): string {
  // 패턴: /tmp/{slackId}/{repoName}_{YYYYMMDD}_{HHmm}_{prName}
  const timestamp = formatTimestamp(new Date()); // 20260325_0959
  const safePrName = sanitize(prName); // 특수문자 제거
  const dirName = `${repoName}_${timestamp}_${safePrName}`;
  const fullPath = normalizeTmpPath(path.join('/tmp', slackId, dirName));
  fs.mkdirSync(fullPath, { recursive: true });
  return fullPath;
}
```

#### 5.2.3 McpConfigBuilder — filesystem MCP 동적 교체

```typescript
// buildConfig() 내부
if (slackContext?.user) {
  const userTmpDir = normalizeTmpPath(path.join('/tmp', slackContext.user));
  // filesystem MCP의 args에서 baseDirectory를 userTmpDir로 교체
  if (config.mcpServers?.filesystem) {
    const fsConfig = config.mcpServers.filesystem as McpStdioServerConfig;
    fsConfig.args = ['-y', '@modelcontextprotocol/server-filesystem', userTmpDir];
  }
}
```

### 5.3 Integration Points

| 기존 모듈 | 변경 내용 |
|-----------|-----------|
| `WorkingDirectoryManager` | `createSessionWorkingDir()` 추가, `getWorkingDirectory()` deprecated 유지 |
| `McpConfigBuilder.buildConfig()` | filesystem MCP args 동적 교체 로직 추가 |
| `McpServerFactory` | `provisionDefaultServers()`에서 baseDirectory 대신 유저별 경로 지원 |
| `session-registry.ts` | `isValidSourceWorkingDirPath()` 내부에서 `normalizeTmpPath()` 사용 |
| `source-working-dir-directive.ts` | path 검증 시 `normalizeTmpPath()` 적용 |
| `claude-handler.ts` | `streamQuery()`에 전달되는 workingDirectory가 세션별 유니크 경로 |

### 5.4 /tmp vs /private/tmp 정규화 전략

```
입력 경로                          정규화 결과
───────────────────────────────    ──────────────────
/tmp/U094E5L4A15/soma-work        /tmp/U094E5L4A15/soma-work
/private/tmp/U094E5L4A15/soma-work /tmp/U094E5L4A15/soma-work
```

**정규화 적용 지점:**
1. `createSessionWorkingDir()` — 생성 시 정규화
2. `isValidSourceWorkingDirPath()` — 검증 시 정규화
3. `addSourceWorkingDir()` — 등록 시 정규화 (기존 realpathSync 대체)
4. `McpConfigBuilder` — filesystem args 설정 시 정규화

## 6. Non-Functional Requirements

- **Performance**: 경로 정규화는 문자열 치환 수준 (< 1ms). 디렉토리 생성은 세션 시작 시 1회.
- **Security**: filesystem MCP가 유저별 /tmp/{slackId} 하위만 접근 가능. path traversal 기존 방어 유지.
- **Reliability**: 세션 비정상 종료 시에도 cleanup은 session-registry expiry 콜백으로 처리.
- **Backward Compatibility**: 기존 `getWorkingDirectory()`는 deprecated이나 동작 유지. 점진적 마이그레이션.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `normalizeTmpPath()` 정규화 방향: `/private/tmp` → `/tmp` | tiny | bash/프롬프트에서 `/tmp` 사용이 표준. `/private/tmp`는 macOS 내부 구현 |
| 유틸 함수 위치: 새 `src/path-utils.ts` 파일 | small | session-registry에 넣으면 순환 의존 가능성. 독립 유틸이 적합 |
| 디렉토리 네이밍: `{repoName}_{YYYYMMDD}_{HHmm}_{prName}` | tiny | 타임스탬프로 유니크성 보장 + `ls` 정렬 시 repo별 그룹핑 |
| `createSessionWorkingDir`의 prName 산입 방식: 특수문자 제거 후 kebab-case | tiny | 파일시스템 안전 + 가독성 |

## 8. Open Questions

None — 핵심 결정 2가지 (MCP 동적 주입, 기존 클래스 확장) 모두 유저 확인 완료.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/session-workspace-isolation/spec.md`
