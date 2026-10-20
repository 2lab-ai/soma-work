# Claude Tag 기능 카탈로그와 soma-work 대조표

Status: in-progress · 조사일 2026-10-20 · soma-work 기준 커밋 main `5dfb235`
스펙: [`../11-claude-tag-parity-spec.md`](../11-claude-tag-parity-spec.md) · SSOT: [`../claude-tag-parity/ssot.md`](../claude-tag-parity/ssot.md)

이 문서는 근거 자료다. 계약은 11번 스펙에 있다.

## 한 줄 결론

Claude Tag 기능 103개 가운데 soma-work에 있는 것은 16개, 일부만 있는 것은 33개, 없는 것은 35개다. 나머지 18개는 Anthropic 호스팅·요금제 고유라 해당이 없고, 1개는 기존 setup 트랙이 다룬다. 부분·없음 68개를 피처 33개(F-01~F-33)로 묶었다.

## 읽는 법

- 판정: `있음` = soma-work에 같은 사용자 결과가 있다 · `부분` = 일부만 있다 · `없음` · `해당없음` = Anthropic 호스팅·과금·플랜 고유라 자체 호스팅 봇에 의미가 없다.
- `피처` 열은 11번 스펙의 피처 ID다. 부분·없음 판정은 전부 피처 하나에 묶인다.
- soma-work 근거는 `file:line`(기준 커밋 `5dfb235`)이다.

## 조사 범위와 증거 라벨

- [DOC] Claude Tag 공식 문서 79쪽 전부 (`https://claude.com/docs/llms.txt` 목록, 2026-10-20 원문 판독). 모든 쪽이 public beta 표기다.
- [ANN] 출시 발표 `https://www.anthropic.com/news/introducing-claude-tag` (2026-06-23), 제품 페이지 `https://claude.com/product/tag`, 블로그 `https://claude.com/blog/agent-identity-access-model`, 출시 후 글 2개 (2026-08-13 "Claude Tag now reads even more of the room", 2026-09-24 personal connectors).
- [CHANGELOG] `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md`의 `[Claude Tag]` 항목 v2.1.267 (2026-09-09) ~ v2.1.304 (2026-10-19).
- [CODE] soma-work 저장소 정적 판독. 라이브 실측은 하지 않았다.
- 경계: Claude Tag를 직접 조작한 세션은 없다. 문서·발표·changelog 서술만으로 판정했다. 실제 UX 세부(이모지 종류, 카드 모양)는 "미조작 — 추정"이다.
- 문서 경로 약칭: `docs/x` = `https://claude.com/docs/claude-tag/x`.

## 집계

| 판정 | 개수 |
|---|---|
| 있음 | 16 |
| 부분 | 33 |
| 없음 | 35 |
| 해당없음 | 18 |
| 기존 트랙 | 1 |
| 합계 | 103 |

## 1. 호출과 대화 모델

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-01 | @멘션으로 호출, 몇 초 안에 이모지 반응으로 접수 표시 | docs/users/when-claude-responds | 있음 | `packages/slack/src/event-router.ts:654-757`, `reaction-manager.ts:92-105` | — |
| CT-02 | 스레드 하나 = 영속 세션 하나, 채널 누구나 답글로 이어감 | docs/concepts/how-it-works | 있음 | `src/session-identity.ts:45-51` `work:<channel>:<threadTs>` | — |
| CT-03 | 채널 레벨 세션: top-level 메시지 간 문맥 유지, 1시간 무활동·1일 경과 시 교체 | docs/concepts/how-it-works | 없음 | top-level 메시지마다 새 세션 `session-initializer.ts:298,315` | F-04 |
| CT-04 | 작업 표시줄 + Stop 버튼 + 제자리 편집 체크리스트 | docs/concepts/how-it-works, CHANGELOG 2.1.274/2.1.280 | 있음 | `packages/slack/src/turn-surface.ts`, `task-list-block-builder.ts`, `assistant-status-manager.ts` | — |
| CT-05 | 채널 누구나 실행 중 세션 스티어링, 편집은 before/after 노트로 전달 | docs/concepts/how-it-works | 부분 | `canInterrupt` = 소유자·현재 요청자만 `src/session-registry.ts:1244-1248`, 편집은 대기 항목만 `event-router.ts:766-793` | F-05 |
| CT-06 | Stop 후 세션 유지, 누가 멈췄는지 한 줄 게시 | docs/concepts/how-it-works | 부분 | 중지 동작은 있음(action panel, dashboard). 정지자 표기 없음 | F-05 |
| CT-07 | 앰비언트 참여: 모든 메시지를 읽고 무응답·짧은 답·세션 시작·진행 세션 전달 중 선택, 무시당하면 덜 답함 | docs/users/when-claude-responds, 블로그 2026-08-13 | 없음 | 멘션 없는 top-level 메시지 핸들러 없음 `event-router.ts:812-821` | F-03 |
| CT-08 | 채널별 "Respond automatically" 설정 (기본 on) | docs/users/when-claude-responds | 없음 | 채널 설정 저장소 없음 | F-03 |
| CT-09 | 스레드 조용히 하기: 멘션 시에만 응답, `!mute`/`!unmute`, 엄지 아래 버튼 = mute | docs/users/commands | 없음 | 세션 스레드 답글은 항상 처리 `event-router.ts:1326-1370` | F-06 |
| CT-10 | 다른 봇·워크플로 메시지는 문맥으로만 읽고 @Claude 있을 때만 답 | docs/users/when-claude-responds | 부분 | Eagle 봇 간 계약만 `packages/slack/src/incident-contract.ts` (기본 off) | F-03 |
| CT-11 | 메시지 폭주(약 100개)·10일 무활동 시 채널 읽기 중단 | docs/users/when-claude-responds | 없음 | 채널 읽기 자체가 없음 | F-03 |
| CT-12 | `!` 명령 체계 (`!help` `!configure` `!feedback` 등) | docs/users/commands | 있음 | `/z`·`%`·`$`·naked 명령 체계 (`CommandRouter`, README Commands) | — |
| CT-13 | `!restart`: 세션 보관 후 새 세션 | docs/users/commands | 있음 | `new`·`renew`·`restore` | — |
| CT-14 | `!status`: 나에게만 보이는 작업 상태 | docs/users/commands | 부분 | 원 스레드 재멘션 시 연결 세션 상태 게시 `event-router.ts:736-748`. 비공개(ephemeral) 아님 | F-06 |
| CT-15 | `!fork`: 스레드 문맥을 새 스레드로 이어가기, 양쪽 상호 링크 | docs/users/commands | 없음 | 없음 | F-06 |
| CT-16 | Fan-out: 작업 목록을 작업별 스레드·세션으로 병렬 실행 후 링크 회신 | docs/users/prompt-library | 없음 | 세션 1개를 새 스레드로 옮기는 것만 `session-initializer.ts:745-766` | F-07 |
| CT-17 | 포워드된 메시지·붙여넣은 스레드 링크를 작업 입력으로 읽기 | docs/users/prompt-library | 없음 | `get_thread_messages`는 현재 스레드만 `packages/mcp-servers/slack-mcp/slack-mcp-server.ts:86` | F-12 |
| CT-18 | 파일·이미지·PDF·음성 클립 입력 | docs/users/getting-started, CHANGELOG 2.1.300 | 있음 | `src/file-handler.ts:62-152`, `src/a2t/a2t-service.ts` | — |
| CT-19 | 중간 멘션 시 스레드 창 읽기, 긴 스레드 처리 | docs/concepts/how-it-works | 있음 | 스레드 인지 힌트 `stream-executor.ts:959-960`, compact | — |
| CT-20 | 스레드·채널·DM별 모델 선택, 답글 footer에 모델 표기 | docs/users/models | 부분 | 유저·세션 모델은 있음 `src/slack/commands/model-handler.ts`. 채널 기본 모델 없음 | F-27 |
| CT-21 | Fast mode (`!fast`) | docs/admins/customize | 해당없음 | Anthropic 과금 모드. soma-work는 model·effort로 대응 | — |
| CT-22 | 요청 시 자기 메시지 삭제, 잘못된 메시지는 제자리 수정 + "Edited" | docs/users/troubleshooting, CHANGELOG 2.1.299 | 없음 | slack-mcp에 수정·삭제 도구 없음 | F-09 |

## 2. 정체성과 멀티플레이어

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-23 | 에이전트 정체성: 도구별 서비스 계정으로 행동, PR이 Slack 스레드로 역링크 | docs/concepts/agent-identity | 부분 | 전역 GitHub App 자격증명 1개 `src/github/git-credentials-manager.ts:17-25`. 요청자 귀속 기록 없음 | F-30 |
| CT-24 | 채널 단위 동일 권한 + "이 채널에서 뭘 쓸 수 있어?" 자기 설명 | docs/concepts/agent-identity | 없음 | 권한은 유저 단위 `src/mcp-config-builder.ts:508-571` | F-11 |
| CT-25 | 채널 사용에 좌석 불필요 | docs/overview | 해당없음 | 요금제 정책. soma-work는 관리자 승인제 | — |
| CT-26 | 개인 커넥터를 채널에서 사용 (Allow / Allow with review / Don't allow) | docs/concepts/personal-connectors, 블로그 2026-09-24 | 없음 | 유저별 서드파티 토큰 없음 `src/user-settings-store.ts:347-484` | F-20 |
| CT-27 | 개인 커넥터 결과 게시 전 민감정보 스크리닝 후 보류 | docs/concepts/personal-connectors | 없음 | 없음 (`src/sensitive-path-filter.ts`는 경로 차단만) | F-20 |
| CT-28 | 커넥터 동작 승인용 비공개 Allow once / Deny 카드 | CHANGELOG 2.1.300 | 있음 | permission-prompt MCP 승인 버튼, 시간 제한 grant `packages/process-shared/src/mcp-tool-grant-store.ts:19` | — |
| CT-29 | 다른 공개 채널에 게시·답글·반응, 출처 줄 "Sent by Claude in #x on behalf of @y" | docs/concepts/how-it-works | 부분 | 같은 채널 루트 게시만 (`channel_message` directive) | F-21 |
| CT-30 | 다른 채널·스레드 팔로우 (7일 무활동 시 종료), 관련 채널 자동 감시 | docs/concepts/how-it-works, CHANGELOG 2.1.273 | 없음 | 없음 | F-17 |
| CT-31 | 유저 그룹 알림, @channel·@here 절대 금지 | docs/users/good-habits | 부분 | 명시 규칙 없음 (미확인) | F-21 |
| CT-32 | 읽은 텍스트는 지시가 아니라 판단 재료, 타인 메시지는 정보로 취급 | docs/concepts/personal-connectors | 부분 | 발화자 태그 `<speaker>` `stream-executor.ts:951` | F-20 |
| CT-33 | 웹 세션 페이지 가시성 = Slack 가시성 (비공개 채널은 멤버만) | docs/users/troubleshooting | 부분 | 대시보드 세션 상세가 로그인 유저 전원에게 열림 (#716 의도된 정책) `src/conversation/dashboard.ts:1314-1317`, `web-server.ts:241-258` | F-02 |

## 3. 메모리와 문맥

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-34 | 채널 메모리: "remember for this channel", 자동 결정 기록, 과거 세션 열람 | docs/users/memory | 없음 | 메모리는 유저 단위만 `src/user-memory-store.ts` | F-10 |
| CT-35 | 워크스페이스 노트 + 범위 규칙 (공개 채널 쓰기, 전 채널 읽기, 비공개는 자기 노트만) | docs/users/memory, CHANGELOG 2.1.268 | 없음 | 조직 공통은 `.system.prompt`뿐 `src/prompt-builder.ts:123-126` | F-10 |
| CT-36 | 채널에서 메모리 조회·수정·삭제, 관리자 메모리 파일 편집, 이전 버전 보존 | docs/users/memory, docs/concepts/data-lifecycle | 부분 | 유저 메모리 카드는 있음 `src/slack/commands/memory-handler.ts` | F-10 |
| CT-37 | 상설 지시문 계층 합성 (Slack → 워크스페이스 → 채널), 8,192자 | docs/admins/attach-to-scope, CHANGELOG 2.1.290 | 부분 | 채널 설명 5분 캐시 주입만 `packages/slack/src/channel-description-cache.ts` | F-11 |
| CT-38 | Managed by: 다른 채널에서 지시문 관리, diff 카드 확인 | docs/admins/managed-by | 없음 | 없음 | F-11 |
| CT-39 | 채널 히스토리·핀 읽기, 공개 채널 키워드 검색 | docs/concepts/how-it-works | 없음 | 검색 scope·도구 없음 (`infra/slack/slack-app-manifest.json:56-75`) | F-12 |
| CT-40 | 레포 클론 후 CLAUDE.md·rules·skills 로드 | docs/admins/configure-github | 있음 | Claude Agent SDK가 작업 디렉토리 설정 로드, 채널 레포 매핑 `channel-registry.ts` | — |
| CT-41 | 첫 초대 시 채널 히스토리를 읽고 할 일 제안하는 인트로 | docs/users/getting-started | 부분 | 합류 시 작업 디렉토리 요청 메시지만 `event-router.ts:1375-1427` | F-13 |

## 4. 능동성

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-42 | 자연어 루틴, 채널 권한으로 실행, 타임존 지정 | docs/users/proactivity | 부분 | cron은 유저 소유 `src/cron-scheduler.ts`, `packages/mcp-servers/cron/cron-mcp-server.ts:480-620` | F-18 |
| CT-43 | 채널 감시 루틴: 지정 채널을 보다가 주제가 맞을 때만 게시 | docs/users/proactivity | 없음 | 없음 | F-17 |
| CT-44 | PR 구독: 코멘트·실패한 체크·리뷰·머지에 깨어나 게시·수정·푸시 | docs/users/proactivity, docs/users/use-cases/work-with-github | 없음 | 없음 | F-16 |
| CT-45 | 루틴 관리: 채널 멤버 누구나 조회·일시정지, 생성자 이탈해도 유지, 3회 연속 실패 시 자동 정지, 완료·실패 알림 | docs/users/proactivity | 부분 | cron 이력·편집은 있음. 채널 소유·자동 정지 없음 | F-18 |
| CT-46 | 정체된 리뷰·조용해진 스레드 재촉, 상태 바뀌면 게시 | docs/users/use-cases/track-projects | 없음 | 12시간 유휴 시 닫기/유지 질문만 `packages/slack/src/session-manager.ts:1043-1106` | F-15 |
| CT-47 | 스스로 후속 작업 예약, 몇 시간·며칠 걸친 자율 진행 | ANN | 부분 | goal loop 상한 10회 `packages/slack/src/session-goal.ts:28`, 반복 cron만, 1회성 예약 없음 | F-14 |
| CT-48 | API 오류·용량·샌드박스 유실 자동 복구와 재시도 | docs/users/troubleshooting | 있음 | 자동 재개 `src/slack-handler.ts:5170-5280`, 사용량 재시도 `src/claude-handler.ts:107-136` | — |
| CT-49 | 아침 브리프·저녁 랩 DM 제안, 주간 채널 추천 DM | docs/admins/restrict-access | 없음 | 일·주간 리포트는 지표용 `src/metrics/report-scheduler.ts` | F-19 |

## 5. 도구·커넥터·출력

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-50 | 스레드별 샌드박스, 범위별 환경 (setup 스크립트·환경 변수·네트워크 수준) | docs/admins/customize | 부분 | 유저별 작업 디렉토리 `src/working-directory-manager.ts`, 샌드박스 토글. 채널별 환경 없음 | F-25 |
| CT-51 | 관리자 커넥터 (가이드형 + 임의 HTTP API, 자격증명 쓰기 전용) | docs/admins/add-connections | 부분 | 전역 MCP 서버 `src/mcp-manager.ts`. 범위별 자격증명 없음 | F-27 |
| CT-52 | 자격증명 설정 링크 → 보유자가 제출 → 관리자 승인 | docs/admins/add-connections | 없음 | 없음 | F-27 |
| CT-53 | 원격 MCP 서버 연결 | docs/admins/connections/custom | 있음 | `src/mcp/config-loader.ts`, `server-factory.ts` | — |
| CT-54 | Agent Proxy: 기본 차단 egress, 자격증명은 프록시에서 주입되어 샌드박스에 안 들어감 | docs/concepts/security-and-data | 부분 | 도메인 허용 목록만 `src/sandbox/dev-domain-allowlist.ts` | F-25 |
| CT-55 | 웹 검색 | docs/admins/restrict-access | 있음 | SDK WebSearch | — |
| CT-56 | Federated agent access: Anthropic 서명 10분 JWT | docs/admins/federated-access/overview | 해당없음 | Anthropic 서명 체계 고유 | — |
| CT-57 | GitHub App으로 클론·브랜치·PR·CI 추적 | docs/admins/configure-github | 있음 | `src/github/*`, zwork·zcheck 스킬 | — |
| CT-58 | GitHub Actions 권한과 PR 자기 승인 위험 안내 | docs/admins/configure-github | 해당없음 | 저장소 브랜치 보호 운영 가이드 | — |
| CT-59 | GitLab (API 전용) | docs/admins/connections/gitlab | 해당없음 | 조직이 GitHub만 사용 | — |
| CT-60 | 플러그인·스킬을 범위별로 붙임, 멤버 제안 + Confirm | docs/admins/add-connections | 부분 | 전역 플러그인 마켓 `src/plugin/plugin-manager.ts` (관리자 전용) | F-27 |
| CT-61 | 스킬 저장소 등록, 배운 것으로 스킬 PR 생성 | docs/admins/skills-repo | 부분 | 유저 스킬 `MANAGE_SKILL`. 저장소 스킬 개선 PR 자동화 없음 | F-24 |
| CT-62 | 호스팅 페이지 (코멘트 → 세션 전달), Slack 캔버스 생성·수정 | docs/users/use-cases/create-artifacts | 부분 | html 스킬 LAN 게시. 코멘트 회신·캔버스 없음 | F-22 |
| CT-63 | 자연어 데이터 질의 + 차트 | docs/users/use-cases/answer-data-questions | 있음 | `packages/mcp-servers/server-tools/server-tools-mcp-server.ts:856-973` | — |
| CT-64 | On-call: 알림 감시, 인시던트 채널 이름 패턴 자동 합류, 태그 없이 조사 | docs/admins/setup-oncall | 부분 | Eagle 인시던트 수신기 기본 off, 라이브 미증명 `docs/runbook/eagle-incident-receiver.md` | F-23 |
| CT-65 | Auto mode 권한 검사기 + 범위별 자연어 허용 규칙 (50개, 1,024자) | docs/admins/customize | 부분 | 도구 정책 파이프라인 `src/agent-runtime/policy/tool-policy.ts:197-221`. 관리자 자연어 규칙 없음 | F-27 |

## 6. DM과 개인 도구

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-66 | 1:1 DM은 내 계정·내 커넥터로 실행, 결과는 내 이름으로 | docs/concepts/agent-identity | 부분 | DM은 유저 llmux 키로 과금 `src/claude-handler.ts:1186-1188`. 개인 커넥터 없음 | F-20 |
| CT-67 | DM 좌석 요건 | docs/overview | 해당없음 | 요금제 | — |
| CT-68 | 계정 없는 멤버의 체험 DM (7일·$50·50세션) | docs/admins/restrict-access | 해당없음 | 요금제 | — |
| CT-69 | 그룹 DM: 앰비언트, 격리된 노트 | docs/users/group-dms | 없음 | manifest에 `mpim:*` scope·event 없음 `infra/slack/slack-app-manifest.json:56-89` | F-08 |
| CT-70 | App Home 탭: 계정 연결, DM 모델 선택, 개인 커넥터 모드 | docs/concepts/personal-connectors | 없음 | `home_tab_enabled:false` | F-33 |

## 7. 관리와 거버넌스

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-71 | 범위(Slack → 워크스페이스 → 채널)와 번들, 상속 규칙 | docs/admins/attach-to-scope | 없음 | 설정은 전역 `config.json` + 유저 설정뿐 | F-27 |
| CT-72 | 채널 이름 패턴(`inc-*`)에 번들 자동 부착 | docs/admins/attach-to-scope | 없음 | 없음 | F-27 |
| CT-73 | 채널 allow-list, 범위 on/off 스위치, 6단계 중지 사다리 | docs/admins/restrict-access | 없음 | 초대된 모든 채널에서 동작 (검색어 `allowedChannels` 등 0건) | F-26 |
| CT-74 | 차단·자동 합류 채널 이름 패턴 | docs/admins/restrict-access | 없음 | 없음 | F-26 |
| CT-75 | 게스트 채널 정책 (Restrict / Channel only / Full) | docs/admins/restrict-access | 없음 | 없음 | F-26 |
| CT-76 | Slack Connect 채널 정책 (기본 off, channel-only 상한) | docs/admins/restrict-access | 없음 | 없음 | F-26 |
| CT-77 | Enterprise Grid 페어링 | docs/admins/workspaces | 해당없음 | 단일 워크스페이스 배포 `src/session-identity.ts:26-33` | — |
| CT-78 | 호출 제한 멤버의 스레드 답글은 "사용 불가자" 표기로 문맥만 전달 | docs/admins/restrict-access | 부분 | 승인 게이트가 새 세션에서만 돈다 `session-initializer.ts:430-469`. 기존 세션 스레드 답글은 무검사 `followup-dispatcher.ts:369` | F-01 |
| CT-79 | DM 허용 토글 | docs/admins/restrict-access | 있음 | 비관리자 DM 게이트 `packages/slack/src/z/whitelist.ts:34-57` | — |
| CT-80 | 위임 관리자 역할 (Owner 없이 관리) | docs/admins/restrict-access | 없음 | 관리자 = `ADMIN_USERS` 환경 변수뿐 `src/admin-utils.ts:1-33` | F-31 |
| CT-81 | 채널 매니저 (채널별 위임: 기본 모델·레포·자격증명) | docs/admins/restrict-access | 없음 | 없음 | F-31 |
| CT-82 | 멤버 편집 잠금 (지시문·기본 모델·자동 응답) | docs/admins/attach-to-scope | 없음 | 없음 | F-31 |
| CT-83 | 범위별 모델 설정, 조직 단위 모델 비활성 | docs/admins/customize | 부분 | 모델 별칭·관리자 모델 명령. 범위별 없음 | F-27 |
| CT-84 | 지출 한도 (조직 월간·채널 기본·채널별), 75%·90% 알림, 초과 시 거절 | docs/admins/set-spend-limit | 없음 | 검색어 `spend limit` `budget` `quota` 0건 | F-28 |
| CT-85 | 사용량 분석: 채널별·작업 종류별(engaged/proactive/scheduled), 요청자별 귀속, CSV | docs/admins/set-spend-limit, docs/admins/attribute-costs | 부분 | 유저·모델별 집계만 `src/metrics/report-aggregator.ts:1034-1068` | F-29 |
| CT-86 | Activity 페이지: 예약 작업·메모리·네트워크 이벤트, 감사 추적 | docs/admins/audit | 부분 | 대화별 work log `src/conversation/work-log.ts`. 요청자·도구 호출 통합 감사 없음 | F-30 |
| CT-87 | 보존 기간·범위별 삭제 | docs/concepts/data-lifecycle | 부분 | 세션만 7일 후 삭제 `src/session-registry.ts:49,57`. 대화·work log·지표·메모리 정책 없음 | F-32 |
| CT-88 | HIPAA·BAA 제약 | docs/admins/healthcare | 해당없음 | 규제 계약 | — |
| CT-89 | Anthropic egress IP 대역 | docs/admins/network-requirements | 해당없음 | 호스팅 고유 | — |
| CT-90 | Legacy 앱 이전 | docs/admins/migrate-from-earlier | 해당없음 | 호스팅 고유 | — |

## 8. 설정과 온보딩

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-91 | 가이드형 설정과 워크스페이스 페어링 | docs/admins/setup-overview | 기존 트랙 | `somawork setup` (`src/cli/setup/*`), 설계 `docs/superpowers/specs/2026-08-23-somawork-setup-onboarding-design.md` | — |
| CT-92 | 선행 조건 (요금제·Routines·Owner) | docs/admins/setup-overview | 해당없음 | 요금제 | — |
| CT-93 | 채널 추가 경로 (초대, 추천 버튼, 자동 합류 패턴) | docs/users/getting-started | 부분 | 초대는 됨. 자동 합류 없음 | F-26 |
| CT-94 | 출시 시 전 멤버 안내 DM | docs/admins/setup-overview | 없음 | 없음 | F-13 |
| CT-95 | 설정 검증 체크 | docs/admins/setup-overview | 있음 | `somawork doctor` | — |
| CT-96 | Slack 앱 scope 투명성 | docs/admins/for-slack-admins | 해당없음 | 문서 사안 | — |
| CT-97 | 프롬프트·사용 사례 라이브러리 | docs/users/prompt-library | 부분 | onboarding 워크플로 `src/prompt/workflows/onboarding.prompt` | F-13 |

## 9. 한도·요금·가용성

| ID | Claude Tag 기능 | 출처 | 판정 | soma-work 근거 | 피처 |
|---|---|---|---|---|---|
| CT-98 | 요금제·가용성 (Team·Enterprise, Slack만) | docs/overview | 해당없음 | — | — |
| CT-99 | 사용량 과금, 읽기·응답 판단은 무과금 | docs/admins/set-spend-limit | 해당없음 | — | — |
| CT-100 | 출시 크레딧 (2026-10-01 만료) | support 15575654 | 해당없음 | — | — |
| CT-101 | 스레드 시작·메시지 전달 처리량 한도 | docs/admins/set-spend-limit | 부분 | Slack API 토큰 버킷 `slack-api-helper.ts:53-80`. 유저·채널 동시성 상한 없음 | F-28 |
| CT-102 | 명시적으로 없는 통제 목록 | docs/admins/restrict-access | 해당없음 | 정보 | — |
| CT-103 | 로드맵 (JIT 자격증명 grant, 신원 인지 오버레이) | 블로그 agent-identity-access-model | 해당없음 | soma-work는 시간 제한 grant를 이미 가짐 | — |

## 출처끼리 어긋나는 곳

- 앰비언트: 발표문은 "ambient가 켜져 있으면"이라고 쓰지만 문서는 채널별 Respond automatically(기본 on)만 설명한다. F-03은 채널별 설정 하나로 정의한다.
- 감사 로그: 발표문은 "모든 작업과 요청자 로그"를 말하지만 감사 문서는 "작업별 요청자 로그는 없다"고 쓴다. F-30은 발표문 쪽(요청자 귀속 로그)을 목표로 한다.
- 지출 알림: 문서는 75%·90%, 지원 문서는 75%·95%. F-28은 문서 쪽(75%·90%)을 쓴다.
- 메모리 편집 권한: 문서는 Owner만, changelog 2.1.296은 Claude Tag admin도 허용. F-10은 관리자 전원으로 정의한다.

## 조사 중 발견한 soma-work 보안 갭

대조 과정에서 Claude Tag 계약과 다르게 열려 있는 두 곳을 찾았다. 정적 판독이며 라이브 재현은 하지 않았다.

- 미승인 유저가 기존 세션 스레드에 답글을 달면 승인 게이트를 거치지 않고 턴이 돈다 (F-01). 승인 게이트는 `if (isNewSession)` 블록 안에 있다 (`packages/slack/src/pipeline/session-initializer.ts:376`, `:430-469`). 유휴 경로 `FollowupDispatcher.runInitial` (`packages/slack/src/followup-dispatcher.ts:369`)에는 권한 훅이 없고, 디스패치 시점 재검사 `authorizeFollowupDispatch` (`src/slack-handler.ts:4388-4400`)는 대기열 항목만 덮는다.
- 대시보드 세션 상세를 로그인한 누구나 읽을 수 있다. 비공개 채널·DM 세션도 같다 (F-02). 이것은 #716에서 의도적으로 정한 정책이다 (`src/conversation/dashboard.ts:1314-1317` 주석 "session details world-readable for any authenticated user"). 버그가 아니라 정책 차이라서 F-02는 유저 결정이 필요하다.
