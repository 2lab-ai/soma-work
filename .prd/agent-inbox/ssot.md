# SSOT — Agent inbox 작업 보드 + Slack 미니멀 출력

Status: in-progress · 작성 2026-10-16 · 기준 커밋 main `e992de7c` (v0.2.1156 프리뷰)

## 유저 원문 (verbatim, 2026-10-16 /goal)

> soma-work 개선
>
> 1. 작업 보드 이런 리스판시브하고 모션 디자인을 /using-dotprd로 먼저 prd 추가 업데이트해줘
> https://www.threads.com/share/KkCMVHyRd/
>
> 2. soma-work에 별도 작업 대시보드가 있는데 이걸 저것처럼 개선해줘.
>
> 3. 전체적으로 다음처럼 개선해줘
> a. slack에서 모든 유저에서 슬랙에 나오는 작업 메세지를 디폴트 minimal로 1회 변경해줘
> b. minimal에서 더욱더 미니멀로 출력해주고, 대시보드에 유저의 지시와 모델의 응답을 볼수 있게 해주고 해당 thread 제일 위에 링크 추가해줘 (아마 비슷하게 추가되어 있을 수 있음)
> 즉, 슬랙 채팅에는 task list와 진짜 필수적인 정보만 출력하고 모델의 실시간 작업 설명등 verbose한 정보는 직접 스탠다드얼론 대시보드 작업 로그에서 볼수 있도록해줘. 슬랙에는 진짜 최소한의 정보만 출력

후속 지시 (2026-10-16, 같은 세션): "아니 aside cli로 확인해줘" — 레퍼런스 확인 경로는 Aside CLI.

## 레퍼런스

- Threads 글: `@growthflo` "Agent inbox component design" — 정식 URL `https://www.threads.com/@growthflo/post/Deg1_k9AAO4`,
  작성자 답글이 원본 컴포넌트 출처로 `affectui.com`을 가리킨다.
- 1차 증거 = 영상 17.5초를 Aside 브라우저에서 0.6초 간격 30프레임으로 캡처한 것(2026-10-16). 프레임 판독 결과는
  [`../10-agent-inbox-board-spec.md`](../10-agent-inbox-board-spec.md) §2에 [REF] 라벨로 고정.
- 재현 목표는 **UX(레이아웃·상호작용·모션)** 이지 소스·브랜드 복제가 아니다.

## 확정 스코프

1. `.prd/10-agent-inbox-board-spec.md` — 작업 보드의 반응형·모션 계약(이번 SSOT의 1번).
2. 기존 대시보드(`src/conversation/dashboard.ts`가 서빙하는 standalone 작업 대시보드)를 그 계약대로 개선(2번).
3. Slack 출력:
   - 3a. 모든 유저의 Slack 작업 메시지 출력 수준을 **1회** `minimal`로 바꾼다 — 이후 유저가 바꾼 값은 존중한다(재실행 금지).
   - 3b. `minimal`을 더 줄인다: 스레드에는 task list + 필수 정보(유저 응답이 필요한 질문/승인, 최종 결과, 오류)만.
     모델의 실시간 작업 설명 등 verbose 정보는 대시보드 작업 로그에서 본다.
   - 3b. 대시보드에서 유저 지시와 모델 응답을 볼 수 있다.
   - 3b. 해당 스레드 맨 위에 대시보드(그 세션 작업 로그) 링크.

## 비목표

- prod 채널(`deploy/prod`) 배포 — 유저 게이트 유지. 이번 배포는 프리뷰 채널(`deploy/dev`) 한정.
  3a 마이그레이션은 각 배포 대상이 새 빌드로 처음 기동할 때 1회 실행되므로, prod에는 prod 배포 시점에 적용된다.
- 레퍼런스 컴포넌트 소스·브랜드 복제.
