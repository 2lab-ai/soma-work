# Bug Trace: Session Recovery Failure After Restart

## AS-IS: 서버 재시작 시 100% 세션 복구 실패 — "No conversation found with session ID: xxx"
## TO-BE: 서버 재시작 후 기존 세션이 정상적으로 resume되어야 함

## Phase 1: Heuristic Top-3

### Hypothesis 1: sessionWorkingDir 직렬화 누락 → cwd 해시 불일치
- `types.ts:260` → `sessionWorkingDir?: string` 정의 (ConversationSession)
- `session-initializer.ts:166-168` → 새 세션 생성 시 `session.sessionWorkingDir = sessionDir` 설정
  - sessionDir = `/tmp/{slackId}/session_{timestamp}_{hash}/`
- `session-initializer.ts:234` → `effectiveWorkingDir = session.sessionWorkingDir || workingDirectory`
  - sessionWorkingDir가 있으면 고유 dir, 없으면 base dir(`/tmp/{slackId}/`)로 fallback
- `claude-handler.ts:550-551` → `options.cwd = workingDirectory` (= effectiveWorkingDir)
- `claude-handler.ts:555-556` → `options.resume = session.sessionId`
- Claude SDK는 `cwd`를 해시하여 `~/.claude/projects/<hash>/sessions/`에 JSONL 저장

**재시작 전 (정상)**:
```
session.sessionWorkingDir = /tmp/U123/session_xxx/
effectiveWorkingDir = /tmp/U123/session_xxx/
options.cwd = /tmp/U123/session_xxx/
SDK → ~/.claude/projects/<hash_A>/sessions/ 에 대화 저장
```

**재시작 후 (버그)**:
```
saveSessions() → sessionWorkingDir 미포함 (PR #77 누락)
loadSessions() → session.sessionWorkingDir = undefined
effectiveWorkingDir = undefined || /tmp/U123/ = /tmp/U123/
options.cwd = /tmp/U123/
SDK → ~/.claude/projects/<hash_B>/sessions/ 에서 검색
hash_A ≠ hash_B → "No conversation found with session ID: xxx"
```

**확인 경로**:
- `session-registry.ts:1117-1148` — saveSessions() 직렬화 목록에 `sessionWorkingDir` 없었음 ← **ROOT CAUSE**
- `session-registry.ts:1201-1241` — loadSessions() 역직렬화에도 `sessionWorkingDir` 없었음
- PR #77 (commit `9123a94`, 2026-03-25 머지) — sessionWorkingDir 도입하면서 직렬화 빠뜨림

✅ **Confirmed** — 이것이 근본 원인

### Hypothesis 2: sessionId 자체가 유실됨
- `session-registry.ts:1124` → `sessionId: session.sessionId` — 직렬화됨
- `session-registry.ts:1207` → `sessionId: serialized.sessionId` — 역직렬화됨
- sessionId는 정상적으로 save/load됨
❌ Ruled out

### Hypothesis 3: Claude SDK가 재시작 후 대화를 메모리에서만 유지
- `~/.claude/projects/` 디렉토리 확인 → JSONL 파일이 디스크에 존재
- SDK는 대화를 디스크에 영구 저장하며 resume 가능
❌ Ruled out

## Conclusion: Hypothesis 1 확인 — sessionWorkingDir 직렬화 누락이 근본 원인

## Edge Cases

1. **PR #77 이전 세션**: sessionWorkingDir 없음 → fallback to base dir → 원래 base dir로 만들었으므로 정상
2. **재시작 중 sessionWorkingDir 디렉토리 삭제**: 대화 JSONL은 `~/.claude/projects/`에 있으므로 resume 자체는 가능. 단, 새 파일 쓰기는 실패할 수 있음 → **별도 이슈로 분리 필요**
3. **workingDirectory vs sessionWorkingDir**: `workingDirectory`는 유저 base dir(`/tmp/{slackId}/`), `sessionWorkingDir`는 세션 고유 dir. 둘은 다른 필드

## Fix (PR #104)

3 changes to `session-registry.ts`:
1. `SerializedSession` interface에 `sessionWorkingDir?: string` 추가 (line 97-98)
2. `saveSessions()`에 `sessionWorkingDir: session.sessionWorkingDir` 추가 (line 1145-1147)
3. `loadSessions()`에 `sessionWorkingDir: serialized.sessionWorkingDir` 추가 (line 1238-1240)

## Verification: Red-Green Cycle

### RED (수정 전 테스트 실패 확인)
- [x] origin/main의 session-registry.ts로 되돌린 후 테스트 실행 → `persists and restores sessionWorkingDir` **FAILED** ✅

### GREEN (수정 후 테스트 통과 확인)
- [x] 수정 복원 후 테스트 실행 → 6/6 **PASSED** ✅
- [x] 전체 테스트 스위트 → 1489/1490 passed (1건 기존 실패, 무관) ✅
- [x] TypeScript 타입 체크 → 0 errors ✅
