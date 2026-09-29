import SomaVerify.BypassDecision.Model

/-!
# Documented invariants of `src/dangerous-command-filter.ts`

Each proposition restates, over the model, a sentence from the TS source, quoted above it with
its `path:line`. They say which catalog entries decide the result, never how the model's filter
chain computes it, so a proof shows that the TS structure implements the sentence.
`Proofs.lean` proves every one of them.

The last section is not documentation: it states the equivalences that justify two
simplifications of `bypassBashPermissionDecision`, for the follow-up refactoring phase.
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

/-- The labels `legacyDescriptionFor` knows, i.e. its `case` labels (lines 144-166). -/
def legacyLabelledIds : List String :=
  ["kill", "pkill", "killall", "rm-recursive", "rm-force", "rm-force-long", "shutdown", "reboot",
    "halt", "mkfs", "dd-if", "chmod-world-recursive"]

/-! ## `bypassBashPermissionDecision` -/

/-- (a) src/dangerous-command-filter.ts:92-93 "Returns 'allow' for non-dangerous commands, 'ask'
for dangerous ones (subject to the session-scoped disable set)." with :110 "Only overridable rules
participate in bypass escalation." -/
def AskIffSomeRuleEscalates : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypassBashPermissionDecision catalog isRuleDisabled).decision = .ask ↔
      ∃ r ∈ catalog, Escalates isRuleDisabled r

/-- (b) src/dangerous-command-filter.ts:80 "`matchedRuleIds`: overridable rules that are
currently *active* (not session-disabled)." — the ids of exactly the escalating rules, in catalog
order, one per rule. -/
def MatchedIdsAreEscalatingIds : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypassBashPermissionDecision catalog isRuleDisabled).matchedRuleIds =
      (catalog.filter fun r => decide (Escalates isRuleDisabled r)).map Rule.id

/-- (b) src/dangerous-command-filter.ts:81 "Empty when decision is 'allow'." -/
def AllowCarriesNoIds : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypassBashPermissionDecision catalog isRuleDisabled).decision = .allow →
      (bypassBashPermissionDecision catalog isRuleDisabled).matchedRuleIds = []

/-- src/dangerous-command-filter.ts:81-82 "Passed end-to-end to the Slack UI so the "Approve &
disable rule for this session" button knows what to disable." — an `ask` names at least one
rule. -/
def AskCarriesIds : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (bypassBashPermissionDecision catalog isRuleDisabled).decision = .ask →
      (bypassBashPermissionDecision catalog isRuleDisabled).matchedRuleIds ≠ []

/-- (c) src/dangerous-command-filter.ts:110-112 "Only overridable rules participate in bypass
escalation. Lockdown rules (cross-user, ssh) have their own enforcement paths and must not be
silenced here" — adding a lockdown rule anywhere, matching or not, under any id, changes
nothing. -/
def LockdownInsertionIrrelevant : Prop :=
  ∀ (before after : List Rule) (lockdown : Rule) (isRuleDisabled : String → Bool),
    lockdown.sessionOverridable = false →
      bypassBashPermissionDecision (before ++ lockdown :: after) isRuleDisabled =
        bypassBashPermissionDecision (before ++ after) isRuleDisabled

/-- (c) src/dangerous-command-filter.ts:110-112, as above — replacing a lockdown rule by any
other lockdown rule changes nothing. -/
def LockdownChangeIrrelevant : Prop :=
  ∀ (before after : List Rule) (lockdown lockdown' : Rule) (isRuleDisabled : String → Bool),
    lockdown.sessionOverridable = false → lockdown'.sessionOverridable = false →
      bypassBashPermissionDecision (before ++ lockdown :: after) isRuleDisabled =
        bypassBashPermissionDecision (before ++ lockdown' :: after) isRuleDisabled

/-- (c) src/dangerous-command-filter.ts:110-112, as above — removing every lockdown rule
changes nothing. -/
def LockdownRemovalIrrelevant : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    bypassBashPermissionDecision (catalog.filter fun r => r.sessionOverridable) isRuleDisabled =
      bypassBashPermissionDecision catalog isRuleDisabled

/-- src/types.ts:762-763 "Lockdown rules (`sessionOverridable === false`) ignore this set
entirely." with src/dangerous-command-filter.ts:111-112 "must not be silenced here even if a
user previously approved them for the session" — the disable predicate is read only on the ids
of overridable matches: two predicates that agree there give the same result. -/
def DisabledReadOnlyOnOverridableMatches : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled isRuleDisabled' : String → Bool),
    (∀ r ∈ catalog, OverridableMatch r → isRuleDisabled r.id = isRuleDisabled' r.id) →
      bypassBashPermissionDecision catalog isRuleDisabled =
        bypassBashPermissionDecision catalog isRuleDisabled'

/-- src/dangerous-command-filter.ts:81-82 (the ids feed the "Approve & disable rule for this
session" button) with :110-112 — an id carried only by lockdown rules is never offered for
disabling. -/
def LockdownIdNeverOffered : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool) (ruleId : String),
    (∀ r ∈ catalog, r.id = ruleId → r.sessionOverridable = false) →
      ruleId ∉ (bypassBashPermissionDecision catalog isRuleDisabled).matchedRuleIds

/-- (d) src/dangerous-command-filter.ts:103-104 "When all matched rules are disabled, the
decision degrades to 'allow'." -/
def SilencingEveryMatchAllows : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    (∀ r ∈ catalog, OverridableMatch r → isRuleDisabled r.id = true) →
      bypassBashPermissionDecision catalog isRuleDisabled =
        { decision := .allow, matchedRuleIds := [] }

/-- src/dangerous-command-filter.ts:102-103 "Predicate that returns true for rule ids that should
be treated as silenced for the current session." — disabling more ids only silences: the ids
under the larger disable set are a sub-list of those under the smaller one, and it never turns
`allow` into `ask`. -/
def DisablingMoreOnlySilences : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled isRuleDisabled' : String → Bool),
    (∀ ruleId, isRuleDisabled ruleId = true → isRuleDisabled' ruleId = true) →
      (bypassBashPermissionDecision catalog isRuleDisabled').matchedRuleIds.Sublist
          (bypassBashPermissionDecision catalog isRuleDisabled).matchedRuleIds ∧
        ((bypassBashPermissionDecision catalog isRuleDisabled').decision = .ask →
          (bypassBashPermissionDecision catalog isRuleDisabled).decision = .ask)

/-- src/dangerous-command-filter.ts:92 "Returns 'allow' for non-dangerous commands" — a command
`isDangerousCommand` rejects is allowed whatever the session disables. -/
def NonDangerousAllowed : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    isDangerousCommand catalog = false →
      (bypassBashPermissionDecision catalog isRuleDisabled).decision = .allow

/-- src/dangerous-command-filter.ts:104 "Defaults to always-false (no session)." — with no
predicate, every overridable match escalates: the decision is `ask` exactly when
`isDangerousCommand` holds, and the ids are `checkDangerousCommand`'s. -/
def NoSessionAgreesWithLegacyHelpers : Prop :=
  ∀ (catalog : List Rule),
    bypassBashPermissionDecision catalog =
      { decision := if isDangerousCommand catalog then .ask else .allow
        matchedRuleIds := (checkDangerousCommand catalog).matchedRuleIds }

/-! ## `checkDangerousCommand`, `isDangerousCommand`, `legacyDescriptionFor` -/

/-- (e) src/dangerous-command-filter.ts:54-55 "this function (like `isDangerousCommand`)
considers ONLY `sessionOverridable=true` rules" — the boolean helper is the structured helper's
`isDangerous`. -/
def IsDangerousAgreesWithCheck : Prop :=
  ∀ (catalog : List Rule), isDangerousCommand catalog = (checkDangerousCommand catalog).isDangerous

/-- (e) src/dangerous-command-filter.ts:54-55, as above — the ids are those of the overridable
matches, in catalog order; no disable set exists here. -/
def CheckIdsAreOverridableMatches : Prop :=
  ∀ (catalog : List Rule),
    (checkDangerousCommand catalog).matchedRuleIds =
      (catalog.filter fun r => decide (OverridableMatch r)).map Rule.id

/-- src/dangerous-command-filter.ts:51 "Returns labels (legacy) + rule ids." — one legacy label
per id, in the same order. -/
def CheckPatternsLabelTheIds : Prop :=
  ∀ (catalog : List Rule),
    (checkDangerousCommand catalog).matchedPatterns =
      (checkDangerousCommand catalog).matchedRuleIds.map legacyDescriptionFor

/-- src/dangerous-command-filter.ts:68-69 "only considers overridable (pattern-based) rules —
NOT cross-user/ssh." -/
def IsDangerousIffOverridableMatch : Prop :=
  ∀ (catalog : List Rule),
    isDangerousCommand catalog = true ↔ ∃ r ∈ catalog, OverridableMatch r

/-- src/dangerous-command-filter.ts:56 "Lockdown rules are checked on their own enforcement
paths." — adding a lockdown rule anywhere changes neither legacy helper. -/
def LegacyHelpersIgnoreLockdown : Prop :=
  ∀ (before after : List Rule) (lockdown : Rule),
    lockdown.sessionOverridable = false →
      checkDangerousCommand (before ++ lockdown :: after) = checkDangerousCommand (before ++ after) ∧
        isDangerousCommand (before ++ lockdown :: after) = isDangerousCommand (before ++ after)

/-- src/dangerous-command-filter.ts:168-169 `default: return ruleId;` — an id without a legacy
label is its own label. -/
def UnlabelledIdIsItsOwnLabel : Prop :=
  ∀ ruleId, ruleId ∉ legacyLabelledIds → legacyDescriptionFor ruleId = ruleId

/-! ## Refactoring equivalences (for the follow-up phase; not documented invariants) -/

/-- `bypassBashPermissionDecision` with its first early return, src/dangerous-command-filter.ts:
114-116, deleted. -/
def bypassWithoutFirstEarlyReturn (catalog : List Rule)
    (isRuleDisabled : String → Bool := fun _ => false) : BypassBashPermissionResult :=
  let matching := catalog.filter fun rule => rule.sessionOverridable && rule.matched
  let effective := matching.filter fun rule => !isRuleDisabled rule.id
  if effective.length = 0 then
    { decision := .allow, matchedRuleIds := [] }
  else
    { decision := .ask, matchedRuleIds := effective.map fun rule => rule.id }

/-- (f) Deleting src/dangerous-command-filter.ts:114-116 gives the same function. -/
def EarlyReturnRedundant : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    bypassWithoutFirstEarlyReturn catalog isRuleDisabled =
      bypassBashPermissionDecision catalog isRuleDisabled

/-- `bypassBashPermissionDecision` computed on ids: take the ids of the overridable matches,
then drop the disabled ones. soma-lib's `overridableMatchedRuleIds(command)` computes that first
list; that it does so over the same catalog is read from soma-lib's source, not proved here. -/
def bypassOnIds (catalog : List Rule)
    (isRuleDisabled : String → Bool := fun _ => false) : BypassBashPermissionResult :=
  let effective := ((catalog.filter fun rule => rule.sessionOverridable && rule.matched).map
    fun rule => rule.id).filter fun ruleId => !isRuleDisabled ruleId
  if effective.length = 0 then
    { decision := .allow, matchedRuleIds := [] }
  else
    { decision := .ask, matchedRuleIds := effective }

/-- Filtering ids instead of rules (src/dangerous-command-filter.ts:113-121) gives the same
function. -/
def FilteringIdsIsEquivalent : Prop :=
  ∀ (catalog : List Rule) (isRuleDisabled : String → Bool),
    bypassOnIds catalog isRuleDisabled = bypassBashPermissionDecision catalog isRuleDisabled

end SomaVerify.BypassDecision.Spec
