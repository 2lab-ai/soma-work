# Runbook: Eagle-eye incident receiver

Eagle-eye 알림 스레드에서 봇이 **무인(unattended) 인시던트 시도 1회**를 돌리는 경로의 운영 절차.
기본값은 **꺼짐**이고, 아래 두 env가 모두 유효할 때만 열린다.

> 상태: 이 문서는 현재 브랜치 코드 기준의 운영 절차서다. **라이브 실측(live proof)은 아직 실행되지 않았다.**
> "구현 완료"나 "live green"을 이 문서로 주장하지 않는다.

---

## 1. Config (env)

| 변수 | 의미 | 읽는 곳 |
|---|---|---|
| `SOMA_INCIDENT_TRUSTED_SOURCE` | 신뢰 발신자 앵커(JSON object) | `getIncidentTrustedSource()` — `src/config.ts:246` |
| `SOMA_INCIDENT_EVIDENCE_BASE_URL` | evidence collector origin | `getIncidentEvidenceConfig()` — `src/config.ts:295` |

`SOMA_INCIDENT_TRUSTED_SOURCE` 필수 필드: `teamId`, `appId`, `botUserId`, `botId`, `channelIds` (비어있지 않은 배열,
각 항목은 정확한 Slack 채널 id, 와일드카드 금지). 형식 예시 — **아래 값은 자리표시자이며 실제 자격증명이 아니다**:

```jsonc
// SOMA_INCIDENT_TRUSTED_SOURCE (실제 값은 운영자가 시크릿 저장소에서 주입)
{"teamId":"<TEAM_ID>","appId":"<APP_ID>","botUserId":"<BOT_USER_ID>","botId":"<BOT_ID>","channelIds":["<CHANNEL_ID>"]}
```

```sh
# SOMA_INCIDENT_EVIDENCE_BASE_URL — origin only (https, 또는 loopback http). path/query/credential 금지.
SOMA_INCIDENT_EVIDENCE_BASE_URL=https://<eagle-eye-host>
```

두 getter 모두 호출 시점에 `process.env`를 읽는다 ⇒ **값 변경은 봇 재시작 후 반영**된다.

## 2. 기본 비활성 + 3중 게이트

세 게이트가 모두 통과해야 시도가 디스패치된다. 하나라도 실패하면 그 요청 메시지는 **버려진다** — 일반 핸들러로
넘어가 평범한 턴이 되지 않는다. 마커 줄이 없는 다른 메시지는 이 게이트와 무관하게 평소대로 처리된다.

> **수신기가 꺼진 상태(기본값)에서도 같다.** `app_mention`에서 선행 멘션을 떼어낸 어느 줄이
> `EAGLE_INCIDENT_REQUEST:`로 시작하면, 신뢰 앵커가 없어도 분류기가 `receiver_disabled`로 거부하고
> (`packages/slack/src/incident-contract.ts:209`), ingress는 `Incident request denied` warn 로그
> (`reason: receiver_disabled`)를 남긴 뒤 이벤트를 버린다 (`packages/slack/src/event-router.ts:676`).
> 통과(pass-through)시키지 않는다 — 통과시키면 마커 메시지가 평범한 턴으로 실행된다.
> 마커가 줄 중간에만 있는 메시지는 요청이 아니므로 평소대로 처리된다 (`packages/slack/src/incident-contract.ts:203`).
> 회귀 테스트: `src/slack/__tests__/incident-ingress.test.ts:252`.

1. **Trust** — `SOMA_INCIDENT_TRUSTED_SOURCE` 미설정/JSON 파손/필드 누락 ⇒ `null` ⇒ 분류기가 `receiver_disabled`
   (`packages/slack/src/incident-contract.ts:209`). 발신 봇/팀/앱/유저/채널이 앵커와 정확히 일치해야 하고,
   요청은 **알림 부모 스레드의 답글**이어야 한다(루트 메시지는 `not_in_thread`).
2. **Accepted user** — 기존 accepted-user 저장소가 그 발신 identity를 허용해야 한다
   (`isIncidentUserAccepted` — `src/slack/event-router.ts:31`). 아니면 `user_not_accepted`.
3. **Evidence URL(runtime readiness)** — `getIncidentEvidenceConfig() !== null`
   (`src/slack/event-router.ts:43`). 미설정이거나 거부된 값이면 `runtime_not_ready`로 **fail-closed**.

## 3. 실행 표면 — strict read-only

한 시도가 받는 SDK 옵션은 평소 세션을 좁힌 것이 아니라 별도로 조립된 최소 객체다 (`src/incident/sdk-options.ts:433`).

- 도구는 인자 없는 `mcp__incident_evidence__collect` **하나**. `tools: []`, `plugins: []`, `settingSources: []`,
  `strictMcpConfig: true`, `allowedTools`는 그 한 개.
- `PreToolUse` 훅과 `canUseTool` 둘 다 기존 `evaluateToolPolicy`를 `incidentReadOnly` 컨텍스트로 호출한다.
  이 tier는 mode/admin과 무관하게 단독 결정하며(`src/agent-runtime/policy/tool-policy.ts:240`),
  `allow`가 아닌 모든 결과는 deny — 무인 스레드에서 `ask`는 불가능하다.
- 쉘·파일·네트워크 없음, `persistSession: false`, `resume/continue` 없음,
  `maxTurns = 4`, wall-clock 상한 10분(`INCIDENT_MAX_WALL_CLOCK_MS`, 타이머는 stream owner가 건다).
- evidence config가 없거나 origin이 불량이면 `IncidentOptionsError`로 실패 — **평범한 세션으로의 폴백은 없다.**

## 4. 스레드와 attempt 수명

- 요청은 **알림 원본 스레드 안에서** 처리된다. `skipAutoBotThread: true`라 봇 전용 루트 스레드를 새로 만들지 않는다
  (`packages/slack/src/event-router.ts:531`).
- 원문 마커 텍스트는 모델에 도달하지 않는다. 고정된 host prompt만 전달된다(`buildIncidentHostPrompt`).
- 같은 `(lifecycle_id, attempt_id)` 재전달은 `duplicate_attempt`.
- **재시도 admission**은 ①host가 쓴 완료 마커 `incidentAttemptFinishedId`가 현재 소유 attempt와 일치하고
  ②세션이 `idle`일 때만 (`packages/slack/src/event-router.ts:495`). 아니면 `attempt_in_progress` / `session_busy`.
- 이미 일반 세션이 있는 스레드는 절대 인수하지 않는다(`ordinary_session_conflict`).
  인시던트 소유 표시는 해제되지 않는다 — 재시도 시 교체될 뿐이다.
- 실행 중인 시도는 **스티어링 대상이 아니다.** 시도는 스티어링 레지스트리에 등록되지 않으므로
  `steerTurn`/`interruptTurn`/`cancelSteeredMessage`는 "실행 중인 턴 없음"으로 답한다 (`src/claude-handler.ts:1265`).
- 백그라운드 에이전트 keepalive는 시도에서 **꺼져 있다**(`0`) — 시도는 답하는 result에서 끝난다 (`src/claude-handler.ts:1320`).
- 인시던트 소유 스레드의 일반 메시지(파일 업로드 포함)는 후속 큐 펜스 **앞에서** 버려진다 — 큐에 쌓이거나
  스레드에 큐 표시가 붙거나 시도에 주입되지 않는다 (`src/slack-handler.ts:993`).

## 5. 산출물의 출처 — collector snapshot

- 모델 텍스트는 **스트리밍되지 않는다.** 누적 → 검증 → host가 렌더한 한 줄만 스레드에 올라간다
  (`src/incident/attempt-output.ts`).
- 그 결론은 모델 문자열(summary, proposal action)을 되싣지만 **해석되지 않는다.** 인시던트 세션의 턴은
  directive(`channel_message` 등)·선택지 JSON·전송 오류 가드 없이 그대로 한 번 게시된다
  (`packages/slack/src/pipeline/stream-executor.ts:1005`, `packages/slack/src/stream-processor.ts:1317`).
  그 스위치 `StreamContext.incidentAttempt`는 기본값 없는 **필수** 필드다
  (`packages/slack/src/stream-processor.ts:112`) — 새 생성 지점이 빠뜨리면 타입 검사가 실패한다.
- 결론은 **항상 blocks 없는 평문 게시**로 나간다 — 턴 스트림의 `markdown_text` 청크로는 절대 나가지 않는다
  (`packages/slack/src/stream-processor.ts:1949`). 그 청크는 Slack이 서버에서 해석하기 때문이다.
  **보장 범위는 byte-for-byte up to the `say` call — `say` 호출까지다.** 코드와 테스트가 증명하는 것은 host가
  렌더한 텍스트가 한 바이트도 바뀌지 않고 `say` 인자의 `text`가 된다는 것까지다. Slack이 **저장한** `text`
  (eagle-eye가 `conversations.replies`로 읽어 가는 값)가 마커 줄과 같다는 것은 **검증되지 않았다** — bare URL
  자동 링크, 엔티티(`&amp;` 등) 처리, 멘션 모양 문자열이 서버에서 바뀔 수 있다. 끝단(end-to-end) 동일성은
  §6의 활성화 전 필수 리시트가 통과하기 전에는 주장하지 않는다.
  게시 인자는 `{ text, thread_ts, unfurl_links: false, unfurl_media: false, parse: 'none', mrkdwn: false }` —
  `text`에 대한 Slack 자체 처리를 끄는 문서화된 `chat.postMessage` 스위치 전부다(`incident-result.ts` caller
  obligation 2). 근거: `@slack/web-api` 7.15.1 `dist/types/request/chat.d.ts`와 Slack 문서
  (chat.postMessage, "Formatting message text"):
  - `unfurl_links`/`unfurl_media` — `false`면 링크·미디어 unfurl을 끈다 (chat.d.ts:139-144).
  - `parse` — 타입 주석은 기본값 `none`(chat.d.ts:31), chat.postMessage 문서는 "By default, URLs will be
    hyperlinked. Set parse to none to remove the hyperlinks"라고 해 **서로 다르다**. 어느 쪽이든 `none`을
    명시하면 bare URL 자동 링크가 꺼진다고 formatting 문서가 적는다.
  - `mrkdwn` — 기본값 `true`, `false`면 최상위 `text`의 마크업 처리를 끈다 (chat.d.ts:170-171).
  - `link_names` — 일부러 **보내지 않는다.** formatting 문서: 최상위 `text`는 `link_names`를 빼면 이름 자동 링크가
    기본으로 꺼진다.

  스위치는 `SayPostSwitches`/`sayPostSwitches`(`packages/slack/src/stream-processor.ts:138`)로 정의되고,
  executor의 `say` 래퍼(`packages/slack/src/pipeline/stream-executor.ts:1402`)와 `SlackHandler`의
  `wrappedSay`(`src/slack-handler.ts:1348`)가 설정된 것만 넘겨 Bolt `say`가 `chat.postMessage`에 그대로 펼친다.
  다른 게시에는 스위치가 하나도 붙지 않는다.
  그래서 인시던트 턴은 B1 스트림 메시지를 **열지 않는다** (`TurnContext.noStream`,
  `packages/slack/src/turn-surface.ts:556`) — 아무것도 붙지 않은 빈 스트림 메시지가 남지 않는다.
  턴 상태(네이티브 상태 표시·supersede·완료 카드)는 그대로 열고 닫는다. 그 결과 evidence 도구 결과 줄은
  스트림 대신 별도 메시지로, 완료 카드도 스트림에 붙지 않고 **결론 뒤의 별도 메시지**로 게시된다.
  결론 뒤에 다른 메시지가 와도 eagle-eye는 결론을 놓치지 않는다. `classify_investigation`은 조사자가 쓴 메시지를
  최신순으로 모두 훑어 결과 마커 줄을 최우선 등급으로 찾는다
  (eagle-eye `feat/41-incident-inbox` @149247880388, `src/incident.rs:719-733`).
- 턴이 끝난 뒤 수집 텍스트를 "내용으로 위장한 전송 오류"(사용량 한도·풀 rate-limit·prompt too long·
  빈 블록 400·compaction 실패)로 읽는 5개 가드도 인시던트 세션에는 적용되지 않는다
  (`packages/slack/src/pipeline/stream-executor.ts:1957`). summary가 그 문구를 인용해도 자격증명 회전이나
  재시도가 일어나지 않는다. 실제 전송 오류는 시도 안에서 이미 host 결과(`failed`/`inconclusive`)가 된다.
- 도구 호출은 evidence 도구 이름일 때만 host가 `input: {}`로 다시 써서 보인다. 다른 도구 호출과 모델이 쓴
  인자는 스레드에 나가지 않는다 (`src/incident/attempt-output.ts:493`). 그 호출의 결과도 버려진다 — 도구 결과는
  이 시도에서 보인 evidence 호출의 id일 때만 고정 문구(조회 완료/실패)로 보인다 (`src/incident/attempt-output.ts:441`).
- 결론의 `status`는 종결 상태만 가능하다. `running`(eagle-eye에서 진행 표시)은 결론으로 거부되고 host가
  `inconclusive`(cause `non_terminal_status`)를 쓴다.
- evidence의 provenance는 `eagle_eye_collector_snapshot`이다. 즉 **수집기가 언제 무엇을 관측했는지**이며,
  지금 시스템이 어떤 상태인지에 대한 **독립 재측정(reprobe)이 아니고, 근본원인 확정도 아니다.**
  결과의 `uncertainties`에는 이 caveat이 항상 포함된다(`INCIDENT_SOURCE_CAVEAT`).
- `status: succeeded`는 "사람이 볼 수 있는 증거 기반 제안이 준비됨"이라는 뜻이지
  원인 확정이나 장애 해소를 뜻하지 않는다.
- 인용은 host가 기록한 evidence 레코드와 대조되며, 수집되지 않은 참조는 결론 전체를 거부시킨다.
- abort·budget 만료·전송 실패·마커 누락/거부에서도 host가 자기 결과 줄을 써서 **항상 종결**된다.
- 결론마다 `Incident attempt concluded` info 로그가 한 줄 남는다 (`src/claude-handler.ts:1714`):
  `end`·`status`·`rejected`(거부 사유, 예: `missing_marker`) 옆에 **모델 텍스트의 길이**(`modelTextChars`,
  버퍼 상한을 넘어 버려진 부분까지 센다)와 **거친 분류**(`modelTextClass`)가 붙는다. 분류는 콘텐츠 가드가 쓰는
  감지 함수를 그대로 재사용한다 — `pool_rate_limit` / `usage_limit` / `prompt_too_long` / `empty` /
  `unmatched`(어느 감지기에도 안 걸림) (`src/claude-handler.ts:143`). 그래서 `missing_marker`가
  "모델이 마커를 안 썼다"(`unmatched`)인지 "SDK가 사용량 한도 안내를 assistant 텍스트로 봉인했다"(`usage_limit`)인지
  로그만으로 구분된다. **모델 텍스트 자체는 로그에 남지 않는다.**
- **자동 실행은 없다.** 시도는 제안(proposal)만 쓴다. 실제 조치는 사람이 한다.

## 6. Rollout

1. **활성화 전 필수 리시트 — Slack 저장 text 되읽기 (아직 실행되지 않았다).** 이것이 통과하기 전에는 env를
   주입하지 않는다.
   - 대상 봇 토큰으로, 인시던트 채널의 스크래치 스레드에 결론 1건을 **실제로** 게시한다. 게시 인자는
     `publishIncidentText`와 같아야 한다: `{ text, thread_ts, unfurl_links: false, unfurl_media: false,
     parse: 'none', mrkdwn: false }`, blocks 없음.
   - `text`는 host 렌더 결과(`buildIncidentAttemptOutput(...).text`)여야 하고, summary에 다음을 **모두** 넣는다:
     bare URL(예: `https://example.com/run/1`), `&`, `<`, `>`, 멘션 모양 문자열(예: `<@U0ADMIN>`, `<!here>`, `@here`).
   - eagle-eye와 같은 경로인 `conversations.replies`로 그 메시지를 되읽는다.
   - 판정: 되읽은 `text`에서 `EAGLE_INCIDENT_RESULT:`로 시작하는 줄이 보낸 마커 줄(`output.line`)과
     **정확히 같아야** 한다(문자열 동일, 정규화 없음). 한 글자라도 다르면 활성화하지 않고, 차이를 기록한 뒤
     게시 경로를 고친다.
   - 리시트(보낸 줄, 되읽은 줄, 비교 결과, 메시지 ts)는 활성화 기록에 남긴다.
2. 대상 호스트에 위 두 env를 주입한다(시크릿 저장소 경유, 문서/PR에 실값 금지).
3. **봇 재시작은 유저 게이트다.** 에이전트가 임의로 재시작하지 않고 유저 승인 후 수행한다.
4. **일반 deploy 워크플로를 그대로 쓰지 않는다.** 그 워크플로가 어떤 인스턴스들로 fan-out 되는지 먼저 확인하고,
   의도한 대상 하나에만 적용되는지 확인한 뒤 진행한다(다중 노드 동시 활성화 금지).
5. 활성 후 확인 지점: ingress 거부 사유 로그(`receiver_disabled` / `user_not_accepted` / `runtime_not_ready`),
   `Built isolated incident attempt options` info 로그, 시도가 끝나면 `Incident attempt concluded` info 로그
   (`rejected`가 있으면 `modelTextClass`로 원인을 먼저 가른다 — §5).

## 7. Rollback

- 1차: `SOMA_INCIDENT_EVIDENCE_BASE_URL` 제거(또는 `SOMA_INCIDENT_TRUSTED_SOURCE`까지 제거) 후 재시작 ⇒
  ingress는 즉시 fail-closed로 돌아간다. 코드 되돌림 불필요.
- 2차: 이전 번들로 되돌린다.
- 두 경로 모두 **데이터 보존**: 세션 파일·스레드·수집물 삭제 금지. 인시던트 스레드의 기존 메시지도 지우지 않는다.

## 8. 검증 명령 (실행 전 상태)

```sh
npm run build                      # check + somalib + workspaces(packages 포함) + tsc
npm run build --workspace packages/slack
npx tsc --noEmit
npx vitest run src/incident/__tests__ \
  src/slack/__tests__/incident-ingress.test.ts \
  src/slack/__tests__/turn-surface.test.ts \
  src/__tests__/slack-handler.test.ts \
  src/agent-runtime/__tests__/tool-policy-incident.test.ts \
  packages/slack/src/__tests__/incident-contract.test.ts \
  packages/slack/src/__tests__/incident-result.test.ts \
  packages/slack/src/pipeline/__tests__/stream-executor.incident-output.test.ts
```

이 문서 작성 시점에 위 명령의 결과는 **기록되지 않았다** — 통과 주장 없음.
라이브 경로(실제 eagle-eye → Slack → 시도 → 결과 줄) 실측도 **아직 없다.**

## 9. Pending

- 사람이 실제 변경(mutation)을 하려면 Eagle-eye 쪽 **Google 인증**이 필요하며, 이는 미해결 상태다.
  그 인증은 **이 레포의 인증이 아니다** — 여기서 해결되지 않으며, 수신기 활성화와 별개 트랙이다.
