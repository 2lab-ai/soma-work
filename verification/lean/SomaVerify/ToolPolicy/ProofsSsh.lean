import SomaVerify.ToolPolicy.ProofsEnvMcp

/-!
# Proofs of phase 8: the ssh ban for everyone, a message per devops-secret reason (env-access WU2)

Proved for `evaluateToolPolicySsh`, for every input: every tool name, tool input, mode, admin flag,
abort and handoff state, native write boundary value, plan check value, incident context, and every
combination of primitive values.

* Step 1b decides as before: its new form returns a value exactly when the old one does
  (`devopsGuardFor_eq_none_iff`), always a deny with the reason as before and the message of that
  reason (`devopsGuardFor_reason`), the old message for every reason but the secret store's and the
  approval records' (`devopsGuardFor_of_other`).
* The ssh ban fires exactly on a Bash call whose command is ssh (`sshGuardAll_eq_none_iff`), and
  then, unless the session was aborted or step 1b fired first, the result is the ban, for admins
  and in incident sessions too (`ssh_denied_for_everyone`).
* The native write boundary holds admins outside an incident session: a refused native write is
  denied with the boundary's reason (`admin_native_write_denied`); the step is silent for non-admins
  and in incident sessions (`adminNativeWriteGuard_of_not_admin_or_incident`), where the earlier block
  already applies it.
* Wherever no change applies the result is `evaluateToolPolicyMcp`'s, the function every earlier
  theorem is about (`evaluateToolPolicySsh_of_silent`).
-/

namespace SomaVerify.ToolPolicy

/-! ## Step 1b with a message per reason -/

/-- The new step 1b returns a value exactly when the old one does. -/
theorem devopsGuardFor_eq_none_iff (i : Input) : devopsGuardFor i = none ↔ devopsGuard i = none := by
  unfold devopsGuardFor devopsGuard
  cases checkDevopsSecretForTool i.toolName i.prims.devopsSecret <;> simp

/-- A reason ends in a deny, with the reason as before and the message of that reason. -/
theorem devopsGuardFor_reason {i : Input} {reason : String}
    (h : checkDevopsSecretForTool i.toolName i.prims.devopsSecret = some reason) :
    devopsGuardFor i =
      some { decision := .deny, reason := "devops-secret: " ++ reason,
             denyMessage := some (devopsSecretDenyMessageFor reason) } := by
  simp [devopsGuardFor, h]

/-- For a reason other than `secret store path` and `approval record` the new step 1b is the old. -/
theorem devopsGuardFor_of_other {i : Input} {reason : String}
    (h : checkDevopsSecretForTool i.toolName i.prims.devopsSecret = some reason)
    (hs : reason ≠ "secret store path") (ha : reason ≠ "approval record") :
    devopsGuardFor i = devopsGuard i := by
  simp [devopsGuardFor, devopsGuard, h, devopsSecretDenyMessageFor, hs, ha]

/-! ## The ssh ban for everyone -/

/-- The ban fires exactly on a Bash call whose command is ssh, whoever makes it. -/
theorem sshGuardAll_eq_none_iff (i : Input) :
    sshGuardAll i = none ↔ ¬(i.toolName = "Bash" ∧ i.prims.ssh = true) := by
  unfold sshGuardAll
  by_cases h : i.toolName = "Bash" ∧ i.prims.ssh = true <;> simp [h]

/-- Every user's Bash ssh is denied, admins and incident sessions included, unless the session was
aborted or step 1b fired first. -/
theorem ssh_denied_for_everyone {nw plan : Option (Option String)} {inc : Option IncidentReadOnly}
    {i : Input} (hb : i.toolName = "Bash") (hs : i.prims.ssh = true) (ha : abortGuard i = none)
    (hd : devopsGuardFor i = none) :
    evaluateToolPolicySsh nw plan inc i =
      { decision := .deny, reason := "ssh-ban: ssh command", denyMessage := some sshBanDenyMessage } := by
  simp [evaluateToolPolicySsh, ha, hd, sshGuardAll, hb, hs]

/-! ## The native write boundary for admins -/

/-- The admin step is silent for every non-admin and in every incident session. -/
theorem adminNativeWriteGuard_of_not_admin_or_incident {nw : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (h : i.isAdmin = false ∨ inc.isSome = true) :
    adminNativeWriteGuard nw inc i = none := by
  unfold adminNativeWriteGuard
  rcases h with h | h
  · simp [h]
  · cases inc <;> simp_all

/-- Outside an incident session, an admin's native write that the session's boundary refuses is
denied with that reason, unless the session was aborted, step 1b fired, or the call was a Bash ssh
(none of which is a native write tool). -/
theorem admin_native_write_denied {plan : Option (Option String)} {i : Input} {outside : String}
    (hadmin : i.isAdmin = true) (htool : i.toolName ∈ nativeWriteTools) (ha : abortGuard i = none)
    (hd : devopsGuardFor i = none) (hs : sshGuardAll i = none) :
    evaluateToolPolicySsh (some (some outside)) plan none i =
      { decision := .deny, reason := "write-boundary: " ++ outside, denyMessage := some outside } := by
  simp [evaluateToolPolicySsh, ha, hd, hs, adminNativeWriteGuard, hadmin, nativeWriteCheck, htool]

/-! ## Where no change applies, nothing changes -/

/-- With the ssh ban and the admin step silent and step 1b giving what it gave before, the result is
`evaluateToolPolicyMcp`'s, decision, reason, deny message and rule ids alike. -/
theorem evaluateToolPolicySsh_of_silent {nw plan : Option (Option String)}
    {inc : Option IncidentReadOnly} {i : Input} (hs : sshGuardAll i = none)
    (hw : adminNativeWriteGuard nw inc i = none) (hd : devopsGuardFor i = devopsGuard i) :
    evaluateToolPolicySsh nw plan inc i = evaluateToolPolicyMcp nw plan inc i := by
  unfold evaluateToolPolicySsh
  rw [hd]
  conv => rhs; unfold evaluateToolPolicyMcp
  cases habort : abortGuard i with
  | some r => rfl
  | none =>
    cases hdev : devopsGuard i with
    | some r => rfl
    | none =>
      simp only [hs, hw]
      unfold evaluateToolPolicyMcp
      simp [habort, hdev]

end SomaVerify.ToolPolicy
