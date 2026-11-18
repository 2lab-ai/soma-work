# 33 — secret-access 아키텍처: 비밀 grant · 호출 단위 판정 · 대시보드 두 탭

Status: planned · Date: 2026-11-18 · 기준 main `e1003add` · 위 층 = [`32-secret-access-spec.md`](32-secret-access-spec.md) ·
SSOT = [`secret-access/ssot.md`](secret-access/ssot.md) · 드라이버 = [`secret-access/loop.md`](secret-access/loop.md)

> 요약: 새 저장소는 둘뿐이다 — 비밀 파일을 다루는 봇 쪽 관리자(이미 있는 `secrets/` 폴더를 읽고 쓰기만)와 감사 원장. 비밀 grant는
> 이미 있는 환경 grant 파일에 한 필드(`perSecret`)로 들어가고, 판정은 정책 4단계의 server-tools 클로저에 한 갈래를 더한다. 카드는
> 관리자 승인 레지스트리에 새 종류(`secret_use`) 하나. 두 탭은 설정 페이지의 어드민 전용 탭이고, 서버 도구 탭의 도구 목록은
> server-tools와 봇이 함께 읽는 카탈로그 한 곳에서 나온다.

## 0. 미니맵

```
33 secret-access 아키텍처
├─ 1. 그림 한 장           ─ 모델 → 정책 4단계(+비밀 갈래) → 카드 → grant → 다시 시도 / 대시보드 → 봇 → secrets/ · config.json
├─ 2. 구성 요소와 파일      ─ 새 모듈 · 고치는 모듈 · 건드리지 않는 것
├─ 3. 판정 규칙            ─ 호출이 쓰는 비밀 · 열리는 조건(OR) · 카드 · 다시 보내기
├─ 4. 저장                 ─ 비밀 파일 · grant · 요청 · 감사 원장 · config.json 쓰기
├─ 5. HTTP                 ─ /api/secrets/* · /api/server-tools/* · 게이트
├─ 6. 위협 모델            ─ 새로 생긴 길과 막는 곳
├─ 7. 작업 단위 (WU0–WU4)
└─ 8. 게이트
```

## 1. 그림 한 장

```
비어드민 U의 모델 ── mcp__server-tools__<tool> {server, …} ──▶ PreToolUse 정책 (build-stream-options)
                                                                │ 4단계 클로저 checkMcpToolPermission
                                                                │  ① 환경 grant가 연다        → 통과
                                                                │  ② 도구 수준 grant가 연다    → 통과
                                                                │  ③ 호출이 쓰는 비밀이 모두 U에게 허락됨 → 통과   ← 새 갈래
                                                                │  ④ 그 밖                    → 거부
                                                                ▼
                       거부 사유 secret-use: a,b ─▶ requestSecretUse ─▶ admin-request-store(kind secret_use)
                                                                     ├─ 모든 어드민 DM 카드 [수락(이 스레드)] [거부] [앞으로 계속 자동 수락]
                                                                     └─ 대시보드 관리자 승인 서랍 (admin-approvals 어댑터)
                       어드민 답 ─▶ decideSecretUse ─▶ env-skill-grants.json perSecret / 스레드 grant(메모리 12h)
                                                     └─ U의 턴을 다시 보낸다 (환경 스킬 흐름과 같은 길)

어드민 브라우저 ── /dashboard/settings#secrets ─▶ /api/secrets/* ─▶ secret-admin-store ─▶ <config dir>/secrets/<이름> (0600)
                                                                 └─ secret-audit.jsonl (값 없음)
             ── /dashboard/settings#server-tools ─▶ /api/server-tools/* ─▶ config.json server-tools.permission (원자적 · CAS)
                                                                         ├─ mcp-tool-grants.json (회수 · 추가)
                                                                         └─ env-skill-grants.json perEnvironment (환경 허락)
server-tools(stdio, 세션마다) ── ConfigCache 키 = config.json mtime·size + secrets/ 디렉터리 mtime ──▶ 새 비밀은 다음 호출에 반영
```

## 2. 구성 요소와 파일

### 2.1 새 모듈

| 구성 요소 | 위치 | 하는 일 |
|---|---|---|
| 비밀 관리자 | `src/secrets/secret-admin-store.ts` | `listSecrets()` → `{name, updatedAt}[]`(값 없음) · `writeSecret(name, value)` · `deleteSecret(name)`. 이름 규칙은 `secret-ref.ts`의 `SECRET_NAME_RE`를 export해 함께 쓴다. 쓰기 = 같은 폴더의 임시 파일(`O_EXCL`, 0600) → fsync → rename, 폴더 0700. `.bak` 없음. 심볼릭 링크 · 폴더 밖 대상 거부 |
| 비밀 쓰는 곳 | `src/secrets/secret-usage.ts` | 순수 함수. `secretUsages(serverToolsRaw)` → 이름 → `{server, path}[]` · `secretsForCall(serverToolsRaw, tool, input)` → 이름[] (§3.1). 원본 `config.json`을 mtime 캐시로 읽는 `loadServerToolsRaw()` (`env-users.ts`의 `loadEnvironments`와 같은 방식, 파싱 실패 = 마지막 값) |
| 감사 원장 | `src/secrets/secret-audit.ts` | `DATA_DIR/secret-audit.jsonl` append-only(0600, `O_APPEND\|O_NOFOLLOW`, fsync — `env-audit.ts`와 같은 방식). 한 줄 = `{at, actor, action, name?, userId?, tool?, server?, from?, to?}`. 값 · 길이 · 해시 필드는 타입에 없다 |
| 비밀 사용 판정 | `src/secrets/secret-access.ts` | `checkSecretAccess(tool, input, requester, scope, raw)` → `{kind:'none'}` (비밀을 안 쓰는 호출) · `{kind:'covered'}` · `{kind:'missing', names}` |
| 카드 블록 · 요청 · 결정 | `src/slack/secret-use-blocks.ts` · `src/slack/secret-use-request.ts` · `src/slack/secret-use-decision.ts` · `src/slack/actions/secret-use-action-handler.ts` | 3버튼 카드, 어드민 DM 발송(+스레드 알림), 한 번만 결정(클레임), 다시 보내기. 구조는 `env-skill-permission-*`와 `mcp-grant-decision.ts`를 따른다 |
| 서버 도구 카탈로그 | `packages/process-shared/src/server-tools-catalog.ts` | 도구마다 `{name, summary, access: 'read'\|'write'\|'mixed', sections}`. server-tools `defineTools()`는 이름 · 설명을 여기서 가져오고, 계약 테스트가 둘의 이름 집합이 같음을 확인한다 |
| 대시보드 라우트 | `src/conversation/secrets-routes.ts` · `src/conversation/server-tools-routes.ts` | §5 |
| 대시보드 탭 | `src/conversation/settings-secrets-tab.ts` · `src/conversation/settings-server-tools-tab.ts` | `X_TAB_HTML` · `X_TAB_CSS` · `X_CLIENT_JS`(String.raw, `${`·백틱 없음) — 스킬 탭과 같은 틀 |

### 2.2 고치는 모듈

| 모듈 | 바뀌는 것 |
|---|---|
| `packages/process-shared/src/secret-ref.ts` | `SECRET_NAME_RE`(또는 `isSecretName`) export. 동작 그대로 |
| `src/user-skill-grants-store.ts` | `SkillGrants.perSecret?: Record<string, string[]>` + `grantSecret` · `revokeSecret` · `secretGrantees` · `hasSecretGrant`. 스레드 grant는 기존 `addThreadGrant`/`hasThreadGrant`를 키 `secret:<이름>`으로 쓴다(저장소 하나 — `rules/permission.md` 4) |
| `src/agent-runtime/claude-code/build-stream-options.ts` | 4단계 클로저에 ③ 갈래(§3.2). 거부 처리에서 사유 `mcp-permission: secret-use:`면 `deps.onSecretUseDenied`(끝까지 기다리지 않음)와 모델 메시지(`permissionDecisionReason`). `tool-policy.ts`는 바꾸지 않는다 — Lean `ToolPolicy` 모델 그대로 |
| `src/admin-request-store.ts` | `AdminRequestKind`에 `'secret_use'` |
| `src/admin-approvals.ts` | `AdminApprovalKind`에 `'secret_use'`, 어댑터 등록(`src/slack/actions/index.ts`). 일괄 승인은 가장 좁은 답(이 스레드) |
| `packages/slack/src/actions/index.ts` | `secret_use_` 액션 정규식 → 핸들러 |
| `src/agent-runtime/policy/devops-secret-guard.ts` | `approvalRecordPaths()`에 `secret-audit.jsonl` (모델 읽기 · 쓰기 거부, 샌드박스 `denyWrite`도 이 목록) |
| `packages/process-shared/src/mcp/config-cache.ts` (server-tools 쪽 사용처만) | 캐시 키에 `SOMA_SECRETS_DIR` 디렉터리 mtime을 더한다 — 대시보드에서 비밀을 넣으면 실행 중인 세션의 다음 호출에서 풀린다 |
| `src/mcp-config-builder.ts` | `loadToolPermissions()`/`getRawConfig()` 캐시를 `config.json` mtime·size로 무효화 — 대시보드가 바꾼 수준이 재시작 없이 쿼리 시작 허용 목록에도 들어간다 |
| `src/conversation/settings-page.ts` | `SettingsPageTab.adminOnly?: true`. 클라이언트 `settingsTabs()`가 `/auth/me`의 `isAdmin`이 거짓이면 그 탭을 뺀다(보이기만의 문제 — 서버가 403) |
| `src/conversation/web-server.ts` | 두 라우트 등록 |
| 문서 | `docs/misc/guides/features{,.ko}.md`(설정 페이지 탭) · `docs/misc/reference/architecture.md`(라우트 묶음) · `docs/misc/configuration/current/config-json.md`(권한 표에 빠진 도구, 대시보드에서 바꾸는 법) · `CLAUDE.md` 비밀 저장소 항목(대시보드 관리, 감사 원장) |

### 2.3 건드리지 않는 것

- `secrets/` 경로 · `{"$secret"}` 해석 · fail-closed 규칙 · 배포 보존 목록 — env-access 그대로.
- 환경 4버튼 · `request_permission` 2버튼 카드 — 그대로. 새 카드는 그 둘이 다루지 않는 "비밀" 단위만.
- `tool-policy.ts` 단계 순서 · Lean 모델.

## 3. 판정 규칙

### 3.1 호출이 쓰는 비밀 (`secretsForCall`)

server-tools 원본 절(`{"$secret"}`이 풀리기 전)에서, 도구가 읽는 곳의 참조 이름을 모은다.

| 도구 | 읽는 곳 | 좁히는 인자 |
|---|---|---|
| `db_query` · `redis_query` · `mongodb_query` · `clickhouse_query` | `databases.<db>` | `database`(없으면 그 타입의 기본 db를 고르는 규칙 `resolveServerAndDb`와 같게; 못 고르면 `databases` 전체) |
| `gh_read` · `gh_pr` | `github` | — |
| `cf_api` | `cloudflare`(한 계정) · `cloudflare.accounts.<account>` (+ `sources`가 있으면 `github`) | `account` |
| `login` | `web.logins.<name>` | 로그인 이름 인자 |
| `phone_call` | `phone` | — |
| `list` · `list_service` · `list_stack` · `logs` · `ssh_exec` · `phone_calls` | (비밀 없음) | — |

카탈로그(§2.1)가 도구 → 읽는 곳을 함께 가진다 — 표가 두 곳에 생기지 않게. 카탈로그에 없는 도구 = 서버 절 전체(닫는 쪽).

### 3.2 열리는 조건

비어드민 U의 `mcp__server-tools__<tool>` 호출(`server` = S)은 아래 중 **하나라도** 맞으면 통과한다. 지금 열린 호출은 그대로 열린다(덧붙이기만).

1. S가 환경 서버이고 U가 그 환경 grant를 가진다(`checkEnvironmentToolAccess` → null). 그 절의 비밀도 쓴다(32 D5).
2. 도구가 어드민 전용이 아니고 도구 수준 grant가 그 수준을 채운다(`checkMcpToolPermission` → null). 표가 없으면 지금처럼 열림(#1170).
3. **새 갈래:** 그 호출이 쓰는 비밀이 하나 이상이고, 그 전부가 U에게 허락됐다 — 항상 grant(`perSecret`) 또는 이 스레드 grant.
   어드민 전용 도구도 이 갈래로 열린다(예: `gh_pr` + `github.token`). 그 도구의 자체 조건표(`approveWhen` · `mergeWhen` · 계정 `write` ·
   `allowTo`)는 그대로 걸린다. 비밀을 안 쓰는 도구(`ssh_exec` 등)는 이 갈래로 절대 열리지 않는다.

셋 다 아니면 거부. 그 호출이 허락 안 된 비밀을 쓰면 사유는 `secret-use: <이름,…>`(카드를 띄움), 아니면 지금의 사유 그대로(카드 없음).

### 3.3 카드 · 결정 · 다시 보내기

- **중복 방지:** 열린 요청 키 = (요청자, 이름 집합, 채널, 스레드). 같은 키가 열려 있으면 새 카드 없이 그 요청을 가리킨다.
- **만료:** 24시간(환경 스킬 요청과 같다). 만료된 카드의 클릭은 "만료됨".
- **결정:** 어드민만, 한 번만(`admin-request-store` 클레임). 이름 · 요청자 · 스레드는 저장된 요청에서 읽는다(버튼 값은 requestId만).
  - `once` → `addThreadGrant(ENV_SKILL_GRANT_OWNER, 'secret:<이름>', U, scope)` 이름마다.
  - `always` → `grantSecret(이름, U)` 이름마다.
  - `deny` → 기록 없음.
- 승인이면 U의 턴을 다시 보낸다(`env-skill-permission-action-handler`가 하는 그 길: "관리자가 비밀 사용을 허락했습니다 — 이어서 진행").
  거부면 U 스레드에 알림. 모든 어드민 DM 사본을 결과로 다시 쓴다. 대시보드 서랍은 같은 결정 함수를 부른다.
- 결정마다 감사 원장 한 줄(`action: 'secret_use.<once|always|deny>'`).

## 4. 저장

| 것 | 위치 | 형식 · 원자성 | 모델 |
|---|---|---|---|
| 비밀 | `<config dir>/secrets/<이름>` | 값 그대로, 0600, 폴더 0700, 임시 파일 → rename | 읽기 · 쓰기 거부 (그대로) |
| 비밀 grant(항상) | `DATA_DIR/env-skill-grants.json` `perSecret` | `atomicWriteJson` + `.bak` (기존 저장소) | 거부 (이미 목록에 있음) |
| 비밀 grant(스레드) | 메모리, 12시간 | 기존 스레드 grant | — |
| 열린 요청 | `DATA_DIR/admin-requests.json` kind `secret_use` | 기존 저장소 | 거부 (이미 목록에 있음) |
| 감사 원장 | `DATA_DIR/secret-audit.jsonl` | append-only, fsync | 읽기 · 쓰기 거부 (새로 목록에) |
| 도구 수준 표 | `config.json` `server-tools.permission` | 원본을 읽어 그 키만 바꾸고 `writeConfigFileAtomically`. 쓰기 직전 다시 읽어 처음 읽은 내용과 다르면 409(덮어쓰지 않음). 다른 절 · 키 순서 · 들여쓰기 2칸 유지 | 쓰기 거부 (배포 디렉터리, 그대로) |
| 도구 grant | `DATA_DIR/mcp-tool-grants.json` | 기존 `setGrant`/`revokeGrant`(잠금 + rename) | 거부 (그대로) |
| 환경 허락 | `env-skill-grants.json` `perEnvironment` | 기존 `grantEnvironment`/`revokeEnvironment` | 거부 (그대로) |

알려진 별건: `plugin-manager.saveConfig`는 타입에 있는 키만 다시 쓴다(`config-loader.ts` `Config`에 `server-tools` 없음) — 조사에서 코드로만
읽었다. WU3이 config.json을 쓰는 두 번째 사용자가 되므로 WU3에서 실제로 재현해 보고, 맞으면 별도 이슈로 연다(이 워크스트림 범위 밖).

## 5. HTTP

게이트(모든 라우트 공통): `authMiddleware` + 쓰기는 CSRF. 그 위에 **이름 있는 어드민** — `authContext.mode === 'oauth_jwt'` ·
`isAdminUser(userId)` · 환경 유저가 아님 · 쓰기는 `X-Admin-Mode: on`. 뷰어 토큰 · 인증 없음(`mode: 'none'`)은 읽기도 403(32 D9).

| 메서드 · 경로 | 몸 · 답 |
|---|---|
| `GET /api/secrets` | `{secrets: [{name, updatedAt, updatedBy?, usages: [{server, path}], missing: false}], missingRefs: [{name, usages}], users: [{id, name}]}` + 비밀마다 `access: {admins: true, environments: [{id, users}], toolGrants: [{userId, level}], direct: [userId]}` |
| `PUT /api/secrets/:name` | `{value, overwrite?: boolean}` → `{ok, secret: {name, updatedAt}}`. 있으면 `overwrite: true` 없이는 409. 값: 1 B–64 KiB, NUL 없음 |
| `DELETE /api/secrets/:name` | → `{ok}` |
| `POST /api/secrets/:name/grants` | `{userId, allow}` → `{ok, access}`. 승인된 유저만(`knownUsers`) |
| `GET /api/server-tools` | `{tools: [{name, summary, access, sections, level: 'read'\|'write'\|null, adminOnly, openTo}], permissionMap: 'present'\|'missing', servers: [{name, envUser?, sections, tools, secrets: [{name, exists}], dropped: [{section, reason}], environmentUsers}], toolGrants: [{userId, level, expiresAt, grantedBy}], users}` |
| `PUT /api/server-tools/permission/:tool` | `{level: 'read'\|'write'\|null}` → `{ok}`. 어드민 전용 도구는 400. `null` = 표에서 뺀다 |
| `POST /api/server-tools/permission` | 표가 없을 때 "표 만들기": 카탈로그 기본 수준으로 전체를 쓴다 → `{ok}` |
| `POST /api/server-tools/grants` | `{userId, level, duration}` / `DELETE /api/server-tools/grants/:userId/:level` |
| `POST /api/server-tools/environments/:envId/users` | `{userId, allow}` — 스킬 탭과 같은 `grantEnvironment`/`revokeEnvironment` |

요청 · 응답 로깅: `PUT /api/secrets/:name` 몸은 Fastify 로거 · 오류 처리기 · 감사 원장 어디에도 들어가지 않는다(테스트: 고유 값을 넣고 로그
스트림 · 응답 · 원장에서 문자열 0회).

## 6. 위협 모델 (새로 생긴 길)

| 길 | 막는 곳 |
|---|---|
| 모델이 대시보드 API를 불러 비밀을 넣거나 grant를 준다(세션이 호스트 env를 물려받음 — #391) | 이름 있는 어드민의 OAuth 쿠키 + 어드민 모드 + CSRF. 뷰어 토큰으로는 안 된다(§5). 모델 세션에는 사람의 브라우저 쿠키가 없다 |
| 모델이 새 기록 파일을 고친다 | `approvalRecordPaths()`에 감사 원장, grant는 기존 파일 — 샌드박스 `denyWrite` + 정책 1b + CLI 규칙 |
| 값이 응답 · 로그 · 원장으로 샌다 | 목록 API는 파일 내용을 읽지 않는다(stat만). 쓰기 응답은 이름 · 시각만. 로거 · 원장 타입에 값 필드가 없다. 테스트로 문자열 0회 |
| 이름으로 경로를 탈출한다(`../`, 링크) | `SECRET_NAME_RE` + realpath 확인(`readSecret`과 같은 규칙) + 쓰기는 `O_NOFOLLOW` |
| 비밀 grant로 비밀 없는 강한 도구가 열린다 | §3.2 ③은 "비밀 ≥ 1개 전부 허락"일 때만. `ssh_exec` · `logs`는 비밀이 없어 이 갈래 밖 |
| 프롬프트 인젝션이 카드를 남발한다 | 중복 키 · 24시간 만료 · 카드는 정보만(값 없음), 결정은 사람 |
| 어드민이 모르는 채로 강한 도구를 연다 | 카드에 도구 이름 · 서버 · 비밀 이름이 다 있다. 어드민 전용 도구면 카드에 "⚠️ 어드민 전용 도구" 한 줄 |

## 7. 작업 단위 (= 에픽의 서브이슈, PR 하나씩)

| WU | 내용 | 끝상태 확인 |
|---|---|---|
| WU0 | 이 문서들(`.prd/32` · `33` · `secret-access/`) | PR 머지 |
| WU1 | 비밀 관리자 + 감사 원장 + 쓰는 곳 + 비밀 탭(목록 · 추가 · 덮어쓰기 · 삭제) + 어드민 전용 탭 + server-tools 캐시 키 | A7 · A8 · A9(감사 원장), 단위 + 라우트 + 클라이언트 테스트 |
| WU2 | `perSecret` grant + 판정 ③ + `secret_use` 카드(Slack · 대시보드) + 다시 보내기 + 비밀 탭 "누가 쓸 수 있나" | A1–A6, 흐름 테스트(카드 1장 → 항상 → 다음 카드 0장) |
| WU3 | 카탈로그 + 서버 도구 탭(도구 · 수준 편집 · 도구 grant · 환경 카드 · 환경 허락) + config.json 쓰기 + 빌더 캐시 무효화 | A10 · A11 |
| WU4 | dev 배포 + 실측 + 문서 shipped 전환 | A12 |

의존: WU0 → WU1 → WU2, WU1 → WU3 (WU2 · WU3은 파일이 겹치지 않아 병렬 가능 — `settings-page.ts` 탭 목록 한 줄만 겹침).

## 8. 게이트 (build facts)

`npx tsc --noEmit` · `npx vitest run <바뀐 파일의 테스트>` · `npm run build` · 탭 추가로 깨지는 `settings-page.test.ts` 탭 목록 갱신 ·
i18n 카탈로그(`packages/common/src/i18n-catalog/en-*.json`) · PR CI + Sanitize Gate · 머지 전 리뷰 · dev 배포 뒤 실측(A12).
