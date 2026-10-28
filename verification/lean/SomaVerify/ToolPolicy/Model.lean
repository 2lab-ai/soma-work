-- models: src/agent-runtime/policy/tool-policy.ts:44 (PR_CREATE_MCP_TOOL)
-- models: src/agent-runtime/policy/tool-policy.ts:52-69 (ToolPolicyDecision, ToolPolicyResult)
-- models: src/agent-runtime/policy/tool-policy.ts:76-107 (ToolPolicyContext: the fields the policy reads)
-- models: src/agent-runtime/policy/tool-policy.ts:122-130 (IncidentReadOnlyContext)
-- models: src/agent-runtime/policy/tool-policy.ts:132-134 (asStr)
-- models: src/agent-runtime/policy/tool-policy.ts:141-154 (checkSensitiveForTool: the call it makes and its result)
-- models: src/agent-runtime/policy/tool-policy.ts:156-157 (DEVOPS_SECRET_DENY_MESSAGE)
-- models: src/agent-runtime/policy/tool-policy.ts:164-179 (checkDevopsSecretForTool: the call it makes and its result)
-- models: src/agent-runtime/policy/tool-policy.ts:192-199 (evaluateIncidentReadOnly)
-- models: src/agent-runtime/policy/tool-policy.ts:205-308 (evaluateToolPolicy)
-- models: src/agent-runtime/policy/tool-policy.ts:311 (TOOL_POLICY_MATCHERS)
-- models: src/agent-runtime/policy/tool-policy.ts:328 (INCIDENT_TOOL_POLICY_MATCHERS)
-- models: src/agent-runtime/policy/permission-mode.ts:28 (PermissionMode)
-- models: src/hooks/bypass-permission-guard.ts:38-51 (NATIVE_BYPASS_TOOLS)
import SomaVerify.Support.Json
import SomaVerify.Support.JsString

/-!
# Model of `evaluateToolPolicy`

`evaluateToolPolicy(toolName, toolInput, ctx)` is the single authorization decision for a tool
call: a deny tier of seven guards, where the first guard that fires returns, then the incident
READ-ONLY tier when `ctx.incidentReadOnly` is set, else a mode tier. This file transcribes it
branch by branch; line numbers refer to `src/agent-runtime/policy/tool-policy.ts` unless another
file is named.

`ctx.incidentReadOnly` is not a field of `Input` but the first argument of `evaluateToolPolicy`,
and `evaluate` is `evaluateToolPolicy none`, the call with that property undefined. Every theorem
of `Spec.lean`, `Proofs.lean`, `Simplification.lean` and `ProofsDevops.lean` is about `evaluate`, so
the incident tier leaves each of them as it was; `ProofsIncident.lean` proves what the tier does.

The guard primitives are inputs of the model, not part of it. `isSshCommand`,
`isCrossUserAccess`, `bypassBashPermissionDecision`, the three sensitive-path checks, the three
devops-secret checks (`devops-secret-guard.ts`), `handlePrIssuePrecondition` and
`ctx.checkMcpToolPermission` appear through the values they return (`Primitives`). The model is about how the policy combines those values, which is also
what `tool-policy.lean-conformance.test.ts` exercises: it mocks the primitives and feeds each
vector's values to the real function.

What the policy reads itself, and the model therefore transcribes:

* the tool name, through `=== 'Bash'`, the `switch` in `checkSensitiveForTool` and in
  `checkDevopsSecretForTool`, `startsWith('mcp__')`, `=== PR_CREATE_MCP_TOOL`,
  `NATIVE_BYPASS_TOOLS.includes` and `allowedMcpTools.includes`;
* `toolInput.command`, `toolInput.file_path`, `toolInput.pattern` and `toolInput.path`, after
  line 210 replaces an undefined `toolInput` with `{}`. `checkSensitiveForTool` picks the
  arguments of its sensitive-path check from them (lines 144-150), and `toolInput.path` also
  decides whether a Grep is checked at all (line 150). `sensitiveCall` is that call, arguments
  included. `checkDevopsSecretForTool` picks the arguments of its devops-secret check from them
  too (lines 167-175); `devopsCall` is that call;
* `ctx.isAdmin`, `ctx.mode`, `ctx.aborted`, whether `ctx.handoffContext` is defined, and whether
  `ctx.incidentReadOnly` is defined, with its `allowedMcpTools`.

The arguments of the sensitive-path and devops-secret checks are modelled; those of the other
primitives are not. `Primitives.sensitive` is the value of the call `sensitiveCall` describes and
`Primitives.devopsSecret` that of the call `devopsCall` describes, and the mocked replay answers
only those exact calls, throwing on any other, so a wrong argument or a wrong check makes it fail.
The other primitives receive `command` (line 211, also `asStr(input.command)`),
`ctx.user`, `ctx.isDangerousRuleDisabled`, the tool name or the tool input; the model takes
their values as given and does not describe those arguments.

The model takes every primitive value as given, including those the TS never asks for on the
path it takes (`&&` skips the call); a value that is never asked for cannot reach the result,
and the proofs show which values each result depends on.

This is the model of the code after the proof-backed simplification and the devops-secret step
(phase 3, step 1b). `ModelOriginal.lean` keeps the phase-1 model of the code before both,
`Proofs.lean` proves the documented invariants for that model, and `Simplification.lean` proves
this model equal to it on every input where the devops-secret step returns nothing.
`ProofsDevops.lean` proves every documented invariant for this model, the devops-secret step
included.
-/

namespace SomaVerify.ToolPolicy

open SomaVerify SomaVerify.JsString

/-- `PermissionMode` — permission-mode.ts:28. -/
inductive Mode where
  | auto
  | bypass
  | legacy
  deriving DecidableEq, Repr

/-- The string a `PermissionMode` is (permission-mode.ts:28), which `${ctx.mode}` renders (line 303). -/
def Mode.name : Mode → String
  | .auto => "auto"
  | .bypass => "bypass"
  | .legacy => "legacy"

/-- `ToolPolicyDecision` — line 52. -/
inductive Decision where
  | allow
  | deny
  | classify
  | pass
  deriving DecidableEq, Repr

/-- `ToolPolicyResult` — lines 54-69. An optional property that the TS object omits, or sets to
`undefined`, is `none`. -/
structure Result where
  decision : Decision
  reason : String
  denyMessage : Option String := none
  matchedRuleIds : Option (List String) := none
  deriving DecidableEq, Repr

/-- `SensitivePathResult` — sensitive-path-filter.ts:243-246. -/
structure SensitivePathResult where
  isSensitive : Bool
  reason : Option String := none
  deriving DecidableEq, Repr

/-- `PrIssueGuardResult` — pr-issue-guard.ts:52-56. Its `reason` is the string union
`PrIssueGuardReason` there; the policy only interpolates it, so any string stands for it. -/
structure PrIssueGuardResult where
  blocked : Bool
  reason : Option String := none
  message : Option String := none
  deriving DecidableEq, Repr

/-- `BypassBashPermissionResult['decision']` — dangerous-command-filter.ts:45. -/
inductive BashVerdict where
  | allow
  | ask
  deriving DecidableEq, Repr

/-- `BypassBashPermissionResult` — dangerous-command-filter.ts:44-47. -/
structure BashPermission where
  decision : BashVerdict
  matchedRuleIds : List String
  deriving DecidableEq, Repr

/-- What the guard primitives return for one call. -/
structure Primitives where
  /-- `isSshCommand(command)` — line 233. -/
  ssh : Bool
  /-- The value the sensitive-path check returns for the one call `checkSensitiveForTool` makes,
  `sensitiveCall` (lines 144-150). Not used when it makes none. -/
  sensitive : SensitivePathResult
  /-- `isCrossUserAccess(command, ctx.user)` — line 253. -/
  crossUser : Bool
  /-- `ctx.checkMcpToolPermission(toolName)` — line 245; `null` is `none`. -/
  mcpDenied : Option String
  /-- `handlePrIssuePrecondition({ toolName, toolInput: input, handoffContext })` — line 261. -/
  prIssue : PrIssueGuardResult
  /-- `bypassBashPermissionDecision(command, ctx.isDangerousRuleDisabled)` — line 291. -/
  bash : BashPermission
  /-- The value the devops-secret check returns for the one call `checkDevopsSecretForTool` makes,
  `devopsCall` (lines 166-175): a reason, or `none` for `null`. Not used when it makes none. Added
  with the devops-secret step; the phase-1 model (`ModelOriginal.lean`) never reads it, and it
  defaults to `none`, a check that comes back clear. -/
  devopsSecret : Option String := none
  deriving DecidableEq, Repr

/-- A property value, as far as `typeof v === 'string'` and `typeof v === 'string' && v` (lines
133, 148, 150) can tell values apart. -/
inductive Field where
  /-- no such property -/
  | absent
  /-- a string -/
  | str (s : String)
  /-- any other value: a number, a boolean, an object, `null` -/
  | other
  deriving DecidableEq, Repr

/-- `asStr(v)` — lines 132-134: the string, or `''` for any other value. -/
def Field.asStr : Field → String
  | .str s => s
  | _ => ""

/-- `typeof v === 'string' ? v : undefined` — line 148, where `none` is `undefined`. The empty
string counts: `typeof '' === 'string'`. -/
def Field.string? : Field → Option String
  | .str s => some s
  | _ => none

/-- `typeof v === 'string' && v` is truthy: `v` is a string, and a string is truthy exactly when
it is not empty. -/
def Field.isNonEmptyString : Field → Bool
  | .str s => s != ""
  | _ => false

/-- One call of `evaluateToolPolicy(toolName, toolInput, ctx)`, all of `ctx` but
`incidentReadOnly`. The four tool-input properties are read from `input = toolInput ?? {}`
(line 210). -/
structure Input where
  /-- `toolName` -/
  toolName : String
  /-- `input.command`: the argument of the Bash sensitive-path and devops-secret checks (lines 144,
  167) -/
  command : Field
  /-- `input.file_path`: the argument of the Read sensitive-path check (line 146) and of the Read,
  Edit and Write devops-secret check (line 171) -/
  filePath : Field
  /-- `input.pattern`: the first argument of the Glob sensitive-path and devops-secret checks (lines
  148, 175) -/
  pattern : Field
  /-- `input.path`: the Glob base (lines 148, 175) and the Grep path (lines 150, 173) -/
  path : Field
  /-- `ctx.isAdmin` -/
  isAdmin : Bool
  /-- `ctx.mode` -/
  mode : Mode
  /-- `ctx.aborted` -/
  aborted : Bool
  /-- `ctx.handoffContext` is defined. A `HandoffContext` is an object, so defined means truthy
  (line 260). -/
  handoff : Bool
  /-- the primitives' values -/
  prims : Primitives
  deriving DecidableEq, Repr

/-- `IncidentReadOnlyContext` — lines 122-130: the exact names of the `mcp__` tools an incident
session may call. -/
structure IncidentReadOnly where
  /-- `allowedMcpTools` — line 129. -/
  allowedMcpTools : List String
  deriving DecidableEq, Repr

/-- A call of one of the three sensitive-path checks, with the arguments it receives. -/
inductive SensitiveCall where
  /-- `checkBashSensitivePaths(command)` -/
  | bash (command : String)
  /-- `checkSensitivePath(filePath)` -/
  | path (filePath : String)
  /-- `checkSensitiveGlob(pattern, basePath)`; `none` is an `undefined` base path -/
  | glob (pattern : String) (basePath : Option String)
  deriving DecidableEq, Repr

/-- `PR_CREATE_MCP_TOOL` — line 44. -/
def prCreateMcpTool : String := "mcp__github__create_pull_request"

/-- `NATIVE_BYPASS_TOOLS` — bypass-permission-guard.ts:38-51, in source order. -/
def nativeBypassTools : List String :=
  ["Write", "Edit", "NotebookEdit", "TodoWrite", "Read", "Glob", "Grep", "Task", "Agent",
    "WebFetch", "WebSearch", "KillShell"]

/-- `TOOL_POLICY_MATCHERS` — line 311: `['Bash', NATIVE_BYPASS_TOOLS.join('|'), 'mcp__']`. -/
def toolPolicyMatchers : List String :=
  ["Bash", "|".intercalate nativeBypassTools, "mcp__"]

/-- `INCIDENT_TOOL_POLICY_MATCHERS` — line 328: `[undefined]`, one entry without a matcher, which
the SDK fires for every tool (lines 314-327). `none` is `undefined`. -/
def incidentToolPolicyMatchers : List (Option String) :=
  [none]

/-- `(toolInput ?? {})[key]` (line 210) for a tool input written as JSON, where `none` is an
undefined `toolInput`. The vector generator derives the four tool-input fields of `Input` with it
from the exact input it hands to the TS function. A JSON object in a vector never repeats a key,
so the first match is the only one. -/
def jsonField (key : String) : Option Json → Field
  | some (.obj fields) =>
    match fields.lookup key with
    | none => .absent
    | some (.str s) => .str s
    | some _ => .other
  | _ => .absent

/-- The sensitive-path check `checkSensitiveForTool` (lines 141-154) calls, with its arguments;
`none` when it calls none. -/
def sensitiveCall (i : Input) : Option SensitiveCall :=
  if i.toolName = "Bash" then some (.bash i.command.asStr)              -- 144: asStr(input.command)
  else if i.toolName = "Read" then some (.path i.filePath.asStr)         -- 146: asStr(input.file_path)
  else if i.toolName = "Glob" then                                       -- 148: asStr(input.pattern),
    some (.glob i.pattern.asStr i.path.string?)                          --   the path when a string
  else if i.toolName = "Grep" then                                       -- 150: input.path, when
    if i.path.isNonEmptyString then some (.path i.path.asStr) else none  --   a non-empty string
  else none                                                              -- 151-152: no call

/-- `checkSensitiveForTool(toolName, input)` — lines 141-154. `sensitive` is the value of the call
`sensitiveCall` describes; `none` is the `undefined` of the `default` arm. -/
def checkSensitiveForTool (toolName : String) (path : Field) (sensitive : SensitivePathResult) :
    Option SensitivePathResult :=
  if toolName = "Bash" then some sensitive          -- 143-144: checkBashSensitivePaths(...)
  else if toolName = "Read" then some sensitive     -- 145-146: checkSensitivePath(...)
  else if toolName = "Glob" then some sensitive     -- 147-148: checkSensitiveGlob(...)
  else if toolName = "Grep" then                    -- 149-150
    if path.isNonEmptyString then some sensitive    --   checkSensitivePath(input.path)
    else some { isSensitive := false }              --   { isSensitive: false }
  else none                                         -- 151-152: undefined

/-- A call of one of the three devops-secret checks (`devops-secret-guard.ts`), with the arguments
it receives. -/
inductive DevopsCall where
  /-- `checkDevopsSecretCommand(command)` -/
  | command (command : String)
  /-- `checkDevopsSecretPath(filePath)` -/
  | path (filePath : String)
  /-- `checkDevopsSecretGlob(pattern, basePath)` -/
  | glob (pattern basePath : String)
  deriving DecidableEq, Repr

/-- The devops-secret check `checkDevopsSecretForTool` (lines 164-179) calls, with its arguments;
`none` when it calls none. Every argument is an `asStr(...)`, so a missing or non-string property
is the empty string. -/
def devopsCall (i : Input) : Option DevopsCall :=
  if i.toolName = "Bash" then some (.command i.command.asStr)                   -- 166-167
  else if i.toolName = "Read" ∨ i.toolName = "Edit" ∨ i.toolName = "Write" then  -- 168-171
    some (.path i.filePath.asStr)
  else if i.toolName = "Grep" then some (.path i.path.asStr)                    -- 172-173
  else if i.toolName = "Glob" then some (.glob i.pattern.asStr i.path.asStr)    -- 174-175
  else none                                                                     -- 176-177

/-- The tools `checkDevopsSecretForTool` consults a check for (lines 166-175). -/
def devopsTools : List String :=
  ["Bash", "Read", "Edit", "Write", "Grep", "Glob"]

/-- `checkDevopsSecretForTool(toolName, input)` — lines 164-179. `devops` is the value of the call
`devopsCall` describes; `none` is the `null` of the `default` arm. -/
def checkDevopsSecretForTool (toolName : String) (devops : Option String) : Option String :=
  if toolName = "Bash" then devops                                              -- 166-167
  else if toolName = "Read" ∨ toolName = "Edit" ∨ toolName = "Write" then devops  -- 168-171
  else if toolName = "Grep" then devops                                         -- 172-173
  else if toolName = "Glob" then devops                                         -- 174-175
  else none                                                                     -- 176-177

/-- `DEVOPS_SECRET_DENY_MESSAGE` — lines 156-157. -/
def devopsSecretDenyMessage : String :=
  "Blocked: reading GitHub or keychain credentials and touching the devops broker files is denied in every permission mode."

/-! ## The deny tier (lines 213-269)

Each step is a function: `some r` is the `return r` it executes, `none` falls through to the next
step. Steps 2-4 sit inside one `if (!ctx.isAdmin || ctx.incidentReadOnly)` block, so they test the
admin flag and the incident context once. -/

/-- 1. Abort guard (Bash only) — lines 217-221. -/
def abortGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.aborted = true then
    some { decision := .deny, reason := "abort-guard: session aborted" }
  else none

/-- 1b. Devops-secret — lines 223-228: every mode, admins too. Any non-null value is a reason
(`devopsSecret !== null`), the empty string included. -/
def devopsGuard (i : Input) : Option Result :=
  match checkDevopsSecretForTool i.toolName i.prims.devopsSecret with
  | some reason =>
    some { decision := .deny, reason := "devops-secret: " ++ reason,
           denyMessage := some devopsSecretDenyMessage }
  | none => none

/-- 2. SSH ban (Bash) — lines 232-235. -/
def sshCheck (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.ssh = true then
    some { decision := .deny, reason := "ssh-ban: ssh command for non-admin user" }
  else none

/-- 3. Sensitive path — lines 236-240. `sensitive?.isSensitive` is falsy when the dispatch
returns `undefined`. -/
def sensitiveCheck (i : Input) : Option Result :=
  match checkSensitiveForTool i.toolName i.path i.prims.sensitive with
  | some sensitive =>
    if sensitive.isSensitive then
      some { decision := .deny,
             reason := "sensitive-path: " ++ sensitive.reason.getD "sensitive location" }
    else none
  | none => none

/-- 4. MCP tool permission (`mcp__` tools) — lines 241-249. Any non-null value is a deny reason
(`denied !== null`), the empty string included. -/
def mcpCheck (i : Input) : Option Result :=
  if jsStartsWith i.toolName "mcp__" = true then
    match i.prims.mcpDenied with
    | some denied => some { decision := .deny, reason := "mcp-permission: " ++ denied }
    | none => none
  else none

/-- Steps 2-4, `if (!ctx.isAdmin || ctx.incidentReadOnly) { … }` — lines 230-250: for a non-admin,
or for anyone in an incident session (an `IncidentReadOnlyContext` is an object, so set means
truthy), the first of the three checks that returns. `incident` is `ctx.incidentReadOnly`. -/
def adminExemptGuards (incident : Option IncidentReadOnly) (i : Input) : Option Result :=
  if i.isAdmin = false ∨ incident.isSome = true then
    match sshCheck i with
    | some r => some r
    | none =>
    match sensitiveCheck i with
    | some r => some r
    | none => mcpCheck i
  else none

/-- 5. Cross-user directory isolation (Bash, always) — lines 252-255. -/
def crossUserGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.crossUser = true then
    some { decision := .deny, reason := "cross-user: another user directory" }
  else none

/-- 6. PR-issue precondition — lines 257-269. `denyMessage: result.message` sets the property to
`undefined` when the guard gives no message, which is `none` here as well. -/
def prIssueGuard (i : Input) : Option Result :=
  if i.handoff = true ∧ (i.toolName = "Bash" ∨ i.toolName = prCreateMcpTool) then
    if i.prims.prIssue.blocked then
      some { decision := .deny,
             reason := "pr-issue: " ++ i.prims.prIssue.reason.getD "precondition failed",
             denyMessage := i.prims.prIssue.message }
    else none
  else none

/-! ## The incident READ-ONLY tier (lines 271-275), reached only when no deny step returned -/

/-- `evaluateIncidentReadOnly(toolName, incident)` — lines 192-199: allow an `mcp__` tool whose
name is in `allowedMcpTools` (`includes`, exact string equality), deny every other call. It reads
neither the mode nor the admin flag, and never returns `pass` or `classify`. -/
def evaluateIncidentReadOnly (toolName : String) (incident : IncidentReadOnly) : Result :=
  if jsStartsWith toolName "mcp__" = true ∧ toolName ∈ incident.allowedMcpTools then  -- 195
    { decision := .allow, reason := "incident-read-only: allow-listed evidence tool " ++ toolName }
  else                                                                                -- 198
    { decision := .deny,
      reason := "incident-read-only: " ++ toolName ++ " is not an allow-listed evidence tool" }

/-! ## The mode tier (lines 277-307), reached only when no deny step returned and no incident
context is set -/

/-- Steps 7-9 and the default return. -/
def modeTier (i : Input) : Result :=
  if i.mode = .bypass ∧ i.toolName = "Bash" then                    -- 7. lines 284-286
    { decision := .allow, reason := "bypass: unsafe allow-all Bash" }
  else if i.mode = .auto ∧ i.toolName = "Bash" then                 -- 8. line 290
    match i.prims.bash.decision with                                -- 291-292
    | .ask =>                                                       -- 294
      { decision := .classify,
        reason := "auto-classify: " ++ ",".intercalate i.prims.bash.matchedRuleIds,
        matchedRuleIds := some i.prims.bash.matchedRuleIds }
    | .allow => { decision := .allow, reason := "auto: non-dangerous Bash" }  -- 296
  else if i.mode ≠ .legacy ∧ nativeBypassTools.contains i.toolName then  -- 9. lines 302-303
    { decision := .allow, reason := i.mode.name ++ ": native tool" }
  else { decision := .pass, reason := "no policy opinion" }          -- 307

/-- `evaluateToolPolicy` — lines 205-308, where `incident` is `ctx.incidentReadOnly` (`none` when
undefined): the abort guard, the devops-secret step, the non-admin block (which an incident context
makes apply to admins as well), the cross-user and PR-issue guards, in that order; the first that
returns decides. If none does, a set incident context hands the call to the incident tier (lines
273-274) and otherwise the mode tier decides. -/
def evaluateToolPolicy (incident : Option IncidentReadOnly) (i : Input) : Result :=
  match abortGuard i with
  | some r => r
  | none =>
  match devopsGuard i with
  | some r => r
  | none =>
  match adminExemptGuards incident i with
  | some r => r
  | none =>
  match crossUserGuard i with
  | some r => r
  | none =>
  match prIssueGuard i with
  | some r => r
  | none =>
  match incident with
  | some inc => evaluateIncidentReadOnly i.toolName inc
  | none => modeTier i

/-- `evaluateToolPolicy` with `ctx.incidentReadOnly` undefined: the function every theorem of
`Spec.lean`, `Simplification.lean` and `ProofsDevops.lean` is about. -/
def evaluate (i : Input) : Result :=
  evaluateToolPolicy none i

end SomaVerify.ToolPolicy
