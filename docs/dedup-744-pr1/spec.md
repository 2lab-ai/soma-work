# dedup-744-pr1 — Spec

> STV Spec | Created: 2026-04-27 | Issue: #744 (PR1 of 3) | Parent epic: #743

## 1. Overview

### Proposal
- **Why**: `cron-storage`, `shared-store`, `stderr-logger` 세 모듈은 `mcp-servers/_shared/`와 `src/` 양쪽에 사본이 존재한다. 두 사본이 발산하면 cron 데이터 정합성과 permission 정책 신호가 깨진다. 공식 정사본을 `somalib` 워크스페이스로 승격해 한 모듈 한 출처 원칙을 회복한다.
- **What Changes**:
  - `somalib/stderr-logger.ts`, `somalib/cron/cron-storage.ts`, `somalib/permission/shared-store.ts` 신규
  - `mcp-servers/_shared/{cron-storage,shared-store,stderr-logger}.ts` 삭제
  - `src/{cron-storage,shared-store,stderr-logger}.ts` 삭제
  - 모든 import 사이트가 `somalib`를 직접 참조 (subpath import: `'somalib/cron/cron-storage'` from src; `'somalib/cron/cron-storage.js'` from mcp-servers)
  - `cron-storage` constructor에서 default `filePath` 제거 — 호출자가 명시 주입 (logger는 모듈 소유 `new StderrLogger('CronStorage')` 그대로)
  - `_shared/index.ts` barrel에서 `StderrLogger` + `LoggerInterface` 두 export 모두 제거
  - CI workflow가 `npm run check` 호출 (somalib까지 lint 보장)
- **Capabilities**:
  - 한 모듈 한 출처 — 발산 위험 제거
  - somalib biome 적용 → 포맷 통일
  - CI lint 사각지대 (somalib) 해소
- **Impact**:
  - mcp-servers/cron, mcp-servers/permission, mcp-servers/mcp-tool-permission, mcp-servers/model-command 의 import 경로 변경
  - src/index.ts, src/permission/slack-messenger.ts, src/slack/actions/permission-action-handler.ts, src/slack/actions/mcp-tool-permission-action-handler.ts 의 import 경로 변경
  - `src/cron-scheduler.ts`는 type-only import (`import type { CronStorage }`) — 경로만 갱신, ctor 호출 없음
  - 기존 `src/__tests__/cron-storage.test.ts`, `cron-execution-history.test.ts`, `cron-scheduler.test.ts`, `permission-action-handler.test.ts` import 경로 변경
  - **No breaking changes for end-users** — 내부 refactor. 동작 보존 (cron 데이터 파일 경로 + logger context 모두 동일).

PR1은 `#744` 전체(6쌍)의 1단계로, 가장 큰 두 모듈(cron-storage 389 dup lines, shared-store 262)에 leaf 의존인 stderr-logger(49)를 leaf-first 묶음으로 함께 처리한다. PR2(slack-messenger + dangerous-command-filter), PR3(types pair)은 후속 z 세션에서 별도 PR로 분리.

## 2. User Stories

- As a **soma-work 메인테이너**, I want cron 작업 저장 로직이 한 군데에 살아 있기를 원한다, so that cron 데이터 정합성 회귀가 한 곳에서만 잡히고 두 사본 발산을 걱정할 필요가 없다.
- As an **MCP 서버 개발자**, I want shared-store 권한 캐시가 단일 정사본을 통해 동작하기를 원한다, so that 권한 결정 로직이 사본별로 흐려지지 않는다.
- As a **CI 운영자**, I want `npm run check`가 CI에서도 그대로 실행되기를 원한다, so that somalib 코드의 lint 통과 여부가 CI 신호로 항상 잡힌다.
- As a **fallow 도구**, I want `dupes --skip-local` 결과에서 cron-storage / shared-store / stderr-logger 페어가 사라지기를 기대한다, so that PR1 머지 후 6 페어 중 3 페어가 baseline에서 빠진다.

## 3. Acceptance Criteria

- [ ] `somalib/stderr-logger.ts` 존재, `mcp-servers/_shared/stderr-logger.ts` + `src/stderr-logger.ts` 부재
- [ ] `somalib/cron/cron-storage.ts` 존재, `mcp-servers/_shared/cron-storage.ts` + `src/cron-storage.ts` 부재
- [ ] `somalib/permission/shared-store.ts` 존재, `mcp-servers/_shared/shared-store.ts` + `src/shared-store.ts` 부재
- [ ] `_shared/index.ts` barrel에서 `StderrLogger` 값 export + `LoggerInterface` 타입 export 모두 제거 — caller가 `'somalib/stderr-logger.js'` 직접 import
- [ ] `cron-storage` constructor 시그니처: `constructor(filePath: string)` — default 제거. 모듈 내부 `const logger = new StderrLogger('CronStorage')`는 유지 (logger context 보존).
- [ ] `src/index.ts`가 `somalib/cron/cron-storage`를 import + `new CronStorage(path.join(DATA_DIR, 'cron-jobs.json'))` 명시
- [ ] `mcp-servers/cron/cron-mcp-server.ts`가 `somalib/cron/cron-storage.js`를 import + `process.env.SOMA_DATA_DIR ? path.join(dataDir, 'cron-jobs.json') : path.join(process.cwd(), 'data', 'cron-jobs.json')` 분기로 명시 주입 (현재 cron-mcp-server.ts:198–206 동작 보존)
- [ ] `mcp-servers/cron/cron-mcp-server.ts:88`의 inline type import (`import('../_shared/cron-storage.js').CronModelConfig`)도 `import('somalib/cron/cron-storage.js').CronModelConfig`로 갱신
- [ ] `src/cron-scheduler.ts`의 type-only import (`type { CronStorage } from './cron-storage'`)가 `from 'somalib/cron/cron-storage'`로 갱신 — ctor 호출은 없음
- [ ] `src/permission/slack-messenger.ts`의 `import { StderrLogger } from '../stderr-logger'`가 `from 'somalib/stderr-logger'`로 갱신
- [ ] `src/slack/actions/permission-action-handler.ts:3` + `src/slack/actions/mcp-tool-permission-action-handler.ts:26` shared-store import 경로 갱신. 두 파일 모두 stderr-logger 직접 import는 없음 — 갱신 대상 아님.
- [ ] `mcp-servers/permission/permission-mcp-server.ts` + `mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts` + `mcp-servers/model-command/model-command-mcp-server.ts` import 갱신
- [ ] 테스트 파일 import 경로 갱신: `src/__tests__/cron-storage.test.ts`, `cron-execution-history.test.ts`, `cron-scheduler.test.ts`, `src/slack/actions/__tests__/permission-action-handler.test.ts` (mcp-tool-permission-action-handler.test.ts는 **현재 부재** — 신규 작성하지 않음, risk 항목으로 명시)
- [ ] `.github/workflows/ci.yml`의 lint 단계가 `npm run check` 호출
- [ ] `#744` 본문 정정 코멘트 게시 (PR1 push 직전)
- [ ] PR1 본문에 `npx fallow@2.52.0 dupes --skip-local` before/after 결과 첨부 — cron-storage, shared-store, stderr-logger 3 페어가 after에서 사라짐
- [ ] `npm run check` 통과 (biome on src/ + somalib/ + scripts/)
- [ ] `npx tsc --noEmit` 통과 (이는 src만 검증함을 명시 — mcp-servers는 별도 smoke 필요)
- [ ] `npm test` 통과 — `vitest`가 `src/**/*.test.ts`, `somalib/**/*.test.ts`, `mcp-servers/**/*.test.ts` 모두 실행 (mcp-servers/_shared/cron-storage 직접 테스트는 부재; cron-storage 시나리오 검증은 src 측 테스트 + cron-scheduler 간접 + 수동 smoke로)
- [ ] **mcp-servers boot smoke** (PR1 변경 영향 영역): 다음 명령들이 각각 exit code 0(정상 종료) 또는 124(timeout, 즉 stdio 부팅에 도달) 중 하나로 끝남 — module resolution + top-level evaluation 검증. PR body에 명령 + 결과(rc) 첨부.
  ```bash
  timeout 3 npx tsx mcp-servers/cron/cron-mcp-server.ts < /dev/null
  timeout 3 npx tsx mcp-servers/permission/permission-mcp-server.ts < /dev/null
  timeout 3 npx tsx mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts < /dev/null
  timeout 3 npx tsx mcp-servers/model-command/model-command-mcp-server.ts < /dev/null
  ```
  - 모든 결과가 `rc ∈ {0, 124}` 일 때 통과. 그 외 코드는 module resolution / 부팅 실패로 즉시 fail (롤백 신호).
  - tsc/biome가 mcp-servers 영역을 lint하지 않으므로 본 boot smoke가 PR1의 mcp-servers 측 검증의 1차 신호다.
- [ ] `npm run build` 통과 (somalib build + tsc + asset copies)
- [ ] CI 통과 (lint + test)
- [ ] PR 머지

## 4. Scope

### In-Scope
- 3 모듈의 somalib 승격 + 양 사본 삭제
- import 사이트 갱신 (mcp-servers + src + tests)
- cron-storage constructor `filePath` default 제거 (logger는 모듈 소유 유지)
- ci.yml `npm run check` 통일
- mcp-servers 영역에 대한 수동 smoke 절차 명시 (PR 본문에 결과)
- `#744` 정정 코멘트
- fallow `dupes --skip-local` 검증 (PR 본문 첨부)

### Out-of-Scope
- **PR2 영역**: `slack-messenger`, `dangerous-command-filter` (full module promote는 PR2에서)
- **PR3 영역**: `_shared/types.ts` ↔ `somalib/model-commands/session-types.ts` 통합
- `#744` 자체 close — PR3 머지 시점
- `#745`(circular deps), `#746`(auto-fix), `#747`(manual review), `#748`(complexity hotspots) — 각자 별 서브이슈
- fallow 도구를 package.json scripts/CI에 영구 wiring하는 것 (별도 결정, `#740`에서 진행)
- mcp-servers 디렉토리에 biome 적용하는 것 (의도적 제외 유지)
- mcp-servers 디렉토리에 별도 tsconfig.json 추가 (현재 미존재 — `npx tsx` 런타임 + vitest로 충분)
- CronStorage logger 인스턴스를 호출자가 주입하도록 바꾸는 설계 변경 (모듈 소유 그대로 유지 — logger context 'CronStorage' 보존)

## 5. Architecture

### 5.1 Layer Structure (cron 흐름)

```
[mcp-servers/cron/cron-mcp-server.ts]                  [src/index.ts]
   │ const dataDir = process.env.SOMA_DATA_DIR;             │ import { CronStorage } from 'somalib/cron/cron-storage';
   │ const cronFilePath = dataDir                           │ const storage = new CronStorage(
   │   ? path.join(dataDir, 'cron-jobs.json')               │   path.join(DATA_DIR, 'cron-jobs.json'));
   │   : path.join(process.cwd(), 'data', 'cron-jobs.json');│
   │ new CronStorage(cronFilePath)                          │
   ▼                                                        ▼
[somalib/cron/cron-storage.ts]
   │ const logger = new StderrLogger('CronStorage');  // module-owned, context 보존
   │ constructor(filePath: string) { this.filePath = filePath; }
   │ import { StderrLogger } from '../stderr-logger';  // somalib 내부 상대경로
```

**`SOMA_DATA_DIR` propagation 설계**: 자식 MCP 프로세스로의 `SOMA_DATA_DIR` 전달은 `src/mcp-config-builder.ts`의 `buildCronServer()` (라인 351) 및 `buildModelCommandServer()` (라인 329)가 child env로 `SOMA_DATA_DIR: DATA_DIR`을 주입한다. `src/index.ts`는 별도로 `process.env.DATA_DIR = DATA_DIR`만 설정 (`src/index.ts:98`) — token manager의 cct-store.json 정합성을 위함. 결과적으로 `mcp-servers/cron/cron-mcp-server.ts`가 부모와 같은 `cron-jobs.json`을 가리킨다. 두 호출자가 **같은 파일을 공유한다 (의도된 공유)**. PR1의 caller 분기 코드는 이 동작을 100% 보존한다.

### 5.2 Module Layout (somalib promote)

| somalib 위치 | source | 비고 |
|---|---|---|
| `somalib/stderr-logger.ts` | `src/stderr-logger.ts` (정사본) | leaf, no deps. `LoggerInterface` + `StderrLogger` 모두 export. |
| `somalib/cron/cron-storage.ts` | `src/cron-storage.ts` 기반 + filePath default 제거 | 모듈 소유 logger (`new StderrLogger('CronStorage')`) 유지. `import { StderrLogger } from '../stderr-logger'` (somalib 내부 상대경로). |
| `somalib/permission/shared-store.ts` | `src/shared-store.ts` (정사본) | StderrLogger 의존 → somalib 내부 import (`../stderr-logger`). 정사본 origin 근거: src 측이 biome 적용 + 동일 동작 (양 사본 cosmetic-only). |

### 5.3 Constructor Signature 변경 (cron-storage)

**Before** (양쪽 사본의 default가 다름)
```ts
// src/cron-storage.ts
const CRON_FILE = path.join(DATA_DIR, 'cron-jobs.json');
class CronStorage {
  constructor(filePath: string = CRON_FILE) { ... }
}

// mcp-servers/_shared/cron-storage.ts
class CronStorage {
  constructor(filePath: string = path.join(process.cwd(), 'data', 'cron-jobs.json')) { ... }
}
```

**After** (somalib — default 없음, 호출자 명시 주입)
```ts
// somalib/cron/cron-storage.ts
import { StderrLogger } from '../stderr-logger';
const logger = new StderrLogger('CronStorage');  // 모듈 소유, context 보존

class CronStorage {
  private filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }
  // ... 나머지 메소드 동일
}
```

**호출자 분기**:
```ts
// src/index.ts
import { DATA_DIR } from './env-paths';
import { CronStorage } from 'somalib/cron/cron-storage';
const storage = new CronStorage(path.join(DATA_DIR, 'cron-jobs.json'));

// mcp-servers/cron/cron-mcp-server.ts
import { CronStorage } from 'somalib/cron/cron-storage.js';
const dataDir = process.env.SOMA_DATA_DIR;
const cronFilePath = dataDir
  ? path.join(dataDir, 'cron-jobs.json')
  : path.join(process.cwd(), 'data', 'cron-jobs.json');
this.storage = new CronStorage(cronFilePath);
// (현재 cron-mcp-server.ts:198–206 분기와 동일 동작 — caller 명시화로 데이터 파일 경로 보존)
```

### 5.4 Integration Points (Affected import sites)

Explore agent 보고 + 실제 grep 기준:

| 파일 | 변경 |
|---|---|
| `mcp-servers/cron/cron-mcp-server.ts:14` | `'../_shared/stderr-logger.js'` → `'somalib/stderr-logger.js'` |
| `mcp-servers/cron/cron-mcp-server.ts:15–19` | `'../_shared/cron-storage.js'` → `'somalib/cron/cron-storage.js'` |
| `mcp-servers/cron/cron-mcp-server.ts:88` (inline type import) | `import('../_shared/cron-storage.js').CronModelConfig` → `import('somalib/cron/cron-storage.js').CronModelConfig` |
| `mcp-servers/cron/cron-mcp-server.ts:198–206` | 분기 보존 (위 5.3 참조) |
| `mcp-servers/permission/permission-mcp-server.ts:7` | `'../_shared/shared-store.js'` → `'somalib/permission/shared-store.js'` |
| `mcp-servers/permission/permission-mcp-server.ts` (stderr-logger 직접 import) | **없음 — 이 파일은 stderr-logger를 직접 import하지 않음**. 갱신 대상 아님. |
| `mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts:17` | shared-store 갱신. stderr-logger 직접 import **없음**. |
| `mcp-servers/model-command/model-command-mcp-server.ts:7` | `import { StderrLogger } from '../_shared/stderr-logger.js'` → `from 'somalib/stderr-logger.js'` (확정 — 라인 7 직접 import 존재) |
| `mcp-servers/_shared/index.ts` | `export { StderrLogger } from './stderr-logger.js'` 라인 제거 + `export type { LoggerInterface } from './stderr-logger.js'` 라인 제거 |
| `mcp-servers/_shared/{slack-messenger,dangerous-command-filter,base-mcp-server}.ts` 내부 stderr-logger import | `'./stderr-logger.js'` → `'somalib/stderr-logger.js'` (PR2까지 이 파일들 자체는 살아있지만 PR1에서 import line만 갱신해서 `_shared/stderr-logger.ts` 삭제 안전) |
| `src/index.ts:685` (실제 ctor 위치) | `new CronStorage()` (default 의존) → `new CronStorage(path.join(DATA_DIR, 'cron-jobs.json'))` 명시. `import { CronStorage }` 라인 경로를 `'somalib/cron/cron-storage'`로 갱신. |
| `src/cron-scheduler.ts:13–15` | `type { CronStorage } from './cron-storage'` → `from 'somalib/cron/cron-storage'` (type-only — ctor 호출 없음) |
| `src/permission/slack-messenger.ts:3` | `'../stderr-logger'` → `'somalib/stderr-logger'` |
| `src/slack/actions/permission-action-handler.ts:3` | shared-store 경로 갱신 |
| `src/slack/actions/mcp-tool-permission-action-handler.ts:26` | shared-store 경로 갱신 |
| `src/__tests__/cron-storage.test.ts` | import 경로 갱신 + ctor 호출에 `testPath` 명시 (default 제거되었으므로 인자 필수) |
| `src/__tests__/cron-execution-history.test.ts` | 위와 동일 |
| `src/__tests__/cron-scheduler.test.ts` | cron-scheduler 측 변화 흡수 — 직접 ctor 호출 시 testPath 명시 |
| `src/slack/actions/__tests__/permission-action-handler.test.ts` | shared-store 경로 갱신 + mock 경로 갱신 |
| 기타 `rg -n "from.*\\b(cron-storage\|shared-store\|stderr-logger)\\b" src/ mcp-servers/` 결과 | implementation 단계에서 1:1 매칭으로 갱신 |

**Risk: 직접 테스트 부재**
- `src/slack/actions/__tests__/mcp-tool-permission-action-handler.test.ts` 파일은 **현재 없음**. 신규 작성하지 않음 (out-of-scope). PR1 후 mcp-tool-permission-action-handler.ts에 직접 회귀 검증이 없는 상태. PR 본문에 risk 항목으로 명시 + 후속 (#747 또는 별도) 작업으로 위임.

### 5.5 CI / Build

- `.github/workflows/ci.yml`의 lint step:
  - **Before**: `npx biome check src/ scripts/` (mcp-servers 의도적 제외, somalib 누락)
  - **After**: `npm run check` (= `biome check src/ somalib/ scripts/`)
- `npm run build:somalib` 이미 존재 — somalib promote 후 자동으로 컴파일 산출물(`.js`, `.d.ts`) 생성
- `npm run build` 흐름 변경 없음 — `check + build:somalib + tsc + asset copies` 그대로
- **mcp-servers는 root `tsc` 영역 외**: `tsconfig.json`의 include는 `src/**/*`만. mcp-servers는 별도 tsconfig 부재 + `npx tsx` 런타임. 따라서 `npx tsc --noEmit`로 mcp-servers 검증 불가. 검증 신호: vitest의 `mcp-servers/**/*.test.ts` + acceptance에 명시한 boot smoke 4개 (§Acceptance Criteria 참조 — `timeout 3 npx tsx mcp-servers/<server>.ts < /dev/null` + `rc ∈ {0, 124}`).
- **`timeout` 명령 가용성**: GNU coreutils의 `timeout`은 Linux 표준. CI는 ubuntu-latest이므로 그대로 사용. macOS 로컬에서는 기본 미설치 — `brew install coreutils`로 설치 후 `gtimeout` 사용 (또는 동등 명령). spec/trace 표기는 `timeout`이지만 macOS 환경에서는 `gtimeout`로 치환 — 이 정정은 Implementer가 환경별로 적용한다.

### 5.6 Issue 정정 코멘트

PR1 push 직전 `#744`에 다음 요지 코멘트 게시:

```
[Correction — PR1 작업 전 본문 정정]

본문 가정 vs 실제 코드 검증 결과:
- "한쪽 사본은 100% dead로 식별, 아무도 import 안 함" → 거짓.
  모든 _shared/ 사본이 mcp-servers의 cron / permission / mcp-tool-permission / model-command 서버에서 활발히 import됨.
- "5쌍 모두 거의 100% 중복" → 부분 거짓.
  · cron-storage: 호출자별 default `filePath`만 다름 (src=DATA_DIR, mcp=process.cwd()/data). 그러나
    `mcp-servers/cron/cron-mcp-server.ts`가 `process.env.SOMA_DATA_DIR`을 우선 사용하고
    `src/mcp-config-builder.ts`의 `buildCronServer()` / `buildModelCommandServer()`가 child env로
    `SOMA_DATA_DIR: DATA_DIR`을 주입해서, 양 호출자가 같은 `cron-jobs.json`을 가리킨다 (의도된 공유).
    PR1은 이 동작을 100% 보존.
  · shared-store, stderr-logger: cosmetic-only diff (포맷·import 순서·prettier 옵션).
  · dangerous-command-filter: 의도적 subset (139줄 vs 369줄, lockdown rules 제거본). PR2 처리.
- 정사본 위치 → somalib 승격이 정답. `model-commands`가 `_shared` → `somalib` 승격된 선례 존재.

PR 분할:
- PR1 (이번): cron-storage + shared-store + stderr-logger leaf-first
- PR2: slack-messenger + dangerous-command-filter (full module promote 결정됨)
- PR3: types pair

#744는 PR3 머지 시 close.
```

## 6. Non-Functional Requirements

- **Performance**: 동작 보존 — cron 작업 데이터 R/W 시간/메모리 변화 없음. import 경로만 바뀜.
- **Security**: 권한 모델 변화 없음. shared-store 캐시 동작 그대로.
- **Compatibility**: 외부 API 표면 변화 없음. 내부 refactor.
- **Observability**: stderr-logger context 'CronStorage' 보존 (모듈 소유 logger 유지). shared-store / 기타 모듈도 기존 logger context 그대로. cron 데이터 파일 경로(`SOMA_DATA_DIR` propagation 포함) 보존.
- **Test coverage**:
  - cron-storage 직접 테스트 (`src/__tests__/cron-storage.test.ts`, `cron-execution-history.test.ts`) — 그대로 통과 보증
  - shared-store는 `src/slack/actions/__tests__/permission-action-handler.test.ts` 간접 — 통과 보증
  - mcp-tool-permission flow는 직접 테스트 부재 — risk 항목 명시
  - mcp-servers smoke (cron/permission MCP 부팅) — PR 본문 보고

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|---|---|---|
| somalib 모듈 위치 — `somalib/stderr-logger.ts` (root), `somalib/cron/cron-storage.ts`, `somalib/permission/shared-store.ts` | small | model-commands 선례 — 도메인별 폴더. infra leaf는 root. |
| cron-storage default `filePath` 제거 (constructor 인자 필수) — logger는 모듈 소유 유지 | small | DI 명시 + 두 호출자가 명시 분기로 동작 보존. logger 변경 안 하므로 'CronStorage' context 그대로. |
| 정사본 origin = `src/` 사본 | tiny | biome 적용본. somalib는 biome 영역. cron-storage는 src의 `import { DATA_DIR }`만 호출자 측으로 옮기면 통합 가능. |
| `_shared/index.ts` barrel에서 `StderrLogger` 값 export + `LoggerInterface` 타입 export 두 줄 모두 제거 | tiny | re-export 사슬 한 단계 감소. caller 직접 import (`'somalib/stderr-logger.js'`). |
| somalib에 별도 `Logger` 인터페이스를 신규 export하지 않음 | tiny | `LoggerInterface`가 이미 stderr-logger.ts에 정의되어 있고 `somalib/stderr-logger.ts` 신규 파일에서 그대로 export됨. structural type을 위한 별도 정의 불필요. |
| CI 와이어링 = `npm run check`로 통일 | small | 단일 진실원. ci.yml과 package.json scripts 분기 제거. |
| stderr-logger를 leaf-first로 PR1에 포함 (이슈 본문 분할에서 PR2 → PR1로 이동) | small | 의존 그래프상 cron/shared가 stderr-logger 의존. leaf-first가 정합. PR2에는 messenger+filter만 남음. |
| `_shared/{slack-messenger,dangerous-command-filter,base-mcp-server}.ts` 내부의 stderr-logger import만 PR1에서 갱신, 파일 자체는 PR2까지 보존 | small | `_shared/stderr-logger.ts`를 PR1에서 안전 삭제하기 위함. 해당 파일들 자체 dedup은 PR2 책임. |
| mcp-servers smoke 검증 (수동 부팅) 의무화 | small | tsc/biome이 mcp-servers를 검증하지 않는 사각지대를 PR1이 만지므로 보완 신호 필요. CI는 vitest로 mcp-servers test만 실행. |

## 8. Open Questions

없음. 핵심 결정 모두 받음.

## 9. Spec Changelog

| 버전 | 일자 | 변경 |
|---|---|---|
| 1.0 | 2026-04-27 | 초안 — PR1 한정. |
| 1.1 | 2026-04-27 | codex 리뷰 84점 피드백 반영: (1) cron-storage 경로 보존 서술 정정 — `SOMA_DATA_DIR` 우선 + cwd fallback + propagation으로 의도된 공유. (2) 검증 신호 정정 — `tsc --noEmit`/`npm run check`는 mcp-servers 미커버 → 수동 smoke 의무화. (3) callsite inventory 정정 — `cron-scheduler.ts` type-only, ctor caller는 `src/index.ts` + `mcp-servers/cron/cron-mcp-server.ts:88` inline type import 추가. (4) `mcp-tool-permission-action-handler.test.ts` 부재 명시. (5) `_shared/index.ts` barrel: `StderrLogger` + `LoggerInterface` 둘 다 제거. (6) `src/permission/slack-messenger.ts` PR1 affected에 추가. (7) cron-storage logger 모듈 소유 유지 (constructor 주입 안 함) — context 'CronStorage' 보존. (8) Scenario 5 fallback: acceptance 미달 stop. (9) somalib subpath import 패턴 명시. |

## 10. Next Step

→ `stv:trace docs/dedup-744-pr1/spec.md`로 시나리오 트레이스 + RED contract test 생성.
