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

각 룰은 `DANGEROUS_RULES` 카탈로그의 항목(`id`, `label`, `description`, `sessionOverridable`)으로 선언된다.

| 룰 id | 패턴 | 설명 | `sessionOverridable` |
|-------|------|------|----------------------|
| `kill`, `pkill`, `killall` | kill/pkill/killall | 프로세스 종료 | true |
| `rm-recursive`, `rm-force`, `rm-force-long` | rm -r*, rm -f*, rm --force | 재귀/강제 삭제 | true |
| `shutdown`, `reboot`, `halt` | shutdown/reboot/halt | 시스템 종료 | true |
| `mkfs` | mkfs | 파일시스템 포맷 | true |
| `dd-if` | dd if= | 디스크 복사 | true |
| `chmod-world-recursive` | chmod -R *7*7 | 재귀 world-writable | true |
| `cross-user-access` | /tmp/{otherUser}/ 경로 접근 | 유저 격리 — **항상 deny**, bypass로도 풀리지 않음 | **false (lockdown)** |
| `ssh-remote` | ssh/scp/sftp/rsync -e ssh | 원격 셸 — admin 전용 | **false (lockdown)** |

`sessionOverridable=true` 룰만 아래의 세션 스코프 비활성화 대상이 된다. `cross-user-access`와 `ssh-remote`는 유저가 세션에서 끌 수 없는 lockdown 룰이며, 각각 별도의 enforcement 경로(다른 `PreToolUse` hook / admin 체크)로 동작한다.

## 세션 스코프 룰 비활성화 — "Approve & disable rule for this session"

### 동기

유저가 해당 세션에서 의도적으로 반복해야 하는 위험 명령이 있다. 예: `kill` 룰이 걸려서 매번 물어보는데, 이번 thread에선 계속 쓸 것임. 매번 Approve만 눌러주는 건 마찰이고, 룰을 영구히 끄는 건 위험.

### 동작

Slack 퍼미션 프롬프트에 4번째 버튼 `🔓 Approve & disable rule (this session)` 을 추가. bypass-mode Bash escalation이고 `sessionOverridable=true` 룰에 매칭됐을 때만 렌더된다.

버튼 클릭 시:
1. 현재 툴 호출을 `allow`로 승인
2. 매칭된 룰 id(s)를 해당 `ConversationSession`의 `disabledDangerousRules` Set에 추가 (in-memory)
3. 이후 같은 세션에서 같은 룰만 매칭되는 bash 명령은 `bypassBashPermissionDecision`이 자동으로 `allow`로 디그레이드 — 다시 물어보지 않음

### 스코프

- **세션 = Slack thread = `ConversationSession`**. 같은 유저라도 다른 thread는 별개의 `disabledDangerousRules` 집합을 가진다.
- **in-memory only**. `saveSessions()`는 `disabledDangerousRules` 필드를 직렬화하지 않음. 봇 재시작 / 세션 만료 / 세션 종료 시 자동 리셋. 재활성 UI는 이 PR 범위 밖.
- **per-rule granularity**. 끄는 단위는 명령 문자열이 아니라 룰 id. `kill`을 끄면 `kill 1234`, `kill -9 99`가 모두 통과.
- **overridable 룰만 대상**. `cross-user-access` / `ssh-remote`는 버튼에 노출되지 않음 — 다른 hook에서 강제되므로 이 경로의 비활성화는 무의미하고 보안상 위험.

### 부분 비활성화 시 동작

복합 명령 `rm -rf /tmp/x` 는 `rm-recursive`와 `rm-force` 두 룰에 동시 매칭된다. 이 중 `rm-recursive`만 세션에서 disable된 상태에서 다시 `rm -rf`를 실행하면, `rm-force`가 여전히 active이므로 Slack UI가 다시 뜬다. `bypassBashPermissionDecision`은 매칭된 **모든** 룰이 disable일 때에만 `allow`로 디그레이드한다.

### 아키텍처 메모 — cross-process rule flow

`permission-mcp-server`는 parent 프로세스의 `SessionRegistry`에 직접 접근할 수 없다. 대신:

1. `permission-mcp-server`가 command에서 `overridableMatchedRuleIds()`를 **다시** 계산 (stateless)
2. 계산된 `rule_ids`를 `PendingApproval`에 저장 (shared-store / 파일 IPC)
3. 유저가 `approve_disable_rule_session` 버튼 클릭 → `PermissionActionHandler.handleApproveDisableRule`
4. Handler가 `sharedStore.getPendingApproval(approvalId)`로 `rule_ids`와 `{channel, thread_ts}`를 회수
5. `ClaudeHandler.getSessionRegistry()`로 세션 키 매핑 → `disableDangerousRules(sessionKey, ruleIds)`
6. `sharedStore.storePermissionResponse(approvalId, {behavior: 'allow'})`로 원래 호출 승인

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

`dangerous-command-filter.ts`는 테스트 커버리지가 확장됐고 (rule catalog + session disable),
`SessionRegistry`의 rule-disable API와 `PermissionActionHandler.handleApproveDisableRule`도
각각 단위 테스트를 갖췄지만, bypass-mode `PreToolUse` hook의 end-to-end 분기 (위험 → ask,
안전 → allow, disable된 룰 → allow) 자체는 여전히 `ClaudeSDK` 통합 테스트가 없다.
