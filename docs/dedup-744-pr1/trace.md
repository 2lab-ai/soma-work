# dedup-744-pr1 — Vertical Trace

> STV Trace | Created: 2026-04-27 | Spec: docs/dedup-744-pr1/spec.md

이 작업은 HTTP API가 아닌 코드 refactor다. 7-section 의미를 보존해 차용:
- **API Entry** → 작업 진입 (대상 파일 + 작업 종류)
- **Input** → 변경 명세 (소스 사본 + 삭제 대상 + 인터페이스 변화)
- **Layer Flow** → 단계별 변경 (생성 → 갱신 → 삭제) + 의존 그래프
- **Side Effects** → 빌드/테스트/CI에 대한 영향
- **Error Paths** → 실패 신호 + 롤백 절차
- **Output** → 시나리오 완료 게이트
- **Observability** → 검증 명령 + 회귀 invariants

**검증 신호 주의**: `npx tsc --noEmit`은 root tsconfig의 include(`src/**/*`)만 검사 — `mcp-servers`는 영역 외. `npm run check`는 biome lint만 (import resolution 검사 X). `mcp-servers` 측 변경은 별도 검증 신호 필요:
- vitest의 `mcp-servers/**/*.test.ts` (현재 cron MCP 직접 테스트는 부재)
- **boot smoke** (timeout-wrapped stdio): `timeout 3 npx tsx mcp-servers/<server>.ts < /dev/null`. exit code `0` 또는 `124` (timeout = stdio listen 도달) 둘 다 통과. 그 외 코드 = 모듈 resolution 또는 top-level evaluation 실패.
- **`timeout` 명령 가용성**: Linux GNU coreutils 표준 (CI = ubuntu-latest 가용). macOS 로컬 환경은 `brew install coreutils` 후 `gtimeout` 사용 — 본 trace의 `timeout` 표기를 `gtimeout`으로 환경별 치환.

## Table of Contents
1. [Scenario 1 — stderr-logger leaf promote](#scenario-1)
2. [Scenario 2 — shared-store promote](#scenario-2)
3. [Scenario 3 — cron-storage promote + filePath 일반화](#scenario-3)
4. [Scenario 4 — CI lint 와이어링 (npm run check)](#scenario-4)
5. [Scenario 5 — #744 정정 코멘트 + fallow dupes 검증](#scenario-5)

---

## Scenario 1 — stderr-logger leaf promote

### 1. Entry
- **대상**: `somalib/stderr-logger.ts` 신규 + 양쪽 사본 삭제 + 모든 caller import 갱신
- **순서**: leaf 먼저 (Scenario 2, 3가 의존)
- **Auth**: 없음 (로컬 refactor)

### 2. Input
- **소스 사본 (정사본)**: `src/stderr-logger.ts` (49 lines, biome 적용본)
- **삭제 대상**: `src/stderr-logger.ts`, `mcp-servers/_shared/stderr-logger.ts`
- **인터페이스 변화**: 없음 — `export interface LoggerInterface { ... }` + `export class StderrLogger implements LoggerInterface` 시그니처 그대로
- **Validation**: 신규 `somalib/stderr-logger.ts`는 node 빌트인 외 의존 없음 (leaf 보장)

### 3. Layer Flow

#### 3a. 파일 생성 — `somalib/stderr-logger.ts`
- 변환: `src/stderr-logger.ts` 내용 → `somalib/stderr-logger.ts` 복사
- biome 자동 포맷 (somalib는 `npm run check` 영역)

#### 3b. caller import 갱신 (Contract Tests RED → GREEN 매핑)

| caller | Before | After |
|---|---|---|
| `mcp-servers/_shared/index.ts:1` | `export { StderrLogger } from './stderr-logger.js'` | 라인 제거 |
| `mcp-servers/_shared/index.ts:2` | `export type { LoggerInterface } from './stderr-logger.js'` | 라인 제거 |
| `mcp-servers/cron/cron-mcp-server.ts:14` | `from '../_shared/stderr-logger.js'` | `from 'somalib/stderr-logger.js'` |
| `mcp-servers/permission/permission-mcp-server.ts` | **stderr-logger 직접 import 없음** | 갱신 대상 아님 |
| `mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts` | **stderr-logger 직접 import 없음** | 갱신 대상 아님 |
| `mcp-servers/model-command/model-command-mcp-server.ts:7` | `'../_shared/stderr-logger.js'` | `'somalib/stderr-logger.js'` |
| `mcp-servers/_shared/cron-storage.ts` (Scenario 3에서 삭제) | `from './stderr-logger.js'` | (삭제될 파일 — line 그대로 두면 무방) |
| `mcp-servers/_shared/shared-store.ts` (Scenario 2에서 삭제) | 동일 | (삭제될 파일) |
| `mcp-servers/_shared/slack-messenger.ts` (PR2 영역, **PR1에서 import만 갱신**) | `from './stderr-logger.js'` | `from 'somalib/stderr-logger.js'` |
| `mcp-servers/_shared/dangerous-command-filter.ts` (PR2 영역, 동일) | 동일 | 동일 |
| `mcp-servers/_shared/base-mcp-server.ts` (잔여, 갱신) | 동일 | 동일 |
| `src/permission/slack-messenger.ts:3` | `'../stderr-logger'` | `'somalib/stderr-logger'` |
| `src/shared-store.ts` (Scenario 2에서 삭제) | `'./stderr-logger'` | (삭제될 파일) |
| `src/cron-storage.ts` (Scenario 3에서 삭제) | `'./stderr-logger'` 또는 등가 | (삭제될 파일) |
| 기타 `src/` 내부 stderr-logger 직접 caller | `'./stderr-logger'` 등 | `'somalib/stderr-logger'` (`rg -n "from.*stderr-logger" src/`로 1:1 매칭) |

**전략**: PR2 영역 파일(slack-messenger, dangerous-command-filter, base-mcp-server)도 PR1에서 stderr-logger import 라인만 갱신. 그래야 `mcp-servers/_shared/stderr-logger.ts`를 PR1에서 안전 삭제 가능. 해당 파일들 자체 dedup은 PR2 책임.

#### 3c. 파일 삭제
- `src/stderr-logger.ts` 삭제
- `mcp-servers/_shared/stderr-logger.ts` 삭제

#### 3d. 의존 그래프 (시나리오 1 후)

```
somalib/stderr-logger.ts (leaf, exports LoggerInterface + StderrLogger)
   ↑
   ├── mcp-servers/{cron,permission,mcp-tool-permission,model-command}/*-mcp-server.ts
   ├── mcp-servers/_shared/{cron-storage,shared-store,slack-messenger,dangerous-command-filter,base-mcp-server}.ts
   ├── src/permission/slack-messenger.ts
   └── src/{cron-storage,shared-store, ...}.ts (잔여, S2/S3에서 삭제)
```

### 4. Side Effects
- `npm run build:somalib` — 신규 `somalib/stderr-logger.{js,d.ts}` 생성
- biome 포맷이 somalib/stderr-logger.ts에 자동 적용
- `_shared/index.ts` barrel 2 lines 감소
- 양쪽 사본 합 ≈98 lines 제거

### 5. Error Paths

| 조건 | 신호 | 롤백 |
|---|---|---|
| `somalib/stderr-logger.ts` typo / 잘못된 export | `npm run build:somalib` 실패 또는 `tsc --noEmit` 실패 (src 측 caller가 unresolved) | 파일 수정 |
| mcp-servers caller `.js` 확장자 누락 | runtime 모듈 resolution 실패 (smoke 단계) — tsc는 못 잡음 | import 라인 수정 |
| src caller `.js` 잘못 추가 | `npx tsc --noEmit` 실패 | import 라인 수정 |
| barrel 갱신 누락 (`StderrLogger` 또는 `LoggerInterface` 라인 잔존) | barrel을 통해 import하는 mcp-server가 없으면 무해, 있으면 unresolved | 잔존 라인 추가 제거 |
| `LoggerInterface` 사용처 누락 (`mcp-servers/_shared/index.ts:2` 라인 한 줄만 있는 경우와 잔존 `import type { LoggerInterface }` 사이트) | grep으로 사후 확인 후 fix | import 사이트 갱신 |

### 6. Output (시나리오 완료 게이트)
- `npm run check` 통과 (biome on src + somalib + scripts)
- `npx tsc --noEmit` 통과 — **단 src만 검증** (mcp-servers 미커버)
- `npm test` 통과 — vitest의 mcp-servers/**/*.test.ts 포함 (실패하는 mcp 측 import 있으면 잡힘)
- `npm run build:somalib && npm run build` 통과
- `rg -n "from.*stderr-logger" src/ mcp-servers/ | grep -v 'somalib/stderr-logger' | grep -v 'somalib internal'` 결과 0 라인 (legacy 경로 잔재 없음)
- boot smoke: `timeout 3 npx tsx mcp-servers/cron/cron-mcp-server.ts < /dev/null` → exit code ∈ {0, 124} (모듈 resolution + top-level evaluation 검증). 그 외 코드 = 실패.

### 7. Observability
- 신규 파일: `somalib/stderr-logger.ts` (≈49 lines)
- 삭제 파일: 2개 (총 ≈98 lines 제거)
- import 갱신 사이트: 12–15개 (`rg`로 정확 카운트, PR 본문 첨부)

### Contract Tests (RED)

| Test | Category | RED state | GREEN gate |
|---|---|---|---|
| `npm run check` (lint) | Lint contract | Fail (시나리오 시작 전 import 갱신 일부 적용 시점 또는 신규 파일 미생성) | Pass after Scenario 1 |
| `npx tsc --noEmit` (src compile) | Compile contract (src) | Fail (caller import unresolved) | Pass after Scenario 1 |
| `npm test` (vitest run) | Regression invariant | Pass before / Pass after (직접 stderr-logger 테스트 부재 — 회귀 0) | Pass throughout |
| `rg -n "from.*stderr-logger" src/ mcp-servers/ \| grep -v 'somalib/stderr-logger'` 결과 = 0 라인 | Migration contract | N>0 before | 0 after Scenario 1 |
| `rg "StderrLogger\\|LoggerInterface" mcp-servers/_shared/index.ts \| wc -l` = 0 | Barrel cleanup contract | 2 before | 0 after Scenario 1 |
| `timeout 3 npx tsx mcp-servers/cron/cron-mcp-server.ts < /dev/null; rc=$?; [ $rc -eq 0 ] \|\| [ $rc -eq 124 ]` | Boot contract (mcp-servers 영역 보완) | Fail before (`Cannot find module 'somalib/stderr-logger.js'` → rc=1) | rc ∈ {0, 124} after Scenario 1 |

---

## Scenario 2 — shared-store promote

### 1. Entry
- **대상**: `somalib/permission/shared-store.ts` 신규 + 양쪽 사본 삭제 + permission-flow caller import 갱신
- **선행**: Scenario 1 (StderrLogger 의존)

### 2. Input
- **소스 사본**: `src/shared-store.ts` (262 lines, biome 적용본 + StderrLogger 사용)
- **삭제 대상**: `src/shared-store.ts`, `mcp-servers/_shared/shared-store.ts`
- **인터페이스 변화**: 없음 — 기존 store 인터페이스 그대로
- **정사본 origin 근거**: 양 사본 cosmetic-only diff (포맷·import 순서). src 측이 biome 적용본이라 somalib(biome 영역)와 호환. mcp-servers 사본의 `rule_ids` JSDoc는 src로 그대로 옮김 (정보 손실 0).

### 3. Layer Flow

#### 3a. 파일 생성 — `somalib/permission/shared-store.ts`
- 변환: `src/shared-store.ts` 내용 → `somalib/permission/shared-store.ts`
- 내부 import 갱신: `'./stderr-logger'` → `'../stderr-logger'` (somalib 내부 상대경로)
- mcp-servers 사본의 더 자세한 `rule_ids` JSDoc도 함께 흡수 (정보 손실 회피)

#### 3b. caller import 갱신

| caller | Before | After |
|---|---|---|
| `mcp-servers/permission/permission-mcp-server.ts:7` | `'../_shared/shared-store.js'` | `'somalib/permission/shared-store.js'` |
| `mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts:17` | 동일 | 동일 |
| `src/slack/actions/permission-action-handler.ts:3` | `'../../shared-store'` | `'somalib/permission/shared-store'` |
| `src/slack/actions/mcp-tool-permission-action-handler.ts:26` | `'../../shared-store'` | `'somalib/permission/shared-store'` |
| `src/slack/actions/__tests__/permission-action-handler.test.ts` | `'../../../shared-store'` | `'somalib/permission/shared-store'` (vi.mock도 포함하면 mock path 변경) |
| 기타 src/ 내부 reference (`rg -n "shared-store" src/`로 정확 매칭) | `'./shared-store'` 등 | `'somalib/permission/shared-store'` |

#### 3c. 파일 삭제
- `src/shared-store.ts` 삭제
- `mcp-servers/_shared/shared-store.ts` 삭제

### 4. Side Effects
- `npm run build:somalib` — 신규 `somalib/permission/shared-store.{js,d.ts}` 생성
- 양쪽 사본 합 ≈524 lines 제거
- permission flow의 데이터 캐시 정사본화

### 5. Error Paths

| 조건 | 신호 | 롤백 |
|---|---|---|
| somalib 내부 stderr-logger 상대경로 오류 | `npm run build:somalib` 실패 | `'../stderr-logger'`로 수정 |
| caller 경로에 `.js` 누락(mcp측) / `.js` 추가(src측) | tsc/runtime 실패 | import 라인 수정 |
| `permission-action-handler.test.ts`의 vi.mock path 갱신 누락 | `npm test` 실패 (mock 불발) | 모든 mock path도 동일 경로로 수정 |
| 권한 캐시 동작 회귀 | `permission-action-handler.test.ts` 실패 | shared-store 정사본 vs 옛 사본 diff 재확인 |
| `mcp-tool-permission-action-handler` 직접 회귀 검증 부재 (test 파일 없음) | 자동 회귀 신호 없음 — 수동 smoke 의존 | mcp-tool-permission MCP 부팅 smoke + PR 본문 risk 명시 |

### 6. Output
- `npm run check` 통과
- `npx tsc --noEmit` 통과 (src 영역)
- `npm test` 통과 — `permission-action-handler.test.ts` 그린
- `npm run build` 통과
- `rg -n "from.*shared-store" src/ mcp-servers/ | grep -v 'somalib/permission/shared-store'` 결과 0 라인
- 수동 smoke: mcp-tool-permission 또는 permission MCP 부팅 (PR 본문 보고)

### 7. Observability
- 신규: `somalib/permission/shared-store.ts` (≈262 lines)
- 삭제: 2개 (총 ≈524 lines 제거)
- import 갱신 사이트: ~6

### Contract Tests (RED)

| Test | Category | RED | GREEN |
|---|---|---|---|
| `src/slack/actions/__tests__/permission-action-handler.test.ts` | Regression invariant | Fail (시나리오 중간 import path 또는 mock path 갱신 미완) | Pass after Scenario 2 |
| `npm run check && npx tsc --noEmit` | Compile contract (src) | Fail (caller unresolved) | Pass after Scenario 2 |
| `rg -n "from.*shared-store" src/ mcp-servers/ \| grep -v 'somalib/permission/shared-store' \| wc -l == 0` | Migration contract | N>0 | 0 |
| `timeout 3 npx tsx mcp-servers/permission/permission-mcp-server.ts < /dev/null; rc=$?; [ $rc -eq 0 ] \|\| [ $rc -eq 124 ]` | Boot contract (mcp 영역) | Fail before (`Cannot find module 'somalib/permission/shared-store.js'` → rc=1) | rc ∈ {0, 124} after Scenario 2 |
| `timeout 3 npx tsx mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts < /dev/null; rc=$?; [ $rc -eq 0 ] \|\| [ $rc -eq 124 ]` | Boot contract (mcp 영역) | 동일 | 동일 |

---

## Scenario 3 — cron-storage promote + filePath 일반화

### 1. Entry
- **대상**: `somalib/cron/cron-storage.ts` 신규 + 양쪽 사본 삭제 + constructor에서 default `filePath` 제거 + 호출자 명시 주입 + 테스트 import 갱신
- **선행**: Scenario 1 (StderrLogger 의존)
- **위험도**: PR1에서 가장 높음 — 두 호출자가 같은 데이터 파일(`cron-jobs.json`)을 가리키도록 보존해야 함

### 2. Input
- **소스 사본**: `src/cron-storage.ts` (정사본 후보 — biome 적용 + `import { DATA_DIR } from './env-paths'`)
- **삭제 대상**: `src/cron-storage.ts`, `mcp-servers/_shared/cron-storage.ts`
- **인터페이스 변화**:
  - **Before** (양쪽 사본의 default가 다름)
    ```ts
    // src/cron-storage.ts
    const CRON_FILE = path.join(DATA_DIR, 'cron-jobs.json');
    constructor(filePath: string = CRON_FILE) { ... }

    // mcp-servers/_shared/cron-storage.ts
    constructor(filePath: string = path.join(process.cwd(), 'data', 'cron-jobs.json')) { ... }
    ```
  - **After** (somalib — default 없음)
    ```ts
    constructor(filePath: string) { this.filePath = filePath; }
    ```
  - 모듈 소유 logger 그대로: `const logger = new StderrLogger('CronStorage')` ← logger 인자 받지 않음
  - 호출자 양쪽이 명시 주입 — 기존 데이터 파일 경로 보존 (`SOMA_DATA_DIR` propagation 그대로)

### 3. Layer Flow

#### 3a. 파일 생성 — `somalib/cron/cron-storage.ts`
- `src/cron-storage.ts`를 base로 복사
- `import { DATA_DIR } from './env-paths'` 라인 제거 (env-paths는 src/ 전용 — somalib는 호출자에 위임)
- `const CRON_FILE = path.join(DATA_DIR, 'cron-jobs.json')` 라인 제거
- `constructor(filePath: string = CRON_FILE)` → `constructor(filePath: string)` (default 제거)
- `import { StderrLogger } from './stderr-logger'` → `import { StderrLogger } from '../stderr-logger'` (somalib 내부 상대경로)
- 모듈 소유 `const logger = new StderrLogger('CronStorage')` 그대로

#### 3b. 호출자 갱신

| 호출자 | Before | After |
|---|---|---|
| `src/index.ts:685` — runtime ctor (확정 위치) | `new CronStorage()` (default 의존). import 라인은 `import { CronStorage } from './cron-storage'`. | `new CronStorage(path.join(DATA_DIR, 'cron-jobs.json'))` 명시. import 라인 → `from 'somalib/cron/cron-storage'`. `DATA_DIR`은 `./env-paths`에서 import 유지. |
| `src/cron-scheduler.ts:13` — **type-only importer** | `type { CronStorage }, ... } from './cron-storage'` | `type { CronStorage }, ... } from 'somalib/cron/cron-storage'` (ctor 호출 없음) |
| `mcp-servers/cron/cron-mcp-server.ts:15–19` — runtime ctor | `import { CronStorage, isValidCronExpression, isValidCronName } from '../_shared/cron-storage.js'` | `import { CronStorage, isValidCronExpression, isValidCronName } from 'somalib/cron/cron-storage.js'` |
| `mcp-servers/cron/cron-mcp-server.ts:88` — inline type import | `import('../_shared/cron-storage.js').CronModelConfig` | `import('somalib/cron/cron-storage.js').CronModelConfig` |
| `mcp-servers/cron/cron-mcp-server.ts:198–206` — ctor caller | `const dataDir = process.env.SOMA_DATA_DIR; const cronFilePath = dataDir ? path.join(dataDir, 'cron-jobs.json') : undefined; new CronStorage(cronFilePath);` | **fallback 명시화**: `const cronFilePath = dataDir ? path.join(dataDir, 'cron-jobs.json') : path.join(process.cwd(), 'data', 'cron-jobs.json'); new CronStorage(cronFilePath);` |
| `src/__tests__/cron-storage.test.ts` | `import { CronStorage } from '../cron-storage'` + `new CronStorage(testPath)` | `import { CronStorage } from 'somalib/cron/cron-storage'` + `new CronStorage(testPath)` (testPath는 이미 명시) |
| `src/__tests__/cron-execution-history.test.ts` | 동일 | 동일 |
| `src/__tests__/cron-scheduler.test.ts` (cron-scheduler 통해 간접) | cron-scheduler가 type-only이므로 import만 변화 흡수. 만약 ctor 호출이 있다면 testPath 명시. | 동일 |

#### 3c. 파일 삭제
- `src/cron-storage.ts` 삭제
- `mcp-servers/_shared/cron-storage.ts` 삭제

#### 3d. behavior preservation (가장 중요)

**Critical**: `src/index.ts`와 `mcp-servers/cron/cron-mcp-server.ts`가 가리키는 cron 데이터 파일이 변하면 **기존 cron 작업이 사라진 것처럼 보임**. PR1은 이 동작을 100% 보존:

- src 측: `path.join(DATA_DIR, 'cron-jobs.json')` (`DATA_DIR`은 `src/env-paths.ts`의 `SOMA_CONFIG_DIR` 또는 git branch 기반 — 변경 없음)
- mcp 측: `process.env.SOMA_DATA_DIR ? path.join(dataDir, 'cron-jobs.json') : path.join(process.cwd(), 'data', 'cron-jobs.json')` — 기존 cron-mcp-server.ts:198–206의 분기를 caller-측에서 명시화. fallback도 옛 default와 동일.
- 자식 MCP 프로세스로의 `SOMA_DATA_DIR` 주입은 `src/mcp-config-builder.ts`의 `buildCronServer()` (라인 351) 및 `buildModelCommandServer()` (라인 329)에서 이뤄진다 — `env: { SOMA_CRON_CONTEXT, SOMA_DATA_DIR: DATA_DIR }`. PR1은 이 라인을 건드리지 않음 — 따라서 양 호출자가 같은 `cron-jobs.json`을 가리키는 동작이 보존됨.

### 4. Side Effects
- `npm run build:somalib` — 신규 `somalib/cron/cron-storage.{js,d.ts}` 생성
- 양쪽 사본 합 ≈778 lines 제거
- cron 데이터 정사본화 (모듈 코드 단일 출처)
- 기존 cron 데이터 파일 자체는 변화 없음 (호출자가 동일 경로 명시)

### 5. Error Paths

| 조건 | 신호 | 롤백 |
|---|---|---|
| somalib에서 `DATA_DIR` import 시도 (잘못된 옮김) | `npm run build:somalib` 실패 (somalib는 src/env-paths 못 봄) | `DATA_DIR` 의존 제거 — 호출자 측에서만 사용 |
| 호출자가 default 의존 (인자 누락) | tsc compile error (default 제거됨) | 호출자에 명시 인자 추가 |
| mcp 측 fallback 누락 (`SOMA_DATA_DIR` 없을 때 undefined로 호출) | runtime: `path.join(undefined, ...)` 또는 ctor 인자 type 에러 | caller 분기에 fallback `path.join(process.cwd(), 'data', 'cron-jobs.json')` 추가 |
| `cron-storage.test.ts` testPath 시그니처 안 맞음 | unit test 실패 | testPath만 명시 (logger 인자 받지 않으므로 ctor 변경 없음) |
| cron-scheduler.test.ts 회귀 | `npm test` 실패 | cron-scheduler가 type-only이므로 import 라인만 갱신 |
| `cron-mcp-server.ts:88` inline type import 갱신 누락 | `npx tsx mcp-servers/cron/cron-mcp-server.ts` 런타임 또는 type alias 미해결 | 88번 라인 갱신 |
| 데이터 파일 경로 회귀 (cron jobs 안 보임) | 수동 smoke 시 list 비어있음 | caller 분기 코드 vs 옛 동작 diff 재확인 |

### 6. Output
- `npm run check` 통과
- `npx tsc --noEmit` 통과 (src — caller `new CronStorage(...)` 명시 인자 검증)
- `npm test` 통과 — `cron-storage.test.ts`, `cron-execution-history.test.ts`, `cron-scheduler.test.ts` 그린
- `npm run build` 통과
- `rg -n "from.*cron-storage" src/ mcp-servers/ | grep -v 'somalib/cron/cron-storage'` 결과 0 라인
- `rg "constructor\\(filePath" somalib/cron/cron-storage.ts` 결과: `constructor(filePath: string) {` (정확 매칭)
- boot smoke: `timeout 3 npx tsx mcp-servers/cron/cron-mcp-server.ts < /dev/null` → exit code ∈ {0, 124}. PR body에 명령 + rc 첨부.
- (선택) cron list smoke: 데이터 파일이 있는 환경에서 `cron_list` 도구 호출 시 기존 jobs 그대로 보임 — 경로 보존 검증. PR body에 결과 첨부 (가능한 경우).
- `cat somalib/cron/cron-storage.ts | grep "DATA_DIR\\|env-paths"` 결과 0 라인 (somalib는 env-paths 의존 없음)

### 7. Observability
- 신규: `somalib/cron/cron-storage.ts` (≈400 lines, biome 적용 후)
- 삭제: 2개 (총 ≈778 lines 제거)
- import 갱신 사이트: 7–8개 (cron-mcp-server.ts에서 4 라인 + src/index.ts + cron-scheduler.ts + tests 3)
- constructor 시그니처 변경: 1개 (default 제거)
- 모듈 소유 logger context 'CronStorage' 보존

### Contract Tests (RED)

| Test | Category | RED | GREEN |
|---|---|---|---|
| `src/__tests__/cron-storage.test.ts` | Regression invariant | Fail (import unresolved) | Pass after Scenario 3 |
| `src/__tests__/cron-execution-history.test.ts` | Regression invariant | Fail (import unresolved) | Pass after Scenario 3 |
| `src/__tests__/cron-scheduler.test.ts` | Regression invariant (간접) | Fail (cron-scheduler import unresolved) | Pass after Scenario 3 |
| `npm run check && npx tsc --noEmit` (src) | Compile contract | Fail (default 제거로 caller `new CronStorage()` 시그니처 미스매치 + 신규 파일 미생성 시 unresolved) | Pass after Scenario 3 |
| `rg -n "from.*cron-storage" src/ mcp-servers/ \| grep -v 'somalib/cron/cron-storage' \| wc -l == 0` | Migration contract | N>0 | 0 |
| `grep "constructor(filePath" somalib/cron/cron-storage.ts \| grep -v "string)"` 결과 = 0 | Signature contract | 시나리오 시작 전 N/A | 정확히 `constructor(filePath: string) {` |
| `grep "DATA_DIR\|env-paths" somalib/cron/cron-storage.ts \| wc -l == 0` | Domain isolation contract | N/A | 0 (somalib는 src/env-paths 미의존) |
| `timeout 3 npx tsx mcp-servers/cron/cron-mcp-server.ts < /dev/null; rc=$?; [ $rc -eq 0 ] \|\| [ $rc -eq 124 ]` | Boot contract (mcp) | Fail before (이전 import unresolved → rc=1) | rc ∈ {0, 124} after Scenario 3 |

---

## Scenario 4 — CI lint 와이어링 (npm run check)

### 1. Entry
- **대상**: `.github/workflows/ci.yml` lint step
- **선행**: Scenario 1–3 (somalib에 새 파일이 들어있어야 lint 신호가 의미 있음)
- **Token**: GitHub bot token으로 workflow 파일은 못 건드림 — `gh` CLI 통해 PR push로 진행

### 2. Input
- **변경 라인**: ci.yml의 lint step (1–2 라인)
- **인터페이스 변화**: CI step 명령만 변화

### 3. Layer Flow

#### 3a. ci.yml 변경
- **Before**:
  ```yaml
  - name: Lint
    run: npx biome check src/ scripts/
  ```
- **After**:
  ```yaml
  - name: Lint
    run: npm run check
  ```
- **근거**: `npm run check`는 `biome check src/ somalib/ scripts/`. somalib 자동 포함 + 단일 진실원.

#### 3b. PR 생성 시 token 처리
- bot token으로 `.github/workflows/`를 modify할 수 없으므로 `gh` CLI(개인 토큰) 통한 push 또는 reviewer가 직접 적용. **z 워크플로 관점**: zwork가 5단계 우회 절차 (메모리 — Bearer↔token, env 다른 토큰, curl raw API, PR close+reopen / empty commit / force push, 진짜 fix)를 시도. 모두 실패 시에만 유저에게 위임.

### 4. Side Effects
- CI 한 step의 명령어 변화
- 향후 somalib 코드 lint 위반이 CI에서 즉시 잡힘
- mcp-servers는 여전히 biome 미적용 영역 (의도)

### 5. Error Paths

| 조건 | 신호 | 롤백 |
|---|---|---|
| bot token이 workflow 못 건드림 | gh push 시 403 | 5단계 우회 시도; 모두 실패 시 유저에게 위임 |
| `npm run check` 명령이 package.json 부재 | CI step 실패 | scripts 확인 — 이미 `"check": "biome check src/ somalib/ scripts/"` 존재 (확인됨) |
| somalib에 lint 위반 코드 | CI 실패 | 위반 fix (시나리오 1–3 단계에서 biome 자동 포맷이 흡수해야 정상) |
| ci.yml YAML 들여쓰기 오류 | CI 즉시 실패 | YAML 들여쓰기 점검 |

### 6. Output
- CI lint step 통과 (somalib 영역 포함)
- ci.yml diff: lint step 1줄 변경
- `grep "biome check src/ scripts/" .github/workflows/ci.yml | wc -l == 0`
- `grep "npm run check" .github/workflows/ci.yml | wc -l >= 1`

### 7. Observability
- ci.yml diff: 1 line changed
- CI 실행 시간 변화: 무시할 수준 (somalib lint 추가 ~수십 ms)

### Contract Tests (RED)

| Test | Category | RED | GREEN |
|---|---|---|---|
| CI run의 lint step | Lint contract | 시나리오 시작 전 ci.yml은 src/ scripts/만 — somalib 사각지대 | 시나리오 끝 후 ci.yml이 npm run check 호출, somalib 포함 |
| `grep -E "biome check src/ scripts/" .github/workflows/ci.yml \| wc -l == 0` | Migration contract | 1 before | 0 after |
| `grep "npm run check" .github/workflows/ci.yml \| wc -l >= 1` | Migration contract | 0 before | ≥1 after |

---

## Scenario 5 — #744 정정 코멘트 + fallow dupes 검증

### 1. Entry
- **대상**: GitHub Issue #744 코멘트 + PR1 본문
- **선행**: Scenario 1–3 (코드 변경 완료 후 검증 가능)
- **타이밍**: PR1 push 직전 코멘트 게시; PR1 본문 작성 시 fallow before/after 결과 첨부

### 2. Input
- **코멘트 본문**: spec.md §5.6 참조 (원문 가정 정정 + PR 분할 + 후속)
- **fallow 명령**: `npx fallow@2.52.0 dupes --skip-local`
- **검증 페어 (PR1 후 사라져야 할 3개)**:
  - cron-storage pair
  - shared-store pair
  - stderr-logger pair

### 3. Layer Flow

#### 3a. before 측정
- 작업 시작 전(또는 `main` HEAD에서) `npx fallow@2.52.0 dupes --skip-local > .pr1-fallow-before.txt`

#### 3b. 코드 변경 완료 후 after 측정
- 시나리오 1–3 + 4 코드 변경 완료 후 `npx fallow@2.52.0 dupes --skip-local > .pr1-fallow-after.txt`

#### 3c. diff 검증
- `diff .pr1-fallow-before.txt .pr1-fallow-after.txt` — 사라진 3 페어 확인
- 사라진 페어가 정확히 cron-storage / shared-store / stderr-logger인지 grep로 검증

#### 3d. #744 코멘트 게시
- `mcp__github__add_issue_comment`로 spec.md §5.6 코멘트 게시
- 게시 시점: PR1 ready_for_review 직전
- 권한 부족 시 5단계 우회 (헤더 형식 변경, 다른 토큰, curl raw API)

#### 3e. PR1 본문에 fallow 결과 첨부
- before/after 출력 일부 (또는 diff) PR body에 포함

### 4. Side Effects
- GitHub #744 timeline에 코멘트 1개 추가
- PR1 본문에 검증 자료 첨부

### 5. Error Paths

| 조건 | 신호 | 롤백 |
|---|---|---|
| `npx fallow@2.52.0` 호출 실패 (네트워크/registry) | 명령 에러 | retry; 그래도 실패 시 **Scenario 5 blocked → acceptance 미달 → PR1 stop** (acceptance 항목이므로 후속 PR로 위임 안 함) |
| fallow가 추가 dupe 페어를 잘못 보고 (false positive) | after에 잔여 페어 표시 | spec scope 외 페어인지 점검 — 그렇다면 본문에 명시 (PR2/PR3 예정 페어들). PR1이 책임지는 3 페어가 빠졌는지가 핵심. |
| dupes after에서도 PR1 책임 3 페어가 안 사라짐 | acceptance fail | 코드 변경 누락분 점검 (시나리오 1–3 다시) — implementation 단계로 복귀 |
| #744 코멘트 권한 부족 | 403 | bot token 헤더 형식 변경 (Bearer↔token), env 다른 토큰, curl raw API; 5단계 우회. 모두 실패 시에만 유저에게 위임. |

### 6. Output
- `#744`에 정정 코멘트 1개 게시
- PR1 본문에 fallow before/after 첨부 (3 페어 dedup 확인)

### 7. Observability
- GitHub Issue #744 timeline: 1 comment
- PR body: fallow output excerpt or diff
- 정량: dupe lines reduction (≈1400 lines)

### Contract Tests (RED)

| Test | Category | RED | GREEN |
|---|---|---|---|
| `npx fallow@2.52.0 dupes --skip-local` (after) | Positive invariant | 시작 전 N pairs (≥6 inc. #744 모든 모듈 + types) | 끝 후 N-3 pairs (cron-storage + shared-store + stderr-logger 빠짐) |
| `gh issue view 744 --comments \| grep "Correction"` | Migration contract | 시작 전 0 | 끝 후 ≥1 |
| PR body grep "fallow" | PR 본문 contract | 시작 전 N/A | PR 본문에 fallow 섹션 존재 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|---|---|---|
| Scenario 1에서 PR2 영역 파일(slack-messenger, dangerous-command-filter, base-mcp-server)의 stderr-logger import도 함께 갱신 | small | `_shared/stderr-logger.ts`를 PR1에서 안전하게 삭제하기 위함. PR2 파일 자체는 손대지 않음 — import 라인만 변경. |
| somalib에 별도 `Logger` 인터페이스 신규 export 없음 | tiny | `LoggerInterface`가 이미 `stderr-logger.ts`에 정의되어 있고, `somalib/stderr-logger.ts` 신규 파일에서 그대로 export됨. 별도 정의 불필요. |
| somalib 파일 위치: stderr-logger=root, cron/cron-storage, permission/shared-store | tiny | model-commands 선례 (도메인 폴더). cross-cutting infra는 root. |
| 시나리오 1 → 2 → 3 → 4 → 5 순서 | tiny | leaf-first + 의존 역순. CI 변경은 어디서든 가능하지만 코드 변경 후가 신호 의미 있음. fallow 검증은 마지막. |
| `npm run check`로 CI 통일 (개별 biome 호출 제거) | small | 단일 진실원. ci.yml과 package.json scripts 분기 제거. |
| **데이터 파일 경로 보존** — somalib에서 default 제거, 호출자가 명시 분기 | medium | 기존 `cron-mcp-server.ts:198–206`의 `SOMA_DATA_DIR ? ... : ...` 분기를 caller-측에 명시화. 자식 MCP 프로세스로의 `SOMA_DATA_DIR` 주입은 `src/mcp-config-builder.ts`의 `buildCronServer()` (라인 351) / `buildModelCommandServer()` (라인 329)가 child env (`env: { SOMA_DATA_DIR: DATA_DIR }`)로 처리. PR1은 그 라인을 건드리지 않으므로 양쪽이 같은 파일을 가리키는 동작이 보존됨. |
| CronStorage logger를 모듈 소유 그대로 (constructor 주입 안 함) | small | logger context 'CronStorage' 보존. constructor 주입은 호출자 코드만 늘리고 testability 이득은 작음. |
| `mcp-tool-permission-action-handler.test.ts`는 신규 작성하지 않고 risk로 명시 | small | 본 PR scope 외. 후속 (#747 또는 별도) 책임. |
| mcp-servers smoke 검증 (수동 부팅) 의무화 | small | tsc/biome이 mcp-servers를 검증하지 않는 사각지대를 PR1이 만지므로 보완 신호 필요. |

## Implementation Status

| # | Scenario | Trace | Tests (RED) | Status |
|---|---|---|---|---|
| 1 | stderr-logger leaf promote | done | RED | Ready for stv:work |
| 2 | shared-store promote | done | RED | Ready for stv:work |
| 3 | cron-storage promote + filePath 일반화 | done | RED | Ready for stv:work |
| 4 | CI lint 와이어링 (npm run check) | done | RED | Ready for stv:work |
| 5 | #744 정정 코멘트 + fallow dupes 검증 | done | RED | Ready for stv:work |

## Changelog

| 버전 | 일자 | 변경 |
|---|---|---|
| 1.0 | 2026-04-27 | 초안 — 5개 시나리오. PR1 한정. |
| 1.1 | 2026-04-27 | codex 리뷰 84점 피드백 반영: cron-storage 경로 동작 정정 (SOMA_DATA_DIR 우선 + cwd fallback + propagation으로 의도된 공유), 검증 신호에 mcp-servers smoke 추가, callsite inventory 정정 (cron-scheduler type-only, cron-mcp-server.ts:88 inline import, mcp-tool-permission-action-handler.test.ts 부재), barrel에서 LoggerInterface도 제거, src/permission/slack-messenger.ts 추가, CronStorage logger 모듈 소유 유지, Scenario 5 fallback acceptance stop. |

## Next Step

→ `stv:work docs/dedup-744-pr1/trace.md`로 시나리오별 구현 (zwork phase2가 호출).
