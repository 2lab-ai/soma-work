import SomaVerify.ToolPolicy.Spec

/-!
# Proofs of the `evaluateToolPolicy` invariants

Every statement in `Spec.lean` is proved here for `evaluate`, for all inputs: every tool name, the
`path` property of every tool input, every context, and every combination of primitive values.

The route: each guard fires exactly under its condition and only ever denies
(`denyTier_result`), so `evaluate` is either the denial of the first guard that fires or, when
no deny condition holds, the mode tier's result (`evaluate_cases`). Most invariants then reduce
to a case analysis of `modeTier`.
-/

namespace SomaVerify.ToolPolicy

open SomaVerify.JsString

/-! ## Each guard fires exactly under its condition, and only ever denies -/

/-- The abort guard stays silent exactly when its condition fails. -/
theorem abortGuard_eq_none_iff (i : Input) : abortGuard i = none ↔ ¬AbortCond i := by
  unfold abortGuard AbortCond
  split <;> simp_all

/-- The SSH guard stays silent exactly when its condition fails. -/
theorem sshGuard_eq_none_iff (i : Input) : sshGuard i = none ↔ ¬SshCond i := by
  unfold sshGuard SshCond
  split <;> simp_all

/-- `checkSensitiveForTool` consults the sensitive-path check for Bash, Read, Glob and a Grep with
a non-empty path; a Grep without one gets `{ isSensitive: false }`, any other tool `undefined`. -/
theorem checkSensitiveForTool_eq (t : String) (p : Field) (s : SensitivePathResult) :
    checkSensitiveForTool t p s =
      if t = "Bash" ∨ t = "Read" ∨ t = "Glob" ∨ (t = "Grep" ∧ p.isNonEmptyString = true) then
        some s
      else if t = "Grep" then some { isSensitive := false }
      else none := by
  unfold checkSensitiveForTool
  by_cases hB : t = "Bash"
  · simp [hB]
  · by_cases hR : t = "Read"
    · simp [hR]
    · by_cases hG : t = "Glob"
      · simp [hG]
      · by_cases hP : t = "Grep"
        · by_cases hn : p.isNonEmptyString = true
          · simp [hP, hn]
          · simp [hP, hn]
        · simp [hB, hR, hG, hP]

/-- The sensitive-path guard stays silent exactly when its condition fails. -/
theorem sensitiveGuard_eq_none_iff (i : Input) : sensitiveGuard i = none ↔ ¬SensitiveCond i := by
  unfold sensitiveGuard SensitiveCond
  rw [checkSensitiveForTool_eq]
  by_cases ha : i.isAdmin = false
  · by_cases hc : i.toolName = "Bash" ∨ i.toolName = "Read" ∨ i.toolName = "Glob" ∨
        (i.toolName = "Grep" ∧ i.path.isNonEmptyString = true)
    · by_cases hs : i.prims.sensitive.isSensitive = true
      · simp [ha, hc, hs]
      · simp [ha, hc, hs]
    · have hB : i.toolName ≠ "Bash" := fun h => hc (.inl h)
      have hR : i.toolName ≠ "Read" := fun h => hc (.inr (.inl h))
      have hG : i.toolName ≠ "Glob" := fun h => hc (.inr (.inr (.inl h)))
      by_cases hP : i.toolName = "Grep"
      · have hn : i.path.isNonEmptyString = false := by
          simpa using fun h => hc (.inr (.inr (.inr ⟨hP, h⟩)))
        simp [ha, hP, hn]
      · simp [ha, hB, hR, hG, hP]
  · simp [ha]

/-- The cross-user guard stays silent exactly when its condition fails. -/
theorem crossUserGuard_eq_none_iff (i : Input) : crossUserGuard i = none ↔ ¬CrossUserCond i := by
  unfold crossUserGuard CrossUserCond
  split <;> simp_all

/-- The MCP-permission guard stays silent exactly when its condition fails. -/
theorem mcpGuard_eq_none_iff (i : Input) : mcpGuard i = none ↔ ¬McpCond i := by
  unfold mcpGuard McpCond
  split
  · cases hm : i.prims.mcpDenied <;> simp_all
  · simp_all

/-- The PR-issue guard stays silent exactly when its condition fails. -/
theorem prIssueGuard_eq_none_iff (i : Input) : prIssueGuard i = none ↔ ¬PrIssueCond i := by
  unfold prIssueGuard PrIssueCond
  split
  · split <;> simp_all
  · simp_all

/-- What every guard of the tier returns when it fires: a denial without rule ids. Only the
PR-issue guard can carry a message. -/
theorem denyTier_result {g : Input → Option Result} (hg : g ∈ denyTier) {i : Input} {r : Result}
    (h : g i = some r) :
    r.decision = .deny ∧ r.matchedRuleIds = none ∧ (g ≠ prIssueGuard → r.denyMessage = none) := by
  simp only [denyTier, List.mem_cons, List.not_mem_nil, or_false] at hg
  rcases hg with rfl | rfl | rfl | rfl | rfl | rfl
  · unfold abortGuard at h
    split at h
    · simp only [Option.some.injEq] at h; subst h; simp
    · simp at h
  · unfold sshGuard at h
    split at h
    · simp only [Option.some.injEq] at h; subst h; simp
    · simp at h
  · unfold sensitiveGuard at h
    split at h
    · split at h
      · split at h
        · simp only [Option.some.injEq] at h; subst h; simp
        · simp at h
      · simp at h
    · simp at h
  · unfold crossUserGuard at h
    split at h
    · simp only [Option.some.injEq] at h; subst h; simp
    · simp at h
  · unfold mcpGuard at h
    split at h
    · split at h
      · simp only [Option.some.injEq] at h; subst h; simp
      · simp at h
    · simp at h
  · unfold prIssueGuard at h
    split at h
    · split at h
      · simp only [Option.some.injEq] at h; subst h; simp
      · simp at h
    · simp at h

/-- No guard of the tier fires exactly when no deny condition holds. -/
theorem denyTier_silent_iff (i : Input) : (∀ g ∈ denyTier, g i = none) ↔ ¬DenyCond i := by
  simp only [denyTier, List.mem_cons, List.not_mem_nil, or_false, forall_eq_or_imp, forall_eq,
    abortGuard_eq_none_iff, sshGuard_eq_none_iff, sensitiveGuard_eq_none_iff,
    crossUserGuard_eq_none_iff, mcpGuard_eq_none_iff, prIssueGuard_eq_none_iff, DenyCond, not_or]

/-- The nested early returns of `evaluate` are the deny tier run in source order. -/
theorem evaluate_eq_evaluateWith (i : Input) : evaluate i = evaluateWith denyTier i := by
  unfold evaluate evaluateWith denyTier
  simp only [List.findSome?]
  cases abortGuard i <;> cases sshGuard i <;> cases sensitiveGuard i <;> cases crossUserGuard i <;>
    cases mcpGuard i <;> cases prIssueGuard i <;> rfl


/-! ## `evaluate` is either a guard's denial or the mode tier's result -/

/-- When no guard of the list fires, the mode tier decides. -/
theorem evaluateWith_of_silent {guards : List (Input → Option Result)} {i : Input}
    (h : ∀ g ∈ guards, g i = none) : evaluateWith guards i = modeTier i := by
  unfold evaluateWith
  rw [List.findSome?_eq_none_iff.mpr h]

/-- When some guard of the list fires, the result is the result of a guard of the list. -/
theorem evaluateWith_of_fires {guards : List (Input → Option Result)} {i : Input}
    (h : ∃ g ∈ guards, g i ≠ none) : ∃ g ∈ guards, g i = some (evaluateWith guards i) := by
  obtain ⟨g, hg, hne⟩ := h
  have hsome : (guards.findSome? (fun g => g i)).isSome = true :=
    List.findSome?_isSome_iff.mpr ⟨g, hg, Option.isSome_iff_ne_none.mpr hne⟩
  obtain ⟨r, hr⟩ := Option.isSome_iff_exists.mp hsome
  obtain ⟨l₁, g', l₂, hl, hg'r, _⟩ := List.findSome?_eq_some_iff.mp hr
  refine ⟨g', by rw [hl]; simp, ?_⟩
  unfold evaluateWith
  rw [hr]
  exact hg'r

/-- The result is either the denial of a deny-tier guard (and a deny condition holds) or the
mode tier's result (and none holds). -/
theorem evaluate_cases (i : Input) :
    (DenyCond i ∧ ∃ g ∈ denyTier, g i = some (evaluate i)) ∨
      (¬DenyCond i ∧ evaluate i = modeTier i) := by
  by_cases hc : DenyCond i
  · refine .inl ⟨hc, ?_⟩
    have hfire : ∃ g ∈ denyTier, g i ≠ none := by
      apply Classical.byContradiction
      intro hn
      exact (denyTier_silent_iff i).mp
        (fun g hg => Classical.byContradiction fun hne => hn ⟨g, hg, hne⟩) hc
    rw [evaluate_eq_evaluateWith]
    exact evaluateWith_of_fires hfire
  · refine .inr ⟨hc, ?_⟩
    rw [evaluate_eq_evaluateWith]
    exact evaluateWith_of_silent ((denyTier_silent_iff i).mpr hc)

/-- Without a deny condition, the mode tier decides. -/
theorem evaluate_of_not_denyCond {i : Input} (h : ¬DenyCond i) : evaluate i = modeTier i := by
  rcases evaluate_cases i with ⟨hc, _⟩ | ⟨_, he⟩
  · exact absurd hc h
  · exact he

/-! ## The mode tier -/

/-- The mode tier never denies. -/
theorem modeTier_decision_ne_deny (i : Input) : (modeTier i).decision ≠ .deny := by
  unfold modeTier
  split <;> (repeat' split) <;> simp

/-- The mode tier never asks. -/
theorem modeTier_decision_ne_ask (i : Input) : (modeTier i).decision ≠ .ask := by
  unfold modeTier
  split <;> (repeat' split) <;> simp

/-- The mode tier never sets `denyMessage`. -/
theorem modeTier_denyMessage (i : Input) : (modeTier i).denyMessage = none := by
  unfold modeTier
  split <;> (repeat' split) <;> simp

/-- The mode tier classifies exactly a Bash call in auto mode that the dangerous-rule check
flags. -/
theorem modeTier_classify_iff (i : Input) :
    (modeTier i).decision = .classify ↔
      i.mode = .auto ∧ i.toolName = "Bash" ∧ i.prims.bash.decision = .ask := by
  unfold modeTier
  split <;> (repeat' split) <;> simp_all

/-- The mode tier sets rule ids exactly on `classify`. -/
theorem modeTier_matchedRuleIds_iff (i : Input) :
    (modeTier i).matchedRuleIds ≠ none ↔ (modeTier i).decision = .classify := by
  unfold modeTier
  split <;> (repeat' split) <;> simp

/-- On `classify`, the mode tier returns the matched rule ids and lists them in the reason. -/
theorem modeTier_classify_payload (i : Input) (h : (modeTier i).decision = .classify) :
    (modeTier i).matchedRuleIds = some i.prims.bash.matchedRuleIds ∧
      (modeTier i).reason = "auto-classify: " ++ ",".intercalate i.prims.bash.matchedRuleIds := by
  revert h
  unfold modeTier
  split <;> (repeat' split) <;> simp_all

/-- The mode tier passes exactly in legacy mode or for a tool that is neither Bash nor native. -/
theorem modeTier_pass_iff (i : Input) :
    (modeTier i).decision = .pass ↔ i.mode = .legacy ∨ ¬Governed i.toolName := by
  unfold modeTier Governed
  split <;> (repeat' split) <;> simp_all


/-! ## The invariants of `Spec.lean` -/

/-- Each deny guard fires exactly when its documented condition holds. -/
theorem guard_conditions : GuardConditions := fun i =>
  ⟨by rw [ne_eq, abortGuard_eq_none_iff, Classical.not_not],
   by rw [ne_eq, sshGuard_eq_none_iff, Classical.not_not],
   by rw [ne_eq, sensitiveGuard_eq_none_iff, Classical.not_not],
   by rw [ne_eq, crossUserGuard_eq_none_iff, Classical.not_not],
   by rw [ne_eq, mcpGuard_eq_none_iff, Classical.not_not],
   by rw [ne_eq, prIssueGuard_eq_none_iff, Classical.not_not]⟩

/-- A call is denied exactly when one of the six deny conditions holds: the mode tier never
denies. -/
theorem deny_exactly : DenyExactly := by
  intro i
  rcases evaluate_cases i with ⟨hc, g, hg, he⟩ | ⟨hc, he⟩
  · exact ⟨fun _ => hc, fun _ => (denyTier_result hg he).1⟩
  · rw [he]
    exact ⟨fun hd => absurd hd (modeTier_decision_ne_deny i), fun h => absurd h hc⟩

/-- (c) Deny dominance: when any deny condition holds the decision is `deny`, in every mode. -/
theorem deny_dominance : DenyDominance := fun i h => (deny_exactly i).mpr h

/-- (a) A Bash call after the session was aborted is denied, by the abort guard itself (its
reason is the abort reason). -/
theorem abort_denies : AbortDenies := by
  intro i h
  have hg : abortGuard i = some { decision := .deny, reason := "abort-guard: session aborted" } := by
    unfold abortGuard
    exact ite_eq_left h
  unfold evaluate
  rw [hg]

/-- (b) Cross-user isolation: a Bash call that touches another user's directory is denied in
every mode, for admins and non-admins alike. -/
theorem cross_user_isolation : CrossUserIsolation := by
  intro i h mode isAdmin
  exact deny_dominance _ (.inr (.inr (.inr (.inl h))))

/-- (c) The deny tier does not read the mode: when a deny condition holds, changing the mode
changes nothing in the result, reason included. -/
theorem deny_tier_mode_independent : DenyTierModeIndependent := by
  intro i mode h
  have hf : denyTier.findSome? (fun g => g { i with mode := mode }) =
      denyTier.findSome? (fun g => g i) := rfl
  rw [evaluate_eq_evaluateWith, evaluate_eq_evaluateWith]
  unfold evaluateWith
  rw [hf]
  cases hr : denyTier.findSome? (fun g => g i) with
  | some r => rfl
  | none => exact absurd h ((denyTier_silent_iff i).mp (List.findSome?_eq_none_iff.mp hr))

/-- Running the deny tier in source order is `evaluate`. -/
theorem evaluateWith_source_order : EvaluateWithSourceOrder := fun i =>
  (evaluate_eq_evaluateWith i).symm

/-- (d) Any reordering of the deny tier yields the same decision (the comment at line 130:
"order within the tier is immaterial"). -/
theorem decision_order_invariant : DecisionOrderInvariant := by
  intro guards i hp
  have hmem : ∀ g, g ∈ guards ↔ g ∈ denyTier := fun g => hp.mem_iff
  by_cases hc : DenyCond i
  · have hfire : ∃ g ∈ guards, g i ≠ none := by
      apply Classical.byContradiction
      intro hn
      exact (denyTier_silent_iff i).mp
        (fun g hg => Classical.byContradiction fun hne => hn ⟨g, (hmem g).mpr hg, hne⟩) hc
    obtain ⟨g, hg, he⟩ := evaluateWith_of_fires hfire
    rw [(denyTier_result ((hmem g).mp hg) he).1, deny_exactly i |>.mpr hc]
  · have hs := (denyTier_silent_iff i).mpr hc
    rw [evaluateWith_of_silent (fun g hg => hs g ((hmem g).mp hg)), evaluate_of_not_denyCond hc]

/-- (d) The reason is not order-independent: with two guards swapped, an aborted non-admin
`ssh` Bash call is reported as an SSH ban instead of an abort. -/
theorem reason_order_dependent : ReasonOrderDependent := by
  refine ⟨[sshGuard, abortGuard, sensitiveGuard, crossUserGuard, mcpGuard, prIssueGuard],
    { toolName := "Bash", path := .absent, isAdmin := false, mode := .auto, aborted := true,
      handoff := false,
      prims := { ssh := true, sensitive := { isSensitive := false }, crossUser := false,
                 mcpDenied := none, prIssue := { blocked := false },
                 bash := { decision := .allow, matchedRuleIds := [] } } },
    List.Perm.swap _ _ _, ?_⟩
  decide


/-- (e) Legacy mode never allows, classifies or asks: its only outcomes are `deny` and `pass`. -/
theorem legacy_never_allows : LegacyNeverAllows := by
  intro i hm
  rcases evaluate_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · rw [(denyTier_result hg he).1]
    decide
  · rw [he]
    unfold modeTier
    split <;> simp_all

/-- (e) Legacy mode passes every call it does not deny. -/
theorem legacy_passes : LegacyPasses := by
  intro i hm hc
  rw [evaluate_of_not_denyCond hc]
  unfold modeTier
  split <;> simp_all

/-- (f) `classify` is returned exactly for a Bash call in auto mode that no deny condition stops
and that `bypassBashPermissionDecision` answers with `ask`. -/
theorem classify_iff : ClassifyIff := by
  intro i
  rcases evaluate_cases i with ⟨hc, g, hg, he⟩ | ⟨hc, he⟩
  · rw [(denyTier_result hg he).1]
    simp [hc]
  · rw [he, modeTier_classify_iff]
    simp [hc]

/-- (f) A result carries rule ids exactly when its decision is `classify`. -/
theorem matched_rule_ids_only_classify : MatchedRuleIdsOnlyClassify := by
  intro i
  rcases evaluate_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · have hr := denyTier_result hg he
    simp [hr.1, hr.2.1]
  · rw [he]
    exact modeTier_matchedRuleIds_iff i

/-- (f) A `classify` result carries the rule ids `bypassBashPermissionDecision` matched, and its
reason lists them comma-separated. -/
theorem classify_carries_rule_ids : ClassifyCarriesRuleIds := by
  intro i h
  rcases evaluate_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · rw [(denyTier_result hg he).1] at h
    exact absurd h (by decide)
  · rw [he] at h ⊢
    exact modeTier_classify_payload i h

/-- Two inputs on which every guard and the mode tier agree get the same result. -/
theorem evaluate_congr {i j : Input} (h1 : abortGuard i = abortGuard j)
    (h2 : sshGuard i = sshGuard j) (h3 : sensitiveGuard i = sensitiveGuard j)
    (h4 : crossUserGuard i = crossUserGuard j) (h5 : mcpGuard i = mcpGuard j)
    (h6 : prIssueGuard i = prIssueGuard j) (h7 : modeTier i = modeTier j) :
    evaluate i = evaluate j := by
  unfold evaluate
  rw [h1, h2, h3, h4, h5, h6, h7]

/-- (g) Being an admin has exactly the effect of the ssh, sensitive-path and MCP checks all
coming back clear for a non-admin: those three guards are skipped, nothing else changes. -/
theorem admin_skips_exactly_ssh_sensitive_mcp : AdminSkipsExactlySshSensitiveMcp := by
  intro i
  apply evaluate_congr
  · rfl
  · simp [sshGuard]
  · rw [(sensitiveGuard_eq_none_iff _).mpr (by simp [SensitiveCond]),
      (sensitiveGuard_eq_none_iff _).mpr (by simp [SensitiveCond])]
  · rfl
  · simp [mcpGuard]
  · rfl
  · rfl

/-- (g) Admins are still denied by the abort, cross-user and PR-issue guards. -/
theorem admin_keeps_abort_cross_user_pr_issue : AdminKeepsAbortCrossUserPrIssue := by
  intro i _ h
  apply deny_dominance
  rcases h with h | h | h
  · exact .inl h
  · exact .inr (.inr (.inr (.inl h)))
  · exact .inr (.inr (.inr (.inr (.inr h))))

/-- (h) `pass` (no policy opinion) is returned exactly when nothing denies and either the mode
is legacy or the tool is neither Bash nor a native tool. -/
theorem pass_iff : PassIff := by
  intro i
  rcases evaluate_cases i with ⟨hc, g, hg, he⟩ | ⟨hc, he⟩
  · rw [(denyTier_result hg he).1]
    simp [hc]
  · rw [he, modeTier_pass_iff]
    simp [hc]

/-- (i) `ask` is never returned, although the result type allows it. -/
theorem never_ask : NeverAsk := by
  intro i
  rcases evaluate_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · rw [(denyTier_result hg he).1]
    decide
  · rw [he]
    exact modeTier_decision_ne_ask i

/-- Bypass mode allows every Bash and native-tool call that nothing denies, a dangerous Bash
included. -/
theorem bypass_allows_governed : BypassAllowsGoverned := by
  intro i hm hc hg
  rw [evaluate_of_not_denyCond hc]
  unfold modeTier
  unfold Governed at hg
  split <;> (repeat' split) <;> simp_all

/-- Auto mode allows every native-tool call that nothing denies, and every such Bash call that
`bypassBashPermissionDecision` does not flag. -/
theorem auto_allows_non_dangerous : AutoAllowsNonDangerous := by
  intro i hm hc hg hb
  rw [evaluate_of_not_denyCond hc]
  unfold modeTier
  unfold Governed at hg
  split <;> (repeat' split) <;> simp_all

/-- `denyMessage` is set only by the PR-issue guard: whenever a result has one, it is the
PR-issue guard's own result. -/
theorem deny_message_only_pr_issue : DenyMessageOnlyPrIssue := by
  intro i hmsg
  rcases evaluate_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · by_cases hp : g = prIssueGuard
    · subst hp
      exact he
    · exact absurd ((denyTier_result hg he).2.2 hp) hmsg
  · rw [he] at hmsg
    exact absurd (modeTier_denyMessage i) hmsg

/-- An `mcp__` tool name is none of the tools the Bash-only and sensitive-path guards cover. -/
theorem ne_of_mcp {t : String} (h : jsStartsWith t "mcp__" = true) :
    t ≠ "Bash" ∧ t ≠ "Read" ∧ t ≠ "Glob" ∧ t ≠ "Grep" := by
  refine ⟨?_, ?_, ?_, ?_⟩ <;> (rintro rfl; simp [jsStartsWith] at h)

/-- Every non-null value of `checkMcpToolPermission` denies a non-admin `mcp__` call, with that
value as the reason, the empty string included. -/
theorem mcp_deny_reason_denies : McpDenyReasonDenies := by
  intro i denied hmcp hadm hd
  obtain ⟨hB, hR, hG, hP⟩ := ne_of_mcp hmcp
  have e1 : abortGuard i = none := (abortGuard_eq_none_iff i).mpr fun h => hB h.1
  have e2 : sshGuard i = none := (sshGuard_eq_none_iff i).mpr fun h => hB h.1
  have e3 : sensitiveGuard i = none := (sensitiveGuard_eq_none_iff i).mpr fun h => by
    rcases h.2.2 with h | h | h | h
    · exact hB h
    · exact hR h
    · exact hG h
    · exact hP h.1
  have e4 : crossUserGuard i = none := (crossUserGuard_eq_none_iff i).mpr fun h => hB h.1
  have e5 : mcpGuard i = some { decision := .deny, reason := "mcp-permission: " ++ denied } := by
    simp [mcpGuard, hmcp, hadm, hd]
  unfold evaluate
  rw [e1, e2, e3, e4, e5]

/-- The policy has an opinion only on calls one of `TOOL_POLICY_MATCHERS` covers: Bash, a
native tool, or an `mcp__` tool. -/
theorem opinion_only_on_matched_tools : OpinionOnlyOnMatchedTools := by
  intro i hne
  rcases evaluate_cases i with ⟨hc, _⟩ | ⟨hc, he⟩
  · rcases hc with h | h | h | h | h | h
    · exact .inl h.1
    · exact .inl h.1
    · rcases h.2.2 with h | h | h | h
      · exact .inl h
      · exact .inr (.inl (by rw [h]; decide))
      · exact .inr (.inl (by rw [h]; decide))
      · exact .inr (.inl (by rw [h.1]; decide))
    · exact .inl h.1
    · exact .inr (.inr h.1)
    · rcases h.2.1 with h | h
      · exact .inl h
      · exact .inr (.inr (by rw [h]; decide))
  · rw [he] at hne
    have hg : ¬(i.mode = .legacy ∨ ¬Governed i.toolName) := fun h => hne ((modeTier_pass_iff i).mpr h)
    have hgov : Governed i.toolName := Classical.byContradiction fun h => hg (.inr h)
    rcases hgov with h | h
    · exact .inl h
    · exact .inr (.inl h)

end SomaVerify.ToolPolicy
