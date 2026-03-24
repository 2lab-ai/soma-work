# Slack Slash Commands — Spec

> STV Spec | Created: 2026-03-25

## 1. Overview

soma-work 봇의 명령어를 Slack 네이티브 slash command로 등록하여, 유저가 `/`를 입력하면 봇 명령어가 자동완성에 노출되도록 한다. 현재 모든 명령은 일반 텍스트 메시지의 첫 단어를 regex로 파싱하여 처리하고 있어 discoverability가 전무하다.

3개의 slash command를 등록한다:
- `/soma [subcommand]` — 범용 명령 (help, model, persona, bypass, mcp 등)
- `/session` — 세션 관리 (ephemeral 응답)
- `/new [prompt]` — 스레드 내 세션 리셋 + 새 대화 시작

## 2. User Stories

- As a 유저, I want `/`를 누르면 soma 봇 명령어가 자동완성에 보이도록, so that 어떤 명령이 있는지 쉽게 발견할 수 있다.
- As a 유저, I want `/soma help`로 전체 명령어 목록을 볼 수 있도록, so that 사용법을 빠르게 파악할 수 있다.
- As a 유저, I want `/session`으로 내 세션 목록을 ephemeral로 볼 수 있도록, so that 채널에 노이즈 없이 세션을 관리할 수 있다.
- As a 유저, I want 스레드 내에서 `/new`로 세션을 리셋할 수 있도록, so that 새 대화를 빠르게 시작할 수 있다.

## 3. Acceptance Criteria

- [ ] `/soma help` 입력 시 help 메시지가 ephemeral로 표시됨
- [ ] `/soma model`, `/soma persona` 등 기존 텍스트 명령과 동일하게 동작
- [ ] `/session` 입력 시 유저의 세션 목록이 ephemeral로 표시됨 (kill 버튼 포함)
- [ ] `/new` 입력 시 스레드 내 세션이 리셋됨 (채널에 표시)
- [ ] `/new fix the bug` 입력 시 세션 리셋 후 프롬프트가 이어서 처리됨
- [ ] 기존 텍스트 기반 명령 (help, sessions, new 등)이 그대로 동작함 (backward compat)
- [ ] Slack manifest에 slash_commands 섹션과 `commands` OAuth scope 추가됨
- [ ] Socket Mode에서 slash command가 정상 수신됨

## 4. Scope

### In-Scope
- 3개 slash command 등록: `/soma`, `/session`, `/new`
- Manifest 수정 (YAML + JSON)
- EventRouter에 slash command 핸들러 등록
- Slash command payload → 기존 CommandRouter 브릿지
- Ephemeral 응답 지원

### Out-of-Scope
- 관리자 명령(accept, deny, config) slash command 등록
- 토큰 관리(cct, set_cct) slash command 등록
- $ prefix 명령 slash command 등록
- Slash command 자동완성 내 subcommand 힌트 (Slack API 미지원)
- Interactive modal/dialog 연동

## 5. Architecture

### 5.1 Layer Structure

```
Slack slash command payload
    ↓
EventRouter.setupSlashCommands()   ← NEW: app.command() 등록
    ↓
SlashCommandAdapter.adapt()        ← NEW: payload → CommandContext 변환
    ↓
CommandRouter.route(ctx)           ← EXISTING: 기존 명령 라우터 재사용
    ↓
Individual CommandHandlers         ← EXISTING: 기존 핸들러 그대로
```

### 5.2 Slash Command Definitions

| Command | Description | Response Type | Subcommand |
|---------|-------------|---------------|------------|
| `/soma` | Claude Code Bot 범용 명령 | Ephemeral | help, model, persona, bypass, mcp, plugins, marketplace, verbosity, context, link, close, renew, onboarding |
| `/session` | 세션 관리 | Ephemeral | (없음: 바로 세션 목록 표시) |
| `/new` | 세션 리셋 + 새 대화 시작 | In-channel | [optional prompt] |

### 5.3 Key Integration Points

1. **EventRouter** (`src/slack/event-router.ts`)
   - `setup()` 메서드에 `this.setupSlashCommands()` 추가
   - `app.command('/soma', handler)`, `app.command('/session', handler)`, `app.command('/new', handler)` 등록

2. **SlashCommandAdapter** (`src/slack/slash-command-adapter.ts`) — NEW
   - Slack slash command payload를 `CommandContext`로 변환
   - `command.text` → CommandRouter가 이해하는 형식으로 매핑
   - `ack()` 호출 + ephemeral/in-channel 응답 분기

3. **CommandContext 확장** — 기존 `SayFn` 대신 `respond` 사용 가능하도록
   - Slash command의 `respond()` → ephemeral 응답
   - Slash command의 `say()` → in-channel 응답

4. **Manifest 수정**
   - `slack-app-manifest.yaml`: `slash_commands` 섹션 + `commands` scope
   - `slack-app-manifest.json`: 동일

### 5.4 Slash Command Payload → CommandContext 매핑

```typescript
// Slack slash command payload
interface SlashCommandPayload {
  command: string;      // "/soma"
  text: string;         // "help" (subcommand 부분)
  user_id: string;
  channel_id: string;
  trigger_id: string;
  response_url: string;
}

// 변환 로직
function adapt(payload): CommandContext {
  return {
    user: payload.user_id,
    channel: payload.channel_id,
    threadTs: payload.channel_id,  // slash command는 thread context 없음 (예외: /new)
    text: payload.text,            // /soma의 경우 subcommand 텍스트
    say: wrapRespond(payload),     // respond()를 say()로 래핑
  };
}
```

### 5.5 /new 특수 처리

`/new`는 스레드 컨텍스트가 필요하다. Slash command는 기본적으로 thread_ts를 전달하지 않으므로:
- 채널 최상위에서 `/new` → "스레드 내에서 사용해주세요" 안내
- 스레드 내에서 `/new` → 해당 스레드의 세션 리셋 (thread_ts 사용 가능 여부에 따라)

> Note: Slack slash command는 스레드 내에서 실행해도 `channel_id`만 전달하고 `thread_ts`는 없을 수 있음. 이 경우 유저에게 텍스트 명령 `new`를 안내하는 fallback 필요.

## 6. Non-Functional Requirements

- **Performance**: Slash command는 3초 내 ack() 필요. 즉시 ack() 후 비동기 처리.
- **Security**: 기존 CommandHandler의 권한 체크 로직 그대로 적용.
- **Backward Compatibility**: 기존 텍스트 기반 명령 100% 유지.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Adapter 파일 위치: `src/slack/slash-command-adapter.ts` | tiny | 기존 slack/ 디렉토리 패턴 따름 |
| Manifest 구조: `slash_commands` 섹션 + `commands` scope | tiny | Slack 공식 스펙. 선택지 없음 |
| EventRouter에 `setupSlashCommands()` 메서드 추가 | small | 기존 `setupMessageHandlers()` 패턴과 동일 |
| `/soma` subcommand를 CommandRouter.route()에 그대로 전달 | small | 기존 regex 파서가 이미 `/` prefix 허용 (`^\/?`) |
| `/session`은 기존 SessionHandler의 기본 동작(ephemeral) 재사용 | tiny | SessionHandler가 이미 ephemeral 로직 보유 |
| 3초 ack() 후 비동기 처리 | tiny | Slack API 요구사항 |

## 8. Open Questions

- `/new`의 thread_ts 접근: Slack slash command가 스레드 내에서 실행될 때 thread_ts가 전달되는지 확인 필요. 안 되면 텍스트 명령 fallback 안내.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/slash-commands/spec.md`
