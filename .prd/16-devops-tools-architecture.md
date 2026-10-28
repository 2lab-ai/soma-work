# 16 — devops-tools 아키텍처 (한 층 아래: 어떻게 만드나): 키 없는 MCP 서버 + 승인까지 검증하는 별도 OS 유저 브로커

Status: in-progress · Date: 2026-10-26 · 기준 main `0a7a638e` · 위 층 = [`14-devops-tools-as-is.md`](14-devops-tools-as-is.md)(지금) · [`15-devops-tools-to-be.md`](15-devops-tools-to-be.md)(요청한 끝상태) ·
상세 = [`devops-tools/research/2026-10-26-detail.md`](devops-tools/research/2026-10-26-detail.md)(실측 file:line · 결정표 원본 · 인수 시험 A1–A19)
이 문서는 상세 §3의 확정안(D1=① · D2=① · D3=① · D4=① · D5=① · D6=① — 2026-10-26 유저 확인, ssot SSOT_4)을 기준으로 쓴다.

## 0. 그림 한 장

```
Slack 유저 ──▶ soma-work 봇 (OS 유저 = 봇 유저)
                 │  Claude 세션 (같은 봇 유저 · 모델의 Bash/Read 포함)
                 │      │ MCP stdio
                 │      ▼
                 │  devops-tools MCP 서버 (봇 유저 · 키 없음 · 정책 없음 — 요청 중계와 대기만)
                 │      │ 유닉스 소켓 (launchd 소유, 0660, 봇 그룹)   {요청}
                 │      ▼
                 │  devops-broker 데몬 (OS 유저 = 브로커 유저 · LaunchDaemon · 루트 소유 코드·런타임·gh)
                 │      ├─ secrets/   gh/<account>.token · cf/<env>.forge · slack/broker-app.token  (0600, 브로커 유저만)
                 │      ├─ policy.json 어드민 Slack ID · 계정 클래스 · gh 인자 스키마 · 환경 계정·존 · TTL 상한 (브로커 유저만 쓰기)
                 │      ├─ state/     승인·lease 상태 (단일 큐로 직렬화된 전이 + 원자적 기록, 재시작 후 유지)
                 │      ├─ ledger.jsonl 감사 원장 append-only
                 │      ├─ 확인 카드: 브로커 전용 Slack 앱으로 어드민 DM에 게시 → 어드민 명의 ✅ 리액션을 직접 확인
                 │      ├─ gh 실행: 루트 소유 gh 사본, env={GH_TOKEN, 빈 HOME·GH_CONFIG_DIR}, 허용표 통과 argv만
                 │      └─ Cloudflare: HTTPS 직접 — 포지키로 단기 키 발급 → 단기 키로 호출 → 폐기·폐기 확인
```

경계 두 개: **(1) 정책 훅 + grant**(봇 안, 기존 기계) — 누가 어떤 도구를 부를 수 있나. 같은 OS 유저라 위조 가능한 **1차 문턱**이다(상세 §1.4).
**(2) 브로커**(봇 밖) — 키를 쥐고, 건별 확인을 **스스로** 받아 검증하고, 허용표 안의 요청만 실행하고, 원장을 남긴다. 키와 승인 판단은 (2)를 떠나지 않는다.

## 1. 위협 모델

모델 = 봇 OS 유저의 모든 권한(파일 읽기·쓰기, 소켓 연결, 봇 `.env`의 Slack 봇 토큰 사용)을 가진 공격자로 본다.

| 공격 | D1=① 브로커 전용 Slack 앱 (추천) | ② 봇 토큰 사본 + 리액션 | ③ 봇 경유 승인 |
|---|---|---|---|
| 도구 출력·로그로 키 노출 | 막음: 키는 브로커 밖으로 안 나감 + 스크럽 | 막음 | 막음 |
| Bash로 키 파일·키체인·`gh auth token` | 막음: 다른 OS 유저 파일 + 봇 유저 gh 정리(D6) + 하드 거부(§2) | 막음 | 막음(브로커가 있으면) |
| 봇 안의 승인 기록 위조로 승인 흉내 | 막음: 브로커는 봇 안의 승인 기록을 보지 않는다 | 막음 | **못 막음** |
| 소켓에 직접 요청 | 실행 0: 브로커 앱 카드에 어드민 명의 ✅가 없으면 실행 안 함 | 같음 | **실행됨** |
| 봇 토큰으로 ✅ 추가 | 무효: 카드는 브로커 앱 DM에 있고, 리액션은 토큰 주체 명의로만 달린다(R12) | 무효: 봇 명의 | — |
| 카드 문구 바꿔치기·원복(`chat.update`) 후 어드민 ✅ 유도 | 막음: 모델은 브로커 앱 토큰이 없어 카드를 고칠 수 없다 | **미확정**: 봇 토큰으로 고칠 수 있다. `edited` 흔적·blocks 수정·조회 경합을 라이브 시험으로 배제해야 함 | — |
| 카드 삭제 | 막음 | 가용성만 손상(카드 없음 = 미승인) | — |
| 봇 토큰으로 어드민 DM에 진짜 카드를 흉내 낸 가짜 카드·가짜 "실행 완료" 줄 게시 | 구분됨: 진짜 카드는 브로커 앱 DM에만 있고 발신 앱이 다르다(실행은 어차피 브로커 카드의 ✅에만 걸림) | 혼동·스팸 잔여: 발신자가 같다(실행 탈취는 아님) | — |
| gh 파일 플래그·위치 인자·stdin으로 브로커 비밀을 GitHub에 전송·덮어쓰기 | 막음: 하위 명령별 인자 스키마(§4), `@` 값·stdin 거부, 빈 HOME·cwd | 같음 | — |
| raw API로 레포 삭제·이전·공개 전환 | 막음: REST 쓰기 허용표 공집합, graphql 거부(§4) | 같음 | — |
| 브로커 코드·런타임·gh를 바꿔치기 | 막음: 루트 소유 경로에서 실행, 일반 deploy가 건드리지 않음 | 같음 | — |
| 남의 lease 사용 | **막지 않음(설계상)**: lease ID는 봇 안 소지자 권한(D4). 승인된 환경·존·권한·만료 밖은 거부, 원장에 호출 세션 기록 | 같음 | — |
| **남는 위험** | ① 읽기 grant·요청자 이름·세션 키는 같은 OS 유저가 위조 가능 → 읽기는 다른 유저 이름으로 실행될 수 있고, lease ID는 승인 범위 안의 소지자 핸들이라 다른 세션에서 쓰일 수 있으며, **카드의 요청자 이름도 자칭**이다(카드에 "자칭·미검증" 표기, 어드민은 작업 내용으로 판단). 실행 범위 자체는 어드민이 본 카드 내용을 넘지 못한다 | ①, 카드 바꿔치기(미확정), 가짜 카드 혼동 | 승인 전체 |

남는 위험 ①을 없애는 길은 모델 세션을 봇과 다른 OS 유저로 내리는 것이고, 이 작업 밖이다(§11).

## 2. 구성 요소와 파일 배치

| 구성 요소 | 위치 | 하는 일 |
|---|---|---|
| 프로토콜 | `packages/process-shared/src/devops/protocol.ts` | 요청·응답·오류 스키마, 프로토콜 버전(불일치 = 거부). **WU1에서 먼저 고정**, 나머지 WU가 의존 |
| gh 분류기·허용표 | `packages/process-shared/src/devops/gh-policy.ts` (+ table test) | argv → `read · write · org-admin-op · deny` 순수 함수, 하위 명령별 플래그 허용표, REST 허용표 (§4) |
| devops-tools MCP 서버 | `packages/mcp-servers/devops-tools/devops-tools-mcp-server.ts` (+ test) | 도구 정의, 인자 스키마 검증, 브로커 호출, 브로커가 카드 결과를 낼 때까지 대기. 키·정책·승인 판단 없음 |
| 브로커 | `packages/devops-broker/` (`broker.ts`, `approval.ts`, `slack-card.ts`, `gh-runner.ts`, `cf-client.ts`, `state.ts`, `ledger.ts`, `scrub.ts`, `install/`) | 소켓 서버, 카드 게시·리액션 검증, 상태·원장, gh 실행, Cloudflare 수명주기, 정리기 |
| 설정 빌더 | `src/mcp-config-builder.ts` | `devops-tools` 섹션이 있으면 서버 등록 — `hasServerToolsConfig`(`:611`) 옆에 `hasDevopsToolsConfig`, 등록은 `:171-172`와 같은 모양 |
| 정책 훅 하드 거부 | `src/agent-runtime/policy/tool-policy.ts` | **모드·어드민 무관 하드 거부 티어**(abort 가드 `:191-195`, cross-user `:219-222`와 같은 층)에 Bash `gh auth token`, `security find-*-password`, 브로커 경로 언급 추가. dangerous 규칙은 auto=classify·bypass=allow라(`:84-85`) 거기에 두면 안 된다. 이 거부는 심층 방어일 뿐 경계는 OS 유저다 |
| 설정 예시 | `config.example.json` | `devops-tools` 예시(자리표시자만 — sanitize) |

봇 쪽 승인 핸들러는 만들지 않는다 — 카드와 검증은 브로커가 한다(D1=①).

## 3. 도구 표면 (8종)

| 도구 | 필요 grant (`permission`) | 건별 ✅ | 하는 일 |
|---|---|---|---|
| `list` | read | — | 계정(이름·클래스)·환경(이름)·요청 세션이 받은 활성 lease(편의 표시, 경계 아님 — §6). 비밀 없음 |
| `gh_read` | read | — | `{account, args[]}` — §4 read 허용표만 |
| `gh_write` | read | **예**(D3=①) | `{account, args[]}` — §4 write 허용표만. 카드에 계정·명령 전문·요청자 |
| `gh_org_member` | read | **예** | `{action: add·remove·set-role, user, role: member·admin}` → `PUT/DELETE /orgs/{org}/memberships/{user}`. org는 정책 고정, org-admin 계정 전용 |
| `gh_repo_access` | read | **예** | `{action: grant·revoke, repo, user, permission: pull·triage·push·maintain·admin}` → `PUT/DELETE /repos/{o}/{r}/collaborators/{u}`. org-admin 계정 전용 |
| `cf_lease_request` | read | **예** | `{env, access: read·edit, permissions[], zones[], ttl, reason}` → ✅ 시 단기 키 발급, lease ID만 반환 |
| `cf_api` | read | — (lease가 곧 승인) | `{lease, method, path, query, body}` — lease 범위 안만 |
| `cf_lease_revoke` | read | — | 자기 lease 폐기 |

grant가 전부 `read`인 이유: grant는 카드 남발을 막는 1차 문턱일 뿐, 쓰기·관리·lease의 실행 권한은 건별 ✅가 준다. D3=②를 고르면 `gh_write`만 `write` grant + 브로커 쪽 기간 grant로 바뀐다.

## 4. gh 허용표 (`gh-policy.ts`)

입력은 argv 배열(셸 해석 없음). **허용표 밖은 전부 거부** — 거부 목록을 늘리는 방식이 아니다(gh 새 버전의 새 플래그도 자동 거부).

1. **최상위 명령 허용**: `pr`, `issue`, `repo`(view·list만), `run`, `workflow`, `release`(view·list·edit만), `label`, `search`, `org`(list만),
   `cache`, `ruleset`, `variable`, `project`, `status`, `api` — 각각 아래 4·5번에 적힌 하위 명령만. 그 밖(`auth`·`cs`·`codespace`·`extension`·
   `alias`·`config`·`secret`·`gist`·`browse`·`ssh-key`·`gpg-key`·`attestation`·`completion` 등)은 거부.
2. **하위 명령별 인자 스키마**: 각 (명령, 하위 명령)마다 ①허용 플래그와 값 형식(카드에 보이는 한 줄 값은 제어·서식·줄 구분 문자 거부, 본문은 양방향·폭 없는 문자 거부)
   ②**위치 인자의 개수·형식**(번호·태그·이름만 — 경로·URL 금지)
   ③stdin 사용 금지를 표로 둔다. 예: `pr comment` = 위치 1개(PR 번호), `-R`, `--body <문자열>`; `pr list` = 위치 0개, `-R`, `--state`, `--label`,
   `--author`, `--limit ≤200`, `--json <필드>`, `--jq`(길이 상한). 파일·디렉터리·브라우저·stdin을 쓰는 입력(`--body-file`, `--notes-file`,
   `-F/--field`의 `@` 값, `--input`, `-O/--output`, `-D/--dir`, `--web`, `--template`, `--recover`, `--env-file`, `workflow run --json`, 값 `-`)과
   `--hostname`은 표에 넣지 않는다. 같은 플래그 중복도 거부. 실행 시 stdin은 `/dev/null`. 표는 브로커가 설치한 고정 gh 버전 기준으로 RED 테스트한다.
3. **레포 문맥**: 브로커는 체크아웃이 없다 → 레포 대상 명령은 `-R owner/name` 필수, owner는 정책의 조직(또는 정책에 적은 소유자)만.
4. **read 하위 명령**: `pr view·list·diff·checks·status`, `issue view·list·status`, `repo view·list`, `run view·list`, `workflow view·list`,
   `release view·list`, `label list`, `search repos·issues·prs·code·commits`, `org list`, `cache list`, `ruleset list·view·check`, `variable list·get`,
   `project view·list·item-list·field-list`. 허용표에 와일드카드(`*`)를 두지 않는다 — 하위 명령마다 플래그 표가 있어야 통과(WU1 테스트로 고정).
   읽기도 정책의 소유자 안으로 묶는다: `search`는 `--owner`나 `-R`이 필수, 검색어와 `--search`의 `repo:`·`org:`·`user:`·`owner:`는 정책 소유자만,
   `repo list`는 소유자 인자 필수. 여러 저장소를 모아 보여주는 `status`는 뺐다(WU1 리뷰, 2026-10-26).
5. **write 하위 명령**: `pr create·comment·edit·merge·close·reopen·ready·review`, `issue create·comment·edit·close·reopen`, `run rerun·cancel`,
   `workflow run·enable·disable`, `release edit`, `label create·edit`, `variable set·delete`(값은 `--body <문자열>`만), `cache delete`.
   (`release create`는 태그 뒤 위치 인자를 업로드 파일로 받으므로, `run download`·`release download·upload·delete`·`label delete`와 함께 v1에서 뺀다.)
6. **`gh api`**: 경로를 먼저 정규화한다 — 전체 URL·`..`·`%2F`·`//`·`{owner}` 자리표시자·쿼리 안의 경로 = 거부, 선행 `/` 통일.
   메서드는 gh 규칙으로 계산(`-X` 우선, 없으면 `-f/-F/--field/--raw-field`가 있으면 POST, 아니면 GET — gh `pkg/cmd/api/api.go:329`).
   - **경로 허용표**: 메서드와 무관하게 `repos/<정책 소유자>/<레포>/…`, `orgs/<정책 소유자>/…`, `rate_limit`만 통과한다. `repositories/<id>`·`user…`·`users/…`·
     `search/…`·`enterprises/…`·`gists` 등은 거부. 그 안에서도 자격 경로(`secrets`·`keys`·`hooks`·`secret-scanning`·`private-registries` 등 세그먼트)는 거부.
   - **GET**: 위 허용표 안이면 read.
   - **GET 외**: **REST 쓰기 허용표**에 있는 (메서드, 경로 패턴, 허용 필드)만 write로 통과. v1 표는 비워 두고 시작한다 — 위 5번 하위 명령으로
     충분하지 않은 실제 요구가 생기면 한 줄씩 추가한다. 따라서 `DELETE /repos/{o}/{r}`, `POST …/transfer`, `PATCH /repos/{o}/{r}`(private·visibility·archived)는 v1에서 도달 불가.
   - `graphql`: v1 거부.
7. 조직·레포 권한 작업은 `gh api`가 아니라 전용 도구(§3)로만 한다.

## 5. 건별 확인 — 브로커가 직접 받는다

1. 브로커가 요청을 정규화(키 정렬 JSON: 도구·계정/환경·argv 또는 구조화 인자·요청자·세션 키)하고 sha256 = `digest`, 승인 ID를 만든다.
2. 브로커가 **브로커 전용 Slack 앱** 토큰으로 정책의 어드민 Slack ID 각각에게 DM 카드를 게시한다: 사람이 읽는 문장 1줄(예: "org-admin 계정이
   `<org>`에서 `alice`의 조직 역할: 현재 멤버 아님 → member로 추가" — 브로커가 구조화 인자와 카드 직전에 조회한 현재 상태로 직접 쓴다.
   GitHub의 멤버십·협업자 PUT은 '추가 또는 변경'이라 현재 상태 없이 '추가'라고 쓰면 소유자 강등·권한 하향이 숨는다 — WU2b 리뷰), 원 인자 전문(값마다 JSON 이스케이프한 코드 영역 — `--body` 같은 문자열이 카드 지시문처럼 보이지 않게. 구역당 3,000자·카드 전체 12,000자·블록 45개를
   넘으면 자르지 않고 요청을 거부한다), 요청자 주장(Slack ID — 인증된 값이 아님을 카드에 표기), 만료 시각, digest 앞 12자,
   "승인하려면 ✅(`white_check_mark`), 거부하려면 ❌(`x`) 리액션" — 리액션 이름은 이 둘로 고정. 게시한 (채널, ts)를 상태에 기록.
   앱 수준 토큰(`slack/broker-app-socket`, scope `connections:write`)이 브로커에 있으면 카드 끝에 **승인 / 거부 버튼**(Block Kit `actions`, 값 = 승인 ID)을 붙이고
   브로커가 Socket Mode로 클릭을 받는다(2026-10-28 유저 요청). 토큰이 없으면 지금처럼 리액션만 쓴다.
3. 브로커가 5초 간격으로 `reactions.get`(그 채널·ts, **`full=true`** — 없으면 `users` 배열이 일부만 올 수 있다, R12)을 확인한다.
   **승인 조건**: ✅ 리액션 사용자 중 정책 어드민 ID가 있다. **거부 조건**: ❌ 리액션 사용자 중 정책 어드민 ID가 있다(다른 사람의 ❌는 무시).
   **버튼**: 클릭은 그 승인 ID의 카드 (채널, ts)에서 왔고, 클릭한 사람(Slack이 채우는 `user.id`)이 정책 어드민이고, 아직 대기 중일 때만 반영 —
   그다음은 리액션과 같은 결정 경로(만료 후 무효·디스크 먼저·1회 소비). 버튼이 있어도 리액션 폴링은 계속한다(소켓이 끊겨도 승인이 막히지 않게).
   봉투(envelope)는 처리 전에 ack한다(미응답 봉투는 재전송된다).
   둘 다 있으면 거부. 5분 무응답 = 만료(기존 권한 요청과 같은 상한 — `mcp-tool-permission-mcp-server.ts:263` `5 * 60 * 1000`).
   대기 카드는 동시에 3장까지(초과 요청은 즉시 "대기 중인 확인이 많음"으로 거절). 3장 × 어드민 2명 ÷ 5초 ≈ 분당 72회라 `reactions.get` 레이트리밋을
   넘을 수 있다 [추정] → 폴링 간격은 대기 카드 수에 비례해 늘리고, 429면 `Retry-After`를 지킨다. Slack API 오류·429 동안은 미승인(실행 0). 카드를 고칠 수 있는 토큰은 브로커만 갖고 있으므로 카드 내용 = 게시 내용이다.
4. 승인 ID를 **실행 전에 소비**한다: 브로커는 상태 전이를 단일 큐로 직렬화하고(동시 요청이 같은 승인을 두 번 소비할 수 없음), 전이마다 state 파일에
   fsync 후 rename. 같은 승인 재사용·재시작 후 재사용 = 거부.
5. 실행 결과(성공·실패·종료 코드)를 카드 스레드에 1줄, 원장에 1행. 원격 쓰기의 결과가 불명(응답 유실)이면 자동 재실행하지 않고 조회로 확인해 원장에 적는다.
6. MCP 서버는 소켓으로 "대기 중 → 승인/거부/만료 → 결과"를 받는다. 승인 대기 상한은 5분이고, 브로커는 카드 만료 + 25초에 반드시 끝 메시지
   (`not-approved` 또는 `still-executing`)를 보낸다. MCP 서버는 카드 만료 + 30초, 최대 355초(SDK 호출 상한 360초 아래)까지 기다린다.
   "승인되지 않음 — 다시 요청 가능"은 브로커가 실제로 `not-approved`를 보낸 경우에만 모델에 전한다. 끝 메시지 없이 시간이 지나면
   "결과 확인 안 됨 — 승인·실행됐을 수 있으니 다시 요청하기 전에 상태부터 확인"으로 전한다(시간 경과로 미승인을 지어내지 않는다 — WU5 리뷰).

왜 전용 앱 + 리액션인가:
- **전용 앱**: 기존 봇 토큰은 봇 `.env`에 있어 모델도 쓸 수 있다 → 그 토큰으로 올린 카드는 모델이 `chat.update`로 문구를 바꿨다 원복할 수 있고, 그런 수정이
  지울 수 없는 흔적을 남기는지(블록·첨부 포함)는 1차 출처로 확인하지 못했다. 전용 앱 토큰은 브로커 유저 파일에만 있으므로 이 문제가 성립하지 않는다.
- **리액션**: 리액션은 호출한 토큰의 주체 명의로만 달린다 — `reactions.add` 인자는 `channel`·`name`·`timestamp`·`token`뿐이고(`users` 같은 대리 인자 없음),
  중복 오류가 "the user/reaction combination"이다(R12). 버튼은 상호작용 이벤트 수신(소켓·HTTP 엔드포인트)이 필요하지만 리액션은 폴링으로 끝난다.
- **버튼(추가, 2026-10-28)**: 클릭 이벤트는 이 앱의 Socket Mode 연결로만 온다 — 연결을 여는 앱 수준 토큰은 브로커 유저 파일에만 있고, 다른 앱의 토큰(soma 봇)은
  이 앱 메시지의 클릭 이벤트를 만들 수 없다. 클릭한 사람 ID는 Slack이 넣는 값이라 요청자 주장과 달리 판단 입력으로 쓴다.
- 전용 앱 매니페스트(`packages/devops-broker/install/slack-app-manifest.json`): bot scope `chat:write`(카드 게시)·`im:write`(어드민 DM 열기)·`reactions:read`(승인 확인)만,
  이벤트 구독 없음. 인터랙티비티는 Socket Mode로만(요청 URL 없음) — 버튼 클릭 수신용. 모델이 가진 soma 봇 토큰은 앱이 달라 이 앱의 DM을 읽거나 쓰거나 리액션할 수 없다.
- WU2 라이브 시험: 기존 봇 토큰으로 카드에 ✅ → 무효, 어드민 ✅ → 승인, 어드민 아닌 사람 ❌ → 무시를 실측으로 고정한다.

## 6. Cloudflare 단기 키 수명주기

- **포지키**: 환경마다 **계정 소유 토큰**, 권한 = `Account API Tokens Edit`(API 이름 `Account API Tokens Write`)만. 유저 소유 "Create additional tokens"
  토큰은 그 유저가 닿는 모든 리소스의 토큰을 찍을 수 있어(R2) 경계가 계정이 아니라 사람이다 — 기본안에서 쓰지 않는다.
- **첫 시험(WU0 — 구현보다 먼저, 운영 키 3개를 받기 전)**: dev2 포지키 1개로 서로 다른 세 질문에 답한다.
  - Q1 **기능**: 필요한 자식(존 DNS read, 존 DNS edit)을 발급할 수 있는가, `expires_on`이 지켜지는가. 아니면 이 설계는 성립하지 않는다 → 계획 복귀.
  - Q2 **환경 경계**: 다른 계정·다른 계정의 존을 대상으로 한 자식 발급이 거부되는가. **반드시 거부여야 한다** — 거부되지 않으면 계획 복귀.
  - Q3 **같은 계정 안 권한 상한**: 브로커 허용표보다 강한 권한(예: 계정 설정 쓰기)의 자식도 발급되는가. 발급되면 그것이 "포지키를 도난당했을 때의 피해 범위"이고,
    평상시 경로는 브로커 정책이 좁힌다 — 결과를 보고서에 그대로 적는다(R4 확정).
  - 부가: IP 조건 키 표기(`request.ip` vs `request_ip`, R1), 계정 토큰 개수 상한 확인.
  - 계정 소유 토큰을 쓸 수 없는 계정이면 대안 = 그 환경 계정에만 속한 전용 Cloudflare 유저의 `API Tokens Edit` 토큰(Q2 경계는 같고, Q3 범위는 그 유저의 계정 역할로 정해짐).
    어느 경우든 결과를 보고하고 계획으로 돌아와 확인받는다 — 조용히 대체하지 않는다.
- **발급**: `POST /accounts/{account_id}/tokens` `{name: "soma-lease-<leaseId>", policies, not_before: now, expires_on: now+ttl}`.
  `policies.resources` = 승인된 존 ID(`com.cloudflare.api.account.zone.<id>`) 또는 계정 1개, `permission_groups` = 정책 허용표 ∩ 요청, **ID로**(R3).
  IP 조건은 첫 시험에서 표기를 확정한 뒤에만 켠다.
- **상태 전이**: `requested → approved → minting → active → revoking → revoked | revoke_failed`, 그리고 `minting` 실패 = `mint_failed`.
  발급 응답을 받았지만 저장 전에 죽은 경우 = 정리기가 `soma-lease-` 접두로 찾아 삭제(orphan).
- **보관**: 단기 키 값은 브로커 메모리 + 브로커 유저 0600 파일 — 모델에는 `leaseId`(128비트 무작위)·`expiresAt`·범위만.
- **공유 범위(D4)**: lease ID는 **그 봇 안 소지자 권한**이다. 브로커는 요청 세션에 ID를 돌려주지만, 세션 키는 같은 OS 유저가 위조할 수 있어 "다른 세션 차단"을 보장하지 않는다.
  그래서 승인 카드에 "이 범위·기간 동안 이 봇의 세션이 사용"이라고 적고 그 범위로 승인받는다. `list`는 편의상 요청 세션 것만 보여주지만 보안 경계가 아니다.
  호출마다 원장에 호출 세션 주장과 경로를 남긴다.
- **호출**(`cf_api`): `https://api.cloudflare.com/client/v4` + 정규화된 path. 허용 = lease의 존(`/zones/<id>/…`) 또는 계정(`/accounts/<id>/…`) 안,
  read lease면 GET만, `*/tokens*`·`/user*`·`*/members*`는 항상 거부. 응답 1MB 상한, 스크럽.
- **폐기**: TTL 만료 또는 `cf_lease_revoke` → 포지키로 `DELETE /accounts/{id}/tokens/{tokenId}`, 이어 포지키로 `GET /accounts/{id}/tokens/{tokenId}` = 404일 때만
  "폐기 확인". 단기 키 자신의 `verify`는 근거로 쓰지 않는다(R5: IP 필터 미적용, 삭제 여부를 묻는 호출이 아님). 실패 = `revoke_failed` + 어드민 DM, 다음 주기 재시도.
- **정리기**: 5분마다 `GET …/tokens?include_expired=true`에서 `soma-lease-` 접두 + (만료 또는 상태에 없음)을 삭제(계정당 500개 상한 — R6).
- **수명 상한**: 기본 1시간, 최대 71시간(원문 "3일 미만"), 정책 `maxTtl`로 환경별 더 좁힐 수 있음. 초과 요청 = 거부.

## 7. gh 실행 (브로커 `gh-runner.ts`)

- gh 실행 파일 = 설치 단계가 루트 소유 경로(`/usr/local/libexec/soma-devops/gh`)에 복사한 고정 버전. Homebrew gh는 봇 유저 소유라 쓰지 않는다(상세 §1.6).
- `execFile(<루트 소유 gh>, argv, {env: {GH_TOKEN, HOME·GH_CONFIG_DIR: 빈 임시 디렉터리, GH_PROMPT_DISABLED: 1, GH_NO_UPDATE_NOTIFIER: 1, NO_COLOR: 1, PATH: /usr/bin:/bin}, cwd: 빈 임시 디렉터리, timeout: 60초})`.
- `gh auth switch`는 쓰지 않는다(전역 상태·동시 호출 경합 — R8). stdout/stderr 1MB 상한, 스크럽(토큰 값 그대로 + `gh[opsur]_`·`github_pat_`·`cfat_`·`cfut_`·`xox[bap]-` 패턴).
- 스크럽은 출력 경로의 방어이고, 외부로 보내는 요청 본문의 방어는 §4 인자 스키마(파일 플래그·경로 위치 인자·stdin 없음)다. stdin = `/dev/null`.

## 8. 설정과 설치

봇 쪽 `config.json` (정책 없음 — 어떤 도구가 어떤 grant를 요구하는지만):

```json
"devops-tools": {
  "permission": {
    "list": "read", "gh_read": "read", "gh_write": "read",
    "gh_org_member": "read", "gh_repo_access": "read",
    "cf_lease_request": "read", "cf_api": "read", "cf_lease_revoke": "read"
  }
}
```

브로커 쪽 `policy.json` (브로커 유저 소유 — 모델이 `config.json`을 고쳐 범위를 넓히는 길을 막는다). **어드민 판정의 정본은 `admins`다** — 설치 때 봇의
`ADMIN_USERS`로 한 번 채우고, 이후 어드민 변경은 브로커 정책 갱신(sudo 설치 단계)으로 한다:

```json
{
  "admins": ["<slack-user-id>"],
  "gh": {
    "org": "<org>",
    "accounts": {
      "member":    { "login": "<login>", "class": "member" },
      "org-admin": { "login": "<login>", "class": "org-admin" }
    },
    "restWriteAllowlist": []
  },
  "cloudflare": {
    "dev2":   { "accountId": "<id>", "zones": { "<zone-name>": "<zone-id>" },
                "permissionGroups": { "read": ["<group-id>"], "edit": ["<group-id>"] },
                "defaultTtl": "1h", "maxTtl": "71h", "ipCondition": false },
    "stage0": { "…": "같은 모양" },
    "stage2": { "…": "같은 모양" }
  },
  "approvalTimeout": "5m"
}
```

- 비밀: `secrets/gh/<account>.token`, `secrets/cf/<env>.forge`, `secrets/slack/broker-app.token`(브로커 유저 0600). 입력 = 브로커 CLI
  `soma-devops-broker ingest <kind> <name>`이 **stdin에서만** 읽는다(인자·env·채팅 경로 없음).
- 배치(라운드 1에서 고정): 데이터 루트 `/usr/local/var/soma-devops`(브로커 유저:`soma-devops` 0750) 아래 `policy.json`, `secrets/` 0700,
  `state/` 0700(상태·`ledger.jsonl`), `run/` 0750(브로커:`soma-devops`) 안의 `broker.sock` 0660. 코드는 `/usr/local/libexec/soma-devops/`(루트 소유:
  Node 런타임, 브로커·process-shared 빌드 결과, 고정 gh). 소켓 경로 상수는 protocol.ts `DEFAULT_BROKER_SOCKET_PATH`.
- 소켓은 브로커가 직접 연다. launchd `Sockets`는 데몬이 `launch_activate_socket()`로 fd를 받아야 하는데 Node에는 그 바인딩이 없다.
  그래서 접근 제어는 `run/` 디렉터리 권한(그룹 `soma-devops`만 통과)으로 하고, 봇 유저를 그 그룹에 넣는다.
- 설치(`packages/devops-broker/install/`, sudo 1회): 브로커 OS 유저·그룹 생성, 봇 유저를 소켓 그룹에 추가, 코드·Node 런타임·gh를 루트 소유 경로에 복사,
  LaunchDaemon(`UserName` = 브로커 유저, `KeepAlive`), 설치 후 소유·권한 점검표(코드·런타임·gh·정책·비밀·`run/`) 출력.
- 일반 soma-work deploy는 브로커를 건드리지 않는다. 브로커 갱신 = 같은 설치 단계 재실행(sudo). MCP↔브로커 프로토콜 버전 불일치 = 거부.

## 9. 리서치 근거 (2026-10-26, 1차 출처)

- **R1** 발급 API: `POST /accounts/{account_id}/tokens`·`/user/tokens`, 본문 `name`·`policies` 필수, `not_before`·`expires_on`(RFC 3339 UTC), 값은 1회만 반환,
  기본 무만료, TTL 상한 문서 없음. IP 조건 키는 문서마다 `request.ip`/`request_ip`로 다름(미확인).
  https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/ · https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/
- **R2** 포지키 권한: 유저 소유 = `API Tokens Write`("Create additional tokens" 템플릿 전용, "can create tokens with access to any of a user's resources"),
  계정 소유 = `Account API Tokens Write`, 자식은 만드는 사람의 계정 권한을 넘지 못함.
  https://developers.cloudflare.com/fundamentals/api/reference/template/ · https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/
- **R3** 권한 그룹 ID 조회 `GET /accounts/{id}/tokens/permission_groups`, 이름은 바뀔 수 있으니 ID로.
  https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/
- **R4** 계정 소유 포지키가 자식을 자기 정책으로 제한하는지 — 1차 출처 없음(미확인, §6 첫 시험).
- **R5** 확인 `GET /accounts/{id}/tokens/verify`(IP 필터 미적용). https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
- **R6** 한도: 토큰 1200요청/5분, 유저 토큰 50개, 계정 토큰 500개. https://developers.cloudflare.com/fundamentals/api/reference/limits/
- **R7** CLI는 `CLOUDFLARE_API_TOKEN` env를 읽고 작업 디렉터리 `.env`도 읽음 — v1은 CLI 대신 HTTPS 직접.
  https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- **R8** gh 다중 계정(2.40+), 조회 순서 `GH_TOKEN` > `GITHUB_TOKEN` > 설정 파일 > 키체인, `GH_CONFIG_DIR`.
  https://github.com/cli/cli/blob/trunk/docs/multiple-accounts.md · https://cli.github.com/manual/gh_help_environment
- **R9** 권한: 조직 멤버십 쓰기 = fine-grained `Members: write` 또는 classic `admin:org`(`write:org`), 레포 collaborator = `repo` + 레포 admin.
  지금 토큰(`gist, read:org, repo, workflow`)으로는 조직 멤버십 변경 불가.
  https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens · https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- **R10** `gh api` 기본 메서드: "GET normally and POST if any parameters were added"(`--input` 포함), graphql은 항상 POST.
  https://cli.github.com/manual/gh_api · https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/api/api.go
- **R11** fine-grained PAT: 수명 최대 366일(조직 정책), 조직 승인 기본 켜짐, 리소스 소유자 1개.
  https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization
- **R12** Slack 리액션: `reactions.add` 인자 = `channel`·`name`·`timestamp`·`token`(+폐기된 `file`·`file_comment`), 중복 오류 `already_reacted` =
  "The specified item already has the user/reaction combination" → 토큰 주체 명의. `reactions.get`: "The `users` array … might not always contain all users
  that have reacted", `full` = "If true always return the complete reaction list".
  https://docs.slack.dev/reference/methods/reactions.add · https://docs.slack.dev/reference/methods/reactions.get

## 10. 다음 파손 (첫 수정 너머를 미리 본다)

1. **사람 계정 로그아웃 전 확인** — 대상 호스트의 실행 중 세션 env에 `GITHUB_TOKEN`이 있는지 다시 본 뒤 로그아웃(상세 §1.3). 없으면 멈추고 보고.
2. **server-tools grant 켜기(D5)의 반영 시점** — 권한 맵은 스트림 옵션을 만들 때 읽는다(`build-stream-options.ts:212`) → 새 턴부터 반영 [추정].
   적용 후 새 턴과 진행 중이던 스레드 양쪽에서 A19를 실측하고, 안 닫히면 그 배포를 재시작한다. 채널에 1줄 공지 — 고객 채널이므로 "DB 도구는 이제
   유저별 허락이 필요"만 적고, grant가 위조 가능한 1차 문턱이라는 사실·방법은 적지 않는다(운영 원장에만).
3. **Cloudflare 토큰 상한·레이트리밋** — 정리기 없이 쌓이면 계정 500개에서 발급이 막힌다(R6). 발급 실패(포지키 폐기·상한·429)는 `mint_failed` 행 + 카드 갱신.
4. **카드가 쌓이는 문제** — 어드민 DM에 카드가 많아지면 오승인 위험이 커진다. 같은 요청 digest의 대기 카드가 있으면 새 카드를 만들지 않고 그 카드를 가리킨다.
5. **sanitize** — 예시·테스트·문서에 고객 이름·도메인·호스트 라벨 금지, 브랜치 이름은 `deploy/staging` 같은 일반형. PR의 Sanitize Gate가 리시트.
6. **D1=②로 바뀌면** — 브로커가 기존 봇 토큰 사본으로 카드를 올린다. 그 전에 라이브 시험으로 "모델이 봇 토큰으로 카드 문구(text·blocks·attachments)를 바꿨다 원복한 경우를
   브로커가 항상 감지하는가"(`edited` 흔적의 지속성, 두 조회 사이 경합 포함)를 증명해야 하고, 실패하면 ①로 전환한다. 증명 전에는 승인 무결성을 주장하지 않는다.
7. **D3=②로 바뀌면** — 브로커가 기간 write grant를 보관하고, 카드 대상이 "기간 grant 부여"로 바뀐다. 남는 위험 ①이 쓰기로 넓어진다(상세 §3).

## 11. 로드맵 (이 작업 밖, 이름만)

- 기존 grant·도구 허가 프롬프트의 위조 가능 구조(상세 §1.4) — 같은 방식(브로커 또는 다른 OS 유저 프로세스가 승인 판단)으로 옮기기.
- 모델 세션을 봇과 다른 OS 유저로 실행 — 남는 위험 ①(요청자 이름 위조)과 server-tools grant 위조를 함께 닫는 근본 수정.
