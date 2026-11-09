<h1 align="center">soma-work</h1>

<p align="center"><strong>슬랙에 말하면, 일하는 게 보입니다.</strong></p>

<p align="center">팀이 같이 쓰는 Claude Code 에이전트. 슬랙·대시보드·음성으로 일을 맡기고, 맡긴 일은 하나씩 카드가 되어 열어 볼 수 있습니다.</p>

<p align="center">
  <a href="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml"><img src="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/2lab-ai/soma-work/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
</p>

<p align="center">
  <a href="#맡기기">맡기기</a> · <a href="#지켜보기">지켜보기</a> · <a href="#끼어들기">끼어들기</a> · <a href="#실행하기">실행하기</a> · <a href="#문서">문서</a> · <a href="./README.md">English</a>
</p>

![soma-work 대시보드: 응답 필요·실행 중·완료 세 열에 작업 카드가 놓이고, 카드마다 상태·PR·비용·슬랙 채널이 보인다](assets/readme/board.png)

<sub>실제 대시보드(Modern Mono 테마), 2026-11-09, 이 저장소의 카드만 걸러 봤습니다. 비공개 호스트 이름이 들어간 카드는 숨겼습니다.</sub>

## 맡기기

세 가지 방법이 있고, 어느 쪽이든 결과는 같습니다. 슬랙 스레드 하나와 보드의 카드 하나가 생깁니다.

- **슬랙:** 채널에서 봇을 멘션하거나, 봇의 스레드에 답글을 답니다.
- **대시보드:** **새 작업**(`Ctrl+N`)을 열고, 쓰고, 보냅니다.
- **음성:** 새 작업에서 **받아쓰기**를 누르고 말합니다.

![새 작업에 지시를 입력해 보내면, 같은 문장 그대로 카드가 보드에 올라온다](assets/readme/ask.gif)

![받아쓰기: 말하는 대로 새 작업 입력창에 글자가 써진다](assets/readme/voice.gif)

## 지켜보기

카드를 엽니다.

- **대화:** 내 지시와 에이전트의 답. 슬랙 스레드와 같은 대화입니다.
- **작업:** 에이전트의 계획. 단계마다 완료·진행 중·대기가 표시됩니다.
- **작업 로그:** 도구 호출 하나하나가 실행되는 대로, 작업별로 묶여 쌓입니다.

![카드를 열면 대화, 작업 목록, 라이브 작업 로그 순서로 보인다](assets/readme/work.gif)

## 끼어들기

- **먼저 묻습니다.** 권한 요청이나 질문이 생기면 카드가 **응답 필요**로 옮겨집니다. 카드에서도, 슬랙에서도 답할 수 있습니다.
- **방향 바꾸기:** 카드의 입력창으로 일하는 중인 에이전트에게 지시합니다.
- **중지**하거나, 컨텍스트를 이전 시점으로 **되돌립니다**.

## 돌아오는 것

- 에이전트가 만든 PR·이슈·문서가 상태와 함께 카드에 붙습니다.
- 일이 끝나면 TL;DR이 붙습니다.
- 카드마다 비용·토큰·모델이 보입니다.

## 실행하기

지금은 소스에서 실행합니다.

```bash
git clone https://github.com/2lab-ai/soma-work.git && cd soma-work && npm install
cp .env.example .env    # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, BASE_DIRECTORY
npm run dev
```

먼저 [`infra/slack/slack-app-manifest.json`](infra/slack/slack-app-manifest.json)으로 슬랙 앱을 만듭니다. Node.js 22 이상이 필요합니다. 배포와 GitHub 연동까지 담은 전체 안내는 [soma-work 실행](docs/misc/guides/setup.ko.md)에 있습니다. 패키지 설치기(`somawork setup`)는 만들어져 있지만 아직 배포하지 않았습니다.

## 워크플로우만 쓰기

soma-work가 돌리는 에이전트 워크플로우 `zworkflow`는 Claude Code 플러그인입니다. 슬랙 없이 내 Claude Code에서 쓸 수 있습니다.

```text
/plugin marketplace add 2lab-ai/soma-work
/plugin install zworkflow@soma-work
```

자세한 내용: [zworkflow 플러그인 README](./src/local/README.ko.md)

## 문서

- [soma-work 실행](docs/misc/guides/setup.ko.md): 설치, 설정, 배포, GitHub, 문제 해결
- [명령어](docs/misc/guides/commands.ko.md): `/z`, `%`, `$`, 접두어 없는 명령어
- [기능과 아키텍처](docs/misc/guides/features.ko.md): 기능 전체
- [soma-work 개발](docs/misc/guides/contributing.ko.md): 프로젝트 구조, 설계 원칙, 테스트
- [문서 지도](docs/README.md), [ADR](docs/adr/README.md)

이 저장소에서 일하는 AI 에이전트라면 [`CLAUDE.md`](CLAUDE.md)와 [`AGENTS.md`](AGENTS.md)를 먼저 읽으세요.

## 라이선스

[MIT](./LICENSE)
