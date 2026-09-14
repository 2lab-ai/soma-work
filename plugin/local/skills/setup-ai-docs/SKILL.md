---
name: setup-ai-docs
description: "One-shot setup skill: pick a target repo and install the docs-sync system so docs and README stay in sync with the code on every future task. Audits doc claims against code (drift table), fixes drift, sets up CLAUDE.md/AGENTS.md agent entry docs, adds a mandatory Documentation Sync completion gate, and installs a repo-local update-docs skill that auto-triggers on task completion. Triggered by: setup-ai-docs <repo>, 'docs 셋업', 'setup docs sync', '문서 체계 셋업'. Companion of setup-ai-workflow (work/deploy axis)."
---

# setup-ai-docs — 대상 repo에 문서 동기화 체계를 1회 셋업

대상 repo 하나를 받아, 이후 모든 작업에서 문서가 코드와 함께 자동 업데이트되는
체계를 만든다. 산출물은 대상 repo에 대한 **PR 1개**.

원본 사례: 2lab-ai/soma-work PR #1186. 참조 패턴: llmux(CLAUDE.md 포인터 +
load-bearing facts), herdr-mx(CLAUDE.md == AGENTS.md 단일 소스).

## Inputs

- `repo` (필수) — 대상 repo (`org/name` 또는 URL). 없으면 유저에게 묻는다.
- 작업 폴더에 새로 clone 한다 (기존 체크아웃 재사용 금지 — 격리).

## Step 1 — Survey: 주장 vs 실제 대조표

문서 표면 전수 나열: `README.md`(+ 다국어 변형), `CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `docs/` 전체. 그다음 문서의 모든 **사실 주장**을 코드에 대조:

- 숫자 카운트("핸들러 N개") → 실제 디렉토리 카운트
- 파일/디렉토리 경로 → 실제 존재 (`ls`, `rg`)
- 기능 상태 주장("X 지원") → 해당 코드에 TODO/placeholder/stub 없는지.
  코드가 TODO면 문서는 *(pending)*/*(partial)*
- 설치/실행 명령 → 참조 파일이 실제 그 경로에 있는지
- 다국어 README 페어 → 같은 세대인지

발견 drift를 표로 출력: `문서 주장 | 실제 | 판정`. drift는 4종이다:
**카운트 / 경로 / 과장(코드 TODO 대비) / 다국어 페어**.

## Step 2 — Fix: 수정 원칙

- 하드코딩 카운트 전부 제거 → "source of truth: <디렉토리>" 포인터로 교체
- 코드에 사는 사실(enum, allowlist, 명령 목록)은 복사 대신 코드 파일 링크
- 다국어 README는 같은 커밋에서 함께
- 기능 상태는 코드의 TODO 주석보다 좋게 쓰지 않는다
- 문서 이동/아카이브는 증거 기반으로만 (보수적으로)

## Step 3 — 진입 문서 정비 (CLAUDE.md / AGENTS.md)

repo에 진입 문서가 없거나 빈약하면 이 구조로 만든다 (있으면 이 구조로 보강):

- **AGENTS.md** = canonical: 아키텍처 원칙(불변식 위주 5–10개), 컨벤션
  (커밋 스타일, co-author 정책), 커밋 전 check 게이트 명령
- **CLAUDE.md** = 얇은 포인터: "Read AGENTS.md first" + 런북/스킬 인덱스 +
  **load-bearing facts** (다시 배우면 비싼 gotcha만; llmux 패턴)
- 단일 파일을 원하면 herdr 패턴: 동일 내용을 CLAUDE.md와 AGENTS.md 양쪽에
  (심링크는 도구 호환성 확인 후)

## Step 4 — 완료 게이트: "Documentation Sync (Required)" 섹션

CLAUDE.md(또는 AGENTS.md)에 추가:

1. 작업은 코드 + 테스트 + 문서가 모두 맞아야 완료다.
2. 커밋/PR 전에 `.claude/skills/update-docs` 스킬로 drift를 점검한다.
3. 영향받는 문서 표면은 **같은 PR에서** 업데이트한다. 문서 소유권 맵을
   표로 명시 (README → 기능/구조/설치, CLAUDE.md → agent 규칙, docs/ → 라우팅).
4. 영향 없으면 PR 본문에 `docs: no impact` 명시 — 점검 생략과 무영향은 다르다.
5. 하드코딩 카운트 금지.

## Step 5 — repo-local update-docs 스킬 설치

`.claude/skills/update-docs/SKILL.md` 생성. frontmatter description에 자동
트리거를 박는다: "이 repo에서 작업을 완료할 때마다 — 커밋·PR 전에 자동 사용".
본문: 문서 소유권 맵(표) / drift 체크 절차(`git diff --stat` → 문서 표면 `rg`
→ 구조 주장 `ls` 검증 → 옛 경로 잔존 `rg` → 로컬 md 링크 resolve) / 규칙
(no-counts, 다국어 페어, same-PR, SSOT 포인터) / 완료 체크리스트.

**gitignore 함정**: `.gitignore`에 `.claude/`(디렉토리 제외)가 있으면
`!.claude/skills/` 재포함이 죽은 규칙이 된다 — git은 제외된 디렉토리 안으로
내려가지 않는다. `.claude/*`로 바꾸고 negation을 유지하라. 커밋 후
`git check-ignore <스킬 경로>`가 exit 1인지 확인.

## Step 6 — Verify + PR

- `git diff --check` 통과
- 변경한 모든 md의 로컬 링크 resolve (pre-existing 깨짐은 고치지 말고 PR에 플래그)
- **새로 쓴 문서도 리뷰 게이트에 통과시켜라** — 리뷰어(codex 등)에게 "문서 주장
  vs 코드 TODO 대조"를 명시적으로 시킨다. 문서를 고치면서 새 과장을 만드는 게
  가장 흔한 실수다.
- PR 1개: drift 수정 + 진입 문서 + 게이트 + 스킬 (+ 필요시 gitignore 픽스).
  본문에 drift 표, 수정 원칙, 미해결 이슈 플래그.

## Common mistakes

- 카운트를 "정확한 숫자로 고치는" 것 — 고치지 말고 제거하라. 다음 달에 또 썩는다.
- 영문만 고치고 다국어 변형을 잊는 것 (또는 그 반대)
- 문서 정리 김에 활성 spec을 아카이브로 옮기는 것 — 증거 없으면 두라
- update-docs 스킬만 만들고 CLAUDE.md 게이트를 안 다는 것 — 강제성 없는 절차는 죽는다
