import SomaVerify.ToolPolicy.Proofs

/-!
# The simplified model equals the phase-1 model

Phase 2 simplified `tool-policy.ts` three ways, each justified by a theorem:

* C1: `'ask'` left `ToolPolicyDecision`, since no path returned it (`Original.never_ask`).
  `Decision` has four constructors, and `build-stream-options.ts` lost its `case 'ask'`.
* C3: the bypass and auto native-tool branches became one, with reason `${ctx.mode}: native tool`
  (`modeTier_toOriginal`).
* C4: the ssh, sensitive-path and MCP guards share one `if (!ctx.isAdmin)` block, which moves the
  MCP guard ahead of the cross-user guard. The two never both fire
  (`Original.mcp_or_crossUser_silent`), so the first guard that fires, and with it the whole
  result, is unchanged (`Original.evaluateWith_newOrder`).

`evaluate_toOriginal` is the combined equality: on every input the simplified result is the
phase-1 result, decision, reason, deny message and rule ids alike. `Result.toOriginal` only renames
the four decision constructors and is injective. `transfer` then carries every invariant proved
for the phase-1 model over to this one.
-/

namespace SomaVerify.ToolPolicy

open SomaVerify.JsString

/-! ## The four-way decision inside the phase-1 five-way one -/

/-- A decision of the simplified model, as the phase-1 decision of the same name. -/
def Decision.toOriginal : Decision → Original.Decision
  | .allow => .allow
  | .deny => .deny
  | .classify => .classify
  | .pass => .pass

/-- A result of the simplified model, as a phase-1 result: same reason, deny message and rule
ids. -/
def Result.toOriginal (r : Result) : Original.Result :=
  { decision := r.decision.toOriginal, reason := r.reason, denyMessage := r.denyMessage,
    matchedRuleIds := r.matchedRuleIds }

/-- No simplified decision is `ask`: the constructor is gone. -/
theorem Decision.toOriginal_ne_ask (d : Decision) : d.toOriginal ≠ .ask := by
  cases d <;> decide

/-- Different simplified decisions are different phase-1 decisions. -/
theorem Decision.toOriginal_injective : Function.Injective Decision.toOriginal := by
  intro a b h
  cases a <;> cases b <;> first | rfl | cases h

/-- Different simplified results are different phase-1 results, so an equation between
`toOriginal` images is an equation between the simplified results themselves. -/
theorem Result.toOriginal_injective : Function.Injective Result.toOriginal := by
  intro a b h
  cases a
  cases b
  simp only [Result.toOriginal, Original.Result.mk.injEq] at h
  obtain ⟨hd, hr, hm, hi⟩ := h
  rw [Decision.toOriginal_injective hd, hr, hm, hi]

/-! ## Each step against its phase-1 counterpart -/

/-- The abort guard is unchanged. -/
theorem abortGuard_toOriginal (i : Input) :
    Original.abortGuard i = (abortGuard i).map Result.toOriginal := by
  unfold abortGuard Original.abortGuard
  split <;> simp_all [Result.toOriginal, Decision.toOriginal]

/-- The cross-user guard is unchanged. -/
theorem crossUserGuard_toOriginal (i : Input) :
    Original.crossUserGuard i = (crossUserGuard i).map Result.toOriginal := by
  unfold crossUserGuard Original.crossUserGuard
  split <;> simp_all [Result.toOriginal, Decision.toOriginal]

/-- The PR-issue guard is unchanged. -/
theorem prIssueGuard_toOriginal (i : Input) :
    Original.prIssueGuard i = (prIssueGuard i).map Result.toOriginal := by
  unfold prIssueGuard Original.prIssueGuard
  split
  · split <;> simp_all [Result.toOriginal, Decision.toOriginal]
  · simp_all

/-- For a non-admin, the phase-1 SSH guard is the SSH check of the non-admin block. -/
theorem sshGuard_of_nonadmin {i : Input} (h : i.isAdmin = false) :
    Original.sshGuard i = (sshCheck i).map Result.toOriginal := by
  unfold sshCheck Original.sshGuard
  split <;> simp_all [Result.toOriginal, Decision.toOriginal]

/-- For an admin, the phase-1 SSH guard stays silent. -/
theorem sshGuard_of_admin {i : Input} (h : i.isAdmin = true) : Original.sshGuard i = none := by
  unfold Original.sshGuard
  simp [h]

/-- For a non-admin, the phase-1 sensitive-path guard is the sensitive-path check of the
non-admin block. -/
theorem sensitiveGuard_of_nonadmin {i : Input} (h : i.isAdmin = false) :
    Original.sensitiveGuard i = (sensitiveCheck i).map Result.toOriginal := by
  unfold sensitiveCheck Original.sensitiveGuard
  rw [ite_eq_left h]
  cases checkSensitiveForTool i.toolName i.path i.prims.sensitive with
  | none => rfl
  | some s => cases hs : s.isSensitive <;> simp [Result.toOriginal, Decision.toOriginal]

/-- For an admin, the phase-1 sensitive-path guard stays silent. -/
theorem sensitiveGuard_of_admin {i : Input} (h : i.isAdmin = true) :
    Original.sensitiveGuard i = none := by
  unfold Original.sensitiveGuard
  simp [h]

/-- For a non-admin, the phase-1 MCP guard is the MCP check of the non-admin block. -/
theorem mcpGuard_of_nonadmin {i : Input} (h : i.isAdmin = false) :
    Original.mcpGuard i = (mcpCheck i).map Result.toOriginal := by
  unfold mcpCheck Original.mcpGuard
  by_cases hm : jsStartsWith i.toolName "mcp__" = true
  · cases i.prims.mcpDenied <;> simp [hm, h, Result.toOriginal, Decision.toOriginal]
  · simp [hm]

/-- For an admin, the phase-1 MCP guard stays silent. -/
theorem mcpGuard_of_admin {i : Input} (h : i.isAdmin = true) : Original.mcpGuard i = none := by
  unfold Original.mcpGuard
  simp [h]

/-- C3: the mode tier with one native-tool branch returns the phase-1 result on every input,
reason strings included: `${ctx.mode}: native tool` is `bypass: native tool` in bypass mode and
`auto: native tool` in auto mode. -/
theorem modeTier_toOriginal (i : Input) : Original.modeTier i = (modeTier i).toOriginal := by
  unfold modeTier Original.modeTier
  cases hm : i.mode <;> cases hd : i.prims.bash.decision <;> by_cases hB : i.toolName = "Bash" <;>
    by_cases hn : i.toolName ∈ nativeBypassTools <;>
    simp [hB, hn, Result.toOriginal, Decision.toOriginal, Mode.name]

/-! ## C4: the new order of the deny tier gives the same result -/

/-- Swapping two neighbours of a list does not change the first `some` when at most one of the
two is `some`. -/
theorem findSome?_swap {α β : Type} (f : α → Option β) (l₁ l₂ : List α) (a b : α)
    (h : f a = none ∨ f b = none) :
    (l₁ ++ a :: b :: l₂).findSome? f = (l₁ ++ b :: a :: l₂).findSome? f := by
  induction l₁ with
  | nil =>
    simp only [List.nil_append, List.findSome?]
    rcases h with h | h <;> rw [h]
  | cons x xs ih =>
    simp only [List.cons_append, List.findSome?]
    rw [ih]

namespace Original

/-- The deny tier in the order of the simplified code: abort, then the ssh, sensitive-path and MCP
guards of the non-admin block, then cross-user and PR-issue. -/
def newOrder : List (Input → Option Result) :=
  [abortGuard, sshGuard, sensitiveGuard, mcpGuard, crossUserGuard, prIssueGuard]

/-- The MCP and cross-user guards never both fire: the first needs an `mcp__` tool, the second
the tool `Bash`. -/
theorem mcp_or_crossUser_silent (i : Input) : mcpGuard i = none ∨ crossUserGuard i = none := by
  by_cases hm : mcpGuard i = none
  · exact .inl hm
  · refine .inr ((crossUserGuard_eq_none_iff i).mpr fun h => ?_)
    have hc : McpCond i :=
      Classical.byContradiction fun hn => hm ((mcpGuard_eq_none_iff i).mpr hn)
    exact (ne_of_mcp hc.1).1 h.1

/-- C4: the deny tier run in the new order returns the phase-1 result on every input, the whole
result: decision, reason, deny message and rule ids. The only pair that changed places, MCP and
cross-user, never fires together. -/
theorem evaluateWith_newOrder (i : Input) : evaluateWith newOrder i = evaluate i := by
  rw [← evaluateWith_source_order i]
  unfold evaluateWith newOrder denyTier
  have hswap := findSome?_swap (fun g => g i) [abortGuard, sshGuard, sensitiveGuard] [prIssueGuard]
    mcpGuard crossUserGuard (mcp_or_crossUser_silent i)
  simp only [List.cons_append, List.nil_append] at hswap
  rw [hswap]

end Original

/-! ## The whole function -/

/-- The simplified code is the phase-1 guards in the new order, then the mode tier: the non-admin
block is the ssh, sensitive-path and MCP guards, each silent for admins. -/
theorem evaluate_toOriginal_newOrder (i : Input) :
    (evaluate i).toOriginal = Original.evaluateWith Original.newOrder i := by
  unfold Original.evaluateWith Original.newOrder evaluate evaluateToolPolicy adminExemptGuards
  simp only [List.findSome?]
  rw [abortGuard_toOriginal, crossUserGuard_toOriginal, prIssueGuard_toOriginal,
    modeTier_toOriginal]
  cases ha : i.isAdmin
  · rw [sshGuard_of_nonadmin ha, sensitiveGuard_of_nonadmin ha, mcpGuard_of_nonadmin ha]
    cases abortGuard i <;> cases sshCheck i <;> cases sensitiveCheck i <;> cases mcpCheck i <;>
      cases crossUserGuard i <;> cases prIssueGuard i <;> rfl
  · rw [sshGuard_of_admin ha, sensitiveGuard_of_admin ha, mcpGuard_of_admin ha]
    cases abortGuard i <;> cases crossUserGuard i <;> cases prIssueGuard i <;> rfl

/-- The simplified `evaluateToolPolicy` returns the phase-1 result on every input: the same
decision, reason, deny message and rule ids (C1, C3 and C4 together). -/
theorem evaluate_toOriginal (i : Input) : (evaluate i).toOriginal = Original.evaluate i := by
  rw [evaluate_toOriginal_newOrder, Original.evaluateWith_newOrder]

/-- The two models are the same function. -/
theorem evaluate_toOriginal_funext : (fun i => (evaluate i).toOriginal) = Original.evaluate :=
  funext evaluate_toOriginal

/-- Whatever holds of the phase-1 evaluation function holds of the simplified one. -/
theorem transfer {P : (Input → Original.Result) → Prop} (h : P Original.evaluate) :
    P (fun i => (evaluate i).toOriginal) := by
  rw [evaluate_toOriginal_funext]
  exact h

/-! ## Every phase-1 invariant, for the simplified model

Each statement is the `Spec.lean` statement of the same name, for the simplified model. -/

/-- The simplified deny steps fire exactly under the documented conditions. The three checks of
the non-admin block fire under theirs together with the block's own test, `isAdmin = false`. -/
theorem guard_conditions (i : Input) :
    (abortGuard i ≠ none ↔ Original.AbortCond i) ∧
    (i.isAdmin = false ∧ sshCheck i ≠ none ↔ Original.SshCond i) ∧
    (i.isAdmin = false ∧ sensitiveCheck i ≠ none ↔ Original.SensitiveCond i) ∧
    (i.isAdmin = false ∧ mcpCheck i ≠ none ↔ Original.McpCond i) ∧
    (crossUserGuard i ≠ none ↔ Original.CrossUserCond i) ∧
    (prIssueGuard i ≠ none ↔ Original.PrIssueCond i) := by
  obtain ⟨g1, g2, g3, g4, g5, g6⟩ := Original.guard_conditions i
  rw [abortGuard_toOriginal] at g1
  rw [crossUserGuard_toOriginal] at g4
  rw [prIssueGuard_toOriginal] at g6
  cases ha : i.isAdmin
  · rw [sshGuard_of_nonadmin ha] at g2
    rw [sensitiveGuard_of_nonadmin ha] at g3
    rw [mcpGuard_of_nonadmin ha] at g5
    simp only [ne_eq, Option.map_eq_none_iff] at g1 g2 g3 g4 g5 g6
    simp only [ne_eq, true_and]
    exact ⟨g1, g2, g3, g5, g4, g6⟩
  · rw [sshGuard_of_admin ha] at g2
    rw [sensitiveGuard_of_admin ha] at g3
    rw [mcpGuard_of_admin ha] at g5
    simp only [ne_eq, Option.map_eq_none_iff, not_true_eq_false, false_iff] at g1 g2 g3 g4 g5 g6
    simp only [ne_eq, Bool.true_eq_false, false_and, false_iff]
    exact ⟨g1, g2, g3, g5, g4, g6⟩

/-- (a) A Bash call after abort is denied with the abort reason. -/
theorem abort_denies : Original.AbortDenies (fun i => (evaluate i).toOriginal) :=
  transfer Original.abort_denies

/-- (b) A cross-user Bash call is denied in every mode, for admins and non-admins alike. -/
theorem cross_user_isolation : Original.CrossUserIsolation (fun i => (evaluate i).toOriginal) :=
  transfer Original.cross_user_isolation

/-- (c) A met deny condition gives `deny`. -/
theorem deny_dominance : Original.DenyDominance (fun i => (evaluate i).toOriginal) :=
  transfer Original.deny_dominance

/-- (c) Under a met deny condition the whole result ignores the mode. -/
theorem deny_tier_mode_independent :
    Original.DenyTierModeIndependent (fun i => (evaluate i).toOriginal) :=
  transfer Original.deny_tier_mode_independent

/-- (c) A call is denied exactly when a deny condition holds. -/
theorem deny_exactly : Original.DenyExactly (fun i => (evaluate i).toOriginal) :=
  transfer Original.deny_exactly

/-- The phase-1 deny tier in phase-1 source order still computes the simplified function. -/
theorem evaluateWith_source_order :
    Original.EvaluateWithSourceOrder (fun i => (evaluate i).toOriginal) :=
  transfer Original.evaluateWith_source_order

/-- (d) Any reordering of the deny tier gives the simplified decision. -/
theorem decision_order_invariant :
    Original.DecisionOrderInvariant (fun i => (evaluate i).toOriginal) :=
  transfer Original.decision_order_invariant

/-- (d) Some reordering of the deny tier changes the simplified reason. -/
theorem reason_order_dependent :
    Original.ReasonOrderDependent (fun i => (evaluate i).toOriginal) :=
  transfer Original.reason_order_dependent

/-- (d) Some reordering of the deny tier changes the simplified deny message. -/
theorem denyMessage_order_dependent :
    Original.DenyMessageOrderDependent (fun i => (evaluate i).toOriginal) :=
  transfer Original.denyMessage_order_dependent

/-- (e) Legacy mode never allows, classifies or asks. -/
theorem legacy_never_allows : Original.LegacyNeverAllows (fun i => (evaluate i).toOriginal) :=
  transfer Original.legacy_never_allows

/-- (e) Legacy mode passes every call it does not deny. -/
theorem legacy_passes : Original.LegacyPasses (fun i => (evaluate i).toOriginal) :=
  transfer Original.legacy_passes

/-- (f) `classify` exactly for an auto-mode Bash call that nothing denies and the dangerous-rule
check flags. -/
theorem classify_iff : Original.ClassifyIff (fun i => (evaluate i).toOriginal) :=
  transfer Original.classify_iff

/-- (f) Rule ids exactly on `classify`. -/
theorem matched_rule_ids_only_classify :
    Original.MatchedRuleIdsOnlyClassify (fun i => (evaluate i).toOriginal) :=
  transfer Original.matched_rule_ids_only_classify

/-- (f) A `classify` result carries the matched rule ids and lists them in its reason. -/
theorem classify_carries_rule_ids :
    Original.ClassifyCarriesRuleIds (fun i => (evaluate i).toOriginal) :=
  transfer Original.classify_carries_rule_ids

/-- (g) Being an admin has exactly the effect of clear ssh, sensitive-path and MCP checks. -/
theorem admin_skips_exactly_ssh_sensitive_mcp :
    Original.AdminSkipsExactlySshSensitiveMcp (fun i => (evaluate i).toOriginal) :=
  transfer Original.admin_skips_exactly_ssh_sensitive_mcp

/-- (g) Admins are still denied by the abort, cross-user and PR-issue guards. -/
theorem admin_keeps_abort_cross_user_pr_issue :
    Original.AdminKeepsAbortCrossUserPrIssue (fun i => (evaluate i).toOriginal) :=
  transfer Original.admin_keeps_abort_cross_user_pr_issue

/-- (h) `pass` exactly when nothing denies and the mode is legacy or the tool is neither Bash nor
native. -/
theorem pass_iff : Original.PassIff (fun i => (evaluate i).toOriginal) :=
  transfer Original.pass_iff

/-- (i) No result is `ask`. -/
theorem never_ask : Original.NeverAsk (fun i => (evaluate i).toOriginal) :=
  transfer Original.never_ask

/-- Bypass mode allows every Bash and native-tool call that nothing denies. -/
theorem bypass_allows_governed :
    Original.BypassAllowsGoverned (fun i => (evaluate i).toOriginal) :=
  transfer Original.bypass_allows_governed

/-- Auto mode allows every native-tool call and every unflagged Bash call that nothing denies. -/
theorem auto_allows_non_dangerous :
    Original.AutoAllowsNonDangerous (fun i => (evaluate i).toOriginal) :=
  transfer Original.auto_allows_non_dangerous

/-- A deny message comes only from the PR-issue guard. -/
theorem deny_message_only_pr_issue :
    Original.DenyMessageOnlyPrIssue (fun i => (evaluate i).toOriginal) :=
  transfer Original.deny_message_only_pr_issue

/-- Every non-null MCP deny reason, the empty string included, denies a non-admin `mcp__` call. -/
theorem mcp_deny_reason_denies :
    Original.McpDenyReasonDenies (fun i => (evaluate i).toOriginal) :=
  transfer Original.mcp_deny_reason_denies

/-- The policy has an opinion only on Bash, native-tool and `mcp__` calls. -/
theorem opinion_only_on_matched_tools :
    Original.OpinionOnlyOnMatchedTools (fun i => (evaluate i).toOriginal) :=
  transfer Original.opinion_only_on_matched_tools

/-- The simplified decision reads `command`, `file_path` and `pattern` only through the primitive
values in `prims`. -/
theorem decision_ignores_call_arguments :
    Original.DecisionIgnoresCallArguments (fun i => (evaluate i).toOriginal) :=
  transfer Original.decision_ignores_call_arguments

end SomaVerify.ToolPolicy
