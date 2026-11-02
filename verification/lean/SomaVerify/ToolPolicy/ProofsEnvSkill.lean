import SomaVerify.ToolPolicy.ProofsDevops

/-!
# Phase 4: the environment-skill step (step 6b)

The phase-4 code adds one guard to `evaluateToolPolicy` (`src/agent-runtime/policy/tool-policy.ts`
lines 292-301), between the incident tier and the mode tier: a non-admin's call of one of
`ENV_GATED_TOOLS` (`Skill`, the file readers `Read`/`Glob`/`Grep`/`Bash` and the writers
`Write`/`Edit`/`NotebookEdit`) whose `ctx.checkEnvSkillPermission`
returns a reason is denied, with `ENV_SKILL_DENY_MESSAGE`. The model
of that code is `evaluateToolPolicyEnv` (`Model.lean`); the phase-3 function keeps its name,
`evaluateToolPolicy`, and every theorem proved about it.

This file ties the two together and pins what the new step does:

* the step is silent unless the call is a non-admin call of a gated tool whose check returned a
  value (`envSkillGuard_eq_none_iff`), and wherever it is silent the phase-4 function is the
  phase-3 one (`evaluateToolPolicyEnv_of_silent`): in particular for every incident call
  (`evaluateToolPolicyEnv_incident`), every admin call (`evaluateEnv_of_admin`), every call whose
  check comes back clear (`evaluateEnv_of_clear`) and every tool outside `ENV_GATED_TOOLS`
  (`evaluateEnv_of_not_gated`), so each phase-3 theorem holds of the TS function on those calls;
* a phase-3 denial stands in phase 4 (`evaluateEnv_of_deny`), and otherwise the step decides when
  it fires (`evaluateEnv_of_not_deny`): it only ever turns an allow, classify or pass into a deny;
* when it fires it decides the call, a deny with its reason and message (`env_skill_denies`): no
  step before it fires on a `Skill` call (`denyTier_silent_of_skill`);
* the policy still has an opinion only on calls a `TOOL_POLICY_MATCHERS` entry covers, now with
  `Skill` among them (`opinion_only_on_matched_tools_env`, `skill_matched`).
-/

namespace SomaVerify.ToolPolicy.Phase4

open SomaVerify SomaVerify.ToolPolicy SomaVerify.JsString

/-! ## When step 6b is silent -/

/-- Step 6b returns nothing unless the call is a non-admin call of a gated tool whose check
returned a value (lines 296-299). -/
theorem envSkillGuard_eq_none_iff (i : Input) :
    envSkillGuard i = none ↔
      ¬(envGatedTools.contains i.toolName = true ∧ i.isAdmin = false ∧
        i.prims.envSkillDenied.isSome = true) := by
  unfold envSkillGuard
  by_cases h : envGatedTools.contains i.toolName = true ∧ i.isAdmin = false
  · cases i.prims.envSkillDenied <;> simp [h]
  · simp only [h, ↓reduceIte, true_iff]
    exact fun h' => h ⟨h'.1, h'.2.1⟩

/-- A check that comes back clear (`null`) keeps step 6b silent. -/
theorem envSkillGuard_of_clear {i : Input} (h : i.prims.envSkillDenied = none) :
    envSkillGuard i = none :=
  (envSkillGuard_eq_none_iff i).mpr fun h' => by simp [h] at h'

/-- Admins skip step 6b (`!ctx.isAdmin`, line 296). -/
theorem envSkillGuard_of_admin {i : Input} (h : i.isAdmin = true) : envSkillGuard i = none :=
  (envSkillGuard_eq_none_iff i).mpr fun h' => by simp [h] at h'

/-- Step 6b consults its check for `ENV_GATED_TOOLS` only (`ENV_GATED_TOOLS.includes`, line 296). -/
theorem envSkillGuard_of_not_gated {i : Input} (h : envGatedTools.contains i.toolName = false) :
    envSkillGuard i = none :=
  (envSkillGuard_eq_none_iff i).mpr fun h' => by rw [h] at h'; exact Bool.false_ne_true h'.1

/-- With step 6b silent, step 6b followed by the mode tier is the mode tier. -/
theorem modeTierEnv_of_silent {i : Input} (h : envSkillGuard i = none) :
    modeTierEnv i = modeTier i := by
  simp [modeTierEnv, h]

/-! ## The phase-4 function is the phase-3 one wherever step 6b is silent -/

/-- Wherever step 6b is silent, the phase-4 policy returns what the phase-3 policy returns, decision,
reason, deny message and rule ids alike, with or without an incident context. -/
theorem evaluateToolPolicyEnv_of_silent (incident : Option IncidentReadOnly) {i : Input}
    (h : envSkillGuard i = none) : evaluateToolPolicyEnv incident i = evaluateToolPolicy incident i := by
  simp only [evaluateToolPolicyEnv, evaluateToolPolicy, modeTierEnv_of_silent h]

/-- An incident session never reaches step 6b (it sits below the incident tier, line 290): the
phase-4 policy is the phase-3 one on every incident call, so `ProofsIncident.lean` describes it. -/
theorem evaluateToolPolicyEnv_incident (inc : IncidentReadOnly) (i : Input) :
    evaluateToolPolicyEnv (some inc) i = evaluateToolPolicy (some inc) i := by
  simp only [evaluateToolPolicyEnv, evaluateToolPolicy]

/-- With the check clear, the phase-4 policy is the phase-3 `evaluate`. -/
theorem evaluateEnv_of_clear {i : Input} (h : i.prims.envSkillDenied = none) :
    evaluateEnv i = evaluate i :=
  evaluateToolPolicyEnv_of_silent none (envSkillGuard_of_clear h)

/-- For admins, the phase-4 policy is the phase-3 `evaluate`. -/
theorem evaluateEnv_of_admin {i : Input} (h : i.isAdmin = true) : evaluateEnv i = evaluate i :=
  evaluateToolPolicyEnv_of_silent none (envSkillGuard_of_admin h)

/-- For every tool outside `ENV_GATED_TOOLS`, the phase-4 policy is the phase-3 `evaluate`. -/
theorem evaluateEnv_of_not_gated {i : Input} (h : envGatedTools.contains i.toolName = false) :
    evaluateEnv i = evaluate i :=
  evaluateToolPolicyEnv_of_silent none (envSkillGuard_of_not_gated h)

/-- The new step changes a result only on a non-admin call of a gated tool whose check returned a
value. -/
theorem evaluateEnv_ne_evaluate {i : Input} (h : evaluateEnv i ≠ evaluate i) :
    envGatedTools.contains i.toolName = true ∧ i.isAdmin = false ∧
      i.prims.envSkillDenied.isSome = true :=
  Classical.byContradiction fun hn =>
    h (evaluateToolPolicyEnv_of_silent none ((envSkillGuard_eq_none_iff i).mpr hn))

/-! ## What step 6b does when it fires -/

/-- No step before 6b fires on a `Skill` call: the abort, ssh, cross-user and PR-issue guards test
for Bash or the PR-create tool, step 1b and the sensitive-path dispatch have no `Skill` arm, and
`Skill` is no `mcp__` tool. -/
theorem denyTier_silent_of_skill {i : Input} (ht : i.toolName = "Skill") :
    abortGuard i = none ∧ devopsGuard i = none ∧ adminExemptGuards none i = none ∧
      crossUserGuard i = none ∧ prIssueGuard i = none := by
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · simp [abortGuard, ht]
  · simp [devopsGuard, checkDevopsSecretForTool, ht]
  · simp [adminExemptGuards, sshCheck, sensitiveCheck, checkSensitiveForTool, mcpCheck, ht,
      jsStartsWith]
  · simp [crossUserGuard, ht]
  · simp [prIssueGuard, prCreateMcpTool, ht]

/-- "Any non-null value is a deny reason" (line 298): a non-admin `Skill` call whose check returns
`denied` is denied with reason `env-skill: <denied>` and `ENV_SKILL_DENY_MESSAGE`, in every mode,
the empty string included. -/
theorem env_skill_denies (i : Input) (denied : String) (ht : i.toolName = "Skill")
    (ha : i.isAdmin = false) (hd : i.prims.envSkillDenied = some denied) :
    evaluateEnv i =
      { decision := .deny, reason := "env-skill: " ++ denied,
        denyMessage := some envSkillDenyMessage } := by
  obtain ⟨h1, h2, h3, h4, h5⟩ := denyTier_silent_of_skill ht
  simp [evaluateEnv, evaluateToolPolicyEnv, h1, h2, h3, h4, h5, modeTierEnv, envSkillGuard,
    envGatedTools, ht, ha, hd]

/-- The phase-3 deny chain, ahead of the incident and mode tiers. -/
def denyChain (i : Input) : Option Result :=
  match abortGuard i with
  | some r => some r
  | none =>
  match devopsGuard i with
  | some r => some r
  | none =>
  match adminExemptGuards none i with
  | some r => some r
  | none =>
  match crossUserGuard i with
  | some r => some r
  | none => prIssueGuard i

/-- Without an incident context, the phase-3 policy is its deny chain, else the mode tier. -/
theorem evaluate_eq_denyChain (i : Input) : evaluate i = (denyChain i).getD (modeTier i) := by
  simp only [evaluate, evaluateToolPolicy, denyChain]
  split <;> simp_all <;> split <;> simp_all <;> split <;> simp_all <;> split <;> simp_all <;>
    split <;> simp_all

/-- Without an incident context, the phase-4 policy is the same deny chain, else step 6b, else the
mode tier. -/
theorem evaluateEnv_eq_denyChain (i : Input) :
    evaluateEnv i = (denyChain i).getD (modeTierEnv i) := by
  simp only [evaluateEnv, evaluateToolPolicyEnv, denyChain]
  split <;> simp_all <;> split <;> simp_all <;> split <;> simp_all <;> split <;> simp_all <;>
    split <;> simp_all

/-- The mode tier never denies. -/
theorem modeTier_ne_deny (i : Input) : (modeTier i).decision ≠ .deny := by
  unfold modeTier
  split
  · simp
  · split
    · split <;> simp
    · split <;> simp

theorem abortGuard_deny {i : Input} {r : Result} (h : abortGuard i = some r) : r.decision = .deny := by
  unfold abortGuard at h
  split at h
  · cases h; rfl
  · cases h

theorem devopsGuard_deny {i : Input} {r : Result} (h : devopsGuard i = some r) : r.decision = .deny := by
  unfold devopsGuard at h
  split at h
  · cases h; rfl
  · cases h

theorem sshCheck_deny {i : Input} {r : Result} (h : sshCheck i = some r) : r.decision = .deny := by
  unfold sshCheck at h
  split at h
  · cases h; rfl
  · cases h

theorem sensitiveCheck_deny {i : Input} {r : Result} (h : sensitiveCheck i = some r) :
    r.decision = .deny := by
  unfold sensitiveCheck at h
  split at h
  · split at h
    · cases h; rfl
    · cases h
  · cases h

theorem mcpCheck_deny {i : Input} {r : Result} (h : mcpCheck i = some r) : r.decision = .deny := by
  unfold mcpCheck at h
  split at h
  · split at h
    · cases h; rfl
    · cases h
  · cases h

theorem adminExemptGuards_deny {i : Input} {r : Result} (h : adminExemptGuards none i = some r) :
    r.decision = .deny := by
  unfold adminExemptGuards at h
  split at h
  · split at h
    · cases h; exact sshCheck_deny (by assumption)
    · split at h
      · cases h; exact sensitiveCheck_deny (by assumption)
      · exact mcpCheck_deny h
  · cases h

theorem crossUserGuard_deny {i : Input} {r : Result} (h : crossUserGuard i = some r) :
    r.decision = .deny := by
  unfold crossUserGuard at h
  split at h
  · cases h; rfl
  · cases h

theorem prIssueGuard_deny {i : Input} {r : Result} (h : prIssueGuard i = some r) : r.decision = .deny := by
  unfold prIssueGuard at h
  split at h
  · split at h
    · cases h; rfl
    · cases h
  · cases h

/-- Every step of the deny chain denies when it returns. -/
theorem denyChain_deny {i : Input} {r : Result} (h : denyChain i = some r) : r.decision = .deny := by
  unfold denyChain at h
  split at h
  · cases h; exact abortGuard_deny (by assumption)
  · split at h
    · cases h; exact devopsGuard_deny (by assumption)
    · split at h
      · cases h; exact adminExemptGuards_deny (by assumption)
      · split at h
        · cases h; exact crossUserGuard_deny (by assumption)
        · exact prIssueGuard_deny h

/-- A phase-3 denial stands in phase 4: step 6b sits below the deny chain, and the mode tier never
denies, so a phase-3 deny came from the chain, which phase 4 runs first as well. -/
theorem evaluateEnv_of_deny {i : Input} (h : (evaluate i).decision = .deny) : evaluateEnv i = evaluate i := by
  rw [evaluateEnv_eq_denyChain, evaluate_eq_denyChain]
  rw [evaluate_eq_denyChain] at h
  cases hc : denyChain i with
  | some r => rfl
  | none => simp [hc] at h; exact absurd h (modeTier_ne_deny i)

/-- Wherever phase 3 does not deny, phase 4 is step 6b when it fires and phase 3 otherwise. -/
theorem evaluateEnv_of_not_deny {i : Input} (h : (evaluate i).decision ≠ .deny) :
    evaluateEnv i = (envSkillGuard i).getD (evaluate i) := by
  rw [evaluateEnv_eq_denyChain, evaluate_eq_denyChain]
  rw [evaluate_eq_denyChain] at h
  cases hc : denyChain i with
  | some r => simp [hc] at h; exact absurd (denyChain_deny hc) h
  | none =>
    simp only [Option.getD_none, modeTierEnv]
    cases envSkillGuard i <;> rfl

/-! ## Matchers -/

/-- `TOOL_POLICY_MATCHERS` has a `Skill` entry (line 343). -/
theorem skill_matched : "Skill" ∈ toolPolicyMatchers := by
  simp [toolPolicyMatchers]

/-- The policy has an opinion only on Bash, native-tool, `mcp__` and `Skill` calls, each covered by
a `TOOL_POLICY_MATCHERS` entry. -/
theorem opinion_only_on_matched_tools_env (i : Input) (hne : (evaluateEnv i).decision ≠ .pass) :
    i.toolName = "Bash" ∨ i.toolName ∈ nativeBypassTools ∨ jsStartsWith i.toolName "mcp__" = true ∨
      i.toolName = "Skill" := by
  cases hg : envGatedTools.contains i.toolName with
  | true =>
    simp only [envGatedTools, List.contains_cons, List.contains_nil, Bool.or_false, Bool.or_eq_true,
      beq_iff_eq] at hg
    rcases hg with h | h | h | h | h | h | h | h
    · exact .inr (.inr (.inr h))
    · exact .inr (.inl (by rw [h]; decide))
    · exact .inr (.inl (by rw [h]; decide))
    · exact .inr (.inl (by rw [h]; decide))
    · exact .inl h
    · exact .inr (.inl (by rw [h]; decide))
    · exact .inr (.inl (by rw [h]; decide))
    · exact .inr (.inl (by rw [h]; decide))
  | false =>
    rw [evaluateEnv_of_not_gated hg] at hne
    have hne' : ((evaluate i).toOriginal).decision ≠ Original.Decision.pass := by
      intro hp
      apply hne
      cases hdec : (evaluate i).decision <;>
        simp [Result.toOriginal, Decision.toOriginal, hdec] at hp ⊢
    rcases Phase3.opinion_only_on_matched_tools i hne' with h | h | h
    · exact .inl h
    · exact .inr (.inl h)
    · exact .inr (.inr (.inl h))

end SomaVerify.ToolPolicy.Phase4
