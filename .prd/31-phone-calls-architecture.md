# 31 — 전화 아키텍처

Status: in-progress

> 한 줄 결론: 데몬의 `PhoneService`가 환경마다 한국AI통신 연결 하나를 들고, 통화마다 자체 음성 세션
> (`PhoneVoiceSession`: 말 감지 → 받아쓰기 → `query()` 대화 → 문장 합성)을 돌린다. server-tools는 `DATA_DIR`의 요청
> 파일로 데몬에 발신을 맡기고 통화 기록 파일을 읽는다. 대시보드는 통화 기록을 대화의 첨부 칸 카드와 통화 보기 창으로 그린다.

## 0. 미니맵

```
31 전화 아키텍처
├─ 1. 흐름 한 장          ─ 모델 → server-tools → 요청 파일 → 데몬 → 플랫폼 → 휴대폰
├─ 2. 모듈 지도           ─ src/phone/* · server-tools · 대시보드 · 배선
├─ 3. 음성 세션           ─ VAD · 받아쓰기 · 대화 모델 · 문장 합성 · 끼어들기 · 첫 마디 · 끊기
├─ 4. 데이터              ─ 설정 절 · 요청/결과 파일 · 통화 기록 · 작업 이벤트
├─ 5. 대시보드            ─ REST · WebSocket · 카드 · 통화 보기
└─ 6. 시험                ─ 단위 · 실서비스 하네스 · 실측
```

## 1. 흐름

```
모델 ──phone_call──► server-tools(stdio, 샌드박스 밖)
                       │ 검증(환경 phone 절 · 번호 · allowTo · 요청자) · 감사 intent
                       ▼
               DATA_DIR/phone/requests/<rid>.json ──(fs.watch + 1 s poll)──► 데몬 PhoneService
                       ▲                                                   │ agent.call(to)
               <rid>.result.json  ◄── { callId } ──────────────────────────┤
                                                                           ▼
                                               한국AI통신 control WS ──► 상대 휴대폰
                                                                           │ 받음
                                               미디어 WS(μ-law 8 kHz) ◄────┘
                                                      │ feedAudio
                                               PhoneVoiceSession ──► 음성 서비스 /api/stt · /api/tts/stream
                                                      │          └──► query() 입력 스트림 (llmux)
                                                      ▼
                                   DATA_DIR/phone/calls/<callId>.json ──► 대시보드 REST · WS · 카드
```

## 2. 모듈 지도

| 파일 | 책임 |
|---|---|
| `src/phone/audio.ts` | 에너지 VAD(`EnergyVad`), WAV 감싸기, 스트림 리샘플러 |
| `src/phone/speech-text.ts` | 스트리밍 응답 → 문장(`SentenceSplitter`), 말할 수 있는 글(`toSpeakable`) |
| `src/phone/voice-client.ts` | 음성 서비스 클라이언트: 받아쓰기, 스트리밍 합성 |
| `src/phone/phone-config.ts` | server-tools 환경의 `phone` 절 파싱 · 검증(데몬 쪽), 시크릿 해석 |
| `src/phone/phone-prompt.ts` | 통화 지시 조립(기본 규칙 → 환경 → 이번 통화) |
| `src/phone/call-store.ts` | 통화 기록(메모리 + `atomicWriteJson`), 갱신 구독 |
| `src/phone/voice-session.ts` | SDK `Session` 구현 — 통화 한 건의 듣기 · 생각 · 말하기 |
| `src/phone/phone-service.ts` | 환경별 `ClawOpsAgent` 연결, 발신, 수신 선별, 요청 파일 감시, 수신 요약 DM. 30초마다 설정을 다시 읽어 `phone` 절이 생기거나(시크릿이 나중에 놓여도) 바뀌거나 빠지면 그 회선을 열고 · 다시 열고 · 닫는다 — 재시작 없음, 통화 중인 회선은 통화가 끝난 뒤 |
| `src/phone/koreaaitel.ts` | SDK 로드(`require('@koreaaitel/sdk/agent')`)와 우리가 쓰는 좁은 타입 |
| `src/agent-runtime/voice-dialog.ts` | 입력 스트림 `query()` 어댑터(통화 대화): 텍스트 델타 · 도구 · 턴 끝 이벤트 |
| `packages/mcp-servers/server-tools/env-phone.ts` | `phone_call` · `phone_calls` (요청 파일 쓰기, 통화 기록 읽기) |
| `src/conversation/phone-routes.ts` | 대시보드 REST(목록 · 한 통화), 권한 |
| `src/conversation/dashboard.ts` | 카드(첨부 칸) · 통화 보기 창 · WS `phone_call_update` |
| `src/index.ts` | `PhoneService` 기동 · 정지, 갱신 → 대시보드 방송 |
| `src/mcp-config-builder.ts` | server-tools에 `SOMA_PHONE_DIR` · `SOMA_PHONE_CONTEXT`(채널 · 스레드 · 대화 ID) |

## 3. 음성 세션 (`PhoneVoiceSession`)

SDK는 세션 객체 하나를 모든 통화에 쓴다. 그래서 래퍼 하나가 통화마다 `CallRun`(상태 묶음)을 만들고, 통화 중에는
다른 통화를 받지 않는다(`onIncoming` → `reject({reason:'busy'})`).

1. **듣기** — `feedAudio(ulaw)` → `ulawToPcm16` → `EnergyVad.push(pcm, agentSpeaking)`.
   - `speech_start`이고 에이전트가 말하는 중이면 끼어들기(§3.4).
   - `utterance` → WAV(8 kHz) → `POST /api/stt`(language ko) → 상대 전사 한 줄.
2. **생각** — 전사를 `voice-dialog`의 입력 스트림에 사용자 메시지로 넣는다. 텍스트 델타는 `SentenceSplitter`로
   문장이 되어 말하기 큐로 간다. `hang_up` 도구는 "말을 다 한 뒤 끊기"로 표시만 한다.
3. **말하기** — 문장마다 `POST /api/tts/stream`(voice cwon, model drama-3, format pcm) → 44.1 kHz → 8 kHz 리샘플 →
   `pcm16ToUlaw` → 160바이트 프레임 `sendAudio`. 한 번에 한 문장, 순서대로. 보낸 오디오 길이로 재생 끝 시각을 추정한다
   (`playEndAt`). 전사의 에이전트 줄은 그 문장 합성을 시작할 때 쓴다.
4. **끼어들기** — `clearAudio()`, 합성 중단(AbortController), 큐 비우기, 생성 중이면 `interrupt()`. 끊긴 문장은 전사에
   `interrupted: true`.
5. **첫 마디** — 발신: `phone_call`을 받으면 대화 모델에 "[연결 대기 — 상대가 받으면 할 첫 마디]"를 보내 첫 문장들을
   만들고 합성해 버퍼에 둔다. 상대가 받은 뒤 상대 첫 말이 끝나거나 1.2 s 조용하면 버퍼를 보낸다. 수신: 설정의
   `inbound.greeting`을 기동 때 합성해 두고 받는 즉시 보낸다.
6. **끊기** — `hang_up` 뒤 말하기 큐가 비고 `playEndAt`이 지나면 `callSession.hangup()`. `max_minutes`가 되면 작별 한
   문장을 합성해 보내고 끊는다. 통화가 끝나면 입력 스트림을 닫고(CLI 종료) 리스를 반납한다.

### 3.1 대화 모델 (`voice-dialog`)

- `query({ prompt: AsyncIterable<SDKUserMessage>, options })`, 옵션: `model`, `systemPrompt`(§4.4), `tools: []`,
  `mcpServers: { phone: createSdkMcpServer(hang_up, send_dtmf) }`, `allowedTools: ['mcp__phone__hang_up',
  'mcp__phone__send_dtmf']`, `includePartialMessages: true`, `settingSources: []`, `plugins: []`,
  `thinking: { type: 'disabled' }`, `env: buildQueryEnv(lease, { llmuxTenant })`, `persistSession: false`.
- 이벤트: `text_delta`(stream_event의 text_delta) · `assistant_text`(완성 메시지) · `tool_use` · `turn_end`(result) · `error`.
- `rules/auth.md`: SDK 런타임 import는 `src/agent-runtime/` 안에만 둔다.

## 4. 데이터

### 4.1 설정 — server-tools 환경의 `phone` 절 (로컬 dev 설정에만)

```json
"2lab-ai-dev": {
  "envUser": "env:2lab-ai-dev",
  "phone": {
    "provider": "koreaaitel",
    "apiKey": { "$secret": "koreaaitel-2lab-ai-dev" },
    "accountId": "AC…",
    "number": "070…",
    "owner": "U…",
    "voice": { "url": "http://<음성 호스트>:9999", "voice": "cwon", "model": "drama-3" },
    "model": "sonnet",
    "outbound": { "systemPrompt": "…", "maxMinutes": 10, "allowTo": ["010…"] },
    "inbound": { "enabled": true, "systemPrompt": "…", "greeting": "…" }
  }
}
```

- `ssh`가 없는 환경을 허용한다(`list`의 `ssh_host`는 `null`, ssh를 쓰는 도구는 "ssh 없음"으로 거절).
- `apiKey`는 `{"$secret"}`만 받는다(아니면 그 `phone` 절을 버린다 — github · cloudflare와 같은 규칙).

### 4.2 요청 · 결과 파일 (`DATA_DIR/phone/requests/`)

- `<rid>.json` = `{ rid, env, to, title, purpose, scenario?, maxMinutes, requester, context: { channel, threadTs,
  conversationId }, createdAt }` — server-tools가 `atomicWriteJson`.
- 데몬이 `<rid>.json` → `<rid>.claimed.json`으로 옮겨 한 번만 처리하고, `<rid>.result.json` = `{ ok, callId? , error? }`.
- server-tools는 결과를 최대 20 s 기다린다. 데몬이 없으면 "phone service is not running"으로 실패, 요청 파일을 지운다.

### 4.3 통화 기록 (`DATA_DIR/phone/calls/<callId>.json`)

```ts
interface PhoneCallRecord {
  id: string; env: string; direction: 'outbound' | 'inbound';
  ourNumber: string; peerNumber: string; title: string;
  purpose?: string; scenario?: string;
  status: 'dialing' | 'active' | 'ended'; endedStatus?: string;
  createdAt: number; answeredAt?: number; endedAt?: number; durationSec?: number;
  requester?: string; conversationId?: string; channel?: string; threadTs?: string;
  model?: string; voice?: string;
  transcript: { role: 'agent' | 'peer'; text: string; at: number; interrupted?: boolean }[];
  work: PhoneWorkEvent[];   // 상한 500
  summary?: string;
}
type PhoneWorkEvent =
  | { kind: 'instruction'; at; text }                          // 통화 지시(목적 · 시나리오)
  | { kind: 'stt'; at; text; ms; audioMs }                      // 받아쓰기
  | { kind: 'reply'; at; text; model; firstTokenMs; ms }        // 모델 응답 한 턴
  | { kind: 'tool'; at; name; input; result? }                  // hang_up · send_dtmf
  | { kind: 'tts'; at; text; firstByteMs; audioMs }             // 문장 합성
  | { kind: 'event'; at; text }                                 // 받음 · 끼어들기 · 끊김
  | { kind: 'error'; at; stage; message };
```

### 4.4 통화 지시 (`phone-prompt.ts`)

```
[통화 규칙] 전화 통화 중이다 · 한두 문장 구어 · 마크다운·목록·이모지 금지 · 숫자는 읽는 말로 ·
            AI냐고 물으면 AI 비서라고 사실대로 · 목적을 이루거나 상대가 끝내면 짧게 인사하고 hang_up ·
            상대가 ARS면 send_dtmf
[환경 지시] outbound.systemPrompt | inbound.systemPrompt
[이번 통화] 방향 · 상대 번호 · 제목 · 목적 · 시나리오 · 요청자 · 지금 시각(KST)
```

## 5. 대시보드

| 길 | 내용 | 권한 |
|---|---|---|
| `GET /api/dashboard/session/:conversationId/phone-calls` | 그 대화의 통화 요약 목록 | 비공개 작업 게이트(onRoute)가 자동으로 붙는 경로 |
| `GET /api/dashboard/session/:conversationId/phone-calls/:callId` | 통화 전체(전사 · 작업) | 같음 |
| `GET /api/dashboard/phone-calls/:callId` | 대화 없는 통화(받은 전화) | 통화의 owner · 요청자 · 어드민 |
| WS `phone_call_update` | `{ conversationId?, call: 요약 }` | 대화가 있으면 대화의 청중(`sendToConversationAudience`), 없으면 owner · 어드민 |

- 카드의 클릭은 요소 데이터(`data-phone-call` · `data-phone-cid`)로 `openPhoneCallEl(this)` — 인라인 핸들러에 이스케이프한 인자를 싣지 않는 페이지 규칙.
- 카드: `convTurnsOf`가 `c.calls`를 답 턴의 첨부 칸에 시간 창으로 넣는다(`createdAt ∈ (이전 턴, 이 턴]`). 남은 최근
  통화는 마지막 턴에 붙는다. `convSlots`가 카드 HTML을 그린다.
- 통화 보기: `<dialog id="phone-call-dialog">` — 머리글 + 탭(통화 = 말풍선 대화, 상대 왼쪽 · 에이전트 오른쪽, 위에 요약;
  작업 = 시간순 목록). 열린 동안 WS 갱신이 다시 읽어 그린다(0.5 s 묶음). `?phoneCall=<id>`로 바로 열린다.

## 6. 시험

- 단위: VAD(합성 사인파 · 무음), 문장 분할, 프롬프트 조립, 설정 검증, 통화 기록 저장 · `.bak`, server-tools 도구
  (요청 파일 · 결과 대기 · 권한 · allowTo), 음성 세션(가짜 CallSession · 가짜 음성 클라이언트 · 가짜 대화로 끼어들기 ·
  첫 마디 · hang_up 순서), 대시보드 클라이언트 함수(카드 HTML · 턴 배치).
- 실서비스 하네스: 실제 음성 서비스 + 실제 llmux로 합성 음성을 세션에 흘려 전사 → 응답 → μ-law 프레임까지(전화망 제외).
- 실측: 로컬 dev 배포 후 소유자 번호로 발신(A2–A6), 070으로 수신(A7).
