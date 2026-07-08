# 설정 규칙 — 단일 출처 · 원자적 저장

`auth.md`(API 인증 단일 경로)의 자매 규칙. 대상은 **런타임 설정(env·파일)** 과 **상태 영속(JSON store)**.
현재 이 둘이 repo 최대의 횡단 부채다(증거: `docs/current/spec/architecture-map.md` §B).

## 절대 규칙

1. **`process.env.*` 를 도메인 코드에서 직접 읽지 않는다.** 모든 env 접근은 단일 설정 모듈을 거친다. 새 env 변수는 거기에 타입드 getter로 1회만 선언한다.
2. **경로 해석은 `@soma/common/env-paths` 한 곳만.** `DATA_DIR`/`CONFIG_FILE`/`ENV_FILE` 등은 여기서만 계산한다. 두 번째 구현 금지(현재 `@soma/process-shared/src/env-paths.ts`가 **분기된 사본** — 제거 대상).
3. **JSON 상태 저장은 원자적이어야 한다.** 라이브 파일에 `writeFileSync` 직접 금지. 공용 `atomicWriteJson`(temp write → `renameSync`)만 사용한다.
4. **로드 실패를 조용히 빈값으로 떨어뜨리지 않는다.** `JSON.parse` catch는 최소 WARN 로그 + `.bak` 폴백. "조용히 0 반환"은 데이터 전손이다.
5. **env 변수 이름은 `SOMA_` 프리픽스로 통일.** 신규 변수에 비프리픽스명 금지(`BASE_DIRECTORY` vs `SOMA_BASE_DIRECTORY` 류 충돌 재발 방지).

## 단일 경로

```
환경/파일                         타입드 설정 모듈            도메인 코드
.env / process.env  ─┐
config.json          ├─► @soma/common/env-paths ─► config accessor ─► 소비자
SOMA_* 변수          ─┘   (경로·dotenv·branch)      (타입·검증·기본값)   (직접 env 읽기 금지)

상태 저장: 도메인 ─► atomicWriteJson(path, data) ─► tmp → renameSync  (+로드시 .bak 폴백)
```

## 적용 범위

| 용도 | 올바른 방식 | 위치 |
|------|------------|------|
| 경로(DATA_DIR 등) | `import { DATA_DIR } from '@soma/common/env-paths'` | env-paths (단일) |
| env 플래그 파싱 | `parseBool` 등 공용 파서 경유 | config.ts |
| 신규 env 변수 | 설정 모듈에 타입드 getter 1회 선언 후 import | config accessor |
| 상태 영속 | `atomicWriteJson` / 원자적 store 베이스 | 공용 store 헬퍼 |

## 새 설정/저장 추가 시

1. env 변수가 필요하면 → 설정 모듈에 `SOMA_`-프리픽스 getter 추가, 소비처는 그 getter만 import.
2. 디스크에 상태를 쓰면 → `atomicWriteJson` 사용, 로드에 `.bak` 폴백 추가.
3. 경로가 필요하면 → `@soma/common/env-paths`에 추가. 절대 두 번째 env-paths를 만들지 않는다.

## 현재 위반 (마이그레이션 대상)

- `@soma/process-shared/src/env-paths.ts` — common과 **다른** DATA_DIR 로직. common 재export로 교체.
- `process.env.*` 직접 읽기가 도메인 전반에 산재 — 설정 모듈로 흡수 (현재 수치는 아래 §검증).
- `writeFileSync`가 여러 곳 비원자적 (`session-registry.ts:1901`, `user-skill-grants-store.ts:66`, `user-settings-store.ts:393` 등) — `atomicWriteJson` 도입 후 일괄 교체.

## 검증

```bash
# 1) env-paths 는 단일 구현 (재export 제외 본체는 @soma/common 하나뿐이어야)
rg -l "execSync|SOMA_CONFIG_DIR" packages/*/src/env-paths.ts src/env-paths.ts
#    → packages/common/src/env-paths.ts 한 줄만 나와야 한다.

# 2) 도메인 코드의 직접 env 읽기 (감소가 목표; 신규 0)
rg -n "process\.env\." src --type ts -g '!*.test.ts' -g '!config*.ts' -g '!env-paths.ts' | wc -l

# 3) 라이브 파일 비원자적 쓰기 (atomicWriteJson 도입 후 0 수렴)
rg -n "writeFileSync\(" src packages somalib --type ts -g '!*.test.ts' | rg -v "atomicWriteJson|\.tmp" | wc -l
```

계약 테스트로 고정: `config-single-source.contract.test.ts` — (a) env-paths 본체 1개, (b) 신규 PR이 `process.env` 직접 읽기를 늘리지 않음(베이스라인 카운트 스냅샷), (c) 등록된 store가 전부 `atomicWriteJson` 경유. ADR 0002 `boundary.test.ts`와 동일한 "CI에서 깨지는 경계" 방식.
