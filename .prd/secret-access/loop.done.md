# secret-access — done (append-only)

Loop: ./loop.md · 라운드를 닫을 때마다 맨 아래에 블록 하나를 붙인다. 위쪽은 바꾸지 않는다(`loop-lint.py` C2). 행은 옮긴 시점의 스냅샷이다.

## R1–R2 — closed 2026-11-18

- WU0–WU3 ✅ 머지 · result: 설계 문서 · 비밀 탭 · 3버튼 비밀 사용 승인 · 서버 도구 탭이 main에 들어감 · closed rows: WU0 WU1 WU2 WU3 · PR: #1341 #1342 #1343 #1345 (리뷰 후속 #1346, 핸드오프 #1347)

### Closed rows

| ID | WU | Status | 이슈 | 브랜치 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|---|
| WU0 | 설계 문서 | ✅ PR #1341 머지 | #1336 | `docs/secret-access-prd` | `.prd/32` · `33` · `secret-access/` | PR 머지 |
| WU1 | 비밀 관리자 + 감사 원장 + 비밀 탭(목록 · 추가 · 덮어쓰기 · 삭제) | ✅ PR #1342 머지 (+ 리뷰 후속 #1346) | #1337 | `feat/secret-access-store-tab` | 33 §7 WU1 | 32 A7 · A8 · A9 |
| WU2 | 비밀 grant + 판정 ③ + 3버튼 카드 + 비밀 탭 권한 편집 | ✅ PR #1343 머지 (리뷰 P1 3건 수정 후) | #1338 | `feat/secret-access-grants` | 33 §7 WU2 | 32 A1–A6 |
| WU3 | 서버 도구 탭 + 카탈로그 + config.json 수준 쓰기 | ✅ PR #1345 머지 (리뷰 P1 1건 수정 후) | #1339 | `feat/secret-access-server-tools-tab` | 33 §7 WU3 | 32 A10 · A11 |

### Round section (as it was in loop.md)

## 라운드 1 — 문서 · 에픽 · WU1부터

계획: WU0(이 문서들) PR → 에픽 #1335 + 서브이슈 #1336–#1340 (만듦, 2026-11-18) → WU1 → WU2 · WU3 → WU4(dev 배포 · 실측). WU 하나 = 브랜치 하나 = PR 하나.


## 라운드 1 결과 (2026-11-18)

- WU1–WU3 구현 · 테스트 · 문서 끝, PR로 쌓임: #1342(main) ← #1343 ← #1345. 각 PR 본문 첫 절에 calldiff.
- WU3 증거: 라우트 7 · 탭 11 · 카탈로그 계약 · permission-map 8 테스트, 만진 스위트 226/226, `npm run build` 0, 브라우저(모의 API) 관리자 · 표 없음 · 읽기 전용 · 비어드민(탭 안 보임) 확인.
- 전체 `vitest run` 22520 통과. 실패 1건 `src/a2t/__tests__/a2t-available-memory`는 호스트 메모리를 읽는 기존 실패(`src/a2t` main과 동일).

## 라운드 2 결과 (2026-11-18) — 머지 · 리뷰 반영

- 머지: #1341 · #1342 · #1343 · #1345 (머지 커밋, 쌓인 PR은 아래가 머지된 뒤 base를 main으로 옮김).
- Review of Legends 필수 리뷰 P1 — 머지 전에 고침:
  - #1343: 동시 거부(병렬 도구 호출) 때 카드 · 알림 중복 → 배달을 첫 await 전에 동기적으로 잡음. 거부 뒤 다시 연 요청이 같은
    requestId라 옛 카드 버튼이 새 요청을 결정 → 버튼 · 대시보드 id에 라운드(`createdAt`)를 싣고 다르면 거절. 허락이 grant
    저장 전에 기록 → 클레임(`settled:false`) 후 grant, 실패하면 이번에 더한 grant를 되돌리고 요청을 다시 엶. 카드 비밀 목록
    3,000자 제한.
  - #1345: 마지막 도구 수준을 지우면 `permission: {}` → 로더가 버려 server-tools가 모두에게 열림(#1170) → 409로 막음. 모든
    변경 핸들러가 감사 경고를 보여 줌.
- #1342(머지 뒤) 리뷰 P2 실결함 → #1346: 줄바꿈뿐인 값, config 파싱 오류 메시지가 설정 텍스트(자격증명)를 로그로 옮김,
  `null` 원장 줄이 비밀 탭 500, 필터 입력이 초안을 지움, 삭제 디렉터리 fsync, stat 실패 시 마지막 절 유지.
- 핸드오프: #1347 — config.json을 읽는 나머지 리더의 파싱 오류 로그 전수 정리.
