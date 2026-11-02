import SomaVerify.ToolPolicy.ProofsNativeWrite

/-!
# Proofs of plan mode (step 6c)

Proved for `evaluateToolPolicyPlan`, for every value of the plan check and every input: every
tool name, tool input, mode, admin flag, abort and handoff state, native write boundary value,
incident context, and every combination of primitive values.

* When the step is silent — no check (`ctx.checkPlanPending` undefined) or a check that answers
  `null` — the result is `evaluateToolPolicyWith`'s, the phase-5 function every earlier theorem is
  about (`evaluateToolPolicyPlan_of_silent`).
* When the check answers a reason, the call is denied, whatever the mode, the admin flag or the
  rest of the input (`plan_reason_denies`): either an earlier deny step decided, or step 6c did.
* When no earlier step fires, the step's own denial, with `PLAN_PENDING_DENY_MESSAGE`, is the
  result (`plan_denies_first`).
* The step only narrows: wherever the result differs from the function without it, it is a deny
  (`evaluateToolPolicyPlan_ne_deny`).
-/

namespace SomaVerify.ToolPolicy

open SomaVerify.ToolPolicy.Phase4 (abortGuard_deny devopsGuard_deny sshCheck_deny sensitiveCheck_deny
  mcpCheck_deny crossUserGuard_deny prIssueGuard_deny)

/-! ## Step 6c on its own -/

/-- Without a check step 6c is silent. -/
theorem planGuard_absent : planGuard none = none := rfl

/-- With a check that answers `null` step 6c is silent. -/
theorem planGuard_clear : planGuard (some none) = none := rfl

/-- With a reason step 6c denies, with that reason and `PLAN_PENDING_DENY_MESSAGE`. -/
theorem planGuard_reason (reason : String) :
    planGuard (some (some reason)) =
      some { decision := .deny, reason := "plan-pending: " ++ reason,
             denyMessage := some planPendingDenyMessage } := rfl

/-- Step 6c is silent exactly when the check gives no reason. -/
theorem planGuard_eq_none_iff (plan : Option (Option String)) :
    planGuard plan = none ↔ ∀ reason, plan ≠ some (some reason) := by
  rcases plan with _ | _ | reason
  · simp [planGuard]
  · simp [planGuard]
  · simp [planGuard]

/-! ## When step 6c is silent, nothing changes -/

/-- When step 6c is silent the result is `evaluateToolPolicyWith`'s. -/
theorem evaluateToolPolicyPlan_of_silent {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : planGuard plan = none) :
    evaluateToolPolicyPlan nw plan inc i = evaluateToolPolicyWith nw inc i := by
  unfold evaluateToolPolicyPlan evaluateToolPolicyWith
  simp only [h]

/-- Without a check (a task whose plan is started, a Slack turn, any other session) the result is
`evaluateToolPolicyWith`'s. -/
theorem evaluateToolPolicyPlan_none (nw : Option (Option String)) (inc : Option IncidentReadOnly)
    (i : Input) : evaluateToolPolicyPlan nw none inc i = evaluateToolPolicyWith nw inc i :=
  evaluateToolPolicyPlan_of_silent planGuard_absent

/-- A check that lets the call through changes nothing. -/
theorem evaluateToolPolicyPlan_clear (nw : Option (Option String)) (inc : Option IncidentReadOnly)
    (i : Input) : evaluateToolPolicyPlan nw (some none) inc i = evaluateToolPolicyWith nw inc i :=
  evaluateToolPolicyPlan_of_silent planGuard_clear

/-! ## When step 6c has a reason, the call is denied -/

/-- Every result step 3b returns is a deny. -/
theorem nativeWriteCheck_deny {nw : Option (Option String)} {i : Input} {r : Result}
    (h : nativeWriteCheck nw i = some r) : r.decision = .deny := by
  obtain ⟨_, _, _, rfl⟩ := nativeWriteCheck_some h
  rfl

/-- Every result the non-admin block (with step 3b) returns is a deny. -/
theorem adminExemptGuardsWith_deny {nw : Option (Option String)} {inc : Option IncidentReadOnly}
    {i : Input} {r : Result} (h : adminExemptGuardsWith nw inc i = some r) : r.decision = .deny := by
  unfold adminExemptGuardsWith at h
  split at h
  · split at h
    · cases h; exact sshCheck_deny (by assumption)
    · split at h
      · cases h; exact sensitiveCheck_deny (by assumption)
      · split at h
        · cases h; exact nativeWriteCheck_deny (by assumption)
        · exact mcpCheck_deny h
  · cases h

/-- A reason from the plan check always ends in a deny — in every mode, for admins and
non-admins, in and out of an incident session, whatever the boundary and the primitives say. -/
theorem plan_reason_denies (nw : Option (Option String)) (inc : Option IncidentReadOnly)
    (i : Input) (reason : String) :
    (evaluateToolPolicyPlan nw (some (some reason)) inc i).decision = .deny := by
  unfold evaluateToolPolicyPlan
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
          · rfl

/-- When no earlier step fires, step 6c's denial is the result. -/
theorem plan_denies_first {nw : Option (Option String)} {inc : Option IncidentReadOnly}
    {i : Input} (reason : String) (h1 : abortGuard i = none) (h2 : devopsGuard i = none)
    (h3 : adminExemptGuardsWith nw inc i = none) (h4 : crossUserGuard i = none)
    (h5 : prIssueGuard i = none) :
    evaluateToolPolicyPlan nw (some (some reason)) inc i =
      { decision := .deny, reason := "plan-pending: " ++ reason,
        denyMessage := some planPendingDenyMessage } := by
  unfold evaluateToolPolicyPlan
  simp only [h1, h2, h3, h4, h5, planGuard_reason]

/-- Step 6c only narrows: wherever the result differs from the function without the step, it is
a deny. -/
theorem evaluateToolPolicyPlan_ne_deny {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input}
    (h : evaluateToolPolicyPlan nw plan inc i ≠ evaluateToolPolicyWith nw inc i) :
    (evaluateToolPolicyPlan nw plan inc i).decision = .deny := by
  rcases plan with _ | _ | reason
  · exact absurd (evaluateToolPolicyPlan_none nw inc i) h
  · exact absurd (evaluateToolPolicyPlan_clear nw inc i) h
  · exact plan_reason_denies nw inc i reason

end SomaVerify.ToolPolicy
