# Bug Trace: Image Processing Error — "Could not process image" API 400 반복 실패

## AS-IS: 스레드에 이미지가 포함된 경우, 봇이 이미지를 Read 도구로 읽으려다 API 400 "Could not process image" 에러 발생. 세션이 유지되어 동일 에러 무한 반복.
## TO-BE: 이미지 처리 실패 시 gracefully 스킵하고 텍스트 기반 대화를 정상 진행해야 함.

## Phase 1: Heuristic Top-3

### Hypothesis 1: Thread context hint가 Claude에게 이미지를 무조건 Read하도록 지시
- `stream-executor.ts:191-202` → `getThreadContextHint()`
- Line 201: "파일이나 이미지가 첨부된 메시지가 있으면 download_thread_file로 다운로드한 후 Read 도구로 확인하세요."
- Claude가 이미지를 다운로드 → Read 도구 사용 → 이미지 바이너리가 대화 컨텍스트에 포함 → API 400
- **✅ 확인됨 — 1차 원인 (트리거)**

### Hypothesis 2: 에러 발생 후 세션이 클리어되지 않아 오염된 컨텍스트가 유지됨
- `stream-executor.ts:817-831` → `shouldClearSessionOnError(error)`
- "Could not process image"는 `isContextOverflowError`, `isRecoverableClaudeSdkError`, `isSlackApiError` 어디에도 매칭 안 됨
- `isInvalidResumeSessionError`만 체크 → 이것도 매칭 안 될 가능성 높음
- 결과: 세션이 유지됨 ("Session: ✅ 유지됨") → 다음 요청에 오염된 이미지 데이터 포함 → 같은 에러 반복
- **✅ 확인됨 — 2차 원인 (무한 반복 유발)**

### Hypothesis 3: formatFilePrompt에서도 이미지를 Read하라고 지시
- `file-handler.ts:200-205` → 직접 업로드 이미지에 대해 "Read tool to examine the image content" 안내
- 이 경로도 동일한 문제 유발 가능
- **✅ 확인됨 — 추가 경로**

## Conclusion

**3중 결함:**
1. `getThreadContextHint()` — 이미지 파일도 무조건 다운로드+Read 지시 (트리거)
2. `shouldClearSessionOnError()` — "Could not process image" 400 에러를 세션 클리어 대상으로 인식 못함 (반복 유발)
3. `formatFilePrompt()` — 이미지를 Read하라는 안내가 같은 문제 유발 (보조 경로)

## Fix Plan

1. `getThreadContextHint()`: 이미지 파일은 Read 대신 메타데이터만 참조하도록 지시 변경
2. `shouldClearSessionOnError()`: "could not process image" 에러를 세션 클리어 대상에 추가
3. `formatFilePrompt()`: 이미지 파일 안내를 안전하게 수정 (Read 대신 경로만 제공, 실패 가능성 안내)
4. `isRecoverableClaudeSdkError()` 또는 새 메서드: 이미지 처리 에러를 명시적으로 처리
