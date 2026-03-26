# Bug Trace: UIAskUserQuestion 버튼 클릭 후 잔존

## AS-IS: 싱글Q/멀티Q 모두 유저 선택 완료 후에도 버튼이 활성 상태로 남아 클릭 가능
## TO-BE: 선택 완료 시 버튼 UI가 비활성화/제거되어 더 이상 클릭할 수 없어야 함

## Phase 1: Heuristic Top-3

### Hypothesis 1: updateMessage 호출 시 attachments를 명시적으로 비우지 않음 ✅ 확인
- `choice-message-builder.ts:104-111` → 원본 메시지는 `attachments[0].blocks`에 버튼 렌더링
- `choice-action-handler.ts:46-59` (싱글Q) → `updateMessage(channel, ts, text, blocks)` 호출, `attachments` 파라미터 미전달 (undefined)
- `choice-action-handler.ts:325-327` (멀티Q 완료) → 동일하게 `attachments` 미전달
- `slack-api-helper.ts:326-332` → payload에 `attachments: undefined` → JSON 직렬화 시 제외됨
- Slack `chat.update` API 동작: `attachments` 필드가 요청에 없으면 기존 attachments 유지
- **결과: 새 blocks 추가되지만, 옛 attachments(버튼 포함) 그대로 잔존**

### Hypothesis 2: 메시지 위치 동기화 누락 (멀티Q 전용) ✅ 부분 확인
- `updateFormUI()` → `resolveChoiceSyncMessageTs()`로 thread + action panel 모든 ts 수집 후 업데이트 → 중간 선택은 정상
- `completeMultiChoiceForm()` → `pendingForm.messageTs || messageTs` 단일 ts만 업데이트
- action panel 메시지가 별도 ts로 존재할 경우 해당 메시지는 업데이트되지 않음

### Hypothesis 3: Slack acknowledge 후 race condition
- Bolt 프레임워크가 자동 ack → 3초 내 처리 → 문제 없음 ❌ 무관

## 결론

**주 원인: Hypothesis 1** — `chat.update` 호출 시 `attachments: []`를 명시적으로 전달하지 않아 기존 버튼 attachment가 잔존
**부 원인: Hypothesis 2** — 멀티Q 완료 시 모든 메시지 위치를 동기화하지 않음

## 수정 대상 파일
- `src/slack/actions/choice-action-handler.ts`
  - `handleUserChoice`: line 46-59 → 5번째 인자로 `[]` 전달
  - `completeMultiChoiceForm`: line 314-330 → `attachments: []` 전달 + `resolveChoiceSyncMessageTs` 사용
