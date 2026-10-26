# affectUI Model Picker → 대시보드 모델 · effort 선택기

Status: 계약(Phase A) · 작성 2026-10-26 · 기준 main `ff6c9ac` · 에픽 #437 / 서브이슈 #442 · SSOT [`ssot.md`](ssot.md)
앞선 계약: [`../13-dashboard-three-surfaces-spec.md`](../13-dashboard-three-surfaces-spec.md) §3.1(모델 · effort의 집 — 펼친 카드 컨트롤 줄, 패널 입력창 옆),
SSOT 2026-10-22 T4/T5(대표 모델 전환 · compact 후 전환), 2026-10-23 T1(세션 effort) · T6(상단 기본값 칩)

## 0. 한 줄 정의

레퍼런스는 "다음 메시지를 어느 모델로, 얼마나 생각하게 보낼지"를 **보내기 전에 대가(속도·품질·가격)를 보면서** 한 메뉴에서 고르게 한다.
대시보드에서 이 결정은 **세션 하나의 모델 · effort**다 — 펼친 카드의 컨트롤 줄과 패널 입력창 옆(`renderModelPicker` · `renderEffortPicker`
×2 서피스). 지금은 네이티브 `<select>` 두 개라 모델끼리 무엇이 다른지(창 · autocompact · 가격) 보이지 않는다. 같은 트리거 → 메뉴 하나로
바꾸고, 막대와 트레이에는 **대시보드가 실제로 아는 숫자만** 싣는다.

## 1. 레퍼런스 해부 [REF]

![ref](assets/ref-model-picker.jpg)

출처: `docs-B2vZk3kt.js`(props · keyboard · a11y · motion · responsive · aiNotes), `RE-css.txt`, 데모 번들, 캡처 `components_model-picker-{light,dark}-t1/t2.png`.

### 1.1 구조

```
root [data-open][data-side=bottom|top][data-align=start|end]
├─ button.trigger  aria-haspopup=dialog · aria-expanded · aria-controls · aria-label "Model: <name>[, extended thinking]"
│   glyph 18px(이름 첫 글자) · name(교차 페이드) · flag(전구 — thinking일 때 펼침) · chevron(열리면 180°)
└─ pop  role=dialog "Model settings" · 닫히면 inert · 320px · 트레이 배경 · r20 · pad 4
    ├─ card r16 · pad 6
    │   ├─ head (aria-hidden)  "Model" | Speed · Quality · Cost (열 3×34px, gap 8)
    │   ├─ listbox "Model" tabindex=0 · aria-activedescendant · [data-pointing]
    │   │   └─ option ×N  aria-selected · aria-label "<name>, <desc>. Speed s, quality q, cost c of 5"
    │   │       glyph 22px · 제목(이름 + 현재면 ✓) / 설명 12px 한 줄 · 막대 3개(5칸, 높이 5px, 칸 간격 2) | 라우터면 "Varies"
    │   └─ settings (위 구분선)
    │       ├─ switch "Extended thinking" (28×16)
    │       ├─ fold 0fr→1fr: "Effort" + radiogroup Low·Medium·High (3×58px, 흰 thumb 슬라이드)
    │       └─ switch "Web search"
    └─ foot 38px  캡션 "~2.1s first token · $25 / M tokens" | kbd ↑↓ ↵ | sr-only aria-live=polite
```

### 1.2 상태

| 상태 | 바뀌는 것 |
|---|---|
| 닫힘 / 열림 | pop 투명·`visibility:hidden`·inert ↔ 보임, 트리거 배경 well, chevron 180° |
| 가리킴(마우스가 목록 위) | `data-pointing`: active 행 배경 well, **나머지 행 opacity .5**, active 행 막대가 칸 순서대로 진하게 채워짐, 트레이가 그 행으로 |
| 키보드 active | 목록 `:focus-visible` → active 행 안쪽 1.5px 링(외곽 outline 없음) |
| 선택됨 | 제목 옆 ✓(팝 320ms), `aria-selected=true` |
| thinking on | 트리거 전구 펼침, Effort 줄 펼침, 트레이 지연 ×1.6 / ×2.5 / ×4(low/medium/high) |
| web search 가리킴/포커스 | 캡션이 검색 설명 문장으로 교체 |
| 라우터 모델(강점 값 없음) | 막대 대신 "Varies", 트레이는 설명 문장 |

### 1.3 상호작용 · 키보드

| 위치 | 키 | 동작 |
|---|---|---|
| 트리거 | Enter · Space · ↓ (↑도) | 열고 목록으로 — active = 현재 모델 |
| 목록 | ↑ ↓ (순환) · Home · End | active 이동, 트레이가 따라감 |
| 목록 | Enter · Space / 클릭 | 고르고 닫고 트리거로 |
| 목록 | Tab | thinking · Effort · Web search로 |
| Effort | ← → (↑ ↓) | 이동 **즉시 선택**(radio 패턴) |
| 어디서나 | Esc | 닫고 트리거로. 바깥 pointerdown · 포커스가 루트 밖으로 → 닫힘 |

### 1.4 모션 (수치)

열기 opacity 200ms ease + transform `translateY(-4px) scale(.96)→none` 320ms `cubic-bezier(.32,.72,.24,1)`, 트리거 모서리 원점(side=top이면
+4px · 아래 모서리) · 닫기 opacity 160 / transform 220, visibility 220ms 지연 · chevron 300ms · 막대: 칸 배경 180ms, 켜질 때 지연
`열×70ms + 칸×45ms` + scaleY 1→1.6→1 360ms · ✓ scale .6→1 320ms · 스위치 knob 280ms · fold 행 420ms + opacity 320ms(지연 100) · thumb
320ms · 캡션 교차 페이드(들어옴 320ms opacity+blur 2px, 나감 220ms) · 숫자 롤 560ms ease-out-quart · reduced-motion이면 전부 정지.

### 1.5 토큰 · 크기 · 반응형 · 접근성 · 데이터 계약

- 색 역할: tray(밝 #f0f0f0 / 어둠 #111113) · card · line · ink · text · muted · well · bar-on · bar-off · switch · focus 링(ink 22% / 흰 30%).
  어둠은 `.dark` / `[data-theme=dark]` 조상으로 전환.
- 글자: 기본 13/20 · 설명 12/17 · 헤드 11/16 · 캡션 12.5(tabular-nums) · kbd 10.5 · glyph 10.5/600.
- 반경: 트리거 10 · pop 20 · card 16 · 행 10 · glyph 6 · segmented 9/thumb 7 · kbd 5 · 막대 칸 1.5. 높이: 트리거 30 · 행 ≥48 · 스위치 행 34 ·
  effort 버튼 24 · foot 38.
- 반응형: 폭 `min(320px, 100vw − 32px)`, 화면 가장자리 12px 안으로 translate 보정. 컨테이너 ≤300px: 행 glyph·키 힌트 숨김, 막대 30px/gap 6,
  effort 들여쓰기 0, 세그먼트 52px. `pointer: coarse`: 트리거 36 · 행 54 · 스위치 42 · effort 30, 키 힌트 숨김.
- 접근성: 트리거 haspopup/expanded/controls, 목록은 listbox + `aria-activedescendant`(포커스는 목록에 머묾), 스위치 `role=switch`,
  Effort는 탭 정지 하나인 radiogroup, 닫힌 메뉴 inert, 트레이 숫자는 굴러갈 때가 아니라 바뀐 뒤 한 번 polite로 읽힘.
- props: `models: {id, name, description?, icon?, speed?, quality?, cost?(1–5), latencyMs?, pricePerM?}[]` · value/onChange ·
  thinking · effort `low|medium|high` · webSearch · open · `side bottom|top` · `align start|end`. aiNotes: 메뉴는 트리거 기준 absolute —
  조상 overflow가 visible이어야 잘리지 않는다. 설명은 2–3단어.

## 2. 변경 전 [CODE]

캡처(하네스 :34105, fixture): `harness/shots-model-picker/before-model-picker-{light,dark}-{desk,phone}-{board,panel,owner-card,owner-panel,owner-panel-controls}.png`.

| 영역 | 현재 | 증거 |
|---|---|---|
| 데이터 | 대표 모델 6개 `{nickname, model, label, contextWindow, autoCompactTokens}`가 페이지에 주입, effort 5단계 | `src/session/model-switch.ts:35,106` · `dashboard.ts:3113–3123, 6319–6320` |
| 세션 필드 | `model · effort · effortEffective`(모델이 단계를 깎을 때만) · `contextTokens · autoCompactTokens · pendingModel` | `dashboard.ts:1093–1112`(cardDerivedFields) · `1300–1312`(modelFields) |
| 카드 | 컨트롤 줄 첫 칸: `<select class="cb-model-select" aria-label="모델 변경">` + effort `<select class="cb-model-select cb-effort-select">`; 640px 미만은 `.cfb-model-toggle` 뒤로 접힘 | `dashboard.ts:9662, 9676–9688, 9779` |
| 모델 옵션 | `nickname · autocompact 750.0K[ · compact 후 전환]`(현재 아닌 모델의 autocompact < 지금 컨텍스트), 목록 밖 모델은 disabled 첫 옵션, `pendingModel`·쓰기 중이면 disabled | `renderModelPicker` `9802–9819` |
| effort 옵션 | `Effort · Extra high` 5개, capped면 title "이 모델은 High까지 실행합니다" | `renderEffortPicker` `9893–9909` |
| 읽기 전용 | `<span class="cb-model-name">opus-5-5[1m]</span>` + `Max → High` 텍스트 | 같은 함수의 `!canSwitch` 분기 |
| 쓰기 | `changeModel(key, select)` → POST `…/model {model:nickname}` → `switched·compacting·unchanged`; `changeEffort` → POST `…/effort`; 세션·작업당 쓰기 하나(`_busy`), 거절 시 `resetPicker` | `9828–9883, 9910–9955` · 라우트 `2644–2703` |
| 안내 | 줄 아래 `renderModelNote`(대기 전환 role=status, 오류 role=alert) | `9820–9827, 9845, 9927` |
| 패널 | `#panel-controls`: "이 세션" + 같은 두 select, 640px 미만·높이 560px 미만이면 `.pc-toggle` 접힘(뜨는 패널), Esc가 먼저 접음 | `renderPanelControls` `9959–9991` · Esc `13007` |
| 실시간 | 포커스된 select가 있으면 카드 몸통·패널 컨트롤을 다시 쓰지 않음 | `isPickingModel` `10108` · `applyCardParts` `7923` · `renderPanelControls` `9964` |
| CSS | `.cb-model*` · `.cfb-model-toggle` · `.panel-controls/.pc-*` `3874–3904`, 접힘 `5166–5184`, 44px `5199` | |
| 상단 칩 | `#td-model/#td-effort` — 새 세션 **기본값**(PATCH `/api/settings/:key`, role=menu · menuitemradio · "열린 세션에도 적용"), Slack 로그인 없으면 숨김 | `6036–6042, 6906–7066` |

**canSwitch 판정(하네스 메모).** 클라이언트 UX 게이트일 뿐이다: `isOwner = s.ownerId === currentUserId`(카드 + `col≠closed`·`!terminated`·
`!sibling`, 패널은 + `sessionState≠SLEEPING`). `currentUserId`는 로그인 신원이 아니라 URL `/dashboard/:userId`(`3048–3051 → 3102 → 6307,
6340`) 또는 사용자 select(`selectUser` `7284`)다. 관리자 모드(`soma_admin_mode` → `X-Admin-Mode`, `6833–6880`)는 선택기 게이트에 쓰이지 않고
서버 쓰기 권한(`_hasWriteAccess` `818` — bearer 헤더/쿠키는 항상 허용)에만 쓰인다. ⇒ 하네스는 `/dashboard/U094E5L4A15`로 열면 전환 가능한
선택기가 그려진다(`/dashboard`는 읽기 전용). 하네스에는 전환 핸들러가 없어 POST는 501. (관리자 모드 ON인 관리자가 남의 세션에서 읽기 전용
선택기를 보는 불일치는 기존 동작 — §6.)

**런타임 사실.** effort는 thinking과 무관하게 매 턴 적용된다(`build-stream-options.ts:391` clamp, thinking은 `405`부터 별개).
세션 thinking은 존재하지만(`types.ts:509`, Slack `%thinking` `session-command-handler.ts:360`) payload에도 대시보드 쓰기 경로에도 없다.
가격은 서버에만 있다: `getModelPricing`(`metrics/model-registry.ts:381`)은 모르는 id(예: `grok-4.6`)에 **조용히** `FALLBACK_SPEC`(Sonnet
요율, `355`)을 돌려준다. 모델별 effort 메뉴는 카탈로그 `getEffortsFor`(`model-catalog.ts:150`)·`clampEffortToModel`(`322`). 첫 토큰 지연·
속도·품질 점수는 `src`에 출처가 없다.

## 3. 차이표

| 레퍼런스 요소 | 현재 | 결정 | 근거 |
|---|---|---|---|
| 트리거(glyph · 이름 · chevron) | select 2개 | **변형** — 트리거 하나, 이름 옆에 `· effort` | `REPRESENTATIVE_MODELS[].label`(대표가 아니면 modelShort), `s.effort` — effort도 같은 메뉴라 닫힌 상태에서 보여야 한다 |
| 전구 flag(thinking) | — | 불채택 → 후속 | `thinkingEnabled`가 payload에 없고 대시보드 쓰기 경로가 없다 |
| 320px 메뉴, side/align | 네이티브 드롭다운 | **변형** — body 단의 fixed 메뉴, side는 서피스별 + 자동 뒤집기 | `.card-expand-inner{overflow:hidden}`(접힘 애니메이션) — absolute면 잘린다(aiNotes). 선례 `.art-peek` fixed `5806` |
| 헤드 "Model" + 열 이름 | — | 변형 — "이 세션 모델" + `창 · 압축 · 비용` | 상단 칩의 "새 세션 기본 모델"과 구별 |
| 행 glyph | — | 채택 | nickname 첫 글자 대문자 |
| 행 이름 | nickname | 채택 — label | `label`("Opus 5.5 (1M)") |
| 행 설명 2–3단어 | 옵션 문구 | **변형** — 지금 옵션 문구를 설명 줄로 | `nickname · autocompact X[ · compact 후 전환]` — 마케팅 문구는 출처 없음 |
| 현재 ✓ | selected | 채택 | `m.model === s.model` |
| Speed 막대 | — | 불채택 | 지연·처리량 측정값 없음 |
| Quality 막대 | — | 불채택 | 품질 점수 출처 없음 |
| Cost 막대 | — | 채택 | 출력 $/M ÷ 목록 최대(D4·D5) |
| (추가) 창 · 압축 막대 | 문구 속 autocompact | 변형 | `contextWindow` · `autoCompactTokens` ÷ 목록 최대 |
| 가리키면 채움 · 다른 행 물러남 | — | 채택 | — |
| 라우터 "Varies" | — | 불채택 | Auto 라우터 모델 없음 |
| Extended thinking 스위치 | — | 불채택 → 후속 | 위 flag와 같음 |
| Effort 세그먼트(3단계, thinking 아래 접힘) | select 5개 | **변형** — 허용 단계만, 늘 보임 | 카탈로그 effort ∩ `EFFORT_LEVELS`(D6); effort는 thinking과 무관하게 적용 |
| Web search 스위치 | — | 불채택 | 세션별 web search 설정 없음 |
| 트레이 첫 토큰 `~2.1s`, effort 배수 | — | 불채택 | TTFT 데이터 없음 |
| 트레이 가격 `/ M tokens`(롤) | — | 채택(변형: 입력·출력 둘) | `findModelPricing`(D5) — 모르면 "가격 정보 없음" |
| (추가) 트레이 창 | — | 채택 | `contextWindow` |
| 키 힌트 ↑↓ ↵ · sr polite | — | 채택 | — |
| 대기 전환 · compacting | select disabled + 안내 | 유지(변형: 옵션 aria-disabled + 메뉴 안 대기 줄) | `pendingModel`, `_busy` |
| capped effort | title + `→` | 유지 | `effortEffective` |
| 640px 접힘 토글 | `.cfb-model-toggle` · `.pc-toggle` | **제거** | 트리거 하나가 접힘의 일을 한다 |
| 상단 기본값 칩 · 새 작업 대화상자 | role=menu / select | 범위 밖(D17) | 다른 결정(새 세션 기본값) |

## 4. 계약 (TO-BE)

클래스 접두사 `mp-`. 클라이언트 상태 `var _mp = { key: null, surface: null, active: 0, pointing: false };`(한 줄 var). 모든 모델·라벨 텍스트는
`esc`/`escAttr`, 값은 `data-*`, 클릭은 위임 또는 모델 텍스트 없는 인라인 호출만.

- **D1 트리거.** owner(`canSwitch`)에게 `renderModelPicker(s, canSwitch, modelShort, surface)`는
  `<button type="button" class="mp-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="mp-menu" data-mp-key="…" data-mp-surface="card|panel">`
  = `.mp-glyph`(글자) + `.mp-name`(대표 label, 아니면 modelShort) + `· <effortLabel(effortEffective||effort)>` + chevron. aria-label
  `모델 <이름>, effort <Effort 전체 이름> — 바꾸기`. 쓰기 중이면 `aria-busy="true"`(비활성화하지 않음 — effort는 모델 대기 중에도 바꿀 수 있다).
  카드 `onclick`은 `event.stopPropagation()` 후 `mpOpenFrom(this)`. 읽기 전용 출력은 지금과 **바이트 단위로 같다**(`cb-model-name`, `meta-effort`).
- **D2 메뉴 호스트 · 배치.** `#mp-menu`(첫 열기 때 `document.body`에 한 번 생성) `role="dialog" aria-label="이 세션의 모델 · effort"`, 닫히면
  `hidden`+`inert`. 열린 메뉴는 하나. `position: fixed; z-index: 150`(패널 101 위, 크론 서랍 190 아래). `mpPlace(anchor, size, viewport, side)`:
  폭 `min(320px, 100vw − 32px)`, align start(트리거 왼쪽), 가장자리 12px로 clamp; side 카드 = bottom, 패널 = top, 그 쪽에 `높이 + 6 + 12`px가
  없으면 반대쪽. 스크롤·resize에 rAF로 재배치, 트리거가 DOM에서 사라지거나 화면 밖이면 닫힘. 패널 닫기·크론 서랍 열기도 닫음.
- **D3 모델 목록.** `renderModelMenu(s)` 안 `role="listbox" aria-label="모델" tabindex="0" aria-activedescendant="mp-opt-<i>"`. 옵션은
  `REPRESENTATIVE_MODELS` 순서, `id="mp-opt-<i>" role="option" data-mp-nick aria-selected`, 내용 = glyph + 제목(label + 현재면 ✓) + 설명
  (`nickname · autocompact <formatTokens> [· compact 후 전환]` — 규칙은 지금 그대로: 현재 아님 && `contextTokens > autoCompactTokens`) + 막대.
  세션 모델이 목록 밖이면 첫 옵션 `aria-disabled="true"` "<modelShort> · 현재(전환 목록 밖)". 옵션 aria-label은 이름·설명·창·autocompact·가격을
  문장으로.
- **D4 막대.** 열 3개 `창 · 압축 · 비용`(헤드 aria-hidden), 각 5칸(`.mp-seg[data-on]`). 칸 수 `mpSegments(v, max) = clamp(round(5·v/max), 1, 5)`,
  값이 없거나 0이면 막대 대신 `—`. 창 = `contextWindow ÷ max`, 압축 = `autoCompactTokens ÷ max`, 비용 = `price.out ÷ max(price.out)` — 최대는
  메뉴에 실린 모델들 중에서. (현 데이터: 창 1M→5 · grok 500K→3; 압축 750K→5 · 600K→4 · 450K→3; 비용 $25→3 · $50→5 · $15→2 · $30→3 · grok —.)
- **D5 가격(서버).** `model-registry.ts`에 `findModelPricing(model): ModelPricingSpec | null`(레지스트리 행이 맞을 때만; FALLBACK이면 null).
  `renderDashboardPage`가 각 대표 모델에 `price: {in: inputPerMTok, out: outputPerMTok}`를 맞을 때만 붙인다(`listRepresentativeModels`는 그대로).
- **D6 effort 허용 단계(서버).** `KanbanSession.effortLevels?: string[]` = `modelCatalog.getEffortsFor(s.model)` ∩ `EFFORT_LEVELS`(그 순서),
  카탈로그가 모델을 알고 교집합이 비지 않을 때만. 없으면 클라이언트는 `EFFORT_LEVELS` 전부.
- **D7 Effort 세그먼트.** 목록 아래 구분선 뒤, 늘 보인다. 1줄: "Effort" + (capped면) `설정 Max → 이 모델은 High까지 실행`; 2줄:
  `renderEffortControl(s)` = `role="radiogroup" aria-label="Effort"` 버튼 `role="radio" aria-checked data-mp-effort`, 짧은 라벨
  `Low · Medium · High · XHigh · Max`(aria-label은 `EFFORT_LABELS`), 체크 = `effortEffective || effort`(실제로 도는 단계), 체크된 것만
  `tabindex="0"`. thumb `style="--i:<idx>;--n:<개수>"`, `grid-template-columns: repeat(var(--n), 1fr)`, thumb 폭 `(100% − 4px)/var(--n)`.
  고르면 메뉴는 열린 채(레퍼런스와 같음), 정착 후 다시 그린다; 실패면 thumb가 세션 값으로 돌아가고 메뉴 안에 오류 한 줄(시각용 — 알림은
  줄 아래 `renderModelNote`의 role=alert가 한 번).
- **D8 트레이.** foot = active 옵션의 캡션 `mpTray(m)`: `입력 $5 · 출력 $25 / M · 창 1.0M`, 가격 없으면 `가격 정보 없음 · 창 500.0K`(달러: 정수면
  소수 없이, 아니면 2자리). `<kbd>↑↓</kbd><kbd>↵</kbd>`. active가 바뀌면 달러 값이 560ms ease-out-quart(1−(1−p)⁴)로 구른다(reduced-motion이면
  즉시). sr-only `aria-live="polite"`는 바뀐 뒤 한 번 `<이름>: 입력 $5, 출력 $25 / 백만 토큰, 창 1.0M` — 굴러가는 중에는 쓰지 않는다.
- **D9 키보드.** 트리거 Enter·Space·↓·↑ → 열고 목록 포커스(active = 현재). 목록 ↑↓ 순환 · Home · End(트레이가 따라감), Enter·Space → 현재가
  아니고 막히지 않았으면 `changeModel(key, nickname)` → 닫고 트리거로. Tab → effort 체크 radio. effort ←→↑↓ → 이동 + 선택
  (`changeEffort(key, level)`), Home·End. Esc → 닫고 트리거로(포커스 대상은 `data-mp-surface`+`data-mp-key`로 다시 찾음 — 재렌더 후에도);
  메뉴의 keydown은 전파를 멈춰 패널 Esc(`13007`)가 같이 닫히지 않는다. 바깥 pointerdown, 메뉴·트리거 밖으로 포커스 이동 → 닫힘.
- **D10 포인터.** 마우스가 옵션 위 = active(트레이 따라감), 목록 `data-pointing` → active 아닌 옵션 opacity .5, pointerleave → 해제. active
  옵션(`data-lit`)의 켜진 칸은 ink 색, 지연 `열×70ms + 칸×45ms`, scaleY 1→1.6→1 360ms.
- **D11 쓰기 · 잠금.** API·결과 문구는 그대로(`postModelSwitch`·`postEffortSwitch`·`modelSwitchNote`·`effortSwitchNote`·`_modelNotes`·
  `renderModelNote`). `changeModel(key, nickname)` · `changeEffort(key, level)` — 값으로 받는다(select 인자·`resetPicker` 제거: 거절되면 세션
  값으로 다시 그려진다). `setBusy`/`isBusy` 잠금, 다른 서피스 즉시 repaint 유지. `pendingModel` 또는 `isBusy(key,'model')` → 모델 옵션 전부
  `aria-disabled="true"`, 목록 위에 대기 줄(`compact 후 grok[1m](으)로 전환 대기 중`), Enter 무시. `isBusy(key,'effort')` → radiogroup
  `aria-disabled="true"`, 화살표 무시.
- **D12 실시간 · 포커스.** `isPickingModel(root)` = `root.querySelector('.mp-trigger[aria-expanded="true"]')` 존재 — 메뉴가 열린 동안 그
  카드 몸통은 다시 쓰지 않는다(트리거 = 위치 기준). `renderPanelControls`도 같은 검사로 건너뜀. 메뉴는 열린 세션의 갱신(`loadSessions` · WS)
  때 `mpRepaint()`로 active 인덱스를 지키며 다시 그린다.
- **D13 모션.** 열기 opacity `var(--dur-fade)` + transform `translateY(∓4px) scale(.96)→none` `var(--dur-move) var(--ease-out)`, 원점 = 트리거
  쪽 모서리. 닫기 opacity 160ms · transform 220ms · visibility 220ms 지연. chevron 180° 300ms · ✓ scale .6→1 320ms · thumb `var(--dur-move)` ·
  트리거 배경 `var(--dur-press)`. reduced-motion: 전역 규칙(`5126`)이 transition·animation을 끄고 롤은 즉시.
- **D14 토큰 · 테마.** 새 토큰 `--mp-tray --mp-card --mp-line --mp-well --mp-bar --mp-bar-off`(어둠 기본 + `[data-theme="light"]` 덮어쓰기
  전부), 글자는 `--ib-text` / `--ib-text-2` / `--ib-muted`, 그림자 `--ib-shadow-raised`, 포커스 `--border-focus`. 반경 트리거 8 · pop 16 ·
  card 12 · 옵션 10 · glyph 6 · segmented 9/7 · 칸 1.5. 글자 13 · 설명 12 · 헤드 11 · 캡션 12.5(tabular-nums).
- **D15 반응형 · 터치.** `.mp-pop{container-type:inline-size}`; `@container (max-width: 300px)`: 옵션 glyph·키 힌트 숨김, 막대 열 30px/gap 6.
  `(max-width: 639px), (pointer: coarse)`: 트리거·effort 버튼 ≥44px, 옵션 ≥54px, 키 힌트 숨김(대시보드 44px 규칙 `5187–5205`).
  패널 입력창 줄에서 트리거는 `max-width: 42%` + 말줄임(지금 `.pc-toggle` 자리).
- **D16 접힘 제거.** `.cfb-model-toggle`·`_cardModelOpen`·`toggleCardModel`, `.pc-toggle`·`.pc-pick` 접힘·`_panelControlsOpen`·
  `togglePanelControls`, Esc의 `_panelControlsOpen` 분기를 지운다. 패널의 "이 세션" 표기는 트리거 앞 `.pc-scope`로 남긴다.
- **D17 범위.** 상단 `#td-model/#td-effort`와 새 작업 대화상자는 그대로 — 결정이 다르다(새 세션 기본값, PATCH `/api/settings`, 옵션은
  설정 레지스트리 행, Slack 로그인 없으면 숨김, "열린 세션에도 적용" 체크). 같은 메뉴를 쓰려면 두 쓰기 경로를 합쳐야 하고 bearer 하네스로
  화면 검증도 못 한다 → 후속.
- **D18 접근성 요약.** 트리거 haspopup/expanded/controls · listbox + activedescendant(포커스는 목록) · radiogroup 탭 정지 하나 · 닫힌 메뉴
  inert · polite 한 번 · Esc/선택 후 트리거로 포커스 복귀 · 헤드·막대·캡션 aria-hidden(옵션 aria-label이 같은 내용).

## 5. 시험

새 파일: `src/conversation/__tests__/dashboard-affectui-model-picker-client.test.ts`(three-surfaces 하네스 헤더), 서버는
`dashboard-affectui-model-picker.test.ts`. 모두 변경 전 RED(함수·필드가 없거나 select를 돌려준다).

| # | 시험 | D |
|---|---|---|
| T1 | owner 트리거 마크업(class·aria·data, label + `· High`, `<select` 없음); 읽기 전용은 지금과 같은 문자열; 쓰기 중 `aria-busy` | D1 |
| T2 | `renderModelMenu`: listbox · 옵션 6개 순서 · 현재 `aria-selected="true"`+✓ · 설명 `grok[1m] · autocompact 450.0K · compact 후 전환`, `fable[1m] · autocompact 750.0K<` · 목록 밖 모델 disabled 첫 옵션 | D3 |
| T3 | `mpSegments` 반올림·clamp, 막대 칸 수(창·압축·비용, grok 비용 `—`) | D4 |
| T4 | 서버: `findModelPricing('grok-4.6') === null`, opus `{5, 25}`; 페이지 `REPRESENTATIVE_MODELS`에 opus `price` 있고 grok 없음 | D5 |
| T5 | 서버: 카탈로그가 아는 모델이면 `effortLevels`가 교집합(순서 유지), 모르면 없음 | D6 |
| T6 | `renderEffortControl`: 허용 단계만 · 체크 = effortEffective · `tabindex="0"` 하나 · `--i/--n` · capped 줄 | D7 |
| T7 | `mpTray` 문구(가격 있음/없음, 달러 형식) + sr 문장 | D8 |
| T8 | 키 처리(가짜 이벤트): ↓ 순환 · Home/End · Enter → `changeModel(key, nick)` + 닫힘 · 현재 모델 Enter는 쓰기 없음 · Esc → 트리거 포커스 · effort → → `changeEffort` | D9 |
| T9 | `changeModel` 두 번째 호출은 잠금으로 거절(POST 1회), 다른 서피스 즉시 busy; `pendingModel`이면 옵션 aria-disabled · Enter 무시 | D11 |
| T10 | `mpPlace`: start 정렬 · 12px clamp · 아래 공간 부족 시 top · 폭 `min(320, vw−32)` | D2 |
| T11 | `isPickingModel`이 열린 트리거를 감지, `renderPanelControls`가 그때 쓰지 않음 | D12 |
| T12 | CSS 핀: `.mp-pop` 폭 식 · `@container (max-width: 300px)` · `[data-theme="light"]`의 `--mp-bar` · 칸 지연 식 · thumb `--n` · 44px 규칙에 `.mp-trigger` | D13–D15 |
| T13 | 페이지에 `cfb-model-toggle` · `pc-toggle` · `toggleCardModel` · `_panelControlsOpen` 없음 | D16 |

고칠 기존 시험(마크업을 일부러 바꿨기 때문):
- `dashboard-live-surfaces-client.test.ts` 722–800: select/option 단언 → T2의 메뉴 단언으로 옮긴다(의미 동일: 6개 nickname 순서, 현재 선택,
  compact 후 전환 문구, 목록 밖 현재 항목, 대기 중 잠금). 읽기 전용 span · `modelSwitchNote` · `renderModelNote` 단언은 그대로.
- `dashboard-effort-client.test.ts` 45–66: owner select(옵션 5개, `Effort · High`, onchange) → radiogroup 단언. 67–72(읽기 전용
  `Max &rarr; High`)와 T6 상단 칩 시험은 그대로.
- `dashboard-three-surfaces-client.test.ts` 868–905(`changeModel(k, select)`·`resetPicker`) → 값 인자로; 1040–1092(접힘 토글이 포커스된
  select를 놓는다 · Esc 문자열 핀) → "열린 메뉴가 Esc로 먼저 닫히고 트리거로, 패널은 그대로"; 336의 var 목록에서 `_cardModelOpen` 제거.
  1180–1185의 `setBusy`/`isBusy` 핀은 함수 이름을 지켜 그대로 통과.
- `dashboard-auto-resume-client.test.ts` 163: var 목록에서 `_cardModelOpen` 제거.
- `dashboard-goal-client.test.ts` 285·311은 `isPickingModel`을 싣는다 — 새 본문은 `root.querySelector`만 쓰고 가짜 body가 null을 돌려주므로
  수정 없이 통과해야 한다(통과를 게이트에서 확인).
- `dashboard-live-surfaces.test.ts` 469(주입 목록 `toMatchObject`)는 `price`가 붙어도 통과.

## 6. 범위 밖 · 후속

- thinking 스위치 + 트리거 전구: `POST …/thinking` + `KanbanSession.thinking`(= `session.thinkingEnabled ?? 사용자 기본값`)이 먼저 필요.
- 상단 기본값 칩 · 새 작업 대화상자를 같은 메뉴로(D17).
- 속도 · 품질 막대, 첫 토큰 지연, effort 지연 배수, web search, Auto 라우터 — 근거 데이터가 생기면.
- 관리자 모드 ON인 관리자에게 남의 세션 선택기를 열어 줄지(서버는 이미 허용) — 게이트 정책 결정이라 이 이슈 밖.
- 패널 컨트롤 줄의 오류 안내를 메뉴 안으로 옮기는 일(지금은 줄 아래 한 곳).
