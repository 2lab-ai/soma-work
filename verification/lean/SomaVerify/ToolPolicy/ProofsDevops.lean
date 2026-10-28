import SomaVerify.ToolPolicy.Simplification

/-!
# Proofs of the invariants for the phase-3 model, the devops-secret step included

`Simplification.lean` carries every phase-1 invariant over to `evaluate` with the devops-secret
check clear. This file proves them for `evaluate` itself, for all inputs, every value of
`Primitives.devopsSecret` included: every phase-1 statement the step leaves true, unchanged, and the
phase-3 statement (`Spec.lean`, "Phase 3") in place of each one the step makes false of the code.

The route mirrors `Proofs.lean`: step 1b fires exactly under its condition and only ever denies
(`denyTier3_result`), `evaluate` is the seven-guard tier run in source order
(`evaluateWith_denyTier3`), so the result is either the denial of the first guard that fires or,
when no condition of `DenyCond3` holds, the phase-1 mode tier's result (`evaluate3_cases`). Where
step 1b stays silent, or the abort guard returns first, the result is the phase-1 result
(`toOriginal_evaluate_of_devops_silent`).
-/

namespace SomaVerify.ToolPolicy.Original

open SomaVerify.JsString

/-! ## Step 1b fires exactly under its condition, and only ever denies -/

/-- The devops-secret guard stays silent exactly when its condition fails. -/
theorem devopsSecretGuard_eq_none_iff (i : Input) : devopsSecretGuard i = none ↔ ¬DevopsCond i := by
  unfold devopsSecretGuard DevopsCond
  cases h : i.prims.devopsSecret with
  | none => simp
  | some r =>
    by_cases hm : i.toolName ∈ devopsTools
    · have hm' := hm
      simp only [devopsTools, List.mem_cons, List.not_mem_nil, or_false] at hm'
      simp [hm, hm']
    · have hm' := hm
      simp only [devopsTools, List.mem_cons, List.not_mem_nil, or_false] at hm'
      simp [hm, hm']

/-- Step 1b fires exactly when its documented condition holds. -/
theorem devops_guard_condition : DevopsGuardCondition := fun i => by
  rw [ne_eq, devopsSecretGuard_eq_none_iff, Classical.not_not]

/-- What every guard of the seven-guard tier returns when it fires: a denial without rule ids.
Only the PR-issue and devops-secret guards can carry a message. -/
theorem denyTier3_result {g : Input → Option Result} (hg : g ∈ denyTier3) {i : Input}
    {r : Result} (h : g i = some r) :
    r.decision = .deny ∧ r.matchedRuleIds = none ∧
      (g ≠ prIssueGuard → g ≠ devopsSecretGuard → r.denyMessage = none) := by
  by_cases hd : g = devopsSecretGuard
  · subst hd
    unfold devopsSecretGuard at h
    split at h
    · split at h
      · simp only [Option.some.injEq] at h
        subst h
        simp [devopsDenial]
      · simp at h
    · simp at h
  · have hg' : g ∈ denyTier := by
      simp only [denyTier3, List.mem_cons, List.not_mem_nil, or_false] at hg
      simp only [denyTier, List.mem_cons, List.not_mem_nil, or_false]
      rcases hg with h | h | h | h | h | h | h
      · exact .inl h
      · exact absurd h hd
      · exact .inr (.inl h)
      · exact .inr (.inr (.inl h))
      · exact .inr (.inr (.inr (.inl h)))
      · exact .inr (.inr (.inr (.inr (.inl h))))
      · exact .inr (.inr (.inr (.inr (.inr h))))
    obtain ⟨h1, h2, h3⟩ := denyTier_result hg' h
    exact ⟨h1, h2, fun hp _ => h3 hp⟩

/-- No guard of the seven-guard tier fires exactly when no condition of `DenyCond3` holds. -/
theorem denyTier3_silent_iff (i : Input) : (∀ g ∈ denyTier3, g i = none) ↔ ¬DenyCond3 i := by
  simp only [denyTier3, List.mem_cons, List.not_mem_nil, or_false, forall_eq_or_imp, forall_eq,
    abortGuard_eq_none_iff, devopsSecretGuard_eq_none_iff, sshGuard_eq_none_iff,
    sensitiveGuard_eq_none_iff, crossUserGuard_eq_none_iff, mcpGuard_eq_none_iff,
    prIssueGuard_eq_none_iff, DenyCond3, DenyCond, not_or]
  exact ⟨fun ⟨a, d, rest⟩ => ⟨d, a, rest⟩, fun ⟨d, a, rest⟩ => ⟨a, d, rest⟩⟩

/-- Running a list of guards is its first guard, then the rest. -/
theorem evaluateWith_cons (g : Input → Option Result) (gs : List (Input → Option Result))
    (i : Input) :
    evaluateWith (g :: gs) i =
      match g i with
      | some r => r
      | none => evaluateWith gs i := by
  unfold evaluateWith
  simp only [List.findSome?]
  cases g i <;> rfl

/-- The phase-1 guards after the abort guard, in source order. -/
def denyRest : List (Input → Option Result) :=
  [sshGuard, sensitiveGuard, crossUserGuard, mcpGuard, prIssueGuard]

theorem denyTier_eq : denyTier = abortGuard :: denyRest := rfl

theorem denyTier3_eq : denyTier3 = abortGuard :: devopsSecretGuard :: denyRest := rfl

/-- An `mcp__` tool is none of the tools step 1b consults a check for. -/
theorem not_mem_devopsTools_of_mcp {t : String} (h : jsStartsWith t "mcp__" = true) :
    t ∉ devopsTools := by
  simp only [devopsTools, List.mem_cons, List.not_mem_nil, or_false, not_or]
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> (rintro rfl; simp [jsStartsWith] at h)

end SomaVerify.ToolPolicy.Original

namespace SomaVerify.ToolPolicy.Phase3

open SomaVerify SomaVerify.ToolPolicy SomaVerify.JsString

/-! ## The model's step 1b against the phase-1-typed guard -/

/-- The dispatch passes the check's value through for every tool it consults a check for. -/
theorem checkDevopsSecretForTool_of_mem {t : String} (h : t ∈ devopsTools) (v : Option String) :
    checkDevopsSecretForTool t v = v := by
  simp only [devopsTools, List.mem_cons, List.not_mem_nil, or_false] at h
  rcases h with rfl | rfl | rfl | rfl | rfl | rfl <;> simp [checkDevopsSecretForTool]

/-- The dispatch returns nothing for every other tool. -/
theorem checkDevopsSecretForTool_of_not_mem {t : String} (h : t ∉ devopsTools) (v : Option String) :
    checkDevopsSecretForTool t v = none := by
  simp only [devopsTools, List.mem_cons, List.not_mem_nil, or_false, not_or] at h
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := h
  simp [checkDevopsSecretForTool, h1, h2, h3, h4, h5, h6]

/-- The model's step 1b is the phase-1-typed devops-secret guard of `Spec.lean`. -/
theorem devopsSecretGuard_toOriginal (i : Input) :
    Original.devopsSecretGuard i = (devopsGuard i).map Result.toOriginal := by
  unfold Original.devopsSecretGuard devopsGuard
  by_cases hm : i.toolName ∈ devopsTools
  · rw [checkDevopsSecretForTool_of_mem hm]
    cases i.prims.devopsSecret with
    | none => rfl
    | some r => simp [hm, Original.devopsDenial, Result.toOriginal, Decision.toOriginal]
  · rw [checkDevopsSecretForTool_of_not_mem hm]
    cases i.prims.devopsSecret with
    | none => rfl
    | some r => simp [hm]

/-- The model's step 1b fires exactly under the documented condition. -/
theorem devops_guard_conditions (i : Input) : devopsGuard i ≠ none ↔ Original.DevopsCond i := by
  rw [← Original.devops_guard_condition i, devopsSecretGuard_toOriginal, ne_eq, ne_eq,
    Option.map_eq_none_iff]

/-! ## `evaluate` is the seven-guard tier in source order -/

/-- `evaluate` is the seven-guard tier run in source order, then the phase-1 mode tier. -/
theorem evaluateWith_denyTier3 (i : Input) :
    Original.evaluateWith Original.denyTier3 i = (evaluate i).toOriginal := by
  have hrest : (evaluate i.clearDevops).toOriginal =
      match Original.abortGuard i with
      | some r => r
      | none => Original.evaluateWith Original.denyRest i := by
    rw [evaluate_clearDevops_toOriginal, Original.evaluate_eq_evaluateWith, Original.denyTier_eq,
      Original.evaluateWith_cons]
  rw [Original.denyTier3_eq, Original.evaluateWith_cons Original.abortGuard,
    Original.evaluateWith_cons Original.devopsSecretGuard, evaluate_eq_devops,
    abortGuard_toOriginal, devopsSecretGuard_toOriginal]
  cases ha : abortGuard i with
  | some r => rfl
  | none =>
    cases hd : devopsGuard i with
    | some r => rfl
    | none =>
      show Original.evaluateWith Original.denyRest i = (evaluate i.clearDevops).toOriginal
      rw [hrest, abortGuard_toOriginal, ha]
      rfl

/-- `evaluate` with step 1b silent is the phase-1 result. -/
theorem toOriginal_evaluate_of_devops_silent {i : Input}
    (h : Original.devopsSecretGuard i = none) : (evaluate i).toOriginal = Original.evaluate i := by
  rw [← evaluateWith_denyTier3, Original.evaluate_eq_evaluateWith, Original.denyTier3_eq,
    Original.denyTier_eq,
    Original.evaluateWith_cons Original.abortGuard (Original.devopsSecretGuard :: Original.denyRest),
    Original.evaluateWith_cons Original.devopsSecretGuard,
    Original.evaluateWith_cons Original.abortGuard Original.denyRest, h]

/-- When the abort guard returns, `evaluate` returns the phase-1 result, its own. -/
theorem toOriginal_evaluate_of_abort {i : Input} (h : Original.AbortCond i) :
    (evaluate i).toOriginal = Original.evaluate i := by
  have ha : Original.abortGuard i = some { decision := .deny, reason := "abort-guard: session aborted" } := by
    unfold Original.abortGuard
    exact ite_eq_left h
  rw [← evaluateWith_denyTier3, Original.evaluate_eq_evaluateWith, Original.denyTier3_eq,
    Original.denyTier_eq,
    Original.evaluateWith_cons Original.abortGuard (Original.devopsSecretGuard :: Original.denyRest),
    Original.evaluateWith_cons Original.abortGuard Original.denyRest, ha]

/-- `evaluate` differs from the phase-1 model only where step 1b returns: unless its condition
holds and the abort guard has not returned first, the result is the phase-1 result. -/
theorem toOriginal_evaluate_eq_original {i : Input}
    (h : ¬(Original.DevopsCond i ∧ ¬Original.AbortCond i)) :
    (evaluate i).toOriginal = Original.evaluate i := by
  by_cases ha : Original.AbortCond i
  · exact toOriginal_evaluate_of_abort ha
  · have hd : ¬Original.DevopsCond i := fun hd => h ⟨hd, ha⟩
    exact toOriginal_evaluate_of_devops_silent ((Original.devopsSecretGuard_eq_none_iff i).mpr hd)

/-- The result is either the denial of a guard of the seven-guard tier (and a condition of
`DenyCond3` holds) or the phase-1 mode tier's result (and none holds). -/
theorem evaluate3_cases (i : Input) :
    (Original.DenyCond3 i ∧ ∃ g ∈ Original.denyTier3, g i = some ((evaluate i).toOriginal)) ∨
      (¬Original.DenyCond3 i ∧ (evaluate i).toOriginal = Original.modeTier i) := by
  rw [← evaluateWith_denyTier3]
  by_cases hc : Original.DenyCond3 i
  · refine .inl ⟨hc, ?_⟩
    have hfire : ∃ g ∈ Original.denyTier3, g i ≠ none := by
      apply Classical.byContradiction
      intro hn
      exact (Original.denyTier3_silent_iff i).mp
        (fun g hg => Classical.byContradiction fun hne => hn ⟨g, hg, hne⟩) hc
    exact Original.evaluateWith_of_fires hfire
  · exact .inr ⟨hc, Original.evaluateWith_of_silent ((Original.denyTier3_silent_iff i).mpr hc)⟩

/-- Without a condition of `DenyCond3`, the phase-1 mode tier decides. -/
theorem evaluate3_of_not_denyCond3 {i : Input} (h : ¬Original.DenyCond3 i) :
    (evaluate i).toOriginal = Original.modeTier i := by
  rcases evaluate3_cases i with ⟨hc, _⟩ | ⟨_, he⟩
  · exact absurd hc h
  · exact he

/-- Two inputs on which every guard of the seven-guard tier and the mode tier agree get the same
result. -/
theorem evaluate3_congr {i j : Input} (h1 : Original.abortGuard i = Original.abortGuard j)
    (h1b : Original.devopsSecretGuard i = Original.devopsSecretGuard j)
    (h2 : Original.sshGuard i = Original.sshGuard j)
    (h3 : Original.sensitiveGuard i = Original.sensitiveGuard j)
    (h4 : Original.crossUserGuard i = Original.crossUserGuard j)
    (h5 : Original.mcpGuard i = Original.mcpGuard j)
    (h6 : Original.prIssueGuard i = Original.prIssueGuard j)
    (h7 : Original.modeTier i = Original.modeTier j) :
    (evaluate i).toOriginal = (evaluate j).toOriginal := by
  rw [← evaluateWith_denyTier3, ← evaluateWith_denyTier3]
  unfold Original.evaluateWith Original.denyTier3
  simp only [List.findSome?]
  rw [h1, h1b, h2, h3, h4, h5, h6, h7]

/-! ## The phase-3 statements of `Spec.lean` -/

/-- A call is denied exactly when one of the seven deny conditions holds. -/
theorem deny_exactly3 : Original.DenyExactly3 (fun i => (evaluate i).toOriginal) := by
  intro i
  dsimp only
  rcases evaluate3_cases i with ⟨hc, g, hg, he⟩ | ⟨hc, he⟩
  · exact ⟨fun _ => hc, fun _ => (Original.denyTier3_result hg he).1⟩
  · rw [he]
    exact ⟨fun hd => absurd hd (Original.modeTier_decision_ne_deny i), fun h => absurd h hc⟩

/-- Any of the seven deny conditions gives `deny`, in every mode. -/
theorem deny_dominance3 : Original.DenyDominance3 (fun i => (evaluate i).toOriginal) :=
  fun i h => (deny_exactly3 i).mpr h

/-- A met devops-secret condition denies in every mode, for admins and non-admins alike. -/
theorem devops_isolation : Original.DevopsIsolation (fun i => (evaluate i).toOriginal) :=
  fun _ h _ _ => deny_dominance3 _ (.inl h)

/-- When the abort guard has not returned, a devops-secret reason is the result: that reason and
the deny message. -/
theorem devops_denies : Original.DevopsDenies (fun i => (evaluate i).toOriginal) := by
  intro i reason ha hm hr
  dsimp only
  rw [← evaluateWith_denyTier3, Original.denyTier3_eq,
    Original.evaluateWith_cons Original.abortGuard,
    Original.evaluateWith_cons Original.devopsSecretGuard, (Original.abortGuard_eq_none_iff i).mpr ha]
  simp [Original.devopsSecretGuard, hr, hm]

/-- Under any of the seven deny conditions the whole result ignores the mode. -/
theorem deny_tier_mode_independent3 :
    Original.DenyTierModeIndependent3 (fun i => (evaluate i).toOriginal) := by
  intro i mode h
  dsimp only
  rw [← evaluateWith_denyTier3, ← evaluateWith_denyTier3]
  have hf : Original.denyTier3.findSome? (fun g => g { i with mode := mode }) =
      Original.denyTier3.findSome? (fun g => g i) := rfl
  unfold Original.evaluateWith
  rw [hf]
  cases hr : Original.denyTier3.findSome? (fun g => g i) with
  | some r => rfl
  | none =>
    exact absurd h ((Original.denyTier3_silent_iff i).mp (List.findSome?_eq_none_iff.mp hr))

/-- Running the seven-guard tier in source order is `evaluate`. -/
theorem evaluateWith_source_order3 :
    Original.EvaluateWithSourceOrder3 (fun i => (evaluate i).toOriginal) :=
  evaluateWith_denyTier3

/-- Any reordering of the seven-guard tier yields the same decision. -/
theorem decision_order_invariant3 :
    Original.DecisionOrderInvariant3 (fun i => (evaluate i).toOriginal) := by
  intro guards i hp
  dsimp only
  have hmem : ∀ g, g ∈ guards ↔ g ∈ Original.denyTier3 := fun g => hp.mem_iff
  by_cases hc : Original.DenyCond3 i
  · have hfire : ∃ g ∈ guards, g i ≠ none := by
      apply Classical.byContradiction
      intro hn
      exact (Original.denyTier3_silent_iff i).mp
        (fun g hg => Classical.byContradiction fun hne => hn ⟨g, (hmem g).mpr hg, hne⟩) hc
    obtain ⟨g, hg, he⟩ := Original.evaluateWith_of_fires hfire
    rw [(Original.denyTier3_result ((hmem g).mp hg) he).1, (deny_exactly3 i).mpr hc]
  · have hs := (Original.denyTier3_silent_iff i).mpr hc
    rw [Original.evaluateWith_of_silent (fun g hg => hs g ((hmem g).mp hg)),
      evaluate3_of_not_denyCond3 hc]

/-- An aborted Bash call whose devops-secret check returns a reason, as a non-admin outside a
handoff: in source order an abort denial with no message; with step 1b moved first, the
devops-secret denial with its message. -/
def abortedDevopsBash : Input :=
  { toolName := "Bash", command := .str "gh auth token", filePath := .absent, pattern := .absent,
    path := .absent, isAdmin := false, mode := .bypass, aborted := true, handoff := false,
    prims := { ssh := false, sensitive := { isSensitive := false }, crossUser := false,
               mcpDenied := none, prIssue := { blocked := false },
               bash := { decision := .allow, matchedRuleIds := [] },
               devopsSecret := some "gh auth token" } }

/-- The reason depends on the order: swapping the abort guard and step 1b reports the call as a
devops-secret denial instead of an abort. -/
theorem reason_order_dependent3 :
    Original.ReasonOrderDependent3 (fun i => (evaluate i).toOriginal) := by
  refine ⟨[Original.devopsSecretGuard, Original.abortGuard, Original.sshGuard,
    Original.sensitiveGuard, Original.crossUserGuard, Original.mcpGuard, Original.prIssueGuard],
    abortedDevopsBash, List.Perm.swap _ _ _, ?_⟩
  decide

/-- The deny message depends on the order as well, for the same call. -/
theorem denyMessage_order_dependent3 :
    Original.DenyMessageOrderDependent3 (fun i => (evaluate i).toOriginal) := by
  refine ⟨[Original.devopsSecretGuard, Original.abortGuard, Original.sshGuard,
    Original.sensitiveGuard, Original.crossUserGuard, Original.mcpGuard, Original.prIssueGuard],
    abortedDevopsBash, List.Perm.swap _ _ _, ?_⟩
  decide

/-- Legacy mode passes every call that none of the seven guards denies. -/
theorem legacy_passes3 : Original.LegacyPasses3 (fun i => (evaluate i).toOriginal) := by
  intro i hm hc
  dsimp only
  rw [evaluate3_of_not_denyCond3 hc]
  unfold Original.modeTier
  split <;> simp_all

/-- `classify` exactly for an auto-mode Bash call that none of the seven guards denies and the
dangerous-rule check flags. -/
theorem classify_iff3 : Original.ClassifyIff3 (fun i => (evaluate i).toOriginal) := by
  intro i
  dsimp only
  rcases evaluate3_cases i with ⟨hc, g, hg, he⟩ | ⟨hc, he⟩
  · rw [(Original.denyTier3_result hg he).1]
    simp [hc]
  · rw [he, Original.modeTier_classify_iff]
    simp [hc]

/-- Admins are still denied by the abort, devops-secret, cross-user and PR-issue guards. -/
theorem admin_keeps_abort_devops_cross_user_pr_issue :
    Original.AdminKeepsAbortDevopsCrossUserPrIssue (fun i => (evaluate i).toOriginal) := by
  intro _i _ h
  apply deny_dominance3
  rcases h with h | h | h | h
  · exact .inr (.inl h)
  · exact .inl h
  · exact .inr (.inr (.inr (.inr (.inl h))))
  · exact .inr (.inr (.inr (.inr (.inr (.inr h)))))

/-- `pass` exactly when none of the seven guards denies and the mode is legacy or the tool is
neither Bash nor native. -/
theorem pass_iff3 : Original.PassIff3 (fun i => (evaluate i).toOriginal) := by
  intro i
  dsimp only
  rcases evaluate3_cases i with ⟨hc, g, hg, he⟩ | ⟨hc, he⟩
  · rw [(Original.denyTier3_result hg he).1]
    simp [hc]
  · rw [he, Original.modeTier_pass_iff]
    simp [hc]

/-- Bypass mode allows every Bash and native-tool call that none of the seven guards denies. -/
theorem bypass_allows_governed3 :
    Original.BypassAllowsGoverned3 (fun i => (evaluate i).toOriginal) := by
  intro i hm hc hg
  dsimp only
  rw [evaluate3_of_not_denyCond3 hc]
  unfold Original.modeTier
  unfold Original.Governed at hg
  split <;> (repeat' split) <;> simp_all

/-- Auto mode allows every native-tool call and every unflagged Bash call that none of the seven
guards denies. -/
theorem auto_allows_non_dangerous3 :
    Original.AutoAllowsNonDangerous3 (fun i => (evaluate i).toOriginal) := by
  intro i hm hc hg hb
  dsimp only
  rw [evaluate3_of_not_denyCond3 hc]
  unfold Original.modeTier
  unfold Original.Governed at hg
  split <;> (repeat' split) <;> simp_all

/-- A deny message comes only from the PR-issue or the devops-secret guard. -/
theorem deny_message_only_pr_issue_or_devops :
    Original.DenyMessageOnlyPrIssueOrDevops (fun i => (evaluate i).toOriginal) := by
  intro i hmsg
  dsimp only at hmsg ⊢
  rcases evaluate3_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · by_cases hp : g = Original.prIssueGuard
    · subst hp
      exact .inl he
    · by_cases hd : g = Original.devopsSecretGuard
      · subst hd
        exact .inr he
      · exact absurd ((Original.denyTier3_result hg he).2.2 hp hd) hmsg
  · rw [he] at hmsg
    exact absurd (Original.modeTier_denyMessage i) hmsg

/-! ## The phase-1 statements step 1b leaves true, for `evaluate` itself -/

/-- The phase-1 guards fire exactly under their documented conditions (the steps are unchanged). -/
theorem guard_conditions (i : Input) :
    (abortGuard i ≠ none ↔ Original.AbortCond i) ∧
    (devopsGuard i ≠ none ↔ Original.DevopsCond i) ∧
    (i.isAdmin = false ∧ sshCheck i ≠ none ↔ Original.SshCond i) ∧
    (i.isAdmin = false ∧ sensitiveCheck i ≠ none ↔ Original.SensitiveCond i) ∧
    (i.isAdmin = false ∧ mcpCheck i ≠ none ↔ Original.McpCond i) ∧
    (crossUserGuard i ≠ none ↔ Original.CrossUserCond i) ∧
    (prIssueGuard i ≠ none ↔ Original.PrIssueCond i) := by
  obtain ⟨g1, g2, g3, g4, g5, g6⟩ := SomaVerify.ToolPolicy.guard_conditions i
  exact ⟨g1, devops_guard_conditions i, g2, g3, g4, g5, g6⟩

/-- (a) A Bash call after abort is denied with the abort reason. -/
theorem abort_denies : Original.AbortDenies (fun i => (evaluate i).toOriginal) := by
  intro i h
  dsimp only
  rw [toOriginal_evaluate_of_abort h]
  exact Original.abort_denies i h

/-- (b) A cross-user Bash call is denied in every mode, for admins and non-admins alike. -/
theorem cross_user_isolation : Original.CrossUserIsolation (fun i => (evaluate i).toOriginal) :=
  fun _ h _ _ => deny_dominance3 _ (.inr (.inr (.inr (.inr (.inl h)))))

/-- (c) A met phase-1 deny condition gives `deny`. -/
theorem deny_dominance : Original.DenyDominance (fun i => (evaluate i).toOriginal) :=
  fun i h => deny_dominance3 i (.inr h)

/-- (c) Under a met phase-1 deny condition the whole result ignores the mode. -/
theorem deny_tier_mode_independent :
    Original.DenyTierModeIndependent (fun i => (evaluate i).toOriginal) :=
  fun i mode h => deny_tier_mode_independent3 i mode (.inr h)

/-- (e) Legacy mode never allows, classifies or asks. -/
theorem legacy_never_allows : Original.LegacyNeverAllows (fun i => (evaluate i).toOriginal) := by
  intro i hm
  dsimp only
  rcases evaluate3_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · rw [(Original.denyTier3_result hg he).1]
    decide
  · rw [he]
    unfold Original.modeTier
    split <;> simp_all

/-- (f) Rule ids exactly on `classify`. -/
theorem matched_rule_ids_only_classify :
    Original.MatchedRuleIdsOnlyClassify (fun i => (evaluate i).toOriginal) := by
  intro i
  dsimp only
  rcases evaluate3_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · have hr := Original.denyTier3_result hg he
    simp [hr.1, hr.2.1]
  · rw [he]
    exact Original.modeTier_matchedRuleIds_iff i

/-- (f) A `classify` result carries the matched rule ids and lists them in its reason. -/
theorem classify_carries_rule_ids :
    Original.ClassifyCarriesRuleIds (fun i => (evaluate i).toOriginal) := by
  intro i h
  dsimp only at h ⊢
  rcases evaluate3_cases i with ⟨_, g, hg, he⟩ | ⟨_, he⟩
  · rw [(Original.denyTier3_result hg he).1] at h
    exact absurd h (by decide)
  · rw [he] at h ⊢
    exact Original.modeTier_classify_payload i h

/-- (g) Being an admin has exactly the effect of clear ssh, sensitive-path and MCP checks: step 1b
reads no admin flag. -/
theorem admin_skips_exactly_ssh_sensitive_mcp :
    Original.AdminSkipsExactlySshSensitiveMcp (fun i => (evaluate i).toOriginal) := by
  intro i
  dsimp only
  apply evaluate3_congr
  · rfl
  · rfl
  · simp [Original.sshGuard]
  · rw [(Original.sensitiveGuard_eq_none_iff _).mpr (by simp [Original.SensitiveCond]),
      (Original.sensitiveGuard_eq_none_iff _).mpr (by simp [Original.SensitiveCond])]
  · rfl
  · simp [Original.mcpGuard]
  · rfl
  · rfl

/-- (g) Admins are still denied by the abort, cross-user and PR-issue guards. -/
theorem admin_keeps_abort_cross_user_pr_issue :
    Original.AdminKeepsAbortCrossUserPrIssue (fun i => (evaluate i).toOriginal) := by
  intro i ha h
  apply admin_keeps_abort_devops_cross_user_pr_issue i ha
  rcases h with h | h | h
  · exact .inl h
  · exact .inr (.inr (.inl h))
  · exact .inr (.inr (.inr h))

/-- (i) No result is `ask`. -/
theorem never_ask : Original.NeverAsk (fun i => (evaluate i).toOriginal) :=
  fun i => Decision.toOriginal_ne_ask (evaluate i).decision

/-- Every non-null MCP deny reason, the empty string included, denies a non-admin `mcp__` call:
step 1b never consults a check for an `mcp__` tool. -/
theorem mcp_deny_reason_denies :
    Original.McpDenyReasonDenies (fun i => (evaluate i).toOriginal) := by
  intro i denied hmcp hadm hd
  dsimp only
  have hs : Original.devopsSecretGuard i = none := by
    unfold Original.devopsSecretGuard
    cases i.prims.devopsSecret with
    | none => rfl
    | some r => simp [Original.not_mem_devopsTools_of_mcp hmcp]
  rw [toOriginal_evaluate_of_devops_silent hs]
  exact Original.mcp_deny_reason_denies i denied hmcp hadm hd

/-- The policy has an opinion only on Bash, native-tool and `mcp__` calls: the tools step 1b
consults a check for are Bash and native tools. -/
theorem opinion_only_on_matched_tools :
    Original.OpinionOnlyOnMatchedTools (fun i => (evaluate i).toOriginal) := by
  intro i hne
  dsimp only at hne
  by_cases hd : Original.DevopsCond i
  · rcases hd.1 with h | h | h | h | h | h
    · exact .inl h
    all_goals exact .inr (.inl (by rw [h]; decide))
  · rw [toOriginal_evaluate_eq_original (fun h => hd h.1)] at hne
    exact Original.opinion_only_on_matched_tools i hne

/-- `command`, `file_path` and `pattern` reach the decision only through the primitive values in
`prims`, the devops-secret value included. -/
theorem decision_ignores_call_arguments :
    Original.DecisionIgnoresCallArguments (fun i => (evaluate i).toOriginal) :=
  fun _ _ _ _ => rfl

end SomaVerify.ToolPolicy.Phase3
