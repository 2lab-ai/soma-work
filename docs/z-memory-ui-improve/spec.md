# Spec: /z memory UI — 전체 노출 + improve 액션

## Problem

현재 `/z memory` Block Kit 카드(`src/slack/z/topics/memory-topic.ts:22` `renderMemoryCard`)는 세 가지 한계가 있다:

1. **24자 preview 버튼만 노출** — entry 전체 text를 읽을 수 없다. 버튼 label이 `📝 #1: 첫 24자…`로 잘린다 (`memory-topic.ts:44`, `:53`).
2. **per-store 5개만 표시** — `maxPerStore = 5` 상수로 6번째 이후 entry는 UI에서 완전히 사라진다 (`memory-topic.ts:40`). 12개 저장돼 있어도 5개만 보인다.
3. **LLM 재작성(improve) 기능 부재** — entry가 조잡하거나 중복될 때 정리할 수단이 없다. `replaceMemory()` API(`src/user-memory-store.ts:134`)는 이미 있지만 UI에서 호출 경로가 없다.

유저는 memory·user profile 전체 내용을 한 번에 읽고, entry별 삭제·개선을 누르고, 전체 개선·전체 삭제도 누를 수 있어야 한다.

## Solution

### 1. `renderMemoryCard` 재작성 — section-per-entry

Block 구성 (상단→하단):

```
[0] header  🧠 Memory
[1] context (요약: Memory N개 %, User M개 %)
[2] actions (global 상단):  [🪄 전체 개선(primary)]  [🗑️ 전체 삭제(danger+confirm)]
[3] section  *📝 Memory entries*
repeat for each memory entry i:
  [k]   section   (entry 전체 text, mrkdwn; 300자 초과 시 미리보기+ellipsis)
  [k+1] actions   [🪄 개선(primary)]  [🗑️ 삭제(danger+confirm)]
[m]   divider
[m+1] section  *👤 User profile entries*
repeat for each user entry j: 동일 패턴
[n]   actions (global 하단 반복):  [🪄 전체 개선]  [🗑️ 전체 삭제]
[n+1] actions (extra):  [➕ 사용자 정보 추가]
[n+2] context (CLI help: /z memory / save / clear)
```

- `maxPerStore` 제거 → 모든 entries 노출.
- 50 block 한도 안전장치(payload guard) — `JSON.stringify(blocks).length > 12000`이면:
  1. user profile entries를 단일 collapsed section (entry 전체를 `\n\n`으로 join, per-entry actions 제거)으로 압축
  2. 그래도 초과면 memory entry text도 300자 미리보기로 잘라 suffix `…(잘림)` 표시
  3. guard가 작동했음을 context block에 `⚠️ 일부 항목은 요약 표시됨 — 전체 내용은 /z memory save 참고` 1줄 추가

### 2. `applyMemory` 확장 — improve branches

기존 z-settings-actions.ts regex `^z_setting_(.+)_set_(.+)$`는 값을 value로 넘기므로 **action_id 라우팅 코드 변경 불필요**. value switch만 확장:

| value | 동작 |
|---|---|
| `clear_all` | (기존) clearAllMemory(userId) |
| `clear_memory_<N>` | (기존) removeMemoryByIndex(userId,'memory',N) |
| `clear_user_<N>` | (기존) removeMemoryByIndex(userId,'user',N) |
| `improve_memory_<N>` | **신규** — improveEntry(memory[N-1],'memory') → replaceMemory(userId,'memory',old,new) |
| `improve_user_<N>` | **신규** — improveEntry(user[N-1],'user') → replaceMemory(userId,'user',old,new) |
| `improve_all` | **신규** — 두 store 각각 improveAll(entries,target) → clearMemory(target) → 결과 배열의 각 string을 addMemory로 재삽입 |

### 3. `src/slack/z/topics/memory-improve.ts` 신규 — LLM helper

```typescript
export async function improveEntry(entry: string, target: 'memory' | 'user'): Promise<string>
export async function improveAll(entries: string[], target: 'memory' | 'user'): Promise<string[]>
```

- `title-generator.ts` 패턴 그대로 — `@anthropic-ai/claude-agent-sdk` `query({maxTurns:1, tools:[]})` + `ensureValidCredentials()` gate + `config.conversation.summaryModel`.
- System prompt 분기:
  - `memory`: "당신은 Slack AI assistant의 장기 기억(기술 사실·경로·팩트) 편집자다. 주어진 entry를 더 명확·간결·정확하게 다시 쓰되 기술적 사실은 보존하라. 출력은 본문만, 250자 이내."
  - `user`: "당신은 사용자 페르소나(말투·선호·성향) 편집자다. 주어진 entry를 더 명확·자연스럽게 다시 쓰되 개성은 보존하라. 출력은 본문만, 200자 이내."
- `improveAll`은 entries를 `\n---\n` 구분자로 연결해 프롬프트에 넣고 "정리·중복제거·통합해 N개 이하의 짧은 entries로 재구성. JSON array of strings로만 출력."을 요구. JSON parse 실패 시 `\n---\n` split fallback.
- 실패 처리: LLM 예외 또는 parse 실패 → `throw new Error(…)` → caller(applyMemory)가 catch해 `{ok:false, summary:'❌ 개선 실패: <reason>'}` 반환.
- 길이 초과: target의 `charLimit`(memory 2200 / user 1375) 내로 truncate. 단일 entry는 target 한도의 30% 상한.

### 4. 2-stage rerender (개선 중… 시각 피드백)

LLM 호출이 3–10초 걸릴 수 있어 유저 체감 개선 필요.

**설계**: `ZTopicBinding.apply` 시그니처에 optional `respond` 파라미터 추가(z-settings-actions.ts handleSet에서 `zRespond.replace`를 클로저로 전달). applyMemory가 필요시 중간 rerender 호출:

```typescript
apply({userId, value, actionId, body, respond?}):
  if (value starts with 'improve_'):
    (1) await respond?.(renderPendingCard(userId, value))   // "🔄 개선 중…" disabled state
    (2) const improved = await improveEntry/All(...)
    (3) replace/clear+add 적용
    (4) return {ok:true, summary:'✅ 개선 완료'}  // handleSet이 최종 카드로 replace
```

- `respond` 미지원 경로(구 DM flow 등)에서는 (1)을 생략하고 단일 rerender로 fallback. ack는 이미 3초 내 처리됐으므로 Slack 타임아웃 위험 없음.

### 5. 테스트 — `src/slack/z/topics/memory-topic.test.ts`

신규 테스트 파일. Jest 패턴은 기존 `cct-topic.test.ts`, `bypass-topic.test.ts`와 동일.

커버리지:
- render: 12+12 entries 전부 section에 text로 등장, global actions 상·하단 2회, 각 entry 아래 actions 2 buttons
- guard: 과도하게 긴 entries에서 payload < 12000 유지
- apply: `improve_memory_3` → `improveEntry` mock + `replaceMemory` 호출, `improve_all` → `improveAll` mock + clear+add 호출
- regression: `clear_memory_N` / `clear_user_N` / `clear_all` 기존 동작 유지

## Scope

**변경**:
- `src/slack/z/topics/memory-topic.ts` — renderMemoryCard 재작성, applyMemory 확장 (~150 line 증가 추정)
- `src/slack/z/topics/memory-improve.ts` — 신규 (~100 line)
- `src/slack/z/topics/memory-topic.test.ts` — 신규 (~250 line)
- `src/slack/actions/z-settings-actions.ts` — ZTopicBinding.apply 시그니처에 optional `respond?: (blocks: any[]) => Promise<void>` 추가, handleSet에서 respond 클로저 전달 (~20 line)

**변경 없음 (entry-point wiring 이미 완료)**:
- `src/slack/z/topics/index.ts` — registerAllTopics가 createMemoryTopicBinding() 이미 호출
- z-settings-actions regex — `improve_*` 자동 catch
- mcp-servers/ — Slack surface only, MCP store 무관
- `src/user-memory-store.ts` — replaceMemory, removeMemoryByIndex, addMemory, clearMemory, clearAllMemory, loadMemory 모두 이미 존재

**Non-goals**:
- CLI `/z memory clear N` 포맷 변경 금지
- `src/slack/commands/memory-handler.ts` text 응답 변경 금지
- `src/user-memory-store.ts` 시그니처 변경 금지
- `src/slack/z/ui-builder.ts buildSettingCard` 변경 금지 (memory-topic이 자체 block 배열 생성)

## Sizing

**medium** (~400 lines across 4 files) — 복수 파일, interface 변경(ZTopicBinding), 신규 LLM helper, 신규 테스트.

## References

- Slack Block Kit 50 blocks/message: https://docs.slack.dev/reference/block-kit/blocks
- `msg_blocks_too_long` ~13.2k 실측: https://github.com/slackapi/bolt-js/issues/2509
- ephemeral `response_url` + `replace_original`: https://docs.slack.dev/messaging/modifying-messages/
- Button element 75자 text / 2000자 value: https://docs.slack.dev/reference/block-kit/block-elements/button-element/
- Confirmation dialog: https://docs.slack.dev/reference/block-kit/composition-objects/confirmation-dialog-object/
