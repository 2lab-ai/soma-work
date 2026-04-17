# Trace: /z memory UI — 전체 노출 + improve 액션

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | renderMemoryCard — section-per-entry 전체 노출 + global actions 상·하단 | medium | RED |
| 2 | Payload guard — 12k byte 초과 시 user profile 접힘/entry 미리보기 | small | RED |
| 3 | applyMemory — `improve_memory_<N>` branch + replaceMemory 호출 | small | RED |
| 4 | applyMemory — `improve_user_<N>` branch + replaceMemory 호출 | small | RED |
| 5 | applyMemory — `improve_all` branch + clearMemory + 재삽입 | medium | RED |
| 6 | memory-improve.ts — improveEntry (target 분기 prompt + 예외 전파) | small | RED |
| 7 | memory-improve.ts — improveAll (JSON parse + fallback split) | small | RED |
| 8 | 2-stage rerender — ZTopicBinding.apply `respond` 파라미터 추가 + handleSet 전달 | small | RED |
| 9 | Regression — 기존 clear_* branches 동작 유지 | small | RED |

---

## Scenario 1: renderMemoryCard — section-per-entry 전체 노출 + global actions 상·하단

### Trigger
유저가 Slack에서 `/z memory` 실행 → ZRouter → MemoryTopic → renderMemoryCard.

### Trace

```
renderMemoryCard({userId, issuedAt})
  ├─ loadMemory(userId, 'memory')  → {entries: string[], charLimit, totalChars, percentUsed}
  ├─ loadMemory(userId, 'user')    → 동일
  ├─ buildBlocks()
  │    ├─ header: '🧠 Memory'
  │    ├─ context: 요약
  │    ├─ actions (global 상단): [improve_all(primary), clear_all(danger+confirm)]
  │    ├─ section: '*📝 Memory entries*'
  │    ├─ for i in 0..mem.entries.length:
  │    │    ├─ section: mem.entries[i] (full mrkdwn)
  │    │    └─ actions: [improve_memory_{i+1}(primary), clear_memory_{i+1}(danger+confirm)]
  │    ├─ divider
  │    ├─ section: '*👤 User profile entries*'
  │    ├─ for j in 0..usr.entries.length: (동일 패턴)
  │    ├─ actions (global 하단 반복): [improve_all, clear_all]
  │    ├─ actions (extra): [open_modal]
  │    └─ context: CLI help
  ├─ payloadGuard(blocks)  → 필요시 압축
  └─ return {text: '🧠 Memory (N entries)', blocks}
```

### Contract Test

```typescript
it('renders all entries as sections with per-entry actions', () => {
  // Arrange: userId with 12 memory + 12 user entries
  // Act: renderMemoryCard({userId, issuedAt})
  // Assert:
  //   - blocks의 section 중 memory entries 모두가 original text로 등장
  //   - 각 entry section 바로 아래 actions block이 있고 elements.length === 2
  //   - action_id가 z_setting_memory_set_improve_memory_{N} / z_setting_memory_set_clear_memory_{N}
  //   - global actions(improve_all, clear_all)가 blocks 상단(index <= 5)과 하단에 각 1회
});
```

---

## Scenario 2: Payload guard — 12k byte 초과 시 user profile 접힘

### Trace

```
payloadGuard(blocks):
  const size = JSON.stringify(blocks).length
  if size <= 12000: return blocks
  // stage 1: user profile per-entry → single collapsed section
  const collapsed = user.entries.join('\n\n───\n\n')
  blocks = replaceUserSection(blocks, [{section: collapsed}])
  if size' <= 12000: annotate '⚠️ user profile 요약 표시됨'; return
  // stage 2: memory entry text → 300자 preview
  for memory entries: section.text = truncate(text, 300) + '…(잘림)'
  annotate '⚠️ 일부 항목은 요약 표시됨'
  return blocks
```

### Contract Test

```typescript
it('collapses user profile when payload > 12000 bytes', () => {
  // Arrange: 12 memory entries, each 180 chars; 12 user entries, each 100 chars (=overflow)
  // Act: renderMemoryCard
  // Assert: JSON.stringify(blocks).length <= 12000
  //         context block 중 '⚠️' 배너 존재
});
```

---

## Scenario 3: applyMemory — `improve_memory_<N>` branch

### Trigger
유저가 🪄 개선 버튼 클릭 → action_id `z_setting_memory_set_improve_memory_3` → handleSet → applyMemory.

### Trace

```
applyMemory({userId, value: 'improve_memory_3', respond})
  ├─ match /^improve_memory_(\d+)$/  → idx=3
  ├─ mem = loadMemory(userId, 'memory')
  ├─ oldText = mem.entries[2]
  ├─ await respond?.(renderPendingCard(userId, 'memory', 3))   // "🔄 #3 개선 중…"
  ├─ try { improved = await improveEntry(oldText, 'memory') }
  │  catch (e) → return {ok:false, summary:'❌ 개선 실패: ' + e.message}
  ├─ replaceMemory(userId, 'memory', oldText, improved)
  └─ return {ok:true, summary:'✅ memory #3 개선 완료'}
```

### Contract Test

```typescript
it('replaces memory entry with improved text', async () => {
  // Arrange: mock improveEntry → 'refined text'
  // mock replaceMemory spy
  // Act: applyMemory({userId, value:'improve_memory_3'})
  // Assert: improveEntry called with (original[2], 'memory')
  //         replaceMemory called with (userId, 'memory', original[2], 'refined text')
  //         return.ok === true
});

it('returns error when LLM throws', async () => {
  // Arrange: mock improveEntry → throw
  // Assert: return.ok === false, summary starts with '❌ 개선 실패'
});
```

---

## Scenario 4: applyMemory — `improve_user_<N>` branch

동일 패턴, target='user'. (생략)

---

## Scenario 5: applyMemory — `improve_all` branch

### Trace

```
applyMemory({userId, value: 'improve_all', respond})
  ├─ await respond?.(renderPendingCard(userId, 'all'))
  ├─ for target in ['memory', 'user']:
  │    ├─ cur = loadMemory(userId, target).entries
  │    ├─ if cur.length === 0: continue
  │    ├─ try { improved = await improveAll(cur, target) }
  │    │  catch (e) → skip this target, record error
  │    ├─ clearMemory(userId, target)
  │    └─ for s in improved: addMemory(userId, target, s)
  └─ return {ok:true, summary:'✅ 전체 개선 완료 (memory X → Y, user Z → W)'}
```

### Contract Test

```typescript
it('rebuilds both stores from improveAll output', async () => {
  // Arrange: mock improveAll(memory) → ['a','b','c'] ; improveAll(user) → ['x','y']
  // clearMemory, addMemory spies
  // Act: applyMemory({userId, value:'improve_all'})
  // Assert: clearMemory called twice; addMemory called 3+2=5 times with correct args
});
```

---

## Scenario 6: memory-improve.ts — improveEntry

### Trace

```
improveEntry(entry, target):
  ├─ ensureValidCredentials() → if invalid: throw
  ├─ systemPrompt = SYSTEM_PROMPTS[target]    // memory vs user
  ├─ prompt = `원본:\n${entry}\n\n개선본만 출력:`
  ├─ options = {model: summaryModel, maxTurns:1, tools:[], systemPrompt, ...}
  ├─ for await msg of query({prompt, options}): collect text
  ├─ text = collected.replace(\r\n, ' ').trim()
  ├─ maxLen = target==='memory' ? 660 : 412  // 30% of store limit
  └─ return text.substring(0, maxLen)
```

### Contract Test

```typescript
it('uses memory system prompt for target=memory', async () => {
  // Arrange: mock query to capture options
  // Act: await improveEntry('...', 'memory')
  // Assert: options.systemPrompt includes '장기 기억'
});

it('uses user system prompt for target=user', async () => {
  // Assert: options.systemPrompt includes '페르소나'
});
```

---

## Scenario 7: memory-improve.ts — improveAll

### Trace

```
improveAll(entries, target):
  ├─ ensureValidCredentials()
  ├─ prompt = `다음 ${entries.length}개 항목을 정리·중복제거·통합해 짧은 entries로 재구성.\n출력: JSON array of strings.\n\n---\n${entries.join('\n---\n')}`
  ├─ collect assistantText from query
  ├─ try JSON.parse(extractJsonArray(assistantText)) → string[]
  ├─ catch: fallback = assistantText.split(/\n---+\n/).map(trim).filter(Boolean)
  ├─ enforce total chars <= charLimit
  └─ return array
```

### Contract Test

```typescript
it('parses JSON array output', async () => {
  // Arrange: mock query → '["a","b","c"]'
  // Assert: result === ['a','b','c']
});

it('falls back to --- split when JSON parse fails', async () => {
  // Arrange: mock query → 'a\n---\nb\n---\nc'
  // Assert: result === ['a','b','c']
});
```

---

## Scenario 8: 2-stage rerender — ZTopicBinding.apply `respond` 전달

### Trace

```
z-settings-actions.ts handleSet(body, client, respondFn):
  ├─ await ack()  // 이미 있음
  ├─ zRespond = respondFromActionBody({body, client, respond: respondFn})
  ├─ binding = registry.get(topic)
  ├─ result = await binding.apply({
  │    userId, value, actionId, body,
  │    respond: async (blocks) => zRespond.replace({text, blocks})   // NEW
  │  })
  └─ zRespond.replace(buildConfirmationCard(result))
```

### Contract Test

```typescript
it('passes respond closure to binding.apply', async () => {
  // Arrange: mock binding.apply to capture args
  // Act: trigger z_setting_memory_set_improve_memory_1
  // Assert: apply called with {respond: function}
});
```

---

## Scenario 9: Regression — clear_* branches

기존 동작 유지 확인.

### Contract Test

```typescript
it('clear_memory_3 still removes by index', async () => {
  // Arrange: mock removeMemoryByIndex spy
  // Act: applyMemory({userId, value:'clear_memory_3'})
  // Assert: removeMemoryByIndex called with (userId, 'memory', 3)
});

it('clear_all still calls clearAllMemory', async () => { ... });
```

---

## Integration Verification

최종 E2E (manual 또는 통합 테스트):
- 실제 Slack workspace에서 `/z memory` 실행 (dev 배포 후) → 12+12 entries 모두 보임
- 🪄 개선 클릭 → 해당 entry text가 LLM 결과로 바뀜
- 🪄 전체 개선 클릭 → entries가 통합되어 줄어듦
- CI green + Jest 테스트 전부 통과
