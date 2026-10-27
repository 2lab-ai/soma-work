# zworkflow

[English](./README.md)

zworkflow는 soma-work가 기본으로 싣는 Claude Code 플러그인입니다. SSOT 기반 개발 파이프라인
(`z` / `zcheck` / `ztrace` / `autoz` / `zwork` / `trinity`)과 `calldiff` 호출 흐름 요약, 그리고
agents·commands·hooks·prompts·skills로 이루어져 있습니다. 이 디렉터리 `src/local/`이 플러그인
루트입니다. 매니페스트는 [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json)이고, 저장소의
마켓플레이스 파일([`/.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json),
마켓플레이스 이름 `soma-work`)이 `zworkflow` 항목을 `./src/local`로 가리킵니다. soma-work 에이전트는
이미 이 플러그인을 불러옵니다. 아래는 내 Claude Code에서 쓰는 방법입니다.

## 설치

Claude Code 세션 안에서:

```
/plugin marketplace add 2lab-ai/soma-work
/plugin install zworkflow@soma-work
```

셸에서:

```bash
claude plugin marketplace add 2lab-ai/soma-work
claude plugin install zworkflow@soma-work
```

HTTPS 주소도 됩니다: `claude plugin marketplace add https://github.com/2lab-ai/soma-work.git`.
설치 범위 기본값은 `user`이고, `--scope project`나 `--scope local`로 좁힐 수 있습니다.
설치된 목록은 `claude plugin list`로 봅니다.

`marketplace add`는 이 디렉터리만이 아니라 soma-work 저장소 전체를 클론합니다.

## 설치하면 생기는 것

2026-10-27, Claude Code 2.1.311, 플러그인 2.5.0, 빈 설정 디렉터리에서 잰 값입니다:

| 항목 | 측정값 |
|---|---|
| `marketplace add` | 약 17초, 마켓플레이스 디렉터리 약 205 MB |
| `install` | 플러그인 캐시 약 7.5 MB |
| `claude plugin details zworkflow@soma-work` | 스킬 59, 에이전트 16, 훅 3 |
| 상시 컨텍스트 | 세션마다 약 8,506 토큰 추가 |

날짜가 붙은 측정값이지 보장값이 아닙니다. 2.6.0은 스킬 하나(`using-intentfirst`)를 더합니다.
지금 값은 `claude plugin details zworkflow@soma-work`로 확인합니다.

플러그인 스킬은 네임스페이스가 붙습니다: `/zworkflow:using-intentfirst`,
`/zworkflow:using-ssot`처럼 부릅니다.

## 업데이트와 제거

```bash
claude plugin marketplace update soma-work
claude plugin update zworkflow@soma-work
claude plugin uninstall zworkflow@soma-work
```

`marketplace update`가 클론을 갱신하고, `update`가 플러그인을 새 버전으로 옮깁니다. `update`는
Claude Code를 재시작해야 적용됩니다.

## soma-work 밖에서의 훅

플러그인은 [`hooks/hooks.json`](./hooks/hooks.json)에 훅을 등록합니다:

- **PreToolUse / PostToolUse (모든 도구)**: `hooks/hook-proxy.sh`를 실행합니다. `HOOKS_PROXY_ENABLED`가
  비어 있으면(기본값) 단독 모드입니다. Agent/Task와 MCP 호출에 대해 `hooks/call-tracker.sh`가
  `/tmp/claude-calls` 아래에 호출 기록을 남기고, 네트워크는 쓰지 않습니다. soma-work는 자기
  에이전트에 `HOOKS_PROXY_ENABLED=true`를 넣어 이벤트를 로컬 soma-work 서비스로 보냅니다. 직접 설치할
  때는 이 값을 넣지 마세요. `hook-proxy.sh`는 모든 경로에서 0으로 끝나고 stdout에 아무것도 쓰지
  않으므로, 이 훅은 도구 호출을 막지 않습니다.
- **Stop**: `hooks/stop-hook.sh`(Ralph loop)와 `hook-proxy.sh cleanup`을 실행합니다. Ralph loop는
  프로젝트에 `.claude/ralph-loop.local.md`가 있을 때만 동작하고, 이 플러그인은 그 파일을 만들지
  않습니다. 파일이 있으면 설계대로 세션을 이어 갑니다.
- **필요한 것**: `jq`. 없으면 PreToolUse / PostToolUse 훅은 아무 일도 하지 않고 0으로 끝납니다.
  `stop-hook.sh`는 Stop 때마다 `jq`·`perl`·`sed`·`awk`를 확인하고, 하나라도 없으면 stderr에 경고를
  쓰고 0으로 끝납니다.

## 가벼운 경로: 스킬 두 개만

플러그인의 훅·에이전트·상시 컨텍스트 없이 `using-intentfirst`만 쓰려면, 이 스킬과 이 스킬이 기대는
`using-ssot`를 사용자 스킬 디렉터리에 복사합니다:

```bash
d="$(mktemp -d)/soma-work" && git clone --depth 1 --filter=blob:none --sparse https://github.com/2lab-ai/soma-work.git "$d" && git -C "$d" sparse-checkout set src/local/skills/using-ssot src/local/skills/using-intentfirst && mkdir -p ~/.claude/skills && cp -R "$d/src/local/skills/using-ssot" "$d/src/local/skills/using-intentfirst" ~/.claude/skills/
```

클론은 `mktemp -d`로 새로 만든 디렉터리에 받으므로 기존 체크아웃을 건드리지 않습니다.
프로젝트 하나에만 쓰려면 두 폴더를
`<project>/.claude/skills/`에 복사합니다. 복사한 스킬은 네임스페이스가 없어 `/using-intentfirst`로
부릅니다. 복사본은 스스로 갱신되지 않으니, 갱신하려면 다시 복사합니다.

## using-intentfirst

지시는 보통 그 뒤의 의도가 아니라 지시한 사람이 떠올린 워크플로우 모양으로 옵니다.
[`using-intentfirst`](./skills/using-intentfirst/SKILL.md)는 의도에서 출발합니다:

- 지시 원문을 [`using-ssot`](./skills/using-ssot/SKILL.md)로 SSOT로 보존합니다(Hook 1 접수,
  Hook 2 drift, Hook 4 완료 보고).
- 워크플로우 모양의 지시에서 의도를 분리하고, 지시에 든 해법은 스펙이 아니라 예시로 표시합니다.
- INTENT-LIST와 INTENT-TASK-TREE를 만들고, 그 트리를 SSOT-TASK-TREE와 비교해(covered·dropped·added·
  reshaped) 차이마다 원인을 붙입니다.
- 차이를 보여 주고 확인을 기다리지 않고 의도 트리대로 진행합니다. 답이 오면 처음부터 다시 하지 않고
  방향만 바꿉니다.
- 추론한 의도를 근거로 되돌릴 수 없는(`[irrev]`) 단계는 밟지 않습니다.

플러그인으로 설치했으면 `/zworkflow:using-intentfirst`, 복사했으면 `/using-intentfirst`로 부릅니다.
스킬 설명(description)에는 모든 지시에서 이 스킬을 먼저 불러오라는 문구가 있습니다. 스킬 본문은
한국어이고, 본문의 "G"는 지시하는 사람, 곧 당신입니다.
