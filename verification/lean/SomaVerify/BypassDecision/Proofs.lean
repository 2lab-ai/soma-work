import SomaVerify.BypassDecision.Spec

/-!
# Proofs of the `BypassDecision` invariants

Every proposition of `Spec.lean` is proved here, against the model in `Model.lean`.

The proofs go through one normal form, `bypass_eq`: the model's two filters fuse into a single
filter by `escalates`, and its first early return is subsumed by the second
(`early_return_redundant`). What remains is a statement about one filtered list.
-/

namespace SomaVerify.BypassDecision.Proofs

open SomaVerify.BypassDecision SomaVerify.BypassDecision.Spec

/-- The model's first filter test: overridable and matching. -/
def overridableMatch (r : Rule) : Bool :=
  r.sessionOverridable && r.matched

/-- The model's two filter tests fused into one: overridable, matching and not disabled. -/
def escalates (isRuleDisabled : String → Bool) (r : Rule) : Bool :=
  r.sessionOverridable && r.matched && !isRuleDisabled r.id

/-- The spec's `OverridableMatch` holds exactly when the model's first filter keeps the rule. -/
theorem decide_overridableMatch (r : Rule) : decide (OverridableMatch r) = overridableMatch r := by
  rcases r with ⟨id, so, m⟩
  cases so <;> cases m <;> rfl

/-- The spec's `Escalates` holds exactly when the fused filter keeps the rule. -/
theorem decide_escalates (d : String → Bool) (r : Rule) :
    decide (Escalates d r) = escalates d r := by
  rcases r with ⟨id, so, m⟩
  cases so <;> cases m <;> simp [escalates]

/-- A lockdown rule never escalates, whatever the session disables. -/
theorem escalates_of_lockdown (d : String → Bool) {r : Rule} (h : r.sessionOverridable = false) :
    escalates d r = false := by
  simp [escalates, h]

/-- Filtering the overridable matches, then the rules the session has not disabled, is filtering
by `escalates` once. -/
theorem fused_filters (c : List Rule) (d : String → Bool) :
    ((c.filter fun rule => rule.sessionOverridable && rule.matched).filter
        fun rule => !d rule.id) = c.filter (escalates d) := by
  rw [List.filter_filter]
  apply List.filter_congr
  intro r _
  exact Bool.and_comm _ _

/-- (f) Deleting the first early return of `bypassBashPermissionDecision`
(src/dangerous-command-filter.ts:114-116) leaves the function unchanged on every catalog and
every disable predicate: when no overridable rule matches, the second filter is empty too and
the second early return yields the same `allow` with no ids. -/
theorem early_return_redundant : EarlyReturnRedundant := by
  intro c d
  unfold bypassWithoutFirstEarlyReturn bypassBashPermissionDecision
  dsimp only
  by_cases h : (c.filter fun rule => rule.sessionOverridable && rule.matched).length = 0
  · rw [List.length_eq_zero_iff] at h
    simp [h]
  · simp only [h, ↓reduceIte]

/-- Normal form: the decision is `ask` exactly when some rule escalates, and the ids are those
of the escalating rules. -/
theorem bypass_eq (c : List Rule) (d : String → Bool) :
    bypassBashPermissionDecision c d =
      if c.filter (escalates d) = [] then { decision := .allow, matchedRuleIds := [] }
      else { decision := .ask, matchedRuleIds := (c.filter (escalates d)).map Rule.id } := by
  rw [← early_return_redundant]
  unfold bypassWithoutFirstEarlyReturn
  dsimp only
  simp only [fused_filters, List.length_eq_zero_iff]

/-- The ids are those of the escalating rules, in catalog order, on `allow` as on `ask`. -/
theorem bypass_matchedRuleIds (c : List Rule) (d : String → Bool) :
    (bypassBashPermissionDecision c d).matchedRuleIds = (c.filter (escalates d)).map Rule.id := by
  rw [bypass_eq]
  split
  · rename_i h
    simp [h]
  · rfl

/-- The decision is `allow` exactly when no rule escalates. -/
theorem bypass_decision (c : List Rule) (d : String → Bool) :
    (bypassBashPermissionDecision c d).decision =
      if c.filter (escalates d) = [] then .allow else .ask := by
  rw [bypass_eq]
  split <;> rfl

/-- (a) The decision is `ask` exactly when the catalog holds a rule that is overridable, matches
the command, and is not disabled for the session. -/
theorem ask_iff_some_rule_escalates : AskIffSomeRuleEscalates := by
  intro c d
  rw [bypass_decision]
  constructor
  · intro h
    split at h
    · cases h
    · rename_i hne
      obtain ⟨r, hr⟩ := List.exists_mem_of_ne_nil _ hne
      rw [List.mem_filter, ← decide_escalates] at hr
      exact ⟨r, hr.1, of_decide_eq_true hr.2⟩
  · rintro ⟨r, hr, he⟩
    have hmem : r ∈ c.filter (escalates d) :=
      List.mem_filter.mpr ⟨hr, by rw [← decide_escalates]; exact decide_eq_true he⟩
    simp [List.ne_nil_of_mem hmem]

/-- (b) `matchedRuleIds` lists the ids of exactly the overridable, matching, not-disabled rules,
in catalog order, one entry per rule. -/
theorem matched_ids_are_escalating_ids : MatchedIdsAreEscalatingIds := by
  intro c d
  rw [bypass_matchedRuleIds]
  congr 1
  apply List.filter_congr
  intro r _
  exact (decide_escalates d r).symm

/-- (b) An `allow` never carries rule ids. -/
theorem allow_carries_no_ids : AllowCarriesNoIds := by
  intro c d h
  rw [bypass_decision] at h
  rw [bypass_matchedRuleIds]
  split at h
  · rename_i hnil
    simp [hnil]
  · cases h

/-- An `ask` always carries at least one rule id, so the "Approve & disable rule for this
session" button always has a rule to disable. -/
theorem ask_carries_ids : AskCarriesIds := by
  intro c d h
  rw [bypass_decision] at h
  rw [bypass_matchedRuleIds]
  split at h
  · cases h
  · rename_i hne
    intro hmap
    exact hne (List.map_eq_nil_iff.mp hmap)

/-- (c) Adding a lockdown rule at any position of the catalog, matching or not and under any id,
does not change the result. -/
theorem lockdown_insertion_irrelevant : LockdownInsertionIrrelevant := by
  intro before after r d h
  have hf : (before ++ r :: after).filter (escalates d) = (before ++ after).filter (escalates d) := by
    simp [List.filter_append, escalates_of_lockdown d h]
  rw [bypass_eq, bypass_eq, hf]

/-- (c) Replacing a lockdown rule by any other lockdown rule does not change the result. -/
theorem lockdown_change_irrelevant : LockdownChangeIrrelevant := by
  intro before after r r' d h h'
  rw [lockdown_insertion_irrelevant before after r d h,
    lockdown_insertion_irrelevant before after r' d h']

/-- (c) Removing every lockdown rule from the catalog does not change the result. -/
theorem lockdown_removal_irrelevant : LockdownRemovalIrrelevant := by
  intro c d
  have hf : (c.filter fun r => r.sessionOverridable).filter (escalates d) = c.filter (escalates d) := by
    rw [List.filter_filter]
    apply List.filter_congr
    intro r _
    rcases r with ⟨id, so, m⟩
    cases so <;> simp [escalates]
  rw [bypass_eq, bypass_eq, hf]

/-- The session's disable predicate matters only on the ids of overridable rules that match the
command: two predicates that agree on those ids give the same result, so disabling a lockdown
rule's id has no effect. -/
theorem disabled_read_only_on_overridable_matches : DisabledReadOnlyOnOverridableMatches := by
  intro c d d' h
  have hf : c.filter (escalates d) = c.filter (escalates d') := by
    apply List.filter_congr
    intro r hr
    have hd := h r hr
    rcases r with ⟨id, so, m⟩
    cases so <;> cases m <;> simp_all [escalates]
  rw [bypass_eq, bypass_eq, hf]

/-- An id that only lockdown rules carry never appears in `matchedRuleIds`, so it is never
offered for disabling. -/
theorem lockdown_id_never_offered : LockdownIdNeverOffered := by
  intro c d x h hx
  rw [bypass_matchedRuleIds, List.mem_map] at hx
  obtain ⟨r, hr, rfl⟩ := hx
  rw [List.mem_filter] at hr
  simp [escalates, h r hr.1 rfl] at hr

/-- (d) When the session has disabled every overridable rule that matches the command, the
result is `allow` with no ids. -/
theorem silencing_every_match_allows : SilencingEveryMatchAllows := by
  intro c d h
  have hnil : c.filter (escalates d) = [] := by
    rw [List.filter_eq_nil_iff]
    intro r hr
    have hd := h r hr
    rcases r with ⟨id, so, m⟩
    cases so <;> cases m <;> simp_all [escalates]
  rw [bypass_eq]
  simp [hnil]

/-- Disabling more ids only silences: under a larger disable set the ids are a sub-list of those
under a smaller one, and an `ask` under the larger set is an `ask` under the smaller one. -/
theorem disabling_more_only_silences : DisablingMoreOnlySilences := by
  intro c d d' h
  have hsub : (c.filter (escalates d')).Sublist (c.filter (escalates d)) := by
    have hf : c.filter (escalates d') = (c.filter (escalates d)).filter (escalates d') := by
      rw [List.filter_filter]
      apply List.filter_congr
      intro r _
      rcases r with ⟨id, so, m⟩
      cases hd' : d' id <;> cases hd : d id <;> simp_all [escalates]
    rw [hf]
    exact List.filter_sublist
  refine ⟨?_, ?_⟩
  · rw [bypass_matchedRuleIds, bypass_matchedRuleIds]
    exact hsub.map _
  · intro hask
    rw [bypass_decision] at hask ⊢
    split at hask
    · cases hask
    · rename_i hne
      have hne' : c.filter (escalates d) ≠ [] := by
        intro hnil
        rw [hnil] at hsub
        exact hne (List.eq_nil_of_sublist_nil hsub)
      simp [hne']

/-- `isDangerousCommand` is `any` of the model's first filter test. -/
theorem is_dangerous_eq (c : List Rule) : isDangerousCommand c = c.any overridableMatch := rfl

/-- `checkDangerousCommand` over the model's first filter test. -/
theorem check_eq (c : List Rule) :
    checkDangerousCommand c =
      { isDangerous := decide ((c.filter overridableMatch).length > 0)
        matchedPatterns := (c.filter overridableMatch).map fun r => legacyDescriptionFor r.id
        matchedRuleIds := (c.filter overridableMatch).map Rule.id } := rfl

/-- No element passes a test exactly when filtering by it leaves nothing. -/
theorem any_eq_false_iff_filter_eq_nil {α : Type} (p : α → Bool) (l : List α) :
    l.any p = false ↔ l.filter p = [] := by
  rw [List.any_eq_false, List.filter_eq_nil_iff]

/-- A command that `isDangerousCommand` rejects is allowed, whatever the session disables. -/
theorem non_dangerous_allowed : NonDangerousAllowed := by
  intro c d h
  rw [is_dangerous_eq, any_eq_false_iff_filter_eq_nil, List.filter_eq_nil_iff] at h
  have hnil : c.filter (escalates d) = [] := by
    rw [List.filter_eq_nil_iff]
    intro r hr
    have hd := h r hr
    rcases r with ⟨id, so, m⟩
    cases so <;> cases m <;> simp_all [escalates, overridableMatch]
  rw [bypass_decision]
  simp [hnil]

/-- With the default predicate (no session), the decision is `ask` exactly when
`isDangerousCommand` holds, and the ids are `checkDangerousCommand`'s ids. -/
theorem no_session_agrees_with_legacy_helpers : NoSessionAgreesWithLegacyHelpers := by
  intro c
  have hf : c.filter (escalates fun _ => false) = c.filter overridableMatch := by
    apply List.filter_congr
    intro r _
    simp [escalates, overridableMatch]
  rw [bypass_eq, hf, is_dangerous_eq, check_eq]
  by_cases h : c.filter overridableMatch = []
  · have hany : c.any overridableMatch = false := (any_eq_false_iff_filter_eq_nil _ _).mpr h
    simp [h, hany]
  · have hany : c.any overridableMatch = true := by
      cases hc : c.any overridableMatch
      · exact absurd ((any_eq_false_iff_filter_eq_nil _ _).mp hc) h
      · rfl
    simp [h, hany]

/-- (e) `isDangerousCommand` returns `checkDangerousCommand`'s `isDangerous`. -/
theorem is_dangerous_agrees_with_check : IsDangerousAgreesWithCheck := by
  intro c
  rw [is_dangerous_eq, check_eq]
  dsimp only
  by_cases h : c.filter overridableMatch = []
  · rw [(any_eq_false_iff_filter_eq_nil _ _).mpr h, h]
    rfl
  · have hpos : (c.filter overridableMatch).length > 0 := List.length_pos_iff.mpr h
    cases hc : c.any overridableMatch
    · exact absurd ((any_eq_false_iff_filter_eq_nil _ _).mp hc) h
    · simp [hpos]

/-- (e) `checkDangerousCommand`'s ids are those of the overridable rules that match, in catalog
order. -/
theorem check_ids_are_overridable_matches : CheckIdsAreOverridableMatches := by
  intro c
  rw [check_eq]
  dsimp only
  congr 1
  apply List.filter_congr
  intro r _
  exact (decide_overridableMatch r).symm

/-- `checkDangerousCommand`'s `matchedPatterns` is the legacy label of each of its ids, in the
same order. -/
theorem check_patterns_label_the_ids : CheckPatternsLabelTheIds := by
  intro c
  rw [check_eq]
  dsimp only
  rw [List.map_map]
  rfl

/-- `isDangerousCommand` holds exactly when an overridable rule matches the command. -/
theorem is_dangerous_iff_overridable_match : IsDangerousIffOverridableMatch := by
  intro c
  rw [is_dangerous_eq, List.any_eq_true]
  constructor
  · rintro ⟨r, hr, hm⟩
    exact ⟨r, hr, by simpa [overridableMatch] using hm⟩
  · rintro ⟨r, hr, hm⟩
    exact ⟨r, hr, by simpa [overridableMatch] using hm⟩

/-- Adding a lockdown rule anywhere changes neither `checkDangerousCommand` nor
`isDangerousCommand`. -/
theorem legacy_helpers_ignore_lockdown : LegacyHelpersIgnoreLockdown := by
  intro before after r h
  have hp : overridableMatch r = false := by simp [overridableMatch, h]
  constructor
  · rw [check_eq, check_eq]
    simp [List.filter_append, hp]
  · rw [is_dangerous_eq, is_dangerous_eq]
    simp [List.any_append, List.any_cons, hp]

/-- An id that is not one of the twelve `legacyDescriptionFor` labels is returned unchanged. -/
theorem unlabelled_id_is_its_own_label : UnlabelledIdIsItsOwnLabel := by
  intro s hs
  simp only [legacyLabelledIds, List.mem_cons, List.not_mem_nil, or_false, not_or] at hs
  unfold legacyDescriptionFor
  split <;> simp_all

/-- Computing the decision on ids (the overridable matches' ids, minus the disabled ones) gives
the same function as filtering rules. -/
theorem filtering_ids_is_equivalent : FilteringIdsIsEquivalent := by
  intro c d
  rw [← early_return_redundant]
  unfold bypassOnIds bypassWithoutFirstEarlyReturn
  dsimp only
  simp only [List.filter_map, List.length_map]
  rfl

end SomaVerify.BypassDecision.Proofs
