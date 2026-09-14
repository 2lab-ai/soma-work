# local — soma-work bot-bound plugin (CLAUDE.md)

`plugin/local/` **그 자체가 하나의 Claude Code 플러그인**이다 (`local`).
`.claude-plugin/plugin.json`이 매니페스트고, 마켓플레이스(`/.claude-plugin/marketplace.json`)가
`source: ./plugin/local`로 이 디렉터리를 가리킨다. 안에 든 agents / commands / hooks / prompts /
skills는 전부 플러그인 페이로드다.

형제 플러그인 `core`(`plugin/core/`)가 하나 더 있다 — 봇 없이 아무 Claude Code 세션에서나
도는 skill·agent만 모아둔 쪽이다. 둘의 경계는 **"애매하면 local"**: 어떤 유닛이 soma-work MCP
서버·LLM 프록시·Slack 전달·hook 배선 중 하나라도 필요로 하면 여기 남는다. 그 경계는
`src/__tests__/core-plugin-closure.test.ts`가 기계로 집행한다 — 유닛을 `core`로 올리려면
그 테스트의 기대 목록을 같이 고쳐야 한다.

## ⚠️ 규칙: 내용을 바꾸면 플러그인 버전을 올려라

`plugin/local/` 아래의 **무엇이든** (hook, skill, command, agent, prompt, 이 CLAUDE.md 포함) 수정/추가/삭제하면,
같은 커밋에서 반드시 `.claude-plugin/plugin.json`의 `version`을 올려라 (SemVer):

- **patch** (`1.0.0` → `1.0.1`): 버그 수정, 문구/룰 보강
- **minor** (`1.0.x` → `1.1.0`): skill·command·hook 추가 등 하위호환 기능 추가
- **major** (`x` → `x+1.0.0`): 기존 동작을 깨는 변경

`plugin/core/`를 고쳤으면 올려야 할 건 그쪽 `plugin.json`이다 — 두 플러그인의 버전은 따로 논다.

### 왜

플러그인 업데이트 자체는 git commit SHA로 감지되므로(`src/plugin/plugin-manager.ts` 참고)
버전을 안 올려도 코드는 전파된다. 하지만 `version` 필드는 업데이트 리포트에
`oldVersion → newVersion`으로 노출되는 **사람용 시맨틱 버전**이다. 안 올리면
내용이 바뀌었는데도 리포트가 `1.0.0 → 1.0.0`으로 떠서, 무엇이 언제 바뀌었는지
추적이 불가능해진다. 플러그인의 버전은 그 플러그인 내용물의 버전이다 — 따로 논다고
방치하지 마라.

> 한 줄 요약: **`plugin/local/` 건드렸으면 `plugin.json` version도 같은 커밋에서 올린다.**
