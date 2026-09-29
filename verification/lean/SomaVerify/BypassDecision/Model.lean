-- models: src/dangerous-command-filter.ts:43-47 (DangerousCommandResult)
-- models: src/dangerous-command-filter.ts:58-65 (checkDangerousCommand)
-- models: src/dangerous-command-filter.ts:71-73 (isDangerousCommand)
-- models: src/dangerous-command-filter.ts:84-87 (BypassBashPermissionResult)
-- models: src/dangerous-command-filter.ts:106-122 (bypassBashPermissionDecision)
-- models: src/dangerous-command-filter.ts:142-171 (legacyDescriptionFor)

/-!
# Model of the parent-side decisions in `src/dangerous-command-filter.ts`

For one Bash command, the TS functions walk soma-lib's `DANGEROUS_RULES` catalog, keep the rules
that are `sessionOverridable` and whose `match(command, {})` fires, and derive a result from
them. The model keeps that structure line for line: the same `filter`, the same two early
returns, the same field values in the same order.

One abstraction: the catalog is an argument, and each entry already carries what its matcher
returned for the command (`Rule.matched`). The matchers are soma-lib's regular expressions run
by the JS regex engine, which the verification layer tests rather than models
(`verification/README.md`, "Trust boundary"). The command string itself therefore never appears
in the model.

`getOverridableRule` (lines 133-135) is not modelled. It forwards to soma-lib's
`overridableRulesByIds`, an id lookup that lives outside this file.
-/

namespace SomaVerify.BypassDecision

/-- One entry of `DANGEROUS_RULES` as the functions see it for one fixed command. `id` and
`sessionOverridable` are the soma-lib `DangerousRule` fields. `matched` is the value of
`rule.match(command, {})`: the matcher is called with an empty context, so a context-dependent
rule (soma-lib's `cross-user-access`) never fires on this path. -/
structure Rule where
  id : String
  sessionOverridable : Bool
  matched : Bool
  deriving DecidableEq, Repr

/-- `DangerousCommandResult` (lines 43-47). -/
structure DangerousCommandResult where
  isDangerous : Bool
  matchedPatterns : List String
  matchedRuleIds : List String
  deriving DecidableEq, Repr

/-- `BypassBashPermissionResult.decision` (line 85): `'allow' | 'ask'`. -/
inductive Decision where
  | allow
  | ask
  deriving DecidableEq, Repr

/-- `BypassBashPermissionResult` (lines 84-87). -/
structure BypassBashPermissionResult where
  decision : Decision
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

end SomaVerify.BypassDecision
