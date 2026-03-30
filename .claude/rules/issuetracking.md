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

## phase:review event 이슈 처리

`bd set-state <id> phase=review`를 실행하면 자식 event 이슈가 자동 생성된다.
이 event 이슈는 **실제 코드 리뷰 게이트** 역할이다.

### 리뷰 절차

1. event 이슈의 부모를 확인하고, 부모의 변경 사항(커밋, diff)을 실제 코드 리뷰한다
2. 리뷰 항목:
   - 변경된 코드가 이슈의 AC(Acceptance Criteria)를 충족하는가
   - 테스트가 통과하는가 (`npx vitest run`, `npx tsc --noEmit`)
   - 보안/품질 이슈가 없는가
3. 리뷰 통과 시: event 이슈를 닫고 (`bd close <event-id> --reason "리뷰 근거"`), 부모도 닫는다
4. 리뷰 실패 시: `bd set-state <parent-id> phase=coding --reason "피드백 내용"`으로 되돌린다

### 주의

- **event 이슈를 리뷰 없이 닫지 말 것** — 이것이 존재하는 이유는 리뷰 강제
- `bd ready`에 event 이슈가 보이면 리뷰가 밀려있다는 의미
- 부모가 이미 closed인 orphan event는 정리 가능 (이미 배가 떠남)

## 규칙

- **구현 완료 시 바로 `bd close` 하지 말 것** — 반드시 `phase=review` 거쳐야 함
- 리뷰 대기 목록: `bd list --status=in_progress --label phase:review`
- 리뷰에서 수정 필요 시: `bd set-state <id> phase=coding --reason "피드백 반영"`
- Work is NOT complete until `git push` succeeds
