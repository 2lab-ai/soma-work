# Spec: /z memory UI — 전체 노출 + improve 액션 (v2 — codex review 반영)

## Problem

현재 `/z memory` Block Kit 카드(`src/slack/z/topics/memory-topic.ts:22` `renderMemoryCard`)는 세 가지 한계가 있다:

1. **24자 preview 버튼만 노출** — entry 전체 text를 읽을 수 없다. 버튼 label이 `📝 #1: 첫 24자…`로 잘린다 (`memory-topic.ts:44`, `:53`).
2. **per-store 5개만 표시** — `maxPerStore = 5` 상수로 6번째 이후 entry는 UI에서 완전히 사라진다 (`memory-topic.ts:40`). 12개 저장돼 있어도 5개만 보인다.
3. **LLM 재작성(improve) 기능 부재** — entry가 조잡하거나 중복될 때 정리할 수단이 없다. `replaceMemory()` API(`src/user-memory-store.ts:123`)와 `clearMemory()`(`:193`)는 이미 있지만 UI에서 호출 경로가 없다.

유저는 memory·user profile 전체 내용을 한 번에 읽고, entry별 삭제·개선을 누르고, 전체 개선·전체 삭제도 누를 수 있어야 한다.

## Solution

### 1. `renderMemoryCard` 재작성 — section+overflow accessory (1 block/entry)

> **중요**: 각 entry를 `section + actions` 2블록으로 쌓으면 12+12=24 entries에서 **8 + 2·24 = 56블록** → Slack 50 block cap 위반. 따라서 **section block의 `accessory`에 `overflow` menu**를 넣어 **entry당 1블록**으로 압축한다. `overflow`는 버튼 그룹과 다르게 section.accessory에 직접 붙을 수 있고 여러 옵션을 가진다.

Block 구성 (상단→하단):

```
[0] header     🧠 Memory
[1] context    (요약: Memory N/charLimit %, User M/charLimit %)
[2] actions    (global 상단): [🪄 전체 메모리 개선(primary)] [🪄 전체 프로필 개선(primary)] [🗑️ 전체 삭제(danger+confirm)]
[3] section    *📝 Memory entries ({N})*
repeat for each memory entry i (1..N):
  [k] section (text: `*#{i}* | {escaped_mrkdwn_text}`)
        .accessory = overflow_menu { options: [🪄 개선(primary feel), 🗑️ 삭제(confirm)] }
[m]   divider
[m+1] section  *👤 User profile entries ({M})*
repeat for each user entry j (1..M):
  [.] section + overflow accessory (동일 패턴)
[n]   actions  (global 하단 반복): [🪄 전체 메모리 개선] [🪄 전체 프로필 개선] [🗑️ 전체 삭제]
[n+1] actions  (extra): [➕ 사용자 정보 추가]
[n+2] context  (CLI help)
```

**Block budget 계산**:
- 고정 블록: header(1) + summary context(1) + top actions(1) + mem group header(1) + divider(1) + user group header(1) + bottom actions(1) + extra actions(1) + help context(1) = **9**
- entry당: **1** (section with overflow accessory)
- 총합 N=12, M=12: 9 + 24 = **33 blocks** (50 cap 여유 17)
- 최대 안전 entries: 50 - 9 = **41 total** (즉 store당 ~20. 현 char limit 기준 memory 2200/200=11, user 1375/100=13 수준이므로 실용 범위 안전)

**Block budget fallback** (entries 총합이 41 초과하거나 아래 guard 작동 시):
1. 각 store의 최신 entries 우선 보존, 초과분은 단일 collapsed section에 `#idx: text` 줄로 이어붙여 표시 (accessory 없음, per-entry action 불가)
2. context block에 `⚠️ 일부 항목은 요약 표시됨 ({X}개 축약)` 배너 추가

**Payload byte guard** (Slack `msg_blocks_too_long` ~13.2k 실측):
- `Buffer.byteLength(JSON.stringify(blocks), 'utf8') > 12000` 체크 (JS 문자 length 아님)
- 초과 시 위 fallback의 stage 2: 각 entry text를 300자(byte 기준) + `…(잘림)` 절단, re-check
- 재초과 시 stage 3: user profile 전체를 단일 collapsed section으로 접음

**Mrkdwn 안전성** (사용자 원문 포함):
- entry text는 `*_\`~<>&` 문자를 escape한 후 section.text(type=mrkdwn)에 임베드
- `@channel` / `<!here>` / `<@UXXXX>` 형태 토큰화 방지 위해 `<`, `>`, `&` 는 HTML-엔티티로 escape (`&lt;`, `&gt;`, `&amp;`)
- 유틸: `escapeMrkdwn(s: string): string` 신규 in `memory-topic.ts` (private)

### 2. `applyMemory` 확장 — improve branches + target 인코딩

기존 z-settings-actions.ts regex `^z_setting_(.+)_set_(.+)$`는 값을 `value`로 넘기므로 **action_id 라우팅 코드 변경 불필요**. value switch만 확장 (target 모호성 해결을 위해 `improve_all`은 target별로 분리):

| value | 동작 |
|---|---|
| `clear_all` | (기존) clearAllMemory(userId) |
| `clear_memory_<N>` | (기존) removeMemoryByIndex(userId,'memory',N) |
| `clear_user_<N>` | (기존) removeMemoryByIndex(userId,'user',N) |
| `improve_memory_<N>` | **신규** — improveEntry(memory[N-1],'memory') → `replaceMemoryByIndex(userId,'memory',N,new)` (atomic) |
| `improve_user_<N>` | **신규** — improveEntry(user[N-1],'user') → `replaceMemoryByIndex(userId,'user',N,new)` |
| `improve_memory_all` | **신규** — improveAll(memory,'memory') → validate → `replaceAllMemory(userId,'memory',improved)` (atomic) |
| `improve_user_all` | **신규** — improveAll(user,'user') → validate → `replaceAllMemory(userId,'user',improved)` |

> **codex P0-2 fix**: target 모호한 `improve_all` 제거. UI는 "🪄 전체 메모리 개선" / "🪄 전체 프로필 개선" 두 버튼으로 분리. (value encoding = `improve_<target>_all`)

### 3. `user-memory-store.ts` 확장 — atomic primitives 추가

> **codex P0-3/P1-1 fix**: 기존 `replaceMemory(old,new)`는 `includes(old)` 매칭 기반 → overlapping entries에서 오매칭 위험. `clearMemory + addMemory` 반복은 비원자적 → LLM 결과 일부가 char limit 거부되면 데이터 유실. 두 atomic primitive를 **추가**(기존 API 시그니처 불변).

```typescript
// 신규 export (기존 함수 그대로 유지, 추가만)

/** Replace entry at (1-based) index atomically. Validates newText length before write. */
export function replaceMemoryByIndex(
  userId: string,
  target: 'memory' | 'user',
  index: number,          // 1-based (UI와 일치)
  newText: string
): { ok: boolean; reason?: string }

/** Replace entire entries array atomically.
 *  Prevalidate: total bytes ≤ charLimit, per-entry ≤ charLimitPerEntry, array non-empty.
 *  On failure: no mutation; returns {ok:false, reason}. */
export function replaceAllMemory(
  userId: string,
  target: 'memory' | 'user',
  entries: string[]
): { ok: boolean; reason?: string }
```

- 구현: 기존 `loadMemory → mutate array → writeMemory` 패턴 재사용. `replaceMemoryByIndex`는 `entries[index-1] = newText` 후 길이 검증.
- `replaceAllMemory`는 전체 배열 교체 전에 (a) 각 entry ≤ per-entry cap (기본 target limit의 30% — memory 660 / user 412), (b) 합계 ≤ target.charLimit, (c) 중복 없음 (`new Set(entries).size === entries.length`) 검증. 실패 시 throw 대신 `{ok:false, reason}` 반환 → caller가 원본 보존.

> **Non-goal 재조정**: 기존 "user-memory-store.ts 시그니처 변경 금지"에서 **"기존 export 제거·시그니처 변경 금지, 추가는 허용"**으로 완화. 두 신규 primitive만 추가되며 기존 `replaceMemory/clearMemory/clearAllMemory/removeMemoryByIndex/addMemory/loadMemory` 호출부는 손대지 않는다.

### 4. `src/slack/z/topics/memory-improve.ts` 신규 — LLM helper

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
- 길이 초과: 단일 entry는 target별 per-entry cap(memory 660 / user 412)으로 truncate. 배열 합은 `replaceAllMemory` 검증에 의존.

### 5. 2-stage rerender — apply 시그니처 확장 + final re-render

LLM 호출이 3–10초 걸릴 수 있어 UX 개선 필요. **codex P2 fix**: 마지막에 generic confirmation card가 아니라 **갱신된 memory card**로 re-render.

**설계**:

```typescript
// ZTopicBinding.apply 시그니처 (z-settings-actions.ts 내부 type)
apply(args: {
  userId: string;
  value: string;
  actionId: string;
  body: BlockAction;
  respond?: (blocks: KnownBlock[]) => Promise<void>;   // NEW (optional)
}): Promise<{
  ok: boolean;
  summary: string;
  rerender?: 'topic';    // NEW — true면 handleSet이 binding.renderCard로 최종 re-render
}>

// handleSet 흐름
await ack();
const result = await binding.apply({
  userId, value, actionId, body,
  respond: async (blocks) => zRespond.replace({ text, blocks }),
});
if (result.rerender === 'topic') {
  const card = await binding.renderCard({ userId, issuedAt: Date.now() });
  await zRespond.replace(card);
} else {
  await zRespond.replace(buildConfirmationCard(result));   // 기존
}
```

**applyMemory 실행 흐름** (improve branch):
```
(1) await respond?.(renderPendingCard(value))      // "🔄 개선 중…" placeholder
(2) const improved = await improveEntry/All(...)
(3) const storeResult = replaceMemoryByIndex/replaceAllMemory(...)
(4) if !storeResult.ok: return {ok:false, summary:'❌ 저장 실패: '+reason, rerender:'topic'}
(5) return {ok:true, summary:'✅ 개선 완료', rerender:'topic'}
```

- `respond` 미지원 경로(구 DM flow 등)에서는 (1)을 생략(단일 최종 rerender로 fallback). ack는 이미 3초 내 처리됐으므로 Slack 타임아웃 위험 없음.
- `clear_*` branches는 기존대로 `rerender` 미설정 → generic confirmation card 유지 (regression 방지).

### 6. 테스트 — `src/slack/z/topics/memory-topic.test.ts` (기존 152줄 확장)

**중요**: 파일 이미 존재. 신규 생성 아님. **vitest** 사용 (Jest 아님). `vi.mock('../../../user-memory-store')` 패턴 유지.

기존 mock 확장:
- `replaceMemoryByIndex`, `replaceAllMemory`, `clearMemory` 추가
- `vi.mock('./memory-improve')` with `improveEntry`, `improveAll`

추가 커버리지:
- **render**: 12+12 entries 모두 section에 text로 등장, 각 section에 overflow accessory(옵션 2개), 상·하단 global actions 2회 반복
- **block-budget**: 총 blocks ≤ 50 assertion (12+12 케이스 33), fallback 경로에서 user profile collapse 시에도 ≤ 50
- **payload guard**: 과도하게 긴 entries (각 2000자)에서 `Buffer.byteLength` ≤ 12000 유지
- **mrkdwn escape**: entry에 `*bold*` / `<@U123>` / `<!here>` 포함 시 대응 escape 적용된 문자열만 렌더 (멘션 발생 X)
- **apply**:
  - `improve_memory_3` → `improveEntry` mock('memory') + `replaceMemoryByIndex(userId,'memory',3,...)` 호출, `rerender:'topic'` 반환
  - `improve_user_2` → 동일 (target='user')
  - `improve_memory_all` → `improveAll(entries,'memory')` + `replaceAllMemory(userId,'memory',improved)` 호출
  - `improve_user_all` → 동일
  - improveAll이 char cap 초과 배열 반환 → `replaceAllMemory`가 `{ok:false}` → applyMemory가 `{ok:false, rerender:'topic'}` 반환 + store mutation 無 (rollback 확인)
  - improveEntry throws → caller catch → `{ok:false, summary:'❌ 개선 실패…'}`
  - `respond` callback 전달 시 pending card가 먼저 호출됨 (assert call order)
- **regression** (기존 테스트 유지): `clear_memory_N` / `clear_user_N` / `clear_all` → `rerender` undefined, generic confirmation path

## Scope

**변경**:
- `src/slack/z/topics/memory-topic.ts` — renderMemoryCard 재작성 (overflow accessory 구조), applyMemory 확장, escapeMrkdwn 유틸 (~180 line 증가)
- `src/slack/z/topics/memory-improve.ts` — 신규 (~100 line)
- `src/user-memory-store.ts` — `replaceMemoryByIndex`, `replaceAllMemory` 2개 신규 export 추가 (~40 line 증가, 기존 함수 불변)
- `src/slack/actions/z-settings-actions.ts` — ZTopicBinding.apply 시그니처에 `respond?`, return에 `rerender?: 'topic'` 추가, handleSet에서 respond 클로저 전달 + rerender 분기 (~30 line)
- `src/slack/z/topics/memory-topic.test.ts` — 기존 152줄 확장 (+~160줄)

**변경 없음 (entry-point wiring 이미 완료)**:
- `src/slack/z/topics/index.ts` — registerAllTopics가 createMemoryTopicBinding() 이미 호출
- z-settings-actions regex — `improve_*_all` / `improve_<target>_<N>` 모두 자동 catch
- mcp-servers/ — Slack surface only, MCP store 무관
- `src/slack/commands/memory-handler.ts` — 변경 無
- `src/slack/z/ui-builder.ts buildSettingCard` — 변경 無 (memory-topic이 자체 block 배열 생성)

**Non-goals**:
- CLI `/z memory clear N` 포맷 변경 금지
- `src/slack/commands/memory-handler.ts` text 응답 변경 금지
- `src/user-memory-store.ts` 기존 export 제거/시그니처 변경 금지 (**추가만 허용**)
- `src/slack/z/ui-builder.ts buildSettingCard` 변경 금지

## Sizing

**medium** (~510 lines across 5 files) — 복수 파일, interface 변경(ZTopicBinding), store primitive 추가, 신규 LLM helper, 기존 테스트 확장.

## References

- Slack Block Kit 50 blocks/message: https://docs.slack.dev/reference/block-kit/blocks
- Overflow menu (section accessory): https://docs.slack.dev/reference/block-kit/block-elements/overflow-menu-element/
- `msg_blocks_too_long` ~13.2k byte 실측: https://github.com/slackapi/bolt-js/issues/2509
- ephemeral `response_url` + `replace_original`: https://docs.slack.dev/messaging/modifying-messages/
- Button element 75자 text / 2000자 value: https://docs.slack.dev/reference/block-kit/block-elements/button-element/
- Confirmation dialog: https://docs.slack.dev/reference/block-kit/composition-objects/confirmation-dialog-object/
- Slack user mention escape: https://docs.slack.dev/messaging/formatting-message-text/#escaping
