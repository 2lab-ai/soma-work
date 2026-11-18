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

**회선 예약 (한 번에 한 통화)** — `busy` = 등록된 run · 준비 중인 run · `line.pending`. `pending`은 첫 `await` 전에
동기로 올린다: 발신은 `dial()` 진입 때(인증·`agent.call` 동안), 수신은 선별 훅이 받기로 정할 때.

**수신 선별** — SDK의 `onIncoming` 훅은 5 s 안에 끝나야 하고, 그 사이 상대가 끊으면 SDK는 `start()`도 끝 이벤트도
부르지 않는다. 그래서 훅은 **결정만** 한다(꺼짐 → rejected, 바쁨 → busy, 아니면 회선을 잡아 둠). run(인증 · 기록 ·
대화)은 SDK가 `start()`할 때 만든다. 잡아 둔 회선은 10 s 안에 `start()`가 없으면 풀린다. 같은 통화의 `start()`가
두 번 와도 run은 하나(진행 중 promise 공유, `attach`는 한 번).

**끝** — 발신은 응답 전 최종 이벤트가 사라질 수 있다(다이얼 응답과 경합, control WS 재연결 중 — 재전송 없음).
`dial` 뒤 75 s(45 s 다이얼 + 30 s) 동안 받지 않은 통화는 워치독이 `no-answer`로 끝낸다. `call_failed`와
`call_end`가 한 통화에 둘 다 올 수 있어 `finish()`는 통화마다 한 번만(요약 · 소유자 DM 한 번).

**재시작** — 시작 때 `dialing`/`active`로 남은 기록을 `interrupted`로 닫는다(끝 이벤트가 다시 오지 않는다). `stop()`은
살아 있는 통화를 디스크에 먼저 닫고 연결을 끊는다. 회선 연결(`connect()`)은 SDK가 네트워크 오류 · 5xx에 영원히
재시도하므로 15 s 상한 — 넘으면 끊고(재연결 루프 정지) 30 s 설정 동기화가 다시 연다. 데몬 부팅은 전화 서비스를
기다리지 않는다(백그라운드 시작).

1. **듣기** — `feedAudio(ulaw)` → `ulawToPcm16` → `EnergyVad.push(pcm, agentSpeaking)`.
   - 에이전트가 말하는 중에 시작한 말이 0.6 s를 넘기면 끼어들기(§3.4). 그보다 짧은 소리("네", "아, 예", 기침)는
     끼어들기가 아니다 — 실통화에서 짧은 맞장구에 여섯 번 끊겼다. 그런 짧은 말과, 끝나면서 첫 마디를 내보낸
     인사("여보세요")는 하던 말을 끊지 않고 그 답이 끝난 뒤 모델에 간다. 잡음으로 끝난 소리 뒤에도 조용한 회선
     타이머를 다시 건다(실통화: 28 s 무응답).
   - `utterance`(말 끝 0.5 s 조용) → WAV(8 kHz) → `POST /api/stt`(language ko) → 상대 전사 한 줄.
2. **생각** — 전사를 `voice-dialog`의 입력 스트림에 사용자 메시지로 넣는다. 텍스트 델타는 `SentenceSplitter`로
   문장이 되어 말하기 큐로 간다(숫자의 소수점 · 천 단위 쉼표에서는 끊지 않는다). `hang_up` 도구는 "말을 다 한 뒤
   끊기"로 표시만 한다. **답은 한 번에 하나** — 상대가 생각 중간에 쉬었다 이어 말하면(실통화: 쉼마다 답이 따로 쌓여
   20 s를 연달아 말함) 새 말이 옛 말에 대한 답을 대신한다: 쓰는 중인 답은 `interrupt()`로 버리고 새 말은 그 턴이
   끝난 뒤 보낸다(앞의 말과 함께 한 번에 답한다). 이미 나가는 답은 끊는다. 버린 답의 `hang_up`은 하지 않는다.
3. **말하기** — 문장마다 `POST /api/tts/stream`(voice cwon, model drama-3, format pcm) → 44.1 kHz → (말 속도
   `voice.speed`: 음성 서비스에 속도 조절이 없어 클라이언트가 WSOLA로 음높이를 지킨 채 줄인다, 10 s에 CPU 0.2 s) → 8 kHz 리샘플 →
   `pcm16ToUlaw` → 160바이트 프레임 `sendAudio`. 한 번에 한 문장, 순서대로. 보낸 오디오 길이로 재생 끝 시각을 추정한다
   (`playEndAt`). 전사의 에이전트 줄은 그 문장 합성을 시작할 때 쓴다.
4. **끼어들기 — 사람처럼 양보한다** (`line-out.ts`). 에이전트 음성은 실시간 속도로, 재생보다 200 ms만 앞서 보낸다(보낸
   오디오는 고칠 수 없으므로). 상대가 에이전트 말 위로 말을 시작하면 즉시 볼륨을 30 %로 낮추고 계속 말한다. 짧은
   맞장구로 끝나면 원래 볼륨으로 돌아온다. 0.6 s를 넘기면 진짜 끼어들기 — 0.3 s 동안 페이드아웃하고(하던 단어를
   부드럽게 끝냄) 남은 말은 버린다. 페이드는 하던 조각에만 걸린다: 아직 시작 안 한 조각은 끊는 순간 버리고(페이드 중에
   시작되지 않는다), 끊은 뒤 들어온 오디오(빠른 다음 답)는 페이드에 들지 않고 끝나면 원래 볼륨으로 나간다. 페이드는
   소리가 0이 되거나 그 조각 오디오가 바닥나면 끝난다(보낼 게 없으면 즉시). 프레임은 타이머에서 나가므로 회선이 오디오를
   거부하면 그 예외는 통화 오류로 한 번만 기록한다(타이머 밖으로 던지지 않음). 합성 중단, 생성 중이면 `interrupt()`. 끊긴 줄은 전사에 `interrupted: true`, 아직
   소리 나지 않은 조각은 전사에 들어가지 않는다. **못 한 말**: OpenAI Realtime이 응답을 실제 재생된 데까지 자르듯,
   다음 모델 입력 앞에 `[시스템: 상대가 끼어들어 네 말이 "…"에서 끊겼다. 못 한 말: "…"]`를 붙인다 — 모델이 상대
   말에 먼저 답하고 필요하면 짧게 이어 말한다. 들린 만큼은 보낸 프레임 비율이고, 아직 합성 중인 조각은 이 통화에서
   잰 말 속도(글자당 프레임)로 잡은 전체 길이에 대고 잰다(아직 합성 중이면 많아야 90 %만 들린 것으로 — 끝은 아직 안 만들어졌다). 못 한 말에는 대기 중·합성 중(아직 소리 0)·큐의 조각이
   들어가고, 페이드가 버린 조각은 잊는다(다음 끊김에 다시 보고하지 않음). 페이드 중 같은 끼어들기의 말이 인식돼도
   처음 쪽지가 그대로 간다(버린 조각은 잊었고 소리 0이라 새로 보고할 게 없다). 페이드 중 빠른 답이 들어왔는데 또
   끊기면 그 답은 버리고 "들리지 않았다"로 알린다. 말 속도·완성 여부는 끝까지 스트리밍된 조각에서만 배운다(엔진 오류로
   끊긴 조각은 다 만든 것으로 치지 않음). 페이드 중 재생 끝 시각은 소리 0까지만 센다(조용한 회선 타이머가 늦지 않게).
4a. **즉시 맞장구** — 상대 말이 끝나는 순간(말 끝 0.5 s) 회선 열 때 미리 만든 "네." / "아, 네."를 들려준다. 진짜 답은
   STT·첫 토큰·합성으로 몇 초 걸린다(실측 중앙값 3.4 s) — 그동안의 정적을 없앤다. 답이 "네,"로 시작하면 떼어 낸다 — 문장부호가 붙은 "네"만: "네 시", "네 명"의 "네"는 숫자다.
4b. **답은 덩어리로** — 첫 조각만 따로 합성하고(빨리 시작), 그 사이 쓰인 나머지는 한 요청으로 합성한다. 엔진이 요청마다
   음성 참조를 다시 읽어 문장 사이에 0.45 s(중앙값)씩 정적이 생겼다.
5. **첫 마디** — 발신: `phone_call`을 받으면 대화 모델에 "[연결 대기 — 상대가 받으면 할 첫 마디]"를 보내 첫 문장들을
   만들고 합성해 버퍼에 둔다. 상대가 받은 뒤 상대 첫 말이 끝나거나 1.2 s 조용하면 버퍼를 보낸다. 수신: 설정의
   `inbound.greeting`을 기동 때 합성해 두고 받는 즉시 보낸다.
6. **끊기** — `hang_up` 뒤 말하기 큐가 비고 `playEndAt`이 지나면 `callSession.hangup()`. `max_minutes`가 되면 작별 한
   문장을 합성해 보내고 끊는다. 통화가 끝나면 입력 스트림을 닫고(CLI 종료) 리스를 반납한다.
7. **조용한 회선** — 에이전트가 말을 마치고(첫 마디 · 수신 인사 · 아무 말 없는 턴 · 받아쓰기가 빈 소리 포함) 15 s
   조용하면 대화에 한 번 재촉하고, 그 답 뒤에도 30 s 조용하면 끊는다. 재촉 횟수는 **상대가 말할 때만** 초기화된다.
8. **리샘플** — HTTP 청크는 샘플(2바이트) 경계에서 끝나지 않는다: 남은 1바이트는 다음 청크 앞에 붙인다. 청크
   마지막 소수 구간까지 보간한다(청크로 나눠도 한 번에 넣은 것과 같은 샘플).
9. **첫 소리 앞당기기** — (a) 전화 음성은 **짧은 참조**로 등록한다: Drama 3는 요청마다 참조를 다시 읽어 첫 바이트가
   참조 길이에 비례한다(실측 cwon 20 s 참조 1.65 s → 9.3 s 0.92 s → 5.9 s 0.70 s; `cwon-phone`). (b) 엔진은 몇 초
   쉬면 첫 바이트가 ~0.8 s 늦다(0.6 → 1.4 s) — 상대 말이 **받아쓰기된 직후** 한 글자 합성으로 깨운다
   (`VoiceClient.warm`, 3 s에 한 번). 말 끝나는 순간 깨우면 같은 호스트의 STT와 자원을 다퉈 STT가 0.9 → 2.5 s로
   느려진다. (c) 턴의 첫 덩어리는 쉼표에서 끊을 수 있다(10자 이상) — 모델이 문장을 다 쓰기 전에 말을 시작한다.

### 3.1 대화 모델 (`voice-dialog`)

- `query({ prompt: AsyncIterable<SDKUserMessage>, options })`, 옵션: `model`, `systemPrompt`(§4.4), `tools: []`,
  `mcpServers: { phone: createSdkMcpServer(hang_up, send_dtmf) }`, `allowedTools: ['mcp__phone__hang_up',
  'mcp__phone__send_dtmf']`, `includePartialMessages: true`, `settingSources: []`, `plugins: []`,
  `thinking: { type: 'disabled' }`, `env: buildQueryEnv(lease, { llmuxTenant })`, `persistSession: false`.
- 이벤트: `text_delta`(stream_event의 text_delta) · `assistant_text`(완성 메시지) · `tool_use` · `turn_end`(result) · `error`.
- `rules/auth.md`: SDK 런타임 import는 `src/agent-runtime/` 안에만 둔다.
- `close()`는 입력을 닫고(대기 중인 입력은 버림) `query.close()`로 CLI까지 끝낸다 — 입력 종료는 EOF일 뿐이라 쓰던 답과
  그 프로세스가 통화 뒤에도 남는다.

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
    "voice": { "url": "http://<음성 호스트>:9999", "voice": "cwon-phone", "model": "drama-3", "speed": 1.5 },
    "model": "sonnet",
    "outbound": { "systemPrompt": "…", "maxMinutes": 10, "allowTo": ["010…"] },
    "inbound": { "enabled": true, "systemPrompt": "…", "greeting": "…" }
  }
}
```

- `ssh`가 없는 환경을 허용한다(`list`의 `ssh_host`는 `null`, ssh를 쓰는 도구는 "ssh 없음"으로 거절).
- `apiKey`는 `{"$secret"}`만 받는다(아니면 그 `phone` 절을 버린다 — github · cloudflare와 같은 규칙).
- server-tools는 `apiKey`를 **풀지 않는다**(자리표시 문자열로 바꿈) — 회선은 데몬이 쥔다. 키가 아직 저장소에 없어도
  그 환경의 다른 도구(ssh · DB)가 빠지지 않는다.

### 4.2 요청 · 결과 파일 (`DATA_DIR/phone/requests/`)

- `<rid>.json` = `{ rid, env, to, title, purpose, scenario?, maxMinutes, requester, context: { channel, threadTs,
  conversationId }, createdAt }` — server-tools가 `atomicWriteJson`.
- 데몬이 `<rid>.json` → `<rid>.claimed.json`으로 옮겨 한 번만 처리하고, `<rid>.result.json` = `{ ok, callId? , error? }`.
- server-tools는 결과를 최대 20 s 기다린다. 데몬이 없으면 "phone service is not running"으로 실패, 요청 파일을 지운다.
- 통화가 걸린 뒤 닫는 감사 줄을 못 써도 `callId`를 돌려준다(`warning` 포함) — 실패로 보이면 모델이 다시 걸 수 있다.
- `phone_calls`: 요청자가 없는 세션은 아무 통화도 못 본다(fail closed). 기록 파일이 깨졌으면 `.bak`에서 읽는다.

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
  updatedAt?: number;       // 바뀔 때마다 엄격히 증가 — 대시보드는 같은 통화의 두 사본 중 새 것을 남긴다
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
| WS `phone_call_update` | `{ conversationId?, call: 요약 }` | REST와 같은 규칙: 요청자 · 대화 주인 · 어드민. 그 스레드에 지시만 한 다른 사람은 받지 않는다 |

- 카드의 클릭은 요소 데이터(`data-phone-call` · `data-phone-cid`)로 `openPhoneCallEl(this)` — 인라인 핸들러에 이스케이프한 인자를 싣지 않는 페이지 규칙.
- 카드: `convTurnsOf`가 `c.calls`를 답 턴의 첨부 칸에 시간 창으로 넣는다(`createdAt ∈ (이전 턴, 이 턴]`). 남은 최근
  통화는 마지막 턴에 붙는다. `convSlots`가 카드 HTML을 그린다.
- 통화 보기: `<dialog id="phone-call-dialog">` — 머리글 + 탭(통화 = 말풍선 대화, 상대 왼쪽 · 에이전트 오른쪽, 위에 요약;
  작업 = 시간순 목록). 열린 동안 WS 갱신이 다시 읽어 그린다(0.5 s 묶음). `?phoneCall=<id>`로 바로 열린다.
- 목록을 읽는 동안 온 WS 갱신은 덮이지 않는다: 응답과 캐시를 통화별로 합치고 `updatedAt`이 큰 쪽이 이긴다. 열린 통화
  보기의 새로 읽기도 겹쳐 순서가 바뀔 수 있어, 더 오래된 사본은 버린다.
- WS 수신자의 "대화 주인"은 살아 있는 세션에서, 없으면(통화 중 보관됨) 대화 기록에서 읽는다.
- 위로 스크롤해 읽는 사람은 새 줄이 와도 그 자리; 맨 아래에 있거나 새로 연 보기는 최신 줄을 따라간다.
- 저장소 메모리: 살아 있는 통화와 아직 디스크에 못 쓴 기록만 둔다. 끝나고 쓴 기록은 디스크에서 읽는다. 쓰기
  실패는 dirty로 남아 5 s 뒤 · 종료 때 다시 쓴다.

## 6. 시험

- 단위: VAD(합성 사인파 · 무음), 문장 분할, 프롬프트 조립, 설정 검증, 통화 기록 저장 · `.bak`, server-tools 도구
  (요청 파일 · 결과 대기 · 권한 · allowTo), 음성 세션(가짜 CallSession · 가짜 음성 클라이언트 · 가짜 대화로 끼어들기 ·
  첫 마디 · hang_up 순서), 대시보드 클라이언트 함수(카드 HTML · 턴 배치).
- 실서비스 하네스: 실제 음성 서비스 + 실제 llmux로 합성 음성을 세션에 흘려 전사 → 응답 → μ-law 프레임까지(전화망 제외).
- 실측: 로컬 dev 배포 후 소유자 번호로 발신(A2–A6), 070으로 수신(A7).
