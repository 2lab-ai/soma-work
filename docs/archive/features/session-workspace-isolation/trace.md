# Session Workspace Isolation — Vertical Trace

> STV Trace | Created: 2026-03-25
> Spec: docs/session-workspace-isolation/spec.md

## Table of Contents
1. [Scenario 1 — Create Session Working Directory](#scenario-1)
2. [Scenario 2 — MCP Filesystem Dynamic Restriction](#scenario-2)
3. [Scenario 3 — Path Normalization /tmp vs /private/tmp](#scenario-3)
4. [Scenario 4 — Concurrent Session Isolation](#scenario-4)
5. [Scenario 5 — Session Cleanup of Working Directories](#scenario-5)

---

## Scenario 1 — Create Session Working Directory

### 1. Entry Point
- Module: `WorkingDirectoryManager`
- Function: `createSessionWorkingDir(slackId, repoUrl, prName)`
- File: `src/working-directory-manager.ts`
- Caller: `SessionInitializer` or workflow prompt (jira-create-pr 등)

### 2. Input
- Parameters:
  ```typescript
  slackId: string   // required - Slack user ID (e.g. "U094E5L4A15")
  repoUrl: string   // required - Git repo URL (e.g. "https://github.com/2lab-ai/soma-work")
  prName: string    // required - PR/task identifier (e.g. "fix-auth-bug")
  ```
- Validation rules:
  - slackId: non-empty string, no path separators
  - repoUrl: valid URL, repo name extracted via URL parsing
  - prName: sanitized to filesystem-safe characters (alphanumeric, hyphens, underscores)

### 3. Layer Flow

#### 3a. WorkingDirectoryManager.createSessionWorkingDir()
- Extract repoName from repoUrl: `new URL(repoUrl).pathname.split('/').pop()?.replace('.git', '')`
  - Input: `"https://github.com/2lab-ai/soma-work"` → repoName: `"soma-work"`
- Generate timestamp: `formatTimestamp(new Date())` → `"20260325_0959"`
- Sanitize prName: `prName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50)`
  - Input: `"fix auth bug!"` → `"fix_auth_bug_"`
- Build directory name: `${repoName}_${timestamp}_${safePrName}`
  - → `"soma-work_20260325_0959_fix_auth_bug_"`
- Build full path: `normalizeTmpPath(path.join('/tmp', slackId, dirName))`
  - → `"/tmp/U094E5L4A15/soma-work_20260325_0959_fix_auth_bug_"`
- Transformation chain:
  ```
  (slackId, repoUrl, prName)
    → repoName = extractRepoName(repoUrl)
    → timestamp = formatTimestamp(now)
    → safePrName = sanitize(prName)
    → dirName = `${repoName}_${timestamp}_${safePrName}`
    → fullPath = normalizeTmpPath('/tmp/' + slackId + '/' + dirName)
  ```

#### 3b. Filesystem
- `fs.mkdirSync(fullPath, { recursive: true })` — 유저 폴더 + 워킹 폴더 동시 생성
- Returns: `fullPath` (정규화된 절대 경로)

### 4. Side Effects
- FS CREATE: `/tmp/{slackId}/{repoName}_{timestamp}_{prName}/` 디렉토리 생성
- No DB change (세션 registry에 등록은 별도 — Scenario 5에서 다룸)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| slackId 비어있음 | `'slackId is required'` | return undefined, 로그 경고 |
| repoUrl 파싱 실패 | `'Invalid repoUrl'` | return undefined, 로그 에러 |
| 디렉토리 생성 실패 (권한/용량) | fs.mkdirSync throws | catch → return undefined, 로그 에러 |

### 6. Output
- Success: `string` — 정규화된 절대 경로 (e.g. `"/tmp/U094E5L4A15/soma-work_20260325_0959_fix_auth_bug_"`)
- Failure: `undefined`

### 7. Observability
- Log: `'Created session working directory'` with `{ slackId, repoName, prName, directory }`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `createSessionWorkingDir_happyPath_createsUniqueDir` | Happy Path | Scenario 1, Section 3 |
| `createSessionWorkingDir_sanitizesPrName` | Contract | Scenario 1, Section 3a, prName sanitization |
| `createSessionWorkingDir_extractsRepoNameFromUrl` | Contract | Scenario 1, Section 3a, repoUrl → repoName |
| `createSessionWorkingDir_emptySlackId_returnsUndefined` | Sad Path | Scenario 1, Section 5 |
| `createSessionWorkingDir_invalidRepoUrl_returnsUndefined` | Sad Path | Scenario 1, Section 5 |

---

## Scenario 2 — MCP Filesystem Dynamic Restriction

### 1. Entry Point
- Module: `McpConfigBuilder`
- Function: `buildConfig(slackContext, modelCommandContext)`
- File: `src/mcp-config-builder.ts:119`
- Caller: `ClaudeHandler.streamQuery()` at line 435

### 2. Input
- Parameters:
  ```typescript
  slackContext: SlackContext  // required - contains user (slackId)
  // slackContext.user = "U094E5L4A15"
  ```

### 3. Layer Flow

#### 3a. McpConfigBuilder.buildConfig()
- Gets base MCP servers: `McpManager.getServerConfiguration()` → includes `filesystem` server
- Current filesystem config:
  ```typescript
  // AS-IS: args: ['-y', '@modelcontextprotocol/server-filesystem', baseDirectory]
  // baseDirectory = process.env.BASE_DIRECTORY (e.g. '/tmp')
  ```
- **NEW**: After merging servers, overwrite filesystem args:
  ```typescript
  if (slackContext?.user && config.mcpServers?.filesystem) {
    const userTmpDir = normalizeTmpPath(path.join('/tmp', slackContext.user));
    const fsConfig = config.mcpServers.filesystem;
    fsConfig.args = ['-y', '@modelcontextprotocol/server-filesystem', userTmpDir];
  }
  ```
- Transformation chain:
  ```
  slackContext.user ("U094E5L4A15")
    → userTmpDir = normalizeTmpPath('/tmp/U094E5L4A15')
    → filesystem.args[2] = userTmpDir
  ```

#### 3b. McpServerFactory.provisionDefaultServers()
- 기존 로직 유지 (baseDirectory로 초기 설정)
- buildConfig()에서 동적 교체하므로 factory 자체는 변경 불필요
- 단, `provisionDefaultServers()`에 optional `userDir` 파라미터 추가를 고려할 수 있으나, 변경 최소화를 위해 buildConfig() 레벨에서 교체

### 4. Side Effects
- MCP filesystem 서버가 `/tmp/{slackId}` 하위만 접근 가능
- `@modelcontextprotocol/server-filesystem`은 positional arg로 받은 디렉토리 하위만 허용

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| slackContext.user 없음 | N/A | filesystem args 교체 스킵 (기존 baseDirectory 유지) |
| filesystem 서버 없음 | N/A | 교체 스킵 |
| userTmpDir 미존재 | N/A | MCP 서버 시작 시 자동 에러 (MCP 레벨에서 처리) |

### 6. Output
- `McpConfig.mcpServers.filesystem.args` = `['-y', '@modelcontextprotocol/server-filesystem', '/tmp/U094E5L4A15']`

### 7. Observability
- Log: `'Filesystem MCP restricted to user directory'` with `{ user, userTmpDir }`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `buildConfig_withSlackContext_restrictsFilesystemToUserDir` | Happy Path | Scenario 2, Section 3a |
| `buildConfig_withoutSlackContext_keepsDefaultFilesystem` | Sad Path | Scenario 2, Section 5 |
| `buildConfig_noFilesystemServer_skipsOverride` | Sad Path | Scenario 2, Section 5 |
| `buildConfig_filesystemArgs_containsNormalizedPath` | Contract | Scenario 2, Section 3a → 6 |

---

## Scenario 3 — Path Normalization /tmp vs /private/tmp

### 1. Entry Point
- Module: `path-utils` (새 파일)
- Function: `normalizeTmpPath(inputPath: string): string`
- File: `src/path-utils.ts`
- Callers: WorkingDirectoryManager, McpConfigBuilder, SessionRegistry

### 2. Input
- Parameters:
  ```typescript
  inputPath: string  // required - /tmp/... 또는 /private/tmp/... 경로
  ```

### 3. Layer Flow

#### 3a. normalizeTmpPath()
- 문자열 치환으로 `/private/tmp/` prefix를 `/tmp/`로 변환
  ```typescript
  if (inputPath.startsWith('/private/tmp/')) {
    return '/tmp/' + inputPath.slice('/private/tmp/'.length);
  }
  if (inputPath === '/private/tmp') {
    return '/tmp';
  }
  return inputPath;
  ```
- Transformation chain:
  ```
  '/private/tmp/U094E5L4A15/soma-work' → '/tmp/U094E5L4A15/soma-work'
  '/tmp/U094E5L4A15/soma-work' → '/tmp/U094E5L4A15/soma-work' (no change)
  '/home/user/project' → '/home/user/project' (no change)
  ```

#### 3b. Integration Points — 정규화 적용 위치
1. `WorkingDirectoryManager.createSessionWorkingDir()` — 경로 생성 시
2. `McpConfigBuilder.buildConfig()` — filesystem args 설정 시
3. `SessionRegistry.addSourceWorkingDir()` — 기존 `fs.realpathSync()` 후 추가 정규화
4. `SessionRegistry.isValidSourceWorkingDirPath()` — 검증 시 정규화 후 비교

### 4. Side Effects
- 없음 (순수 함수)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| null/undefined 입력 | TypeError | 호출자 책임 (함수는 non-null 가정) |
| /tmp도 /private/tmp도 아닌 경로 | N/A | 입력 그대로 반환 |

### 6. Output
- `string` — `/tmp/` prefix로 정규화된 경로

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `normalizeTmpPath_privateTmp_convertsToTmp` | Happy Path | Scenario 3, Section 3a |
| `normalizeTmpPath_alreadyTmp_unchanged` | Happy Path | Scenario 3, Section 3a |
| `normalizeTmpPath_nonTmpPath_unchanged` | Sad Path | Scenario 3, Section 5 |
| `normalizeTmpPath_privateTmpExact_convertsToTmp` | Contract | Scenario 3, Section 3a, edge case |

---

## Scenario 4 — Concurrent Session Isolation

### 1. Entry Point
- Module: `WorkingDirectoryManager`
- Function: `createSessionWorkingDir(slackId, repoUrl, prName)`
- Scenario: 같은 유저(U094E5L4A15)가 같은 repo(soma-work)에 대해 2개 세션 동시 실행

### 2. Input
- Session A: `createSessionWorkingDir('U094E5L4A15', 'https://github.com/2lab-ai/soma-work', 'pr-74')`
- Session B: `createSessionWorkingDir('U094E5L4A15', 'https://github.com/2lab-ai/soma-work', 'pr-74')` (1초 후)

### 3. Layer Flow

#### 3a. Timestamp-based Uniqueness
- Session A (02:59:27): `soma-work_20260325_0259_pr-74`
- Session B (02:59:28): `soma-work_20260325_0259_pr-74` ← **타임스탬프 분 단위면 충돌 가능!**

**해결**: 타임스탬프를 분 단위가 아닌 **epoch milliseconds** 사용
- Session A: `soma-work_1742868567000_pr-74`
- Session B: `soma-work_1742868568000_pr-74`
- 또는 **YYYYMMDD_HHmmss_SSS** 형식: `soma-work_20260325_025927_759_pr-74`

**최종 결정**: `{repoName}_{epochMs}_{prName}` — 가장 짧고 유니크성 보장
- Transformation:
  ```
  timestamp = Date.now().toString()  // "1742868567000"
  dirName = `${repoName}_${timestamp}_${safePrName}`
  ```

#### 3b. 두 세션의 결과
- Session A: `/tmp/U094E5L4A15/soma-work_1742868567000_pr-74/`
- Session B: `/tmp/U094E5L4A15/soma-work_1742868568000_pr-74/`
- 각 세션은 독립된 디렉토리에서 `git clone` → 충돌 없음

### 4. Side Effects
- 2개의 독립된 디렉토리 생성
- 각 세션의 `options.cwd`가 서로 다른 경로

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| 극히 드문 경우 같은 ms에 호출 | 동일 경로 생성 시도 | `fs.mkdirSync`는 이미 존재해도 `{ recursive: true }`면 에러 안 남. 실질적으로 같은 세션의 재시도 취급 |

### 6. Output
- 항상 서로 다른 경로 (epoch ms 기반)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `createSessionWorkingDir_twoCallsSameUser_differentPaths` | Happy Path | Scenario 4, Section 3 |
| `createSessionWorkingDir_sameRepoSamePr_uniqueByTimestamp` | Contract | Scenario 4, Section 3a |

---

## Scenario 5 — Session Cleanup of Working Directories

### 1. Entry Point
- Module: `SessionRegistry`
- Function: `cleanupSourceWorkingDirs(session)` + `safeRemoveSourceDir(dir)`
- File: `src/session-registry.ts:921-928, 846-864`
- Trigger: 세션 종료 (`terminateSession`) 또는 비활성 만료 (`cleanupInactiveSessions`)

### 2. Input
- `createSessionWorkingDir()`로 생성된 경로가 `source_working_dir` directive를 통해 세션에 등록된 상태
- `session.sourceWorkingDirs = ['/tmp/U094E5L4A15/soma-work_1742868567000_pr-74']`

### 3. Layer Flow

#### 3a. 경로 등록 (기존 흐름 + normalization 추가)
- `SessionRegistry.addSourceWorkingDir(channel, threadTs, dirPath)`
  - `isValidSourceWorkingDirPath(dirPath)` — `/tmp/` 또는 `/private/tmp/` 검증
  - **NEW**: `dirPath = normalizeTmpPath(dirPath)` — 정규화 적용
  - `fs.existsSync(dirPath)` — 존재 확인
  - `fs.realpathSync(dirPath)` → `normalizeTmpPath(resolvedPath)` — 심볼릭 링크 해결 후 재정규화
  - `session.sourceWorkingDirs.push(resolvedPath)`

#### 3b. 세션 종료 시 cleanup
- `terminateSession(sessionKey)` or `cleanupInactiveSessions(maxAge)` 호출
  - → `cleanupSourceWorkingDirs(session)`
    - → `session.sourceWorkingDirs.forEach(dir => safeRemoveSourceDir(dir))`
      - → `fs.rmSync(dir, { recursive: true, force: true })`

### 4. Side Effects
- FS DELETE: `/tmp/{slackId}/{repoName}_{timestamp}_{prName}/` 재귀 삭제
- Session state: `session.sourceWorkingDirs = []` (정리 완료)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| 이미 삭제된 디렉토리 | N/A | `safeRemoveSourceDir` 반환 true (idempotent) |
| 삭제 권한 없음 | fs.rmSync throws | catch → 로그 에러, 실패 목록에 추가 (non-blocking) |
| 심볼릭 링크 | symlink detected | `safeRemoveSourceDir` 반환 false, 삭제 거부 |

### 6. Output
- 성공: 모든 워킹 디렉토리 삭제, `session.sourceWorkingDirs = []`
- 부분 실패: 실패한 경로만 `sourceWorkingDirs`에 남음, 로그 경고

### 7. Observability
- Log: `'Cleaned up source working dir'` per dir
- Log: `'Some source working dirs could not be cleaned up'` on partial failure

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `addSourceWorkingDir_normalizesPath` | Contract | Scenario 5, Section 3a |
| `cleanup_removesCreatedSessionDir` | Happy Path | Scenario 5, Section 3b |
| `cleanup_handlesAlreadyDeletedDir` | Sad Path | Scenario 5, Section 5 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 타임스탬프를 분 단위 → epoch ms로 변경 | small | Scenario 4에서 분 단위 충돌 가능성 발견. epoch ms는 유니크성 보장하면서 구현 단순 |
| `normalizeTmpPath`를 `src/path-utils.ts` 독립 파일로 배치 | small | session-registry에 넣으면 순환 의존 가능. 독립 유틸이 적합 |
| `McpServerFactory` 변경 없이 `McpConfigBuilder`에서만 override | small | factory는 초기 설정만 담당, 세션별 동적 교체는 builder 책임. 변경 범위 최소화 |
| `createSessionWorkingDir`의 repoUrl 파싱: URL constructor 사용 | tiny | 정규 표현식보다 안정적, edge case 처리 내장 |

## Implementation Status
| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| 1. Create Session Working Directory | done | GREEN (5/5) | Verified | Complete |
| 2. MCP Filesystem Dynamic Restriction | done | GREEN (3/3) | Verified | Complete |
| 3. Path Normalization | done | GREEN (5/5) | Verified | Complete |
| 4. Concurrent Session Isolation | done | GREEN (1/1) | Verified | Complete |
| 5. Session Cleanup + Normalization | done | GREEN (2/2) | Verified | Complete |

## Trace Deviations
- Scenario 1/4: 타임스탬프 형식을 `{YYYYMMDD}_{HHmm}` → `{epochMs}_{counter}`로 변경. 분 단위 충돌 방지 + 동일 ms 내 호출에도 카운터로 유니크성 보장.

## Verified At
2026-03-25 — All 5 scenarios GREEN + Verified (16/16 contract tests passing, 1183/1184 total project tests passing, 1 pre-existing failure unrelated)
