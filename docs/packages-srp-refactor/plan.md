# Packages × SRP Refactor — Plan

## 1. Target state

```
soma-work/
├── package.json                     # workspaces: ["packages/*"]
└── packages/
    ├── common/         @soma/common         pure utils, logger, paths, formatters
    ├── extensions/     @soma/extensions     prompts, personas, local skills, plugins, model-commands
    ├── integrations/   @soma/integrations   github, oauth, a2t, notification-channels, credentials
    ├── metrics/        @soma/metrics        usage accounting, model registry, render assets
    ├── mcp/            @soma/mcp            MCP config + manager + 5 internal MCP servers
    ├── core/           @soma/core           runtime: sessions, Claude SDK, dispatch, auth, hooks
    ├── sdk/            @soma/sdk            stable embedder facade over core
    ├── slack/          @soma/slack          @slack/bolt UI: events, commands, actions, Block Kit
    ├── app/            @soma/app            process bootstrap, deploy, cron, multi-agent host
    └── test-utils/     @soma/test-utils     shared test factories & mocks
```

**왜 9 + 1인가:** gemini-cli의 7개(core / cli / sdk / a2a-server / devtools / test-utils / vscode-ide-companion)와 같은 단위 시계열. soma-work는 Slack-host라는 한 가지 surface만 갖지만 그 surface가 무겁기 때문에 `core ↔ slack` 사이에 `integrations` / `metrics` / `mcp` / `extensions` 4개를 끼워 core를 framework-agnostic으로 유지한다.

## 2. Package responsibilities + moves

| Package | Responsibility (1줄) | Allowed upstream | 이동 대상 (src/ + root files) |
|---|---|---|---|
| `@soma/common` | 순수 유틸·로깅·경로·포맷터. UI/IO/Slack 의존 0. | (없음) | `src/util`, `src/utils`, `src/format`, `logger.ts`, `env-paths.ts`, `path-utils.ts`, `config-env-substitution.ts`, `dangerous-command-filter.ts`, `sensitive-path-filter.ts`, `webhook-url-validator.ts` |
| `@soma/extensions` | 프롬프트·페르소나·로컬 스킬·플러그인·model-command 카탈로그 | `common` | `src/prompt`, `src/persona`, `src/local`, `src/plugin`, `user-skill-store.ts`, `prompt-cache-invalidation.ts`, `somalib/model-commands` → 흡수 |
| `@soma/integrations` | Slack 외 외부 서비스 어댑터 (GitHub, OAuth, A2T, 알림 채널) | `common` | `src/github`, `src/oauth`, `src/a2t`, `src/notification-channels`, `github-auth.ts`, `credentials-manager.ts`, `credential-alert.ts`, `link-metadata-fetcher.ts` |
| `@soma/metrics` | 사용량 집계·모델 레지스트리·리포트·렌더 에셋(PNG) | `common` | `src/metrics` (10M, PNG 에셋 포함), `claude-status-fetcher.ts` |
| `@soma/mcp` | MCP config·manager·5개 내부 MCP 서버 | `common`, `extensions`, `integrations` | `src/mcp`, `mcp-servers/` (workspace로 흡수), `mcp-manager.ts`, `mcp-config-builder.ts`, `mcp-call-tracker.ts`, `mcp-tool-grant-store.ts`, `mcp-tool-permission-config.ts` |
| `@soma/core` | Framework-agnostic 어시스턴트 런타임. **`@slack/*` import 금지.** | `common`, `extensions`, `integrations`, `mcp`, `metrics` | `src/agent-session`, `src/session`, `src/conversation` (web UI 제외), `src/auth`, `src/hooks`, `src/cct-store`, `src/sandbox`, `claude-handler.ts`, `session-registry.ts`, `token-manager.ts`, `prompt-builder.ts`, `dispatch-service.ts`, `complexity-scorer.ts`, `todo-manager.ts`, `working-directory-manager.ts`, `user-memory-store.ts`, `user-settings-store.ts`, `types.ts`, `agent-instance.ts`, `agent-manager.ts` (런타임 부분만) |
| `@soma/sdk` | 외부/내부 embedder가 core를 안정 API로 쓰는 facade. legacy 코드 bulk 이동 없음, 신규 facade만. | `common`, `core`, `mcp` | (신규 파일만) |
| `@soma/slack` | Slack Bolt UI/어댑터, Block Kit, 명령어, 액션, 파일, Slack session surface | `common`, `core`, `sdk`, `integrations`, `metrics`, `extensions` | `src/slack` (3.9M), `slack-handler.ts`, `file-handler.ts`, `channel-registry.ts`, `channel-description-cache.ts`, `startup-notifier.ts`, `release-notifier.ts`, `turn-notifier.ts` |
| `@soma/app` | Process bootstrap, config 로드, cron, deploy, multi-agent host wiring | (모든 런타임 패키지) | `index.ts`, `config.ts`, `config-loader.ts`, `cron-scheduler.ts`, `agent-instance.ts`/`agent-manager.ts` (host wiring 부분), `src/deploy`, `src/conversation/web-server.ts`+`dashboard.ts`+`oauth.ts`, `release-notifier.ts` wiring |
| `@soma/test-utils` | 공유 테스트 fixture·mock | (모든 패키지, devDep 한정) | `src/test-utils` + 각 패키지에서 공통화 가능한 mock 추출 |

**`somalib/`의 운명:** 4 모듈을 분해해서 흡수.
- `cron/` → `@soma/app` (cron-scheduler가 쓰는 storage)
- `model-commands/` → `@soma/extensions`
- `permission/` → `@soma/mcp` (permission-mcp-server와 같은 위치)
- `stderr-logger.ts` → `@soma/common`

이행 끝나면 `somalib/` 디렉토리는 삭제. 마지막 페이즈 작업.

## 3. Dependency DAG

```
              ┌────────────────────────────────────────┐
              │              @soma/app                 │
              │ index.ts · config · cron · deploy host │
              └───────────────┬────────────────────────┘
                              │ (depends on everything below)
   ┌──────────────────────────┼──────────────────────────┐
   ▼                          ▼                          ▼
┌─────────────┐   ┌─────────────────┐         ┌─────────────────┐
│ @soma/slack │   │   @soma/sdk     │         │  (host other    │
│ (UI/IO)     │──▶│ (facade)        │         │   surfaces here │
└──────┬──────┘   └────────┬────────┘         │   in future)    │
       │                   │                  └─────────────────┘
       ▼                   ▼
       └────────────► @soma/core ◀───────────────┐
                          │                       │
        ┌─────────────────┼────────────────┐      │
        ▼                 ▼                ▼      │
  @soma/extensions   @soma/integrations  @soma/mcp│
        │                 │                │      │
        └─────────┬───────┴────────────────┘      │
                  ▼                               │
            @soma/metrics ──────────────────────►─┘
                  │
                  ▼
            @soma/common      (devDep only:) @soma/test-utils
```

### Hard rules

1. **`@soma/core` MUST NOT import `@slack/bolt`, `@slack/web-api`, `react`, `ink`, or any UI/IO surface lib.** (gemini-cli core/GEMINI.md과 같은 원칙.)
2. **Cross-package import는 항상 published name (`@soma/x`) + 그 패키지의 barrel `index.ts`로만.** 형제 패키지의 `src/...` 깊이 import 금지.
3. **`@soma/common` is sink — depends on nothing inside this repo.**
4. **`@soma/sdk`는 facade만.** 비즈니스 로직은 `core`에 있고, sdk는 안정된 named export 묶음. legacy 코드 옮기지 말 것.
5. **`@soma/test-utils`는 devDependency로만 노출.** runtime bundle에 들어가면 안 됨.

## 4. Migration phases

각 페이즈는 **PR-sized + runtime을 깨지 않음**. 이전 경로(`src/...`) 호환은 임시 re-export로 유지하고 마지막 페이즈에서 삭제.

### Phase 1 — `@soma/slack` (가장 먼저)

- 만들기: `packages/slack/`. `package.json`은 `dependencies`에 `@slack/bolt`, `@slack/web-api`, `markdown-to-slack-blocks` 옮기고 루트 `package.json`에서는 제거.
- 옮기기: `src/slack/`, `slack-handler.ts`, `file-handler.ts`, `channel-registry.ts`, `channel-description-cache.ts`, `startup-notifier.ts`, `release-notifier.ts`, `turn-notifier.ts`.
- Barrel: `packages/slack/src/index.ts`에서 외부가 쓰던 export만 named로 노출.
- 호환: 옮긴 파일의 옛 경로(`src/slack-handler.ts` 등)는 한 줄 re-export로 stub: `export * from '@soma/slack/slack-handler';`. 한 페이즈만 유지하다 삭제.
- 결과: **@slack/bolt가 core에 직접 import되어 있던 라인이 컴파일 에러로 폭로된다.** 이것이 이 페이즈의 진짜 산출물. 노출된 누수는 같은 PR 안에서 `core` 쪽이 callback/interface로 받도록 inversion한다.
- Acceptance: `npm run check && npx vitest run` 통과. `grep -r '@slack/' packages/core/src` 0건.

### Phase 2 — `@soma/common` + `@soma/extensions` + `@soma/test-utils`

- 의존 sink부터. 순수 모듈을 분리하면 다른 페이즈의 import 경로가 깔끔해진다.
- `@soma/common`: `src/util`, `src/utils`, `src/format`, `logger.ts`, `env-paths.ts`, `path-utils.ts`, 각종 filter/validator.
- `@soma/extensions`: `src/prompt`, `src/persona`, `src/local`, `src/plugin`, `user-skill-store.ts`, `somalib/model-commands/*`. **여기서 `.prompt` 파일 에셋 처리가 등장 (§7 참고).**
- `@soma/test-utils`: `src/test-utils` + 패키지별 vitest setup 공통화.
- Acceptance: `@soma/core` 미존재 상태로도 위 3개 패키지의 `npm run typecheck` 단독 성공.

### Phase 3 — `@soma/integrations` + `@soma/metrics`

- `@soma/integrations`: `src/github`, `src/oauth`, `src/a2t`, `src/notification-channels`, `github-auth.ts`, `credentials-manager.ts`, `credential-alert.ts`, `link-metadata-fetcher.ts`.
- `@soma/metrics`: `src/metrics` (PNG asset 포함). **여기서 `src/metrics/usage-render/assets`의 운명 결정 (§7).**
- Acceptance: 두 패키지 단독 typecheck + 자체 vitest 통과. Slack 패키지가 `import { ... } from '@soma/metrics'` 로 갈아끼워짐.

### Phase 4 — `@soma/mcp`

- `mcp-servers/` 디렉토리를 `packages/mcp/servers/`로 흡수, workspace 등록.
- `src/mcp`, `mcp-manager.ts`, `mcp-config-builder.ts`, `mcp-call-tracker.ts`, `mcp-tool-*` 이동.
- `somalib/permission/*` 흡수.
- **이미 진행 중인 `docs/mcp-refactor` / `docs/mcp-server-independence` 작업은 이 페이즈와 같은 PR 트랙으로 합친다.** 두 갈래로 가지 않게.
- Acceptance: `mcp-servers/`에서 `../../src/`로 가던 import 0건 (이미 mcp-server-independence의 acceptance criterion).

### Phase 5 — `@soma/core`

- 가장 묵직한 페이즈. 큰 파일 4개(`session-registry.ts` 76K, `token-manager.ts` 96K, `claude-handler.ts` 52K, `prompt-builder.ts` 20K)가 core 안으로 들어간다.
- 이 페이즈에서 **파일을 쪼개지 않는다.** 단순 이동 + barrel만. 분할은 별도 트랙(`docs/architecture.md`이 이미 facade 분해 진행 중).
- 의존성 검증: `npm run check && depcruise packages` 로 cross-package relative import 0건 보장.
- Acceptance: `packages/core`만으로 `npm run build -w @soma/core` 성공.

### Phase 6 — `@soma/sdk` + `@soma/app` + cleanup

- `@soma/sdk`: core의 가장 안정된 표면을 명시적 named export로 묶는 thin facade. 신규 파일만, 옮기는 것 없음.
- `@soma/app`: `index.ts`, `config.ts`, `config-loader.ts`, `cron-scheduler.ts`, `agent-instance.ts`/`agent-manager.ts` (host wiring), `src/deploy`, conversation의 web UI 파일.
- `somalib/` 디렉토리 삭제 (모든 모듈 흡수 완료).
- 1~5단계에서 남겨둔 src/* re-export stub 일괄 삭제.
- 루트 `package.json`의 dependencies는 거의 비어야 함 (대부분 패키지로 이동). 빌드 스크립트는 `npm run build --workspaces`로 단순화.
- Acceptance: `find src -type f | wc -l` = 0. `npm run prod` (또는 그 후속) 정상 부팅.

## 5. Barrel exports policy

gemini-cli의 [`packages/core/src/index.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/index.ts)는 named export로 표면을 직접 큐레이션한다. 같은 원칙:

```ts
// packages/core/src/index.ts — 좋은 예시
export { SessionRegistry, type SessionId } from './session/registry';
export { TokenManager } from './token/manager';
export { dispatchWorkflow, type Workflow } from './dispatch/service';
// ❌ 금지: export * from './internal/foo';  // 내부 유출 방지
// ❌ 금지: export { ClaudeUsageRaw } from './claude-handler';  // 외부에 쓸 일 없는 internal
```

규칙:
- `export *`는 같은 패키지 내부 합산 barrel(서브폴더 → 패키지 barrel)에서만 허용. **패키지 밖으로 내보낼 때는 named 전용.**
- 타입은 `export type { ... }` 명시.
- 새 export를 barrel에 추가하면 PR 설명에 "why public" 한 줄 명시. 이 룰이 표면 비대화를 막는다.

## 6. Lint enforcement under biome

**결정: dependency-cruiser**를 `npm run check`에 추가. (biome의 `noRestrictedImports`로는 패키지 경계 그래프 룰을 표현 못 함 — codex 검증 완료, `references.md` 참고.)

루트에 `.dependency-cruiser.cjs`:

```js
module.exports = {
  forbidden: [{
    name: "no-cross-package-relative",
    severity: "error",
    from: { path: "^packages/([^/]+)/src/" },
    to: {
      path: "^packages/([^/]+)/src/",
      pathNot: "^packages/$1/src/",
      dependencyTypes: ["local"]
    }
  }],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    exclude: "^(.*/)?(node_modules|dist)/"
  },
};
```

`package.json#scripts.check`:
```json
"check": "biome check src/ somalib/ scripts/ && depcruise packages --validate .dependency-cruiser.cjs"
```

이 룰은 **형제 패키지의 `src/`를 상대경로로 import하면 error**. `@soma/x`를 통해 published name으로 들어가야만 허용. 추가로 `core`가 `@slack/*`을 import하지 못하게 하는 룰도 같은 파일에 추가:

```js
{
  name: "core-must-not-import-slack",
  severity: "error",
  from: { path: "^packages/core/src/" },
  to: { dependencyTypes: ["npm"], path: "@slack/" }
}
```

## 7. Build pipeline 교체

### 현재 (루트 `package.json`)

```
"build": "npm run check && npm run build:somalib && tsc && cp -r src/prompt dist/ && cp -r src/persona dist/ && cp -r src/local dist/ && mkdir -p dist/metrics/usage-render && cp -r src/metrics/usage-render/assets dist/metrics/usage-render/"
```

이 `cp -r src/...` 파이프라인은 페이즈 2/3에서 즉시 깨진다 — `src/prompt`, `src/persona`, `src/local`은 `@soma/extensions`로, `src/metrics/usage-render/assets`는 `@soma/metrics`로 이동하니까.

### 교체안

**각 패키지가 자기 에셋을 자기 dist로 발행한다.** 루트는 합치지 않는다.

```jsonc
// packages/extensions/package.json
{
  "name": "@soma/extensions",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json && cp -r src/prompt src/persona src/local dist/"
  }
}
```

```jsonc
// packages/metrics/package.json
{
  "name": "@soma/metrics",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json && mkdir -p dist/usage-render && cp -r src/usage-render/assets dist/usage-render/"
  }
}
```

```jsonc
// 루트 package.json
{
  "scripts": {
    "build": "npm run check && npm run build --workspaces"
  }
}
```

런타임 코드는 에셋을 더 이상 `path.resolve(__dirname, '../prompt/...')` 같은 src/-상대 경로로 찾으면 안 된다. 각 패키지가 `import.meta.url` 기반 helper(`@soma/common/asset-path` 정도)를 통해 자기 패키지 안에서 찾도록 한다. **이 helper가 페이즈 2에서 가장 먼저 만들 한 가지.**

## 8. Landmines (soma-work 특화)

| Landmine | Why it bites | Mitigation |
|---|---|---|
| `session-registry.ts` 76KB, `token-manager.ts` 96KB | Phase 5에서 단순 이동만 해도 git diff가 거대 — 리뷰 부담 | 이동과 분해를 분리. 이 PR에서는 `git mv` 동등(content unchanged)로만. 분해는 후속 PR. |
| 루트 build의 `cp -r src/prompt dist/` 외 3개 | 페이즈 2 시작과 동시에 빌드 깨짐 | §7대로 각 패키지로 책임 이전. 페이즈 2의 첫 커밋이 이것이어야 함. |
| `.prompt` 파일들이 코드와 분리된 정적 에셋 | `npm publish`하지 않더라도 `tsc`가 안 옮김 | 각 패키지 `files:["dist"]` + 패키지 `build`에서 cp |
| `src/metrics/usage-render/assets/` PNG 자원 | 동일 (tsc는 PNG 무시) | `@soma/metrics`의 build가 직접 emit |
| `somalib/`은 이미 `mcp-servers/`도 import 중 | 페이즈 6에서 `somalib/` 삭제 시 mcp-servers도 같이 다뤄야 함 | 페이즈 4의 acceptance criterion: mcp-servers의 somalib 의존을 `@soma/common`/`@soma/extensions`/`@soma/mcp`로 모두 갈아끼움 |
| ESM/CJS interop (현재 `tsx` + `tsc` 혼용, `dist/index.js`는 commonjs) | workspace로 나누면 각 패키지가 자기 `type: module`을 선언, 혼재 시 require/import 충돌 | 모든 신규 패키지를 `"type": "module"`로 통일하고 루트 `package.json`도 같이 변경. tsconfig `moduleResolution: "bundler"` 또는 `nodenext`로 통일. |
| biome workspace 인식 | biome는 monorepo per-package 설정 지원이 ESLint보다 얕다 | 루트 `biome.json` 단일 유지. 각 패키지가 자기 영역만 lint하지 않아도 됨 — 어차피 같은 룰. |
| 기존 `docs/architecture.md`의 facade 분해 (`SlackHandler`/`ClaudeHandler`/`McpManager`) | 이 작업과 충돌 가능 | facade 분해는 한 패키지 내부 일이므로 충돌 없음. `architecture.md`를 페이즈 5/6에서 패키지 경계 기준으로 갱신. |
| `docs/mcp-refactor` + `docs/mcp-server-independence` + `docs/mcp-extraction` 3 트랙 동시 진행 | 같은 코드를 3 PR이 건드림 | 페이즈 4를 이 셋의 상위 우산으로 선언. 새 작업은 모두 페이즈 4 PR로 합류. |
| `agent-instance.ts` / `agent-manager.ts`는 host wiring과 runtime이 섞임 | 페이즈 5/6에서 어디 둘지 모호 | 두 파일을 먼저 `runtime` 부분 / `host wiring` 부분으로 나누는 prep 커밋. runtime → `@soma/core`, host wiring → `@soma/app`. |
| `dist/`에 cp되는 정적 prompt가 외부 사용자에게 노출되는 형태(`config.example.json` 등) | `files:` 화이트리스트가 좁으면 dist에 안 들어감 | 각 패키지 `files` 필드는 dist 외에 필요한 정적 자원도 명시. |

## 9. Anti-patterns to avoid

- **`@soma/sdk`를 너무 일찍 만들지 마라.** core가 안정되기 전에 facade를 만들면 facade가 매주 깨진다. 페이즈 6 전에는 만들지 않는다.
- **공유 타입을 모두 `@soma/common`에 넣지 마라.** Slack-specific 타입은 `@soma/slack`이, MCP-specific은 `@soma/mcp`가 소유. common은 진짜로 어디서나 쓰는 것만(Result, Logger 인터페이스 등).
- **`export * from './internal'` 금지.** 새 패키지에서 한 번이라도 허용하면 1년 안에 표면이 통제 불능.
- **`@soma/*`끼리 동시 양방향 의존을 허용하지 마라.** core ↔ slack 양방향이 보이면 그 경계는 잘못 잡힌 것. core가 콜백/인터페이스로 받게 inversion.
- **패키지 수를 7개로 줄이려 만들지 마라.** 9개라는 숫자에 집착하지도 마라. 한 패키지가 다른 한 패키지에만 쓰이고 다른 곳엔 쓰이지 않는다면 흡수.
- **`docs/PLANS/`로 옮기지 마라.** 이 plan은 active spec이다. PLANS는 archive 느낌.

## 10. If you only do ONE phase

**Phase 1 (@soma/slack 카브아웃)만 해도 80%의 이득.**

- `src/slack/`은 이미 가장 응집도 높은 단위(3.9M, 한 곳에 모임)라 mechanical move 가능.
- `@slack/bolt`가 core에 leak되던 사례가 한 PR에서 모두 컴파일 에러로 폭로된다 — 그것이 진짜 산출물.
- 이 한 PR이 의존 방향(`slack → core`)을 코드 레벨에서 못 박으면 이후 모든 페이즈는 그 방향을 따른다.
- 위험은 낮다 — 코드 변경 거의 없고 `git mv` + barrel + workspace 등록이 전부.
- 페이로드가 크고 위험이 낮은 페이즈는 첫 번째에 한다. 페이즈 5(core 본체 이동)은 가장 무거우므로 마지막에 가까운 곳에 배치된 이유.
