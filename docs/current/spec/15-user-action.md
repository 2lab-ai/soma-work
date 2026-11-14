# 15 — User actions (`instruct_user`)

In short: when the agent needs the human to do something it cannot do itself, it hands over a short script and the machine to run it on through its own MCP tool. The host checks the script the way the agent's own Bash is checked and shows the script and the check in their own place — a Slack card and a "사용자 할 일" section on the dashboard — never folded into a reply or a question.

## Why it exists

A task buried in a report ("verify the channel", "run this on your Mac") left the owner asking which machine and what exactly to do. A task is not a question: a question asks for a decision or input (`ASK_USER_QUESTION`, [12](./12-ui-ask-user-question.md)); a task asks the owner to act. They get separate surfaces so neither hides the other.

## The flow

```
model ── mcp__user-action__instruct_user({ title, host, why, script, shell?, expect, effects, optional? })
           │  packages/mcp-servers/user-action — validate (somalib/user-action), `bash -n` syntax check,
           │  inspect (dangerous-rule catalog · irreversible actions · sudo · network · file writes · remote/hidden code)
           ▼
        tool result { type: 'user_action', ok, action: UserActionRecord }
           │  stream-executor onToolResult → provider captureUserActions (src/slack/user-action-host.ts)
           ▼
        session.userActions (persisted, ≤ 20, resolved ones dropped first)
           ├─ Slack: its own colored card (src/slack/user-action-card.ts) — where · script · what changes ·
           │         success · check result · ✅ 완료했어요 / ❌ 안 됐어요
           └─ dashboard: KanbanSession.userActions → detail card #panel-user-actions ("사용자 할 일"),
                         a count on the card face while a required one waits
owner presses ✅ / ❌ ── UserActionActionHandler → resolveSessionUserAction (first answer wins, card rewritten
                         without buttons) → a message to the agent through the normal message path
                         ("✅ 사용자 작업 완료: …" / "❌ 사용자 작업 안 됨: …", with the script)
```

## The contract

- **Required fields**: `title` (one line, ≤ 80), `host` (the machine by the name the owner knows, one line), `why`, `script`, `expect`, `effects` (the model's own reading of what the script changes). `shell` is `bash` (default), `zsh`, `sh` or `powershell`; `optional` marks a task the work goes on without.
- **Short script**: at most 8 lines and 600 characters. Longer logic goes into a file the agent prepares; the owner gets the one line that runs it.
- **Refused** (the model gets the reason and must fix the call): a missing field, a too-long script, a bare URL or comment-only script (`NOT_A_SCRIPT` — a browser or phone step still starts from a command such as `open 'https://…'`), a credential in the script (`SECRET_IN_SCRIPT`), a script that does not parse (`SYNTAX_ERROR`).
- **The check** shown next to the script: verdict (✅ 통과 · ⚠️ 주의 · ⛔ 위험), the syntax check that ran (`bash -n`, or "검사 못 함" when no checker exists — never shown as passed), the commands it runs, its length, and every finding:
  - `rule:<id>` — the same dangerous-rule catalog `evaluateToolPolicy` applies to the agent's Bash (caution);
  - `irreversible:<id>` — the irreversible-action reader the permission prompts use (caution);
  - `sudo` (caution), `remote-code` (download piped into a shell, danger), `hidden-code` (`eval`, base64-decoded execution, danger);
  - `writes-files` and `network` (info, with the targets).
- **Who may answer**: the instruction gate (`InstructionApprovals.allows`) — the owner, someone approved for the session, or a trusted person. Anyone else gets an ephemeral note; nothing changes.
- **Audience**: the board's copy has the same audience as the pending question. The Slack message ts stays server-side.

## Where the rule lives

- The model rule: `src/prompt/common.prompt` §Tasks for the user. Skills: `local:auto-es` (a user-only step is a user task, named by title in the follow-up section) and `local:UIAskUserQuestion` (a question, not a task).
- Code: `somalib/user-action/user-action.ts` (validation, inspection, list helpers, result parser), `packages/mcp-servers/user-action/`, `src/slack/user-action-{card,host}.ts`, `src/slack/actions/user-action-action-handler.ts`, `src/conversation/user-actions-view.ts`, the dashboard client (`panelUserActionsHtml`).
