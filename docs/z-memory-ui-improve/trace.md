# Trace: /z memory UI — 전체 노출 + improve 액션 (v2)

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | renderMemoryCard — section+overflow accessory (1 block/entry) + global top/bottom actions | medium | RED |
| 2 | Block-budget fallback — entries > 41이면 overflow를 collapsed section으로 접음 | small | RED |
| 3 | Byte payload guard — Buffer.byteLength > 12000 시 truncate/collapse | small | RED |
| 4 | Mrkdwn escape — 사용자 원문 `*_<>&` + `<@U..>` / `<!here>` 토큰 무력화 | small | RED |
| 5 | applyMemory — `improve_memory_<N>` → improveEntry + replaceMemoryByIndex(atomic) | small | RED |
| 6 | applyMemory — `improve_user_<N>` → 동일 target='user' | small | RED |
| 7 | applyMemory — `improve_memory_all` → improveAll + replaceAllMemory(atomic, rollback-safe) | medium | RED |
| 8 | applyMemory — `improve_user_all` → 동일 target='user' | small | RED |
| 9 | user-memory-store — `replaceMemoryByIndex` 신규 export (1-based index, validate) | small | RED |
| 10 | user-memory-store — `replaceAllMemory` 신규 export (atomic, prevalidate, rollback) | small | RED |
| 11 | memory-improve — improveEntry (target 분기 prompt, char cap, 예외 전파) | small | RED |
| 12 | memory-improve — improveAll (JSON parse + `\n---\n` fallback split) | small | RED |
| 13 | 2-stage rerender — ZTopicBinding.apply `respond` + return `rerender:'topic'` + handleSet 분기 | small | RED |
| 14 | Regression — 기존 `clear_memory_N` / `clear_user_N` / `clear_all` branches 동작 유지 | small | RED |

---

## Scenario 1: renderMemoryCard — section+overflow accessory

### Trigger
유저가 Slack에서 `/z memory` 실행 → ZRouter → MemoryTopic → renderMemoryCard.

### Trace

```
renderMemoryCard({userId, issuedAt})
  ├─ mem  = loadMemory(userId, 'memory')   // {entries: string[], charLimit, totalChars, percentUsed}
  ├─ usr  = loadMemory(userId, 'user')
  ├─ blocks = buildBlocks(mem, usr)
  │    ├─ header:  '🧠 Memory'
  │    ├─ context: '요약 — Memory {N}개 {p1}%, User {M}개 {p2}%'
  │    ├─ actions (top): [improve_memory_all, improve_user_all, clear_all(confirm)]
  │    ├─ section: '*📝 Memory entries ({N})*'
  │    ├─ for i in 1..N:
  │    │    └─ section(
  │    │         text: `*#${i}* | ${escapeMrkdwn(mem.entries[i-1])}`,
  │    │         accessory: overflow({
  │    │           action_id: `z_setting_memory_set_overflow_memory_${i}`,
  │    │           options: [{value:`improve_memory_${i}`,text:'🪄 개선'},
  │    │                     {value:`clear_memory_${i}`, text:'🗑️ 삭제', confirm:{...}}]
  │    │         })
  │    │       )
  │    ├─ divider
  │    ├─ section: '*👤 User profile entries ({M})*'
  │    ├─ for j in 1..M: (동일 패턴, target='user')
  │    ├─ actions (bottom): 상단과 동일 3버튼
  │    ├─ actions (extra): [open_modal '➕ 사용자 정보 추가']
  │    └─ context: CLI help 문자열
  ├─ blocks = blockBudgetFallback(blocks, mem, usr)   // Scenario 2
  ├─ blocks = bytePayloadGuard(blocks, mem, usr)       // Scenario 3
  └─ return {text: `🧠 Memory (${N+M} entries)`, blocks}
```

### Contract Test

```typescript
it('renders all entries as sections with overflow accessory (1 block/entry)', async () => {
  // Arrange: mem 12 entries, usr 12 entries
  // Act: renderMemoryCard({userId, issuedAt})
  // Assert:
  //   - fixed blocks(9) + 24 = 33 blocks total, <= 50
  //   - 각 entry section.text 에 original mem/user text 포함
  //   - 각 entry section.accessory.type === 'overflow'
  //   - overflow.options.length === 2, values: improve_<t>_<n>, clear_<t>_<n>
  //   - 상단·하단 actions block 각 1회 (total global actions = 2)
});

it('overflow clear option has confirm dialog', () => {
  // Assert: overflow.options[1].confirm exists with title/text/confirm/deny
});
```

---

## Scenario 2: Block-budget fallback — entries > 41

### Trigger
mem.entries.length + usr.entries.length + 9(fixed) > 50

### Trace

```
blockBudgetFallback(blocks, mem, usr):
  const total = mem.entries.length + usr.entries.length + 9
  if total <= 50: return blocks
  const overflowCount = total - 50
  // Drop overflow per-entry sections from the larger group first, concat into collapsed section
  const [targetGroup, ...] = pickLargerGroup(mem, usr)
  keep = targetGroup.entries.slice(0, targetGroup.entries.length - overflowCount)
  dropped = targetGroup.entries.slice(keep.length)
  replace per-entry sections of targetGroup with:
    keep → per-entry sections (unchanged)
    dropped → single collapsed section(
      text: dropped.map((t,i) => `#${keep.length+i+1}: ${escapeMrkdwn(truncate(t,200))}`).join('\n')
    )
  prepend context: `⚠️ ${dropped.length}개 항목은 요약 표시됨 — 개별 개선/삭제 불가`
  return blocks
```

### Contract Test

```typescript
it('collapses overflow entries when total > 41', async () => {
  // Arrange: mem 30 entries (short), usr 20 entries (short) → 50 entries + 9 = 59
  // Act: renderMemoryCard
  // Assert: blocks.length <= 50
  //         context block 중 '⚠️' 배너 존재
  //         overflow-only collapsed section 존재
});
```

---

## Scenario 3: Byte payload guard — Buffer.byteLength > 12000

### Trigger
entries 합이 길어서 JSON payload byte size 초과.

### Trace

```
bytePayloadGuard(blocks, mem, usr):
  const size = Buffer.byteLength(JSON.stringify(blocks), 'utf8')
  if size <= 12000: return blocks
  // stage 1: truncate each entry section.text to 300 bytes + '…(잘림)'
  for each entry section: section.text.text = truncateBytes(section.text.text, 300) + '\n_…(잘림)_'
  re-check size
  if size <= 12000: annotate '⚠️ 일부 entry 요약 표시됨'; return blocks
  // stage 2: collapse user profile group into single section, drop its accessories
  replaceUserGroupWith(single collapsed section + no actions)
  annotate '⚠️ user profile 요약 표시됨'
  return blocks
```

### Contract Test

```typescript
it('keeps payload <= 12000 bytes when entries are long', async () => {
  // Arrange: 12 mem entries × 2000 chars, 12 user × 100 chars
  // Act: renderMemoryCard
  // Assert: Buffer.byteLength(JSON.stringify(blocks),'utf8') <= 12000
  //         ⚠️ 배너 context block 존재
  //         모든 mem entry text 끝에 '…(잘림)' 포함
});
```

---

## Scenario 4: Mrkdwn escape — 사용자 원문 토큰 무력화

### Trigger
entry에 `*bold*`, `<@U123>`, `<!here>`, `&` 등이 포함돼 있어 그대로 mrkdwn 렌더 시 의도치 않은 멘션·포맷 발생.

### Trace

```
escapeMrkdwn(s: string): string
  ├─ replace '&' → '&amp;'        // 먼저 해야 이중 치환 방지
  ├─ replace '<' → '&lt;'
  ├─ replace '>' → '&gt;'
  ├─ replace '*' → '\u2217'       // asterisk operator (bold 방지)
  ├─ replace '_' → '\u2f96'       // kangxi radical (italic 방지, 원문 가독성 유지)
  ├─ replace '`' → '\u02cb'       // modifier grave accent
  ├─ replace '~' → '\u223c'       // tilde operator (strikethrough 방지)
  └─ return s
```

(fallback은 `zero-width-space` 삽입 `* → *\u200b`도 검토. 초안은 homoglyph 방식.)

### Contract Test

```typescript
it('escapes mention tokens and mrkdwn chars', () => {
  // Arrange: entry = '<@U123> 안녕 *굵게* <!here> & <http://x>'
  // Act: escapeMrkdwn(entry)
  // Assert: result에 '<@U123>' 원문 없음, '*' 없음, '&amp;' 포함
});

it('section text uses escaped content', async () => {
  // Arrange: mem.entries[0] = '<!here> *X*'
  // Act: renderMemoryCard
  // Assert: 해당 section.text.text 에 '&lt;!here&gt;' 포함, '<!here>' 원문 포함 안됨
});
```

---

## Scenario 5: applyMemory — `improve_memory_<N>` branch

### Trigger
유저가 overflow menu에서 '🪄 개선' 선택 → action_id `z_setting_memory_set_overflow_memory_3`, action.selected_option.value = `improve_memory_3` → handleSet → applyMemory(value='improve_memory_3').

### Trace

```
applyMemory({userId, value: 'improve_memory_3', respond})
  ├─ match /^improve_(memory|user)_(\d+)$/  → target='memory', idx=3
  ├─ mem = loadMemory(userId, 'memory')
  ├─ if idx > mem.entries.length: return {ok:false, summary:'❌ entry 없음', rerender:'topic'}
  ├─ oldText = mem.entries[2]
  ├─ await respond?.(renderPendingCard(userId, 'memory', 3))   // "🔄 #3 개선 중…"
  ├─ try { improved = await improveEntry(oldText, 'memory') }
  │  catch (e) → return {ok:false, summary:'❌ 개선 실패: '+e.message, rerender:'topic'}
  ├─ result = replaceMemoryByIndex(userId, 'memory', 3, improved)
  ├─ if !result.ok: return {ok:false, summary:'❌ 저장 실패: '+result.reason, rerender:'topic'}
  └─ return {ok:true, summary:'✅ memory #3 개선 완료', rerender:'topic'}
```

### Contract Test

```typescript
it('replaces memory entry via replaceMemoryByIndex', async () => {
  // Arrange: mock improveEntry → 'refined text'
  //          mock replaceMemoryByIndex → {ok:true}
  // Act: applyMemory({userId, value:'improve_memory_3', respond: spyPending})
  // Assert: improveEntry called with (original[2], 'memory')
  //         replaceMemoryByIndex called with (userId, 'memory', 3, 'refined text')
  //         spyPending called once BEFORE replace
  //         return.ok === true, return.rerender === 'topic'
});

it('returns error when LLM throws', async () => {
  // Arrange: mock improveEntry → throw Error('rate limit')
  // Assert: replaceMemoryByIndex NOT called
  //         return.ok === false, summary.startsWith('❌ 개선 실패')
  //         rerender === 'topic'
});

it('returns error when replaceMemoryByIndex fails', async () => {
  // Arrange: mock replaceMemoryByIndex → {ok:false, reason:'too long'}
  // Assert: return.ok === false, summary includes 'too long'
});
```

---

## Scenario 6: applyMemory — `improve_user_<N>` branch

동일 패턴, target='user'. (생략)

---

## Scenario 7: applyMemory — `improve_memory_all` branch (atomic rebuild)

### Trace

```
applyMemory({userId, value: 'improve_memory_all', respond})
  ├─ match /^improve_(memory|user)_all$/  → target='memory'
  ├─ cur = loadMemory(userId, 'memory').entries
  ├─ if cur.length === 0: return {ok:true, summary:'ℹ️ entries 없음', rerender:'topic'}
  ├─ await respond?.(renderPendingCard(userId, 'memory', 'all'))
  ├─ try { improved = await improveAll(cur, 'memory') }
  │  catch (e) → return {ok:false, summary:'❌ 개선 실패: '+e.message, rerender:'topic'}
  ├─ // atomic replace — replaceAllMemory 내부에서 prevalidate
  ├─ result = replaceAllMemory(userId, 'memory', improved)
  ├─ if !result.ok: return {ok:false, summary:'❌ 저장 실패: '+result.reason, rerender:'topic'}
  │  // 원본 보존됨 (mutation 無)
  └─ return {ok:true, summary:`✅ memory ${cur.length} → ${improved.length} 개 재구성`, rerender:'topic'}
```

### Contract Test

```typescript
it('atomically rebuilds memory store via replaceAllMemory', async () => {
  // Arrange: mock improveAll(memory) → ['a','b','c']
  //          mock replaceAllMemory → {ok:true}
  // Act: applyMemory({userId, value:'improve_memory_all'})
  // Assert: improveAll called with (original, 'memory')
  //         replaceAllMemory called with (userId, 'memory', ['a','b','c'])
  //         clearMemory / addMemory NOT called (atomic path only)
  //         return.rerender === 'topic'
});

it('preserves original entries when replaceAllMemory rejects', async () => {
  // Arrange: mock improveAll → ['x'.repeat(10000)]  // too long
  //          mock replaceAllMemory → {ok:false, reason:'over charLimit'}
  //          spy: loadMemory after call — entries unchanged
  // Assert: return.ok === false
  //         memory file (or mock store) unchanged
});
```

---

## Scenario 8: applyMemory — `improve_user_all` branch

동일 패턴, target='user'. (생략)

---

## Scenario 9: user-memory-store — `replaceMemoryByIndex`

### Trace

```
replaceMemoryByIndex(userId, target, index, newText):
  ├─ mem = loadMemoryFile(userId, target)  // internal
  ├─ if index < 1 || index > mem.entries.length: return {ok:false, reason:'index out of range'}
  ├─ if newText.length > perEntryCap(target): return {ok:false, reason:'entry too long'}
  ├─ const next = [...mem.entries]
  ├─ next[index-1] = newText
  ├─ const totalChars = next.reduce((a,s)=>a+s.length, 0)
  ├─ if totalChars > target.charLimit: return {ok:false, reason:'total over charLimit'}
  ├─ writeMemoryFile(userId, target, next)
  └─ return {ok:true}
```

### Contract Test

```typescript
it('replaces entry at 1-based index atomically', () => {
  // Arrange: entries = ['a','b','c']
  // Act: replaceMemoryByIndex(u,'memory',2,'NEW')
  // Assert: entries after = ['a','NEW','c']
  //         return.ok === true
});

it('rejects out-of-range index without mutation', () => {
  // Act: replaceMemoryByIndex(u,'memory',99,'x')
  // Assert: return.ok === false, reason includes 'range'
  //         entries unchanged
});

it('rejects when new text exceeds perEntryCap', () => {
  // Act: replaceMemoryByIndex(u,'memory',1,'a'.repeat(5000))
  // Assert: return.ok === false
  //         entries unchanged
});
```

---

## Scenario 10: user-memory-store — `replaceAllMemory`

### Trace

```
replaceAllMemory(userId, target, entries):
  ├─ if !Array.isArray(entries) || entries.length === 0: return {ok:false, reason:'empty'}
  ├─ if new Set(entries).size !== entries.length: return {ok:false, reason:'duplicates'}
  ├─ for s of entries:
  │    if typeof s !== 'string' || s.length === 0: return {ok:false, reason:'empty entry'}
  │    if s.length > perEntryCap(target): return {ok:false, reason:'entry too long'}
  ├─ const total = entries.reduce((a,s)=>a+s.length,0)
  ├─ if total > charLimit(target): return {ok:false, reason:'total over charLimit'}
  ├─ writeMemoryFile(userId, target, entries)   // atomic file write (tmp + rename or same as existing)
  └─ return {ok:true}
```

### Contract Test

```typescript
it('writes full array atomically on valid input', () => {
  // Arrange: entries = ['a','b']
  // Act: replaceAllMemory(u,'memory',['x','y','z'])
  // Assert: file contents = ['x','y','z']
  //         return.ok === true
});

it('rejects duplicates without mutation', () => {
  // Act: replaceAllMemory(u,'memory',['a','a'])
  // Assert: return.ok === false, reason === 'duplicates'
  //         file unchanged
});

it('rejects over-limit arrays without mutation', () => {
  // Act: replaceAllMemory(u,'memory',['x'.repeat(3000)])
  // Assert: return.ok === false
  //         file unchanged (prevalidate before write)
});
```

---

## Scenario 11: memory-improve.ts — improveEntry

### Trace

```
improveEntry(entry, target):
  ├─ cred = await ensureValidCredentials()
  ├─ if !cred.valid: throw new Error('credentials invalid: '+cred.error)
  ├─ systemPrompt = SYSTEM_PROMPTS[target]    // memory vs user
  ├─ prompt = `원본:\n${entry}\n\n개선본만 출력:`
  ├─ options = {model: config.conversation.summaryModel, maxTurns:1, tools:[], systemPrompt,
  │             settingSources:[], plugins:[]}
  ├─ for await msg of query({prompt, options}): collect assistantText from text blocks
  ├─ text = assistantText.replace(/[\r\n]+/g,' ').trim()
  ├─ if !text: throw new Error('empty LLM output')
  ├─ const cap = target==='memory' ? 660 : 412  // per-entry cap (30% of store limit)
  └─ return text.substring(0, cap)
```

### Contract Test

```typescript
it('uses memory system prompt for target=memory', async () => {
  // Arrange: mock query capturing options.systemPrompt
  // Act: await improveEntry('원본 텍스트', 'memory')
  // Assert: options.systemPrompt includes '장기 기억'
  //         options.tools === []
  //         options.maxTurns === 1
});

it('uses user system prompt for target=user', async () => {
  // Assert: options.systemPrompt includes '페르소나'
});

it('throws on empty LLM output', async () => {
  // Arrange: mock query emits no text
  // Assert: throws Error('empty LLM output')
});

it('truncates to per-entry cap', async () => {
  // Arrange: mock query → 'x'.repeat(5000)
  // Act: await improveEntry('orig', 'memory')
  // Assert: result.length === 660
});
```

---

## Scenario 12: memory-improve.ts — improveAll

### Trace

```
improveAll(entries, target):
  ├─ ensureValidCredentials (same gate)
  ├─ prompt = `다음 ${entries.length}개 항목을 정리·중복제거·통합해 더 짧은 entries로 재구성.\n`
  │         + `출력: JSON array of strings, 다른 텍스트 없이.\n\n`
  │         + `---\n${entries.join('\n---\n')}`
  ├─ collect assistantText from query (동일 패턴)
  ├─ // parse strategy
  │  try:
  │    const json = extractFirstJsonArray(assistantText)    // 정규식 `/\[[\s\S]*\]/`
  │    arr = JSON.parse(json)
  │    if !Array.isArray(arr) || arr.some(x => typeof x !== 'string'): throw
  │  catch:
  │    arr = assistantText.split(/\n-{3,}\n/).map(s=>s.trim()).filter(Boolean)
  ├─ if arr.length === 0: throw new Error('improveAll returned empty')
  ├─ // per-entry cap truncate
  │  const cap = target==='memory' ? 660 : 412
  │  arr = arr.map(s => s.substring(0, cap))
  └─ return arr
```

### Contract Test

```typescript
it('parses JSON array output', async () => {
  // Arrange: mock query → '["a","b","c"]'
  // Act: await improveAll(['x','y'], 'memory')
  // Assert: result === ['a','b','c']
});

it('falls back to --- split when JSON parse fails', async () => {
  // Arrange: mock query → 'a\n---\nb\n---\nc'
  // Assert: result === ['a','b','c']
});

it('truncates each entry to cap', async () => {
  // Arrange: mock query → JSON.stringify([('x'.repeat(5000))])
  // Act: improveAll(..., 'memory')
  // Assert: result[0].length === 660
});
```

---

## Scenario 13: 2-stage rerender — `respond` + `rerender:'topic'`

### Trace

```
// ZTopicBinding interface (z-settings-actions.ts)
interface ZTopicBinding {
  // ... (기존)
  apply(args: {
    userId: string;
    value: string;
    actionId: string;
    body: BlockAction;
    respond?: (blocks: KnownBlock[]) => Promise<void>;
  }): Promise<{ ok: boolean; summary: string; rerender?: 'topic' }>;
  renderCard(args: { userId: string; issuedAt: number }): Promise<{ text: string; blocks: KnownBlock[] }>;
}

// handleSet 분기
await ack();
const zRespond = respondFromActionBody({ body, client, respond: respondFn });
const respondClosure = async (blocks: KnownBlock[]) =>
  zRespond.replace({ text: `🧠 Memory`, blocks });
const result = await binding.apply({ userId, value, actionId, body, respond: respondClosure });
if (result.rerender === 'topic') {
  const card = await binding.renderCard({ userId, issuedAt: Date.now() });
  await zRespond.replace(card);
} else {
  await zRespond.replace(buildConfirmationCard(result));   // 기존 경로
}
```

### Contract Test

```typescript
it('passes respond closure and re-renders topic card on rerender flag', async () => {
  // Arrange: mock binding.apply returns {ok:true, summary:'...', rerender:'topic'}
  //          mock binding.renderCard returns {text:'🧠 Memory', blocks:[...]}
  //          spy zRespond.replace
  // Act: dispatch action z_setting_memory_set_improve_memory_1
  // Assert: binding.apply called with object containing 'respond' function
  //         binding.renderCard called after apply
  //         zRespond.replace called with renderCard output (not buildConfirmationCard)
});

it('falls back to confirmation card when rerender undefined', async () => {
  // Arrange: mock binding.apply returns {ok:true, summary:'...'} (no rerender)
  // Assert: binding.renderCard NOT called
  //         zRespond.replace called with confirmation card
});
```

---

## Scenario 14: Regression — `clear_*` branches

기존 동작 유지 확인.

### Contract Test

```typescript
it('clear_memory_3 still removes by index without topic re-render', async () => {
  // Act: applyMemory({userId, value:'clear_memory_3'})
  // Assert: removeMemoryByIndex called with (userId, 'memory', 3)
  //         return.rerender === undefined  // confirmation card path
});

it('clear_all still calls clearAllMemory without topic re-render', async () => {
  // Assert: clearAllMemory(userId) called
  //         return.rerender === undefined
});
```

---

## Integration Verification

최종 E2E (manual + vitest):
- 실제 Slack workspace에서 `/z memory` 실행 (dev 배포 후) → 12+12 entries 모두 보임
- 각 entry overflow 클릭 → [개선, 삭제] 2 options 나옴
- '🪄 개선' 선택 → pending card ("🔄 개선 중…") 즉시 표시 → LLM 완료 후 refreshed memory card로 교체, 해당 entry text가 refined text로 바뀜
- '🪄 전체 메모리 개선' 클릭 → entries가 통합·중복제거되어 줄어듦, 실패 시 원본 보존
- '🗑️ 전체 삭제' → 기존 confirmation dialog → clearAllMemory 실행
- `npm test` 모두 통과 + 신규 테스트 통과 (`memory-topic.test.ts`, `memory-improve.test.ts`, `user-memory-store.test.ts`)
- CI green
