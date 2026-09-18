# SSOT — 큐/스티어링 UI를 이모지 리액션으로 (soma-work Slack 에이전트)

Status: in-progress · 작성 2026-09-18 · 기준 커밋 main `3229521d` (PR #235 머지, v0.2.1143 프리뷰 배포·실측 완료)

## 유저 원문 (verbatim, 2026-09-18 /goal)

> soma-work 개선 /using-dotprd
>
> 1. 유저의 미드턴 지시를 메세지큐에 넣고 응답하고 ui를 출력하지 말고 대신에 이모지로해줘
>
> AS-IS:
> Z 1 minute ago
> 5678
> [큐됐다는이모지]
>
> 쓰마의 AGENT  1 minute ago
> 2. 5678 · 전달됨 · 모델이 다음 툴 호출에서 읽음
> [Send now 버튼] [Cancel 버튼]
>
> TO-BE:
>   Z 1 minute ago
>   5678
>   [큐됐다는이모지] [Send Now이모지] [Cancel 이모지]
>
> ---
> 이렇게 유저가 보낸 메세지에 이모지를 붙이고 유저가 해당 이모지를 클릭해서 2로 만들면 그걸 리액션을 받아서 처리해줘.
>
> 이해했음? 그리고 스티어링되면 이모지를 제거해줘 큐됐다는 이모지도 제거하고 처리 됐다는 이모지로 변경
>
> >처리됐을경우
>  Z 1 minute ago
>  5678
>  [전달완료 이모지]
>
> >캔슬됐을경우
>    Z 1 minute ago
>    5678
>    [캔슬완료 이모지] [Cancel 이모지]x2
> (유저가 클릭해서 Cancel이 2개 됐다가 1로 줄어들고 캔슬완료 이모지 표시)
>
> Send Now도 캔슬처럼 처리
>
> 이렇게 해줘 이렇게 ui를 최소화할수 있도록
>
> 저 Send Now랑 Cancel 이모지는 니가 만들어서 추가해줘.  (클인클 사용)
>
> [!Send] :ui_send_now:
> [Cancel] :ui_cancel:

## 확정 스코프

1. 미드턴 유저 메시지는 큐에 넣고, **봇 카드(A39 인라인 아이템 메시지)를 더 이상 게시하지 않는다.** 상태와 컨트롤은 유저 메시지의 리액션으로만 표현한다.
2. 리액션 = 컨트롤: 유저가 `:ui_send_now:` / `:ui_cancel:`을 눌러 카운트가 2가 되면 봇이 `reaction_added`로 받아 Send now / Cancel을 실행한다.
3. 전이 시 봇이 자기 리액션을 정리한다(큐됨·컨트롤 제거, 결과 이모지 추가). Cancel/Send now 모두 "봇 리액션 1개 제거(2→1) + 완료 이모지".
4. 커스텀 이모지 `:ui_send_now:`, `:ui_cancel:` 이미지를 만들어 워크스페이스에 추가한다(Claude in Chrome).
5. `queue` 명령·Cancel/Send now 권한 규칙(A30, `authorizeFollowupInterrupt`)·정산 로직은 그대로.

## 비스코프

- 스레드 패널(Resume/Retry 등 parked 항목 UI) 변경.
- 리액션 제거(`reaction_removed`)에 대한 동작.
