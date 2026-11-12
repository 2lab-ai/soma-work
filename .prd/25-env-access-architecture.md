# 25 — env-access 아키텍처 (한 층 아래: 어떻게 만드나): 비밀 저장소 · 샌드박스 프로필 둘 · 환경 사용자 · 환경 도구

Status: planned · Date: 2026-11-12 · 기준 main `35ceddd92` · 위 층 = [`23`](23-env-access-as-is.md)(지금) · [`24`](24-env-access-to-be.md)(끝상태) ·
SSOT = [`env-access/ssot.md`](env-access/ssot.md) · 드라이버 = [`env-access/loop.md`](env-access/loop.md)

## 0. 그림 한 장

```
Slack 유저 ──▶ soma-work 봇 프로세스 (OS 유저 = 봇 유저, 샌드박스 밖)
                │  evaluateToolPolicy  ── 1b 비밀 거부 (모든 유저 · 어드민 · 모든 모드)
                │                      └─ 환경 grant 확인 (요청자 × 환경 사용자 × 스킬|전체)
                │  환경 grant 저장소 ◀── 어드민 카드 4버튼 · 대시보드 결정 (모델은 못 씀)
                │  secrets/  (봇 유저 0700 · 파일 0600) ◀── config.json·server-tools는 {"$secret": "<name>"} 참조만
                │
                ├─ Claude 세션 = 샌드박스 (OS 강제, fail-closed)
                │     일반 유저 프로필: 쓰기 /tmp/{uid} · 네트워크 dev 목록 (+ grant 받은 환경 도메인)
                │     어드민 프로필:   쓰기 홈·배포 디렉터리 · 네트워크 넓게 · trustd(gh TLS)
                │     둘 다: secrets/ · ~/.ssh 읽기 금지, 승인·grant 기록 쓰기 금지, Bash ssh 금지
                │
                └─ server-tools MCP (= 환경 도구, 샌드박스 밖, 봇 유저)
                      환경마다 한 절: envUser · ssh · databases · github · web(login) · cloudflare
                      도구: list · logs · db_* (지금) + ssh_exec · gh · login · cf_* (추가) · 감사 원장
                      ─────────▶ 환경 호스트 · 고객 레포 · 환경 웹 · Cloudflare
```

별도 브로커(별도 OS 유저 데몬 · 브로커 Slack 앱 · `devops-tools` 중계 MCP · 대기열)는 없다. 그 역할은 위 셋이 나눠 맡는다:
키 보관 = `secrets/` + OS 샌드박스, 승인 = 환경 grant + 4버튼, 실행 = server-tools 환경 도구.

## 1. 위협 모델

모델(어드민 포함) = 샌드박스 안에서 Bash · 기본 도구 · MCP 도구를 부를 수 있는 주체. 샌드박스 밖 코드(봇 프로세스, 그 MCP 서버, 허가된
플러그인)는 신뢰한다.

| 공격 | 막는 곳 |
|---|---|
| Bash로 비밀 파일 읽기 (상대경로·와일드카드·심볼릭 링크 포함) | OS 샌드박스 `denyRead` (`secrets/`, `~/.ssh`) |
| Read · Grep · Glob · Write · Edit로 비밀 경로 | 정책 1b (`devops-secret-guard.ts`를 비밀 경로 전체로 넓힘) — 어드민 · 모든 모드 |
| 승인·grant 기록을 고쳐 허락을 흉내 | OS `denyWrite` + 정책 1b(Write · Edit) |
| 샌드박스가 뜨지 못한 틈 | `failIfUnavailable: true` — 모델 명령 실행 안 함 |
| ssh 키로 직접 접속 | Bash ssh 금지(모든 모델) + `~/.ssh` 읽기 금지. 호스트 명령은 `ssh_exec`만 |
| 환경 도구를 grant 없이 호출 | 정책의 환경 grant 단계 (어드민 = 통과) |
| 환경 도구로 허용 밖 GitHub 작업 | `gh` 허용표 (`packages/process-shared/src/devops/gh-policy.ts` 재사용) + 승인 조건 검사 |
| 봇 App 토큰으로 배포 브랜치 머지 | **남는 위험** — 24 §6. 고객 레포 배포 브랜치 규칙이 근본 해결 |

## 2. 구성 요소와 파일 배치

| 구성 요소 | 위치 | 하는 일 |
|---|---|---|
| 비밀 디렉터리 경로 | `packages/common/src/env-paths.ts` | `SECRETS_DIR` = `<config dir>/secrets` (단일 경로 규칙 — `rules/config.md`) |
| 비밀 참조 해석 | `packages/process-shared/src/secret-ref.ts` | `{"$secret": "<name>"}` → `secrets/<name>` 내용. 이름은 안전한 경로 조각만, 파일 없음 = 오류(fail-closed). 봇과 MCP 서버가 함께 쓴다 |
| 비밀 거부 | `src/agent-runtime/policy/devops-secret-guard.ts` | 지금의 브로커 경로 · `gh auth token` · 키체인에 더해 `SECRETS_DIR`, `~/.ssh`(PR2), 승인·grant 기록 쓰기. `checkDevopsSecretForTool` 호출 모양은 그대로라 Lean `devopsSecret` 기본값 모델은 바뀌지 않는다 |
| 샌드박스 프로필 | `src/agent-runtime/claude-code/build-stream-options.ts` | `failIfUnavailable: true`, 공통 `denyRead`·`denyWrite`, 어드민 프로필(PR2), 환경 grant가 더하는 도메인·작업 폴더(PR4) |
| 어드민 토글 | `src/slack/commands/sandbox-handler.ts` · `user-settings-store.ts` | `sandboxDisabled`는 비상용으로만. 켜진 세션은 스레드에 경고 한 줄 |
| ssh 금지 | `tool-policy.ts` 2단계 | 어드민 면제를 없앤다 → Lean ToolPolicy 모델 변경 (PR2) |
| 환경 도구 | `packages/mcp-servers/server-tools/server-tools-mcp-server.ts` · `env-github.ts` · `env-audit.ts` | 환경 절에 `envUser` · `github` · `web` · `cloudflare` 추가, 도구 `ssh_exec` · `gh_pr`(WU3a: view·approve·merge, head SHA 고정) · `login`(WU3b: `web.logins` → 세션만, `env-login.ts`) · `cf_*` 추가, 감사 원장 `DATA_DIR/env-audit/env-audit.jsonl`(쓰기 전 의도 → 결과, 의도를 못 쓰면 실행 안 함) |
| 환경 사용자 | `config.json` server-tools 환경 절의 `envUser: "env:<org>-dev2"` + 스킬 저장소 `DATA_DIR/env-users/<id>/skills/` | 환경 하나 = 설정 한 절. 스킬은 `$env:<id>:<skill>` |
| 환경 grant | `src/user-skill-grants-store.ts` (예약 소유자 `env-skills` → 환경 사용자 ID로 일반화) · `src/slack/env-skill-permission-*.ts` · `src/slack/actions/env-skill-permission-action-handler.ts` | 4버튼(수락 · 거절 · 이 스킬 항상 · 이 환경 전체 항상), 저장 하나 |
| 환경 grant 정책 단계 | `tool-policy.ts` (6d 옆, 추가형) | 비어드민의 `mcp__server-tools__*` 호출 → 그 `server` 인자의 환경 사용자 grant 확인. github MCP 쓰기 도구도 grant 필요. Lean 추가형 단계 + Proofs |
| 브로커 제거 | `packages/devops-broker/`, `packages/mcp-servers/devops-tools/`, 설치 스크립트, `.github/workflows/deploy.yml`의 브로커 단계, `mcp-config-builder.ts`의 devops-tools 등록 | 삭제. 브로커 토큰·포지키는 운영자가 `secrets/`로 옮긴다 |

## 3. 환경 사용자 설정 (예 — 값은 자리표시자)

```json
"server-tools": {
  "dev2": {
    "envUser": "env:acme-dev2",
    "skills": ["acme-env:deploy-dev2", "acme-env:qa-dev2"],
    "ssh": { "host": "dev2" },
    "databases": { "app": { "type": "mysql", "host": "127.0.0.1", "port": 3306, "user": "app", "password": { "$secret": "dev2-db-app" } } },
    "github": {
      "repos": ["acme/app"],
      "token": { "$secret": "gh-org-admin" },
      "approveWhen": { "authors": ["bot-app[bot]"], "bases": ["develop"] },
      "mergeWhen": { "authors": ["bot-app[bot]"], "bases": ["develop", "deploy/dev2"] },
      "mergeMethods": ["merge"]
    },
    "web": {
      "domains": ["app.example.test", "bo.app.example.test"],
      "accounts": { "player": { "$secret": "dev2-player" } },
      "login": { "player": { "url": "https://app.example.test/api/login", "tokenFrom": "json:$.token" } }
    }
  }
}
```

## 4. 요청 흐름

1. 비어드민 U가 dev2 배포를 요청 → 모델이 `$env:acme-dev2:deploy` 스킬 또는 `server-tools` 환경 도구를 부른다.
2. 정책: U는 어드민이 아니고 `env:acme-dev2` grant가 없다 → 거부, 어드민에게 4버튼 카드(기존 환경 스킬 요청 흐름 재사용).
3. 어드민이 "이 유저에게 이 환경 전체 항상" → grant 기록 → U의 턴을 다시 보낸다.
4. 이번 턴: 샌드박스에 dev2 도메인·작업 폴더가 더해진다. 스킬 절차대로 진행하고, 승인·머지·로그인·로그는 환경 도구가 한다.
5. 다음 요청부터 카드 없음. 어드민과 어드민 크론은 처음부터 카드 없음.

## 5. 작업 단위 (= 에픽의 서브이슈, PR 하나씩)

| WU | 내용 | 파일 소유 | 끝상태 확인 |
|---|---|---|---|
| WU0 | `.prd/env-access` (이 문서들) | `.prd/` | 머지 |
| WU1 | 비밀 저장소 + 정책 1b 확장 + 공통 `denyRead`·`denyWrite` + `failIfUnavailable: true` + server-tools `$secret` 해석 | env-paths · secret-ref · devops-secret-guard · build-stream-options · server-tools 설정 로더 | 일반·어드민(토글 켠 채) 세션 모두 비밀 경로 거부, 봇 정상 부팅, `$secret` DB 조회 성공 |
| WU2 | 어드민 샌드박스 프로필 + ssh 금지 전원 + `~/.ssh` 읽기 금지 + `ssh_exec` | build-stream-options · sandbox-handler · tool-policy 2단계(+Lean) · server-tools | 어드민 세션 gh·git push·Playwright 동작, `ssh` 거부, `ssh_exec` 결과 |
| WU3 | 환경 사용자 + 환경 도구 `gh` · `login` + 감사 원장 + org-admin 토큰 `secrets/` | server-tools · 스킬 저장소 · skill-force-handler(`$env:`) | `gh`로 봇 PR 승인(조건 충족 시만) · 머지, `login` 세션으로 환경 API 200 |
| WU4 | 환경 grant 단일화 + 4버튼 + 정책 단계(+Lean) + github MCP 쓰기 gate + 기존 grant 이관 + `deploySandbox` 계산화 | grants store · env-skill-permission-* · tool-policy · build-stream-options | 비어드민 카드 1장 → "환경 전체 항상" → 다음 카드 0장 |
| WU5 | 배포·QA 스킬을 환경 사용자로 이전, 배포 진입점 하나, 배포 → QA 연결 복구, 환경 계정 `secrets/` | 고객 스킬 레포 · 배포 워크플로 프롬프트 | QA 없는 dev2 배포 0건, 비밀번호 노출 0 |
| WU6 | 브로커 제거 (`cf_*`를 server-tools로 옮긴 뒤) | devops-broker · devops-tools · deploy.yml · 문서 | 정기 작업 봇 PR 승인 카드 0장, 배포 번들 하나 |

의존: WU1 → WU2 · WU3 → WU4 → WU5, WU6은 WU3(gh) · `cf_*` 이관 뒤.

## 6. 게이트 (build facts)

`npx tsc --noEmit` · `npx vitest run <바뀐 파일의 테스트>` (부하 시 `--pool=forks --maxWorkers=1 --testTimeout=30000`) · `npm run build` ·
Lean을 건드린 WU는 `npm run verify:lean` · PR CI + Sanitize Gate · 머지 전 trinity 리뷰 · `team-host` dev 배포 후 실측.
