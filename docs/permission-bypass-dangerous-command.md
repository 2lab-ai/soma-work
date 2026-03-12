# Permission System: Bypass + Dangerous Command Filtering

## 배경

Slack에서 Claude가 툴을 실행할 때, SDK `permissionMode`가 동작을 결정한다:

- `'default'` — 모든 툴 실행 전 퍼미션 체크. `permissionPromptToolName`으로 지정된 MCP 서버가 Slack UI(Approve/Deny/Explain 버튼)를 표시.
- `'bypassPermissions'` — 퍼미션 체크 자체를 건너뜀. 모든 툴 자동 실행.

유저는 `bypass on/off` 명령으로 자신의 모드를 전환한다.

## 원래 구현

`mcp-config-builder.ts`에서 bypass 여부에 따라 분기:

```
bypass ON:
  permissionMode = 'bypassPermissions'
  allowDangerouslySkipPermissions = true
  permission-prompt MCP 서버 미생성 (필요 없음)

bypass OFF:
  permissionMode = 'default'
  permission-prompt MCP 서버 생성 → Slack UI 버튼 노출
```

bypass ON이면 SDK 레벨에서 퍼미션을 아예 안 물어봄. permission MCP 서버도 없음. 완전 자동.

## 문제 제기

bypass ON 유저가 `kill -9`, `rm -rf /` 같은 위험 명령을 실행할 때도 자동 승인됨.
한 세션에서 다른 세션의 프로세스를 kill하는 등의 시나리오가 가능.

## 첫 번째 시도 — 실패 (커밋 `2e46609`)

### 접근

1. **모든 Slack 유저를 `default` 모드로 강제** (bypass 유저 포함)
2. permission-prompt MCP 서버를 모든 Slack 유저에게 생성
3. `PermissionRequest` hook을 추가해서:
   - 위험 명령 → `{ continue: true }` (Slack UI로 넘김)
   - bypass 유저 + 안전한 명령 → `hookSpecificOutput.decision: { behavior: 'allow' }` (자동 승인)
   - non-bypass 유저 → `{ continue: true }` (Slack UI로 넘김)

### 실패 원인

`hookSpecificOutput`의 `decision: { behavior: 'allow' }`를 SDK가 인식하지 못함.
`SyncHookJSONOutput`에는 두 가지 decision 경로가 있다:

| 경로 | 타입 | 역할 |
|------|------|------|
| `decision` (최상위) | `'approve' \| 'block'` | hook의 최종 결정 |
| `hookSpecificOutput.decision` | `{ behavior: 'allow' \| 'deny' }` | hook-specific 부가 데이터 |

첫 커밋은 `hookSpecificOutput`만 넣고 최상위 `decision`을 안 넣음 → SDK가 무시 → bypass 유저한테도 모든 툴 퍼미션 UI가 표시됨.

## 두 번째 시도 — 여전히 실패 (커밋 `36bf2ee`)

### 접근

`hookSpecificOutput` 대신 최상위 `decision: 'approve'`로 변경:

```typescript
// Before
return {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' },
  },
};

// After
return { decision: 'approve' };
```

### 실패 원인

`PermissionRequest` hook에서 최상위 `decision: 'approve'`도 SDK가 제대로 처리하지 않음.
결과 동일: bypass 유저한테 모든 툴 퍼미션 UI 표시. 스크린샷에서 "Tool execution approved" 메시지 30개 이상 도배.

**근본 원인**: `PermissionRequest` hook은 퍼미션 결정을 내리기 위한 hook이 아님. 이 hook은 퍼미션 요청이 발생했을 때 통보받는 용도에 가까우며, 여기서 결정을 반환해도 SDK가 반영하지 않는다.

## 최종 수정 — `PreToolUse` hook 사용

### 핵심

`PermissionRequest` hook 대신 `PreToolUse` hook의 `permissionDecision` 필드를 사용.

```typescript
type PreToolUseHookSpecificOutput = {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow' | 'deny' | 'ask';  // SDK가 퍼미션 결정용으로 설계한 필드
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
};
```

`permissionDecision`은 SDK에서 **퍼미션 결정을 위해 설계된 공식 필드**:
- `'allow'` — 이 툴 호출을 자동 승인 (퍼미션 UI 안 뜸)
- `'deny'` — 이 툴 호출을 거부
- `'ask'` — 유저에게 직접 물어봄

### 최종 구현 (bypassPermissions 모드 복원)

위 접근도 아키텍처가 뒤집힌 상태였다 (default 모드 + hook으로 매 툴마다 allow).
올바른 설계: **bypass 모드를 유지하고, 위험 Bash만 hook으로 차단**.

`mcp-config-builder.ts`:

```typescript
// bypass 유저 → bypassPermissions 모드 복원 (원래대로)
// permission-prompt MCP 서버는 모든 Slack 유저에게 생성 (위험 명령 ask용)
const config: McpConfig = !slackContext || userBypass
  ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, userBypass }
  : { permissionMode: 'default', userBypass };
```

`claude-handler.ts`:

```typescript
// bypass 유저에게만 PreToolUse hook 등록, Bash 매칭만
if (slackContext && mcpConfig.userBypass) {
  options.hooks = {
    ...options.hooks,
    PreToolUse: [{
      matcher: 'Bash',  // Bash 툴에서만 hook 실행
      hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
        const { tool_input } = input as { tool_input: unknown };
        const toolRecord = tool_input as Record<string, unknown> | undefined;
        const command = typeof toolRecord?.command === 'string' ? toolRecord.command : '';

        if (isDangerousCommand(command)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',  // bypass 모드 override → Slack UI 표시
            },
          };
        }

        return { continue: true };  // bypass 모드가 자동 승인
      }],
    }],
  };
}
```

### 분기표

| 유저 상태 | 툴 종류 | 동작 |
|-----------|---------|------|
| bypass ON | Bash 이외 모든 툴 | `bypassPermissions` 모드가 자동 승인. hook 안 탐. |
| bypass ON | Bash + 안전한 명령 | hook이 `{ continue: true }` → bypass 모드가 자동 승인 |
| bypass ON | Bash + 위험한 명령 | hook이 `permissionDecision: 'ask'` → Slack UI 퍼미션 표시 |
| bypass OFF | 모든 명령 | `default` 모드. hook 미등록. Slack UI 퍼미션 표시. |

### 위험 명령 목록 (`dangerous-command-filter.ts`)

| 패턴 | 설명 |
|------|------|
| `kill`, `pkill`, `killall` | 프로세스 종료 |
| `rm -r*`, `rm -f*`, `rm --recursive` | 재귀/강제 삭제 |
| `shutdown`, `reboot`, `halt` | 시스템 종료 |
| `mkfs` | 파일시스템 포맷 |
| `dd if=` | 디스크 복사 |
| `chmod -R *7*7` | 재귀 world-writable |

## 추가 수정: ephemeral 메시지 스팸 제거

`permission-action-handler.ts`에서 승인/거절/설명 요청 시 보내던 ephemeral 응답 메시지 제거:

```
- "Tool execution approved. Claude will now proceed with the operation."
- "Tool execution denied. Claude will not proceed with this operation."
- "Explanation requested. Claude will explain the action and ask for permission again."
```

유저가 버튼을 눌렀으면 이미 결과를 아는 것이므로, 매번 확인 메시지를 보내는 것은 스팸. 에러 케이스의 응답만 유지.

## 남은 문제

### bypassPermissions 모드에서 PreToolUse permissionDecision 존중 여부

`bypassPermissions` 모드에서 PreToolUse hook의 `permissionDecision: 'ask'`가 실제로 Slack UI를 트리거하는지
배포 후 실제 테스트로 검증 필요. 만약 bypass 모드가 hook을 무시하면, 위험 명령도 자동 승인될 수 있다.
그 경우 `permissionDecision: 'deny'`로 전환하여 명령 자체를 차단하는 방식으로 폴백.

### 정규식 빈틈

- `rm file.txt -f` — `rm` 직후에 `-f`가 안 오면 매칭 안 됨
- `rm --force` — 체크 안 함 (`--recursive`만 체크)
- `grep kill file.txt` — false positive (실제 프로세스를 죽이는 게 아님)

### hook 통합 테스트 부재

`dangerous-command-filter.ts`는 36개 테스트가 있지만,
PreToolUse hook 내부의 분기 로직 (위험 → continue, 안전 → allow) 자체는 테스트가 없다.
