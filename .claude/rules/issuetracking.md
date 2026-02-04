# Issue Tracking (bd)

## Lifecycle

```
open → in_progress → phase:review → closed (with evidence)
```

| 단계 | 명령 | 의미 |
|------|------|------|
| 작업 시작 | `bd update <id> --status in_progress` | 코딩 시작 |
| 리뷰 전환 | `bd set-state <id> phase=review --reason "구현 요약"` | 구현 완료, 리뷰 대기 |
| 리뷰 통과 | `bd close <id> --reason "근거"` | **반드시 근거 기재** |

## close 시 필수 근거 (--reason)

아래 중 해당하는 항목을 `--reason`에 명시:

- **테스트**: 통과한 테스트 결과 (예: "vitest 458 passed, 0 new failures")
- **빌드**: 컴파일 성공 여부 (예: "tsc --noEmit clean")
- **코드 리뷰**: 누가 리뷰했는지 (예: "Oracle agent reviewed, feedback addressed")
- **변경 범위**: 변경된 파일과 라인 수 (예: "5 files, +491 lines")
- **수정 없는 경우**: 왜 불필요한지 (예: "config-only change, no logic")

```bash
# 올바른 예시
bd close <id> --reason "tsc clean, vitest 458 passed (0 new), Oracle reviewed, 3 files +24 lines"

# 잘못된 예시
bd close <id> --reason "done"
bd close <id> --reason "구현 완료"
```

## 규칙

- **구현 완료 시 바로 `bd close` 하지 말 것** — 반드시 `phase=review` 거쳐야 함
- 리뷰 대기 목록: `bd list --status=in_progress --label phase:review`
- 리뷰에서 수정 필요 시: `bd set-state <id> phase=coding --reason "피드백 반영"`
- Work is NOT complete until `git push` succeeds
