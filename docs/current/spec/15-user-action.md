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
owner presses ✅ / ❌ ── Slack: UserActionActionHandler · dashboard: POST /api/dashboard/session/:key/user-action
   (either surface)      → answerUserAction: instruction gate → a lock kept apart from the stored record (a second
                         press meanwhile is "in flight"; the record stays pending on disk whatever else saves) →
                         the host notifier (setUserActionNotifier, src/index.ts) sends "✅ 사용자 작업 완료: …" /
                         "❌ 사용자 작업 안 됨: …" (with the script) as the actor's message in the thread and waits for
                         it to be taken (onAccepted) → only then: card rewritten without buttons, persisted, broadcast.
                         Not taken → nothing was ever written; lock released, answerable again (also after a restart).
```

## The contract

- **Required fields**: `title` (one line, ≤ 80), `host` (the machine by the name the owner knows, one line), `why`, `script`, `expect`, `effects` (the model's own reading of what the script changes). `shell` is `bash` (default), `zsh` or `sh` — POSIX only, because the check reads POSIX shell; `optional` marks a task the work goes on without.
- **Short script**: at most 8 lines and 600 characters, and at most 2800 characters once `&<>` are escaped for Slack, so the card always shows the script whole — exactly the text that was checked (other long text is split across sections, never cut). No ``` in the script. Longer logic goes into a file the agent prepares; the owner gets the one line that runs it.
- **Refused** (the model gets the reason and must fix the call): a missing field, a too-long script, a bare URL or comment-only script (`NOT_A_SCRIPT` — a browser or phone step still starts from a command such as `open 'https://…'`), a credential in any posted field — script, title, host, why, expect, effects (`SECRET_IN_SCRIPT`; known token prefixes, JWTs, bearer headers, a password in a URL (`https://me:x@host`), a secret-named key (TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE, PASSCODE, CREDENTIAL, API_KEY, PRIVATE_KEY, ACCESS_KEY — any case, anywhere in a name; PASS / PW as a whole part of one; the Korean 비밀번호, 비번, 암호, 패스워드, 토큰, 시크릿, API 키) given a literal value of any length with `=`, `+=`, `:`, `：`, `:=` or `=>`, in any form a field carries it: a shell assignment or option (`PASSWORD='x'`, `export "PASSWORD=x"`, `--password=x`, `--token x`, `--client-secret x`; in the script the shell's own reading decides, so `TOKEN= date` is an empty value and `--password-stdin` names no secret) or prose, markup and data (`PASSWORD: x`, `` `PASSWORD=x` ``, `**Password**: x`, `{"password":"x"}`, `{password: x}`, escaped `{\"password\":\"x\"}`, a header `X-Api-Key: x`). The value passes only when it is empty, a path, or comes from elsewhere: `$X`, `${X}`, `${X:?msg}`, `$(command)` (not `echo`, `printf`, `base64`, `xxd`, `rev`, `openssl enc`, nor a `<<<` here-string), a `<placeholder>`; text the shell writes itself — `'$x'`, `$'x'`, a `${X:-default}` default — is literal. The refusal never repeats it), a script that does not parse, or holds a here-document that is never closed (`SYNTAX_ERROR` — `bash -n` passes that one, and pasted it would swallow every command after it).
- **Credential refusal is a second line, not the first.** The first is the prompt rule (a script reads a secret from where the human keeps it — `$VAR`, `$(pass show …)`, a prompt — and never carries one) and the owner reading the whole script before running it. The validator then refuses the forms it can recognise without guessing: known token shapes (GitHub, Anthropic/OpenAI-style `sk-`, Slack, AWS, Google keys, private-key blocks, JWTs, bearer headers); a secret-named key with a literal value (above); a password in a URL's `user:password@` or in `-u` / `--user` / `--proxy-user name:password`; an HTTP credential after `Bearer` / `Basic`, in any case (any length). A heredoc body is data: a secret-named key there is checked like JSON, outside any shell quote. In the script a header or data value (`-H 'X-Api-Key: …'`, `-d '{"password":"…"}'`) is read as the shell hands it over, so a `$` inside single quotes is literal. In the script every one of these is read as the shell reads the word (quotes, `$'…'`, `${X:-default}`, `$(echo …)`, `$(cat <<< …)`). A secret in a shape none of these name (for example a bare word handed to `mysql -p`) is not detected; such a shape is added as a rule with a regression test, not by widening a guess.
- **The check** shown next to the script: verdict (✅ 통과 · ⚠️ 주의 · ⛔ 위험), the syntax check that ran (`bash -n`, or "검사 못 함" when no checker exists — a caution, never a pass), the commands it runs (keywords such as `if`/`while`/`for` skipped, `$(…)` and backticks read as commands of their own, heredoc bodies read as input — except the `$(…)`/backticks an unquoted `<<EOF` body expands), its length, and every finding:
  - `rule:<id>` — the same dangerous-rule catalog `evaluateToolPolicy` applies to the agent's Bash (caution);
  - `irreversible:<id>` — the irreversible-action reader the permission prompts use (caution);
  - `sudo` (caution, also when it stands as an argument — `xargs sudo …`), `remote-code` (`curl`/`wget` piped into a shell or interpreter in the same pipeline, also across a line continuation, a pipe that ends a line, or a wrapper such as `sudo -u root` / `sudo --user root`; danger), `hidden-code` (`eval`, or a base64 decode piped into a shell or interpreter in the same pipeline — also behind `sudo` / `env`; danger); `env -S '…'` is read as the command line it runs;
  - `writes-files` and `network` (info, with the targets).
- **Who may answer**: the instruction gate (`InstructionApprovals.allows`) — the owner, someone approved for the session, or a trusted person — on both surfaces. Anyone else is refused (Slack: an ephemeral note; dashboard: 403); nothing changes.
- **Audience**: the board's copy has the same audience as the pending question. The Slack message ts stays server-side.

## Where the rule lives

- The model rule: `src/prompt/common.prompt` §Tasks for the user. Skills: `local:auto-es` (a user-only step is a user task, named by title in the follow-up section) and `local:UIAskUserQuestion` (a question, not a task).
- Code: `somalib/user-action/user-action.ts` (validation, inspection, list helpers, result parser), `packages/mcp-servers/user-action/`, `src/slack/user-action-{card,host}.ts`, `src/slack/actions/user-action-action-handler.ts`, `src/conversation/user-actions-view.ts`, the dashboard client (`panelUserActionsHtml`).
