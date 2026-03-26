# Deploy Notification Channel Splitting — Spec

> STV Spec | Created: 2026-03-26

## 1. Overview

Deploy workflow 세션에서 봇이 출력하는 빌드/배포/E2E 테스트 메시지의 채널 라우팅을 분리한다.
현재 모든 출력이 세션이 시작된 채널(#backend-general)에 가지만, 상세 로그는 #backend-update로 이동하고
원래 채널에는 모든 단계 완료 후 한줄 요약만 표시한다. 실패 시에만 상세 에러를 원래 채널에 출력한다.

## 2. User Stories

- As a backend developer, I want deploy detailed logs in #backend-update, so that #backend-general stays clean and scannable.
- As a team lead, I want a one-line deploy summary in #backend-general, so that I can quickly see if deploys are healthy.
- As an on-call engineer, I want detailed failure info in #backend-general with red formatting, so that I can immediately act on failures.

## 3. Acceptance Criteria

- [ ] `deploy` 워크플로우 타입이 dispatch에서 인식됨
- [ ] deploy 세션의 중간 출력(tool use, assistant text)이 `DEPLOY_LOG_CHANNEL`로 라우팅됨
- [ ] deploy 세션 완료 시 원래 채널에 한줄 요약 포스트
- [ ] 성공 포맷: `[{env}] {version} | build: {ok/fail} | deploy: {ok/fail} | e2e: {ok/fail}`
- [ ] 실패 시 요약 + 상세 에러 블록 (빨간 attachment, 볼드/이탤릭 포맷)
- [ ] 실패 상세 포함: Environment, Platform, Namespace, Images, Duration, Conclusion, Run URL, Error
- [ ] `DEPLOY_LOG_CHANNEL` 환경변수로 로그 채널 설정 가능
- [ ] 기존 워크플로우(default, jira-*, pr-*)에 영향 없음

## 4. Scope

### In-Scope
- `deploy` WorkflowType 추가
- StreamExecutor에 deploy 워크플로우용 채널 라우팅 로직
- deploy.prompt 워크플로우 프롬프트
- 배포 요약 포맷터 (DeploySummaryFormatter)
- dispatch 패턴에 deploy 추가
- DEPLOY_LOG_CHANNEL 환경변수

### Out-of-Scope
- GitHub Actions webhook 수신 엔드포인트
- HTTP 서버 추가
- 다른 워크플로우의 채널 라우팅
- E2E 테스트 실행 로직 자체

## 5. Architecture

### 5.1 Layer Structure

```
Slack Event → EventRouter → SlackHandler.handleMessage()
  → InputProcessor → SessionInitializer (dispatch → 'deploy')
  → StreamExecutor.execute()
    → [NEW] deploy workflow detected?
      → YES: wrap say() to route to DEPLOY_LOG_CHANNEL
             on completion: post summary to original channel
      → NO: existing behavior (unchanged)
```

### 5.2 Component Changes

| File | Change | Lines |
|------|--------|-------|
| `src/types.ts` | Add `'deploy'` to WorkflowType | ~2 |
| `src/dispatch-service.ts` | Add 'deploy' to validWorkflows, add dispatch pattern | ~5 |
| `src/prompt/dispatch.prompt` | Add deploy pattern to classification rules | ~3 |
| `src/config.ts` | Add `deploy.logChannel` config | ~3 |
| `.env.example` | Add `DEPLOY_LOG_CHANNEL` | ~2 |
| `src/slack/pipeline/stream-executor.ts` | Add deploy channel routing logic | ~40 |
| `src/slack/deploy-summary-formatter.ts` | NEW: Summary formatting + error block builder | ~80 |
| `src/prompt/workflows/deploy.prompt` | NEW: Deploy workflow system prompt | ~50 |

### 5.3 Stream Routing Logic (StreamExecutor)

```typescript
// In StreamExecutor.execute():
if (session.workflow === 'deploy' && config.deploy.logChannel) {
  // Create log channel say function
  const logSay = async (msg) => {
    return slackApi.postMessage(config.deploy.logChannel, msg.text, {
      threadTs: logThreadTs, // thread in log channel
      blocks: msg.blocks,
    });
  };

  // Override stream context say → logSay (detailed output goes to log channel)
  // On stream completion → post summary to original channel via original say
}
```

### 5.4 Deploy Summary Format

**Success:**
```
[Dev2] 0.1.0-d198882 | build: ok | deploy: ok | e2e: ok
```

**Failure (one-line + red attachment):**
```
[Dev2] 0.1.0-d198882 | build: ok | deploy: fail

(Red Slack attachment block):
[Dev2] 0.1.0-b517504 deploy failed.
*Environment:* Dev2
*Platform:* linux/amd64
*Namespace:* ghcr.io/insightquest-io/gucci
*Images:* 9
*Duration:* 9s
*Conclusion:* failure
Run: https://github.com/insightquest-io/Gucci/actions/runs/23236408002|#338
*Error:* see thread for full logs.
```

### 5.5 Integration Points

- **StreamExecutor**: 핵심 수정 지점. deploy 워크플로우 감지 시 say 함수 래핑.
- **SlackApiHelper**: 기존 `postMessage()` 재사용. 수정 없음.
- **DispatchService**: deploy 패턴 추가만.
- **PromptBuilder**: 기존 워크플로우 로딩 메커니즘 재사용. 수정 없음.
- **config.ts**: deploy.logChannel 추가.

## 6. Non-Functional Requirements

- **Performance**: 추가 Slack API 호출 1-2회 (log channel posting). 무시할 수준.
- **Reliability**: 로그 채널 포스팅 실패 시 원래 채널로 fallback.
- **Security**: 새로운 보안 고려사항 없음. 기존 Slack Bot Token 재사용.
- **Backward Compatibility**: deploy 워크플로우 아닌 세션은 100% 기존 동작 유지.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 'deploy' WorkflowType 추가 | tiny | 기존 패턴 그대로. union type에 한 줄 추가. |
| DEPLOY_LOG_CHANNEL 환경변수 | tiny | 기존 CREDENTIAL_ALERT_CHANNEL 패턴과 동일. |
| dispatch.prompt에 deploy 패턴 | tiny | 기존 패턴 분류 규칙에 한 줄 추가. |
| StreamExecutor say() 래핑 방식 | medium | MCP 서버 대안 대비 신뢰성 우선. Claude 프롬프트 준수에 의존하지 않음. |
| DeploySummaryFormatter 별도 파일 | small | 단일 책임 원칙. stream-executor에 포맷 로직 섞지 않음. |
| deploy.prompt에서 요약 포맷 지시 | small | Claude가 최종 출력으로 정형화된 요약을 생성하도록 유도. |
| 로그 채널 포스팅 실패 시 fallback | small | 로그 채널 에러가 전체 deploy를 막지 않도록. graceful degradation. |

## 8. Open Questions

None — 모든 결정이 기존 아키텍처 패턴 내에서 해결됨.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`
