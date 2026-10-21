import SomaVerify.BypassDecision.Model
import SomaVerify.BypassDecision.ModelOriginal

/-!
# Documented invariants of `src/dangerous-command-filter.ts`

Each proposition restates, over a model, a sentence from the TS source, quoted above it with its
`path:line`. They say which catalog entries decide the result, never how a model computes it, so
a proof shows that the TS structure implements the sentence.

The `bypassBashPermissionDecision` invariants take the implementation as an argument
(`BypassImpl`). `ProofsOriginal.lean` proves them for the model of the file as of commit 416b71b7
(`ModelOriginal.lean`), `Proofs.lean` for the simplified model of the current file
(`Model.lean`). Quotes marked `@416b71b7` are from the file before the simplification, where the
deleted legacy helpers lived; the others are from the current file.

The last section states the equalities that justify the simplification.
-/

namespace SomaVerify.BypassDecision.Spec

open SomaVerify.BypassDecision

/-- An overridable rule whose matcher fired on the command. -/
abbrev OverridableMatch (r : Rule) : Prop :=
  r.sessionOverridable = true ∧ r.matched = true

/-- A rule that escalates the command: an overridable match whose id the session has not
disabled. -/
abbrev Escalates (isRuleDisabled : String → Bool) (r : Rule) : Prop :=
  OverridableMatch r ∧ isRuleDisabled r.id = false

/-- The labels the deleted `legacyDescriptionFor` knew, i.e. its `case` labels
(src/dangerous-command-filter.ts@416b71b7:144-166). -/
def legacyLabelledIds : List String :=
  ["kill", "pkill", "killall", "rm-recursive", "rm-force", "rm-force-long", "shutdown", "reboot",
    "halt", "mkfs", "dd-if", "chmod-world-recursive"]

/-- An implementation of `bypassBashPermissionDecision` over the abstract catalog. Both
`@bypassBashPermissionDecision` (current file) and `@Original.bypassBashPermissionDecision`
(commit 416b71b7) are one; the `@` passes the disable predicate explicitly. -/
abbrev BypassImpl : Type :=
  List Rule → (String → Bool) → BypassBashPermissionResult

/-! ## `bypassBashPermissionDecision` -/

/-- (a) src/dangerous-command-filter.ts:52-53 "Returns 'allow' for non-dangerous commands, 'ask'
for dangerous ones (subject to the session-scoped disable set)." with :69 "Only overridable rules
participate in bypass escalation." -/
def AskIffSomeRuleEscalates (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypass catalog isRuleDisabled).decision = .ask ↔
      ∃ r ∈ catalog, Escalates isRuleDisabled r

/-- (b) src/dangerous-command-filter.ts:39 "`matchedRuleIds`: overridable rules that are
currently *active* (not session-disabled)." — the ids of exactly the escalating rules, in catalog
order, one per rule. -/
def MatchedIdsAreEscalatingIds (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypass catalog isRuleDisabled).matchedRuleIds =
      (catalog.filter fun r => decide (Escalates isRuleDisabled r)).map Rule.id

/-- (b) src/dangerous-command-filter.ts:40 "Empty when decision is 'allow'" -/
def AllowCarriesNoIds (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypass catalog isRuleDisabled).decision = .allow →
      (bypass catalog isRuleDisabled).matchedRuleIds = []

/-- src/dangerous-command-filter.ts:40 "non-empty when it is 'ask'" -/
def AskCarriesIds (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypass catalog isRuleDisabled).decision = .ask →
      (bypass catalog isRuleDisabled).matchedRuleIds ≠ []

/-- (c) src/dangerous-command-filter.ts:69-71 "Only overridable rules participate in bypass
escalation. Lockdown rules (cross-user, ssh) have their own enforcement paths and must not be
silenced here" — adding a lockdown rule anywhere, matching or not, under any id, changes
nothing. -/
def LockdownInsertionIrrelevant (bypass : BypassImpl) : Prop :=
  ∀ (before after : List Rule) (lockdown : Rule) (isRuleDisabled : String → Bool),
    lockdown.sessionOverridable = false →
      bypass (before ++ lockdown :: after) isRuleDisabled = bypass (before ++ after) isRuleDisabled

/-- (c) src/dangerous-command-filter.ts:69-71, as above — replacing a lockdown rule by any other
lockdown rule changes nothing. -/
def LockdownChangeIrrelevant (bypass : BypassImpl) : Prop :=
  ∀ (before after : List Rule) (lockdown lockdown' : Rule) (isRuleDisabled : String → Bool),
    lockdown.sessionOverridable = false → lockdown'.sessionOverridable = false →
      bypass (before ++ lockdown :: after) isRuleDisabled =
        bypass (before ++ lockdown' :: after) isRuleDisabled

/-- (c) src/dangerous-command-filter.ts:69-71, as above — removing every lockdown rule changes
nothing. -/
def LockdownRemovalIrrelevant (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    bypass (catalog.filter fun r => r.sessionOverridable) isRuleDisabled =
      bypass catalog isRuleDisabled

/-- src/types.ts:762-763 "Lockdown rules (`sessionOverridable === false`) ignore this set
entirely." with src/dangerous-command-filter.ts:70-71 "must not be silenced here even if a user
previously approved them for the session" — the disable predicate is read only on the ids of
overridable matches: two predicates that agree there give the same result. -/
def DisabledReadOnlyOnOverridableMatches (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled isRuleDisabled' : String → Bool),
    (∀ r ∈ catalog, OverridableMatch r → isRuleDisabled r.id = isRuleDisabled' r.id) →
      bypass catalog isRuleDisabled = bypass catalog isRuleDisabled'

/-- src/dangerous-command-filter.ts:39 (the ids are those of overridable rules) with :69-71 — an
id carried only by lockdown rules never appears among the ids. -/
def LockdownIdNeverOffered (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool) (ruleId : String),
    (∀ r ∈ catalog, r.id = ruleId → r.sessionOverridable = false) →
      ruleId ∉ (bypass catalog isRuleDisabled).matchedRuleIds

/-- (d) src/dangerous-command-filter.ts:62-63 "When all matched rules are disabled, the decision
degrades to 'allow'." -/
def SilencingEveryMatchAllows (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (∀ r ∈ catalog, OverridableMatch r → isRuleDisabled r.id = true) →
      bypass catalog isRuleDisabled = { decision := .allow, matchedRuleIds := [] }

/-- src/dangerous-command-filter.ts:61-62 "Predicate that returns true for rule ids that should be
treated as silenced for the current session." — disabling more ids only silences: the ids under
the larger disable set are a sub-list of those under the smaller one, and it never turns `allow`
into `ask`. -/
def DisablingMoreOnlySilences (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled isRuleDisabled' : String → Bool),
    (∀ ruleId, isRuleDisabled ruleId = true → isRuleDisabled' ruleId = true) →
      (bypass catalog isRuleDisabled').matchedRuleIds.Sublist
          (bypass catalog isRuleDisabled).matchedRuleIds ∧
        ((bypass catalog isRuleDisabled').decision = .ask →
          (bypass catalog isRuleDisabled).decision = .ask)

/-- src/dangerous-command-filter.ts:52 "Returns 'allow' for non-dangerous commands" — a command
the deleted `isDangerousCommand` rejected is allowed whatever the session disables. -/
def NonDangerousAllowed (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    Original.isDangerousCommand catalog = false →
      (bypass catalog isRuleDisabled).decision = .allow

/-- src/dangerous-command-filter.ts:63 "Defaults to always-false (no session)." — with no
predicate, the decision is `ask` exactly when the deleted `isDangerousCommand` held, and the ids
are the deleted `checkDangerousCommand`'s. Both helpers are therefore derivable from
`bypassBashPermissionDecision`: this is what justified deleting them. -/
def NoSessionAgreesWithLegacyHelpers (bypass : BypassImpl) : Prop :=
  ∀ (catalog : List Rule),
    bypass catalog (fun _ => false) =
      { decision := if Original.isDangerousCommand catalog then .ask else .allow
        matchedRuleIds := (Original.checkDangerousCommand catalog).matchedRuleIds }

/-! ## The deleted legacy helpers (`ModelOriginal.lean`) -/

/-- (e) src/dangerous-command-filter.ts@416b71b7:54-55 "this function (like `isDangerousCommand`)
considers ONLY `sessionOverridable=true` rules" — the boolean helper is the structured helper's
`isDangerous`. -/
def IsDangerousAgreesWithCheck : Prop :=
  ∀ (catalog : List Rule),
    Original.isDangerousCommand catalog = (Original.checkDangerousCommand catalog).isDangerous

/-- (e) src/dangerous-command-filter.ts@416b71b7:54-55, as above — the ids are those of the
overridable matches, in catalog order; no disable set exists here. -/
def CheckIdsAreOverridableMatches : Prop :=
  ∀ (catalog : List Rule),
    (Original.checkDangerousCommand catalog).matchedRuleIds =
      (catalog.filter fun r => decide (OverridableMatch r)).map Rule.id

/-- src/dangerous-command-filter.ts@416b71b7:51 "Returns labels (legacy) + rule ids." — one legacy
label per id, in the same order. -/
def CheckPatternsLabelTheIds : Prop :=
  ∀ (catalog : List Rule),
    (Original.checkDangerousCommand catalog).matchedPatterns =
      (Original.checkDangerousCommand catalog).matchedRuleIds.map Original.legacyDescriptionFor

/-- src/dangerous-command-filter.ts@416b71b7:68-69 "only considers overridable (pattern-based)
rules — NOT cross-user/ssh." -/
def IsDangerousIffOverridableMatch : Prop :=
  ∀ (catalog : List Rule),
    Original.isDangerousCommand catalog = true ↔ ∃ r ∈ catalog, OverridableMatch r

/-- src/dangerous-command-filter.ts@416b71b7:56 "Lockdown rules are checked on their own
enforcement paths." — adding a lockdown rule anywhere changes neither legacy helper. -/
def LegacyHelpersIgnoreLockdown : Prop :=
  ∀ (before after : List Rule) (lockdown : Rule),
    lockdown.sessionOverridable = false →
      Original.checkDangerousCommand (before ++ lockdown :: after) =
          Original.checkDangerousCommand (before ++ after) ∧
        Original.isDangerousCommand (before ++ lockdown :: after) =
          Original.isDangerousCommand (before ++ after)

/-- src/dangerous-command-filter.ts@416b71b7:168-169 `default: return ruleId;` — an id without a
legacy label is its own label. -/
def UnlabelledIdIsItsOwnLabel : Prop :=
  ∀ ruleId, ruleId ∉ legacyLabelledIds → Original.legacyDescriptionFor ruleId = ruleId

/-! ## The simplification -/

/-- `bypassBashPermissionDecision` as of commit 416b71b7 with its first early return
(src/dangerous-command-filter.ts@416b71b7:114-116) deleted. -/
def bypassWithoutFirstEarlyReturn (catalog : List Rule)
    (isRuleDisabled : String → Bool := fun _ => false) : BypassBashPermissionResult :=
  let matching := catalog.filter fun rule => rule.sessionOverridable && rule.matched
  let effective := matching.filter fun rule => !isRuleDisabled rule.id
  if effective.length = 0 then
    { decision := .allow, matchedRuleIds := [] }
  else
    { decision := .ask, matchedRuleIds := effective.map fun rule => rule.id }

/-- (f) Deleting src/dangerous-command-filter.ts@416b71b7:114-116 gives the same function. -/
def EarlyReturnRedundant : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    bypassWithoutFirstEarlyReturn catalog isRuleDisabled =
      Original.bypassBashPermissionDecision catalog isRuleDisabled

/-- `bypassBashPermissionDecision` computed on ids: take the ids of the overridable matches,
then drop the disabled ones, then branch on the result. -/
def bypassOnIds (catalog : List Rule)
    (isRuleDisabled : String → Bool := fun _ => false) : BypassBashPermissionResult :=
  let effective := ((catalog.filter fun rule => rule.sessionOverridable && rule.matched).map
    fun rule => rule.id).filter fun ruleId => !isRuleDisabled ruleId
  if effective.length = 0 then
    { decision := .allow, matchedRuleIds := [] }
  else
    { decision := .ask, matchedRuleIds := effective }

/-- Filtering ids instead of rules (src/dangerous-command-filter.ts@416b71b7:113-121) gives the
same function. -/
def FilteringIdsIsEquivalent : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    bypassOnIds catalog isRuleDisabled = Original.bypassBashPermissionDecision catalog isRuleDisabled

/-- The simplified function (src/dangerous-command-filter.ts:72-74, one return deriving the
decision from the ids) equals the function as of commit 416b71b7 (lines 113-121 there) on every
catalog and every disable predicate. -/
def SimplifiedIsOriginal : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    bypassBashPermissionDecision catalog isRuleDisabled =
      Original.bypassBashPermissionDecision catalog isRuleDisabled

end SomaVerify.BypassDecision.Spec
