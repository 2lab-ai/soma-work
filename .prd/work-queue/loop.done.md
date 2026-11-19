# work-queue — done (append-only)

Loop: ./loop.md · Each round close appends one block at the bottom; nothing above it ever changes (`loop-lint.py` C2 compares against git). Rows here are snapshots (Last Measured frozen at move time). A later pass is a `re-verified` line in a loop.md round section; a regression reopens as a new loop.md row with Source `regression:<ID>`.

## R1 — closed 2026-11-19

- measured 9✅ · result: one keyed work queue merged (PR https://github.com/2lab-ai/soma-work/pull/1380, merge `b489d453`) and deployed to the owner dev host (v0.3.97-dev) · closed rows: W1–W8, G1 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1380

### Closed rows

| ID | 작업 단위 | Status | 증거 |
|---|---|---|---|
| W1 | 원장: keys · config · ledger · store (`somalib/work-queue`, process-shared 재export) | ✅ | 원장 48 GREEN. 저장소는 R3 리뷰 뒤 `node:sqlite`(트랜잭션 하나 · OS 잠금)로 교체, 4개 프로세스 동시 쓰기 60/60 유실 0(8회 반복) |
| W2 | MCP 서버 `work-queue` + 리졸버 · config builder · 패키지 등록 | ✅ | MCP 18 + e2e GREEN. 배포된 바이너리 두 스레드 실측: running → CONFLICT(wq-1) → queued #1 → 다른 레인 독립 → NOT_HOLDER → done이 wq-2로 넘김 |
| W3 | 호스트 `WorkQueueHost`(`src/work-queue/host.ts`) + index.ts 조립 | ✅ | host 19 GREEN. 소유자 dev 호스트에서 `data/work-queues.sqlite3`(WAL) 생성 확인 |
| W4 | 옛 장치 제거: #726 게이트 · v1 `env-run-queue` | ✅ | 옛 카드 버튼 "만료" 응답 테스트 GREEN |
| W5 | hand-off 추적 + 끝 = `whenFree` · 목표 루프 · 후속 질문 술어 | ✅ | hand-off 48 GREEN |
| W6 | 보드: `queueWait` · 보라 태그 · i18n | ✅ | 보드 테스트 GREEN (화면 실측은 loop.md W9c) |
| W7 | 레인 소비자: `deploy.prompt` · `deploy-qa` · RUN_ENV_SKILL · CLAUDE.md · architecture.md | ✅ | 프롬프트 · 스킬 계약 테스트 GREEN |
| W8 | 게이트: tsc · biome · vitest · Lean · 리뷰 · PR | ✅ | CI 최종 head `ec89fa99`: quality-gates · lean-verify · scan · review-of-legends 전부 통과. 리뷰 R1(독립 9건) · R2(봇 10건) · R3(봇: 설정 · 잠금) 반영 |
| G1 | v1 PR의 기준선 밖 실패 테스트 | ✅ | 원인 확인: env-skill-handoff-host 6건은 v1 싱글턴 큐 탓 → v1 제거로 해소. 나머지(display-lang · incident-ingress)는 병렬 부하 타임아웃 · main에서도 같은 실패(기준선) |

### Round section (as it was in loop.md)

라운드 1 — 원장 · MCP · 호스트 · 옛 장치 걷어내기. 리뷰 라운드: R1 독립 리뷰(재시작 유예 · 미통지 차례 · 큐 이름 정규화 · 늦은 답 재확인 · hand-off 경합 · 잠금 탈취 · deliver 계약 · stamp) → R2 리뷰 봇(설정 재읽기 실패를 "큐 없음"으로 캐시 · 레코드 검증 · 동시 프로세스 테스트) → R3 리뷰 봇(잠금 PID 재사용 · 복구 경합 → 저장소를 `node:sqlite`로 교체, `workQueues: []` 옛 끄기 보존) → CI Node 20(`node:sqlite` 없음) → 그런 런타임은 큐를 끄고 `QUEUE_UNAVAILABLE`, 호스트 · MCP 테스트는 메모리 저장소. sanitize: 예시 Jira 키 형식이 금지 패턴이라 브랜치 히스토리를 `ABC-n`으로 고쳐 씀.
