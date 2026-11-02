# 22 — 작업 카드의 연결: 이슈 · PR · 위키와 그 상태를 기본으로

> 한 줄 결론: 모든 작업 카드는 기본으로 현재 작업 바로 아래에 "연결" 줄을 보여 준다. 연결된 이슈(Jira · GitHub)와 이슈 상태, 연결된 PR과 머지 상태, 연결된 위키가 칩으로 뜨고, 칩을 누르면 그 페이지가 새 탭으로 열린다.

## 0. 미니맵

```
22 작업 카드의 연결
├─ 1. 지시 (원문)
├─ 2. 결정            ─ 줄 하나 · 순서 · 상태 말 · PR 칩 끔 · 빠진 항목 규칙
├─ 3. 데이터          ─ cardLinksOf (src/conversation/card-links.ts) · 상태의 출처 · 백그라운드 갱신
├─ 4. 화면            ─ @2lab.ai/ui 0.19.0 card.links · 펼친 카드 · 편집기 · 스레드 카드
├─ 5. 기존 레이아웃   ─ 저장된 유저에게도 새 줄이 켜진 채 나타나는 이유
├─ 6. 구현 지도
└─ 7. 검증            ─ 단위 테스트 · 실서버 하네스 L1–L8
```

이 문서를 읽는 법: 무엇이 기본인지는 §2, 상태가 어디서 오는지는 §3, 이미 레이아웃을 저장한 유저에게 무엇이 바뀌는지는 §5를 본다.

## 1. 지시 (SSOT 2026-11-02, 원문)

> 작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은 깃허브 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들

## 2. 결정

- **줄 하나.** 카드 면에 "연결" 줄(`links`)을 더한다. 이슈, PR, 위키를 칩 하나씩으로 보여 준다. 칩은 짧은 참조(`PAY-12`, `#41`, `#733`, 위키 제목)와, 이슈와 PR이면 상태를 말로 쓴다. 색만으로 상태를 말하지 않는다.
- **기본 켜짐.** 1 · 2 · 3안의 미니멀과 어드밴스드, 여섯 프리셋 모두에서 켜져 있고 자리는 현재 작업 바로 아래다. 편집기(설정 › 대시보드 화면)에서 다른 줄처럼 끄거나 옮길 수 있다.
- **순서.** 먼저 종류마다 지금 것 하나(현재 연결된 이슈 · PR · 위키, 없으면 가장 최근 것)를 이슈, PR, 위키 순으로 쓴다. 그다음 나머지를 종류별로 최신순으로 쓴다. 이슈가 아무리 많아도 지금 PR과 위키가 면의 앞 칩에 남는다. 같은 URL은 한 번만 쓴다. 서버는 최대 20개를 보내고, 나머지 칸은 종류마다 하나씩 돌아가며 나눈다. 면은 6개를 그린 뒤 `+N`을 붙인다.
- **상태 말.**

  | 종류 | 원래 값 | 칩 | 톤 |
  |---|---|---|---|
  | PR | open · draft · merged · closed | 열림 · 초안 · 머지됨 · 닫힘 | run · (없음) · done · fail |
  | GitHub 이슈 | open · closed | 열림 · 닫힘 | run · done |
  | Jira 이슈 | 상태 이름 그대로 (`In Progress`, `Done`, `검토 중`) | 그대로 | 완료류 done · 리뷰/대기류 wait · 진행류 run · 그 밖은 없음 |
  | 위키 | — | 제목만 | — |

- **칩은 링크다.** `<a target="_blank" rel="noopener noreferrer">`이고 카드를 열거나 닫지 않는다. http(s) URL만 받는다.
- **PR 칩은 기본으로 끈다.** 맨 아래 오른쪽의 PR 칩(`pr`)은 연결 줄과 같은 PR을 두 번 보여 주므로, 모든 기본 프리셋에서 끈다. 칩 자체는 편집기에 남는다.

## 3. 데이터 (`src/conversation/card-links.ts`)

- 보드 JSON의 카드마다 `cardLinks: CardLink[]`가 붙는다(`KanbanSession.cardLinks`). `CardLink = { kind: 'issue' | 'pr' | 'wiki', url, text, title?, status?, tone? }`.
- 출처는 세션의 `links`(`issue` · `pr` · `doc`)와 `linkHistory`(`issues` · `prs` · `docs`)다. 문서 링크(`doc`: Confluence, Notion 등)가 위키다.
- 상태는 기다리지 않고 지금 가진 것 중 가장 새것을 쓴다.
  - PR: 슬랙 스레드의 실시간 확인(`actionPanel.prStatus`. 그 URL을 확인했고 그 뒤로 링크가 다시 기록되지 않은 경우, `ActionPanelBuilder.livePrStatus`와 같은 검사) → 링크 메타데이터 캐시(`peekLinkMetadata`) → 링크에 기록된 상태. 머지는 되돌아가지 않으므로, 셋 중 하나라도 머지면 머지됨이다. 그래서 세션이 쉬는 사이 머지된 PR도 예전 "열림" 확인에 가려지지 않는다.
  - 이슈: 캐시 → 기록된 상태.
- **백그라운드 갱신(`warmLinkMetadata`).** 보드를 그릴 때 캐시가 없거나 오래된 GitHub · Jira 이슈와 PR을 백그라운드에서 가져온다. 보드는 기다리지 않고, 다음 보드가 새 상태를 그린다. 보관된(종료된) 카드는 가져오지 않고 캐시와 기록만 쓴다.
  - 얼마나 자주: URL마다 5분(TTL)에 한 번. 머지된 PR은 다시 가져오지 않는다. 닫히거나 끝난 이슈와 닫힌 PR은 한 시간에 한 번이다. 실패한 URL도 그 시간 안에는 다시 가져오지 않는다.
  - 얼마나 많이: 모든 보드를 합쳐 한 번에 8개까지 동시에, 1분에 40개까지, 보드 한 번에 8개까지다. 응답이 15초 안에 없으면 그 자리를 비워 다음 요청이 쓴다.
  - 캐시는 `fetchLinkMetadata`만 쓴다. 거절되거나 빈 응답(권한, 요청 한도)은 마지막으로 받은 좋은 답을 지우지 않는다. 네트워크 오류가 난 백그라운드 요청은 기록된 옛 상태를 새 상태처럼 캐시에 넣지 않는다.

## 4. 화면

- **카드 면** — `@2lab.ai/ui` 0.19.0 `<ui-agent-inbox>`의 `card.links`가 그린다(`INBOX_ROWS`: summary · task · links · agents · usage · artifacts). 칩을 누르면 `ui-link { cardId, href, kind }` 이벤트가 나고, 카드는 토글되지 않는다. 대시보드는 `cardLinksFace(s)`로 `cardLinks`를 칩으로 바꾼다. 툴팁은 `종류 참조 — 제목 · 상태`다.
- **펼친 카드** — 이슈 · PR 링크 부분(`refs`)이 같은 링크를 상태와 함께 보여 준다(`card-ref`). `cardLinks`가 없는 예전 보드에서는 예전처럼 이슈 · PR 짧은 참조를 쓴다.
- **편집기** — 본문 줄에 "연결 — 이슈 · PR · 위키"가 있다. 미리보기 카드에 견본 연결(PAY-12 In Progress, #700 열림, 위키)이 있어서 켜고 끄는 결과가 바로 보인다.
- **스레드 카드(슬랙)** — "태스크 카드 따라감"일 때, 연결 줄이나 PR 칩 중 하나라도 켜져 있으면 링크 줄에 링크 기록(`linkhistory`)이 켜진다. 서버(`followThreadLayout`)와 편집기 미리보기가 같은 결과를 낸다.

## 5. 기존 레이아웃

- 예전 규칙(.prd/21 §3)은 저장된 목록에 없는 항목을 "끈 채로 끝에" 붙였다. 그러면 연결 줄은 이미 레이아웃을 저장한 유저에게 꺼진 채로 나타나서, 지시("디폴트로 표시")를 어긴다.
- 새 규칙: 저장된 레이아웃(`presets`)에 없는 항목은 **기본 프리셋의 상태로, 기본 프리셋에서 바로 앞에 있던 항목 뒤에** 들어간다. 그래서 저장한 유저도 연결 줄이 현재 작업 아래에 켜진 채로 보인다. 저장된 항목의 순서와 켜짐은 그대로다.
- 예외: "따로 설정"한 스레드 카드와, 면에서 옮겨 만든 목록(`followThreadLayout`의 정보 줄)은 유저가 고른 것만 담으므로, 없는 항목을 예전처럼 끈 채로 끝에 붙인다.
- 저장된 PR 칩은 저장된 대로 둔다. 레이아웃을 저장하면서 PR 칩을 켜 둔 유저는 PR이 두 번 보일 수 있고, 편집기에서 끌 수 있다.

## 6. 구현 지도

| 파일 | 바뀐 것 |
|---|---|
| `src/conversation/card-links.ts` (새) | `cardLinksOf`, `linkState`, `CardLink` |
| `src/link-metadata-fetcher.ts` | `peekLinkMetadata`, `warmLinkMetadata` |
| `src/conversation/dashboard.ts` | `KanbanSession.cardLinks`(`liveCardLinks` · `archivedCardLinks`), 클라이언트 `cardLinksFace` → `card.links`, 펼친 카드의 refs, 상태 CSS |
| `src/view-layout.ts` | `CARD_ROWS`에 `links`, 여섯 프리셋에서 켜짐, PR 칩 끔, 카탈로그 항목, `items(…, missing)`, `followThreadLayout` |
| `src/conversation/view-layout-client.ts` | 클라이언트 쪽 같은 변환 |
| `src/conversation/settings-layout-tab.ts` | 미리보기 견본 연결 |
| `package.json` | `@2lab.ai/ui` 0.17.0 → 0.19.0 (2lab-ai/ui#9, #10) |
| `scripts/screenshot-card-links.ts` (새) | 실서버 하네스 |

## 7. 검증

- 단위 테스트:
  - `card-links.test.ts` K1–K4(지금 것 먼저인 순서와 공정한 나머지 칸, 짧은 참조, 상태의 출처와 머지 우선, 다시 기록된 링크의 실시간 확인 무시, 상태 말과 톤).
  - `link-metadata-fetcher.warm.test.ts` W1(캐시를 나이와 상관없이 읽음), W2(없거나 오래된 GitHub · Jira 이슈와 PR만 백그라운드로, URL마다 TTL 안에 한 번, 실패해도 다시 안 감, 보드마다 몇 개만), W3(모든 보드에 걸친 동시 수와 분당 예산, 머지된 PR은 다시 안 가져옴, 끝난 상태는 한 시간에 한 번), W4(빈 응답이 좋은 답을 지우지 않음, 실패한 백그라운드 요청이 기록된 상태를 쓰지 않음).
  - `view-layout.test.ts` L2(빠진 항목 규칙), L6(연결 줄 기본값과 스레드 카드 변환).
  - `dashboard-card-links-client.test.ts` C1(칩 변환, `ui.dashboardheader`가 links를 숨기면 없음), C2(모든 기본 면에 연결 줄이 현재 작업 바로 뒤, PR 칩 없음; 줄을 끈 레이아웃엔 없음), C3(펼친 카드 refs).
- 실서버 하네스 `scripts/screenshot-card-links.ts`. 보드를 목으로 넣지 않는다. 실제 로그인, 실제 세션 → `sessionToKanban` → `cardLinksOf`, 실제 캐시, 실제 설정 저장소(레이아웃을 저장한 적 없는 유저)를 쓴다.
  - L1: 편집기에서 연결이 기본 켜짐이고 현재 작업 바로 뒤다. PR 칩은 꺼져 있다.
  - L2–L3: 기본 카드 면에 `PAY-12 In Progress`, `#733 열림`, `결제 폼 설계`, `#41 닫힘`, `#700 머지됨`이 이 순서로 뜬다.
  - L4: 칩은 새 탭 링크이고, 눌러도 카드가 열리지 않는다.
  - L5: 연결이 없는 카드에는 줄이 없다. PR이 두 번 나오지 않는다.
  - L6: 펼친 카드의 refs에 같은 링크와 상태가 있다.
  - L7: PR이 머지되면(스레드의 실시간 확인) 다음 보드에 `#733 머지됨`이 뜬다.
  - L8: 390px에서 옆으로 스크롤되지 않는다.
