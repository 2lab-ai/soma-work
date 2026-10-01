-- models: src/dangerous-command-filter.ts:44-47 (BypassBashPermissionResult)
-- models: src/dangerous-command-filter.ts:65-75 (bypassBashPermissionDecision)

/-!
# Model of `bypassBashPermissionDecision` in `src/dangerous-command-filter.ts`

For one Bash command, the TS function walks soma-lib's `DANGEROUS_RULES` catalog, keeps the rules
that are `sessionOverridable` and whose `match(command, {})` fires, takes their ids and drops the
ids the session has disabled. The model keeps that structure line for line.

One abstraction: the catalog is an argument, and each entry already carries what its matcher
returned for the command (`Rule.matched`). The matchers are soma-lib's regular expressions run
by the JS regex engine, which the verification layer tests rather than models
(`verification/README.md`, "Trust boundary"). The command string itself therefore never appears
in the model.

This is the function after the proof-backed simplification. `ModelOriginal.lean` keeps the model
of the file as of commit 416b71b7, before it, including the helpers the simplification deleted;
`Proofs.lean` proves the two models of `bypassBashPermissionDecision` equal on every input.
-/

namespace SomaVerify.BypassDecision

/-- One entry of `DANGEROUS_RULES` as the function sees it for one fixed command. `id` and
`sessionOverridable` are the soma-lib `DangerousRule` fields. `matched` is the value of
`rule.match(command, {})`: the matcher is called with an empty context, so a context-dependent
rule (soma-lib's `cross-user-access`) never fires on this path. -/
structure Rule where
  id : String
  sessionOverridable : Bool
  matched : Bool
  deriving DecidableEq, Repr

/-- `BypassBashPermissionResult.decision` (line 45): `'allow' | 'ask'`. -/
inductive Decision where
  | allow
  | ask
  deriving DecidableEq, Repr

/-- `BypassBashPermissionResult` (lines 44-47). -/
structure BypassBashPermissionResult where
  decision : Decision
  matchedRuleIds : List String
  deriving DecidableEq, Repr

/-- `bypassBashPermissionDecision` (lines 65-75). `isRuleDisabled` defaults to the constant
`false` predicate, as `() => false` does in the TS signature (line 67). The TS local `matches`
is `matching` here: `matches` is a Lean keyword. -/
def bypassBashPermissionDecision (catalog : List Rule)
    (isRuleDisabled : String → Bool := fun _ => false) : BypassBashPermissionResult :=
  let matching := catalog.filter fun rule => rule.sessionOverridable && rule.matched
  let matchedRuleIds := (matching.map fun rule => rule.id).filter fun ruleId => !isRuleDisabled ruleId
  { decision := if matchedRuleIds.length = 0 then .allow else .ask
    matchedRuleIds := matchedRuleIds }

end SomaVerify.BypassDecision
