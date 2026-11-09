import SomaVerify.ToolPolicy.ProofsPlan

/-!
# Proofs of the environment plugin MCP step (step 6d)

Proved for `evaluateToolPolicyMcp`, for every input: every tool name, tool input, mode, admin flag,
abort and handoff state, native write boundary value, plan check value, incident context, and every
combination of primitive values.

* The step is silent unless the call is a non-admin call of a `PLUGIN_MCP_TOOL_PREFIX` tool whose
  check returned a value (`envPluginMcpGuard_eq_none_iff`), and wherever it is silent the result is
  `evaluateToolPolicyPlan`'s, the function every earlier theorem is about
  (`evaluateToolPolicyMcp_of_silent`): in particular for every incident call
  (`evaluateToolPolicyMcp_incident`), every admin call (`evaluateToolPolicyMcp_of_admin`), every call
  whose check comes back clear (`evaluateToolPolicyMcp_of_clear`) and every tool outside the prefix
  (`evaluateToolPolicyMcp_of_not_prefixed`).
* Step 6b never fires on a tool of the prefix (`envSkillGuard_of_plugin_mcp`), so the two
  environment steps never compete for a call.
* Outside an incident session, a reason from the check always ends in a deny, whatever the mode
  (`env_mcp_reason_denies`), and when no earlier step fires the step's own denial, with
  `ENV_PLUGIN_MCP_DENY_MESSAGE`, is the result (`env_mcp_denies_first`).
* The step only narrows: wherever the result differs from the function without it, it is a deny
  (`evaluateToolPolicyMcp_ne_deny`).
* `TOOL_POLICY_MATCHERS` keeps an MCP entry, now the regular expression `^mcp__` (`mcp_matched`).
-/

namespace SomaVerify.ToolPolicy

open SomaVerify.JsString
open SomaVerify.ToolPolicy.Phase4 (abortGuard_deny devopsGuard_deny crossUserGuard_deny prIssueGuard_deny
  envSkillGuard_of_not_gated)

/-! ## Step 6d on its own -/

/-- Step 6d returns nothing unless the call is a non-admin call of a `PLUGIN_MCP_TOOL_PREFIX` tool
whose check returned a value (lines 373-375). -/
theorem envPluginMcpGuard_eq_none_iff (i : Input) :
    envPluginMcpGuard i = none ↔
      ¬(i.isAdmin = false ∧ jsStartsWith i.toolName pluginMcpToolPrefix = true ∧
        i.prims.envMcpDenied.isSome = true) := by
  unfold envPluginMcpGuard
  by_cases h : i.isAdmin = false ∧ jsStartsWith i.toolName pluginMcpToolPrefix = true
  · cases i.prims.envMcpDenied <;> simp [h]
  · simp only [h, ↓reduceIte, true_iff]
    exact fun h' => h ⟨h'.1, h'.2.1⟩

/-- Admins skip step 6d (`!ctx.isAdmin`, line 373). -/
theorem envPluginMcpGuard_of_admin {i : Input} (h : i.isAdmin = true) : envPluginMcpGuard i = none :=
  (envPluginMcpGuard_eq_none_iff i).mpr fun h' => by simp [h] at h'

/-- A check that comes back clear (`null`) keeps step 6d silent. -/
theorem envPluginMcpGuard_of_clear {i : Input} (h : i.prims.envMcpDenied = none) :
    envPluginMcpGuard i = none :=
  (envPluginMcpGuard_eq_none_iff i).mpr fun h' => by simp [h] at h'

/-- Step 6d consults its check for `PLUGIN_MCP_TOOL_PREFIX` tools only (line 373). -/
theorem envPluginMcpGuard_of_not_prefixed {i : Input}
    (h : jsStartsWith i.toolName pluginMcpToolPrefix = false) : envPluginMcpGuard i = none :=
  (envPluginMcpGuard_eq_none_iff i).mpr fun h' => by rw [h] at h'; exact Bool.false_ne_true h'.2.1

/-- Every result step 6d returns is a deny. -/
theorem envPluginMcpGuard_deny {i : Input} {r : Result} (h : envPluginMcpGuard i = some r) :
    r.decision = .deny := by
  unfold envPluginMcpGuard at h
  split at h
  · split at h
    · cases h; rfl
    · cases h
  · cases h

/-- With a reason, a non-admin call of a `PLUGIN_MCP_TOOL_PREFIX` tool is denied by step 6d, with
reason `env-plugin-mcp: <reason> (<toolName>)` and `ENV_PLUGIN_MCP_DENY_MESSAGE`; the empty reason
included (`pluginDenied !== null`, line 375). -/
theorem envPluginMcpGuard_reason {i : Input} (denied : String) (ha : i.isAdmin = false)
    (hp : jsStartsWith i.toolName pluginMcpToolPrefix = true) (hd : i.prims.envMcpDenied = some denied) :
    envPluginMcpGuard i =
      some { decision := .deny, reason := "env-plugin-mcp: " ++ denied ++ " (" ++ i.toolName ++ ")",
             denyMessage := some envPluginMcpDenyMessage } := by
  simp [envPluginMcpGuard, ha, hp, hd]

/-- No tool of `ENV_GATED_TOOLS` starts with `PLUGIN_MCP_TOOL_PREFIX`, so step 6b is silent on every
call step 6d can fire on. -/
theorem envSkillGuard_of_plugin_mcp {i : Input}
    (hp : jsStartsWith i.toolName pluginMcpToolPrefix = true) : envSkillGuard i = none := by
  apply envSkillGuard_of_not_gated
  cases hg : envGatedTools.contains i.toolName with
  | false => rfl
  | true =>
    exfalso
    simp only [envGatedTools, List.contains_cons, List.contains_nil, Bool.or_false, Bool.or_eq_true,
      beq_iff_eq] at hg
    rcases hg with h | h | h | h | h | h | h | h <;>
      (rw [h] at hp; simp [jsStartsWith, pluginMcpToolPrefix] at hp)

/-- With step 6d silent, step 6b, step 6d and the mode tier are step 6b and the mode tier. -/
theorem modeTierMcp_of_silent {i : Input} (h : envPluginMcpGuard i = none) :
    modeTierMcp i = modeTierEnv i := by
  unfold modeTierMcp modeTierEnv
  cases envSkillGuard i <;> simp [h]

/-! ## When step 6d is silent, nothing changes -/

/-- When step 6d is silent the result is `evaluateToolPolicyPlan`'s, decision, reason, deny message
and rule ids alike. -/
theorem evaluateToolPolicyMcp_of_silent {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : envPluginMcpGuard i = none) :
    evaluateToolPolicyMcp nw plan inc i = evaluateToolPolicyPlan nw plan inc i := by
  simp only [evaluateToolPolicyMcp, evaluateToolPolicyPlan, modeTierMcp_of_silent h]

/-- An incident session never reaches step 6d (it sits below the incident tier): the result is
`evaluateToolPolicyPlan`'s on every incident call, so `ProofsIncident.lean` describes it. -/
theorem evaluateToolPolicyMcp_incident (nw plan : Option (Option String)) (inc : IncidentReadOnly)
    (i : Input) : evaluateToolPolicyMcp nw plan (some inc) i = evaluateToolPolicyPlan nw plan (some inc) i := by
  simp only [evaluateToolPolicyMcp, evaluateToolPolicyPlan]

/-- For admins the result is `evaluateToolPolicyPlan`'s. -/
theorem evaluateToolPolicyMcp_of_admin {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : i.isAdmin = true) :
    evaluateToolPolicyMcp nw plan inc i = evaluateToolPolicyPlan nw plan inc i :=
  evaluateToolPolicyMcp_of_silent (envPluginMcpGuard_of_admin h)

/-- With the check clear the result is `evaluateToolPolicyPlan`'s. -/
theorem evaluateToolPolicyMcp_of_clear {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : i.prims.envMcpDenied = none) :
    evaluateToolPolicyMcp nw plan inc i = evaluateToolPolicyPlan nw plan inc i :=
  evaluateToolPolicyMcp_of_silent (envPluginMcpGuard_of_clear h)

/-- For every tool outside `PLUGIN_MCP_TOOL_PREFIX` the result is `evaluateToolPolicyPlan`'s. -/
theorem evaluateToolPolicyMcp_of_not_prefixed {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : jsStartsWith i.toolName pluginMcpToolPrefix = false) :
    evaluateToolPolicyMcp nw plan inc i = evaluateToolPolicyPlan nw plan inc i :=
  evaluateToolPolicyMcp_of_silent (envPluginMcpGuard_of_not_prefixed h)

/-! ## When step 6d has a reason, the call is denied -/

/-- Every result step 6c returns is a deny. -/
theorem planGuard_deny {plan : Option (Option String)} {r : Result} (h : planGuard plan = some r) :
    r.decision = .deny := by
  unfold planGuard at h
  split at h
  · cases h; rfl
  · cases h

/-- Outside an incident session, a reason from the check on a non-admin call of a
`PLUGIN_MCP_TOOL_PREFIX` tool always ends in a deny — in every mode, whatever the boundary, the plan
check and the other primitives say: either an earlier deny step decided, or step 6d did. -/
theorem env_mcp_reason_denies (nw plan : Option (Option String)) (i : Input) (denied : String)
    (ha : i.isAdmin = false) (hp : jsStartsWith i.toolName pluginMcpToolPrefix = true)
    (hd : i.prims.envMcpDenied = some denied) :
    (evaluateToolPolicyMcp nw plan none i).decision = .deny := by
  unfold evaluateToolPolicyMcp
  split
  · next r h => exact abortGuard_deny h
  · split
    · next r h => exact devopsGuard_deny h
    · split
      · next r h => exact adminExemptGuardsWith_deny h
      · split
        · next r h => exact crossUserGuard_deny h
        · split
          · next r h => exact prIssueGuard_deny h
          · split
            · next r h => exact planGuard_deny h
            · simp only [modeTierMcp, envSkillGuard_of_plugin_mcp hp, envPluginMcpGuard_reason denied ha hp hd]

/-- When no earlier step fires, step 6d's denial is the result. -/
theorem env_mcp_denies_first {nw plan : Option (Option String)} {i : Input} (denied : String)
    (ha : i.isAdmin = false) (hp : jsStartsWith i.toolName pluginMcpToolPrefix = true)
    (hd : i.prims.envMcpDenied = some denied) (h1 : abortGuard i = none) (h2 : devopsGuard i = none)
    (h3 : adminExemptGuardsWith nw none i = none) (h4 : crossUserGuard i = none)
    (h5 : prIssueGuard i = none) (h6 : planGuard plan = none) :
    evaluateToolPolicyMcp nw plan none i =
      { decision := .deny, reason := "env-plugin-mcp: " ++ denied ++ " (" ++ i.toolName ++ ")",
        denyMessage := some envPluginMcpDenyMessage } := by
  simp only [evaluateToolPolicyMcp, h1, h2, h3, h4, h5, h6, modeTierMcp, envSkillGuard_of_plugin_mcp hp,
    envPluginMcpGuard_reason denied ha hp hd]

/-- Step 6d only narrows: wherever the result differs from the function without the step, it is a
deny. -/
theorem evaluateToolPolicyMcp_ne_deny {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input}
    (h : evaluateToolPolicyMcp nw plan inc i ≠ evaluateToolPolicyPlan nw plan inc i) :
    (evaluateToolPolicyMcp nw plan inc i).decision = .deny := by
  rcases inc with _ | inc
  · cases ha : i.isAdmin with
    | true => exact absurd (evaluateToolPolicyMcp_of_admin ha) h
    | false =>
      cases hp : jsStartsWith i.toolName pluginMcpToolPrefix with
      | false => exact absurd (evaluateToolPolicyMcp_of_not_prefixed hp) h
      | true =>
        cases hd : i.prims.envMcpDenied with
        | none => exact absurd (evaluateToolPolicyMcp_of_clear hd) h
        | some denied => exact env_mcp_reason_denies nw plan i denied ha hp hd
  · exact absurd (evaluateToolPolicyMcp_incident nw plan inc i) h

/-! ## Matchers -/

/-- `TOOL_POLICY_MATCHERS` has an MCP entry, the regular expression `^mcp__` (line 442). -/
theorem mcp_matched : "^mcp__" ∈ toolPolicyMatchers := by
  simp [toolPolicyMatchers]

end SomaVerify.ToolPolicy
