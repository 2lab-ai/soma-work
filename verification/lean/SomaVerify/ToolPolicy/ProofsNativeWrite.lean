import SomaVerify.ToolPolicy.ProofsIncident

/-!
# Proofs of the native write boundary

Every native-write statement of `Spec.lean` is proved here for `evaluateToolPolicyWith`, for every
boundary value and every input: every tool name, tool input, mode, admin flag, abort and handoff
state, incident context, and every combination of primitive values.

The route: when step 3b is silent the non-admin block is the one without the step
(`adminExemptGuardsWith_of_silent`), so the whole result is `evaluateToolPolicy`'s
(`evaluateToolPolicyWith_of_silent`). The step is silent without a boundary, with a target inside
it, and for every tool that is not a native write tool. When it fires, the call is a native write
tool, which no earlier step of the deny tier looks at, so the step's denial is the result
(`nativeWrite_denies_outside`).
-/

namespace SomaVerify.ToolPolicy

/-! ## Step 3b on its own -/

/-- Without a boundary step 3b is silent. -/
theorem nativeWriteCheck_absent (i : Input) : nativeWriteCheck none i = none := rfl

/-- With a target inside the boundary step 3b is silent. -/
theorem nativeWriteCheck_inside (i : Input) : nativeWriteCheck (some none) i = none := rfl

/-- For a tool that is not a native write tool step 3b is silent, whatever the boundary says. -/
theorem nativeWriteCheck_not_write (nw : Option (Option String)) {i : Input}
    (h : i.toolName ∉ nativeWriteTools) : nativeWriteCheck nw i = none := by
  rcases nw with _ | _ | outside
  · rfl
  · rfl
  · simp [nativeWriteCheck, h]

/-- Step 3b returns only for a native write tool, and then it denies with the boundary's
reason. -/
theorem nativeWriteCheck_some {nw : Option (Option String)} {i : Input} {r : Result}
    (h : nativeWriteCheck nw i = some r) :
    ∃ outside, nw = some (some outside) ∧ i.toolName ∈ nativeWriteTools ∧
      r = { decision := .deny, reason := "write-boundary: " ++ outside,
            denyMessage := some outside } := by
  rcases nw with _ | _ | outside
  · simp [nativeWriteCheck] at h
  · simp [nativeWriteCheck] at h
  · by_cases hw : i.toolName ∈ nativeWriteTools
    · simp [nativeWriteCheck, hw] at h
      exact ⟨outside, rfl, hw, h.symm⟩
    · simp [nativeWriteCheck, hw] at h

/-- A native write tool is one of the three names. -/
theorem nativeWriteTools_cases {t : String} (h : t ∈ nativeWriteTools) :
    t = "Write" ∨ t = "Edit" ∨ t = "NotebookEdit" := by
  simpa [nativeWriteTools] using h

/-! ## When step 3b is silent, nothing changes -/

/-- When step 3b is silent the non-admin block is the one without the step. -/
theorem adminExemptGuardsWith_of_silent {nw : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : nativeWriteCheck nw i = none) :
    adminExemptGuardsWith nw inc i = adminExemptGuards inc i := by
  unfold adminExemptGuardsWith adminExemptGuards
  simp only [h]

/-- When step 3b is silent the result is `evaluateToolPolicy`'s. -/
theorem evaluateToolPolicyWith_of_silent {nw : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : nativeWriteCheck nw i = none) :
    evaluateToolPolicyWith nw inc i = evaluateToolPolicy inc i := by
  unfold evaluateToolPolicyWith evaluateToolPolicy
  rw [adminExemptGuardsWith_of_silent h]

/-- Without a boundary the result is `evaluateToolPolicy`'s. -/
theorem evaluateToolPolicyWith_none (inc : Option IncidentReadOnly) (i : Input) :
    evaluateToolPolicyWith none inc i = evaluateToolPolicy inc i :=
  evaluateToolPolicyWith_of_silent (nativeWriteCheck_absent i)

/-- Outside the non-admin block (an admin, no incident context) step 3b never runs. -/
theorem adminExemptGuardsWith_of_exempt {nw : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (ha : ¬(i.isAdmin = false ∨ inc.isSome = true)) :
    adminExemptGuardsWith nw inc i = adminExemptGuards inc i := by
  simp only [adminExemptGuardsWith, adminExemptGuards, ite_eq_right_of_eq_false _ _ (eq_false ha)]

/-! ## When step 3b fires, it decides -/

/-- For a non-admin, or in an incident session, a native write tool whose target the boundary
puts outside is denied by step 3b: no earlier step looks at a native write tool. -/
theorem nativeWrite_denies_outside (outside : String) {inc : Option IncidentReadOnly}
    {i : Input} (ha : i.isAdmin = false ∨ inc.isSome = true)
    (hw : i.toolName ∈ nativeWriteTools) :
    evaluateToolPolicyWith (some (some outside)) inc i =
      { decision := .deny, reason := "write-boundary: " ++ outside,
        denyMessage := some outside } := by
  have ht := nativeWriteTools_cases hw
  have h1 : abortGuard i = none := by
    unfold abortGuard
    rcases ht with h | h | h <;> simp [h]
  have h2 : sshCheck i = none := by
    unfold sshCheck
    rcases ht with h | h | h <;> simp [h]
  have h3 : sensitiveCheck i = none := by
    unfold sensitiveCheck checkSensitiveForTool
    rcases ht with h | h | h <;> simp [h]
  have h4 : nativeWriteCheck (some (some outside)) i =
      some { decision := .deny, reason := "write-boundary: " ++ outside,
             denyMessage := some outside } := by
    simp [nativeWriteCheck, hw]
  have h5 : adminExemptGuardsWith (some (some outside)) inc i =
      some { decision := .deny, reason := "write-boundary: " ++ outside,
             denyMessage := some outside } := by
    simp only [adminExemptGuardsWith, ite_eq_left_of_eq_true _ _ (eq_true ha), h2, h3, h4]
  unfold evaluateToolPolicyWith
  simp only [h1, h5]

/-! ## The invariants of `Spec.lean` -/

/-- (a) Without a boundary nothing changes. -/
theorem nativeWrite_absent_unchanged : NativeWriteAbsentUnchanged evaluateToolPolicyWith :=
  evaluateToolPolicyWith_none

/-- (b) A native write outside the boundary is denied for a non-admin and in an incident session,
in every mode. -/
theorem nativeWrite_denies_outside_spec : NativeWriteDeniesOutside evaluateToolPolicyWith :=
  fun outside _ _ ha hw => nativeWrite_denies_outside outside ha hw

/-- (c) Outside an incident session an admin is decided as without a boundary. -/
theorem nativeWrite_admin_exempt : NativeWriteAdminExempt evaluateToolPolicyWith := by
  intro nw i ha
  have hx : ¬(i.isAdmin = false ∨ (none : Option IncidentReadOnly).isSome = true) := by
    simp [ha]
  unfold evaluate evaluateToolPolicyWith evaluateToolPolicy
  rw [adminExemptGuardsWith_of_exempt hx]

/-- (d) Every tool that is not a native write tool is decided as without a boundary. -/
theorem nativeWrite_only_write_tools : NativeWriteOnlyWriteTools evaluateToolPolicyWith :=
  fun nw _ _ h => evaluateToolPolicyWith_of_silent (nativeWriteCheck_not_write nw h)

/-- (e) A target inside the boundary changes nothing. -/
theorem nativeWrite_inside_unchanged : NativeWriteInsideUnchanged evaluateToolPolicyWith :=
  fun _ i => evaluateToolPolicyWith_of_silent (nativeWriteCheck_inside i)

/-- (f) The boundary only adds denials. -/
theorem nativeWrite_only_adds_denies : NativeWriteOnlyAddsDenies evaluateToolPolicyWith := by
  intro nw inc i
  cases hs : nativeWriteCheck nw i with
  | none => exact .inl (evaluateToolPolicyWith_of_silent hs)
  | some r =>
    obtain ⟨outside, rfl, hw, _⟩ := nativeWriteCheck_some hs
    by_cases ha : i.isAdmin = false ∨ inc.isSome = true
    · exact .inr (by rw [nativeWrite_denies_outside outside ha hw])
    · refine .inl ?_
      unfold evaluateToolPolicyWith evaluateToolPolicy
      rw [adminExemptGuardsWith_of_exempt ha]

end SomaVerify.ToolPolicy
