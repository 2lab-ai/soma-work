# Slack 출력 통일 (Output Unification) — Design Doc

> **상태**: Proposal
> **추적 이슈**: #824 (epic tracking)
> **참조**: #823 (directive as-is 스펙), #525 / #669 (5블록 UI)

## 1. Context

soma-work에서 "모델 응답 → Slack 출력" 영역에 **3개의 처리 시스템**이 공존한다. 각 시스템은 따로 도입되어 책임이 부분적으로 겹치며, 모델 입장에서 일관된 멘탈 모델이 없다. 결과적으로 같은 Slack API 종착점이 3개의 코드 경로에서 호출되고, 출력 양식별로 어느 시스템을 써야 하는지가 시스템마다 다른 룰로 흩어져 있다.

### 1.1 3개 시스템 — 책임 매트릭스

| 책임 영역 | A. directive (텍스트 내 JSON) | B. 5블록 (TurnSurface) | C. slack-mcp (별도 MCP 서버) | 평가 |
|---|:---:|:---:|:---:|---|
| 채널 루트 포스팅 | ✅ | ❌ | ❌ | A 단독 |
| 스레드 reply 본문 (자동) | ❌ | ✅ B1 stream | ❌ | B 단독 |
| 스레드 reply 본문 (능동) | ❌ | ❌ | ✅ | **B vs C 중복** |
| 진행 spinner | ❌ | ✅ B4 native | ❌ | B 단독 |
| 계획 카드 | ❌ | ✅ B2 (`TodoWrite`) | ❌ | B 단독 |
| 사용자 선택 폼 | ❌ | ✅ B3 (`UIAskUserQuestion`) | ❌ | B 단독 |
| 완료 마커 | ❌ | ✅ B5 | ❌ | B 단독 |
| 파일 업로드 | ❌ | ❌ | ✅ | C 단독 |
| 스레드 메시지 읽기 | ❌ | ❌ | ✅ | C 단독 |
| 파일 다운로드 | ❌ | ❌ | ✅ | C 단독 |
| ephemeral 출력 | ❌ | ❌ | ❌ | **부재** |
| 메시지 갱신 (chat.update) | ❌ | ✅ (planTs 한정) | ❌ | **일반 update 부재** |
| 세션 메타 링크 (jira/issue/pr/doc) | ✅ | ❌ | ❌ | A 단독 |
| 작업 디렉토리 등록 | ✅ | ❌ | ❌ | A 단독 |

### 1.2 트리거 메커니즘 — 비대칭

| 시스템 | 트리거 | 활성화 |
|---|---|---|
| A. directive | 모델 텍스트 내 JSON 패턴 (코드펜스 또는 raw) | 항상 |
| B. 5블록 | SDK 메시지 종류 (assistant text chunk / tool 호출 / lifecycle) | `SOMA_UI_5BLOCK_PHASE >= 1` |
| C. slack-mcp | 모델의 SDK `tool_use` 능동 호출 | **mid-thread mention 세션만** |

### 1.3 핵심 결함

1. **트리거 모델 3종 공존** — 모델이 어떤 출력을 어느 채널로 보내야 하는지 일관 룰 없음.
2. **`chat.postMessage` 종착점 3경로 중복** — 시스템 A/B/C 모두 같은 API 종착점으로 수렴. 모델이 잘못된 도구를 고르면 silent overlap.
3. **활성화 비대칭** — slack-mcp는 mid-thread만, 다른 둘은 항상. 같은 책임이 세션 종류에 따라 다른 채널로 나감.
4. **카탈로그 갭** — 합쳐도 ephemeral / 일반 chat.update / 특정 ts에 thread reply / 파일 업로드 directive가 부재. 모델은 시스템마다 다른 룰을 외워야 함.
5. **directive ID/지속 핸들 부재** — 발사 후 ts/permalink 회수 불가 → 두 단계 작업("그 메시지 ts에 reply") 불가능.
6. **directive 이중 fire 가능성** — streaming 청크와 final result 양쪽에서 directive 추출이 일어나 텍스트 dedup만 있고 directive 레벨 dedup 없음 (#823 B1).

## 2. Decision

### 2.1 책임 축 분리

```
모델 응답
 ├── 텍스트 본문 ────────────► [하류 라이터] 5블록 B1 stream (자동, TurnSurface)
 ├── TodoWrite ─────────────► [하류 라이터] 5블록 B2 plan (자동)
 ├── UIAskUserQuestion ─────► [하류 라이터] 5블록 B3 form (자동)
 └── tool_use ──────────────► [상류 능동 사이드 채널] slack-mcp 카탈로그
                              ├ 채널 루트 포스팅
                              ├ ephemeral
                              ├ 파일/미디어 업로드
                              ├ 메시지 갱신
                              ├ 특정 ts에 thread reply
                              ├ 세션 메타 (jira/issue/pr/doc)
                              └ 작업 디렉토리 등록

turn lifecycle (begin/end/fail) ────► [하류 라이터] 5블록 B4 spinner / B5 완료
```

### 2.2 결정 사항

1. **상류 능동 사이드 채널을 SDK `tool_use`로 단일화**
   - directive 시스템(A)을 deprecate → slack-mcp(C) 카탈로그로 흡수
   - 이유:
     - `tool_use`는 SDK 표준 — 모든 LLM(Claude/Codex/Gemini)이 동일하게 다룸
     - `tool_result`로 ts/permalink 회수 가능 → idempotency / 후속 액션 라우팅 자연 해결
     - 외부 카탈로그 자동 (SDK가 tool 명세를 노출)

2. **하류 라이터(5블록 B1~B5)는 그대로 유지**
   - 이유:
     - Streaming 본문(B1)을 `tool_use`로 wrapping하면 한 turn당 수백 round-trip → 비현실적
     - SDK 이벤트 종류 기반 자동 분기는 잘 작동 (Issue #525 phase 1~5 롤아웃 완료)
     - B2(`TodoWrite`) / B3(`UIAskUserQuestion`)은 이미 SDK tool 기반

3. **slack-mcp 활성화를 모든 세션으로 확대**
   - 현행: mid-thread mention만 활성
   - 변경 후: 모든 Slack 세션에서 활성
   - 이유: 활성화 비대칭 제거 — 같은 책임이 세션 종류에 따라 다른 채널로 나가는 문제 해소

4. **directive 시스템 완전 폐기**
   - 코드 + 디스패처 + 사용처 모두 제거
   - dual-mode 기간을 둬서 안전한 마이그레이션

## 3. Catalog Spec — 통합 후 slack-mcp 도구 (총 11)

### 3.1 Read (현행 유지)

| 도구 | 시그니처 | 책임 |
|---|---|---|
| `get_thread_messages` | `{ thread?, offset?, limit?, anchor_ts?, before?, after? }` | 스레드 메시지 array 읽기 |
| `download_thread_file` | `{ file_url, file_name }` | 첨부파일 다운로드 |

### 3.2 Write — 메시지

| 도구 | 시그니처 | 반환 | 비고 |
|---|---|---|---|
| `send_thread_message` (현행) | `{ text, thread? }` | `{ ts, permalink, channel }` | 시그니처는 유지하되 반환 형식 표준화 |
| `post_to_channel_root` (신규) | `{ text, blocks?, headline_only?: boolean }` | `{ ts, permalink, channel }` | ← `channel_message` directive 흡수 |
| `send_ephemeral` (신규) | `{ user_id, text, blocks? }` | `{ message_ts }` | 카탈로그 갭 해소 |
| `update_message` (신규) | `{ ts, channel?, text?, blocks? }` | `{ ts, channel }` | 일반 `chat.update` |
| `reply_in_thread` (신규) | `{ thread_ts, text, blocks?, broadcast?: boolean }` | `{ ts, permalink, channel }` | ts 라우팅 — `post_to_channel_root` 결과 ts와 체이닝 |

### 3.3 Write — 파일 (현행 유지, 반환 표준화)

| 도구 | 비고 |
|---|---|
| `send_file` | 임의 타입 업로드 |
| `send_media` | 이미지/오디오/비디오 업로드 + 확장자 화이트리스트 |

### 3.4 Write — 메타

| 도구 | 시그니처 | 책임 |
|---|---|---|
| `set_session_links` (신규) | `{ jira?, issue?, pr?, doc? }` | ← `session_links` directive 흡수 |
| `set_source_working_dir` (신규) | `{ path }` | ← `source_working_dir` directive 흡수 (보안 가드 동일) |

## 4. Trade-offs

### 4.1 장점

- **단일 멘탈 모델**: "텍스트는 그냥 출력 (B1로 자동), 사이드이펙트는 무조건 slack-mcp tool"
- **표준 SDK 메커니즘**: tool_use는 SDK 표준 — Claude/Codex/Gemini 동일 처리
- **Idempotency 자연 해결**: `tool_result`로 ts/permalink 회수 → 같은 액션을 두 번 발사할 동기 없음 → #823 B1(이중 fire) 자연 소멸
- **체이닝 가능**: ts 회수 후 `reply_in_thread`에 그 ts를 넘김 → #823 B2 해결
- **에러 표면화**: tool_result가 실패면 모델이 즉시 인식 → retry/fallback 자연 → #823 B5 해결
- **활성화 일관성**: 모든 세션에서 slack-mcp 활성 → 비대칭 제거

### 4.2 단점

- **마이그레이션 비용**: directive 시스템 코드 + 사용처 모두 deprecate. 모델 system prompt 갱신, 스킬·외부 통합 다수 변경.
- **Tool round-trip latency**: directive는 응답 텍스트 안 즉시 파싱이지만, tool_use는 SDK round-trip. 단, 채널 루트 포스팅류는 한 응답당 1~2회로 영향 미미.
- **호환성 검증 비용**: 기존 directive 사용처를 모두 찾아 변경 필요. 외부 통합/스킬 호출처 누락 시 silent breakage.

## 5. Migration Sequencing

각 단계는 별도 에픽으로 분해. 단계 간 deprecation 기간 둬서 회귀 위험 최소화.

| 에픽 | 의존 | 목표 |
|---|---|---|
| **E1 — slack-mcp activation parity** | 없음 (시작점) | mid-thread mention 한정 활성화를 모든 세션으로 확대. 영향 범위 작음. |
| **E2 — message write catalog** | E1 | `post_to_channel_root` / `send_ephemeral` / `update_message` / `reply_in_thread` 4종 도입. 카탈로그 갭 해소. |
| **E3 — metadata catalog** | E1 | `set_session_links` / `set_source_working_dir` 2종 도입. directive 메타 흡수 준비. |
| **E4 — directive deprecation + call-site migration** | E2, E3 | directive를 dual-mode로 두고 deprecation warning. 사용처(스킬·프롬프트·외부 통합)를 모두 tool_use로 변경. |
| **E5 — directive removal + observability** | E4 | directive 코드 + 디스패처 제거. tool_use 결과(success/failure/duration) 메트릭 추가. |

### 5.1 단계 간 호환 전략

- E1~E3 추가 단계에서는 directive가 그대로 작동 — **회귀 없음**
- E4 dual-mode 진입 시점부터 directive 사용 시 deprecation warning 로그 — 모니터링 가능
- E5에서 directive 제거 — E4 완료된 사용처 grep 결과로 잔여 사용처 0 검증

## 6. Acceptance — 통합 검증

이 design doc 기반으로 진행한 모든 에픽이 완료된 시점에 다음을 검증.

- [ ] #823 B1 (directive 이중 fire) — E5 directive 제거로 자연 소멸
- [ ] #823 B2 (ID/지속 핸들 부재) — E2 신규 tool 반환에 `{ts, permalink, channel}` 포함
- [ ] #823 B3 (thread_reply / ephemeral / file_upload directive 부재) — E2 / E3 신규 tool로 해소
- [ ] #823 B4 (외부 카탈로그 부재) — tool_use는 SDK 표준 카탈로그 자동 노출
- [ ] #823 B5 (옵저버빌리티 약함) — E5 메트릭으로 해소
- [ ] 5블록 시스템(`TurnSurface`, B1~B5) 변경 없음 — Issue #525 phase 1~5 결과 보존

## 7. 비범위 (Out of scope for this doc)

- 5블록 시스템(B1~B5) 자체 변경 — 별도 추적
- Slack 외 다른 채널(Telegram 등) 출력 통합 — 별도 작업
- LLM 백엔드(Codex/Gemini)별 prompt 변경 디테일 — 각 에픽에서 다룸
- Bot identity / OAuth scope 변경 — 별도 작업

## 8. 참고

- #823 — directive as-is 스펙
- #525 — 5블록 UI refactor 에픽
- #669 — 5블록 수렴 에픽
- `docs/slack-ui-phase{1..5}.md` — 5블록 SSOT
- `docs/mcp-extraction/spec.md` — slack-mcp 추출 (2026-03-27)
- `docs/slack-mcp-rename/spec.md` — slack-mcp 리네이밍 + 파일/미디어 (2026-03-28)
- `docs/slack-mcp-cross-thread/spec.md` — work/source 스레드 (2026-04-02)
