# Work Plan — Turn-End Surface Guarantee P0 (Phase 1 of 2)

**Trigger**: `$autoz` (옵션 B → codex binding review로 split 결정)
**Brief**: P0 카드 누락 구멍 4개(B-1, B-3, C-2, C-5)를 단일 PR로 fix. **PR #926 watchdog은 유지** — 삭제는 Phase 2 PR에서 C-1 idle-timeout 교체와 함께.
**작성자**: Z + Zhuge, 2026-05-26
**Codex binding review**: session `7bc8a74d-ad7e-4170-8f7f-747c58a066bf`
**관련 문서**: [`exhaustive-paths.md`](./exhaustive-paths.md), [`trace.md`](./trace.md)

---

## 0. 스코프 결정 (binding)

Z 원안 = 단일 PR로 (revert + B-1/B-3/C-2/C-5). Codex 검증 결과 **watchdog 삭제 + C-1 fix 부재 = 현재 HEAD보다 위험**. PR을 둘로 분리.

### Phase 1 (이 PR)
- B-1 ghost-session reason 신설 + 태깅
- B-3 TurnNotifier zero-channels warn
- C-2 TurnSurface.end timeout → fallback notify (once-guard 포함)
- C-5 cleanupTempFiles 위치 이동 + timeout-wrap
- 문서: `exhaustive-paths.md`, `work-plan-b-bundle.md` (이 문서), `trace.md` 갱신
- **watchdog은 건드리지 않음**

### Phase 2 (다음 PR — 본 PR 머지 직후)
- PR #926 revert (`stream-stall-watchdog.ts` 삭제 + 5곳 export 정리 + 와이어 3곳 제거 + 테스트 삭제)
- C-1 fix: `processor.process` idle-timeout wrapper (SDK consumption 지점)

### 이 PR이 다루지 않는 항목
- B-2 unknown-reason policy (lint rule, 별 작업)
- B-4, B-5, B-6: P1
- C-3 (`beginTurn` hang), C-4 (`say` hang), C-6 (`summaryService` hang): P1~P3
- V1 untagged abort (`v1-query-adapter.ts:79-88`): B-2 묶음

---

## 1. 변경 파일 명세 (codex 확인 라인)

### 1.1 구현 변경 (`packages/slack/` 만)

| 파일 | 변경 |
|---|---|
| `packages/slack/src/request-coordinator.ts:27` | `RequestAbortReason` union에 `'ghost-session'` 추가. JSDoc에 "callback self-abort on session.terminated; notify-worthy anomaly" 명시. |
| `packages/slack/src/pipeline/stream-executor.ts:405-415` | `KNOWN_ABORT_REASONS` set에 `'ghost-session'` 추가. |
| `packages/slack/src/pipeline/stream-executor.ts:1063-1065` (onToolUse) | `abortController.abort()` → `abortController.abort('ghost-session' satisfies RequestAbortReason)`. |
| `packages/slack/src/pipeline/stream-executor.ts:1125-1127` (onToolResult) | 동일 패턴 변경. |
| `packages/slack/src/pipeline/stream-executor.ts:1968-1982` (handleError gate) | `stallTimeoutAbort`만 notify-worthy인 게이트를 `notifyWorthyAbort = stallTimeoutAbort \|\| abortReason === 'ghost-session'`로 확장. 메시지 분기에 ghost-session 추가: `'세션이 종료되어 턴이 중단되었습니다.'`. |
| `packages/slack/src/turn-notifier.ts:198-223` (notify) | `if (active.length === 0) return;` 분기에 `logger.warn('TurnNotifier: no enabled channels — terminal card not surfaced', { userId, category });` 추가. |
| `packages/slack/src/turn-surface.ts` (`end()` ~L751-827) | 반환 타입을 `void` → `{ snapshotResolved: boolean }` (또는 동등한 시그널)로 확장. 3s timeout 분기(L817-825)에서 `snapshotResolved=false` 반환. 정상 분기는 `true`. |
| `packages/slack/src/pipeline/stream-executor.ts` (finally의 `endTurn` 호출 근처) | `endTurn()` 결과의 `snapshotResolved=false` && enrichAndResolve의 `.then` notify가 아직 실행되지 않음 (once-guard) 인 경우 fallback `turnNotifier.notify` 호출. fallback args는 L1666-1685의 `fallbackArgs` 사용. |
| `packages/slack/src/pipeline/stream-executor.ts` (enrichAndResolve `.then` ~L1676-1697) | once-guard flag 설정 (예: `let terminalNotified = false;` outer scope, `.then`에서 set, finally의 fallback에서 check). |
| `packages/slack/src/pipeline/stream-executor.ts:1721-1722` (cleanupTempFiles 호출 success path) | 위치를 `finally` 안으로 이동 (terminal surfacing 이후). 또는 `Promise.race([cleanupTempFiles(...), sleep(3000)])`로 timeout-wrap. **두 가지 다 적용** — 위치 이동 + race wrap. |
| `packages/slack/src/pipeline/stream-executor.ts:2215-2218` (cleanupTempFiles 호출 error path in handleError) | 동일하게 timeout-wrap. |

### 1.2 shim/export 확인 (변경 거의 없음)

| 파일 | 확인 사항 |
|---|---|
| `src/slack/request-coordinator.ts` | re-export shim. `'ghost-session'` 추가는 자동 전파 — 변경 불요. |
| `src/slack/pipeline/stream-executor.ts` | provider shim + re-export. 변경 불요. |
| `src/turn-notifier.ts` | re-export. 변경 불요. |
| `src/__tests__/packages-srp-phase2-slack-contract.test.ts` | 새 export 추가/제거 없으므로 변경 불요. |

### 1.3 신규 테스트 (RED → GREEN)

| 파일 | 목적 |
|---|---|
| `packages/slack/src/pipeline/__tests__/ghost-session-abort.test.ts` | B-1: `handleError`를 직접 호출하여 `abortReason='ghost-session'`일 때 `turnNotifier.notify`가 Exception 카테고리로 호출됨을 assert. 추가: `stream-executor.ts:1063, 1125` 두 위치의 abort 호출에 `'ghost-session'` 인자가 있는지 grep-style 어서션 (소스 정적 검사). |
| `packages/slack/src/__tests__/turn-notifier-empty-channels.test.ts` | B-3: 빈 channels[] 또는 모두 isEnabled=false인 채널들로 `TurnNotifier.notify()` 호출 → mock logger의 `warn`이 1회 호출됨을 assert. |
| `packages/slack/src/__tests__/turn-surface-end-fallback.test.ts` | C-2: `TurnSurface.end('completed')`이 3s timeout 분기를 타도록 fake timer 사용. 반환값이 `{ snapshotResolved: false }`인지 assert. |
| `packages/slack/src/pipeline/__tests__/stream-executor-fallback-notify.test.ts` | C-2 통합: enrichAndResolve가 영원히 pending인 fake로 `execute()` 실행 → finally에서 `turnNotifier.notify`가 fallback args로 호출됨을 assert. once-guard: `.then` notify가 늦게 발화해도 두 번째 notify는 호출 안 됨. |
| `packages/slack/src/pipeline/__tests__/cleanup-temp-files-timeout.test.ts` | C-5: `cleanupTempFiles`가 영원히 pending인 fake handler 주입 + fake timer. `threadPanel.endTurn`이 cleanup timeout(3s) 내에 호출됨을 assert (vitest test-level timeout이 아니라 명시적 시점 검증). |

### 1.4 문서

- `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md`: 작성 완료 (commit 포함).
- `docs/current/plans/turn-end-surface-guarantee/work-plan-b-bundle.md`: 이 문서 (commit 포함).
- `docs/current/plans/turn-end-surface-guarantee/trace.md`: ghost-session reason 행 추가, C-2/C-5 fallback 정책 명시. watchdog 행은 유지(Phase 2에서 제거).

---

## 2. RED 테스트 설계 (codex 재설계 반영)

### 2.1 B-1 — `ghost-session-abort.test.ts`
```ts
// Unit seam: handleError를 직접 호출 (StreamExecutor 내부 SDK 모킹 회피)
describe('handleError ghost-session branch', () => {
  it('emits Exception card when abortReason === ghost-session', async () => {
    const notify = vi.fn();
    const turnNotifier = { notify } as any;
    const executor = new StreamExecutor({ ...deps, turnNotifier });
    // Access private via cast — pattern used elsewhere in suite
    await (executor as any).handleError(
      new Error('AbortError'), session, sessionKey, channel, threadTs,
      [], say, true /*requestAborted*/, null, undefined, 'ghost-session'
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      category: 'Exception',
      message: expect.stringContaining('세션이 종료'),
    }));
  });
});

// Source-level 어서션: abort 콜 사이트가 reason을 태깅했는지
it('onToolUse/onToolResult tag abort with ghost-session', async () => {
  const src = await readFile('packages/slack/src/pipeline/stream-executor.ts', 'utf8');
  // 두 위치 모두 'ghost-session' 인자가 있어야 함
  const tagged = src.matchAll(/abortController\.abort\('ghost-session'/g);
  expect(Array.from(tagged)).toHaveLength(2);
});
```
RED 확인: 현재 코드는 untagged → grep 0개 + handleError가 `abortReason='ghost-session'` 분기 미존재 → notify 미호출.

### 2.2 B-3 — `turn-notifier-empty-channels.test.ts`
```ts
const warn = vi.fn();
const logger = { warn } as any;
// Logger 주입은 module-level singleton이므로 spyOn으로 처리
vi.spyOn(loggerInstance, 'warn').mockImplementation(warn);

const notifier = new TurnNotifier([]); // zero channels
await notifier.notify({ category: 'Exception', userId: 'u', channel: 'c', threadTs: 't', durationMs: 0 });
expect(warn).toHaveBeenCalledWith(
  expect.stringContaining('no enabled channels'),
  expect.objectContaining({ userId: 'u', category: 'Exception' }),
);
```
RED 확인: 현재 코드는 L221 `return` — warn 호출 없음.

### 2.3 C-2 — `turn-surface-end-fallback.test.ts` + `stream-executor-fallback-notify.test.ts`
```ts
// turn-surface 단위: timeout 시 snapshotResolved=false 반환
it('end() returns snapshotResolved:false on snapshot timeout', async () => {
  vi.useFakeTimers();
  const surface = new TurnSurface({ ...deps });
  // buildCompletionEvent을 영원히 pending으로
  const result = surface.end('completed', /* never-resolving snapshot */);
  vi.advanceTimersByTime(3500);
  await expect(result).resolves.toEqual({ snapshotResolved: false });
});

// stream-executor 통합: timeout 발생 시 fallback notify 호출
it('falls back to turnNotifier.notify when TurnSurface.end times out', async () => {
  const notify = vi.fn();
  // enrichAndResolve을 영원히 pending으로 → TurnSurface.end timeout 유발
  await executor.execute(params);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({
    category: expect.stringMatching(/^(WorkflowComplete|UIUserAskQuestion|Exception)$/),
  }));
});

// once-guard: late .then 발화 시 두 번 호출 안 됨
it('does not double-notify if enrichment resolves after timeout', async () => {
  const notify = vi.fn();
  let resolveEnrich!: (v: any) => void;
  const enrichPromise = new Promise(r => { resolveEnrich = r; });
  // execute 호출 → TurnSurface.end timeout 발생 → fallback notify (1회)
  const execPromise = executor.execute(params);
  await vi.advanceTimersByTimeAsync(3500);
  // 늦게 enrichment 완료
  resolveEnrich({ category: 'WorkflowComplete', /* ... */ });
  await execPromise;
  expect(notify).toHaveBeenCalledTimes(1); // once-guard
});
```
RED 확인: 현재 `TurnSurface.end()`는 `void` 반환 → snapshotResolved 신호 없음 → stream-executor는 timeout을 감지 못함 → fallback notify 미호출.

### 2.4 C-5 — `cleanup-temp-files-timeout.test.ts`
```ts
it('endTurn is called even when cleanupTempFiles never resolves', async () => {
  vi.useFakeTimers();
  const endTurn = vi.fn();
  const fileHandler = {
    cleanupTempFiles: vi.fn(() => new Promise(() => {})), // never resolves
  };
  const threadPanel = { beginTurn: vi.fn(), endTurn };
  const executor = new StreamExecutor({ ...deps, fileHandler, threadPanel });

  const execPromise = executor.execute({ ...params, processedFiles: [{ /* ... */ }] });
  await vi.advanceTimersByTimeAsync(3500); // cleanup timeout
  await execPromise; // should resolve, not hang

  expect(endTurn).toHaveBeenCalled();
});
```
RED 확인: 현재 코드는 `await cleanupTempFiles(...)` (L1722) — never resolves면 `execPromise`가 영원히 pending. `await execPromise` 자체가 hang → 명시적 vitest timeout 옵션 (e.g. `{ timeout: 5000 }`)으로 fail.

---

## 3. 구현 순서

```
0. 브랜치 생성: fix/turn-end-surface-guarantee-p0
1. RED 테스트 4개 작성 → npm test -- (해당 파일들) 으로 RED 확인
2. B-1 구현: 'ghost-session' reason 신설 + 태깅 + gate + 메시지
3. B-3 구현: turn-notifier.ts warn 추가
4. C-2 구현 (2단):
   a) TurnSurface.end의 반환 타입 확장 (snapshotResolved 신호)
   b) StreamExecutor finally에서 신호 확인 + once-guard + fallback notify
5. C-5 구현: cleanupTempFiles 위치 이동 + 3s timeout-wrap (success path + error path)
6. npm test (전체) — GREEN 확인
7. npm run check (lint + typecheck) — clean 확인
8. trace.md 갱신
9. commit (Co-Authored-By: Zhuge)
10. push + gh pr create
```

---

## 4. 위험 분석 + 완화 (codex 보강)

| 위험 | 완화 |
|---|---|
| `'ghost-session'` reason 추가로 union consumer 깨짐 | codex 확인 — exhaustive switch 없음. 모두 literal/gate 기반. `request-coordinator.ts:27`, `stream-executor.ts:405-415, 1968-1982`만 갱신. action handler들은 영향 없음. |
| C-2 timeout fallback + late `.then` 둘 다 notify | **once-guard 필수** — `terminalNotified` flag outer scope에 두고 양쪽에서 check & set. 테스트로 명시 검증. |
| TurnSurface.end 반환 타입 변경이 다른 호출자 영향 | `TurnSurface.end()` 호출자 grep — stream-executor.ts에서만 사용한다고 가정하나 진행 시 직접 확인. 다른 호출자 있으면 동일 PR에서 갱신. |
| C-5 위치 이동으로 정상 cleanup 타이밍 변화 | 정상 case는 await 시간 변화 없음 (cleanup 자체는 빠름). timeout은 비정상 case에서만 발동. |
| RED 테스트가 `private handleError` 접근 | 같은 suite에서 이미 (executor as any).handleError 패턴 사용 중 — 변동 없음. |
| Phase 2 PR이 미뤄지면 user:dev/qa-dev는 여전히 watchdog에 죽음 | Phase 1 머지 직후 Phase 2 즉시 진행. 일시적으로는 `SOMA_STREAM_STALL_TIMEOUT_MS=0` env로 운영 핫픽스 가능. |
| Phase 2의 C-1 fix는 SDK heartbeat 부재 → 정공법 어려움 | SDK `includePartialMessages` 옵션 + idle-timeout wrapper 조합 필요. Phase 2 plan에서 codex 재상담. |
| V1QueryAdapter cancel/dispose untagged abort | B-2 묶음으로 추후 PR. 이번 PR 영향 없음. |

---

## 5. PR Description Template

```
# fix(turn-end): plug P0 card-emit holes (B-1/B-3/C-2/C-5) — Phase 1 of 2

## Problem
Audit at `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md` enumerated
6 silent-fail holes + 6 hang paths where a turn can end (or stall) without
surfacing the 🟢/🟠/🔴 terminal card invariant. PR #926 added a blunt
10-min stall watchdog as a fail-safe but killed legitimate long-running
turns 100% of the time.

## Fix (Phase 1)
This PR plugs 4 P0 holes. PR #926 watchdog is intentionally KEPT until
Phase 2 (next PR) replaces it with an idle-timeout wrapper at the SDK
consumption point.

1. **B-1** — `onToolUse`/`onToolResult` ghost-session self-abort
   (L1063/L1125) emits `abortController.abort()` untagged → silent.
   Introduce `'ghost-session'` `RequestAbortReason`; tag both sites; add
   notify-worthy branch in `handleError` with message
   `'세션이 종료되어 턴이 중단되었습니다.'`.
2. **B-3** — `TurnNotifier.notify` returns silently when zero channels
   are enabled. Add `logger.warn`.
3. **C-2** — `TurnSurface.end()` 3s snapshot timeout skips B5 emit.
   Extend return type with `snapshotResolved` signal; StreamExecutor
   posts fallback `turnNotifier.notify` on timeout. Once-guard prevents
   double-notify with late enrichment resolution.
4. **C-5** — `cleanupTempFiles` hang blocked `endTurn`. Move cleanup
   after terminal surfacing AND wrap in 3s timeout.

## Test evidence
- 5 new RED tests for B-1/B-3/C-2/C-5 fail against pre-fix code.
- All GREEN post-fix.
- Full suite parity maintained.

## Decision log (binding codex sessions)
- `eeecfada-...` — exhaustive path audit
- `7bc8a74d-...` — work plan review (binding)
  - Split PR (Phase 1/2) instead of bundling watchdog removal —
    deleting watchdog without C-1 fix is worse than current HEAD.
  - C-2 fix lives in StreamExecutor (not TurnSurface) because
    `turnNotifier` is not in `TurnSurfaceDeps`.
  - C-5 fix uses fake timers + endTurn-call assertion, not vitest timeout.

## Docs
- New: `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md`
- New: `docs/current/plans/turn-end-surface-guarantee/work-plan-b-bundle.md`
- Updated: `trace.md` (ghost-session reason row added; watchdog row kept)

## Follow-up
- Phase 2 PR (next, immediately after this merges):
  - Revert PR #926 watchdog (delete `stream-stall-watchdog.ts` + 5
    export sites + 3 wire-ups + tests).
  - C-1: `processor.process` idle-timeout wrapper at SDK consumption.
- Backlog:
  - B-2 unknown-reason policy (lint rule + V1 adapter audit)
  - B-4/B-5/B-6 cleanup
  - C-3/C-4/C-6 hang fixes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
Co-Authored-By: Zhuge <z@2lab.ai>
```
