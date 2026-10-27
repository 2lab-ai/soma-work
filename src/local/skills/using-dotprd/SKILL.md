---
name: using-dotprd
description: "Use when a large feature, rebuild, or port in a repo should be driven through a repo-root `.prd/` folder (numbered spec docs fixed first, then a per-workstream ssot.md / loop.md / loop.done.md converge loop), or when starting multi-session work that needs that spec→converge discipline. Triggers: '.prd 만들고 진행', 'dotprd로 진행', '/using-dotprd', '다른 레포 .prd처럼'. Args — <target repo path> (required); <work item / mission> (required); optional reference docs (existing PRDs, captures, upstream links). NOT for single quick fixes, docs-only edits, or personal notes kept outside a repo."
argument-hint: "<target repo path> <work item / mission> [reference docs…]"
---

# using-dotprd — .prd 폴더로 스펙을 고정하고 그 위에서 컨버지한다

여러 레포의 `.prd` 관행(번호 스펙 문서 + 워크스트림별 컨버지 폴더)을 합친 것이다.

## 불변량

1. **`.prd/`는 repo-root, git-tracked.** (확인: `git ls-files .prd`가 비어 있지 않다.)
   scratchpad가 아니다 — 다음 세션·타 에이전트가 읽는 durable 캐리어다.
2. **번호 문서는 계약을 기록한다, 희망을 기록하지 않는다.** 각 문서 상단에 `Status:`
   한 줄 (**planned / in-progress / shipped**). shipped 문서는 현재형으로 "구현된 계약"을
   기술하고 "not a future target"을 명시한다.
3. **유저 원명령은 verbatim 보존** — ssot.md에 축자 인용으로 고정하고, 문서는 그 승계다.
4. **날짜는 절대 날짜만.** 상대 날짜 금지 (공통 문서 규약).

## Layout

```text
<repo>/.prd/
  01-spec.md          # 문제 → 목표/비목표 → 인수 기준. 미션의 WHY와 끝상태.
  02-architecture.md  # 스택·모듈 배치·경계. HOW의 상위 절반.
  03+-<topic>.md      # 피처/에픽 단위 스펙·리서치·findings (번호는 생성 순, 주제는 kebab)
  research/           # 딥다이브 노트 (번호 문서가 아닌 보조 근거)
  <workstream>/       # 구현 드라이브가 시작되면 워크스트림당 1폴더:
    ssot.md           #   고정 타깃 — 유저 원문 verbatim + 확정 스코프. loop 중 재해석 금지.
    loop.md           #   드라이버 — 아직 안 끝난 것만: 현재 라운드 계획, 열린 WU 행(브랜치·워크트리·스코프),
                      #   build facts(게이트 명령 실측), 열린 gap 행 (§loop.md 관리)
    loop.done.md      #   완료 원장(append-only) — 닫힌 라운드·WU·gap 행을 그대로 옮겨 쌓는다
```

작은 작업이면 01·02 + 워크스트림 폴더 하나면 충분하다. 문서를 위한 문서 금지 —
개선 우선순위(삭제→병합→기계화→문서)는 여기에도 적용된다.

## 번들 파일

번들 파일은 `$CLAUDE_PLUGIN_ROOT/skills/<skill>/…`로 닿는다. `$CLAUDE_PLUGIN_ROOT`는 이 스킬
base directory의 두 단계 위다(`…/skills/using-dotprd` → `…`). 셸은 보통 이 변수를 설정하지 않으므로
절대 경로를 쓴다. 셸 호출마다 셸 상태가 이어지지 않으니 경로는 호출마다 다시 쓴다.

```bash
# loop.md ↔ loop.done.md 린트 (§loop.md 관리). FAIL이 하나라도 있으면 exit 1.
python3 "$CLAUDE_PLUGIN_ROOT/skills/using-dotprd/scripts/loop-lint.py" <워크스트림 폴더> [--base <git rev, 기본 HEAD>]
python3 "$CLAUDE_PLUGIN_ROOT/skills/using-dotprd/scripts/loop-lint.py" --selftest

# 원본↔구현 대조 시트 (Phase 2 UI 라운드). Pillow 필요.
python3 "$CLAUDE_PLUGIN_ROOT/skills/using-dotprd/scripts/parity-sheet.py" <out.png> <ref.png> <impl.png> [--label-ref T] [--label-impl T]
```

`loop.done.md` 라운드 블록 형식 = `$CLAUDE_PLUGIN_ROOT/skills/using-dotprd/templates/loop.done.template.md`.

## Workflow

### Phase 1 — 스펙 고정 (코드 전)
1. 레퍼런스·현재 상태를 실측으로 캡처 (증거 라벨 관행: [LIVE]/[BUNDLE]/[RULES]/[TARGET].
   외부 제품 레퍼런스는 **UX 재현**이 목표지 소스/브랜드 복제가 아님을 01-spec에 명기).
   **외부 제품의 "전수 기술" 주장은 실조작 세션 없이 금지** — 정적 스크린샷·번들 식별자·
   과거 캡처만으로 스펙을 "전수"로 서명할 수 없다; 해당 제품을 직접 충분히 조작한 세션
   기록(조작 로그+캡처)이 스펙의 1차 증거여야 하고, 조작 불가 영역은 스펙에 "미조작 —
   추정" 경계로 명시한다.
2. `01-spec.md` 작성: 문제, 목표/비목표, 인수 시나리오(명령형: 실행 → 기대 관측치).
3. `02-architecture.md` 작성: 기존 스택 위 경계 결정. 대형 스펙이면 레포·세션이 정한
   외부 이원 엔진 리뷰 후 고정.
4. **스코프**: 문서 스코프 = 경로(폴더/파일명)가 말하는 주제 전체. 직전 사건·특정 환경은 문서 틀이 아니라 요구사항 1줄로만 흡수한다.

### Phase 2 — 컨버지 드라이브
5. 워크스트림 폴더 생성: `ssot.md`(유저 원문 + 스코프 고정) → `loop.md`(라운드 1 계획). `loop.done.md`는 처음 끝난 항목이 생길 때 만든다.
6. WU 분해: 파일 소유권 서로소 단위로 → per-unit dispatch (에이전트당 WU 1개),
   워크트리는 `<repo>/.worktrees/<branch-with-dashes>` (브랜치명의 `/`를 `-`로).
7. 라운드마다: 구현 → 게이트 직접 재실행 → **관측으로 verify** (스크린샷/캡처 원문,
   "GREEN only from observed pixels") → gap matrix 갱신 →
   잔여 gap이 0이 될 때까지 다음 라운드. 리시트는 레포·세션의 리시트 규율을 따른다.
   라운드를 닫는 커밋에서 끝난 것을 `loop.done.md`로 옮기고 번들 `loop-lint.py <워크스트림 폴더>`
   FAIL 0을 확인한다(§번들 파일, §loop.md 관리).
   **외부 제품 UX 재현 루프의 UI 라운드는 원본 대조 시트가 리시트 필수 항목이다** —
   레퍼런스 원본 캡처를 먼저 확보하고 번들 `parity-sheet.py`(§번들 파일)로 원본↔구현
   나란히 합성 시트를 만들어 항목별 갭 체크리스트와 함께 첨부; 행동 테스트·단독
   스크린샷만으로는 그 라운드를 GREEN 선언할 수 없다.

### Phase 3 — 종결
8. 리시트 green → 머지 → 레포 런북이 정한 프리뷰/dev 배포 → 배포 후 실측 (PR에서 멈추지 않는다).
   prod·정규 릴리즈처럼 되돌릴 수 없는 배포는 레포·세션의 게이트를 따른다.
9. 번호 문서를 shipped 상태로 갱신 (미래형 → 현재형 계약). 남은 기록을 `loop.done.md`로 옮기고,
   loop.md에는 `Status: done` + 다음 착수점·게이트 대기 항목만 남긴다.
10. `.prd` 변경분 커밋 — 코드와 같은 PR/커밋 흐름에 태운다.

## loop.md 관리 — 지금 할 일만

이 절이 loop.md ↔ loop.done.md 규칙의 정본이다. 기계 검사 = 번들 `loop-lint.py <워크스트림 폴더>`
(`--selftest`로 자기 검증; 명령 = §번들 파일).

- **표 형식.** 첫 헤더가 `ID`인 표는 모두 gap/WU 표이고 `Status` 열을 가진다(없으면 C0). loop.md의 Status 칸은
  표시 하나를 반드시 담는다 — ✅ ⚫ = 닫힘, 🔴 🟡 🚪 = 열림. 표시 없는 칸(`open`·`done` 같은 낱말뿐) = W2 경고 — 표시로 바꾼다.
  선택 열 `Source`는 회귀를 `regression:<ID>`로 적는다. loop.md의 WU 행도 같은 ID/Status 형식을 쓴다
  (Layout의 "열린 WU 행"이 이 표다).
- **loop.md = 아직 안 끝난 것만.** 현재 라운드 계획 · 열린 WU 행 · build facts · 열린 gap 행 · 아직 처리 안 한
  리뷰 지적 · 다음 착수점. 옮기는 기준은 "끝났는가" 하나다 — 열린 것은 줄 수와 상관없이 남긴다. 린트의 줄 수
  경고는 "끝난 것이 남았는지 점검하라"는 신호이지 상한이 아니다.
- **옮기는 때와 단위.** 라운드를 닫는 커밋에서 옮긴다. 옮기기 전에 그 라운드 절에 결과(측정·닫힌 행·커밋/PR)를
  적고, 옮긴 뒤에는 고치지 않는다.
  - 붙이는 곳은 언제나 `loop.done.md` **맨 아래**다. 위쪽은 한 글자도 바꾸지 않는다(린트 C2가 git 기준으로 확인).
  - gap 표가 없는 문서 드라이브: 끝난 라운드 절 전체를 그대로 붙인다.
  - gap 표가 있는 루프: 라운드마다 블록 하나 — `## R<n> — closed` 아래에 요약 한 줄, `### Closed rows` 표(닫힌 행,
    같은 ID), 그 라운드 절. 형식 = 번들 템플릿 `$CLAUDE_PLUGIN_ROOT/skills/using-dotprd/templates/loop.done.template.md`.
  - 닫힌 WU 행(리시트 green·머지)도 같은 커밋에서 그 라운드 절에 담아 옮긴다.
- **`loop.done.md`는 append-only다.** 옮긴 행·절은 그 시점의 스냅샷이다(`Last Measured`도 그때 값으로 굳는다).
  - 나중 재측정에서 닫힌 행이 그대로 통과하면 현재 라운드 절에 `re-verified ✅: <ID…> · 증거 · 리비전` 한 줄을
    적는다. 이 줄은 행이 아니라 회계에 세지 않고, 그 라운드와 함께 옮겨진다.
  - 재측정에서 실패하면 회귀다. loop.md에 새 ID 행을 열고 Source에 `regression:<원래 ID>`를 적는다. 같은
    원래 ID의 회귀 행이 이미 열려 있으면 새로 열지 않고 그 행을 갱신한다.
  - 한 ID의 현재 판정 = 열린 회귀 행 > 가장 최근 `re-verified` 줄 > `loop.done.md` 스냅샷.
- **한 파일 드라이버(옛 형식)**: 끝난 것이 쌓인 loop.md는 그 워크스트림을 다시 열 때 처음 한 번 위 규칙대로
  나눈다(ID·증거 링크 유지). 다시 열지 않는 워크스트림은 건드리지 않는다.
- 설계 규칙·결정은 loop 파일에 두지 않는다 → 번호 문서(01/02/03+). 번호 문서는 설계 근거로 loop 파일을 가리키지 않는다
  (리시트 근거로 `loop.done.md`를 가리키는 것은 된다).

## Red flags

- `.prd`를 만들었는데 gitignore에 넣으려 한다 → 불변량 1 위반.
- loop.md 없이 "머릿속 계획"으로 WU를 디스패치하고 있다 → Phase 2로 복귀.
- loop.md에 끝난 라운드·닫힌 WU·처리가 끝난 리뷰 지적이 남아 있다 → `loop.done.md`로 옮기고 `loop-lint.py` FAIL 0 후 진행.
- verify가 에이전트 보고 인용뿐이다 → 관측 캡처를 직접 떠라 (inputs not oracles).
- 문서 상태가 shipped인데 본문이 미래형이다 → 계약 기술로 재작성.

- **위치·크기를 주장하는 리시트는 좌표를 출력에 남긴다** — "뷰포트 내"류 불리언 판정만 남기면
  detached-anchor (8,8) 같은 결함 지문이 성공으로 통과한다(proxy-green: 검증 대상을 검증 가능한
  근접 지표로 치환). 앵커 rect와 대상 rect를 나란히 출력하면 지문은 숨을 곳이 없다
  (실제 사례: 팝오버 위치를 네 라운드의 리시트가 한 번도 보지 않아 결함이 prod까지 나갔다).
