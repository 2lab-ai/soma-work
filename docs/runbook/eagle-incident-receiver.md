# Runbook: Eagle-eye incident receiver

Eagle-eye 알림 스레드에서 봇이 **무인(unattended) 인시던트 시도 1회**를 돌리는 경로의 운영 절차.
기본값은 **꺼짐**이고, 아래 두 env가 모두 유효할 때만 열린다.

> 상태: 이 문서는 현재 브랜치 코드 기준의 운영 절차서다. **라이브 실측(live proof)은 아직 실행되지 않았다.**
> "구현 완료"나 "live green"을 이 문서로 주장하지 않는다.

---

## 1. Config (env)

| 변수 | 의미 | 읽는 곳 |
|---|---|---|
| `SOMA_INCIDENT_TRUSTED_SOURCE` | 신뢰 발신자 앵커(JSON object) | `getIncidentTrustedSource()` — `src/config.ts:184` |
| `SOMA_INCIDENT_EVIDENCE_BASE_URL` | evidence collector origin | `getIncidentEvidenceConfig()` — `src/config.ts:233` |

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

세 게이트가 모두 통과해야 시도가 디스패치된다. 하나라도 없으면 요청은 거부되고 스레드는 평소대로 동작한다.

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
  이 tier는 mode/admin과 무관하게 단독 결정하며(`src/agent-runtime/policy/tool-policy.ts:235`),
  `allow`가 아닌 모든 결과는 deny — 무인 스레드에서 `ask`는 불가능하다.
- 쉘·파일·네트워크 없음, `persistSession: false`, `resume/continue` 없음,
  `maxTurns = 4`, wall-clock 상한 10분(`INCIDENT_MAX_WALL_CLOCK_MS`, 타이머는 stream owner가 건다).
- evidence config가 없거나 origin이 불량이면 `IncidentOptionsError`로 실패 — **평범한 세션으로의 폴백은 없다.**

## 4. 스레드와 attempt 수명

- 요청은 **알림 원본 스레드 안에서** 처리된다. `skipAutoBotThread: true`라 봇 전용 루트 스레드를 새로 만들지 않는다
  (`packages/slack/src/event-router.ts:448`).
- 원문 마커 텍스트는 모델에 도달하지 않는다. 고정된 host prompt만 전달된다(`buildIncidentHostPrompt`).
- 같은 `(lifecycle_id, attempt_id)` 재전달은 `duplicate_attempt`.
- **재시도 admission**은 ①host가 쓴 완료 마커 `incidentAttemptFinishedId`가 현재 소유 attempt와 일치하고
  ②세션이 `idle`일 때만 (`packages/slack/src/event-router.ts:415`). 아니면 `attempt_in_progress` / `session_busy`.
- 이미 일반 세션이 있는 스레드는 절대 인수하지 않는다(`ordinary_session_conflict`).
  인시던트 소유 표시는 해제되지 않는다 — 재시도 시 교체될 뿐이다.

## 5. 산출물의 출처 — collector snapshot

- 모델 텍스트는 **스트리밍되지 않는다.** 누적 → 검증 → host가 렌더한 한 줄만 스레드에 올라간다
  (`src/incident/attempt-output.ts`).
- evidence의 provenance는 `eagle_eye_collector_snapshot`이다. 즉 **수집기가 언제 무엇을 관측했는지**이며,
  지금 시스템이 어떤 상태인지에 대한 **독립 재측정(reprobe)이 아니고, 근본원인 확정도 아니다.**
  결과의 `uncertainties`에는 이 caveat이 항상 포함된다(`INCIDENT_SOURCE_CAVEAT`).
- `status: succeeded`는 "사람이 볼 수 있는 증거 기반 제안이 준비됨"이라는 뜻이지
  원인 확정이나 장애 해소를 뜻하지 않는다.
- 인용은 host가 기록한 evidence 레코드와 대조되며, 수집되지 않은 참조는 결론 전체를 거부시킨다.
- abort·budget 만료·전송 실패·마커 누락/거부에서도 host가 자기 결과 줄을 써서 **항상 종결**된다.
- **자동 실행은 없다.** 시도는 제안(proposal)만 쓴다. 실제 조치는 사람이 한다.

## 6. Rollout

1. 대상 호스트에 위 두 env를 주입한다(시크릿 저장소 경유, 문서/PR에 실값 금지).
2. **봇 재시작은 유저 게이트다.** 에이전트가 임의로 재시작하지 않고 유저 승인 후 수행한다.
3. **일반 deploy 워크플로를 그대로 쓰지 않는다.** 그 워크플로가 어떤 인스턴스들로 fan-out 되는지 먼저 확인하고,
   의도한 대상 하나에만 적용되는지 확인한 뒤 진행한다(다중 노드 동시 활성화 금지).
4. 활성 후 확인 지점: ingress 거부 사유 로그(`receiver_disabled` / `user_not_accepted` / `runtime_not_ready`),
   `Built isolated incident attempt options` info 로그.

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
  src/agent-runtime/__tests__/tool-policy-incident.test.ts \
  packages/slack/src/__tests__/incident-contract.test.ts \
  packages/slack/src/__tests__/incident-result.test.ts
```

이 문서 작성 시점에 위 명령의 결과는 **기록되지 않았다** — 통과 주장 없음.
라이브 경로(실제 eagle-eye → Slack → 시도 → 결과 줄) 실측도 **아직 없다.**

## 9. Pending

- 사람이 실제 변경(mutation)을 하려면 Eagle-eye 쪽 **Google 인증**이 필요하며, 이는 미해결 상태다.
  그 인증은 **이 레포의 인증이 아니다** — 여기서 해결되지 않으며, 수신기 활성화와 별개 트랙이다.
