-- models: src/agent-runtime/policy/tool-policy.ts:44 (PR_CREATE_MCP_TOOL)
-- models: src/agent-runtime/policy/tool-policy.ts:52-70 (ToolPolicyDecision, ToolPolicyResult)
-- models: src/agent-runtime/policy/tool-policy.ts:77-116 (ToolPolicyContext: the fields the policy reads)
-- models: src/agent-runtime/policy/tool-policy.ts:131-139 (IncidentReadOnlyContext)
-- models: src/agent-runtime/policy/tool-policy.ts:141-143 (asStr)
-- models: src/agent-runtime/policy/tool-policy.ts:150-163 (checkSensitiveForTool: the call it makes and its result)
-- models: src/agent-runtime/policy/tool-policy.ts:176-183 (evaluateIncidentReadOnly)
-- models: src/agent-runtime/policy/tool-policy.ts:189-292 (evaluateToolPolicy)
-- models: src/agent-runtime/policy/tool-policy.ts:295 (TOOL_POLICY_MATCHERS)
-- models: src/agent-runtime/policy/tool-policy.ts:312 (INCIDENT_TOOL_POLICY_MATCHERS)
-- models: src/agent-runtime/policy/native-write-boundary.ts:35 (NATIVE_WRITE_TOOLS)
-- models: src/agent-runtime/policy/permission-mode.ts:28 (PermissionMode)
-- models: src/hooks/bypass-permission-guard.ts:56-69 (NATIVE_BYPASS_TOOLS)
import SomaVerify.Support.Json
import SomaVerify.Support.JsString

/-!
# Model of `evaluateToolPolicy`

`evaluateToolPolicy(toolName, toolInput, ctx)` is the single authorization decision for a tool
call: a deny tier of seven guards, where the first guard that fires returns, then the incident
READ-ONLY tier when `ctx.incidentReadOnly` is set, else a mode tier. This file transcribes it
branch by branch; line numbers refer to `src/agent-runtime/policy/tool-policy.ts` unless another
file is named.

`ctx.checkNativeWrite`, the native write boundary (step 3b), is optional as well. Its value is
the first argument of `evaluateToolPolicyWith`, the transcription of the whole function, and
`evaluateToolPolicy` is that function with the property undefined, proved equal to
`evaluateToolPolicyWith none` (`ProofsNativeWrite.lean`). So the theorems below about
`evaluateToolPolicy` and `evaluate` are about sessions without a boundary, and
`ProofsNativeWrite.lean` proves what the boundary adds.

`ctx.incidentReadOnly` is not a field of `Input` but the first argument of `evaluateToolPolicy`,
and `evaluate` is `evaluateToolPolicy none`, the call with that property undefined. Every theorem
of `Spec.lean`, `Proofs.lean` and `Simplification.lean` is about `evaluate`, so the incident tier
leaves each of them as it was; `ProofsIncident.lean` proves what the tier does.

The guard primitives are inputs of the model, not part of it. `isSshCommand`,
`isCrossUserAccess`, `bypassBashPermissionDecision`, the three sensitive-path checks,
`handlePrIssuePrecondition` and `ctx.checkMcpToolPermission` appear through the values they
return (`Primitives`), and `ctx.checkNativeWrite` through the value it returns
(`evaluateToolPolicyWith`'s first argument). The model is about how the policy combines those values, which is also
what `tool-policy.lean-conformance.test.ts` exercises: it mocks the primitives and feeds each
vector's values to the real function.

What the policy reads itself, and the model therefore transcribes:

* the tool name, through `=== 'Bash'`, the `switch` in `checkSensitiveForTool`,
  `startsWith('mcp__')`, `=== PR_CREATE_MCP_TOOL`, `NATIVE_BYPASS_TOOLS.includes` and
  `allowedMcpTools.includes`;
* `toolInput.command`, `toolInput.file_path`, `toolInput.pattern` and `toolInput.path`, after
  line 194 replaces an undefined `toolInput` with `{}`. `checkSensitiveForTool` picks the
  arguments of its sensitive-path check from them (lines 153-159), and `toolInput.path` also
  decides whether a Grep is checked at all (line 159). `sensitiveCall` is that call, arguments
  included;
* `ctx.isAdmin`, `ctx.mode`, `ctx.aborted`, whether `ctx.handoffContext` is defined, whether
  `ctx.incidentReadOnly` is defined, with its `allowedMcpTools`, and whether
  `ctx.checkNativeWrite` is defined.

The arguments of the sensitive-path checks are modelled; those of the other primitives are not.
`Primitives.sensitive` is the value of the call `sensitiveCall` describes, and the mocked replay
answers only that exact call, throwing on any other, so a wrong argument or a wrong check makes
it fail. The other primitives receive `command` (line 195, also `asStr(input.command)`),
`ctx.user`, `ctx.isDangerousRuleDisabled`, the tool name or the tool input; the model takes
their values as given and does not describe those arguments.

The model takes every primitive value as given, including those the TS never asks for on the
path it takes (`&&` skips the call); a value that is never asked for cannot reach the result,
and the proofs show which values each result depends on.

This is the model of the code after the proof-backed simplification. `ModelOriginal.lean` keeps
the phase-1 model of the code before it, `Proofs.lean` proves the documented invariants for that
model, and `Simplification.lean` proves this model equal to it on every input, which carries every
one of those theorems over to this model.
-/

namespace SomaVerify.ToolPolicy

open SomaVerify SomaVerify.JsString

/-- `PermissionMode` — permission-mode.ts:28. -/
inductive Mode where
  | auto
  | bypass
  | legacy
  deriving DecidableEq, Repr

/-- The string a `PermissionMode` is (permission-mode.ts:28), which `${ctx.mode}` renders (line 287). -/
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

/-- `ToolPolicyResult` — lines 54-70. An optional property that the TS object omits, or sets to
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
  /-- `isSshCommand(command)` — line 210. -/
  ssh : Bool
  /-- The value the sensitive-path check returns for the one call `checkSensitiveForTool` makes,
  `sensitiveCall` (lines 153-159). Not used when it makes none. -/
  sensitive : SensitivePathResult
  /-- `isCrossUserAccess(command, ctx.user)` — line 237. -/
  crossUser : Bool
  /-- `ctx.checkMcpToolPermission(toolName)` — line 229; `null` is `none`. -/
  mcpDenied : Option String
  /-- `handlePrIssuePrecondition({ toolName, toolInput: input, handoffContext })` — line 245. -/
  prIssue : PrIssueGuardResult
  /-- `bypassBashPermissionDecision(command, ctx.isDangerousRuleDisabled)` — line 275. -/
  bash : BashPermission
  deriving DecidableEq, Repr

/-- A property value, as far as `typeof v === 'string'` and `typeof v === 'string' && v` (lines
132, 147, 149) can tell values apart. -/
inductive Field where
  /-- no such property -/
  | absent
  /-- a string -/
  | str (s : String)
  /-- any other value: a number, a boolean, an object, `null` -/
  | other
  deriving DecidableEq, Repr

/-- `asStr(v)` — lines 141-143: the string, or `''` for any other value. -/
def Field.asStr : Field → String
  | .str s => s
  | _ => ""

/-- `typeof v === 'string' ? v : undefined` — line 157, where `none` is `undefined`. The empty
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
(line 194). -/
structure Input where
  /-- `toolName` -/
  toolName : String
  /-- `input.command`: the argument of the Bash sensitive-path check (line 153) -/
  command : Field
  /-- `input.file_path`: the argument of the Read sensitive-path check (line 155) -/
  filePath : Field
  /-- `input.pattern`: the first argument of the Glob sensitive-path check (line 157) -/
  pattern : Field
  /-- `input.path`: the Glob base (line 157) and the Grep path (line 159) -/
  path : Field
  /-- `ctx.isAdmin` -/
  isAdmin : Bool
  /-- `ctx.mode` -/
  mode : Mode
  /-- `ctx.aborted` -/
  aborted : Bool
  /-- `ctx.handoffContext` is defined. A `HandoffContext` is an object, so defined means truthy
  (line 244). -/
  handoff : Bool
  /-- the primitives' values -/
  prims : Primitives
  deriving DecidableEq, Repr

/-- `IncidentReadOnlyContext` — lines 131-139: the exact names of the `mcp__` tools an incident
session may call. -/
structure IncidentReadOnly where
  /-- `allowedMcpTools` — line 138. -/
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

/-- `NATIVE_BYPASS_TOOLS` — bypass-permission-guard.ts:56-69, in source order. -/
def nativeBypassTools : List String :=
  ["Write", "Edit", "NotebookEdit", "TodoWrite", "Read", "Glob", "Grep", "Task", "Agent",
    "WebFetch", "WebSearch", "KillShell"]

/-- `TOOL_POLICY_MATCHERS` — line 295: `['Bash', NATIVE_BYPASS_TOOLS.join('|'), 'mcp__']`. -/
def toolPolicyMatchers : List String :=
  ["Bash", "|".intercalate nativeBypassTools, "mcp__"]

/-- `INCIDENT_TOOL_POLICY_MATCHERS` — line 312: `[undefined]`, one entry without a matcher, which
the SDK fires for every tool (lines 298-311). `none` is `undefined`. -/
def incidentToolPolicyMatchers : List (Option String) :=
  [none]

/-- `(toolInput ?? {})[key]` (line 194) for a tool input written as JSON, where `none` is an
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

/-- The sensitive-path check `checkSensitiveForTool` (lines 150-163) calls, with its arguments;
`none` when it calls none. -/
def sensitiveCall (i : Input) : Option SensitiveCall :=
  if i.toolName = "Bash" then some (.bash i.command.asStr)              -- 153: asStr(input.command)
  else if i.toolName = "Read" then some (.path i.filePath.asStr)         -- 155: asStr(input.file_path)
  else if i.toolName = "Glob" then                                       -- 157: asStr(input.pattern),
    some (.glob i.pattern.asStr i.path.string?)                          --   the path when a string
  else if i.toolName = "Grep" then                                       -- 159: input.path, when
    if i.path.isNonEmptyString then some (.path i.path.asStr) else none  --   a non-empty string
  else none                                                              -- 160-161: no call

/-- `checkSensitiveForTool(toolName, input)` — lines 150-163. `sensitive` is the value of the call
`sensitiveCall` describes; `none` is the `undefined` of the `default` arm. -/
def checkSensitiveForTool (toolName : String) (path : Field) (sensitive : SensitivePathResult) :
    Option SensitivePathResult :=
  if toolName = "Bash" then some sensitive          -- 152-153: checkBashSensitivePaths(...)
  else if toolName = "Read" then some sensitive     -- 154-155: checkSensitivePath(...)
  else if toolName = "Glob" then some sensitive     -- 156-157: checkSensitiveGlob(...)
  else if toolName = "Grep" then                    -- 158-159
    if path.isNonEmptyString then some sensitive    --   checkSensitivePath(input.path)
    else some { isSensitive := false }              --   { isSensitive: false }
  else none                                         -- 160-161: undefined

/-! ## The deny tier (lines 197-253)

Each step is a function: `some r` is the `return r` it executes, `none` falls through to the next
step. Steps 2-4 sit inside one `if (!ctx.isAdmin || ctx.incidentReadOnly)` block, so they test the
admin flag and the incident context once. -/

/-- 1. Abort guard (Bash only) — lines 201-205. -/
def abortGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.aborted = true then
    some { decision := .deny, reason := "abort-guard: session aborted" }
  else none

/-- 2. SSH ban (Bash) — lines 209-212. -/
def sshCheck (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.ssh = true then
    some { decision := .deny, reason := "ssh-ban: ssh command for non-admin user" }
  else none

/-- 3. Sensitive path — lines 213-217. `sensitive?.isSensitive` is falsy when the dispatch
returns `undefined`. -/
def sensitiveCheck (i : Input) : Option Result :=
  match checkSensitiveForTool i.toolName i.path i.prims.sensitive with
  | some sensitive =>
    if sensitive.isSensitive then
      some { decision := .deny,
             reason := "sensitive-path: " ++ sensitive.reason.getD "sensitive location" }
    else none
  | none => none

/-- 4. MCP tool permission (`mcp__` tools) — lines 225-233. Any non-null value is a deny reason
(`denied !== null`), the empty string included. -/
def mcpCheck (i : Input) : Option Result :=
  if jsStartsWith i.toolName "mcp__" = true then
    match i.prims.mcpDenied with
    | some denied => some { decision := .deny, reason := "mcp-permission: " ++ denied }
    | none => none
  else none

/-- Steps 2-4, `if (!ctx.isAdmin || ctx.incidentReadOnly) { … }` — lines 207-234: for a non-admin,
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

/-! ## The native write boundary (step 3b, lines 218-224)

`ctx.checkNativeWrite` (lines 101-108) is optional. What the policy gets from it for one call is
`nativeWrite : Option (Option String)`: `none` when the property is undefined, `some v` when it is
set and the call returns `v` (`null` is `none`). The TS asks it only for a tool of
`NATIVE_WRITE_TOOLS` (`&&`, line 219); the model takes the value as given, as it does for every
primitive. The tool sets of steps 1-4 and 3b do not meet, so the step can only change the result
of a call to a native write tool. -/

/-- `NATIVE_WRITE_TOOLS` — native-write-boundary.ts:35, in source order. -/
def nativeWriteTools : List String :=
  ["Write", "Edit", "NotebookEdit"]

/-- 3b. Native write boundary — lines 218-224: for a tool of `NATIVE_WRITE_TOOLS`, when
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

/-- Steps 2-4 with step 3b between the sensitive-path and the MCP checks — lines 207-234.
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

/-- 5. Cross-user directory isolation (Bash, always) — lines 236-239. -/
def crossUserGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.crossUser = true then
    some { decision := .deny, reason := "cross-user: another user directory" }
  else none

/-- 6. PR-issue precondition — lines 241-253. `denyMessage: result.message` sets the property to
`undefined` when the guard gives no message, which is `none` here as well. -/
def prIssueGuard (i : Input) : Option Result :=
  if i.handoff = true ∧ (i.toolName = "Bash" ∨ i.toolName = prCreateMcpTool) then
    if i.prims.prIssue.blocked then
      some { decision := .deny,
             reason := "pr-issue: " ++ i.prims.prIssue.reason.getD "precondition failed",
             denyMessage := i.prims.prIssue.message }
    else none
  else none

/-! ## The incident READ-ONLY tier (lines 255-259), reached only when no deny step returned -/

/-- `evaluateIncidentReadOnly(toolName, incident)` — lines 176-183: allow an `mcp__` tool whose
name is in `allowedMcpTools` (`includes`, exact string equality), deny every other call. It reads
neither the mode nor the admin flag, and never returns `pass` or `classify`. -/
def evaluateIncidentReadOnly (toolName : String) (incident : IncidentReadOnly) : Result :=
  if jsStartsWith toolName "mcp__" = true ∧ toolName ∈ incident.allowedMcpTools then  -- 179
    { decision := .allow, reason := "incident-read-only: allow-listed evidence tool " ++ toolName }
  else                                                                                -- 182
    { decision := .deny,
      reason := "incident-read-only: " ++ toolName ++ " is not an allow-listed evidence tool" }

/-! ## The mode tier (lines 261-291), reached only when no deny step returned and no incident
context is set -/

/-- Steps 7-9 and the default return. -/
def modeTier (i : Input) : Result :=
  if i.mode = .bypass ∧ i.toolName = "Bash" then                    -- 7. lines 268-270
    { decision := .allow, reason := "bypass: unsafe allow-all Bash" }
  else if i.mode = .auto ∧ i.toolName = "Bash" then                 -- 8. line 274
    match i.prims.bash.decision with                                -- 275-276
    | .ask =>                                                       -- 278
      { decision := .classify,
        reason := "auto-classify: " ++ ",".intercalate i.prims.bash.matchedRuleIds,
        matchedRuleIds := some i.prims.bash.matchedRuleIds }
    | .allow => { decision := .allow, reason := "auto: non-dangerous Bash" }  -- 280
  else if i.mode ≠ .legacy ∧ nativeBypassTools.contains i.toolName then  -- 9. lines 286-287
    { decision := .allow, reason := i.mode.name ++ ": native tool" }
  else { decision := .pass, reason := "no policy opinion" }          -- 291

/-- `evaluateToolPolicy` — lines 189-292, with `ctx.checkNativeWrite` undefined (step 3b never
returns) and `incident` as `ctx.incidentReadOnly` (`none` when undefined): the abort guard, the non-admin block (which an incident context makes apply to admins
as well), the cross-user and PR-issue guards, in that order; the first that returns decides. If
none does, a set incident context hands the call to the incident tier (lines 257-258) and
otherwise the mode tier decides. -/
def evaluateToolPolicy (incident : Option IncidentReadOnly) (i : Input) : Result :=
  match abortGuard i with
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
`Spec.lean`, `Proofs.lean` and `Simplification.lean` is about. -/
def evaluate (i : Input) : Result :=
  evaluateToolPolicy none i

/-- `evaluateToolPolicy` — lines 189-292, all of it: `nativeWrite` is what `ctx.checkNativeWrite`
gives the call (`nativeWriteCheck`), `incident` is `ctx.incidentReadOnly`. The same steps as
`evaluateToolPolicy`, with step 3b in the non-admin block. -/
def evaluateToolPolicyWith (nativeWrite : Option (Option String))
    (incident : Option IncidentReadOnly) (i : Input) : Result :=
  match abortGuard i with
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
  | none => modeTier i

end SomaVerify.ToolPolicy
