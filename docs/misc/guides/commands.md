# soma-work commands

## Commands

Four prefix families — each with a clear, non-overlapping purpose:

| Prefix | Scope | Persistence | Example |
|--------|-------|-------------|---------|
| `/z <topic> …` | Primary command surface (Block Kit UI where it makes sense) | User-global | `/z persona set linus` |
| `%<sub> …` | **Current session only** — override without saving | Ephemeral (reset on `new`/`renew`) | `%model opus` |
| `$<skill>` / `$<plugin>:<skill>` | **Force skill invocation** (reads `SKILL.md`, emits RPG banner at `compact` and above — at `minimal` it is not posted; recorded in the dashboard work log when the session has a conversation) | Per-message | `$z`, `$stv:new-task` |
| naked text | Bare command forms (see below) or chat / workflow dispatch | n/a | `sessions`, `new`, `fix PR 123` |

> **Split history (#508)**: `$` used to double as both "force skill" and "session setting". It was split — `%` took over session settings, `$` is now skill-only. Legacy `$model` / `$verbosity` / `$effort` / `$thinking` / `$thinking_summary` still work during the deprecation grace period but emit a one-line notice nudging users to `%`.

> **Dashboard composer menus (2026-11-04)**: in the dashboard's two inputs — **New task** and an open session's composer — typing `/` as the first thing lists every command you can use there, each with what it does and a typical use in grey. The new task offers every command that works without an existing session (all but the ones that act on the thread's session, such as `/compact` or `!`). A command that only answers says so in its row — its answer is posted in the Slack thread, and the dashboard says where with a link. As a new task's first message such a command is launched answer-only: it answers in the new thread and no task card is made. Admins also see the admin commands. `%` lists the session settings, and `$` at the start of any word lists every skill you can invoke, as the token that names it (`$user:…`, `$local:…`, `$<plugin>:…`). Typing filters the list; ↑↓ move, Enter or Tab picks, Esc closes. The lists come from `GET /api/dashboard/composer-menus` ([`src/conversation/composer-menus.ts`](../../../src/conversation/composer-menus.ts)); its test routes every command row's example through the production `CommandRouter`, so a row cannot name a command the bot would treat as chat. The menu itself is `@2lab.ai/ui` `<ui-composer>` `data.triggers` (0.27.0).

### `/z` — primary surface

Grammar: `/z <topic> [verb] [args...]`. See `docs/current/spec/01-slack-integration.md` for the full surface, `docs/runbook/rollback-z-refactor.md` for emergency rollback.

| Command | Description |
|---------|-------------|
| `/z help` | Show all topics |
| `/z cwd [set <path>]` | Show / set working directory |
| `/z mcp [list\|reload]` | List MCP servers / reload config |
| `/z bypass [set on\|off]` | Toggle permission bypass |
| `/z lang [set ko\|en]` | Display language for the dashboard, the Slack thread and the answers (per user, Korean by default; naked `lang ko\|en` / `language ko\|en` also accepted) |
| `/z epictasks [set on\|off]` | Allow making epics: the composer's **에픽** switch on a new task (`epic: true` on the new-task API; per user, off by default, experimental; naked `epictasks on\|off` also accepted). An epic is a Slack thread that writes a plan tree and makes each child its own thread in the same channel; its instruction to a working child waits in that child's queue. With the switch on, work the dispatcher sizes as one task or less (about 10 minutes) is made an ordinary task instead, and the thread says why; no estimate (or a failed dispatch) keeps the epic. |
| `/z persona [set <name>\|list]` | Switch persona |
| `/z model [set <name>\|list]` | Switch model (sonnet, opus, haiku) |
| `/z verbosity [set <level>]` | Set output verbosity (`minimal` · `compact` · `detail` · `verbose`). The default is `minimal`: the thread shows the task list (the main agent's — a subagent's own list lives on its dashboard entry), questions/approvals, the final answer and errors; the model's running narration, tool calls, compaction notices and skill banners (`$skill` and autoskill included) go to the dashboard work log |
| `/z session` · `sessions` | List active sessions (`sessions` naked form still accepted) |
| `/z new` · `/z renew` | Reset / renew session (naked `new` / `renew` also accepted) |
| `/z close` | Close current thread session |
| `/z restore` | Restore a session |
| `/z context` · `/z compact` | Show / compact the context window |
| `rollback` · `rollback <n>` · `rollback goal` · `rollback cancel` · `rollback redo` | Roll the model's conversation context back to just before one of your inputs, or (`rollback goal`) to where a stalled goal first failed — files are not touched (naked form only; `롤백` also works). `rollback redo` takes the last rollback back until the next message runs. On the dashboard, **⏪ 되돌리기 모드** in the detail card puts a button on each instruction in the chat and each point in the work log; an instruction rollback puts the instruction back into the composer. Spec: [`docs/current/spec/context-rollback.md`](../../../docs/current/spec/context-rollback.md) |
| `/z link <type> <url>` | Attach issue/PR/doc links |
| `/z onboarding` | Run onboarding workflow |
| `/z admin [accept\|deny\|users\|config\|llmchat\|session list]` | Admin commands |
| `/z cct [set <name>\|next]` | CCT token status / manual switch |
| `/z auth [llmux\|cct\|switch <name>\|key]` | Auth backend card: read-only capacity overview by provider (see [Auth capacity overview](#auth-capacity-overview)) + runtime mode switch (llmux default / cct legacy) and account switch/add/remove behind explicit Admin mode; `key` DMs your personal llmux client key |
| `/z marketplace [add <x>]` | Plugin marketplace |
| `/z plugin [add\|update\|remove\|rollback\|backups]` | Manage installed plugins |
| `/z skill [list\|download]` | Skills directory |
| `/z report [today\|daily\|weekly]` | Usage reports |

### llmux SDK authentication

Soma-work uses the Claude Agent SDK's Messages transport with llmux, including
Codex-backed models from its model catalog. Each SDK call carries its selected
llmux URL and key together: the personal tenant pair when available, otherwise
the existing shared-key fallback (including helper calls without a tenant lease).
Inherited OAuth/bearer credentials,
alternative-provider selectors, and authentication custom headers cannot replace
that choice; unrelated custom headers remain available. See the [SDK authentication contract](../../../docs/current/spec/llmux-sdk-auth.md).

### Auth capacity overview

In llmux mode the `auth` card is first and foremost a **read-only capacity
overview** of the llmux account pool (`GET /llmux/status`), rendered the same
for everyone — admins included:

- **Grouped by provider** — Claude → Codex → Grok, then any other groups
  alphabetically; within a group, accounts follow the scheduler's selection
  order.
- **Normalized account equivalents, not tokens** — per-group totals sum the
  remaining `5h` / `7d` (and scoped weekly, e.g. `7d-fable`) window ratios as
  account equivalents: 100% of one account = 1, with no plan weighting. The
  llmux status contract carries only utilization ratios and reset times — no
  token denominators exist, so a token balance is never shown or implied, and
  cumulative token totals are labelled as consumption, not remaining budget.
- **Reset planning** — every known reset renders as a Slack-local absolute
  timestamp plus relative time remaining, and each group summary names the
  next upcoming reset: which window, which account, and the normalized
  percentage points it recovers (valid only with no further usage; other
  windows, cooldowns and auth failures stay as reported).
- **Unknown stays unknown** — missing, expired or out-of-range windows render
  as "not supplied / re-query needed", never as 0% or 100%; model-scoped
  windows are listed separately from the shared limits, and cold/null values
  are excluded from totals with the measured coverage shown (`measured n/m`).
- **Grok / API-key accounts** — upstream llmux collapses raw request/token
  counts into a utilization ratio and attaches a synthetic short reset horizon
  to Grok's reset-less burst limits; the card shows the rate-limit ratio but
  suppresses that synthetic reset instead of presenting it as a real quota
  window with a countdown.
- **Codex manual resets** — observed `usage_control` counters (owned /
  currently applicable) display read-only; soma-work never redeems them
  automatically.
- **Admin is explicit opt-in** — every entry point renders readonly; eligible
  admins get an [Admin mode] button, and only that opens the mode switch /
  settings / add / remove / switch controls. A forged or stale admin click
  from a non-admin is demoted to readonly server-side.
- **Pagination** — large pools page at a fixed size with prev/next buttons so
  every account is reachable; Refresh and paging preserve the chosen view and
  page. The legacy CCT view embedded in `auth` also pages slots; its management
  buttons and modal submissions return to the same auth view and page. The
  separate `cct` command keeps its existing behavior.

### Dashboard capacity

The web dashboard shows the same llmux pool as an **LLM 가용량** section between
the stats strip and the Agent inbox (`GET /api/dashboard/capacity`, llmux read at
most every 30 s; the page refetches every 60 s). It starts folded on every window
(your unfold choice is kept per device); folded, one chip per subscription provider
gives both windows as max accounts' worth of the total and %:
`Claude 지금 5.2/16.0 33% · 주 5.6/16.0 35%`. Below 840px the chips wrap, breaking
only between the two measures. A chip whose oldest reading is over a day old, or
whose pool counts fewer than 80% of its accounts, carries a warning:
`Codex 주 2.37/2.4 99% ⚠ 5일 전 · 3/5 반영`. Why two bars, 5h on top: see
[`docs/misc/research/2026-10-25-capacity-dual-window.md`](../../../docs/misc/research/2026-10-25-capacity-dual-window.md).

**llmux save mode (admins, top bar).** The **세이브** chip in the top bar sets
llmux save mode: until a time you choose, llmux uses only the accounts whose
weekly quota resets before then and holds the rest like a pause, so next week's
quota is still there when work starts (for example, on Friday set Monday 15:00).
The chip reads `세이브 끔` or `세이브 ~ <time>`; a press opens a dialog with the
time (the next Monday 15:00 by default) and 켜기 / 끄기. It turns off by itself
at that time. When every account that may serve is spent, requests are refused
until then. Only admins see the chip; changing it needs Admin mode on (or the
viewer token), like the lifecycle policy. Held accounts read 세이브 모드 in the
capacity cards. API: `PUT /api/dashboard/llmux-save-mode` `{ until: <epoch seconds> | null }`
→ llmux `POST /llmux/save-mode`; needs an llmux with save mode (the chip stays
hidden on an older one).

Unfolded, each provider (Claude, Codex; API-key pools have no plan unit and are
not shown) is one simple card:

- **Two bars** — `5시간 · 지금 쓸 수 있음` (the smaller of the 5h and weekly
  remaining; 0 while blocked) and `일주일 · 이번 주 남음`, each
  `x / total 계정 · %`, with one line for what raises it next — how much and when,
  `다음 +1.0계정 · 1시간 23분 후` (the cause is named only when it is not the bar's
  own reset, e.g. `· 차단 해제`; the account is in the tooltip; a 5시간 bar held by
  the weekly limit reads `일주일 한도에 묶임 · 다음 …`). Codex (no 5h data) has the
  weekly bar only. "계정" = max accounts' worth: tier weight (Max x20 = 1, x5 = ¼,
  Pro $500 = 1, $200 = 0.4) × remaining — a normalised estimate, not tokens. The %
  is from the raw ratio (100% only when full); a count that rounds to the total
  keeps two decimals (`2.37 / 2.4 · 99%`).
- **One muted disclosure line**, only what is non-zero:
  `16/17 반영(차단 6 포함) · 제외 1(보류) · 측정 4시간 전` — accounts counted (and how
  many of them are blocked right now), left out (paused / auth failure / no known lift = 보류, an untiered Codex account,
  no weekly reading), Claude accounts counted on an assumed x20 plan and the oldest llmux reading when over an hour old.
- **One timeline**, now → 24h (55% of the width) → 7d: ● is a gain to the 5시간 bar
  (label above), ◆ a gain to the 일주일 bar (label below), in the bars' colours;
  refills whose labels would collide merge into one marker with a span. Gains come
  from replaying each account's resets in time order (blocks lifted first, then
  5h, then weekly). With no 5h gain in 7 days the ● key says "늘어날 양 없음"; with only small ones
  (each under 0.05) it gives their sum, `+0.1계정 미만` or e.g. `+0.1계정`, in the same words
  as the bars' next line and the chip tooltip.
- Tiers: llmux ≥ 0.2.26 reports each account's plan — Claude `rate_limit_tier`
  (`default_claude_max_20x`), Codex `plan_type` (`pro` = $200, `promax` = $500) — and
  the dashboard uses it with no configuration. Order: `SOMA_LLMUX_ACCOUNT_TIERS`
  (`group:name=tier`, e.g. `claude:ai7=x20,claude:ai12=x5`) → the plan llmux reports → built-in defaults
  (Codex `ai1`·`ai2` = Pro $200, `ai5`·`ai6` = Pro $500). A bare llmux `max` is
  never read as x5/x20. An unmapped **Claude** account counts as Max x20 and is said
  so — `티어 미지정 15(x20 가정)` on the card, `⚠ x20 가정 15` on the folded chip — so a
  host without the map still shows its pool (2026-10-26). An unmapped
  Codex account stays out of the totals (`제외 1(티어 미지정)`).
- Not routed through llmux (`ccp` mode) → the section is hidden; llmux
  unreachable → the section says so with a fixed reason.

Spec: [`.prd/12-cron-lane-and-llm-capacity-spec.md`](../../../.prd/12-cron-lane-and-llm-capacity-spec.md).

Wiring: [`src/slack/z/topics/auth-topic.ts`](../../../src/slack/z/topics/auth-topic.ts)
→ [`src/auth/llmux-client.ts`](../../../src/auth/llmux-client.ts) →
[`src/slack/auth/capacity.ts`](../../../src/slack/auth/capacity.ts) →
[`src/slack/auth/builder.ts`](../../../src/slack/auth/builder.ts). Details and pinned
upstream source verification:
[`.prd/07-auth-capacity-spec.md`](../../../.prd/07-auth-capacity-spec.md).

### Auto-compact thresholds (`autocompact` / `compact-threshold`)

If the provider rejects a compact request, the failure notice includes the provider's error details with credentials redacted. Slack details are length-limited with an explicit truncation note; server logs retain the full redacted reason. A failure notice does not mean compaction succeeded.

`autocompact` is a message command (the message may also start with `/`, as in
`/autocompact`; it is not a separately registered Slack slash command). It sets
how many used tokens a session may reach before soma-work schedules `/compact`.
The setting is **session-scoped** — it lives on the conversation session and
persists with that session across process restarts. Use `reset` to clear it and
return to the model/default threshold.

| Form | Effect |
|------|--------|
| `/autocompact` · `autocompact` | Show the effective threshold and which source it came from |
| `/autocompact <value>` · `autocompact <value>` | Set the session threshold. Accepts `800k`, `800K`, `0.8M`, `800000`, or bare `800` (read as thousands — `autocompact 800` = 800,000); the general range is 100k–1M, but a model's own safe maximum can reject a syntactically valid value |
| `/autocompact reset` · `autocompact reset` | Clear the session override — falls back to the model default |

**Precedence** (highest wins): session override (`/autocompact <value>`) → the
model's canonical default → the legacy per-user percentage, converted against
the current model's context window.

**Model defaults** — resolved by `resolveModelProfile` in
[`src/metrics/model-profile.ts`](../../../src/metrics/model-profile.ts), which is the
source of truth for any model not listed here:

| Model | Context window | Auto-compact default |
|---|---|---|
| `claude-fable-5-2[1m]` (aliases `fable`, `fable[1m]`, `fable-5-2`, `fable-5-2[1m]`) | 1,000,000 | 750,000 |
| `claude-fable-5-1[1m]` (version-pinned aliases `fable-5-1`, `fable-5-1[1m]`) | 1,000,000 | 750,000 |
| `claude-fable-5[1m]` (version-pinned alias `fable-5`) | 1,000,000 | 750,000 |
| `claude-opus-5-5[1m]` (aliases `opus`, `opus[1m]`, `opus-5-5`) | 1,000,000 | 750,000 |
| `claude-opus-5[1m]` (version-pinned alias `opus-5[1m]`) | 1,000,000 | 750,000 |
| `claude-opus-5-5` (bare, no `[1m]`) | 200,000 | none — falls back to the legacy per-user percentage below |
| `claude-opus-5` (bare, no `[1m]`) | 200,000 | none — falls back to the legacy per-user percentage below |
| `gpt-5.6-sol[1m]` (literal id only) | 1,000,000 | 600,000 |
| `gpt-5.6-sol` (bare; the default, alias `gpt`) | 372,000 | 340,000 |
| `gpt-6-astra[1m]` (aliases `astra`, `astra[1m]`, `gpt-6`, `gpt6`) | 1,000,000 | 600,000 |
| `gpt-6-astra` (bare literal only) | 272,000 | 240,000 |
| `gpt-6.1-sol[1m]` (aliases `sol`, `sol[1m]`, `gpt-6.1`) | 1,000,000 | 600,000 |
| `gpt-6.1-sol` (bare literal only) | 272,000 | 240,000 |
| `gpt-6.1-terra[1m]` (aliases `terra`, `terra[1m]`) | 1,000,000 | 600,000 |
| `gpt-6.1-terra` (bare literal only) | 500,000 | 450,000 |
| `grok-4.7` (the representative grok: dashboard `grok[1m]`, featured model button; `grok` resolves through the llmux catalog to the same pin) | 500,000 | 450,000 |
| `grok-4.6` (literal id) | 500,000 | 450,000 |

Every `gpt-…[1m]` profile, including future supported models, automatically uses
Sol's 1M window, 977,000 SDK blocking limit and 600,000 auto-compact default.
No per-model threshold registration is needed. This policy does not create
unsupported model variants or change explicitly selected bare model IDs.
Session overrides still take precedence.

`grok-4.7[1m]` / `grok-4.6[1m]` are not real models — xAI's grok window is
500,000, so a `[1m]` spelling would make the client budget for a window the
backend does not have — so they are rejected everywhere a model id is
accepted (model set, session model, `/autocompact`) with a visible
`use grok-4.7` / `use grok-4.6` message rather than being silently rewritten.

`/compact-threshold <percent>` is a **deprecated** compatibility adapter, not a
second setting: it converts `<percent>` against the *current* model's context
window, writes the result into the same session token slot `/autocompact`
uses, and removes the old stored per-user percentage once the conversion
succeeds. A conversion that would land above the model's safe maximum fails
visibly instead of silently clamping.

soma-work's own threshold checker is the sole automatic-compaction authority —
the Claude Agent SDK's built-in autocompaction is disabled for every resolved
model profile, so exactly one scheduler ever decides when a session compacts.
The checker runs as each API call of a turn lands, not only when the turn ends.
A turn that crosses the threshold is stopped, the conversation is compacted,
and the work continues automatically (goal sessions through their goal loop).
A turn that started already over the threshold is not stopped — the next turn
compacts. After a restart, a session whose saved context is at or over its
threshold compacts before its next turn.

### `%` — session-scoped (ephemeral)

Overrides that apply **only to the current session** and do not persist. Cleared on `/z new` or `/z renew`.

| Command | Description |
|---------|-------------|
| `%` | Show session info (model, verbosity, effort, thinking flags) |
| `%model [<name>]` | Get / set session model (e.g. `%model opus`) |
| `%verbosity [<level>]` | Get / set session verbosity (same levels; default `minimal`, see `/z verbosity`) |
| `%effort [<level>]` | Get / set session effort |
| `%thinking [on\|off]` | Toggle extended thinking for this session |
| `%thinking_summary [on\|off]` | Toggle thinking-output display |

> The `$` prefix is still accepted for these subcommands (`$model opus`, …) during the deprecation grace period — the bot will reply with a one-line hint directing you to `%`.

### `$` — forced skill invocation

Forces the bot to read a skill's `SKILL.md` and follow it. Emits a red RPG banner ("⚡ skill 강제 발동") on resolution at `compact` and above; at `minimal` the banner is not posted (the skill still runs). At every level the banner is recorded in the dashboard work log when the session has a conversation.

| Syntax | Resolves to |
|--------|-------------|
| `$<skill>` | `src/local/skills/<skill>/SKILL.md` (bare shorthand for local skills) |
| `$local:<skill>` | Same as above, explicit form; a name zworkflow lacks falls back to `src/local-harness/skills/<skill>/SKILL.md` (soma-work harness plugin, e.g. `$local:auto-es`) |
| `$user:<skill>` | `DATA_DIR/{userId}/skills/<skill>/SKILL.md` (per-user skills) |
| `$<plugin>:<skill>` | `plugins/<plugin>/skills/<skill>/SKILL.md` |

Representative examples: `$z`, `$zcheck`, `$stv:new-task`. For the current inventory see [`src/local/skills/`](../../../src/local/skills/) (hardcoded lists drift — always check the directory).

Nested `$plugin:skill` references inside skill content are resolved recursively (max depth 10).

### naked — bare-text compatibility

Bare (no-prefix) `[cmd] [args]` forms run through the same command handlers as their `/z` counterparts. The source of truth is the handler chain of [`CommandRouter`](../../../packages/slack/src/commands/command-router.ts) and its `CommandParser.is*Command` matchers (including operational cards such as `auth`, `cct`). In a DM, a non-admin may send only the inputs [`isDmAllowedForNonAdmin`](../../../packages/slack/src/z/whitelist.ts) accepts. Common forms:

| Form | Notes |
|------|-------|
| `session` · `sessions` | List active sessions |
| `sessions public` | Public session listing |
| `sessions terminate <key>` | Terminate a session by key |
| `theme` · `theme <name>` · `theme set <name>` · `theme=<name>` | Theme get/set (both `set`-prefixed and bare-value forms accepted) |
| `sessions theme [<name>]` · `sessions theme=<name>` | Session-scoped theme |
| `new [<prompt>]` · `renew [<prompt>]` | Reset / renew session, optional prompt carries over |
| `auth` · `auth llmux\|cct` · `set auth <mode>` · `auth switch <name>` | Auth backend card / runtime mode switch (#1189; defaults to the read-only [capacity overview](#auth-capacity-overview) for everyone, mutations admin-only behind Admin mode) |
| `key` · `auth key` | DM yourself your personal llmux client key + local Claude Code (`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`) and Codex (`OPENAI_BASE_URL`/`OPENAI_API_KEY`) setup. Same user always gets the same key; llmux meters bot + local usage as one tenant. Works for every user (it is your own key) |
| `cct` · `cct set <n>` · `cct next` · `cct usage [<n>]` · `cct auto [dry]` | CCT token status / rotation; `auto` = admin-only manual auto-rotate (token mutation is card-only since #569) |
| `cron` · `schedule` (also `크론` · `스케줄`) | Interactive cron card — per-job model/output-target dropdowns + delete button; routed as a command so autogoal can never swallow it; admins see all users' jobs with the owner shown |
| `cron model <name> <default\|opus\|fable\|fast\|model>` · `cron target <name> <channel\|dm\|thread>` · `cron delete <name>` | Change a job's model (`default` = creator's current model at fire time; `opus`/`fable` = latest opus/fable resolved at fire time) / delivery target / delete; admins address another user's job by appending `<@owner>` |
| `$` · `$model <v>` · `$verbosity <v>` · `$effort <v>` · `$thinking <v>` · `$thinking_summary <v>` | **Legacy** session prefix during deprecation grace period (emits one-line notice, use `%` going forward) |

The Codex block in the key DM points `OPENAI_BASE_URL` at the advertised server's `/v1` endpoint and uses your same tenant key. Copy the complete `codex --model … -c …` invocation: its explicit Responses provider reads `OPENAI_API_KEY` even when you already use ChatGPT login or another provider. The exports apply to the current terminal; the invocation does not rewrite Codex config or login credentials. Use that invocation again for later llmux sessions. See [Codex gateway authentication](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway).

Any free-form text that no command handler claims is treated as a chat / workflow dispatch prompt.

**Cron runs on the dashboard**: a session a cron fire creates starts under the job's name (not `Direct (skipDispatch)`); that title is provisional, so the first clear title — the turn summary or a linked issue/PR — replaces it, and the card fades the new title in. Its card leads with a **CRON** badge and lives in the dashboard's **CRON lane** above the columns: one tile per job with the schedule in words (cron is UTC), the next run, the last runs as a glyph-coded strip (✓ success · ✗ failed · ● running · ▲ needs you · ◌ no session), and the job's latest run as a live card. **지난 실행** opens a drawer with every kept run (the history keeps the last 20 per job) linked to its session, work log, conversation and Slack thread (`GET /api/dashboard/cron`). A cron fire injected into an existing session does not re-file that session.

**Post-deploy QA**: a host can install an environment plugin (such as `acme-env`) that provides a `post-deploy` skill. The deploy workflow then runs post-deploy QA as its step 7, in the deploy session itself, for each repo whose deploy is confirmed (setup: [docs/runbook/add-new-deploy.md](../../../docs/runbook/add-new-deploy.md) §8.5). At `qa=max` the QA first plans every issue against a coverage matrix of what a human QA checks, then checks each case's preconditions (accounts, test data, write permission, settings). If one is missing, it posts the gap table and asks the requester one question before running any case — provide it, proceed without it (those cases stay blocked, never pass), or skip the issue — and the run ends `deployed, QA incomplete: waiting for precondition confirmation` until they answer. A deploy requested with `$autoz` is sent by an automation, so nobody would answer: the workflow passes `waive=autoz`, the request counts as "proceed without", and the run waives every open precondition and goes on with QA in the same run, without asking. Waived cases stay blocked and never pass, and the report marks them `waived by $autoz`. Without `$autoz`, it asks and waits as above. The report lists the preconditions first.

**Environment skills need an admin's approval**: the skills of a deploy-time environment plugin run for admins (`ADMIN_USERS`) at once and for everyone else only on an admin's grant. A non-admin's `$plugin:skill` or the model's `Skill` call is stopped, every admin gets a DM with four buttons (1회 허용 for that thread, 이 스킬 항상 허용, 모든 환경 스킬 항상 허용, 거부), and on approval the requester's turn is sent again so the run continues (details: [docs/runbook/add-new-deploy.md](../../../docs/runbook/add-new-deploy.md) §8.5).

**Work queues — one dev2 deploy at a time**: some work runs at most N at a time across every user of the bot. The built-in queue serialises dev2 deploys: while one `… -> deploy/dev2` deploy runs, a second one does not start. Its requester gets a card that names who is deploying (with a thread link and how long it has run) and two buttons: **현재 배포가 끝나면 배포** (deploy after the current one) or **취소** (cancel). Cancelling, or making no choice within 10 minutes, ends the request, and a session made only for it is closed. A queued request starts on its own, in its own thread, when the slot frees; it then asks the usual deploy confirmation. The slot frees when the deploy session's turn ends, when the session is closed, or when the deploy has waited on its own question for 10 minutes. A later answer in that thread joins the queue again. The host reads the target from the trigger text (`dev2` and `deploy/dev2` are the same target) before the model starts, and a deploy session stays in its queue for its later turns. Configure the queues in `config.json#workQueues`. Without the key, the dev2 queue applies; `[]` turns all queues off. Each entry takes `id`, `label`, `workflow`, `targets`, optional `repos`, `concurrency`, `askTimeoutMinutes` and `holderIdleMinutes`. The queue lives in the bot's memory: it covers every user of one bot process, but not a second bot install or a merge made by hand.

**Task card link leak report**: every day at `SOMA_LINK_LEAK_REPORT_HOUR` (in `REPORT_TIMEZONE`), the host lists the PRs and issues the GitHub App opened in the last 24 hours (deploy PRs excluded) and checks each against every task card's links, live and archived. It posts how many reached no card, which landed on another session's card (the creating session comes from the write that made the PR), and the run of days with nothing missed. It alerts only after a baseline week, and only above that week's median. Set `SOMA_LINK_LEAK_REPORT_CHANNEL` to turn the daily post on; `report leaks` shows the current figure in the thread whenever the GitHub App is configured.

**Deploy release notes**: after a deploy, the deploy workflow writes the notes with `local:release-notes` and emits one `release_notes` directive per repo. The host posts a short root message — `repo target · version` plus up to three TL;DR lines — and the full notes as replies in its thread (cut losslessly, never truncated). The operator decides the channel with `SOMA_RELEASE_NOTES_CHANNELS` in the host's `.env` (for example `acme/app@deploy/dev2=C0DEV2CHAN1,*=session`): an exact `owner/repo@branch` or `branch` match goes to that channel, `*=session` keeps unmatched deploys in the deploy session's channel, and without `*` an unmatched deploy stays in the deploy thread. Unset means the deploy session's channel, as before. A failed post never moves the notes to another channel's root; they land in the deploy thread with a warning.

**Bare commands (#531)**: Bare forms such as `persona linus` or `model sonnet` run directly through their handlers. The one-time tombstone hint that #506 Phase 1 showed for them was removed in #531. `SOMA_ENABLE_LEGACY_SLASH=true` only restores the legacy `/soma`, `/session` and `/new` slash commands.
