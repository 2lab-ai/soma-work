# SSOT — 대시보드 × affectUI 레퍼런스 7종

Status: 진행 · 작성 2026-10-26 · 기준 커밋 main `ff6c9ac` · 스펙: [`../14-dashboard-affectui-spec.md`](../14-dashboard-affectui-spec.md) · 루프: [`loop.md`](loop.md)

## 유저 원문 (verbatim, 2026-10-26 Slack)

> soma-work 대시보드 ui 개선
>
> - https://www.affectui.com/screens/agent-run
> - https://www.affectui.com/components/ai-answer
> - https://www.affectui.com/components/agent-inbox
> - https://www.affectui.com/components/agent-queue
> - https://www.affectui.com/components/context-window
> - https://www.affectui.com/components/memory-panel
> - https://www.affectui.com/components/model-picker
>
> 여기에 나온 얘들 각각 리버스 엔지니어링하고 dotprd로 만든후에 이 내용들을 이용하여 대시보드 업데이트해줘.
>
> $using-epic-issue나 $using-epic-tasks 써서 작업

## SSOT-TASK-TREE (ssot-task)

| T | 요건 (원문 근거) | 산출물 |
|---|---|---|
| T1 | "여기에 나온 얘들 각각 리버스 엔지니어링" | 레퍼런스 7종 해부 — 구조·상태·상호작용·모션·토큰·반응형·접근성·데이터 계약 (`re-*.md` §1–§3) |
| T2 | "dotprd로 만든후에" | `.prd/14-dashboard-affectui-spec.md`(에픽 스펙) + `.prd/affectui/re-<slug>.md` 7개 |
| T3 | "이 내용들을 이용하여 대시보드 업데이트" | 서브이슈 7개 = PR 7개, 각 `re-<slug>.md` §4–§6(매핑·계약·시험)을 구현 |
| T4 | "$using-epic-issue나 $using-epic-tasks 써서 작업" | `using-epic-tasks` Case B — 에픽 1 + 서브이슈 7 + PR 7 |

## 레퍼런스 → 대시보드 서피스

| 레퍼런스 | 대시보드 서피스 | 스펙 |
|---|---|---|
| Agent Inbox | 세션 보드(접힌·펼친 카드) | [`re-agent-inbox.md`](re-agent-inbox.md) |
| Agent Run (screen) | 세션 디테일 패널 — 계획·활동·승인·세부 | [`re-agent-run.md`](re-agent-run.md) |
| AI Answer | 패널 대화의 모델 응답 턴 | [`re-ai-answer.md`](re-ai-answer.md) |
| Context Window | 컨텍스트 사용량(패널 세션 정보) | [`re-context-window.md`](re-context-window.md) |
| Model Picker | 모델 · effort 선택기 | [`re-model-picker.md`](re-model-picker.md) |
| Memory Panel | 설정 › 기억 탭 | [`re-memory-panel.md`](re-memory-panel.md) |
| Agent Queue | LLM 가용량 · 크론 레인 | [`re-agent-queue.md`](re-agent-queue.md) |

## 출처 · 라이선스

- 판독 원천: affectui.com 공개 페이지(2026-10-26 캡처, light·dark), 사이트가 브라우저에 내려 주는 문서 청크(props·keyboard·motion·responsive·a11y)와
  데모 번들의 CSS 변수·문구. 7종 중 6종이 affectUI Pro(유료) 항목이다 — **코드를 옮기지 않는다.** 구조·동작·수치만 판독하고, 대시보드의
  vanilla JS·CSS로 다시 구현한다. 캡처는 `assets/ref-<slug>.jpg`(미리보기 영역만 잘라 저장).
- 오픈소스 저장소(`flohoeller/affectui`, MIT)에는 이 7종이 없다(2026-10-26 확인).
