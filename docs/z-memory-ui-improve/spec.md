# Spec: /z memory UI — 전체 노출 + improve 액션 (v3 — codex round-2 반영)

## Problem

현재 `/z memory` Block Kit 카드(`src/slack/z/topics/memory-topic.ts:22` `renderMemoryCard`)는 세 가지 한계가 있다:

1. **24자 preview 버튼만 노출** — entry 전체 text를 읽을 수 없다.
2. **per-store 5개만 표시** — `maxPerStore = 5` 상수로 6번째 이후 entry는 UI에서 완전히 사라진다.
3. **LLM 재작성(improve) 기능 부재** — entry가 조잡하거나 중복될 때 정리할 수단이 없다.

유저는 memory·user profile 전체 내용을 한 번에 읽고, entry별 삭제·개선을 누르고, 전체 개선·전체 삭제도 누를 수 있어야 한다.

## Solution

### 1. `renderMemoryCard` — section+actions per-entry + block-budget fallback

**구조 결정 근거** (v3): overflow+confirm은 Slack 스펙상 option-level confirm 불가(element-level만)이므로 삭제 확인 dialog 지원 불가. button 기반이 confirm·routing·test 모두 표준 경로. 따라서 `section + actions (2 blocks/entry)` 구조를 채택하고 block budget은 fallback으로 해결.

**Block 구성** (상단→하단):

```
[0] header     🧠 Memory
[1] context    (요약 — Memory {N}/{limit} ({p1}%), User {M}/{limit} ({p2}%))
[2] actions    (global 상단): [🪄 전체 메모리 개선] [🪄 전체 프로필 개선] [🗑️ 전체 삭제(confirm)]
[3] section    *📝 Memory entries ({N})*
[... per-entry sections + actions (한 entry 당 2블록) ...]
[k] divider
[k+1] section  *👤 User profile entries ({M})*
[... per-entry sections + actions ...]
[m] actions    (global 하단): [🪄 전체 메모리 개선] [🪄 전체 프로필 개선] [🗑️ 전체 삭제(confirm)]
[m+1] actions  (extra):  [➕ 사용자 정보 추가] [❌ 닫기]
[m+2] context  (CLI help)
```

**Per-entry blocks** (1 entry = 2 blocks):
```
section.text = `*#${i}* | ${escapeMrkdwn(entry)}`      // 3000 char 이하 enforce
actions.elements = [
  button('🪄 개선', primary, action_id=`z_setting_memory_set_improve_${target}_${i}`),
  button('🗑️ 삭제', danger, confirm={title,text,confirm,deny}, action_id=`z_setting_memory_set_clear_${target}_${i}`),
]
```

**Block-budget 계산**:
- 고정 블록: 11 (header, summary, top-actions, mem-header, divider, user-header, bottom-actions, extra-actions, help)
- entry당 2 blocks
- 50 cap ≤ 11 + 2·(N+M) → **(N+M) ≤ 19**

**Block-budget fallback** (`N+M > 19`):
- 큰 쪽 store부터 오래된 entries를 **collapsed single section**으로 접음 (text only, per-entry actions 제거)
- collapsed text는 3000자 cap 준수 (`chunkByChars` — 2900자마다 section 분할). 분할된 section도 블록으로 계산.
- 보존 규칙: 최신 `keepN`개 entry만 per-entry actions 유지, 나머지는 collapsed
  - `keepN`은 `floor((50 - 11 - collapsedBlocks - otherStoreBlocks) / 2)` (동적)
- context block에 `⚠️ {dropped}개 항목은 요약 표시됨 — 개별 개선/삭제 불가. /z memory save ...` 배너 추가
- 두 store 모두 collapse해도 50 초과면 user profile 섹션을 완전히 단일 truncated section으로 합침

**Payload byte guard** (Slack `msg_blocks_too_long` ~13.2k byte):
- `Buffer.byteLength(JSON.stringify(blocks), 'utf8') > 12000` 체크
- 초과 시 각 per-entry section text를 400자 + `…(잘림)` truncate
- 재초과 시 user profile 전체 collapsed+truncated

**Section text 3000-char cap**:
- 각 section의 `text.text`는 빌드 직후 `s.length > 2900`이면 잘라냄(`…_(전체 보기는 /z memory)`) — Slack API 거부 방지
- collapsed section도 동일 룰, 초과분은 다음 section으로 chunk

**Mrkdwn 안전성** (사용자 원문 포함):
- section.text(type=mrkdwn)에 embed 전 `escapeMrkdwn()` 적용
- 치환: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` (멘션/URL 무력화). `*`/`` ` ``/`_`/`~`는 homoglyph (`\u2217`, `\u02cb`, `\u2f96`, `\u223c`) — 가독성 보존 + 포맷 부작용 차단
- `@channel`, `<!here>`, `<@UXXXX>`는 `<`/`>` escape만으로 무력화됨

### 2. `applyMemory` — branch 확장

기존 `handleSet`의 button-value 경로(`action.value`)를 그대로 재사용. **overflow payload 처리 불필요** (button만 씀).

| value | 동작 |
|---|---|
| `clear_all` | (기존) clearAllMemory(userId) |
| `clear_memory_<N>` | (기존) removeMemoryByIndex(userId,'memory',N) |
| `clear_user_<N>` | (기존) removeMemoryByIndex(userId,'user',N) |
| `cancel` | (기존 ui-builder) dismiss card |
| `improve_memory_<N>` | **신규** — improveEntry(memory[N-1],'memory') → `replaceMemoryByIndex(userId,'memory',N,new)` |
| `improve_user_<N>` | **신규** — improveEntry(user[N-1],'user') → `replaceMemoryByIndex(userId,'user',N,new)` |
| `improve_memory_all` | **신규** — improveAll(memory,'memory') → `replaceAllMemory(userId,'memory',improved)` |
| `improve_user_all` | **신규** — improveAll(user,'user') → `replaceAllMemory(userId,'user',improved)` |

모든 improve branch는 결과에 `rerender: 'topic'` 플래그 포함 → handleSet이 memory card 재렌더.

### 3. `user-memory-store.ts` — atomic primitives 추가 + atomic write

> **codex P0-3 fix**: 현재 `fs.writeFileSync`는 crash/ENOSPC 시 파일 절반 쓰기 가능 → 손상. **tmp + rename** pattern으로 교체(atomic rename 보장).

**신규 export** (기존 export 불변):

```typescript
export function replaceMemoryByIndex(
  userId: string, target: MemoryTarget, index: number, newText: string
): { ok: boolean; reason?: string }

export function replaceAllMemory(
  userId: string, target: MemoryTarget, entries: string[]
): { ok: boolean; reason?: string }
```

**내부 변경**:
```typescript
// 기존 writeEntries 교체:
function writeEntries(userId, target, entries) {
  const filePath = getFilePath(userId, target);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const content = entries.join(ENTRY_DELIMITER);
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);    // atomic on POSIX
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}
```

- 기존 함수 시그니처 불변. `addMemory/removeMemoryByIndex/replaceMemory/clearMemory/clearAllMemory`는 내부 writeEntries만 atomic화 → 전역 atomic 보장.

**validation**:
- `replaceMemoryByIndex`: index 1-based, `newText.length > charLimit(target) × 0.3`이면 `{ok:false, reason:'entry too long'}`. 합계 > charLimit이면 거부.
- `replaceAllMemory`: 빈 배열 거부, 중복 거부(`new Set.size`), per-entry cap 검사, 합계 검사. 모두 pre-validate 후 단일 writeEntries 호출. 실패 시 mutation 無.

### 4. `src/slack/z/topics/memory-improve.ts` 신규 — LLM helper

```typescript
export async function improveEntry(entry: string, target: 'memory' | 'user'): Promise<string>
export async function improveAll(entries: string[], target: 'memory' | 'user'): Promise<string[]>
```

- `title-generator.ts` 패턴: `query({maxTurns:1, tools:[], settingSources:[], plugins:[]})` + `ensureValidCredentials()` + `config.conversation.summaryModel`
- System prompt 분기(memory=기술 사실, user=페르소나), 출력 본문만, 길이 caps(memory 660 / user 412)
- `improveAll`: entries `\n---\n` join → "JSON array of strings로만 출력" 요구 → `JSON.parse` → 실패 시 `\n---\n` split fallback → per-entry cap truncate
- 실패 시 `throw`; caller(applyMemory)가 catch → `{ok:false, summary:'❌ 개선 실패: …', rerender:'topic'}`

### 5. 2-stage rerender

**ZTopicBinding.apply** 시그니처 확장:
```typescript
apply(args: {
  userId: string; value: string; actionId: string; body: BlockAction;
  respond?: (blocks: KnownBlock[]) => Promise<void>;   // NEW
}): Promise<{ ok: boolean; summary: string; rerender?: 'topic' }>;   // NEW return field
```

**handleSet** 분기:
```typescript
const respondClosure = async (blocks) => zRespond.replace({ text: `🧠 Memory`, blocks });
const result = await binding.apply({ userId, value, actionId, body, respond: respondClosure });
if (result.rerender === 'topic') {
  const card = await binding.renderCard({ userId, issuedAt: Date.now() });
  await zRespond.replace(card);
} else {
  await zRespond.replace(buildConfirmationCard(result));   // 기존
}
```

**applyMemory improve flow**:
```
(1) await respond?.(renderPendingCard(target, idx|'all'))      // "🔄 개선 중…"
(2) const improved = await improveEntry/All(...)    // catch → {ok:false, rerender:'topic'}
(3) const result = replaceMemoryByIndex/replaceAllMemory(...)
(4) if !result.ok: return {ok:false, summary:'❌ 저장 실패: '+reason, rerender:'topic'}
(5) return {ok:true, summary:'✅ 개선 완료', rerender:'topic'}
```

### 6. Cancel button 유지

현 `buildSettingCard`가 `z_setting_<topic>_cancel` 버튼을 자동 추가. memory-topic이 자체 blocks 배열 생성하므로 **cancel button을 명시적으로 포함** (`extra actions` 섹션에). 기존 테스트 (`memory-topic.test.ts:58` `expect(ids).toContain('z_setting_memory_cancel')`) 호환.

### 7. 테스트 — `src/slack/z/topics/memory-topic.test.ts` (기존 152줄 확장)

- **vitest** (Jest 아님). 기존 `vi.mock('../../../user-memory-store')` 패턴 유지.
- 신규 mock: `replaceMemoryByIndex`, `replaceAllMemory`, `clearMemory` + `vi.mock('./memory-improve')` with `improveEntry`, `improveAll`.
- **render**: 5+5 case all per-entry, 12+12 case는 fallback 확인, block count ≤ 50 assertion, cancel button 존재, 각 entry actions 2 buttons, 상·하단 global actions 2회
- **3000 char section cap**: 각 section text.length ≤ 3000
- **byte guard**: 긴 entries에서 Buffer.byteLength ≤ 12000
- **mrkdwn escape**: `<@U123>`, `*bold*`, `<!here>`, `&` 포함 entry → 렌더 텍스트에 원문 토큰 없음
- **apply**:
  - `improve_memory_3` → improveEntry('memory') + replaceMemoryByIndex(userId,'memory',3,new) + `rerender:'topic'`
  - `improve_user_2` → 동일
  - `improve_memory_all` → improveAll('memory') + replaceAllMemory(userId,'memory',improved) + `rerender:'topic'`
  - improveAll이 3000자 초과 배열 반환 → replaceAllMemory `{ok:false}` → applyMemory `{ok:false, rerender:'topic'}`, store mutation 無
  - improveEntry throws → replaceMemoryByIndex NOT called, summary starts `❌ 개선 실패`
  - respond callback 전달 시 pending card 먼저 호출 (spy call order)
- **regression**: `clear_memory_N` / `clear_user_N` / `clear_all` → `rerender` undefined (generic confirmation path)

### 8. 테스트 — `src/user-memory-store.test.ts` 신규 (또는 기존 확장)

기존 테스트 유무 확인 후 확장/신규. 커버리지:
- `replaceMemoryByIndex` — 정상 replace, out-of-range 거부, per-entry cap 초과 거부 (파일 불변)
- `replaceAllMemory` — 정상 replace, 빈 배열 거부, 중복 거부, over-limit 거부 (파일 불변)
- **atomic write**: `fs.writeFileSync` mock to throw → tmp 파일 cleanup 확인, 원본 파일 내용 유지

### 9. 테스트 — `src/slack/actions/z-settings-actions.test.ts` 확장

기존 button-only 테스트에 추가:
- mock binding with `apply` returning `rerender:'topic'` → `binding.renderCard` 호출 확인, `buildConfirmationCard` 미호출 확인
- `rerender` undefined → 기존 confirmation card 경로 유지 (regression)
- `respond` closure → binding.apply 첫 인자에 `respond: Function` 포함

## Scope

**변경**:
- `src/slack/z/topics/memory-topic.ts` — renderMemoryCard 재작성(section+actions/entry + fallback), applyMemory 확장, escapeMrkdwn/chunkByChars 유틸 (~200 line 증가)
- `src/slack/z/topics/memory-improve.ts` — 신규 (~100 line)
- `src/user-memory-store.ts` — writeEntries atomic rename, replaceMemoryByIndex/replaceAllMemory export 추가 (~60 line 증가)
- `src/slack/actions/z-settings-actions.ts` — ZTopicBinding.apply 시그니처(respond?, rerender?), handleSet 분기 (~30 line)
- `src/slack/z/topics/memory-topic.test.ts` — 기존 확장 (+~180줄)
- `src/user-memory-store.test.ts` — 신규 또는 확장 (~100줄)
- `src/slack/actions/z-settings-actions.test.ts` — 기존 확장 (+~60줄)

**변경 없음**:
- `src/slack/z/topics/index.ts` — registerAllTopics 그대로
- z-settings-actions regex — button-only, `improve_*` 자동 catch
- mcp-servers/ — Slack surface only
- `src/slack/commands/memory-handler.ts` — 변경 無
- `src/slack/z/ui-builder.ts` — 변경 無

**Non-goals**:
- CLI `/z memory clear N` 포맷 변경 금지
- `src/slack/commands/memory-handler.ts` text 응답 변경 금지
- `src/user-memory-store.ts` 기존 export 제거/시그니처 변경 금지 (추가·내부 atomic 교체만 허용)

## Sizing

**medium** (~730 lines across 7 files) — 복수 파일, interface 변경(ZTopicBinding), store atomic write, 신규 LLM helper, 테스트 3 스위트.

## References

- Slack Block Kit 50 blocks/message: https://docs.slack.dev/reference/block-kit/blocks
- Section text 3000 chars: https://docs.slack.dev/reference/block-kit/blocks/section-block
- Button confirm dialog: https://docs.slack.dev/reference/block-kit/composition-objects/confirmation-dialog-object/
- Overflow option NO confirm (option-object): https://docs.slack.dev/reference/block-kit/composition-objects/option-object
- `msg_blocks_too_long` ~13.2k byte 실측: https://github.com/slackapi/bolt-js/issues/2509
- block_actions payload (action.value): https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/
- ephemeral `response_url` + `replace_original`: https://docs.slack.dev/messaging/modifying-messages/
- Slack mention escape: https://docs.slack.dev/messaging/formatting-message-text/#escaping
- POSIX rename atomicity: https://man7.org/linux/man-pages/man2/rename.2.html
