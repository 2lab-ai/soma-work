import SomaVerify.ToolPolicy.Simplification

/-!
# Proofs of the incident READ-ONLY tier

Every incident statement of `Spec.lean` is proved here for `evaluateToolPolicy`, for every
allowlist and every input: every tool name, tool input, mode, admin flag, abort and handoff state,
and every combination of primitive values.

The route: with an incident context no step reads the mode or the admin flag, since the non-admin
block runs for everyone and the incident tier replaces the mode tier
(`evaluateToolPolicy_some_mode_admin`). So an incident call is decided as the same call made by a
non-admin, and for a non-admin the deny steps are those of `evaluate`, all silent exactly when no
deny condition holds (`denyStepsSilent_iff`). When one returns, the result is `evaluate`'s, a
denial (`Simplification.deny_exactly`); when none does, it is the incident tier's
(`incident_cases`). Each statement is then a case analysis of `evaluateIncidentReadOnly`.

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

/-! ## Mode and admin flag never reach an incident call -/

/-- With an incident context, no step reads the mode or the admin flag: the non-admin block runs
whatever the flag, and the incident tier stands where the mode tier would. -/
theorem evaluateToolPolicy_some_mode_admin (inc : IncidentReadOnly) (i : Input) (mode : Mode)
    (isAdmin : Bool) :
    evaluateToolPolicy (some inc) { i with mode := mode, isAdmin := isAdmin } =
      evaluateToolPolicy (some inc) i := by
  have h1 : abortGuard { i with mode := mode, isAdmin := isAdmin } = abortGuard i := rfl
  have hs : sshCheck { i with mode := mode, isAdmin := isAdmin } = sshCheck i := rfl
  have hp : sensitiveCheck { i with mode := mode, isAdmin := isAdmin } = sensitiveCheck i := rfl
  have hm : mcpCheck { i with mode := mode, isAdmin := isAdmin } = mcpCheck i := rfl
  have h2 : adminExemptGuards (some inc) { i with mode := mode, isAdmin := isAdmin } =
      adminExemptGuards (some inc) i := by
    simp [adminExemptGuards, hs, hp, hm]
  have h3 : crossUserGuard { i with mode := mode, isAdmin := isAdmin } = crossUserGuard i := rfl
  have h4 : prIssueGuard { i with mode := mode, isAdmin := isAdmin } = prIssueGuard i := rfl
  unfold evaluateToolPolicy
  rw [h1, h2, h3, h4]

/-! ## The deny steps of a non-admin call, silent or not -/

/-- No deny step of `evaluate` returns. -/
def DenyStepsSilent (i : Input) : Prop :=
  abortGuard i = none ∧ adminExemptGuards none i = none ∧ crossUserGuard i = none ∧
    prIssueGuard i = none

/-- For a non-admin, the non-admin block runs with or without an incident context. -/
theorem adminExemptGuards_some_of_nonadmin (inc : IncidentReadOnly) {i : Input}
    (ha : i.isAdmin = false) : adminExemptGuards (some inc) i = adminExemptGuards none i := by
  simp [adminExemptGuards, ha]

/-- For a non-admin call on which no deny step returns, an incident context hands the call to the
incident tier. -/
theorem evaluateToolPolicy_some_of_silent {i : Input} (ha : i.isAdmin = false)
    (h : DenyStepsSilent i) (inc : IncidentReadOnly) :
    evaluateToolPolicy (some inc) i = evaluateIncidentReadOnly i.toolName inc := by
  obtain ⟨h1, h2, h3, h4⟩ := h
  unfold evaluateToolPolicy
  rw [adminExemptGuards_some_of_nonadmin inc ha, h1, h2, h3, h4]

/-- When no deny step returns and no incident context is set, the mode tier decides. -/
theorem evaluate_of_silent {i : Input} (h : DenyStepsSilent i) : evaluate i = modeTier i := by
  obtain ⟨h1, h2, h3, h4⟩ := h
  unfold evaluate evaluateToolPolicy
  rw [h1, h2, h3, h4]

/-- For a non-admin call on which a deny step returns, the incident context changes nothing: the
result is `evaluate`'s. -/
theorem evaluateToolPolicy_some_of_not_silent {i : Input} (ha : i.isAdmin = false)
    (h : ¬DenyStepsSilent i) (inc : IncidentReadOnly) :
    evaluateToolPolicy (some inc) i = evaluate i := by
  unfold DenyStepsSilent at h
  unfold evaluate evaluateToolPolicy
  rw [adminExemptGuards_some_of_nonadmin inc ha]
  cases h1 : abortGuard i <;> cases h2 : adminExemptGuards none i <;>
    cases h3 : crossUserGuard i <;> cases h4 : prIssueGuard i <;> simp_all

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

/-- The deny steps of `evaluate` are all silent exactly when no deny condition holds. -/
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
    have e2 : adminExemptGuards none i = none := by
      cases ha : i.isAdmin
      · have hs : sshCheck i = none := Classical.byContradiction fun h => cS (g2.mp ⟨ha, h⟩)
        have hp : sensitiveCheck i = none := Classical.byContradiction fun h => cP (g3.mp ⟨ha, h⟩)
        have hm : mcpCheck i = none := Classical.byContradiction fun h => cM (g4.mp ⟨ha, h⟩)
        simp [adminExemptGuards, ha, hs, hp, hm]
      · simp [adminExemptGuards, ha]
    exact ⟨e1, e2, e3, e4⟩

/-- Whatever a session without an incident context hard-denies, for an admin or not, an incident
session hard-denies too: dropping the admin flag only adds deny conditions. -/
theorem denyCond_incidentDenyCond (i : Input) : Original.DenyCond i → IncidentDenyCond i := by
  intro h
  rcases h with h | h | h | h | h | h
  · exact .inl h
  · exact .inr (.inl ⟨h.1, rfl, h.2.2⟩)
  · exact .inr (.inr (.inl ⟨rfl, h.2.1, h.2.2⟩))
  · exact .inr (.inr (.inr (.inl h)))
  · exact .inr (.inr (.inr (.inr (.inl ⟨h.1, rfl, h.2.2⟩))))
  · exact .inr (.inr (.inr (.inr (.inr h))))

/-- With an incident context, the result is either the denial `evaluate` gives the same call made
by a non-admin (a deny condition of that call holds) or the incident tier's (none holds). -/
theorem incident_cases (inc : IncidentReadOnly) (i : Input) :
    (IncidentDenyCond i ∧ evaluateToolPolicy (some inc) i = evaluate { i with isAdmin := false } ∧
        (evaluate { i with isAdmin := false }).decision = .deny) ∨
      (¬IncidentDenyCond i ∧
        evaluateToolPolicy (some inc) i = evaluateIncidentReadOnly i.toolName inc) := by
  have hj : evaluateToolPolicy (some inc) { i with isAdmin := false } =
      evaluateToolPolicy (some inc) i :=
    evaluateToolPolicy_some_mode_admin inc i i.mode false
  rw [← hj]
  by_cases hc : IncidentDenyCond i
  · refine .inl ⟨hc, evaluateToolPolicy_some_of_not_silent rfl
      (fun hs => (denyStepsSilent_iff _).mp hs hc) inc, (evaluate_deny_iff _).mpr hc⟩
  · exact .inr ⟨hc, evaluateToolPolicy_some_of_silent rfl ((denyStepsSilent_iff _).mpr hc) inc⟩

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

/-- (b) With an incident context, a call is allowed exactly when no deny condition of the same
call made by a non-admin holds and the tool is an `mcp__` tool named in the allowlist. -/
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

/-- (c) With an incident context, the mode and the admin flag change nothing in the result, reason
included. -/
theorem incident_mode_admin_independent : IncidentModeAdminIndependent evaluateToolPolicy :=
  evaluateToolPolicy_some_mode_admin

/-- (c) With an incident context, the admin flag changes nothing in the result: an admin gets no
privilege. -/
theorem incident_admin_independent : IncidentAdminIndependent evaluateToolPolicy :=
  fun inc i isAdmin => evaluateToolPolicy_some_mode_admin inc i i.mode isAdmin

/-- (c) With an incident context, the mode changes nothing in the result. -/
theorem incident_mode_independent : IncidentModeIndependent evaluateToolPolicy :=
  fun inc i mode => evaluateToolPolicy_some_mode_admin inc i mode i.isAdmin

/-- (c) With an incident context, when no deny condition holds the incident tier decides, on the
tool name and the allowlist alone. -/
theorem incident_tier_decides : IncidentTierDecides evaluateToolPolicy := by
  intro inc i hc
  rcases incident_cases inc i with ⟨h, _⟩ | ⟨_, he⟩
  · exact absurd h hc
  · exact he

/-- (d) With an incident context, a met deny condition decides as it does for a non-admin without
one: a denial, with the deny guard's own reason, even for an allow-listed tool. -/
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
