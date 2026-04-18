# Trace: /z memory UI — 전체 노출 + improve 액션 (v3)

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | renderMemoryCard — section+actions per-entry (2 blocks/entry) + top/bottom global actions + cancel | medium | RED |
| 2 | Block-budget fallback — N+M > 20 시 오래된 entries를 collapsed section(들)로 접음 | medium | RED |
| 3 | Section 3000-char cap — 긴 entry text → 2900자 chunk 분할 또는 truncate | small | RED |
| 4 | Byte payload guard — Buffer.byteLength > 12000 시 truncate/collapse | small | RED |
| 5 | Mrkdwn escape — `<@U..>` / `<!here>` / `*_~<>&` 무력화 (escapeMrkdwn) | small | RED |
| 6 | applyMemory — `improve_memory_<N>` → improveEntry + replaceMemoryByIndex | small | RED |
| 7 | applyMemory — `improve_user_<N>` → 동일 target='user' | small | RED |
| 8 | applyMemory — `improve_memory_all` → improveAll + replaceAllMemory(rollback-safe) | medium | RED |
| 9 | applyMemory — `improve_user_all` → 동일 target='user' | small | RED |
| 10 | user-memory-store — writeEntries atomic rename 패턴 | small | RED |
| 11 | user-memory-store — `replaceMemoryByIndex` 신규 export (1-based, validate) | small | RED |
| 12 | user-memory-store — `replaceAllMemory` 신규 export (prevalidate, atomic, rollback) | small | RED |
| 13 | memory-improve — improveEntry (target prompt, cap, 예외 전파) | small | RED |
| 14 | memory-improve — improveAll (JSON parse + split fallback + cap) | small | RED |
| 15 | 2-stage rerender — ZTopicBinding.apply respond + rerender 플래그 + handleSet 분기 | small | RED |
| 16 | z-settings-actions — rerender 경로 테스트 (binding.renderCard 호출) | small | RED |
| 17 | Regression — 기존 `clear_*`, `cancel` branches 동작 유지 | small | RED |

---

## Scenario 1: renderMemoryCard — section+actions per-entry

### Trigger
유저 Slack `/z memory` → ZRouter → MemoryTopic → renderMemoryCard.

### Trace

```
renderMemoryCard({userId, issuedAt})
  ├─ mem = loadMemory(userId, 'memory')
  ├─ usr = loadMemory(userId, 'user')
  ├─ blocks = buildFullPerEntryBlocks(mem, usr)
  │    ├─ header: '🧠 Memory'
  │    ├─ context: summary line
  │    ├─ actions (top): [improve_memory_all(primary), improve_user_all(primary), clear_all(danger+confirm)]
  │    ├─ section: '*📝 Memory entries ({N})*'
  │    ├─ for i in 1..N:
  │    │    ├─ section(text=`*#${i}* | ${escapeMrkdwn(mem.entries[i-1])}`)
  │    │    └─ actions([button('🪄 개선',primary,value=`improve_memory_${i}`,
  │    │                       action_id=`z_setting_memory_set_improve_memory_${i}`),
  │    │                button('🗑️ 삭제',danger,confirm={...},value=`clear_memory_${i}`,
  │    │                       action_id=`z_setting_memory_set_clear_memory_${i}`)])
  │    ├─ divider
  │    ├─ section: '*👤 User profile entries ({M})*'
  │    ├─ for j in 1..M: (same pattern, target='user')
  │    ├─ actions (bottom): same 3 global buttons
  │    ├─ actions (extra): [open_modal('➕ 사용자 정보 추가'),
  │    │                    button('❌ 닫기', value='cancel',
  │    │                           action_id='z_setting_memory_cancel')]
  │    └─ context: CLI help
  ├─ if (9 + 2*(N+M) > 50):     // 9 fixed blocks
  │     blocks = collapseFallback(blocks, mem, usr)                // Scenario 2
  ├─ blocks = enforceSectionCharCap(blocks)                         // Scenario 3
  ├─ blocks = bytePayloadGuard(blocks)                              // Scenario 4
  └─ return {text: `🧠 Memory (${N+M} entries)`, blocks}
```

### Contract Test

```typescript
it('renders all entries as section+actions (2 blocks/entry) when N+M <= 20', async () => {
  // Arrange: mem 5 entries, usr 5 entries
  // Act: renderMemoryCard
  // Assert:
  //   blocks.length === 9 + 2*10 === 29
  //   each entry has both section (with original text) and actions with 2 buttons
  //   improve button action_id matches `z_setting_memory_set_improve_<target>_<N>`
  //   clear button has `confirm` object
  //   top and bottom global action blocks each contain [improve_memory_all, improve_user_all, clear_all]
  //   extra actions contain open_modal and z_setting_memory_cancel
});

it('clear button has confirm dialog', () => {
  // Assert: button.confirm exists with title/text/confirm/deny plain_text
});
```

---

## Scenario 2: Block-budget fallback — N+M > 20

### Trigger
9 + 2·(N+M) > 50 즉 N+M ≥ 21.

### Trace

```
collapseFallback(blocks, mem, usr):
  totalEntries = mem.entries.length + usr.entries.length
  overflow = totalEntries - 20   // 9 fixed + 2*20 = 49 ≤ 50 cap
  // 큰 store부터 오래된(낮은 index) 쪽을 접음
  larger = mem.entries.length >= usr.entries.length ? 'memory' : 'user'
  takeFrom[larger] = overflow
  // 한쪽으로 다 못 덜어내면 반대쪽도 부분 접음
  if takeFrom[larger] > mem[larger].entries.length - 3:  // 최소 3개 per-entry 유지
     spill = takeFrom[larger] - (mem[larger].entries.length - 3)
     takeFrom[other] = spill
  for each target with collapse:
    collapsed = target.entries.slice(0, collapseCount)
    kept     = target.entries.slice(collapseCount)
    collapsedText = collapsed.map((t, i) => `*#${i+1}*: ${escapeMrkdwn(truncate(t, 200))}`).join('\n\n')
    // 3000 char 분할(Scenario 3 적용)
    collapsedSections = chunkByChars(collapsedText, 2900).map(c => section(text=c))
    // 그 store 영역의 per-entry section+actions를 collapsedSections + kept per-entry로 교체
    replaceGroupEntries(blocks, target, collapsedSections, kept)
  prepend banner context: `⚠️ ${totalCollapsed}개 항목은 요약 표시됨 — 개별 개선/삭제 불가. 전체 보기는 /z memory save ...`
  return blocks
```

### Contract Test

```typescript
it('collapses larger store when N+M > 19', async () => {
  // Arrange: mem 20, usr 0  => overflow=1, keep 19 per-entry (floor constraint hit)
  // Act: renderMemoryCard
  // Assert:
  //   blocks.length <= 50
  //   context block 중 '⚠️' 배너 존재
  //   mem collapsed section count + kept per-entry × 2 + fixed 11 == blocks.length
});

it('spreads collapse across both stores when one cannot absorb', async () => {
  // Arrange: mem 15, usr 15 => overflow=11; mem-only takeFrom would leave 4 (<3 floor not hit), but test spill path via mem 30, usr 30 (overflow=41)
  // Assert: both mem and user have collapsed sections
});

it('never emits more than 50 blocks', async () => {
  // Arrange: mem 50 short entries, usr 50 short entries
  // Assert: blocks.length <= 50
});
```

---

## Scenario 3: Section 3000-char cap

### Trace

```
enforceSectionCharCap(blocks):
  for b of blocks:
    if b.type === 'section' && b.text && b.text.text:
      if b.text.text.length > 3000:
        // preview-friendly truncate
        b.text.text = b.text.text.substring(0, 2960) + '\n_…(전체 보기는 `/z memory save`)_'
  return blocks
```

> 참고: collapsed section 생성 시에는 이미 chunkByChars(text, 2900)으로 분할했으므로 enforce가 재작동해도 no-op.

### Contract Test

```typescript
it('truncates per-entry section text > 3000 chars', async () => {
  // Arrange: mem.entries[0] = 'a'.repeat(5000)
  // Act: renderMemoryCard
  // Assert: that entry's section.text.text.length <= 3000
  //         contains '…(전체 보기는' suffix
});

it('chunkByChars splits collapsed text into <= 2900 segments', () => {
  // Act: chunkByChars('x'.repeat(10000), 2900)
  // Assert: every chunk.length <= 2900; join restores original
});
```

---

## Scenario 4: Byte payload guard

### Trace

```
bytePayloadGuard(blocks):
  size = Buffer.byteLength(JSON.stringify(blocks), 'utf8')
  if size <= 12000: return blocks
  // stage 1: per-entry section text → 400-char truncate
  for b of blocks where per-entry section:
    b.text.text = truncateBytes(b.text.text, 400) + '\n_…(잘림)_'
  size2 = Buffer.byteLength(JSON.stringify(blocks), 'utf8')
  if size2 <= 12000: annotate '⚠️ 일부 entry 요약 표시됨'; return
  // stage 2: collapse user profile entirely into single truncated section
  replaceUserWith(singleCollapsedSection(truncatedText))
  annotate '⚠️ user profile 요약 표시됨'
  return blocks
```

### Contract Test

```typescript
it('keeps byte size <= 12000 when entries are long', async () => {
  // Arrange: 12 mem entries × 2000 chars, 12 user × 100 chars
  // Act: renderMemoryCard
  // Assert: Buffer.byteLength(JSON.stringify(blocks), 'utf8') <= 12000
});
```

---

## Scenario 5: Mrkdwn escape

### Trace

```
escapeMrkdwn(s):
  s = s.replace(/&/g, '&amp;')
  s = s.replace(/</g, '&lt;')
  s = s.replace(/>/g, '&gt;')
  s = s.replace(/\*/g, '\u2217')   // asterisk op
  s = s.replace(/_/g, '\u2f96')    // kangxi radical
  s = s.replace(/`/g, '\u02cb')    // modifier grave
  s = s.replace(/~/g, '\u223c')    // tilde op
  return s
```

### Contract Test

```typescript
it('neutralizes mention tokens and mrkdwn syntax', () => {
  const inp = '<@U123> *X* <!here> a&b `c`'
  const out = escapeMrkdwn(inp)
  expect(out).not.toContain('<@U123>')
  expect(out).not.toContain('*')
  expect(out).toContain('&amp;')
  expect(out).toContain('&lt;!here&gt;')
})

it('section text uses escaped content', async () => {
  // Arrange: mem.entries[0] = '<!here> *bold*'
  // Act: renderMemoryCard
  // Assert: section.text.text !includes('<!here>'), !includes('*bold*')
})
```

---

## Scenario 6: applyMemory — `improve_memory_<N>`

### Trigger
Button click → action_id `z_setting_memory_set_improve_memory_3` → regex → value=`improve_memory_3` → handleSet → applyMemory.

### Trace

```
applyMemory({userId, value:'improve_memory_3', respond})
  ├─ match /^improve_(memory|user)_(\d+)$/  → target='memory', idx=3
  ├─ mem = loadMemory(userId, 'memory')
  ├─ if idx > mem.entries.length: return {ok:false, summary:'❌ entry 없음', rerender:'topic'}
  ├─ await respond?.(renderPendingCard(userId, 'memory', 3))  // "🔄 #3 개선 중…"
  ├─ try { improved = await improveEntry(mem.entries[2], 'memory') }
  │  catch (e) → return {ok:false, summary:'❌ 개선 실패: '+e.message, rerender:'topic'}
  ├─ result = replaceMemoryByIndex(userId, 'memory', 3, improved)
  ├─ if !result.ok: return {ok:false, summary:'❌ 저장 실패: '+result.reason, rerender:'topic'}
  └─ return {ok:true, summary:'✅ memory #3 개선 완료', rerender:'topic'}
```

### Contract Test

```typescript
it('replaces memory entry via replaceMemoryByIndex', async () => {
  // Arrange: mock improveEntry → 'refined'; mock replaceMemoryByIndex → {ok:true}; spy respond
  // Act: applyMemory({userId, value:'improve_memory_3', respond})
  // Assert:
  //   improveEntry called with (entries[2], 'memory')
  //   replaceMemoryByIndex called with (userId, 'memory', 3, 'refined')
  //   respond called once BEFORE replace (pending card)
  //   return {ok:true, summary:..., rerender:'topic'}
});

it('returns failure when LLM throws', async () => {
  // Arrange: improveEntry → throw
  // Assert: replaceMemoryByIndex NOT called; return.ok===false; summary startsWith('❌ 개선 실패')
});

it('returns failure when store rejects', async () => {
  // Arrange: replaceMemoryByIndex → {ok:false, reason:'entry too long'}
  // Assert: return.ok===false; summary includes 'too long'
});
```

---

## Scenario 7: applyMemory — `improve_user_<N>`

동일 패턴, target='user'. (생략)

---

## Scenario 8: applyMemory — `improve_memory_all`

### Trace

```
applyMemory({userId, value:'improve_memory_all', respond})
  ├─ match /^improve_(memory|user)_all$/  → target='memory'
  ├─ cur = loadMemory(userId, 'memory').entries
  ├─ if cur.length === 0: return {ok:true, summary:'ℹ️ entries 없음', rerender:'topic'}
  ├─ await respond?.(renderPendingCard(userId, 'memory', 'all'))
  ├─ try { improved = await improveAll(cur, 'memory') }
  │  catch (e) → return {ok:false, summary:'❌ 개선 실패: '+e.message, rerender:'topic'}
  ├─ result = replaceAllMemory(userId, 'memory', improved)    // atomic prevalidate
  ├─ if !result.ok: return {ok:false, summary:'❌ 저장 실패: '+result.reason, rerender:'topic'}
  │  // store 불변 (prevalidate before write)
  └─ return {ok:true, summary:`✅ memory ${cur.length} → ${improved.length} 재구성`, rerender:'topic'}
```

### Contract Test

```typescript
it('atomically rebuilds memory via replaceAllMemory', async () => {
  // Arrange: improveAll → ['a','b','c']; replaceAllMemory → {ok:true}
  // Act: applyMemory({userId, value:'improve_memory_all'})
  // Assert:
  //   improveAll called with (cur, 'memory')
  //   replaceAllMemory called with (userId, 'memory', ['a','b','c'])
  //   clearMemory / addMemory NOT called
  //   return.rerender === 'topic'
});

it('preserves original entries when replaceAllMemory rejects', async () => {
  // Arrange: improveAll → ['x'.repeat(5000)]; replaceAllMemory → {ok:false, reason:'entry too long'}
  // Act: applyMemory({userId, value:'improve_memory_all'})
  // Assert:
  //   return.ok === false
  //   summary includes 'too long'
  //   (integration: file contents unchanged — tested in Scenario 12)
});
```

---

## Scenario 9: applyMemory — `improve_user_all`
동일, target='user'. (생략)

---

## Scenario 10: user-memory-store — atomic rename

### Trace

```
writeEntries(userId, target, entries):
  filePath = getFilePath(userId, target)
  dir = path.dirname(filePath)
  if (!fs.existsSync(dir)): fs.mkdirSync(dir, {recursive:true})
  tmpPath = `${filePath}.tmp.${pid}.${Date.now()}`
  content = entries.join(ENTRY_DELIMITER)
  try:
    fs.writeFileSync(tmpPath, content, 'utf-8')
    fs.renameSync(tmpPath, filePath)    // atomic on POSIX
  catch err:
    try: fs.unlinkSync(tmpPath) catch {}
    throw err
```

### Contract Test

```typescript
it('writes via tmp+rename so partial writes do not corrupt', async () => {
  // Arrange: vi.spyOn(fs,'writeFileSync').mockImplementation((p,c) => {
  //            realFs.writeFileSync(p, c, 'utf-8'); // only writes tmp
  //          });
  //          vi.spyOn(fs,'renameSync').mockImplementation(() => { throw new Error('ENOSPC') });
  //          write initial file with known content
  // Act: addMemory(userId, 'memory', 'new') → throws
  // Assert: original file content unchanged
  //         tmp files cleaned up
});
```

---

## Scenario 11: user-memory-store — `replaceMemoryByIndex`

### Trace

```
replaceMemoryByIndex(userId, target, index, newText):
  entries = readEntries(userId, target)
  if index < 1 || index > entries.length: return {ok:false, reason:'index out of range'}
  perEntryCap = Math.floor(getCharLimit(target) * 0.3)
  if newText.length > perEntryCap: return {ok:false, reason:'entry too long'}
  next = [...entries]
  next[index-1] = newText
  if totalChars(next) > getCharLimit(target): return {ok:false, reason:'total over charLimit'}
  writeEntries(userId, target, next)   // atomic
  return {ok:true}
```

### Contract Test

```typescript
it('replaces 1-based index atomically', () => {
  seedMemory(['a','b','c'])
  expect(replaceMemoryByIndex(u,'memory',2,'NEW')).toEqual({ok:true})
  expect(loadMemory(u,'memory').entries).toEqual(['a','NEW','c'])
})

it('rejects out-of-range without mutation', () => {
  seedMemory(['a','b'])
  expect(replaceMemoryByIndex(u,'memory',99,'x').ok).toBe(false)
  expect(loadMemory(u,'memory').entries).toEqual(['a','b'])
})

it('rejects over-cap newText without mutation', () => {
  seedMemory(['a'])
  expect(replaceMemoryByIndex(u,'memory',1,'x'.repeat(5000)).ok).toBe(false)
  expect(loadMemory(u,'memory').entries).toEqual(['a'])
})
```

---

## Scenario 12: user-memory-store — `replaceAllMemory`

### Trace

```
replaceAllMemory(userId, target, entries):
  if (!Array.isArray(entries) || entries.length === 0): return {ok:false, reason:'empty'}
  if (new Set(entries).size !== entries.length): return {ok:false, reason:'duplicates'}
  perEntryCap = Math.floor(getCharLimit(target) * 0.3)
  for s of entries:
    if (typeof s !== 'string' || s.length === 0): return {ok:false, reason:'empty entry'}
    if (s.length > perEntryCap): return {ok:false, reason:'entry too long'}
  if (totalChars(entries) > getCharLimit(target)): return {ok:false, reason:'total over charLimit'}
  writeEntries(userId, target, entries)   // atomic
  return {ok:true}
```

### Contract Test

```typescript
it('writes full array on valid input', () => {
  seedMemory(['old1','old2'])
  expect(replaceAllMemory(u,'memory',['x','y','z'])).toEqual({ok:true})
  expect(loadMemory(u,'memory').entries).toEqual(['x','y','z'])
})

it('rejects duplicates without mutation', () => {
  seedMemory(['old'])
  expect(replaceAllMemory(u,'memory',['a','a']).ok).toBe(false)
  expect(loadMemory(u,'memory').entries).toEqual(['old'])
})

it('rejects over-limit without mutation (prevalidate)', () => {
  seedMemory(['old'])
  expect(replaceAllMemory(u,'memory',['x'.repeat(3000)]).ok).toBe(false)
  expect(loadMemory(u,'memory').entries).toEqual(['old'])
})
```

---

## Scenario 13: memory-improve — `improveEntry`

### Trace

```
improveEntry(entry, target):
  cred = await ensureValidCredentials()
  if (!cred.valid): throw new Error('credentials invalid: '+cred.error)
  systemPrompt = target==='memory' ? MEMORY_PROMPT : USER_PROMPT
  prompt = `원본:\n${entry}\n\n개선본만 출력:`
  options = {model: config.conversation.summaryModel, maxTurns:1, tools:[],
             systemPrompt, settingSources:[], plugins:[]}
  let text = ''
  for await (msg of query({prompt, options})):
    if (msg.type==='assistant' && msg.message?.content):
      for (b of msg.message.content):
        if (b.type==='text'): text += b.text
  text = text.replace(/[\r\n]+/g,' ').trim()
  if (!text): throw new Error('empty LLM output')
  cap = target==='memory' ? 660 : 412
  return text.substring(0, cap)
```

### Contract Test

```typescript
it('uses memory prompt for target=memory', async () => {
  const opts = captureOptionsMock(query)
  await improveEntry('orig', 'memory')
  expect(opts.systemPrompt).toContain('장기 기억')
  expect(opts.tools).toEqual([])
  expect(opts.maxTurns).toBe(1)
})

it('uses user prompt for target=user', async () => {
  const opts = captureOptionsMock(query)
  await improveEntry('orig', 'user')
  expect(opts.systemPrompt).toContain('페르소나')
})

it('throws on empty output', async () => {
  mockQuery('')
  await expect(improveEntry('orig','memory')).rejects.toThrow('empty LLM output')
})

it('truncates to per-entry cap', async () => {
  mockQuery('x'.repeat(5000))
  expect((await improveEntry('o','memory')).length).toBe(660)
})
```

---

## Scenario 14: memory-improve — `improveAll`

### Trace

```
improveAll(entries, target):
  ensureValidCredentials()
  prompt = `다음 ${entries.length}개 항목을 정리·중복제거·통합해 더 짧은 entries로 재구성.\n`
         + `출력: JSON array of strings, 다른 텍스트 없이.\n\n`
         + `---\n${entries.join('\n---\n')}`
  text = collectText(query(...))
  arr = null
  try:
    jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch): arr = JSON.parse(jsonMatch[0])
  catch {}
  if (!Array.isArray(arr) || arr.some(x => typeof x !== 'string')):
    arr = text.split(/\n-{3,}\n/).map(s=>s.trim()).filter(Boolean)
  if (arr.length === 0): throw new Error('improveAll returned empty')
  cap = target==='memory' ? 660 : 412
  return arr.map(s => s.substring(0, cap))
```

### Contract Test

```typescript
it('parses JSON array output', async () => {
  mockQuery('["a","b","c"]')
  expect(await improveAll(['x','y'],'memory')).toEqual(['a','b','c'])
})

it('falls back to --- split when JSON parse fails', async () => {
  mockQuery('a\n---\nb\n---\nc')
  expect(await improveAll(['x'],'memory')).toEqual(['a','b','c'])
})

it('truncates each entry to cap', async () => {
  mockQuery(JSON.stringify(['x'.repeat(5000)]))
  const r = await improveAll(['x'],'memory')
  expect(r[0].length).toBe(660)
})
```

---

## Scenario 15: 2-stage rerender — apply signature + handleSet

### Trace

```
// ZTopicBinding interface (z-settings-actions.ts)
interface ZTopicBinding {
  apply(args: {
    userId: string; value: string; actionId: string; body: BlockAction;
    respond?: (blocks: KnownBlock[]) => Promise<void>;
  }): Promise<{ ok: boolean; summary: string; rerender?: 'topic' }>;
  renderCard(args: { userId: string; issuedAt: number }): Promise<{ text: string; blocks: KnownBlock[] }>;
  ...
}

// handleSet
await ack();
const zRespond = respondFromActionBody({body, client, respond: respondFn});
const respondClosure = async (blocks) => zRespond.replace({text: '🧠 Memory', blocks});
const result = await binding.apply({userId, value, actionId, body, respond: respondClosure});
if (result.rerender === 'topic') {
  const card = await binding.renderCard({userId, issuedAt: Date.now()});
  await zRespond.replace(card);
} else {
  await zRespond.replace(buildConfirmationCard(result));
}
```

### Contract Test

```typescript
it('passes respond closure to binding.apply', async () => {
  const applySpy = vi.fn(async () => ({ok:true, summary:'...', rerender:'topic'}))
  bindingMock.apply = applySpy
  await simulateButton('z_setting_memory_set_improve_memory_1', 'improve_memory_1')
  expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({
    respond: expect.any(Function)
  }))
})

it('re-renders topic card when rerender flag present', async () => {
  bindingMock.apply = async () => ({ok:true, summary:'ok', rerender:'topic'})
  bindingMock.renderCard = vi.fn(async () => ({text:'🧠 Memory', blocks:[{type:'header'}]}))
  await simulateButton('z_setting_memory_set_improve_memory_1', 'improve_memory_1')
  expect(bindingMock.renderCard).toHaveBeenCalled()
  // buildConfirmationCard NOT called
})

it('falls back to confirmation card when rerender undefined', async () => {
  bindingMock.apply = async () => ({ok:true, summary:'ok'})
  bindingMock.renderCard = vi.fn()
  await simulateButton('z_setting_memory_set_clear_memory_1', 'clear_memory_1')
  expect(bindingMock.renderCard).not.toHaveBeenCalled()
  // zRespond.replace called with confirmation card
})
```

---

## Scenario 16: z-settings-actions — rerender routing

커버: Scenario 15와 동일한 케이스, action-handler 레벨 integration.

---

## Scenario 17: Regression — clear_* / cancel

### Trace
기존 branches 그대로:
- `clear_memory_<N>` → removeMemoryByIndex → `{ok, summary}` (rerender 미설정)
- `clear_user_<N>` → 동일
- `clear_all` → clearAllMemory → `{ok, summary}`
- `cancel` → ui-builder 표준 경로 (handleSet 분기 이전에 match)

### Contract Test

```typescript
it('clear_memory_3 removes by index, no topic rerender', async () => {
  // Act: applyMemory({userId, value:'clear_memory_3'})
  // Assert: removeMemoryByIndex called with (userId,'memory',3)
  //         return.rerender === undefined
})

it('clear_all still calls clearAllMemory without topic rerender', async () => {
  // Act: applyMemory({userId, value:'clear_all'})
  // Assert: clearAllMemory(userId) called
  //         return.rerender === undefined
})

it('cancel button present with correct action_id', async () => {
  // Act: renderMemoryCard
  // Assert: blocks에 z_setting_memory_cancel action_id 포함 (기존 테스트 호환)
})
```

---

## Integration Verification

최종 E2E (manual + vitest):
- 실제 Slack workspace에서 `/z memory` 실행 → 5+5, 10+10, 20+20 엔트리 케이스별 렌더 확인
- 각 entry 아래 [🪄 개선, 🗑️ 삭제] 버튼 노출, 🗑️는 confirm dialog
- '🪄 개선' 클릭 → pending card "🔄 #N 개선 중…" 즉시 표시 → LLM 완료 후 갱신된 memory card로 교체
- '🪄 전체 메모리 개선' 클릭 → entries 통합·중복제거되어 줄어듦, 실패 시 원본 보존
- '🗑️ 전체 삭제' → 기존 confirm → clearAllMemory
- '❌ 닫기' cancel → 카드 dismiss
- 50 cap 초과 케이스(20+20)에서 block-budget fallback 작동, `⚠️` 배너, blocks ≤ 50, byte ≤ 12000
- `npm test` 모두 통과 (+신규 memory-topic, memory-improve, user-memory-store, z-settings-actions 테스트)
- CI green
