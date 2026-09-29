-- models: src/agent-runtime/policy/tool-policy.ts:47-64 at 748a369d (ToolPolicyDecision with 'ask', ToolPolicyResult)
-- models: src/agent-runtime/policy/tool-policy.ts:122-213 at 748a369d (evaluateToolPolicy)
import SomaVerify.ToolPolicy.Model

/-!
# The phase-1 model of `evaluateToolPolicy`, before the proof-backed simplification

The phase-1 `Model.lean` (commit faa26d14), moved into the `Original` namespace and otherwise
unchanged. It transcribes `tool-policy.ts` as of commit 748a369d, before three simplifications
that `Simplification.lean` proves harmless: `'ask'` left `ToolPolicyDecision`, the ssh,
sensitive-path and MCP guards were grouped under one `!ctx.isAdmin` test, and the two
native-tool allow branches were merged. Line numbers below refer to that commit.

The input side did not change, so this file reuses `Input`, `Primitives`, `Mode`, the constants
and `checkSensitiveForTool` from `Model.lean`. It keeps its own `Decision`, which still has
`ask`, and its own `Result`. `Proofs.lean` proves the documented invariants for this model.
-/

namespace SomaVerify.ToolPolicy.Original

open SomaVerify SomaVerify.JsString

/-- `ToolPolicyDecision` — line 47, which still lists `'ask'`. -/
inductive Decision where
  | allow
  | deny
  | ask
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

/-! ## The deny tier (lines 130-177)

Each guard is one numbered step of the tier: `some r` is the `return r` it executes, `none`
falls through to the next step. -/

/-- 1. Abort guard (Bash only) — lines 132-136. -/
def abortGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.aborted = true then
    some { decision := .deny, reason := "abort-guard: session aborted" }
  else none

/-- 2. SSH ban (Bash, non-admin) — lines 138-141. -/
def sshGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.isAdmin = false ∧ i.prims.ssh = true then
    some { decision := .deny, reason := "ssh-ban: ssh command for non-admin user" }
  else none

/-- 3. Sensitive path (non-admin) — lines 143-149. `sensitive?.isSensitive` is falsy when the
dispatch returns `undefined`. -/
def sensitiveGuard (i : Input) : Option Result :=
  if i.isAdmin = false then
    match checkSensitiveForTool i.toolName i.path i.prims.sensitive with
    | some sensitive =>
      if sensitive.isSensitive then
        some { decision := .deny,
               reason := "sensitive-path: " ++ sensitive.reason.getD "sensitive location" }
      else none
    | none => none
  else none

/-- 4. Cross-user directory isolation (Bash, always) — lines 151-154. -/
def crossUserGuard (i : Input) : Option Result :=
  if i.toolName = "Bash" ∧ i.prims.crossUser = true then
    some { decision := .deny, reason := "cross-user: another user directory" }
  else none

/-- 5. MCP tool permission (`mcp__` tools, non-admin) — lines 156-163. Any non-null value is a
deny reason (`denied !== null`, line 160), the empty string included. -/
def mcpGuard (i : Input) : Option Result :=
  if jsStartsWith i.toolName "mcp__" = true ∧ i.isAdmin = false then
    match i.prims.mcpDenied with
    | some denied => some { decision := .deny, reason := "mcp-permission: " ++ denied }
    | none => none
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

/-! ## The mode tier (lines 179-212), reached only when no deny guard returned -/

/-- Steps 7 and 8 and the default return. Each `mode` arm ends in the fall-through to line 212,
as the TS `if (ctx.mode === ...)` blocks do. -/
def modeTier (i : Input) : Result :=
  match i.mode with
  | .bypass =>                                                -- 186
    if i.toolName = "Bash" then                               -- 187-189
      { decision := .allow, reason := "bypass: unsafe allow-all Bash" }
    else if nativeBypassTools.contains i.toolName then        -- 190-192
      { decision := .allow, reason := "bypass: native tool" }
    else { decision := .pass, reason := "no policy opinion" }  -- 212
  | .auto =>                                                  -- 197
    if i.toolName = "Bash" then                               -- 198
      match i.prims.bash.decision with                        -- 199-200
      | .ask =>                                               -- 202
        { decision := .classify,
          reason := "auto-classify: " ++ ",".intercalate i.prims.bash.matchedRuleIds,
          matchedRuleIds := some i.prims.bash.matchedRuleIds }
      | .allow => { decision := .allow, reason := "auto: non-dangerous Bash" }  -- 204
    else if nativeBypassTools.contains i.toolName then        -- 206-208
      { decision := .allow, reason := "auto: native tool" }
    else { decision := .pass, reason := "no policy opinion" }  -- 212
  | .legacy => { decision := .pass, reason := "no policy opinion" }  -- 212

/-- `evaluateToolPolicy` — lines 122-213: the deny guards in source order, the first one that
returns decides; if none does, the mode tier decides. -/
def evaluate (i : Input) : Result :=
  match abortGuard i with
  | some r => r
  | none =>
  match sshGuard i with
  | some r => r
  | none =>
  match sensitiveGuard i with
  | some r => r
  | none =>
  match crossUserGuard i with
  | some r => r
  | none =>
  match mcpGuard i with
  | some r => r
  | none =>
  match prIssueGuard i with
  | some r => r
  | none => modeTier i


end SomaVerify.ToolPolicy.Original
