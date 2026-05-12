# Packages × SRP Refactor — Plan (v3)

> v2 변경 요지: codex hard review (42/100, 2026-05-12) 결과 반영.
> ① mcp-servers를 **단일 `@soma/mcp` 패키지로 흡수하지 않고** 각자 `bin`을 가진 별도 워크스페이스 패키지로 분리, ② `src/mcp-config-builder.ts`가 파일경로 대신 `require.resolve('@soma/mcp-server-<x>/bin')`로 해소하도록 변경, ③ somalib는 흡수 대상이 아니라 **cross-process shared 패키지(`@soma/process-shared`)로 승격**, ④ Phase 0 = **deploy install contract + MCP bin packages**를 최우선, Slack 카브아웃은 Phase 2로 연기, ⑤ 임베디드 콘텐츠는 `src/local`/`src/prompt`가 아니라 패키지별 `assets/` 루트로 이동(exec bit 보존, smoke test 추가).
>
> v3 보강 요지: current repo audit로 ① package count를 12→11 first-class packages로 정정, ② `mcp-servers/mcp-tool-permission/*`가 현재 `../../src/{mcp-tool-grant-store,mcp-tool-permission-config,admin-utils}.js`를 import하는 사실을 Phase 0 scope에 포함, ③ Phase 0에서는 현재 root CommonJS 빌드를 유지하고 ESM 전환을 별도 결정으로 분리, ④ `@soma/mcp-config`의 MCP bin package edge를 "import"가 아니라 resolver-only dependency로 명시, ⑤ deploy YAML/package.json의 escaping-heavy inline shell은 금지하고 script files로 구현.

## 1. Target state

```
soma-work/
├── package.json                      # workspaces: ["packages/*", "packages/mcp-servers/*"]
└── packages/
    ├── common/         @soma/common              pure utils, logger, paths, formatters
    ├── process-shared/ @soma/process-shared      cross-process shared (former somalib): cron storage, model-cmd catalog, permission store, stderr-logger
    ├── extensions/     @soma/extensions          prompts, personas, local skills/agents/hooks (asset packages)
    ├── integrations/   @soma/integrations        github, oauth, a2t, notification-channels
    ├── metrics/        @soma/metrics             usage accounting + render assets
    ├── mcp-config/     @soma/mcp-config          MCP config/manager/permission gates (in-process, app side)
    ├── core/           @soma/core                runtime: sessions, Claude SDK, dispatch, auth, hooks
    ├── sdk/            @soma/sdk                 stable embedder facade
    ├── slack/          @soma/slack               @slack/bolt UI/adapter
    ├── app/            @soma/app                 process bootstrap, deploy, cron, multi-agent host wiring
    ├── test-utils/     @soma/test-utils          shared test factories
    └── mcp-servers/                              ← per-process bin packages, separate workspace dir
        ├── permission/        @soma/mcp-server-permission        bin
        ├── llm/               @soma/mcp-server-llm               bin
        ├── slack-mcp/         @soma/mcp-server-slack-mcp         bin
        ├── model-command/     @soma/mcp-server-model-command     bin
        ├── server-tools/      @soma/mcp-server-server-tools      bin
        ├── cron/              @soma/mcp-server-cron              bin
        ├── agent/             @soma/mcp-server-agent             bin
        ├── mcp-tool-permission/ @soma/mcp-server-mcp-tool-permission bin
        └── (_shared was a workaround — see §4 — it disappears)
```

**총 11개 first-class workspace 패키지 + 8개 MCP bin 패키지.** 11개는 `9 runtime in-process + 1 cross-process shared + 1 dev-only test-utils`다. "9개"나 "12개"라는 숫자가 목표가 아니다. 패키지 경계가 **실제 runtime 경계(in-process vs child-process)**와 일치하는 것이 목표.

## 2. Package responsibilities + moves

| Package | 종류 | Responsibility (1줄) | Allowed upstream | 이동 대상 |
|---|---|---|---|---|
| `@soma/common` | in-proc | 순수 유틸·로깅·경로·포맷터. UI/IO/Slack/MCP 의존 0. **stderr-logger는 cross-process 사용 중이므로 여기 두지 않음.** | (없음) | `src/util`, `src/utils`, `src/format`, `logger.ts`(in-proc only), `env-paths.ts`, `path-utils.ts`, filter들 |
| `@soma/process-shared` | **cross-proc** | 메인 앱과 `mcp-servers/` 자식 프로세스 **양쪽이 import**하는 계약 코드. 부모/자식 사이의 유일한 shared source surface. | `common` | `somalib/{cron,model-commands,permission,stderr-logger.ts}/*` 전체, `mcp-servers/_shared/` 전체, `src/mcp-tool-grant-store.ts`, `src/mcp-tool-permission-config.ts`, `src/admin-utils.ts`, 추가로 `src/types.ts`의 cross-process 쓰이는 타입 |
| `@soma/extensions` | in-proc | 프롬프트·페르소나·로컬 스킬/에이전트/훅 — **asset 패키지**(컴파일 산출물 + 정적 .md/.prompt/.sh) | `common` | `src/prompt`, `src/persona`, `src/local`, `src/plugin`, `user-skill-store.ts`, `prompt-cache-invalidation.ts` → **콘텐츠는 `assets/` 서브트리로 reorg(§7)** |
| `@soma/integrations` | in-proc | Slack 외 외부 서비스 어댑터 | `common` | `src/github`, `src/oauth`, `src/a2t`, `src/notification-channels`, `github-auth.ts`, `credentials-manager.ts`, `link-metadata-fetcher.ts` |
| `@soma/metrics` | in-proc | 사용량 집계·모델 레지스트리·렌더 에셋(PNG) | `common` | `src/metrics` → assets 별도 root(§7) |
| `@soma/mcp-config` | in-proc | MCP 설정 합성·서버 매니저·권한 게이트 (앱 측에서 자식 MCP를 띄울 때 쓰는 로직만) | `common`, `process-shared`, `extensions`, `integrations`, **resolver-only deps on `@soma/mcp-server-*`** | `src/mcp`, `mcp-manager.ts`, `mcp-config-builder.ts`, `mcp-call-tracker.ts`; permission grant/config/admin logic은 `process-shared`로 이동 |
| `@soma/core` | in-proc | Framework-agnostic 어시스턴트 런타임. `@slack/*` import 금지. **MCP bin 패키지도 import 금지** (자식 프로세스이므로). | `common`, `process-shared`, `extensions`, `integrations`, `mcp-config`, `metrics` | `src/agent-session`, `src/session`, `src/conversation` (web UI 제외), `src/auth`, `src/hooks`, `src/cct-store`, `src/sandbox`, `claude-handler.ts`, `session-registry.ts`, `token-manager.ts`, `prompt-builder.ts`, `dispatch-service.ts`, `complexity-scorer.ts`, `todo-manager.ts`, `working-directory-manager.ts`, `user-memory-store.ts`, `user-settings-store.ts`, `types.ts`(앱 전용 부분), `agent-instance.ts`/`agent-manager.ts`(런타임 부분) |
| `@soma/sdk` | in-proc | 외부/내부 embedder가 core를 쓰는 thin facade. 신규 파일만. Phase 6 전에 만들지 말 것. | `common`, `core`, `mcp-config` | (신규) |
| `@soma/slack` | in-proc | Slack Bolt UI/어댑터 | `common`, `core`, `sdk`, `integrations`, `metrics`, `extensions` | `src/slack`, `slack-handler.ts`, `file-handler.ts`, `channel-registry.ts`, `channel-description-cache.ts`, `startup-notifier.ts`, `release-notifier.ts`, `turn-notifier.ts` |
| `@soma/app` | in-proc | Process bootstrap, deploy, cron, multi-agent host | (모든 in-proc 패키지) **단, MCP bin 패키지는 import가 아닌 spawn으로만 의존** | `index.ts`, `config.ts`, `config-loader.ts`, `cron-scheduler.ts`, host wiring 부분, `src/deploy`, conversation web UI |
| `@soma/test-utils` | in-proc (devDep) | 공유 테스트 fixture | (모든 패키지, devDep 한정) | `src/test-utils` |
| `@soma/mcp-server-*` × 8 | **child-proc bin** | stdio MCP 서버 한 개 = 한 패키지. `package.json#bin`으로 실행 가능. | `common`, `process-shared`, **그리고 자기 자식의 필요 deps만** (예: slack-mcp는 @slack/web-api). **`@soma/core`/`slack`/`app`/`mcp-config` import 금지**. | `mcp-servers/<name>/*` 그대로 + `_shared/` 흡수 |

**핵심 재정의:** `@soma/mcp-config`는 "MCP 서버들을 모아둔 곳"이 아니라 "앱이 자식 MCP를 어떻게 띄울지를 결정하는 in-process 로직". 실제 MCP 서버 8개는 모두 **독립 패키지 + bin**. 단, `@soma/mcp-config`는 내부 서버 path를 찾기 위해 `@soma/mcp-server-*`를 package dependency로 가질 수 있다. 그 edge는 `require.resolve`/`createRequire.resolve` 전용이고 runtime import/call은 금지다.

## 3. Dependency DAG

```
                  ┌──────────── @soma/app ────────────┐
                  │      (bootstraps + spawns)         │
                  │                                    │
                  ▼                                    ▼ spawn (stdio)
              @soma/slack                  ┌───────────────────────────┐
                  │                        │ MCP bin packages (8 procs)│
                  ▼                        │  @soma/mcp-server-*       │
              @soma/sdk                    └──────────┬────────────────┘
                  │                                   │ import shared only
                  ▼                                   ▼
              @soma/core ───────────────► @soma/process-shared
                  │                                   │
        ┌─────────┼──────────┐                        │
        ▼         ▼          ▼                        │
   extensions integrations  metrics    ← @soma/mcp-config (in-proc)
        │         │          │             ┆
        └─────────┴──────────┴──── @soma/common ◀─────┘
                                      ┆
                                      └── dotted edge = resolver-only package deps
                                          from mcp-config to @soma/mcp-server-*
```

### Hard rules

1. **`@soma/core` MUST NOT import** `@slack/bolt`, `@slack/web-api`, `react`, `ink`, OR any `@soma/mcp-server-*`. MCP 서버는 자식 프로세스 — import 자체가 위반.
2. **`@soma/mcp-server-*` MUST NOT import** `@soma/{core, slack, sdk, app, mcp-config, extensions, integrations, metrics}`. 자식 프로세스가 부모 앱 코드를 import하면 의존 방향이 무너진다.
3. **`@soma/process-shared`는 양쪽에서 import되는 유일한 shared surface**다. "양방향 의존"을 허용한다는 뜻이 아니다. `process-shared` 자신은 `common`만 의존한다.
4. **`@soma/mcp-config`만 `@soma/mcp-server-*` package dependency를 가질 수 있다.** 허용 목적은 `internal-mcp-server-resolver.ts`의 static `require.resolve`/`createRequire.resolve`뿐이다. MCP server code를 import하거나 exported function을 호출하면 위반.
5. **Sibling 패키지 import는 published name(`@soma/x`) + 그 패키지 barrel만.** 형제의 `src/...` 깊이 import 금지.
6. **`@soma/common` is sink** — 이 repo 안 어떤 것도 import하지 않음.

## 4. Process boundary reality (왜 mcp-server는 import 패키지가 아니라 bin 패키지인가)

**현재 코드 증거:**
- `src/mcp-config-builder.ts:35` — `const PROJECT_ROOT = path.resolve(__dirname, '..')`
- `src/mcp-config-builder.ts:38` — `const MCP_SERVERS_DIR = path.join(PROJECT_ROOT, 'mcp-servers')`
- `src/mcp-config-builder.ts:301` 부근 — 각 MCP 서버를 `command: 'npx', args: ['tsx', <path>]`로 spawn

즉 main app은 mcp-servers의 코드를 **자기 메모리에 import한 적이 없다.** Claude Agent SDK가 stdio 프로토콜로 child process를 띄우고 JSON-RPC로 통신한다. 8개 MCP 서버 각각이 별도 OS 프로세스.

**그래서 plan v1의 `@soma/mcp` 단일 흡수는 틀렸다.**

**v3 결정:**
- `packages/mcp-config/` — 앱이 in-process로 쓰는 config/manager/permission 게이트. 자식 spawn 명령을 생성.
- `packages/mcp-servers/<name>/` × 8 — 각각 자기 `package.json#bin` 엔트리 + 명시적 `exports` subpath를 가진 워크스페이스 패키지. 예:
  ```jsonc
  // packages/mcp-servers/permission/package.json
  {
    "name": "@soma/mcp-server-permission",
    "bin": { "permission-mcp-server": "./dist/permission-mcp-server.js" },
    "files": ["dist"],
    "exports": {
      ".": "./dist/index.js",
      "./bin": "./dist/permission-mcp-server.js"      // resolver subpath
    },
    "dependencies": {
      "@soma/process-shared": "*",
      "@modelcontextprotocol/sdk": "^1.27.0"
    }
  }
  ```
- **Phase 0에서는 현재 root `tsconfig.json#module: commonjs` 계약을 유지한다.** `type: "module"` 전환은 이 PR-sized phase의 목표가 아니다. ESM 전환이 필요해지면 별도 PR에서 `moduleResolution`, `exports.import`, test runner, `__dirname` 대체까지 같이 다룬다.
- `src/mcp-config-builder.ts` (→ `@soma/mcp-config`) 안의 path resolution은 **명시 export subpath**로 해소: `require.resolve('@soma/mcp-server-permission/bin')` → `node_modules/@soma/mcp-server-permission/dist/permission-mcp-server.js`. CommonJS 유지 중에는 `require.resolve`를 쓰고, 해당 패키지가 ESM으로 전환된 뒤에는 `createRequire(import.meta.url).resolve`를 쓴다. 더 이상 `PROJECT_ROOT + 'mcp-servers'`로 가지 않는다. `bin` field 하나만으로는 `require.resolve('.../bin/...')` subpath가 보장되지 않으므로 `exports."./bin"` 명시가 필수.
- `@soma/mcp-config/src/internal-mcp-server-resolver.ts`를 새로 만들고, 8개 내부 서버 이름과 package specifier를 **static manifest**로 둔다. 예: `{ permission: '@soma/mcp-server-permission/bin' }`. `mcp-config-builder.ts`는 이 resolver만 호출한다. 이 파일 외부에서 `@soma/mcp-server-*`를 import/resolve하면 depcruise 위반.
- Spawn command는 production에서 `node <resolved dist js>`를 사용한다. Local dev는 둘 중 하나를 Phase 0에서 명시 선택해야 한다: (A) `npm start` 전에 `npm run build -w @soma/mcp-server-*`를 돌려 dist resolver를 항상 만족시키거나, (B) `SOMA_MCP_SERVER_MODE=source`에서만 workspace source entry(`packages/mcp-servers/<name>/<basename>.ts`)를 `tsx`로 실행하는 dev-only fallback을 둔다. fallback은 prod에서 절대 켜지면 안 된다.
- `mcp-servers/_shared/`의 src-복사 8개 파일은 `@soma/process-shared`로 흡수되며 사라진다 — copy-and-sync 부담 해소.
- `mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts`의 현재 `../../src/{mcp-tool-grant-store,mcp-tool-permission-config,admin-utils}.js` import는 Phase 0의 blocker다. 이 세 파일은 `process-shared`로 먼저 이동한 뒤 MCP bin과 app side가 동일 패키지를 import해야 한다.

## 5. Deploy & install contract (가장 중요한 한 절)

### 현재 fragility 위치

`.github/workflows/deploy.yml` 220, 230, 231 라인에 3개의 분리된 rsync:

```yaml
rsync -a --delete --exclude='mcp-servers.json' dist/ "$TARGET/dist/"
rsync -a --delete mcp-servers/ "$TARGET/mcp-servers/"
rsync -a --delete somalib/ "$TARGET/somalib/"
```

3개 트리가 독립으로 동기화된다. 한 rsync가 부분 실패하거나 파일 누락이면 다른 트리는 깨끗한데 mcp 호출이 런타임에 crash. `src/mcp-config-builder.ts:38`의 `PROJECT_ROOT + 'mcp-servers'` 가정이 깨지면서 무성한 ENOENT.

또한 dev 환경은 `dist/`에 `src/`가 없는데 `mcp-servers/`는 `../../src/` import를 남겨놨던 PR #130 회귀가 `docs/mcp-server-independence/spec.md`에서 발견된 사례 — 같은 패턴이 반복된다.

### v3 deploy contract

**원칙:** 빌드 단계에서 **하나의 immutable 배포 번들**을 만들고, 타깃에서는 그 번들을 install한다. 빌드는 자기 자신을 검증할 수 있어야 한다.

```
build artifact = {
  source bundle: packages/*/dist + packages/*/assets + 모든 package.json + package-lock.json
}
target install: rsync 후 타깃에서 `npm ci --omit=dev --workspaces` → 타깃 arch에 맞는 node_modules/@soma/* 생성
```

구체 방법 2가지(둘 중 하나 선택, **권장은 (B)**):

**(A) `npm pack` 기반:** 각 워크스페이스 패키지 → `npm pack` → 8 + 11 = 19개 tarball을 deploy artifact로 묶고, 타깃에서 `npm install ./tarballs/*.tgz`. **장점:** 표준 install, 검증 가능. **단점:** tarball 관리 부담.

**(B) 빌드된 소스 번들 + 타깃에서 prod install (권장):** **`node_modules`는 rsync하지 않는다** — `@resvg/resvg-js` 같은 native deps가 빌드 머신(linux x64)과 타깃(darwin arm64 mac-mini-dev) 사이에 arch-incompatible. 빌드는 `packages/*/dist/` + `package.json` + `package-lock.json` + 워크스페이스 메타만 묶고, 타깃에서 `npm ci --omit=dev --workspaces`로 native deps를 자기 arch로 빌드. `dist/`, `mcp-servers/`, `somalib/` 세 트리는 하나의 소스 번들로 합쳐진다.

  ```yaml
  # .github/workflows/deploy.yml (after)
  - run: npm ci
  - run: npm run build --workspaces
  - run: npm run smoke:deploy-bundle
  - run: scripts/deploy/stage-bundle.sh
  - run: scripts/deploy/sync-bundle.sh "$TARGET"
  - run: scripts/deploy/install-target.sh "$TARGET" "$TARGET_DIR" "$ENV"
  ```

  **Escaping rule:** YAML에는 복잡한 shell, `node -e`, quoted JSON, include/exclude filter를 직접 넣지 않는다. 이 repo 지시처럼 escaping-heavy command는 모두 script file로 옮긴다.

  `scripts/deploy/stage-bundle.sh` 책임:
  - 깨끗한 `bundle/` 디렉토리 생성.
  - root `package.json`, `package-lock.json`, `service.sh`, `deploy/protected-paths.txt` 포함.
  - 각 workspace package에서 `package.json`, `dist/`, `assets/`만 복사. `src/`, `__tests__/`, `*.test.ts`, `node_modules/`는 제외.
  - `packages/app/dist/deploy/main-env-bootstrap.js`가 번들에 있는지 검사(현재 deploy workflow가 main 환경 bootstrap을 호출하기 때문).

  `scripts/deploy/sync-bundle.sh` 책임:
  - `rsync -a --delete --exclude-from='deploy/protected-paths.txt' bundle/ "$TARGET/"`.
  - `--delete`는 bundle이 관리하는 파일에만 적용되고 아래 protected paths는 보존.

  `scripts/deploy/install-target.sh` 책임:
  - 타깃에서 `npm ci --omit=dev --workspaces --no-audit --no-fund`.
  - native dependency smoke: `node scripts/smoke/resvg-native.js`.
  - 세 번째 인자로 받은 env로 `bash service.sh "$ENV" install`을 bundle sync + target install 이후 실행.

  `deploy/protected-paths.txt`(신규):
  ```
  .env
  .system.prompt
  config.json
  mcp-servers.json
  data/
  logs/
  .claude/
  ```

  이 두 단계(bundle staging + protected excludes)가 현재 `service.sh cmd_setup`이 manual로 두는 영구 상태를 안전하게 보존한다.

  `npm ci --omit=dev --workspaces`가 워크스페이스 심볼릭 링크를 만들면서 `node_modules/@soma/*` 트리를 타깃 머신 arch에 맞게 native deps와 함께 구성한다. (대안 (A) `npm pack` + tarball install은 native deps 문제는 같지만 immutable tarball이 필요할 때 — 예: 외부 registry 배포 — 고려.)

**런타임 호출 변경:** `@soma/app`의 `index.ts`는 `node packages/app/dist/index.js` 또는 `npm exec @soma/app`으로 실행. MCP 서버 spawn은 `@soma/mcp-config`가 `require.resolve('@soma/mcp-server-permission/bin')`로 해소 (package `exports."./bin"`가 dist 파일로 해결).

**`service.sh`** — 현재 `node dist/index.js`를 `node packages/app/dist/index.js` 또는 `node node_modules/@soma/app/dist/index.js`로 변경. 한 줄 수정.

### Deploy smoke test (필수)

이 PR이 만들 새 npm scripts는 inline shell을 담지 않고 script files만 호출한다:
```jsonc
"scripts": {
  "smoke:mcp-bins": "node scripts/smoke/mcp-bins.js",
  "smoke:assets": "node scripts/smoke/assets.js",
  "smoke:deploy-bundle": "node scripts/smoke/deploy-bundle.js"
}
```

CI는 `npm run smoke:deploy-bundle`을 deploy 직전에 실행. 통과해야 rsync. `scripts/smoke/mcp-bins.js`는 8개 `@soma/mcp-server-*` package의 `./bin` export를 static list로 resolve하고, resolved path가 `dist/*.js`이며 파일이 존재하는지 확인한다.

## 6. Migration phases (REORDERED — v1과 다름)

각 페이즈는 **독립 PR-sized + runtime을 깨지 않음**. 이전 경로는 임시 re-export로 호환 유지, 마지막 페이즈에서 일괄 삭제.

### Phase 0 — **Deploy & MCP bin contract** (FIRST — v1에서 빠졌던 페이즈)

목표: 배포 fragility를 먼저 죽인다. 그 다음에 src/ 모듈을 패키지로 옮기는 일이 안전해진다.

작업:
1. `packages/process-shared/` 생성 — 현재 `somalib/` 그대로 이름만 바꾸지 말고, **현재 MCP bin이 `../../src`로 끌어오는 3개 파일**(`mcp-tool-grant-store`, `mcp-tool-permission-config`, `admin-utils`)까지 먼저 흡수한다. legacy `somalib/` 경로는 한 페이즈 re-export로 호환.
2. `packages/mcp-servers/<name>/` × 8 생성 — 현재 `mcp-servers/<name>/`을 **그대로 git mv**, 각자 `package.json` + `tsconfig.json` + `bin` + `exports."./bin"` 추가. `_shared/`는 `@soma/process-shared` import로 교체.
3. `@soma/mcp-config/src/internal-mcp-server-resolver.ts` 생성 — 8개 internal server의 package specifier를 static manifest로 관리. `mcp-config-builder.ts`의 `MCP_SERVERS_DIR` 경로 해소를 이 resolver 호출로 변경. `mcp-servers.json` 사용자 정의 서버는 기존처럼 외부 command/path로 유지하고 internal resolver와 섞지 않는다.
4. Runtime command 계약 변경 — production internal MCP는 `command: 'node', args: [resolvedDistPath]`. dev mode는 Phase 0에서 명시 선택: prebuild 방식 또는 `SOMA_MCP_SERVER_MODE=source` fallback. 선택한 방식에 대해 test를 먼저 작성한다.
5. `package.json#workspaces`에 `"packages/*"`, `"packages/mcp-servers/*"` 추가. `package-lock.json`도 같은 PR에서 갱신한다. 기존 `somalib`도 한 페이즈 유지(re-export shim).
6. `.github/workflows/deploy.yml` 3-rsync → script-file based 1-rsync(source bundle만)로 교체(§5 (B)). **`node_modules`는 rsync 금지** — 타깃에서 `scripts/deploy/install-target.sh`가 `npm ci --omit=dev --workspaces --no-audit --no-fund`를 실행.
7. `npm run smoke:deploy-bundle` script + CI에 게이트 추가.

Acceptance:
- `grep -r '../../src/' packages/mcp-servers/` 0건
- `grep -r 'somalib/' packages/mcp-servers/` 0건 (대신 `@soma/process-shared`)
- `grep -r '../_shared' packages/mcp-servers/` 0건 (대신 `@soma/process-shared`)
- `npm run smoke:mcp-bins` 통과
- `npm run build --workspaces` 통과
- `npm run test -- mcp-config-builder mcp-tool-permission` 통과
- `git grep "rsync.*mcp-servers" .github/workflows/` 0건
- `.github/workflows/deploy.yml`에 multiline deploy shell이 없고 `scripts/deploy/*.sh` 호출만 있음
- prod-like 환경 1회 배포 통과(자체 smoke)

### Phase 1 — `@soma/common` + `@soma/extensions` + asset reorg + `@soma/test-utils`

목표: 의존 sink 분리 + 임베디드 콘텐츠 자산화(§7).

- `@soma/common`: `src/util`, `src/utils`, `src/format`, `logger.ts`, `env-paths.ts`, `path-utils.ts`, filter류.
- `@soma/extensions`: `src/prompt`, `src/persona`, `src/local`, `src/plugin`, `user-skill-store.ts` → **콘텐츠는 패키지 안의 `assets/`로 reorg(§7)**. ts/test는 `src/`. exec bit 보존.
- `@soma/test-utils`: `src/test-utils` + 패키지별 공통 fixture.

Acceptance: 3개 패키지 단독 typecheck/test 통과. `src/local/hooks/*.sh` 실행 비트 유지 smoke.

### Phase 2 — `@soma/slack` 카브아웃

(v1의 Phase 1과 같은 작업, 그러나 v2에서는 Phase 0 이후로 연기. 배포 안전성이 먼저.)

- `src/slack`, `slack-handler.ts`, `file-handler.ts`, `channel-*`, notifier들 → `packages/slack/`.
- 옛 경로 한 페이즈 re-export.
- Acceptance: `grep -r '@slack/' packages/{core,mcp-config,extensions,integrations,metrics,common,process-shared}/src` 0건. Phase 2 시점에 `packages/core`가 아직 없으면 동일 검사를 남아있는 non-slack source path에 맞춰 실행한다.

### Phase 3 — `@soma/integrations` + `@soma/metrics`

- `@soma/integrations`: `src/github`, `src/oauth`, `src/a2t`, `src/notification-channels`, github-auth/credentials.
- `@soma/metrics`: `src/metrics` (assets 별도 root §7).

### Phase 4 — `@soma/mcp-config`

- `src/mcp`, `mcp-manager.ts`, `mcp-config-builder.ts`(Phase 0에서 일부 수정됨), `mcp-call-tracker.ts`, `mcp-tool-*` → `packages/mcp-config/`.
- (mcp-server bin 패키지들은 Phase 0에서 이미 분리됨)

### Phase 5 — `@soma/core`

- 거대 4 파일(`session-registry.ts` 76K, `token-manager.ts` 88K, `claude-handler.ts` 56K, `prompt-builder.ts` 20K)을 **분해하지 않고** 이동만. 분해는 후속 트랙.
- DAG 위반 0 (depcruise).
- Acceptance: `packages/core`만으로 `npm run build -w @soma/core` 성공.

### Phase 6 — `@soma/sdk` + `@soma/app` + cleanup

- `@soma/sdk`: 신규 thin facade (named export만).
- `@soma/app`: `index.ts`, `config.ts`, `config-loader.ts`, `cron-scheduler.ts`, host wiring, `src/deploy`, conversation web UI.
- `somalib/` 디렉토리 삭제 (Phase 0에서 시작된 process-shared 전환 완료).
- 모든 src/* re-export shim 삭제.
- Acceptance: `find src -type f | wc -l` = 0 또는 남는 파일이 `src/README.md` 같은 migration tombstone뿐임. `npm run prod` 부팅 정상.

## 7. Embedded content asset strategy

### 현 상태의 문제

- `src/prompt/`는 `.prompt` 파일 + `user-instructions-block.ts` + `__tests__/` 혼재.
- `src/local/`은 `agents/`, `commands/`, `hooks/` (셸 스크립트 — exec bit 필요), `prompts/`, `skills/`로 구성된 **순수 콘텐츠**.
- `src/metrics/usage-render/assets/`은 PNG.
- 현재 build: `cp -r src/{prompt,persona,local} dist/ && mkdir -p dist/metrics/usage-render && cp -r src/metrics/usage-render/assets dist/metrics/usage-render/` — 둔탁한 트리 복사.

### v3 전략

**각 패키지 안에 `assets/` 루트를 둔다.** ts/test와 콘텐츠를 분리하고, 콘텐츠는 명시적으로 publish한다.

```
packages/extensions/
├── src/                            # TS only (user-skill-store.ts, user-instructions-block.ts, __tests__/)
├── assets/
│   ├── prompt/
│   │   ├── default.prompt
│   │   ├── dispatch.prompt
│   │   ├── workflows/*.prompt
│   │   └── ...
│   ├── persona/
│   └── local/
│       ├── agents/*.md
│       ├── commands/*.md
│       ├── hooks/*.sh           # ← exec bit 보존 필수
│       ├── prompts/*.md
│       └── skills/...
├── package.json   files: ["dist", "assets"]
└── scripts/smoke-assets.js        # exec bits + 존재 검증
```

`@soma/metrics`도 동일 패턴:
```
packages/metrics/
├── src/
├── assets/usage-render/
│   └── *.png
└── package.json   files: ["dist", "assets"]
```

### Asset 경로 helper

`@soma/common`에 단일 helper 추가. **주의: 호출자는 개별 모듈 위치가 아니라 패키지 루트의 안정된 anchor를 넘긴다** — 중첩 컴파일 출력(`dist/sub/foo.js` 같은)에서 상대 경로가 깨지지 않도록. Phase 0~6은 현재 repo의 CommonJS 빌드(`tsconfig.json#module: commonjs`)를 유지하므로 anchor는 `__dirname` 기반으로 둔다.

```ts
// packages/common/src/asset-path.ts
import { resolve } from 'node:path';

/**
 * 패키지 루트를 고정 anchor로 받아 그 안 assets/ 경로를 만든다.
 *
 * 호출자는 패키지마다 한 곳에 anchor를 둔다:
 *   // packages/extensions/src/asset-root.ts
 *   export const ASSET_ROOT = resolve(__dirname, '..');  // dist/.. = package root
 *
 * 그러면 모듈이 dist/sub/foo.js로 컴파일돼도 ASSET_ROOT는 항상 패키지 루트.
 */
export function assetPath(packageRoot: string, ...segments: string[]): string {
  return resolve(packageRoot, 'assets', ...segments);
}
```

사용:
```ts
// packages/extensions/src/asset-root.ts        ← 패키지마다 한 곳
import { resolve } from 'node:path';

export const ASSET_ROOT = resolve(__dirname, '..');

// packages/extensions/src/load-prompt.ts
import { assetPath } from '@soma/common/asset-path';
import { ASSET_ROOT } from './asset-root';
const filePath = assetPath(ASSET_ROOT, 'prompt', 'workflows', 'deploy.prompt');
```

이렇게 하면 `dist/load-prompt.js`도 `dist/workflows/load-prompt.js`도 똑같이 `packages/extensions/assets/prompt/workflows/deploy.prompt`로 해소된다. 호출자가 각 파일의 `__dirname`/`import.meta.url`을 직접 넘기는 패턴은 모듈이 nested되면 깨지므로 금지.

이 helper + 패키지마다 한 줄 `asset-root.ts`가 **Phase 1의 가장 먼저 만드는 한 가지.**

### Exec bit 보존 + smoke

`src/local/hooks/*.sh`는 실행 비트가 죽으면 hook이 silent fail.

```js
// packages/extensions/scripts/smoke-assets.js
import fs from 'node:fs';
const must = [
  'assets/local/hooks/todo-guard.sh',
  'assets/local/hooks/hook-proxy.sh',
  'assets/local/hooks/stop-hook.sh',
  'assets/local/skills/z/SKILL.md',
  'assets/prompt/default.prompt',
];
let bad = 0;
for (const p of must) {
  if (!fs.existsSync(p)) { console.error('MISSING', p); bad++; continue; }
  if (p.endsWith('.sh')) {
    const m = fs.statSync(p).mode & 0o111;
    if (!m) { console.error('NOT EXECUTABLE', p); bad++; }
  }
}
process.exit(bad);
```

CI에서 `npm run smoke:assets`로 게이트.

## 8. Barrel exports policy

gemini-cli의 [`packages/core/src/index.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/index.ts)는 named export로 표면을 직접 큐레이션한다. 같은 원칙:

```ts
// packages/core/src/index.ts — 좋은 예시
export { SessionRegistry, type SessionId } from './session/registry';
export { TokenManager } from './token/manager';
export { dispatchWorkflow, type Workflow } from './dispatch/service';
// ❌ 금지: export * from './internal/foo';
```

- `export *`는 같은 패키지 내부 합산 barrel에서만 허용.
- 타입은 `export type { ... }` 명시.
- 새 export를 barrel에 추가 = PR 설명에 "why public" 한 줄 명시.

## 9. Lint enforcement under biome

**dependency-cruiser**를 `npm run check`에 추가.

`.dependency-cruiser.cjs`:

```js
// `packages/<name>/src/` 와 `packages/mcp-servers/<name>/src/` 두 깊이를 모두 잡는다.
const PKG_SRC = "^packages/(?:mcp-servers/)?([^/]+)/src/";
const SAME_PKG_SRC = "^packages/(?:mcp-servers/)?$1/src/";

module.exports = {
  forbidden: [
    // 1) 형제 패키지의 src/를 상대경로로 import 금지 (in-proc + mcp-bin 모두 포함)
    {
      name: "no-cross-package-relative",
      severity: "error",
      from: { path: PKG_SRC },
      to: {
        path: PKG_SRC,
        // dependency-cruiser supports $1 from `from.path` inside `to.pathNot`.
        // 같은 패키지 내부 relative import는 허용, 다른 package src relative import는 금지.
        pathNot: SAME_PKG_SRC,
        dependencyTypes: ["local"]
      }
    },
    // 2) core는 @slack/* 금지
    {
      name: "core-must-not-import-slack",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { dependencyTypes: ["npm"], path: "^@slack/" }
    },
    // 3) 일반 in-proc 패키지는 MCP server bin 패키지 import/resolve 금지.
    //    `@soma/mcp-config`는 아래 rule 4에서 resolver 파일만 예외 처리.
    {
      name: "in-proc-must-not-import-mcp-bin",
      severity: "error",
      from: { path: "^packages/(core|app|slack|sdk|extensions|integrations|metrics|common|process-shared)/src/" },
      to: { dependencyTypes: ["npm"], path: "^@soma/mcp-server-[^/]+(/|$)" }
    },
    // 4) mcp-config의 MCP bin package edge는 resolver-only.
    {
      name: "mcp-config-mcp-bin-only-from-resolver",
      severity: "error",
      from: {
        path: "^packages/mcp-config/src/",
        pathNot: "^packages/mcp-config/src/internal-mcp-server-resolver\\.ts$"
      },
      to: { dependencyTypes: ["npm"], path: "^@soma/mcp-server-[^/]+(/|$)" }
    },
    // 5) MCP bin 패키지는 in-proc 앱 internals import 금지. subpath(/internal 등)까지 차단.
    {
      name: "mcp-bin-must-not-import-app-internals",
      severity: "error",
      from: { path: "^packages/mcp-servers/[^/]+/src/" },
      to: {
        dependencyTypes: ["npm"],
        path: "^@soma/(core|app|slack|sdk|mcp-config|extensions|integrations|metrics)(/|$)"
      }
    }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    exclude: "^(.*/)?(node_modules|dist)/"
  }
};
```

`package.json#scripts.check`:
```json
"check": "biome check packages/ scripts/ && depcruise packages --validate .dependency-cruiser.cjs"
```

(v1에서 `biome check src/ somalib/`는 Phase 6 이후 폐기.)

검증 근거: dependency-cruiser rules reference는 `from.path` capture group을 `to.pathNot`의 `$1`에서 재사용하는 패턴을 지원한다. 단, `require.resolve` detection은 static string일 때만 신뢰한다. 그래서 resolver manifest는 string literal map이어야 하고, dynamic string concatenation으로 specifier를 만들면 안 된다.

## 10. Landmines (soma-work 특화)

| Landmine | Why it bites | Mitigation |
|---|---|---|
| `mcp-servers/_shared/`의 src-복사물 | `docs/mcp-server-independence/spec.md`가 만든 band-aid. src 변경 시 수동 sync 필요 | Phase 0에서 `@soma/process-shared`로 흡수, `_shared/` 삭제 |
| 3-way rsync drift (dist/mcp-servers/somalib) | 한쪽 부분 실패 = MCP child crash | Phase 0의 §5 (B)로 1-rsync 전환 |
| `mcp-config-builder.ts:38` `path.resolve(__dirname, '..')` | `dist/`로 빌드된 후 `__dirname`이 변하면 `mcp-servers/` 못 찾음 | Phase 0에서 `require.resolve('@soma/mcp-server-<x>/bin')`로 교체 (`exports."./bin"`로 dist 해소) |
| `mcp-tool-permission` MCP server의 `../../src/*` import | bin package로 옮긴 뒤 부모 `src`가 사라지면 즉시 crash. 현재 `mcp-tool-grant-store`, `mcp-tool-permission-config`, `admin-utils` 3개가 해당 | Phase 0에서 이 셋을 `@soma/process-shared`로 먼저 이동 |
| `somalib/tsconfig.json#outDir: "."` | JS 산출물이 source tree에 섞이는 현 구조. workspace package에서는 dist/files contract가 깨짐 | `@soma/process-shared`는 `outDir: "dist"`, `files:["dist"]`, legacy shim은 한 페이즈만 |
| root `tsconfig.json#module: commonjs` | `type: "module"`을 MCP packages에 섞으면 import/export/runtime이 한 PR에서 터짐 | Phase 0은 CommonJS 유지. ESM/dual emit은 별도 PR 또는 충분한 tests 후에만 |
| `src/local/hooks/*.sh` exec bit | tar/rsync 옵션에 따라 exec bit 손실 시 hook silent fail | §7 smoke + `files:["assets","dist"]` + rsync `-a` 보존 |
| `src/prompt/`에 ts + 정적 .prompt 혼재 | naive cp -r로는 분리 안 됨 | §7 assets/ vs src/ 분리 |
| `session-registry.ts` 76K, `token-manager.ts` 88K | Phase 5에서 단순 이동만 해도 git diff 거대 | content-unchanged git mv. 분해는 후속 PR. |
| `.prompt` 파일이 `dist/`에 cp되지 않으면 런타임 ENOENT silent | smoke가 잡지 못하면 prod에서 발견 | §5 smoke에 `.prompt`/`.md` 존재 체크 포함 |
| `mcp-servers.json` 사용자 정의 외부 MCP 서버 | 내부 bin과 외부 server를 같은 config가 다룸 | `@soma/mcp-config`는 두 path 분리: 내부=`require.resolve`, 외부=사용자 지정 command |
| inline shell in deploy YAML / package.json scripts | quoting/escaping 오류가 deploy를 깨뜨림. 이 repo는 shell escaping을 피하라고 명시 | §5처럼 `scripts/deploy/*.sh`와 `scripts/smoke/*.js` 파일로 분리 |
| `agent-instance.ts` / `agent-manager.ts` runtime + host wiring 혼재 | Phase 5/6 어디로 갈지 모호 | Phase 5 prep 커밋에서 runtime/host로 분할. runtime→core, host→app. |
| 3 동시 트랙(`mcp-refactor`, `mcp-server-independence`, `mcp-extraction`) | 같은 코드 3 PR이 건드림 | Phase 0를 우산으로 선언. 신규 작업 합류. |
| biome workspace 인식 약함 | per-package 설정 ESLint보다 얕다 | 루트 단일 `biome.json` 유지. 룰은 동일. |
| Node 18 Dockerfile + workspace/native deps | 일부 native modules와 npm workspace install 호환성 | Dockerfile Node 20 LTS 업그레이드(이미 root `engines.node": ">=20"` 권고 — Dockerfile만 뒤짐) |

## 11. Anti-patterns to avoid

- **`@soma/sdk`를 너무 일찍 만들지 마라.** core 안정화 전에는 매주 깨진다. Phase 6 전 금지.
- **공유 타입을 모두 `@soma/common`에 넣지 마라.** Slack-specific은 `@soma/slack`, MCP-config-specific은 `@soma/mcp-config`. common은 진짜 어디서나 쓰는 것만.
- **`export * from './internal'` 금지.** 표면 통제 불능.
- **`@soma/*`끼리 양방향 의존 금지.** 보이면 그 경계는 잘못 잡혔다 — inversion.
- **패키지 수 목표 X.** 통합할 곳은 통합, 쪼갤 곳은 쪼갠다. 11 + 8은 결과지 목표가 아니다.
- **mcp-server bin 패키지를 in-process로 import하지 마라.** 자식 프로세스를 in-proc으로 끌어오면 의존 방향 완전 붕괴.
- **MCP bin resolver를 dynamic string concatenation으로 만들지 마라.** depcruise와 smoke가 static specifier를 볼 수 있어야 한다.
- **deploy YAML에 긴 shell을 넣지 마라.** script file로 옮기고 그 script를 테스트한다.
- **`somalib`을 그대로 두지 마라 — `@soma/process-shared`로 승격하고 cross-process 계약을 명시하라.** "그냥 shared"는 의도 표현이 약하다.

## 12. Q&A — 사용자 질문 답변 (a/b/c/d/e)

### a. `mcp-servers/`를 패키지로 만들 수 있나?

**Yes. 그리고 그게 deploy "병신처럼 됨" 문제를 정확히 해소한다.** 현재 `src/mcp-config-builder.ts:38`이 `path.resolve(__dirname, '..')/mcp-servers`로 찾기 때문에 dist와 mcp-servers 트리가 한쪽이라도 어긋나면 child process spawn이 실패. 8개 MCP 서버 각자를 `packages/mcp-servers/<name>/`로 옮기고 `package.json#bin` + `exports."./bin"`를 달면, `@soma/mcp-config`의 resolver가 `require.resolve('@soma/mcp-server-permission/bin')`로 어디서든 찾을 수 있다. 이 resolver edge는 package resolution 전용이고 MCP server code import는 아니다. **3개 rsync 중 2개(`mcp-servers/`, `somalib/`)는 없어지고**, 타깃에서 `npm ci --omit=dev --workspaces`가 native deps까지 자기 arch로 install. 자세한 절차는 §4·§5·Phase 0.

### b. `somalib/`은 어떻게 처리?

**`@soma/process-shared`로 승격한다 — 흡수도 흩뜨림도 아닌 정체성 정정.** somalib의 진짜 역할은 "메인 앱과 mcp-servers 자식 프로세스 양쪽이 import하는 공유 코드"인데, 현재는 이름이 그것을 드러내지 않고 mcp-server-independence/spec.md가 src-복사로 우회한다. v3는:
- `packages/process-shared/`로 이동. Phase 0은 현 CommonJS 빌드를 유지하고, ESM/dual emit은 별도 검증이 붙을 때만 추가.
- `mcp-servers/_shared/`와 현재 `mcp-tool-permission`이 `../../src`로 끌어오는 permission grant/config/admin 파일을 흡수 → 복사/부모-src 의존 제거.
- 메인 앱과 모든 mcp-server bin 패키지가 동일 `@soma/process-shared`를 import.
- 이 패키지는 부모 앱과 자식 MCP 양쪽에서 import되는 유일한 shared surface(§3).

(v1처럼 cron→app, model-commands→extensions로 흩어버리면 mcp-server들이 다시 src를 import해야 해서 부메랑.)

### c. 메타 인지 — 이게 어떻게 실행되나

런타임 토폴로지:
1. **Process #1 = `@soma/app` (`node packages/app/dist/index.js`).** Slack Bolt가 Slack에 WebSocket 연결, 세션 상태 보관, Claude Agent SDK 호출.
2. **Process #2…N = MCP server children.** Claude Agent SDK가 turn 시작 시 config(mcp-config가 만든)를 보고 필요한 MCP 서버를 stdio로 spawn. 각각 별도 OS 프로세스. 8개 내부 + 사용자 정의 외부 MCP.
3. **통신 = JSON-RPC over stdio.** in-process 함수 호출 아님. 즉 mcp-server들과 메인 앱은 OS 수준에서 격리.
4. **공유는 오직 source code(npm install 트리)로만** — `@soma/process-shared`가 양 프로세스의 코드 베이스에 똑같이 들어감.

이 토폴로지가 **이미 process boundary로 분리되어 있다**. 패키지 분리는 그 사실을 코드 레벨에 못 박는 것일 뿐.

### d. `src/`는 앱, `src/{local,prompt}`는 임베디드 파일, `mcp-servers/`는 외부 MCP — 맞다.

정확히 그 인식이 v3의 전제다.
- `src/` → `@soma/app` + `@soma/core` + … (9 runtime in-proc 패키지).
- `src/local`, `src/prompt`, `src/persona` → `@soma/extensions/assets/{local,prompt,persona}` (§7) — TS 코드와 분리된 정적 콘텐츠.
- `mcp-servers/` → `packages/mcp-servers/<name>/` × 8 (외부 child process bin).

### e. 어떻게 하는 게 좋을지

**Phase 0부터 시작한다.** v1처럼 Slack 카브아웃을 먼저 하면 배포 fragility(현 3-rsync 구조)가 마이그레이션 내내 살아있다. Phase 0의 결과:
1. `packages/mcp-servers/*` × 8 (각 bin)
2. `packages/process-shared/` (somalib + `_shared` + cross-process permission code 승격)
3. `mcp-config-builder.ts`의 path-resolve → resolver-only `require.resolve`
4. deploy.yml 3-rsync → script-file based 1-rsync
5. `smoke:deploy-bundle` CI gate

이 한 PR로 사용자 말 "deploy 가끔 병신처럼 됨"의 근원 — 3개 트리 drift, src-복사 sync, `__dirname` 의존 — 이 한꺼번에 사라진다. 이후 페이즈는 in-proc src/ 정리.

## 13. If you only do ONE phase

**Phase 0 (deploy & MCP bin contract)만 해도 80% 이상의 운영 이득.**

- 배포 fragility의 직접 원인(3-rsync 분산, `path.resolve` 의존, src-복사 동기화)이 한 PR로 사라진다.
- `mcp-servers/`가 워크스페이스 패키지가 되면 신규 MCP 서버 추가 시 boilerplate 없이 `packages/mcp-servers/<x>/`만 만들면 끝.
- `@soma/process-shared`가 명시화되면 "src와 mcp-servers의 공유 코드가 뭔지" 모호함이 사라진다.
- 위험은 관리 가능하다 — business logic 변경은 거의 없지만 deploy contract와 process packaging을 바꾸므로 resolver/dev-mode/deploy smoke tests가 필수다.
- 이 PR이 통과한 시점부터 모든 후속 페이즈는 **이미 배포가 안정한 상태에서** 진행된다. Slack/core 카브아웃의 위험도가 한 계단 낮아진다.

(v1의 "Slack 먼저"는 코드 리스크 관점에서는 맞지만 **운영 리스크 관점에서는 틀렸다.** 운영 리스크가 더 비싸다.)
