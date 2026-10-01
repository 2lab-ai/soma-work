-- models: src/dangerous-command-filter.ts@416b71b7:43-47 (DangerousCommandResult)
-- models: src/dangerous-command-filter.ts@416b71b7:58-65 (checkDangerousCommand)
-- models: src/dangerous-command-filter.ts@416b71b7:71-73 (isDangerousCommand)
-- models: src/dangerous-command-filter.ts@416b71b7:106-122 (bypassBashPermissionDecision)
-- models: src/dangerous-command-filter.ts@416b71b7:142-171 (legacyDescriptionFor)

import SomaVerify.BypassDecision.Model

/-!
# Model of `src/dangerous-command-filter.ts` as of commit 416b71b7

The model the phase-1 proofs were written against, kept as the reference for the simplification.
Line numbers in this file point into `src/dangerous-command-filter.ts` at commit 416b71b7.

`bypassBashPermissionDecision` here has the two early returns and the rule-level filter of that
version; `Proofs.lean` proves the simplified function in `Model.lean` equal to it on every input.
`checkDangerousCommand`, `isDangerousCommand` and `legacyDescriptionFor` no longer exist in the
TS. They stay here because the theorem that justified deleting them,
`OriginalProofs.no_session_agrees_with_legacy_helpers`, is about them. The rule and result types
are shared with `Model.lean`.
-/

namespace SomaVerify.BypassDecision.Original

open SomaVerify.BypassDecision

/-- `DangerousCommandResult` (lines 43-47). -/
structure DangerousCommandResult where
  isDangerous : Bool
  matchedPatterns : List String
  matchedRuleIds : List String
  deriving DecidableEq, Repr

/-- `legacyDescriptionFor` (lines 142-171): the `switch` on the rule id. JS `switch` compares
with `===`, which on strings is exact equality, as Lean's string patterns are. The `default`
branch returns the id unchanged. -/
def legacyDescriptionFor (ruleId : String) : String :=
  match ruleId with
  | "kill" => "kill process"
  | "pkill" => "pkill process"
  | "killall" => "killall process"
  | "rm-recursive" => "recursive delete"
  | "rm-force" => "force delete"
  | "rm-force-long" => "force delete (--force)"
  | "shutdown" => "system shutdown"
  | "reboot" => "system reboot"
  | "halt" => "system halt"
  | "mkfs" => "format filesystem"
  | "dd-if" => "disk copy (dd)"
  | "chmod-world-recursive" => "recursive world-writable chmod"
  | _ => ruleId

/-- `checkDangerousCommand` (lines 58-65). The TS local `matches` is `matching` here: `matches`
is a Lean keyword. -/
def checkDangerousCommand (catalog : List Rule) : DangerousCommandResult :=
  let matching := catalog.filter fun rule => rule.sessionOverridable && rule.matched
  { isDangerous := decide (matching.length > 0)
    matchedPatterns := matching.map fun r => legacyDescriptionFor r.id
    matchedRuleIds := matching.map fun r => r.id }

/-- `isDangerousCommand` (lines 71-73). `Array.prototype.some` is `List.any`. -/
def isDangerousCommand (catalog : List Rule) : Bool :=
  catalog.any fun rule => rule.sessionOverridable && rule.matched

/-- `bypassBashPermissionDecision` (lines 106-122). `isRuleDisabled` defaults to the constant
`false` predicate, as `() => false` does in the TS signature (line 108). The TS local `matches` is
`matching` here. -/
def bypassBashPermissionDecision (catalog : List Rule)
    (isRuleDisabled : String → Bool := fun _ => false) : BypassBashPermissionResult :=
  let matching := catalog.filter fun rule => rule.sessionOverridable && rule.matched
  if matching.length = 0 then
    { decision := .allow, matchedRuleIds := [] }
  else
    let effective := matching.filter fun rule => !isRuleDisabled rule.id
    if effective.length = 0 then
      { decision := .allow, matchedRuleIds := [] }
    else
      { decision := .ask, matchedRuleIds := effective.map fun rule => rule.id }

end SomaVerify.BypassDecision.Original
