# zworkflow — soma-work default plugin (CLAUDE.md)

`src/local/` **그 자체가 하나의 Claude Code 플러그인**이다 (`zworkflow`).
`.claude-plugin/plugin.json`이 매니페스트고, 마켓플레이스(`/.claude-plugin/marketplace.json`)가
`source: ./src/local`로 이 디렉터리를 가리킨다. 안에 든 agents / commands / hooks / prompts /
skills는 전부 플러그인 페이로드다.

## ⚠️ 규칙: soma-work 하네스 호출은 여기 넣지 마라

zworkflow는 마켓플레이스로 외부에 배포되어 soma-work 없는 Claude Code에서도 돈다. 세션 작업 카드
호출(`GET_SESSION` · `UPDATE_SESSION`)은 soma-work 전용 플러그인 `local`(`src/local-harness/`)에 넣고,
거기서 이 플러그인의 스킬을 감싼다 (예: `local:auto-es`가 `es`를 부른다).
`src/plugin/__tests__/harness-plugin.test.ts`가 이 경계를 지킨다 (#857). 아직 남아 있는 다른 model-command
호출(`ASK_USER_QUESTION`, `CONTINUE_SESSION`, cron)을 옮기는 일은 #860이다 — 새로 늘리지 마라.

## ⚠️ 규칙: 내용을 바꾸면 플러그인 버전을 올려라

`src/local/` 아래의 **무엇이든** (hook, skill, command, agent, prompt, 이 CLAUDE.md 포함) 수정/추가/삭제하면,
같은 커밋에서 반드시 `.claude-plugin/plugin.json`의 `version`을 올려라 (SemVer):

- **patch** (`1.0.0` → `1.0.1`): 버그 수정, 문구/룰 보강
- **minor** (`1.0.x` → `1.1.0`): skill·command·hook 추가 등 하위호환 기능 추가
- **major** (`x` → `x+1.0.0`): 기존 동작을 깨는 변경

### 왜

플러그인 업데이트 자체는 git commit SHA로 감지되므로(`src/plugin/plugin-manager.ts` 참고)
버전을 안 올려도 코드는 전파된다. 하지만 `version` 필드는 업데이트 리포트에
`oldVersion → newVersion`으로 노출되는 **사람용 시맨틱 버전**이다. 안 올리면
내용이 바뀌었는데도 리포트가 `1.0.0 → 1.0.0`으로 떠서, 무엇이 언제 바뀌었는지
추적이 불가능해진다. 플러그인의 버전은 그 플러그인 내용물의 버전이다 — 따로 논다고
방치하지 마라.

> 한 줄 요약: **`src/local/` 건드렸으면 `plugin.json` version도 같은 커밋에서 올린다.**

## 벤더링 규약 — 외부 스킬 들여오기

다른 저장소의 스킬을 이 플러그인에 넣을 때(`import-skills`가 따르는 규약). 선례: `apple-design`,
`dimensional-drawing`, `impeccable`. (`lottie`는 이 규약 이전 것이라 예외 — NOTICE에 원본 SHA가 없고 라이선스 전문이
NOTICE 안에 있다. 선례로 쓰지 않는다.)

1. **허락된 것만.** 그 스킬에 적용되는 라이선스가 허용형(MIT · ISC · BSD · Apache-2.0 등)이고 그 조건을 지킬 때만
   들여온다. 저장소 라이선스만 보지 말고 스킬 폴더 안의 LICENSE · NOTICE, 같이 가져올 파일의 라이선스도 본다.
   라이선스가 없거나(`NOASSERTION` 포함) GPL·AGPL·자체 조건이면 들여오지 않는다. 예외는 권리자의 재배포 허락이
   문서로 있을 때뿐이고, 그 링크를 NOTICE에 적는다 — 가져오는 사람이나 이 저장소 오너의 승낙은 허락이 아니다.
2. **원본 고정.** 후보를 볼 때 원본 commit SHA 하나를 정하고, 미리보기 · 라이선스 판정 · 가져오기를 모두 그 커밋으로
   한다. 브랜치 이름(`HEAD`, `main`)으로 가져오지 않는다.
3. **자리.** `skills/<name>/SKILL.md`. 이름이 기존 스킬과 겹치면 이름을 바꾼다 — 덮어쓰지 않는다.
   `local-harness`의 스킬 이름과도 겹치면 안 된다(`local:` 키가 둘 다 찾는다).
4. **frontmatter.** `name`, `description`(언제 쓰는지 + EN/KO 트리거), `version`(원본 버전, 없으면 `1.0.0`),
   `license`(라이선스 이름, SPDX 식별자 권장). 필요하면 `allowed-tools`. description은 매 턴 모든 사용자에게 붙는다 —
   짧게 쓰고, `src/__tests__/prompt-budget.test.ts`의 skills 예산을 넘으면 같은 PR에서 의도적으로 올린다.
5. **출처 기록.** `skills/<name>/LICENSES/NOTICE.md` — 원본 저장소 링크, 원본 commit SHA와 날짜, 라이선스 이름과
   저작권 줄, `## Local changes`(바꾼 것 목록). 같은 폴더에 원본 라이선스 전문 사본 — 파일 이름에 원본과 라이선스가
   드러나게(예: `emilkowalski-skills-MIT.txt`, `impeccable-Apache-2.0.txt`).
   원본에 NOTICE가 있으면 `upstream-NOTICE.md`로 함께 둔다.
6. **본문.** 원본 그대로가 기본이다. 바꾼 곳은 NOTICE의 Local changes에 적는다. 하네스 호출(`GET_SESSION` ·
   `UPDATE_SESSION`), 특정 머신 이름·개인 경로·자격증명은 넣지 않는다 — 원본에 있으면 빼고 Local changes에 적는다.
7. **딸린 파일.** 스킬 폴더의 다른 파일(`references/` · `scripts/` · `templates/` · `examples/` · 검사기 등)도 함께
   가져온다. 플랫폼 고정 경로가 있으면 고쳐서 가져오고, 고칠 수 없으면 그 파일을 쓰는 본문 지시도 같이 고친다 —
   본문이 없는 파일을 가리키게 두지 않는다. 그것도 안 되면 그 스킬은 들여오지 않는다. 빼거나 고친 것은 NOTICE의
   Local changes와 PR 본문에 적는다.
8. **계약 테스트.** `skills/<name>/__tests__/<name>-skill.test.ts` — SKILL.md와 frontmatter `name`, 본문의 핵심 규칙
   몇 개, `LICENSES/`에 NOTICE와 라이선스 사본이 있는지.
9. **버전.** 스킬 추가는 이 플러그인의 minor bump(위 규칙).
