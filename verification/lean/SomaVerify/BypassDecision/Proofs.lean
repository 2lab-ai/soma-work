import SomaVerify.BypassDecision.ProofsOriginal

/-!
# Proofs about the simplified model

`simplified_eq_original` proves the simplified `bypassBashPermissionDecision` (`Model.lean`, the
current TS) equal to the function as of commit 416b71b7 (`ModelOriginal.lean`) on every catalog
and every disable predicate. Every invariant `ProofsOriginal.lean` proves for the original then
holds for the simplified function through that equality; this file states each one again, under
the same name, for the simplified model.

The legacy helpers (`checkDangerousCommand`, `isDangerousCommand`, `legacyDescriptionFor`) have
no simplified counterpart: the simplification deleted them. Their facts stay in
`ProofsOriginal.lean`, and `no_session_agrees_with_legacy_helpers` below shows that both helpers'
results are still derivable from the function that remains.
-/

namespace SomaVerify.BypassDecision.Proofs

open SomaVerify.BypassDecision SomaVerify.BypassDecision.Spec

/-- The simplified function's single return, which derives the decision from the ids, equals the
two-branch return of `bypassOnIds`: when no id is left, both return the empty list. -/
theorem simplified_eq_on_ids (c : List Rule) (d : String → Bool) :
    bypassBashPermissionDecision c d = bypassOnIds c d := by
  unfold bypassBashPermissionDecision bypassOnIds
  dsimp only
  by_cases h : ((c.filter fun rule => rule.sessionOverridable && rule.matched).map
      fun rule => rule.id).filter (fun ruleId => !d ruleId) = []
  · simp [h]
  · simp [h]

/-- The simplified `bypassBashPermissionDecision` equals the one as of commit 416b71b7 on every
catalog and every disable predicate: the same decision and the same ids in the same order. -/
theorem simplified_eq_original : SimplifiedIsOriginal := by
  intro c d
  rw [simplified_eq_on_ids, OriginalProofs.filtering_ids_is_equivalent]

/-- The same equality, between the two functions: what carries each invariant below over. -/
theorem simplified_eq_original_fun :
    (@bypassBashPermissionDecision : BypassImpl) = @Original.bypassBashPermissionDecision := by
  funext c d
  exact simplified_eq_original c d

/-- Normal form: the decision is `ask` exactly when some rule escalates, and the ids are those
of the escalating rules. -/
theorem bypass_eq (c : List Rule) (d : String → Bool) :
    bypassBashPermissionDecision c d =
      if c.filter (OriginalProofs.escalates d) = [] then { decision := .allow, matchedRuleIds := [] }
      else
        { decision := .ask, matchedRuleIds := (c.filter (OriginalProofs.escalates d)).map Rule.id } := by
  rw [simplified_eq_original]
  exact OriginalProofs.bypass_eq c d

/-- The ids are those of the escalating rules, in catalog order, on `allow` as on `ask`. -/
theorem bypass_matchedRuleIds (c : List Rule) (d : String → Bool) :
    (bypassBashPermissionDecision c d).matchedRuleIds =
      (c.filter (OriginalProofs.escalates d)).map Rule.id := by
  rw [simplified_eq_original]
  exact OriginalProofs.bypass_matchedRuleIds c d

/-- The decision is `allow` exactly when no rule escalates. -/
theorem bypass_decision (c : List Rule) (d : String → Bool) :
    (bypassBashPermissionDecision c d).decision =
      if c.filter (OriginalProofs.escalates d) = [] then .allow else .ask := by
  rw [simplified_eq_original]
  exact OriginalProofs.bypass_decision c d

/-- (a) The decision is `ask` exactly when the catalog holds a rule that is overridable, matches
the command, and is not disabled for the session. -/
theorem ask_iff_some_rule_escalates : AskIffSomeRuleEscalates @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.ask_iff_some_rule_escalates

/-- (b) `matchedRuleIds` lists the ids of exactly the overridable, matching, not-disabled rules,
in catalog order, one entry per rule. -/
theorem matched_ids_are_escalating_ids : MatchedIdsAreEscalatingIds @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.matched_ids_are_escalating_ids

/-- (b) An `allow` never carries rule ids. -/
theorem allow_carries_no_ids : AllowCarriesNoIds @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.allow_carries_no_ids

/-- An `ask` always carries at least one rule id. -/
theorem ask_carries_ids : AskCarriesIds @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.ask_carries_ids

/-- (c) Adding a lockdown rule at any position of the catalog, matching or not and under any id,
does not change the result. -/
theorem lockdown_insertion_irrelevant : LockdownInsertionIrrelevant @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.lockdown_insertion_irrelevant

/-- (c) Replacing a lockdown rule by any other lockdown rule does not change the result. -/
theorem lockdown_change_irrelevant : LockdownChangeIrrelevant @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.lockdown_change_irrelevant

/-- (c) Removing every lockdown rule from the catalog does not change the result. -/
theorem lockdown_removal_irrelevant : LockdownRemovalIrrelevant @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.lockdown_removal_irrelevant

/-- The session's disable predicate matters only on the ids of overridable rules that match the
command: two predicates that agree on those ids give the same result, so disabling a lockdown
rule's id has no effect. -/
theorem disabled_read_only_on_overridable_matches :
    DisabledReadOnlyOnOverridableMatches @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.disabled_read_only_on_overridable_matches

/-- An id that only lockdown rules carry never appears in `matchedRuleIds`. -/
theorem lockdown_id_never_offered : LockdownIdNeverOffered @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.lockdown_id_never_offered

/-- (d) When the session has disabled every overridable rule that matches the command, the
result is `allow` with no ids. -/
theorem silencing_every_match_allows : SilencingEveryMatchAllows @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.silencing_every_match_allows

/-- Disabling more ids only silences: under a larger disable set the ids are a sub-list of those
under a smaller one, and an `ask` under the larger set is an `ask` under the smaller one. -/
theorem disabling_more_only_silences : DisablingMoreOnlySilences @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.disabling_more_only_silences

/-- A command that the deleted `isDangerousCommand` rejected is allowed, whatever the session
disables. -/
theorem non_dangerous_allowed : NonDangerousAllowed @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.non_dangerous_allowed

/-- With the default predicate (no session), the decision is `ask` exactly when the deleted
`isDangerousCommand` held, and the ids are the deleted `checkDangerousCommand`'s ids: both
helpers' results are derivable from the function that remains. -/
theorem no_session_agrees_with_legacy_helpers :
    NoSessionAgreesWithLegacyHelpers @bypassBashPermissionDecision :=
  simplified_eq_original_fun ▸ OriginalProofs.no_session_agrees_with_legacy_helpers

end SomaVerify.BypassDecision.Proofs
