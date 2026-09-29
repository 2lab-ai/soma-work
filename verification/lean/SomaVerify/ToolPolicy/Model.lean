-- models: src/agent-runtime/policy/tool-policy.ts:39 (PR_CREATE_MCP_TOOL)
-- models: src/agent-runtime/policy/tool-policy.ts:47-64 (ToolPolicyDecision, ToolPolicyResult)
-- models: src/agent-runtime/policy/tool-policy.ts:71-93 (ToolPolicyContext: the fields the policy reads)
-- models: src/agent-runtime/policy/tool-policy.ts:104-117 (checkSensitiveForTool)
-- models: src/agent-runtime/policy/tool-policy.ts:123-209 (evaluateToolPolicy)
-- models: src/agent-runtime/policy/tool-policy.ts:212 (TOOL_POLICY_MATCHERS)
-- models: src/agent-runtime/policy/permission-mode.ts:28 (PermissionMode)
-- models: src/hooks/bypass-permission-guard.ts:56-68 (NATIVE_BYPASS_TOOLS)
import SomaVerify.Support.Json
import SomaVerify.Support.JsString

/-!
# Model of `evaluateToolPolicy`

`evaluateToolPolicy(toolName, toolInput, ctx)` is the single authorization decision for a tool
call: a deny tier of six guards, where the first guard that fires returns, then a mode tier.
This file transcribes it branch by branch; line numbers refer to
`src/agent-runtime/policy/tool-policy.ts` unless another file is named.

The guard primitives are inputs of the model, not part of it. `isSshCommand`,
`isCrossUserAccess`, `bypassBashPermissionDecision`, the three sensitive-path checks,
`handlePrIssuePrecondition` and `ctx.checkMcpToolPermission` appear only through the values they
return (`Primitives`). The model is about how the policy combines those values, which is also
what `tool-policy.lean-conformance.test.ts` exercises: it mocks the primitives and feeds each
vector's values to the real function.

What the policy reads itself, and the model therefore transcribes:

* the tool name, through `=== 'Bash'`, the `switch` in `checkSensitiveForTool`,
  `startsWith('mcp__')`, `=== PR_CREATE_MCP_TOOL` and `NATIVE_BYPASS_TOOLS.includes`;
* `toolInput.path`, for Grep only (line 113), after line 128 replaces an undefined `toolInput`
  with `{}`;
* `ctx.isAdmin`, `ctx.mode`, `ctx.aborted`, and whether `ctx.handoffContext` is defined.

`ctx.user` and `ctx.isDangerousRuleDisabled` are only passed on to primitives, and `command`
(line 129) only feeds primitives, so none of them appears here. The model takes every primitive
value as given, including those the TS never asks for on the path it takes (`&&` skips the call);
a skipped call's value cannot reach the result, and the proofs show which values each result
depends on.

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

/-- The string a `PermissionMode` is (permission-mode.ts:28), which `${ctx.mode}` renders (line 204). -/
def Mode.name : Mode → String
  | .auto => "auto"
  | .bypass => "bypass"
  | .legacy => "legacy"

/-- `ToolPolicyDecision` — line 47. -/
inductive Decision where
  | allow
  | deny
  | classify
  | pass
  deriving DecidableEq, Repr

/-- `ToolPolicyResult` — lines 49-64. An optional property that the TS object omits, or sets to
`undefined`, is `none`. -/
structure Result where
  decision : Decision
  reason : String
  denyMessage : Option String := none
  matchedRuleIds : Option (List String) := none
  deriving DecidableEq, Repr

/-- `SensitivePathResult` — sensitive-path-filter.ts:60-63. -/
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

/-- `BypassBashPermissionResult['decision']` — dangerous-command-filter.ts:85. -/
inductive BashVerdict where
  | allow
  | ask
  deriving DecidableEq, Repr

/-- `BypassBashPermissionResult` — dangerous-command-filter.ts:84-87. -/
structure BashPermission where
  decision : BashVerdict
  matchedRuleIds : List String
  deriving DecidableEq, Repr

/-- What the guard primitives return for one call. -/
structure Primitives where
  /-- `isSshCommand(command)` — line 142. -/
  ssh : Bool
  /-- The value of the sensitive-path check that `checkSensitiveForTool` calls for the tool:
  `checkBashSensitivePaths`, `checkSensitivePath` or `checkSensitiveGlob` (lines 107-113). -/
  sensitive : SensitivePathResult
  /-- `isCrossUserAccess(command, ctx.user)` — line 161. -/
  crossUser : Bool
  /-- `ctx.checkMcpToolPermission(toolName)` — line 153; `null` is `none`. -/
  mcpDenied : Option String
  /-- `handlePrIssuePrecondition({ toolName, toolInput: input, handoffContext })` — line 169. -/
  prIssue : PrIssueGuardResult
  /-- `bypassBashPermissionDecision(command, ctx.isDangerousRuleDisabled)` — line 193. -/
  bash : BashPermission
  deriving DecidableEq, Repr

/-- A property value, as far as `typeof v === 'string' && v` (line 113) can tell values apart. -/
inductive Field where
  /-- no such property -/
  | absent
  /-- a string -/
  | str (s : String)
  /-- any other value: a number, a boolean, an object, `null` -/
  | other
  deriving DecidableEq, Repr

/-- `typeof v === 'string' && v` is truthy: `v` is a string, and a string is truthy exactly when
it is not empty. -/
def Field.isNonEmptyString : Field → Bool
  | .str s => s != ""
  | _ => false

/-- One call of `evaluateToolPolicy(toolName, toolInput, ctx)`. -/
structure Input where
  /-- `toolName` -/
  toolName : String
  /-- `input.path`, where `input = toolInput ?? {}` (line 128) -/
  path : Field
  /-- `ctx.isAdmin` -/
  isAdmin : Bool
  /-- `ctx.mode` -/
  mode : Mode
  /-- `ctx.aborted` -/
  aborted : Bool
  /-- `ctx.handoffContext` is defined. A `HandoffContext` is an object, so defined means truthy
  (line 168). -/
  handoff : Bool
  /-- the primitives' values -/
  prims : Primitives
  deriving DecidableEq, Repr

/-- `PR_CREATE_MCP_TOOL` — line 39. -/
def prCreateMcpTool : String := "mcp__github__create_pull_request"

/-- `NATIVE_BYPASS_TOOLS` — bypass-permission-guard.ts:56-68, in source order. -/
def nativeBypassTools : List String :=
  ["Write", "Edit", "NotebookEdit", "TodoWrite", "Read", "Glob", "Grep", "Task", "WebFetch",
    "WebSearch", "KillShell"]

/-- `TOOL_POLICY_MATCHERS` — line 212: `['Bash', NATIVE_BYPASS_TOOLS.join('|'), 'mcp__']`. -/
def toolPolicyMatchers : List String :=
  ["Bash", "|".intercalate nativeBypassTools, "mcp__"]

/-- `(toolInput ?? {}).path` (lines 113 and 128) for a tool input written as JSON, where `none`
is an undefined `toolInput`. The vector generator derives `Input.path` with it from the exact
input it hands to the TS function. A JSON object in a vector never repeats a key, so the first
match is the only one. -/
def pathField : Option Json → Field
  | some (.obj fields) =>
    match fields.lookup "path" with
    | none => .absent
    | some (.str s) => .str s
    | some _ => .other
  | _ => .absent

/-- `checkSensitiveForTool(toolName, input)` — lines 104-117. `sensitive` is the value of the
sensitive-path check the `switch` calls; `none` is the `undefined` of the `default` arm. -/
def checkSensitiveForTool (toolName : String) (path : Field) (sensitive : SensitivePathResult) :
    Option SensitivePathResult :=
  if toolName = "Bash" then some sensitive          -- 106-107: checkBashSensitivePaths(command)
  else if toolName = "Read" then some sensitive     -- 108-109: checkSensitivePath(file_path)
  else if toolName = "Glob" then some sensitive     -- 110-111: checkSensitiveGlob(pattern, path)
  else if toolName = "Grep" then                    -- 112-113
    if path.isNonEmptyString then some sensitive    --   checkSensitivePath(input.path)
    else some { isSensitive := false }              --   { isSensitive: false }
  else none                                         -- 114-115: undefined

/-! ## The deny tier (lines 131-177)

Each step is a function: `some r` is the `return r` it executes, `none` falls through to the next
step. Steps 2-4 sit inside one `if (!ctx.isAdmin)` block, so they test the admin flag once. -/

/-- 1. Abort guard (Bash only) — lines 133-137. -/
def abortGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.aborted = true then
    some { decision := .deny, reason := "abort-guard: session aborted" }
  else none

/-- 2. SSH ban (Bash) — lines 141-144. -/
def sshCheck (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.ssh = true then
    some { decision := .deny, reason := "ssh-ban: ssh command for non-admin user" }
  else none

/-- 3. Sensitive path — lines 145-149. `sensitive?.isSensitive` is falsy when the dispatch
returns `undefined`. -/
def sensitiveCheck (i : Input) : Option Result :=
  match checkSensitiveForTool i.toolName i.path i.prims.sensitive with
  | some sensitive =>
    if sensitive.isSensitive then
      some { decision := .deny,
             reason := "sensitive-path: " ++ sensitive.reason.getD "sensitive location" }
    else none
  | none => none

/-- 4. MCP tool permission (`mcp__` tools) — lines 150-157. Any non-null value is a deny reason
(`denied !== null`), the empty string included. -/
def mcpCheck (i : Input) : Option Result :=
  if jsStartsWith i.toolName "mcp__" = true then
    match i.prims.mcpDenied with
    | some denied => some { decision := .deny, reason := "mcp-permission: " ++ denied }
    | none => none
  else none

/-- Steps 2-4, `if (!ctx.isAdmin) { … }` — lines 139-158: for a non-admin, the first of the three
checks that returns. -/
def adminExemptGuards (i : Input) : Option Result :=
  if i.isAdmin = false then
    match sshCheck i with
    | some r => some r
    | none =>
    match sensitiveCheck i with
    | some r => some r
    | none => mcpCheck i
  else none

/-- 5. Cross-user directory isolation (Bash, always) — lines 160-163. -/
def crossUserGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.crossUser = true then
    some { decision := .deny, reason := "cross-user: another user directory" }
  else none

/-- 6. PR-issue precondition — lines 165-177. `denyMessage: result.message` sets the property to
`undefined` when the guard gives no message, which is `none` here as well. -/
def prIssueGuard (i : Input) : Option Result :=
  if i.handoff = true ∧ (i.toolName = "Bash" ∨ i.toolName = prCreateMcpTool) then
    if i.prims.prIssue.blocked then
      some { decision := .deny,
             reason := "pr-issue: " ++ i.prims.prIssue.reason.getD "precondition failed",
             denyMessage := i.prims.prIssue.message }
    else none
  else none

/-! ## The mode tier (lines 179-208), reached only when no deny step returned -/

/-- Steps 7-9 and the default return. -/
def modeTier (i : Input) : Result :=
  if i.mode = .bypass ∧ i.toolName = "Bash" then                    -- 7. lines 186-188
    { decision := .allow, reason := "bypass: unsafe allow-all Bash" }
  else if i.mode = .auto ∧ i.toolName = "Bash" then                 -- 8. line 192
    match i.prims.bash.decision with                                -- 193-194
    | .ask =>                                                       -- 196
      { decision := .classify,
        reason := "auto-classify: " ++ ",".intercalate i.prims.bash.matchedRuleIds,
        matchedRuleIds := some i.prims.bash.matchedRuleIds }
    | .allow => { decision := .allow, reason := "auto: non-dangerous Bash" }  -- 198
  else if i.mode ≠ .legacy ∧ nativeBypassTools.contains i.toolName then  -- 9. lines 203-204
    { decision := .allow, reason := i.mode.name ++ ": native tool" }
  else { decision := .pass, reason := "no policy opinion" }          -- 208

/-- `evaluateToolPolicy` — lines 123-209: the abort guard, the non-admin block, the cross-user and
PR-issue guards, in that order; the first that returns decides. If none does, the mode tier decides. -/
def evaluate (i : Input) : Result :=
  match abortGuard i with
  | some r => r
  | none =>
  match adminExemptGuards i with
  | some r => r
  | none =>
  match crossUserGuard i with
  | some r => r
  | none =>
  match prIssueGuard i with
  | some r => r
  | none => modeTier i

end SomaVerify.ToolPolicy
