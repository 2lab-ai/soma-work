# 리서치 — 한국AI통신(구 ClawOps) 전화 API로 soma-work 전화 걸기·받기 (2026-11-17)

요약: 한국AI통신 Voice Agent SDK(`@koreaaitel/sdk` 0.62.3, MIT)는 번호 하나에 상시 연결 하나를 두고 그 위로
걸고 받는다. 음성·모델을 우리 것으로 바꾸려면 SDK의 세션 자리에 자체 세션을 꽂아야 한다 — 내장 파이프라인은
문장 단위 스트리밍도, 통화별 지시도, 전사 이벤트도 없다. 그래서 soma-work 데몬이 연결을 들고, 음성은 사내 음성
서비스(Drama 3 · cwon), 대화 모델은 soma-work가 쓰는 같은 `query()` 경로(llmux)로 붙인다.

## 1. 출처

- 문서 전체: `https://platform.koreaaitel.com/llms.txt` → 279개 `.md` 페이지(2026-11-17 내려받음).
  핵심: `getting-started`, `voice-agent`, `sdk/node/agent/{quickstart,architecture,pipeline,custom-providers,events}`,
  `webhooks/call-context`, `voice-agent/managed`, `mcp`, `api/calls/*`.
- SDK 소스: `npm pack @koreaaitel/sdk@0.62.3` → `dist/agent/index.js` · `dist/chunk-A33WN3RL.js` 직접 읽음.
- 계정 실측(소유자 리눅스 브라우저, 클로드 인 크롬, 2026-11-17 16:3x): 체험판(11-24 종료), 070 번호 1개(인바운드
  라우팅 = 대시보드 에이전트 "내 첫 에이전트"), API 키 0개, 발신 10분 · 문자 10건 한도.

## 2. 플랫폼이 정하는 것 (바꿀 수 없음)

| 사실 | 근거 | 우리 설계에 주는 제약 |
|---|---|---|
| 번호 1개당 Agent 연결(control WebSocket) 1개. 새 연결이 오면 옛 연결이 끊긴다 | quickstart "번호 하나당 프로세스 하나" | 세션마다 뜨는 stdio MCP 프로세스는 연결을 들 수 없다 → **데몬이 든다** |
| 통화마다 별도 미디어 WebSocket, G.711 μ-law 8 kHz mono | architecture | 우리 세션이 μ-law를 디코드·인코드한다 |
| API 키 발급은 가입 휴대폰 SMS 인증을 요구한다 | 실측(발급 대화상자 "API 키 발급 인증") | 키 발급은 사람 단계 |
| 체험판 발신 10분 | 실측 | 시험 통화는 짧게 |
| 인바운드: SDK 연결이 있으면 SDK가 받고, 거절·실패는 번호 라우팅(대체 경로)으로 넘어간다 | SDK `IncomingCall.reject` 주석 "reason 없는 거절은 … 대체 경로로 넘긴다" | 번호 라우팅을 바꾸지 않아도 된다(추정 — 실측 대상 G3) |

## 3. SDK 안쪽 (소스로 확인)

- `ClawOpsAgent`는 **세션 객체 하나**(`this._session`)를 모든 통화에 쓴다. 통화마다 `setToolRegistry` ·
  `setRecorder` · `setBuiltinTools` · `setLogger`를 다시 넣고 `start(callSession, tools)`를 부른다.
  → 동시에 두 통화를 하면 상태가 섞인다. 우리 세션은 통화 한 건만 받는다(통화 중 수신은 `busy`로 거절).
- 내장 `PipelineSession`(Node):
  - LLM 응답 **전체**를 모은 뒤 TTS에 넘긴다(`_respond` → `_synthesizeAndSend(fullResponse)`) — 첫 소리가 늦다.
  - `transcript` 이벤트를 내지 않는다(OpenAI/Gemini Realtime만 낸다).
  - 시스템 프롬프트는 생성자에서 한 번 — 통화별 지시가 없다.
  - STT 내장은 Deepgram(키 필요)뿐.
- 세션 인터페이스(`Session`): `start · prewarm · attach · feedAudio(ulaw) · feedDtmf · stop`. `CallSession`이
  `sendAudio(ulaw 160B)` · `clearAudio()` · `hangup()` · `sendDtmfSequence()` · `_emit('transcript', role, text)`를 준다.
- 내장 도구 실행기 `executeBuiltinTool('hang_up' | 'send_dtmf' | …, args, call)`와 코덱 `ulawToPcm16` ·
  `pcm16ToUlaw` · `resamplePcm16`가 공개 export다.
- 발신: `agent.call(to, { timeout })` → `CallSession`(callId 즉시). 결과는 `endedStatus`(completed만 연결됨).
- 패키지: `exports`에 `require` 조건이 있어 CommonJS인 soma-work에서 `require('@koreaaitel/sdk/agent')`로 로드된다
  (Node 26 실측). 타입은 `moduleResolution: node`라 하위 경로 타입을 못 찾는다 → 좁은 로컬 인터페이스로 감싼다.

## 4. 대안과 버린 이유

| 대안 | 버린 이유 |
|---|---|
| 대시보드 에이전트(플랫폼이 실행) + `CallContext` | 음성·모델이 플랫폼 것 — cwon도 llmux도 못 쓴다 |
| 호스팅 MCP(`https://api.koreaaitel.com/mcp`, OAuth) | 같은 이유. 발신은 되지만 대화 두뇌가 플랫폼 에이전트 |
| SDK `OpenAIRealtime` / `GeminiRealtime` | OpenAI·Google 키와 음성 — 요구(cwon · llmux)와 다름 |
| SDK `PipelineSession` + 커스텀 STT/LLM/TTS | §3의 세 가지 결함(전체 응답 뒤 TTS · 전사 없음 · 통화별 지시 없음) |
| 음성 서비스의 voicechat WebSocket에 통째로 연결 | 대화 모델 호출을 음성 서비스가 한다 — soma-work의 `query()` 경로·도구(통화 종료)를 못 쓴다 |
| SIP 트렁크 → 외부 게이트웨이 | 애드온·게이트웨이 운영이 필요. 이번 범위 밖 |

## 5. 음성 서비스 실측 (사내 음성 호스트, 2026-11-17)

| 측정 | 값 |
|---|---|
| `POST /api/tts/stream` cwon, 31자, wav | 첫 바이트 4.05 s, 전체 7.2 s, 44.1 kHz s16le mono |
| 같은 것, 8자 "네, 알겠습니다." pcm ×2 | 첫 바이트 2.23 s / 6.65 s (GPU 경쟁으로 출렁임) |
| `POST /api/stt` 5.06 s 음성 | 3.0 s (RTF 0.59), 원문과 문장부호까지 일치 |

→ 말 끝 → 첫 응답 소리 예상: VAD 0.7 s + STT ~1.2 s + 모델 첫 문장 ~1.5 s + TTS 첫 바이트 2–4 s ≈ **5–7 s**.
전화로는 느리다. 줄이는 수단: 발신 첫 인사는 신호가 가는 동안 미리 만든다, 수신 인사는 기동 때 미리 만든다,
문장마다 TTS를 바로 시작한다. 남는 지연은 gap으로 기록한다(loop G1).

## 6. soma-work 쪽 제약 (코드로 확인)

- 모든 Claude 호출은 Agent SDK `query()` 한 길(`rules/auth.md`). llmux 키·주소는 `buildQueryEnv(lease, { llmuxTenant })`가
  넣는다(`src/auth/query-env-builder.ts`). 통화 한 건 = 입력 스트림 `query()` 한 개(통화 동안 CLI 프로세스 하나).
- 시크릿 저장소(`<config dir>/secrets`)는 모든 모델에 닫혀 있다 — 키를 넣는 것은 사람 단계.
- stdio MCP 서버는 데몬을 부를 길이 없다. 이미 쓰는 길은 "MCP가 `DATA_DIR`에 파일을 쓰고 데몬이 감시"(권한 프롬프트,
  크론)다. 모델은 `DATA_DIR`에 쓰지 못하므로 그 폴더의 요청 파일은 server-tools 프로세스만 만들 수 있다.
- Slack 없는 세션은 없다(#855 계약 테스트). 통화는 세션이 아니라 **세션의 첨부 기록**으로 둔다.
- 대화 화면의 첨부 칸(`attachments-<turnId>`)에 카드를 넣는 길은 산출물(#1074)이 이미 쓴다.
