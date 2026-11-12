# loop — env-access 구현 드라이브

Status: in-progress (라운드 1 = 설계 문서 + 에픽) · AS-IS = [`../23-env-access-as-is.md`](../23-env-access-as-is.md) ·
TO-BE = [`../24-env-access-to-be.md`](../24-env-access-to-be.md) · 아키텍처 = [`../25-env-access-architecture.md`](../25-env-access-architecture.md) ·
ssot = [`ssot.md`](ssot.md)

## 라운드 1 — 설계 문서 · 에픽 · WU1 착수 (2026-11-12 열림)

계획: WU0(이 문서들)을 PR로 올린다 → 에픽 #1207과 서브이슈 #1208–#1214 (만듦, 2026-11-12) → WU1부터 PR 하나씩.

| ID | WU | Status | 이슈 | 브랜치 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|---|
| WU0 | 설계 문서 | 🟡 | #1208 | `docs/env-access-prd` | `.prd/23-25`, `.prd/env-access/` | PR 머지 |
| WU1 | 비밀 저장소 + 전원 거부 + fail-closed 샌드박스 | 🟡 | #1209 | `feat/env-access-secrets` (PR #1218, trinity 만장일치 승인 2026-11-12) | 25 §5 WU1 | 25 §5 WU1 + dev 실측 |
| WU2 | 어드민 샌드박스 프로필 + 어드민 쓰기 경계 + ssh는 MCP로만 | 🟡 | #1210 | `feat/env-access-admin-sandbox` | 25 §5 WU2 + #1218 리뷰가 넘긴 두 길(`sandbox off` Bash, 배포 설정 쓰기) | 25 §5 WU2 + 두 길의 적대적 테스트 |
| WU3 | 환경 사용자 + 환경 도구 `gh` · `login` | 🔴 | #1211 | — | 25 §5 WU3 | 25 §5 WU3 |
| WU4 | 환경 grant + 4버튼 + 정책 단계 | 🔴 | #1212 | — | 25 §5 WU4 | 25 §5 WU4 |
| WU5 | 배포·QA 스킬 이전 + 배포 → QA 연결 | 🔴 | #1213 | — | 25 §5 WU5 | 25 §5 WU5 |
| WU6 | 브로커 제거 | 🔴 | #1214 | — | 25 §5 WU6 | 25 §5 WU6 |

## 열린 질문

| ID | 질문 | Status | 기본값 |
|---|---|---|---|
| Q1 | 컨테이너 배포처럼 샌드박스를 띄울 수 없는 호스트에서 `failIfUnavailable: true`를 어떻게 다룰지 | 🟡 | WU1에서 배포 대상 호스트별로 샌드박스 가능 여부를 실측하고, 불가한 곳은 배포 설정으로 명시적으로 끄게 한다(조용한 fail-open 금지) |
| Q2 | 고객 레포 배포 브랜치에 PR 승인 규칙을 걸지 (24 §6 남는 위험) | 🚪 | 어드민 결정 대기. 이번 스코프 밖 |

## 게이트 (build facts — WU1에서 실측해 갱신)

25 §6.

- **출시 게이트 (PR #1218 리뷰 R4, 2026-11-12):** 실제 비밀은 WU2(#1210)가 배포되고 그 적대적 테스트가 통과한 뒤에
  `secrets/`로 옮긴다. 그 전에는 어드민이 샌드박스를 끈 세션의 Bash, 어드민 모델이 배포 설정을 고쳐 참조를 돌리는 길이 남아 있다.

- **WU2 리뷰가 남긴 후속 (PR #1240):**
  - stdio MCP 런처(`npx`·`uvx`)가 세션 작업 디렉터리에서 떠서, 모델이 쓸 수 있는 프로젝트 설정(`.npmrc` 등)을 읽는다.
    #1240 이전부터 있던 구멍이다 → #1241. 캐시를 `options.env`로 옮기는 고침은 같은 구멍을 넓히므로 쓰지 않는다(astra R2).
  - 샌드박스 세션의 모델에게 "홈 캐시는 읽기 전용, 설치는 `--cache /tmp/{uid}/npm`"을 알리는 프롬프트 한 줄(fable R3 P2).
    지금은 CLI의 Bash 도구 설명에 나오는 샌드박스 쓰기 목록으로만 알 수 있다.
  - `ssh_exec`를 비동기 `spawn`으로(review-of-legends R4 P2). 지금은 server-tools의 `logs`처럼 `spawnSync`라서,
    최대 600초 동안 그 세션의 다른 server-tools 호출이 멈춘다(server-tools는 세션마다 따로 뜨는 stdio 자식이다).
  - 쓰기 보호·자격 파일 읽기 금지는 CLI가 거부 규칙을 훅보다 먼저 적용한다는 사실에 기댄다(spec 07 §6a-2, 실측 2.1.321).
    CLI를 올릴 때마다 `scripts/verification/probe-cli-deny-before-hooks.mjs`를 다시 돌린다.

## 다음 착수점

WU0 · WU1 머지 → dev 배포 · 실측 → WU2(#1210) 브랜치 `feat/env-access-admin-sandbox` → 머지 · dev 실측 → WU3(#1211).
