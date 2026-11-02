-- models: src/agent-runtime/policy/tool-policy.ts:44 (PR_CREATE_MCP_TOOL)
-- models: src/agent-runtime/policy/tool-policy.ts:52-69 (ToolPolicyDecision, ToolPolicyResult)
-- models: src/agent-runtime/policy/tool-policy.ts:76-114 (ToolPolicyContext: the fields the policy reads)
-- models: src/agent-runtime/policy/tool-policy.ts:129-137 (IncidentReadOnlyContext)
-- models: src/agent-runtime/policy/tool-policy.ts:139-141 (asStr)
-- models: src/agent-runtime/policy/tool-policy.ts:148-161 (checkSensitiveForTool: the call it makes and its result)
-- models: src/agent-runtime/policy/tool-policy.ts:163-164 (DEVOPS_SECRET_DENY_MESSAGE)
-- models: src/agent-runtime/policy/tool-policy.ts:166-172 (ENV_SKILL_DENY_MESSAGE)
-- models: src/agent-runtime/policy/tool-policy.ts:179-194 (checkDevopsSecretForTool: the call it makes and its result)
-- models: src/agent-runtime/policy/tool-policy.ts:207-214 (evaluateIncidentReadOnly)
-- models: src/agent-runtime/policy/tool-policy.ts:220-334 (evaluateToolPolicy)
-- models: src/agent-runtime/policy/tool-policy.ts:343 (TOOL_POLICY_MATCHERS)
-- models: src/agent-runtime/policy/tool-policy.ts:360 (INCIDENT_TOOL_POLICY_MATCHERS)
-- models: src/agent-runtime/policy/native-write-boundary.ts:53-60 (NATIVE_WRITE_TOOLS)
-- models: src/agent-runtime/policy/permission-mode.ts:28 (PermissionMode)
-- models: src/hooks/bypass-permission-guard.ts:38-51 (NATIVE_BYPASS_TOOLS)
import SomaVerify.Support.Json
import SomaVerify.Support.JsString

/-!
# Model of `evaluateToolPolicy`

`evaluateToolPolicy(toolName, toolInput, ctx)` is the single authorization decision for a tool
call: a deny tier of eight guards, where the first guard that fires returns, then the incident
READ-ONLY tier when `ctx.incidentReadOnly` is set, else a mode tier. This file transcribes it
branch by branch; line numbers refer to `src/agent-runtime/policy/tool-policy.ts` unless another
file is named.

`ctx.incidentReadOnly` is not a field of `Input` but the first argument of `evaluateToolPolicy`,
and `evaluate` is `evaluateToolPolicy none`, the call with that property undefined. Every theorem
of `Spec.lean`, `Proofs.lean`, `Simplification.lean` and `ProofsDevops.lean` is about `evaluate`, so
the incident tier leaves each of them as it was; `ProofsIncident.lean` proves what the tier does.

`ctx.checkNativeWrite`, the native write boundary (step 3b), is optional as well. Its value is
the first argument of `evaluateToolPolicyWith`, the transcription of the whole function as it is
now (phase 4 with step 3b), and `evaluateToolPolicyEnv` is that function with the property
undefined, proved equal to `evaluateToolPolicyWith none` (`ProofsNativeWrite.lean`). So the
theorems below about `evaluateToolPolicy`, `evaluate`, `evaluateToolPolicyEnv` and `evaluateEnv`
are about sessions without a boundary, and `ProofsNativeWrite.lean` proves what the boundary adds.

The guard primitives are inputs of the model, not part of it. `isSshCommand`,
`isCrossUserAccess`, `bypassBashPermissionDecision`, the three sensitive-path checks, the three
devops-secret checks (`devops-secret-guard.ts`), `handlePrIssuePrecondition`,
`ctx.checkMcpToolPermission` and `ctx.checkEnvSkillPermission` appear through the values they
return (`Primitives`), and `ctx.checkNativeWrite` through the value it returns
(`evaluateToolPolicyWith`'s first argument). The model is about how the policy combines those values, which is also
what `tool-policy.lean-conformance.test.ts` exercises: it mocks the primitives and feeds each
vector's values to the real function.

What the policy reads itself, and the model therefore transcribes:

* the tool name, through `=== 'Bash'`, the `switch` in `checkSensitiveForTool` and in
  `checkDevopsSecretForTool`, `startsWith('mcp__')`, `=== PR_CREATE_MCP_TOOL`, `=== 'Skill'`,
  `NATIVE_BYPASS_TOOLS.includes`, `NATIVE_WRITE_TOOLS.includes`, `ENV_GATED_TOOLS.includes` and
  `allowedMcpTools.includes`;
* `toolInput.command`, `toolInput.file_path`, `toolInput.pattern` and `toolInput.path`, after
  line 225 replaces an undefined `toolInput` with `{}`. `checkSensitiveForTool` picks the
  arguments of its sensitive-path check from them (lines 151-157), and `toolInput.path` also
  decides whether a Grep is checked at all (line 157). `sensitiveCall` is that call, arguments
  included. `checkDevopsSecretForTool` picks the arguments of its devops-secret check from them
  too (lines 182-190); `devopsCall` is that call;
* `ctx.isAdmin`, `ctx.mode`, `ctx.aborted`, whether `ctx.handoffContext` is defined, whether
  `ctx.incidentReadOnly` is defined, with its `allowedMcpTools`, and whether
  `ctx.checkNativeWrite` is defined.

The arguments of the sensitive-path and devops-secret checks are modelled; those of the other
primitives are not. `Primitives.sensitive` is the value of the call `sensitiveCall` describes and
`Primitives.devopsSecret` that of the call `devopsCall` describes, and the mocked replay answers
only those exact calls, throwing on any other, so a wrong argument or a wrong check makes it fail.
The other primitives receive `command` (line 226, also `asStr(input.command)`),
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

/-- The string a `PermissionMode` is (permission-mode.ts:28), which `${ctx.mode}` renders (line 329). -/
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

/-- `SensitivePathResult` — sensitive-path-filter.ts:139-142. -/
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
  /-- `isSshCommand(command)` — line 248. -/
  ssh : Bool
  /-- The value the sensitive-path check returns for the one call `checkSensitiveForTool` makes,
  `sensitiveCall` (lines 151-157). Not used when it makes none. -/
  sensitive : SensitivePathResult
  /-- `isCrossUserAccess(command, ctx.user)` — line 268. -/
  crossUser : Bool
  /-- `ctx.checkMcpToolPermission(toolName)` — line 260; `null` is `none`. -/
  mcpDenied : Option String
  /-- `handlePrIssuePrecondition({ toolName, toolInput: input, handoffContext })` — line 276. -/
  prIssue : PrIssueGuardResult
  /-- `bypassBashPermissionDecision(command, ctx.isDangerousRuleDisabled)` — line 317. -/
  bash : BashPermission
  /-- The value the devops-secret check returns for the one call `checkDevopsSecretForTool` makes,
  `devopsCall` (lines 181-190): a reason, or `none` for `null`. Not used when it makes none. Added
  with the devops-secret step; the phase-1 model (`ModelOriginal.lean`) never reads it, and it
  defaults to `none`, a check that comes back clear. -/
  devopsSecret : Option String := none
  /-- `ctx.checkEnvSkillPermission(toolName, input)` — line 297: a reason, or `none` for `null`.
  Added with the environment-skill step (phase 4); only `evaluateToolPolicyEnv` reads it, and it
  defaults to `none`, a check that comes back clear. -/
  envSkillDenied : Option String := none
  deriving DecidableEq, Repr

/-- A property value, as far as `typeof v === 'string'` and `typeof v === 'string' && v` (lines
140, 155, 157) can tell values apart. -/
inductive Field where
  /-- no such property -/
  | absent
  /-- a string -/
  | str (s : String)
  /-- any other value: a number, a boolean, an object, `null` -/
  | other
  deriving DecidableEq, Repr

/-- `asStr(v)` — lines 139-141: the string, or `''` for any other value. -/
def Field.asStr : Field → String
  | .str s => s
  | _ => ""

/-- `typeof v === 'string' ? v : undefined` — line 155, where `none` is `undefined`. The empty
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
(line 225). -/
structure Input where
  /-- `toolName` -/
  toolName : String
  /-- `input.command`: the argument of the Bash sensitive-path and devops-secret checks (lines 151,
  182) -/
  command : Field
  /-- `input.file_path`: the argument of the Read sensitive-path check (line 153) and of the Read,
  Edit and Write devops-secret check (line 186) -/
  filePath : Field
  /-- `input.pattern`: the first argument of the Glob sensitive-path and devops-secret checks (lines
  155, 190) -/
  pattern : Field
  /-- `input.path`: the Glob base (lines 155, 190) and the Grep path (lines 157, 188) -/
  path : Field
  /-- `ctx.isAdmin` -/
  isAdmin : Bool
  /-- `ctx.mode` -/
  mode : Mode
  /-- `ctx.aborted` -/
  aborted : Bool
  /-- `ctx.handoffContext` is defined. A `HandoffContext` is an object, so defined means truthy
  (line 275). -/
  handoff : Bool
  /-- the primitives' values -/
  prims : Primitives
  deriving DecidableEq, Repr

/-- `IncidentReadOnlyContext` — lines 129-137: the exact names of the `mcp__` tools an incident
session may call. -/
structure IncidentReadOnly where
  /-- `allowedMcpTools` — line 136. -/
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

/-- `NATIVE_WRITE_TOOLS` — native-write-boundary.ts:53-60, in source order: the native tools that
can write a local path the call chooses. -/
def nativeWriteTools : List String :=
  ["Write", "Edit", "NotebookEdit", "Artifact", "EnterWorktree", "Agent"]

/-- `TOOL_POLICY_MATCHERS` — lines 343-349: `['Bash', NATIVE_BYPASS_TOOLS.join('|'), 'mcp__', 'Skill',
NATIVE_WRITE_TOOLS.filter((tool) => !NATIVE_BYPASS_TOOLS.includes(tool)).join('|')]`. -/
def toolPolicyMatchers : List String :=
  ["Bash", "|".intercalate nativeBypassTools, "mcp__", "Skill",
    "|".intercalate (nativeWriteTools.filter fun t => !nativeBypassTools.contains t)]

/-- `INCIDENT_TOOL_POLICY_MATCHERS` — line 360: `[undefined]`, one entry without a matcher, which
the SDK fires for every tool (lines 346-359). `none` is `undefined`. -/
def incidentToolPolicyMatchers : List (Option String) :=
  [none]

/-- `(toolInput ?? {})[key]` (line 225) for a tool input written as JSON, where `none` is an
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

/-- The sensitive-path check `checkSensitiveForTool` (lines 148-161) calls, with its arguments;
`none` when it calls none. -/
def sensitiveCall (i : Input) : Option SensitiveCall :=
  if i.toolName = "Bash" then some (.bash i.command.asStr)              -- 151: asStr(input.command)
  else if i.toolName = "Read" then some (.path i.filePath.asStr)         -- 153: asStr(input.file_path)
  else if i.toolName = "Glob" then                                       -- 155: asStr(input.pattern),
    some (.glob i.pattern.asStr i.path.string?)                          --   the path when a string
  else if i.toolName = "Grep" then                                       -- 157: input.path, when
    if i.path.isNonEmptyString then some (.path i.path.asStr) else none  --   a non-empty string
  else none                                                              -- 158-159: no call

/-- `checkSensitiveForTool(toolName, input)` — lines 148-161. `sensitive` is the value of the call
`sensitiveCall` describes; `none` is the `undefined` of the `default` arm. -/
def checkSensitiveForTool (toolName : String) (path : Field) (sensitive : SensitivePathResult) :
    Option SensitivePathResult :=
  if toolName = "Bash" then some sensitive          -- 150-151: checkBashSensitivePaths(...)
  else if toolName = "Read" then some sensitive     -- 152-153: checkSensitivePath(...)
  else if toolName = "Glob" then some sensitive     -- 154-155: checkSensitiveGlob(...)
  else if toolName = "Grep" then                    -- 156-157
    if path.isNonEmptyString then some sensitive    --   checkSensitivePath(input.path)
    else some { isSensitive := false }              --   { isSensitive: false }
  else none                                         -- 158-159: undefined

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

/-- The devops-secret check `checkDevopsSecretForTool` (lines 179-194) calls, with its arguments;
`none` when it calls none. Every argument is an `asStr(...)`, so a missing or non-string property
is the empty string. -/
def devopsCall (i : Input) : Option DevopsCall :=
  if i.toolName = "Bash" then some (.command i.command.asStr)                   -- 181-182
  else if i.toolName = "Read" ∨ i.toolName = "Edit" ∨ i.toolName = "Write" then  -- 183-186
    some (.path i.filePath.asStr)
  else if i.toolName = "Grep" then some (.path i.path.asStr)                    -- 187-188
  else if i.toolName = "Glob" then some (.glob i.pattern.asStr i.path.asStr)    -- 189-190
  else none                                                                     -- 191-192

/-- The tools `checkDevopsSecretForTool` consults a check for (lines 181-190). -/
def devopsTools : List String :=
  ["Bash", "Read", "Edit", "Write", "Grep", "Glob"]

/-- `checkDevopsSecretForTool(toolName, input)` — lines 179-194. `devops` is the value of the call
`devopsCall` describes; `none` is the `null` of the `default` arm. -/
def checkDevopsSecretForTool (toolName : String) (devops : Option String) : Option String :=
  if toolName = "Bash" then devops                                              -- 181-182
  else if toolName = "Read" ∨ toolName = "Edit" ∨ toolName = "Write" then devops  -- 183-186
  else if toolName = "Grep" then devops                                         -- 187-188
  else if toolName = "Glob" then devops                                         -- 189-190
  else none                                                                     -- 191-192

/-- `DEVOPS_SECRET_DENY_MESSAGE` — lines 163-164. -/
def devopsSecretDenyMessage : String :=
  "Blocked: reading GitHub or keychain credentials and touching the devops broker files is denied in every permission mode."

/-! ## The deny tier (lines 228-284)

Each step is a function: `some r` is the `return r` it executes, `none` falls through to the next
step. Steps 2-4 sit inside one `if (!ctx.isAdmin || ctx.incidentReadOnly)` block, so they test the
admin flag and the incident context once. -/

/-- 1. Abort guard (Bash only) — lines 232-236. -/
def abortGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.aborted = true then
    some { decision := .deny, reason := "abort-guard: session aborted" }
  else none

/-- 1b. Devops-secret — lines 238-243: every mode, admins too. Any non-null value is a reason
(`devopsSecret !== null`), the empty string included. -/
def devopsGuard (i : Input) : Option Result :=
  match checkDevopsSecretForTool i.toolName i.prims.devopsSecret with
  | some reason =>
    some { decision := .deny, reason := "devops-secret: " ++ reason,
           denyMessage := some devopsSecretDenyMessage }
  | none => none

/-- 2. SSH ban (Bash) — lines 247-250. -/
def sshCheck (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.ssh = true then
    some { decision := .deny, reason := "ssh-ban: ssh command for non-admin user" }
  else none

/-- 3. Sensitive path — lines 251-255. `sensitive?.isSensitive` is falsy when the dispatch
returns `undefined`. -/
def sensitiveCheck (i : Input) : Option Result :=
  match checkSensitiveForTool i.toolName i.path i.prims.sensitive with
  | some sensitive =>
    if sensitive.isSensitive then
      some { decision := .deny,
             reason := "sensitive-path: " ++ sensitive.reason.getD "sensitive location" }
    else none
  | none => none

/-- 4. MCP tool permission (`mcp__` tools) — lines 256-264. Any non-null value is a deny reason
(`denied !== null`), the empty string included. -/
def mcpCheck (i : Input) : Option Result :=
  if jsStartsWith i.toolName "mcp__" = true then
    match i.prims.mcpDenied with
    | some denied => some { decision := .deny, reason := "mcp-permission: " ++ denied }
    | none => none
  else none

/-- Steps 2-4, `if (!ctx.isAdmin || ctx.incidentReadOnly) { … }` — lines 245-265: for a non-admin,
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

/-! ## The native write boundary (step 3b, lines 266-272)

`ctx.checkNativeWrite` (lines 102-109) is optional. What the policy gets from it for one call is
`nativeWrite : Option (Option String)`: `none` when the property is undefined, `some v` when it is
set and the call returns `v` (`null` is `none`). The TS asks it only for a tool of
`NATIVE_WRITE_TOOLS` (`&&`, line 267); the model takes the value as given, as it does for every
primitive. The tool sets of steps 1-3 and 3b do not meet, but step 1b's does (`Write` and `Edit`
consult the devops-secret check, which runs first), so the step can only change the result of a
call to a native write tool whose devops-secret check came back clear. -/

/-- 3b. Native write boundary — lines 266-272: for a tool of `NATIVE_WRITE_TOOLS`, when
`ctx.checkNativeWrite` is set, any non-null value is a deny reason (`outside !== null`), the empty
string included, and is surfaced to the model as the deny message. -/
def nativeWriteCheck (nativeWrite : Option (Option String)) (i : Input) : Option Result :=
  match nativeWrite with
  | some (some outside) =>
    if i.toolName ∈ nativeWriteTools then
      some { decision := .deny, reason := "write-boundary: " ++ outside,
             denyMessage := some outside }
    else none
  | _ => none

/-- Steps 2-4 with step 3b between the sensitive-path and the MCP checks — lines 255-282.
`nativeWrite` is what `ctx.checkNativeWrite` gives the call (`nativeWriteCheck`). -/
def adminExemptGuardsWith (nativeWrite : Option (Option String))
    (incident : Option IncidentReadOnly) (i : Input) : Option Result :=
  if i.isAdmin = false ∨ incident.isSome = true then
    match sshCheck i with
    | some r => some r
    | none =>
    match sensitiveCheck i with
    | some r => some r
    | none =>
    match nativeWriteCheck nativeWrite i with
    | some r => some r
    | none => mcpCheck i
  else none

/-- 5. Cross-user directory isolation (Bash, always) — lines 267-270. -/
def crossUserGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.crossUser = true then
    some { decision := .deny, reason := "cross-user: another user directory" }
  else none

/-- 6. PR-issue precondition — lines 272-284. `denyMessage: result.message` sets the property to
`undefined` when the guard gives no message, which is `none` here as well. -/
def prIssueGuard (i : Input) : Option Result :=
  if i.handoff = true ∧ (i.toolName = "Bash" ∨ i.toolName = prCreateMcpTool) then
    if i.prims.prIssue.blocked then
      some { decision := .deny,
             reason := "pr-issue: " ++ i.prims.prIssue.reason.getD "precondition failed",
             denyMessage := i.prims.prIssue.message }
    else none
  else none

/-! ## The incident READ-ONLY tier (lines 286-290), reached only when no deny step returned -/

/-- `evaluateIncidentReadOnly(toolName, incident)` — lines 207-214: allow an `mcp__` tool whose
name is in `allowedMcpTools` (`includes`, exact string equality), deny every other call. It reads
neither the mode nor the admin flag, and never returns `pass` or `classify`. -/
def evaluateIncidentReadOnly (toolName : String) (incident : IncidentReadOnly) : Result :=
  if jsStartsWith toolName "mcp__" = true ∧ toolName ∈ incident.allowedMcpTools then  -- 210
    { decision := .allow, reason := "incident-read-only: allow-listed evidence tool " ++ toolName }
  else                                                                                -- 213
    { decision := .deny,
      reason := "incident-read-only: " ++ toolName ++ " is not an allow-listed evidence tool" }

/-! ## The mode tier (lines 303-333), reached only when no deny step returned and no incident
context is set -/

/-- Steps 7-9 and the default return. -/
def modeTier (i : Input) : Result :=
  if i.mode = .bypass ∧ i.toolName = "Bash" then                    -- 7. lines 310-312
    { decision := .allow, reason := "bypass: unsafe allow-all Bash" }
  else if i.mode = .auto ∧ i.toolName = "Bash" then                 -- 8. line 316
    match i.prims.bash.decision with                                -- 317-318
    | .ask =>                                                       -- 320
      { decision := .classify,
        reason := "auto-classify: " ++ ",".intercalate i.prims.bash.matchedRuleIds,
        matchedRuleIds := some i.prims.bash.matchedRuleIds }
    | .allow => { decision := .allow, reason := "auto: non-dangerous Bash" }  -- 322
  else if i.mode ≠ .legacy ∧ nativeBypassTools.contains i.toolName then  -- 9. lines 328-329
    { decision := .allow, reason := i.mode.name ++ ": native tool" }
  else { decision := .pass, reason := "no policy opinion" }          -- 333

/-- `evaluateToolPolicy` — lines 220-334, where `incident` is `ctx.incidentReadOnly` (`none` when
undefined): the abort guard, the devops-secret step, the non-admin block (which an incident context
makes apply to admins as well), the cross-user and PR-issue guards, in that order; the first that
returns decides. If none does, a set incident context hands the call to the incident tier (lines
288-289) and otherwise the mode tier decides. -/
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

/-! ## Phase 4: the environment-skill step (step 6b, lines 292-301)

Phase 4 adds a guard the phase-3 code did not have, between the incident tier and the mode tier: a
non-admin's call of one of `ENV_GATED_TOOLS` (the `Skill` tool, the file readers and writers) that
`ctx.checkEnvSkillPermission` answers with a reason is denied, with `ENV_SKILL_DENY_MESSAGE`. It
reads one more primitive value, `Primitives.envSkillDenied`.

`evaluateToolPolicy` above is the phase-3 function and keeps its name, so every theorem about it
and about `evaluate` stands as proved. `evaluateToolPolicyEnv` is the TS function now: the same
chain, with `modeTierEnv` in place of `modeTier`. `ProofsEnvSkill.lean` proves the two agree on every
call the new step stays silent on (every incident call, every admin call, every call whose check
comes back clear), and what the step does when it fires. The conformance vectors are its output. -/

/-- `ENV_SKILL_DENY_MESSAGE` — lines 166-172. -/
def envSkillDenyMessage : String :=
  "Blocked: this call reaches an environment skill (calling it or reading its files), which runs only with an admin approval. When it names one skill, an approval request has been sent to the admins; when one approves, this thread receives a message to continue. Do not retry, do not read or follow the skill file another way, and report that the step waits for admin approval."

/-- `ENV_GATED_TOOLS` — line 337, in source order. -/
def envGatedTools : List String :=
  ["Skill", "Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit"]

/-- 6b. Environment skill (`ENV_GATED_TOOLS`, non-admins) — lines 296-301. Any non-null value is a
deny reason (`envDenied !== null`), the empty string included. -/
def envSkillGuard (i : Input) : Option Result :=
  if envGatedTools.contains i.toolName = true ∧ i.isAdmin = false then
    match i.prims.envSkillDenied with
    | some denied =>
      some { decision := .deny, reason := "env-skill: " ++ denied,
             denyMessage := some envSkillDenyMessage }
    | none => none
  else none

/-- Step 6b, then the mode tier (lines 292-333): reached only when no deny step returned and no
incident context is set. -/
def modeTierEnv (i : Input) : Result :=
  match envSkillGuard i with
  | some r => r
  | none => modeTier i

/-- `evaluateToolPolicy` — lines 220-334, phase 4: the phase-3 chain of `evaluateToolPolicy` with
step 6b ahead of the mode tier. -/
def evaluateToolPolicyEnv (incident : Option IncidentReadOnly) (i : Input) : Result :=
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
  | none => modeTierEnv i

/-- `evaluateToolPolicyEnv` with `ctx.incidentReadOnly` undefined. -/
def evaluateEnv (i : Input) : Result :=
  evaluateToolPolicyEnv none i

/-! ## The native write boundary in the whole function

`evaluateToolPolicyEnv` above is the function with `ctx.checkNativeWrite` undefined (step 3b never
returns) and keeps its name, so every theorem about it and about `evaluateEnv` stands as proved.
`evaluateToolPolicyWith` is the TS function now: the same chain, with `adminExemptGuardsWith` in
place of `adminExemptGuards`. `ProofsNativeWrite.lean` proves the two agree whenever step 3b is
silent, and what the step does when it fires. The conformance vectors are its output. -/

/-- `evaluateToolPolicy` — lines 220-334, all of it: `nativeWrite` is what `ctx.checkNativeWrite`
gives the call (`nativeWriteCheck`), `incident` is `ctx.incidentReadOnly`. The same steps as
`evaluateToolPolicyEnv`, with step 3b in the non-admin block. -/
def evaluateToolPolicyWith (nativeWrite : Option (Option String))
    (incident : Option IncidentReadOnly) (i : Input) : Result :=
  match abortGuard i with
  | some r => r
  | none =>
  match devopsGuard i with
  | some r => r
  | none =>
  match adminExemptGuardsWith nativeWrite incident i with
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
  | none => modeTierEnv i

/-! ## Plan mode: step 6c (lines 317-326)

Phase 6 adds a deny step the earlier code did not have, after step 6 (the PR-issue precondition)
and before the incident and mode tiers: when `ctx.checkPlanPending` is set — a dashboard task
whose plan is not started — and answers the call with a reason, the call is denied with
`PLAN_PENDING_DENY_MESSAGE`, in every mode and for admins too. `plan` is what the check gives the
call: `none` when `ctx.checkPlanPending` is undefined, `some none` when it answers `null`,
`some (some reason)` when it answers a reason (the empty reason included: `planDenied !== null`).

`evaluateToolPolicyWith` above is the function without the step and keeps its name, so every
theorem about it stands as proved. `evaluateToolPolicyPlan` is the TS function now: the same chain
with step 6c after `prIssueGuard`. `ProofsPlan.lean` proves the two agree whenever the step is
silent, that a reason always ends in a deny, and that when no earlier step fires the step's denial
is the result. The conformance vectors are its output. -/

/-- `PLAN_PENDING_DENY_MESSAGE` — lines 195-196. -/
def planPendingDenyMessage : String :=
  "Blocked: this task's plan is not started yet. While planning, only reading and research run (Read, Glob, Grep, WebFetch, WebSearch, read-only shell commands such as ls, cat, grep, rg, find, git log/show/diff/status, git clone/fetch, gh … view/list, and read MCP tools). Put this change into the plan and submit it with plan_submit; it runs after the owner presses 시작. Do not retry it or work around it."

/-- 6c. Plan mode — lines 321-326: a reason from `ctx.checkPlanPending` denies. -/
def planGuard : Option (Option String) → Option Result
  | some (some denied) =>
    some { decision := .deny, reason := "plan-pending: " ++ denied,
           denyMessage := some planPendingDenyMessage }
  | _ => none

/-- `evaluateToolPolicy` — lines 245-376, all of it: `nativeWrite` is what `ctx.checkNativeWrite`
gives the call, `plan` what `ctx.checkPlanPending` gives it, `incident` is `ctx.incidentReadOnly`.
The steps of `evaluateToolPolicyWith`, with step 6c after the PR-issue step. -/
def evaluateToolPolicyPlan (nativeWrite : Option (Option String)) (plan : Option (Option String))
    (incident : Option IncidentReadOnly) (i : Input) : Result :=
  match abortGuard i with
  | some r => r
  | none =>
  match devopsGuard i with
  | some r => r
  | none =>
  match adminExemptGuardsWith nativeWrite incident i with
  | some r => r
  | none =>
  match crossUserGuard i with
  | some r => r
  | none =>
  match prIssueGuard i with
  | some r => r
  | none =>
  match planGuard plan with
  | some r => r
  | none =>
  match incident with
  | some inc => evaluateIncidentReadOnly i.toolName inc
  | none => modeTierEnv i

end SomaVerify.ToolPolicy
