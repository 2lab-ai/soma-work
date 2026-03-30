# Bug Trace: Thread Header Files Invisible on Mid-Thread DM Initiation

## AS-IS: mid-thread DM으로 봇 이니시에이팅 시, thread root message(header)에 첨부된 이미지/파일을 확인 못함
## TO-BE: mid-thread 이니시에이팅 시, root message의 파일/이미지 메타데이터도 모델이 인식해야 함

## Phase 1: Heuristic Top-3

### Hypothesis 1: Legacy mode `fetchMessagesBefore`가 root message를 명시적으로 skip
- `slack-mcp-server.ts:620` → `if (m.ts === this.context.threadTs) continue;`
- Legacy mode에서 `conversations.replies` API는 root message를 첫 번째로 반환
- 이 코드가 root를 의도적으로 건너뜀 → root에 첨부된 파일 메타데이터가 누락됨
- thread-awareness hint (`stream-executor.ts:201`)가 "(before/after 개수 지정)"으로 legacy mode를 유도
- **✅ Confirmed: root message 완전 누락**

### Hypothesis 2: Thread-awareness hint가 root message 파일 확인을 명시하지 않음
- `stream-executor.ts:196-209` → hint 내용 확인
- "먼저 get_thread_messages로 멘션 이전 대화를 읽고" — root message 확인을 직접 지시하지 않음
- Array mode로 호출하면 root(offset 0)를 볼 수 있지만, hint가 legacy mode를 유도
- **✅ Confirmed: hint가 모델 행동을 잘못 유도**

### Hypothesis 3: 이미지 파일에 url_private_download가 제거되어 모델이 접근 불가
- `slack-mcp-server.ts:689` → `!fileIsMedia && f.url_private_download` — 미디어 파일은 download URL 제거
- 이미지는 `is_image: true`, `image_note: "do NOT download or Read"` 메타데이터만 제공
- 이건 설계 의도이며, 모델이 메타데이터(이름, mimetype, size)는 볼 수 있어야 함
- **문제는 이미지 "내용"을 못 보는 게 아니라, 파일 존재 자체를 모르는 것** → Hypothesis 1이 원인
- **❌ 부차적 문제 (root가 보이면 해결됨)**

## Conclusion

**Root Cause: 2개의 결함이 복합적으로 작용**

1. **`fetchMessagesBefore` (line 620)**: root message를 `continue`로 skip → legacy mode에서 root 파일 완전 누락
2. **Thread-awareness hint**: "(before/after 개수 지정)" 문구가 모델을 legacy mode로 유도 → array mode(root 포함)가 아닌 legacy mode 사용

## Fix Plan

### Fix 1: `fetchMessagesBefore`에서 root message skip 제거
- Line 620의 `if (m.ts === this.context.threadTs) continue;` 제거
- Root message도 "before" 결과에 포함

### Fix 2: Thread-awareness hint 개선
- Array mode를 기본으로 안내
- "먼저 root message(offset 0)의 파일을 확인하라" 명시
- Legacy mode 언급 제거 또는 부차적으로 언급
