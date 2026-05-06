# Commands Reference

## Version
- Document Version: 2.1
- Last Updated: 2026-04-16 (#506: `/z` Phase 1)

## 1. Overview

이 문서는 Claude Code Slack Bot에서 사용 가능한 모든 명령어를 설명합니다. 모든 명령어는 `/` 접두사 유무와 관계없이 동작합니다.

### 1.1 `/z` 통합 명령 표면 (Phase 1 — #506)

Phase 1부터 모든 명령은 `/z <topic> [verb] [args…]` 통합 문법으로 접근하는 것이 권장됩니다. 기존 네이키드 문법(`persona linus`, `model sonnet`, …)은 사용자당 한 번만 마이그레이션 힌트(`tombstone`)를 보여주고 이후 드롭됩니다. 화이트리스트(`session`, `sessions public`, `new`, `renew`, `theme`, `$*`)는 계속 네이키드로 동작합니다.

- 아키텍처: `docs/spec/01-slack-integration.md` §10
- 롤백 절차: `docs/ops/rollback-z-refactor.md`
- 롤백 플래그: `SOMA_ENABLE_LEGACY_SLASH=true` (Tier 1 — 즉시)
- 제거된 별칭(#506): `set_cct` → `cct set`, `nextcct` → `cct next`, `플러그인 업데이트` → `plugin update`, `show_prompt` → `show prompt`, `show_instructions` → `show instructions`, `servers` → `mcp list`, `credentials` → `restore`, `commands`/`?`·`commands?` → `help`, `kill`/`end` → `terminate`, `report help` → `/z help`.

## 2. Working Directory Commands

### 2.1 Set Working Directory

**명령어**:
```
cwd <path>
/cwd <path>
set cwd <path>
set directory <path>
set working-directory <path>
```

**설명**: Claude가 작업할 디렉토리를 설정합니다.

**파라미터**:
- `<path>`: 절대 경로 또는 BASE_DIRECTORY 기준 상대 경로

**예시**:
```
cwd my-project
cwd /Users/dev/Code/my-project
set directory backend-api
```

**응답**:
```
✅ Working directory set for this thread: `/Users/dev/Code/my-project`
_This will be your default for future conversations._
```

### 2.2 Get Working Directory

**명령어**:
```
cwd
/cwd
cwd?
get cwd
directory
working-directory
```

**설명**: 현재 설정된 작업 디렉토리를 확인합니다.

**응답 (설정됨)**:
```
Current working directory for this channel: `/Users/dev/Code/my-project`

Base directory: `/Users/dev/Code`
You can use relative paths like `cwd project-name` or absolute paths.
```

**응답 (미설정)**:
```
No working directory set for this channel. Please set one using:
`cwd project-name` (relative to base directory)
`cwd /absolute/path/to/directory` (absolute path)

Base directory: `/Users/dev/Code`
```

## 3. Permission Commands

### 3.1 Check Bypass Status

**명령어**:
```
bypass
/bypass
```

**설명**: 현재 권한 우회 설정 상태를 확인합니다.

**응답**:
```
🔐 *Permission Bypass Status*

Your current setting: OFF
✅ Claude will ask for permission before executing sensitive tools.
```

### 3.2 Enable Bypass

**명령어**:
```
bypass on
/bypass on
```

**설명**: 권한 확인을 건너뛰고 도구를 자동 실행하도록 설정합니다.

**응답**:
```
✅ *Permission Bypass Enabled*

Claude will now execute tools without asking for permission.
⚠️ Use with caution - this allows Claude to perform actions automatically.
```

### 3.3 Disable Bypass

**명령어**:
```
bypass off
/bypass off
```

**설명**: 도구 실행 전 권한 확인을 요청하도록 설정합니다.

**응답**:
```
✅ *Permission Bypass Disabled*

Claude will now ask for your permission before executing sensitive tools.
```

## 4. MCP Commands

### 4.1 View MCP Servers

**명령어**:
```
mcp
/mcp
```

**설명**: 설정된 MCP 서버 목록을 확인합니다.

**응답**:
```
🔧 **MCP Servers Configured:**

• **jira** (sse)
  URL: `https://mcp.atlassian.com/v1/sse`

• **github** (stdio) (GitHub App)
  Command: `npx`
  Args: `-y @modelcontextprotocol/server-github`

• **filesystem** (stdio)
  Command: `npx`
  Args: `-y @modelcontextprotocol/server-filesystem /usercontent`

Available tools follow the pattern: `mcp__serverName__toolName`
All MCP tools are allowed by default.
```

### 4.2 Reload MCP Configuration

**명령어**:
```
mcp reload
/mcp reload
```

**설명**: `config.json` 파일에서 MCP 설정을 다시 로드합니다.

**응답**:
```
✅ MCP configuration reloaded successfully.

🔧 **MCP Servers Configured:**
...
```

## 5. Persona Commands

### 5.1 List Personas

**명령어**:
```
persona
/persona
```

**설명**: 사용 가능한 페르소나 목록과 현재 설정을 확인합니다.

**응답**:
```
🎭 *Available Personas*

Current: `default`

Available:
• `default`
• `chaechae`

To change: `persona <name>`
```

### 5.2 Set Persona

**명령어**:
```
persona <name>
/persona <name>
```

**설명**: AI 어시스턴트의 페르소나를 변경합니다.

**파라미터**:
- `<name>`: 페르소나 파일명 (.md 확장자 제외)

**예시**:
```
persona chaechae
persona default
```

**응답**:
```
✅ Persona changed to `chaechae`

Your AI assistant will now use this personality.
```

## 6. Session Commands

### 6.1 List My Sessions

**명령어**:
```
sessions
/sessions
```

**설명**: 현재 사용자의 활성 세션 목록을 확인합니다.

**응답**:
```
📋 *내 세션 목록* (2개)

*1. #channel-name* (thread)
   📁 `/path/to/project`
   🕐 마지막 활동: 5분 전 | 🎯 현재 대화: 다른사용자
   ⏳ 만료: 23시간 55분 남음

*2. DM*
   📁 `/path/to/other`
   🕐 마지막 활동: 1시간 전
   ⏳ 만료: 22시간 남음
```

### 6.2 List All Sessions

**명령어**:
```
all_sessions
/all_sessions
```

**설명**: 전체 활성 세션 현황을 확인합니다.

**응답**:
```
🌐 *전체 세션 현황* (5개)

👤 *홍길동* (2개 세션)
   • #backend (thread) | 📁 `project-a` | 🕐 5분 전 | ⏳ 23시간 남음
   • DM | 📁 `project-b` | 🕐 1시간 전 | ⏳ 22시간 남음

👤 *김철수* (3개 세션)
   • #frontend | 📁 `webapp` | 🕐 30분 전 | 🎯 박영희 | ⏳ 23시간 30분 남음
   ...
```

## 7. Help Command

### 7.1 Show Help

**명령어**:
```
help
/help
?
```

**설명**: 사용 가능한 명령어 목록을 표시합니다.

**응답**:
```
📖 *Claude Code Bot - Help*

**Working Directory**
• `cwd` - View current working directory
• `cwd <path>` - Set working directory

**Permissions**
• `bypass` - Check bypass status
• `bypass on/off` - Enable/disable permission bypass

**MCP**
• `mcp` - List MCP servers
• `mcp reload` - Reload MCP configuration

**Persona**
• `persona` - List available personas
• `persona <name>` - Change persona

**Sessions**
• `sessions` - List your sessions
• `all_sessions` - List all sessions

**Usage**
• In DM: Just type your message
• In channels: @mention the bot or reply in an active thread
```

## 8. Request Cancellation

### 8.1 Cancel Request

**명령어**:
```
취소
stop
cancel
```

**설명**: 현재 진행 중인 Claude 요청을 취소합니다.

**조건**:
- 세션 소유자 또는 현재 요청자만 취소 가능
- 진행 중인 요청이 있어야 함

**응답**:
```
⏹️ *Request cancelled*
```

## 9. Special Inputs

### 9.1 File Uploads

**설명**: 파일을 업로드하면 자동으로 처리됩니다.

**지원 형식**:
- 이미지: JPG, PNG, GIF, WebP, SVG
- 텍스트: TXT, MD, JSON, JS, TS, PY, etc.
- 코드: 대부분의 프로그래밍 언어

**사용법**:
1. 파일을 드래그 앤 드롭 또는 업로드
2. (선택) 텍스트 메시지 추가
3. 전송

**예시**:
```
[screenshot.png 업로드]
이 오류 메시지 분석해줘
```

### 9.2 URLs and Links

**GitHub PR/Issue**:
```
https://github.com/org/repo/pull/123
```

**Jira Issue**:
```
https://yoursite.atlassian.net/browse/PROJECT-123
```

**Confluence Page**:
```
https://yoursite.atlassian.net/wiki/spaces/SPACE/pages/123456789
```

## 10. Command Summary Table

| Command | Description | Slash Support |
|---------|-------------|---------------|
| `cwd` / `cwd <path>` | 현재/설정 작업 디렉토리 | ✅ |
| `bypass` / `bypass on/off` | 권한 우회 상태/설정 | ✅ |
| `mcp` / `mcp reload` | MCP 서버 목록/리로드 | ✅ |
| `persona` / `persona <name>` | 페르소나 목록/변경 | ✅ |
| `model` / `model <name>` | 모델 목록/변경 (sonnet/opus/haiku) | ✅ |
| `verbosity` / `verbosity <level>` | 출력 상세도 설정 | ✅ |
| `sessions` / `all_sessions` | 내 세션/전체 세션 목록 | ✅ |
| `new` | 세션 초기화 (새 세션 시작) | ✅ |
| `renew` | 세션 갱신 (설정 유지, 대화 리셋) | ✅ |
| `close` | 현재 스레드 세션 종료 | ✅ |
| `context` | 컨텍스트 윈도우 상태 확인 | ✅ |
| `restore` | 세션 복원 | ✅ |
| `link [url]` | 세션에 이슈/PR/문서 링크 첨부 | ✅ |
| `onboarding` | 온보딩 워크플로우 실행 | ✅ |
| `help` | 도움말 표시 | ✅ |
| `admin` | 관리자 명령 (accept/deny/users/config) | ✅ |
| `cct [set <name> \| next]` | CCT 토큰 상태 / 수동 전환 / 다음 토큰으로 회전 | ✅ |
| `marketplace` | 플러그인 마켓플레이스 | ✅ |
| `plugin[s]` | 설치된 플러그인 관리 (`add`/`remove`/`update`/`rollback`/`backups`) | ✅ |
| `%` / `%model` / `%verbosity` | 세션 전용 설정 (비영속). `$` 접두는 deprecation grace period 동안만 허용되며 경고 메시지와 함께 실행됨. `$`는 강제 스킬 발동 전용. | ✅ |
| `취소/stop/cancel` | 진행 중 요청 취소 | ❌ |

## 11. Usage Contexts

### 11.1 Direct Message (DM)

- @멘션 불필요
- 즉시 응답
- 개인 세션

```
User: cwd my-project
Bot: ✅ Working directory set...

User: package.json 내용 보여줘
Bot: [파일 내용 표시]
```

### 11.2 Channel

- 첫 대화는 @멘션 필요
- 스레드에서 계속 대화

```
User: @Claude cwd backend-api
Bot: ✅ Working directory set...

User: (same thread, no mention) API 엔드포인트 목록 보여줘
Bot: [엔드포인트 목록]
```

### 11.3 Thread Override

- 스레드에서 다른 디렉토리로 작업

```
User: @Claude cwd frontend-app
Bot: ✅ Working directory set for this thread...
```

## 12. Error Responses

### 12.1 No Working Directory

```
⚠️ No working directory set. Please set a default working directory for this channel first using:
`cwd project-name` or `cwd /absolute/path`
```

### 12.2 Invalid Directory

```
❌ Directory not found: "invalid-name" (checked in base directory: /Users/dev/Code)
```

### 12.3 Permission Denied

```
❌ You don't have permission to cancel this request. Only the session owner or current requester can cancel.
```

### 12.4 Unknown Command

알 수 없는 명령어는 일반 메시지로 처리되어 Claude에게 전달됩니다.
