---
name: setup-ai-workflow
description: "One-shot setup skill: pick a target repo and install the AI work-execution system — check gate (task runner), commit/PR conventions, worktree isolation policy, build/deploy/release runbook skills generated from the repo's actual CI/CD (deployment included), and optional issue/PR gates with a label-driven agent work queue. Generalized from 2lab-ai/llmux and 2lab-ai/herdr-mx. Triggered by: setup-ai-workflow <repo>, 'AI 워크플로우 셋업', 'agent 작업 체계 셋업'. Companion of setup-ai-docs (docs axis)."
---

# setup-ai-workflow — 대상 repo에 AI 작업·배포 체계를 1회 셋업

대상 repo 하나를 받아, AI 에이전트가 자율적으로 작업하고 배포까지 수행할 수
있는 체계를 만든다. 산출물은 대상 repo에 대한 **PR 1개** (+ 필요시 라벨/워크플로우).

일반화 원본: 2lab-ai/llmux (CD 런북 스킬 + agent triage/resolve/loop),
2lab-ai/herdr-mx (issue/pr 게이트 + 워크트리 격리 + check 게이트),
2lab-ai/soma-work (branch-push 배포 + TDD 게이트).

## Inputs — 인터뷰 필수 항목

repo에서 추론 가능한 것은 추론하고, 불가한 것만 유저에게 묻는다 (한 번에 묶어서):

- `repo` (필수)
- 배포 채널: preview/stable 분리? 배포 트리거(master push / tag / branch push /
  workflow_dispatch)? 배포 대상(brew tap, 서버 호스트, 컨테이너, 패키지 레지스트리)?
- 검증 방법: 배포 후 무엇을 확인하면 "성공"인가 (버전 명령, 헬스체크, 상태 명령)?
- 외부 기여 게이트가 필요한가 (공개 repo인가)?
- label 기반 agent 작업 큐를 원하는가?

## Step 1 — Survey: 기존 체계 인벤토리

```bash
ls .github/workflows/          # CI/CD 현황
cat justfile Makefile package.json 2>/dev/null | head -50   # task runner
ls .claude/skills/ .claude/rules/ 2>/dev/null
cat CLAUDE.md AGENTS.md 2>/dev/null
gh label list --repo <repo>
```

이미 있는 것을 파괴하지 않는다 — 빈 곳만 채우고, 충돌하면 기존 규칙을 따른다.

## Step 2 — 체크 게이트 (task runner)

단일 명령으로 "커밋 가능 상태"를 판정하는 게이트를 만든다/확인한다:

- Rust: `just check` = `fmt --check` + `clippy -D warnings` + `nextest` (herdr/llmux 패턴)
- Node: `npm run check` = `tsc --noEmit` + lint + `vitest run` (soma-work 패턴)
- 진입 문서에 명시: "**check green before every commit.** 우회 금지 — 실패를
  고치거나, 왜 더 좁은 검증으로 충분한지 설명하라." (herdr 문구)

## Step 3 — 컨벤션 + 워크트리 격리 정책 (진입 문서에 기록)

- 커밋: conventional commits, lowercase 여부, emoji 정책, co-author 정책 —
  **repo 기존 히스토리를 보고 맞춘다** (`git log --oneline -20`)
- 멀티에이전트 격리 (herdr 패턴):
  - 읽기 조사는 공유 체크아웃, 작은 수정은 main 워크트리 허용
  - 큰 작업은 전용 워크트리 `../<repo>-worktrees/<task-slug>`, 브랜치
    `issue/<id>-<slug>`
  - 통합은 공유 체크아웃 fast-forward → push; 작업 후 워크트리/브랜치 제거

## Step 4 — CD 런북 스킬 생성 (배포 포함, llmux 패턴)

`.claude/skills/`에 intent-트리거 런북을 만든다. 공통 절차는
`_shared/cd-reference.md`로 뽑고 각 스킬은 얇게:

- **build** (빌드) — 로컬 빌드 → (해당 시) 로컬 hot-deploy → 커밋 → feature
  branch push. master 직행 금지.
- **deploy** (배포/"배포해줘") — preview 채널: master push → CI preview 빌드
  watch (`gh run watch --exit-status`) → 아티팩트/포뮬러 갱신 → **검증 루프**
  (버전/상태 확인) → 보고
- **release** (릴리즈) — 버전 bump(유저와 함께 결정) → `v*` tag → CI stable
  release → 배포 대상 갱신 → 검증 → 보고

각 스킬에 반드시 포함: **결정 지점 표기**(*(Decision point.)*), 검증 명령,
**Common mistakes 섹션**, 그리고 repo 고유의 **load-bearing facts**
(예: "tag ≠ Cargo.toml 버전이면 release 실패", "tap은 auto-bump 안 됨").
Step 1 인터뷰에서 얻은 실제 배포 채널 사실로 채운다 — 템플릿 문장을 남기지 마라.

CD 워크플로우가 아예 없으면 llmux preview.yml 패턴(master push → prerelease
`preview-<timestamp>-<sha>` + SHA256SUMS)을 제안하되, CI 작성은 유저 승인 후.

## Step 5 — 이슈/PR 게이트 (공개 repo면, herdr 패턴)

- `issue-gate.yml`: 템플릿 필수 섹션 미충족 이슈 자동 클로즈 (+ 안내 코멘트)
- `pr-gate.yml` (`pull_request_target`): 승인된 기여자만 PR 유지, bot 스킵
- `approve-contributor.yml`: 메인테이너가 라벨/코멘트로 기여자 승인
- 필요 시크릿(bot 토큰)은 유저에게 요청 — 추측 금지

## Step 6 — label 기반 agent 작업 큐 (옵션, llmux 패턴)

원하면 3-스킬 세트를 repo에 설치:

- **agent-triage** — 이슈를 평가해 label을 붙인다: `ready-to-agent` /
  `needs-design` / `needs-human` / `not-in-repo` / `agent-blocked`.
  ready면 draft PR 오픈. **label이 agent의 메모리다** — 이미 라벨된 이슈는
  재평가하지 않는다.
- **agent-resolve** — ready draft PR 하나를 전용 워크트리에서 구현, check +
  CI green까지. 머지/배포는 하지 않는다 (인간 경계).
- **agent-loop** — triage → resolve 반복 오케스트레이터. dry-run 기본,
  `--apply`로 실행. 정지 조건: 큐 소진 / max-iterations(기본 3) / 연속 2회
  blocked / kill-switch(needs-human, security, release).

## Step 7 — Verify + PR

- check 게이트 green 상태로 PR 1개: 진입 문서 + 스킬들 + (승인된 경우)
  워크플로우 파일. `.github/workflows/`는 bot 토큰으로 push 불가할 수 있다 —
  gh CLI 사용자 토큰 경로로 우회.
- PR 본문: 인터뷰에서 확정한 배포 채널 사실, 설치한 게이트 목록, 남은 수동
  단계 (시크릿 등록, 라벨 생성, 브랜치 보호 규칙).
- 마지막에 `setup-ai-docs`를 아직 안 돌렸으면 함께 돌릴 것을 제안한다 —
  두 축이 모여야 완전한 셋업이다.

## Common mistakes

- 배포 사실을 인터뷰 없이 추측해서 런북에 박는 것 — 런북의 거짓 한 줄이
  실제 배포 사고가 된다. 모르면 물어라.
- 기존 justfile/CI를 무시하고 새 체계를 얹는 것 — 있는 것을 따르고 빈 곳만 채워라.
- agent-resolve에 머지/배포 권한을 주는 것 — 리뷰 게이트 없는 자율 배포는
  사고 경로다 (soma-work 2026-06-23 dev2 outage 교훈).
- `pull_request_target`에서 체크아웃한 PR 코드를 실행하는 것 — 시크릿 유출 벡터.
