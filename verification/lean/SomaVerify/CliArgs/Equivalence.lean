import SomaVerify.CliArgs.ModelOriginal
import SomaVerify.CliArgs.Proofs

/-!
# The simplified model returns what the original model returned

`Model.lean` models `src/cli/args.ts` after its simplification; `ModelOriginal.lean` keeps the
phase-1 model of the code before it (commit 79eb7ffd). `parseCli_simplified_eq_original` proves
the two `parseCli`s agree on every argv (same command, same error text), which is what licenses
each change. Line numbers `@79eb7ffd` refer to the old `args.ts`, bare ones to the new.

| change | per-function theorem | why it is unobservable |
|---|---|---|
| `if (value === true) throw …` (@79eb7ffd:174) became `typeof value !== 'string'` (169) | `readProfile_eq_original` | `--profile` is stored as `true` by no parse (`get_profile_ne_present`) |
| the `minPositionals` check (@79eb7ffd:164-166) and field removed | `parseArguments_eq_original` | every grammar had `minPositionals: 0` |
| `\|\| 'no options'` (@79eb7ffd:137) removed | `expectedOptions_eq_original` | every grammar declares a flag |
| `COMMAND_GRAMMAR.sessions` (@79eb7ffd:84) removed | `commandGrammar_eq_original` | `parseCli` never read it |
| two sessions grammar literals (@79eb7ffd:287-290) merged (282-285) | `sessionsGrammar_eq_original` | same flags, same maximum per action |
-/

namespace SomaVerify.CliArgs.Equivalence

open SomaVerify.CliArgs

/-- An original grammar without its `minPositionals` field. -/
def simplify (grammar : Original.Grammar) : Grammar :=
  ⟨grammar.flags, grammar.maxPositionals⟩

/-! ## Grammars -/

/-- The five `COMMAND_GRAMMAR` entries `parseCli` reads are the same flags and maximum; the
sixth original entry, `sessions`, is dropped (`parseCli` reads `sessionsGrammar` instead). -/
theorem commandGrammar_eq_original :
    simplify Original.COMMAND_GRAMMAR.setup = COMMAND_GRAMMAR.setup ∧
    simplify Original.COMMAND_GRAMMAR.doctor = COMMAND_GRAMMAR.doctor ∧
    simplify Original.COMMAND_GRAMMAR.status = COMMAND_GRAMMAR.status ∧
    simplify Original.COMMAND_GRAMMAR.service = COMMAND_GRAMMAR.service ∧
    simplify Original.COMMAND_GRAMMAR.profile = COMMAND_GRAMMAR.profile :=
  ⟨rfl, rfl, rfl, rfl, rfl⟩

/-- The one sessions grammar literal (args.ts:282-285) is the two old ones (@79eb7ffd:287-290),
for every action. -/
theorem sessionsGrammar_eq_original (action : String) :
    simplify (Original.sessionsGrammar action) = sessionsGrammar action := by
  by_cases h : action = "list" <;> simp [simplify, Original.sessionsGrammar, sessionsGrammar, h]

/-- Every original grammar `parseCli` used had `minPositionals: 0`. -/
theorem original_minPositionals :
    Original.COMMAND_GRAMMAR.setup.minPositionals = 0 ∧
    Original.COMMAND_GRAMMAR.doctor.minPositionals = 0 ∧
    Original.COMMAND_GRAMMAR.status.minPositionals = 0 ∧
    Original.COMMAND_GRAMMAR.service.minPositionals = 0 ∧
    Original.COMMAND_GRAMMAR.profile.minPositionals = 0 ∧
    ∀ action, (Original.sessionsGrammar action).minPositionals = 0 := by
  refine ⟨rfl, rfl, rfl, rfl, rfl, fun action => ?_⟩
  unfold Original.sessionsGrammar
  split <;> rfl

/-! ## `|| 'no options'` -/

/-- args.ts@79eb7ffd:137: the fallback only differs from the plain join when the join is empty. -/
theorem expectedOptions_eq_original {grammar : Original.Grammar}
    (h : (", ".intercalate (grammar.flags.map (·.1))).isEmpty = false) :
    Original.expectedOptions grammar = expectedOptions (simplify grammar) := by
  simp only [Original.expectedOptions, expectedOptions, simplify, h, Bool.false_eq_true,
    ↓reduceIte]

/-- Every original grammar `parseCli` used declares a flag, so its option list is never empty. -/
theorem original_options_nonempty :
    (", ".intercalate (Original.COMMAND_GRAMMAR.setup.flags.map (·.1))).isEmpty = false ∧
    (", ".intercalate (Original.COMMAND_GRAMMAR.doctor.flags.map (·.1))).isEmpty = false ∧
    (", ".intercalate (Original.COMMAND_GRAMMAR.status.flags.map (·.1))).isEmpty = false ∧
    (", ".intercalate (Original.COMMAND_GRAMMAR.service.flags.map (·.1))).isEmpty = false ∧
    (", ".intercalate (Original.COMMAND_GRAMMAR.profile.flags.map (·.1))).isEmpty = false ∧
    ∀ action,
      (", ".intercalate ((Original.sessionsGrammar action).flags.map (·.1))).isEmpty = false := by
  refine ⟨by decide, by decide, by decide, by decide, by decide, fun action => ?_⟩
  unfold Original.sessionsGrammar sessionsHandlerFlags
  by_cases h : action = "list" <;> simp only [h, ↓reduceIte] <;> decide

/-! ## The walker and `parseArguments` -/

theorem unknownOptionMessage_eq_original {grammar : Original.Grammar} {token command : String}
    (h : Original.expectedOptions grammar = expectedOptions (simplify grammar)) :
    Original.unknownOptionMessage token grammar command =
      unknownOptionMessage token (simplify grammar) command := by
  simp only [Original.unknownOptionMessage, unknownOptionMessage, h]

/-- The two walkers agree token by token once their option lists render the same. -/
theorem walk_eq_original {grammar : Original.Grammar} {command : String}
    (h : Original.expectedOptions grammar = expectedOptions (simplify grammar)) :
    ∀ (tokens : List String) (acc : Parsed),
      Original.walk grammar command tokens acc = walk (simplify grammar) command tokens acc := by
  intro tokens acc
  induction tokens, acc using Original.walk.induct grammar with
  | case1 acc =>
    rw [walk_nil, Original.walk.eq_def]
  | case2 token tokens acc hopt hlook =>
    rw [walk_unknown (grammar := simplify grammar) hopt hlook, Original.walk.eq_def]
    simp only [hopt, hlook, ↓reduceIte, unknownOptionMessage_eq_original h]
  | case3 token tokens acc hopt kind hlook hhas =>
    rw [walk_repeated (grammar := simplify grammar) hopt hlook hhas, Original.walk.eq_def]
    simp only [hopt, hlook, hhas, ↓reduceIte]
  | case4 token tokens acc hopt hhas hlook ih =>
    rw [walk_boolean (grammar := simplify grammar) hopt hhas hlook, ← ih, Original.walk.eq_def]
    simp only [hopt, hlook, hhas, Bool.false_eq_true, ↓reduceIte]
  | case5 token acc hopt hhas hlook =>
    rw [walk_value_missing (grammar := simplify grammar) hopt hhas hlook, Original.walk.eq_def]
    simp only [hopt, hlook, hhas, Bool.false_eq_true, ↓reduceIte]
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    rw [walk_value_dash (grammar := simplify grammar) hopt hhas hstart hlook,
      Original.walk.eq_def]
    simp only [hopt, hlook, hhas, hstart, Bool.false_eq_true, ↓reduceIte]
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    rw [walk_value (grammar := simplify grammar) hopt hhas hstart hlook, ← ih,
      Original.walk.eq_def]
    simp only [hopt, hlook, hhas, hstart, Bool.false_eq_true, ↓reduceIte]
  | case8 token tokens acc hopt ih =>
    rw [walk_positional (grammar := simplify grammar) hopt, ← ih, Original.walk.eq_def]
    simp only [hopt, Bool.false_eq_true, ↓reduceIte]

/-- args.ts@79eb7ffd:164-166: with `minPositionals: 0` the check never fires, so dropping it
(and the field) changes no result. -/
theorem parseArguments_eq_original {grammar : Original.Grammar}
    (hmsg : Original.expectedOptions grammar = expectedOptions (simplify grammar))
    (hmin : grammar.minPositionals = 0) (tokens : List String) (command : String) :
    Original.parseArguments tokens grammar command =
      parseArguments tokens (simplify grammar) command := by
  unfold Original.parseArguments parseArguments
  rw [walk_eq_original hmsg]
  cases walk (simplify grammar) command tokens { flags := [], positionals := [] } with
  | error message => rfl
  | ok parsed =>
    simp only [hmin, Nat.not_lt_zero, ↓reduceIte, simplify]
    rfl

/-! ## `readProfile` -/

/-- args.ts@79eb7ffd:174 → args.ts:169: the two readers differ only on a `--profile` stored as
`true`. -/
theorem readProfile_eq_original {parsed : Parsed} (h : parsed.get PROFILE_FLAG ≠ some .present) :
    Original.readProfile parsed = readProfile parsed := by
  unfold Original.readProfile readProfile
  cases hv : parsed.get PROFILE_FLAG with
  | none => rfl
  | some value =>
    cases value with
    | present => exact absurd hv h
    | str value => rfl

/-- Every parse `parseCli` hands to `readProfile` is one where the two readers agree: the
grammar declares `--profile` as a value flag, so it is never stored as `true`. -/
theorem readProfile_eq_original_of_parse {tokens : List String} {grammar : Grammar}
    {command : String} {parsed : Parsed} (hg : grammar.flags.lookup PROFILE_FLAG = some .value)
    (hp : parseArguments tokens grammar command = .ok parsed) :
    Original.readProfile parsed = readProfile parsed :=
  readProfile_eq_original (get_profile_ne_present hg hp)

/-! ## `parseCli` -/

/-- One `parseArguments`-then-`readProfile` step, as each `parseCli` arm performs it, agrees
between the models. -/
theorem bind_parse_eq_original {α : Type} {grammar : Original.Grammar} {grammar' : Grammar}
    {tokens : List String} {command : String} (hsimp : simplify grammar = grammar')
    (hmin : grammar.minPositionals = 0)
    (hopts : (", ".intercalate (grammar.flags.map (·.1))).isEmpty = false)
    (hprof : grammar'.flags.lookup PROFILE_FLAG = some .value)
    (k : Parsed → Option String → Except String α) :
    (Original.parseArguments tokens grammar command >>= fun parsed =>
        Original.readProfile parsed >>= fun profile => k parsed profile) =
      (parseArguments tokens grammar' command >>= fun parsed =>
        readProfile parsed >>= fun profile => k parsed profile) := by
  subst hsimp
  rw [parseArguments_eq_original (expectedOptions_eq_original hopts) hmin]
  cases h : parseArguments tokens (simplify grammar) command with
  | error message => rfl
  | ok parsed => rw [ok_bind, ok_bind, readProfile_eq_original_of_parse hprof h]

/-- The original `switch` (args.ts@79eb7ffd:260-303) as a chain of string comparisons. -/
theorem original_parseCliWith_cons (rp : Parsed → Except String (Option String))
    (command : String) (rest : List String) :
    Original.parseCliWith rp (command :: rest) =
      if HELP_TOKENS.contains command then do
        assertNoExtraTokens rest "help"
        pure .help
      else if VERSION_TOKENS.contains command then do
        assertNoExtraTokens rest "version"
        pure .version
      else if command = "setup" then do
        let parsed ← Original.parseArguments rest Original.COMMAND_GRAMMAR.setup "setup"
        let profile ← rp parsed
        pure (.setup profile (parsed.has "--resume"))
      else if command = "doctor" then do
        let parsed ← Original.parseArguments rest Original.COMMAND_GRAMMAR.doctor "doctor"
        let profile ← rp parsed
        pure (.doctor profile (parsed.has "--json"))
      else if command = "status" then do
        let parsed ← Original.parseArguments rest Original.COMMAND_GRAMMAR.status "status"
        let profile ← rp parsed
        pure (.status profile (parsed.has "--json"))
      else if command = "service" then do
        let action ← readAction rest "service" SERVICE_ACTIONS
        let parsed ←
          Original.parseArguments (rest.drop 1) Original.COMMAND_GRAMMAR.service "service"
        let profile ← rp parsed
        pure (.service action profile)
      else if command = "profile" then do
        let action ← readAction rest "profile" PROFILE_ACTIONS
        let parsed ←
          Original.parseArguments (rest.drop 1) Original.COMMAND_GRAMMAR.profile "profile"
        let profile ← rp parsed
        pure (.profile action profile (parsed.has "--json"))
      else if command = "sessions" then do
        let action ← readAction rest "sessions" SESSIONS_ACTIONS
        let parsed ← Original.parseArguments (rest.drop 1) (Original.sessionsGrammar action)
          s!"sessions {action}"
        let profile ← rp parsed
        pure (.sessions action profile
          (normalizeSessionsArgv parsed (sessionsHandlerFlags action)))
      else .error (unknownCommandMessage command) := by
  by_cases hh : HELP_TOKENS.contains command = true
  · simp only [Original.parseCliWith, hh, ↓reduceIte]
  by_cases hv : VERSION_TOKENS.contains command = true
  · simp only [Original.parseCliWith, hh, hv, Bool.false_eq_true, ↓reduceIte]
  by_cases h1 : command = "setup"
  · subst h1; rfl
  by_cases h2 : command = "doctor"
  · subst h2; rfl
  by_cases h3 : command = "status"
  · subst h3; rfl
  by_cases h4 : command = "service"
  · subst h4; rfl
  by_cases h5 : command = "profile"
  · subst h5; rfl
  by_cases h6 : command = "sessions"
  · subst h6; rfl
  simp only [Original.parseCliWith, hh, hv, h1, h2, h3, h4, h5, h6, Bool.false_eq_true,
    ↓reduceIte]

/-- The simplified `parseCli` returns exactly what the original returned, for every argv: the
same command object or the same error message. -/
theorem parseCli_simplified_eq_original (argv : List String) :
    parseCli argv = Original.parseCli argv := by
  obtain ⟨hsetup, hdoctor, hstatus, hservice, hprofile⟩ := commandGrammar_eq_original
  obtain ⟨msetup, mdoctor, mstatus, mservice, mprofile, msessions⟩ := original_minPositionals
  obtain ⟨osetup, odoctor, ostatus, oservice, oprofile, osessions⟩ := original_options_nonempty
  rcases argv with _ | ⟨command, rest⟩
  · rfl
  rw [parseCli_cons, Original.parseCli, original_parseCliWith_cons]
  split
  · rfl
  split
  · rfl
  split
  · exact (bind_parse_eq_original hsetup msetup osetup (by decide) _).symm
  split
  · exact (bind_parse_eq_original hdoctor mdoctor odoctor (by decide) _).symm
  split
  · exact (bind_parse_eq_original hstatus mstatus ostatus (by decide) _).symm
  split
  · congr 1
    funext action
    exact (bind_parse_eq_original hservice mservice oservice (by decide) _).symm
  split
  · congr 1
    funext action
    exact (bind_parse_eq_original hprofile mprofile oprofile (by decide) _).symm
  split
  · congr 1
    funext action
    exact (bind_parse_eq_original (sessionsGrammar_eq_original action) (msessions action)
      (osessions action) (sessionsGrammar_profile action) _).symm
  · rfl

end SomaVerify.CliArgs.Equivalence
