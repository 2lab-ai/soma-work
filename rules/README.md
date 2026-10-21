# rules/ — 반복 적용되는 패턴 규칙

`CLAUDE.md`가 "무엇을 할 때마다 지켜라"의 진입점이라면, `rules/`는 **그 규칙의 본문**이다.
각 룰은 단일-출처/단일-경로 철학을 한 횡단 관심사에 박아둔다. 새 코드는 해당 룰을 먼저 읽는다.

| 룰 | 무엇을 고정하나 | 언제 읽나 |
|---|---|---|
| [auth.md](auth.md) | Claude **API 인증** 단일 경로 (Agent SDK `query()`만) | LLM 호출 추가 시 |
| [permission.md](permission.md) | **인가(도구 허용/거부)** 단일 결정 파이프라인 | 권한 분기·grant·classifier 손댈 때 |
| [config.md](config.md) | **설정(env·파일)** 단일 출처 + **상태 저장** 원자성 | env 변수·config·JSON store 추가 시 |
| [packaging.md](packaging.md) | **`@soma/*` 패키지 경계** — 추출은 이동(복사 금지), 이중 출처 해소 | 공유 코드 추가·패키지 이동 시 |
| [build.md](build.md) | 빌드·테스트·품질 게이트 | 커밋 전 |
| [deploy.md](deploy.md) | 배포 절차 | 배포 시 |
| [issuetracking.md](issuetracking.md) | 이슈 추적 | 이슈 작업 시 |
| [pattern.cleanup.md](pattern.cleanup.md) | repo-root/docs 정리 | 문서 이동 시 |
| [pattern.doc.md](pattern.doc.md) | 문서 작성 패턴 | 문서 작성 시 |
| [pattern.test.md](pattern.test.md) | 테스트 패턴 | 테스트 작성 시 |

현행 구조 맵: [`docs/current/spec/architecture-map.md`](../docs/current/spec/architecture-map.md).
아키텍처 결정: [`docs/adr/README.md`](../docs/adr/README.md).

## 룰 작성 규칙

새 룰은 `auth.md`/`config.md` 형식을 따른다: **절대 규칙 → 단일 경로(다이어그램) → 적용 범위(표) → 새 기능 시 → 현재 위반 → 검증(실행 가능한 `rg`/계약 테스트)**.
검증 없는 룰은 위조 가능한 다짐일 뿐이다 — 모든 룰은 CI에서 깨질 수 있는 계약 테스트를 지정한다(ADR 0002 `boundary.test.ts` 방식).
