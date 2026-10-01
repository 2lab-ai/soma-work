import SomaVerify.ToolPolicy.Simplification

/-!
# Proofs of the incident READ-ONLY tier

Every incident statement of `Spec.lean` is proved here for `evaluateToolPolicy`, for every
allowlist and every input: every tool name, tool input, mode, admin flag, abort and handoff state,
and every combination of primitive values.

The route: the deny steps of `evaluateToolPolicy` are all silent exactly when no deny condition
holds (`denyStepsSilent_iff`). When one returns, the incident context changes nothing and the
result is `evaluate`'s, a denial (`Simplification.deny_exactly`); when none does, the result is
the incident tier's (`incident_cases`). Each statement is then a case analysis of
`evaluateIncidentReadOnly`.

`evaluate` is `evaluateToolPolicy none`, so (e) holds by definition, and `evaluate_toOriginal`
(`Simplification.lean`) still proves that function equal to the phase-1 model on every input.
-/

namespace SomaVerify.ToolPolicy

open SomaVerify.JsString

/-! ## The incident tier on its own -/

/-- The incident tier allows exactly an `mcp__` tool named in the allowlist. -/
theorem evaluateIncidentReadOnly_allow_iff (t : String) (inc : IncidentReadOnly) :
    (evaluateIncidentReadOnly t inc).decision = .allow ↔
      jsStartsWith t "mcp__" = true ∧ t ∈ inc.allowedMcpTools := by
  unfold evaluateIncidentReadOnly
  split <;> simp_all

/-- The incident tier only allows or denies. -/
theorem evaluateIncidentReadOnly_allow_or_deny (t : String) (inc : IncidentReadOnly) :
    (evaluateIncidentReadOnly t inc).decision = .allow ∨
      (evaluateIncidentReadOnly t inc).decision = .deny := by
  unfold evaluateIncidentReadOnly
  split <;> simp

/-! ## The deny steps, silent or not -/

/-- No deny step of `evaluateToolPolicy` returns. -/
def DenyStepsSilent (i : Input) : Prop :=
  abortGuard i = none ∧ adminExemptGuards i = none ∧ crossUserGuard i = none ∧
    prIssueGuard i = none

/-- When no deny step returns and an incident context is set, the incident tier decides. -/
theorem evaluateToolPolicy_some_of_silent {i : Input} (h : DenyStepsSilent i)
    (inc : IncidentReadOnly) :
    evaluateToolPolicy (some inc) i = evaluateIncidentReadOnly i.toolName inc := by
  obtain ⟨h1, h2, h3, h4⟩ := h
  unfold evaluateToolPolicy
  rw [h1, h2, h3, h4]

/-- When no deny step returns and no incident context is set, the mode tier decides. -/
theorem evaluate_of_silent {i : Input} (h : DenyStepsSilent i) : evaluate i = modeTier i := by
  obtain ⟨h1, h2, h3, h4⟩ := h
  unfold evaluate evaluateToolPolicy
  rw [h1, h2, h3, h4]

/-- When a deny step returns, the incident context changes nothing: the result is `evaluate`'s. -/
theorem evaluateToolPolicy_of_not_silent {i : Input} (h : ¬DenyStepsSilent i)
    (inc : Option IncidentReadOnly) : evaluateToolPolicy inc i = evaluate i := by
  unfold DenyStepsSilent at h
  unfold evaluate evaluateToolPolicy
  cases h1 : abortGuard i <;> cases h2 : adminExemptGuards i <;> cases h3 : crossUserGuard i <;>
    cases h4 : prIssueGuard i <;> simp_all

/-- The mode tier never denies. -/
theorem modeTier_decision_ne_deny (i : Input) : (modeTier i).decision ≠ .deny := by
  unfold modeTier
  split <;> (repeat' split) <;> simp

/-- A result denies exactly when its phase-1 image does. -/
theorem Result.toOriginal_deny_iff (r : Result) :
    r.toOriginal.decision = .deny ↔ r.decision = .deny := by
  cases r with
  | mk d _ _ _ => cases d <;> simp [Result.toOriginal, Decision.toOriginal]

/-- `evaluate` denies exactly under a deny condition (`Simplification.deny_exactly`, without the
phase-1 image). -/
theorem evaluate_deny_iff (i : Input) : (evaluate i).decision = .deny ↔ Original.DenyCond i := by
  rw [← Result.toOriginal_deny_iff]
  exact deny_exactly i

/-- The deny steps are all silent exactly when no deny condition holds. -/
theorem denyStepsSilent_iff (i : Input) : DenyStepsSilent i ↔ ¬Original.DenyCond i := by
  constructor
  · intro hs hc
    have hd := (evaluate_deny_iff i).mpr hc
    rw [evaluate_of_silent hs] at hd
    exact modeTier_decision_ne_deny i hd
  · intro hc
    obtain ⟨g1, g2, g3, g4, g5, g6⟩ := guard_conditions i
    simp only [Original.DenyCond, not_or] at hc
    obtain ⟨cA, cS, cP, cX, cM, cR⟩ := hc
    have e1 : abortGuard i = none := Classical.byContradiction fun h => cA (g1.mp h)
    have e3 : crossUserGuard i = none := Classical.byContradiction fun h => cX (g5.mp h)
    have e4 : prIssueGuard i = none := Classical.byContradiction fun h => cR (g6.mp h)
    have e2 : adminExemptGuards i = none := by
      unfold adminExemptGuards
      cases ha : i.isAdmin
      · have hs : sshCheck i = none := Classical.byContradiction fun h => cS (g2.mp ⟨ha, h⟩)
        have hp : sensitiveCheck i = none := Classical.byContradiction fun h => cP (g3.mp ⟨ha, h⟩)
        have hm : mcpCheck i = none := Classical.byContradiction fun h => cM (g4.mp ⟨ha, h⟩)
        simp [hs, hp, hm]
      · simp
    exact ⟨e1, e2, e3, e4⟩

/-- With an incident context, the result is either `evaluate`'s denial (a deny condition holds) or
the incident tier's (none holds). -/
theorem incident_cases (inc : IncidentReadOnly) (i : Input) :
    (Original.DenyCond i ∧ evaluateToolPolicy (some inc) i = evaluate i ∧
        (evaluate i).decision = .deny) ∨
      (¬Original.DenyCond i ∧
        evaluateToolPolicy (some inc) i = evaluateIncidentReadOnly i.toolName inc) := by
  by_cases hc : Original.DenyCond i
  · exact .inl ⟨hc, evaluateToolPolicy_of_not_silent (fun hs => (denyStepsSilent_iff i).mp hs hc) _,
      (evaluate_deny_iff i).mpr hc⟩
  · exact .inr ⟨hc, evaluateToolPolicy_some_of_silent ((denyStepsSilent_iff i).mpr hc) inc⟩

/-! ## The invariants of `Spec.lean` -/

/-- (a) With an incident context, every call is allowed or denied: never `pass`, never
`classify`. -/
theorem incident_allow_or_deny : IncidentAllowOrDeny evaluateToolPolicy := by
  intro inc i
  rcases incident_cases inc i with ⟨_, he, hd⟩ | ⟨_, he⟩
  · rw [he]
    exact .inr hd
  · rw [he]
    exact evaluateIncidentReadOnly_allow_or_deny _ _

/-- (a) With an incident context, no call is passed to the SDK's own permission logic. -/
theorem incident_never_pass : IncidentNeverPass evaluateToolPolicy := by
  intro inc i
  rcases incident_allow_or_deny inc i with h | h <;> rw [h] <;> decide

/-- (b) With an incident context, a call is allowed exactly when no deny condition holds and the
tool is an `mcp__` tool named in the allowlist. -/
theorem incident_allow_iff : IncidentAllowIff evaluateToolPolicy := by
  intro inc i
  rcases incident_cases inc i with ⟨hc, he, hd⟩ | ⟨hc, he⟩
  · rw [he, hd]
    simp [hc]
  · rw [he, evaluateIncidentReadOnly_allow_iff]
    simp [hc]

/-- (b) With an incident context, every call that is not an allow-listed `mcp__` tool is
denied. -/
theorem incident_denies_off_allow_list : IncidentDeniesOffAllowList evaluateToolPolicy := by
  intro inc i hn
  rcases incident_allow_or_deny inc i with h | h
  · exact absurd ((incident_allow_iff inc i).mp h).2 hn
  · exact h

/-- (c) With an incident context, the mode changes nothing in the result, reason included. -/
theorem incident_mode_independent : IncidentModeIndependent evaluateToolPolicy := by
  intro inc i mode
  have hc : Original.DenyCond { i with mode := mode } ↔ Original.DenyCond i := Iff.rfl
  rcases incident_cases inc i with ⟨hc1, he1, _⟩ | ⟨hc1, he1⟩ <;>
    rcases incident_cases inc { i with mode := mode } with ⟨hc2, he2, _⟩ | ⟨hc2, he2⟩
  · rw [he1, he2]
    exact Result.toOriginal_injective (deny_tier_mode_independent i mode hc1)
  · exact absurd (hc.mpr hc1) hc2
  · exact absurd (hc.mp hc2) hc1
  · rw [he1, he2]

/-- (c) With an incident context, when no deny condition holds the incident tier decides, on the
tool name and the allowlist alone. -/
theorem incident_tier_decides : IncidentTierDecides evaluateToolPolicy := by
  intro inc i hc
  rcases incident_cases inc i with ⟨h, _⟩ | ⟨_, he⟩
  · exact absurd h hc
  · exact he

/-- (c) With an incident context, mode and admin flag change nothing as long as no deny condition
holds. -/
theorem incident_mode_admin_independent_without_deny :
    IncidentModeAdminIndependentWithoutDeny evaluateToolPolicy := by
  intro inc i mode isAdmin h1 h2
  rw [incident_tier_decides inc _ h1, incident_tier_decides inc _ h2]

/-- The sensitive-path check stays silent when the sensitive-path primitive comes back clear. -/
theorem sensitiveCheck_of_not_sensitive {i : Input} (h : i.prims.sensitive.isSensitive = false) :
    sensitiveCheck i = none := by
  unfold sensitiveCheck
  cases hc : checkSensitiveForTool i.toolName i.path i.prims.sensitive with
  | none => rfl
  | some s =>
    have hs : s.isSensitive = false := by
      rw [Original.checkSensitiveForTool_eq] at hc
      split at hc
      · cases hc
        exact h
      · split at hc
        · cases hc
          rfl
        · cases hc
    simp [hs]

/-- Being an admin has exactly the effect of the ssh, sensitive-path and MCP checks all coming back
clear for a non-admin, with or without an incident context. -/
theorem evaluateToolPolicy_admin (incident : Option IncidentReadOnly) (i : Input) :
    evaluateToolPolicy incident { i with isAdmin := true } =
      evaluateToolPolicy incident { i with
        isAdmin := false,
        prims := { i.prims with ssh := false, sensitive := { isSensitive := false },
                                mcpDenied := none } } := by
  have e2 : adminExemptGuards { i with isAdmin := true } = none := by
    simp [adminExemptGuards]
  have hs : sshCheck { i with
      isAdmin := false,
      prims := { i.prims with ssh := false, sensitive := { isSensitive := false },
                              mcpDenied := none } } = none := by
    simp [sshCheck]
  have hp : sensitiveCheck { i with
      isAdmin := false,
      prims := { i.prims with ssh := false, sensitive := { isSensitive := false },
                              mcpDenied := none } } = none :=
    sensitiveCheck_of_not_sensitive rfl
  have hm : mcpCheck { i with
      isAdmin := false,
      prims := { i.prims with ssh := false, sensitive := { isSensitive := false },
                              mcpDenied := none } } = none := by
    simp [mcpCheck]
  have e2' : adminExemptGuards { i with
      isAdmin := false,
      prims := { i.prims with ssh := false, sensitive := { isSensitive := false },
                              mcpDenied := none } } = none := by
    simp [adminExemptGuards, hs, hp, hm]
  unfold evaluateToolPolicy
  rw [e2, e2']
  cases abortGuard i <;> cases crossUserGuard i <;> cases prIssueGuard i <;> cases incident <;> rfl

/-- (c) With an incident context, an admin's call gets exactly the result of a non-admin's whose
ssh, sensitive-path and MCP checks come back clear. -/
theorem incident_admin_skips_exactly_ssh_sensitive_mcp :
    IncidentAdminSkipsExactlySshSensitiveMcp evaluateToolPolicy :=
  fun inc i => evaluateToolPolicy_admin (some inc) i

/-- (c) The admin flag alone can change an incident call's decision: the allow-listed evidence
tool, with an MCP grant check that fails, is denied to a non-admin (`mcp-permission`) and allowed
to an admin, who skips that check. -/
theorem incident_admin_dependent : IncidentAdminDependent evaluateToolPolicy := by
  refine ⟨{ allowedMcpTools := ["mcp__x__y"] },
    { toolName := "mcp__x__y", command := .absent, filePath := .absent, pattern := .absent,
      path := .absent, isAdmin := false, mode := .legacy, aborted := false, handoff := false,
      prims := { ssh := false, sensitive := { isSensitive := false }, crossUser := false,
                 mcpDenied := some "grant expired", prIssue := { blocked := false },
                 bash := { decision := .allow, matchedRuleIds := [] } } }, ?_⟩
  decide

/-- (d) With an incident context, a met deny condition decides as it does without one: a denial,
with the deny guard's own reason, even for an allow-listed tool. -/
theorem incident_hard_deny_wins : IncidentHardDenyWins evaluateToolPolicy := by
  intro inc i hc
  rcases incident_cases inc i with ⟨_, he, hd⟩ | ⟨h, _⟩
  · exact ⟨he, by rw [he]; exact hd⟩
  · exact absurd hc h

/-- (e) Without an incident context the result is `evaluate`'s, by definition. -/
theorem incident_absent_unchanged : IncidentAbsentUnchanged evaluateToolPolicy :=
  fun _ => rfl

/-- (e) Without an incident context the result is the phase-1 model's, decision, reason, deny
message and rule ids alike, so every invariant `Simplification.lean` transfers holds of it. -/
theorem incident_absent_toOriginal (i : Input) :
    (evaluateToolPolicy none i).toOriginal = Original.evaluate i :=
  evaluate_toOriginal i

end SomaVerify.ToolPolicy
