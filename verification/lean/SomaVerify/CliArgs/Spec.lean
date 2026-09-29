import SomaVerify.CliArgs.Model

/-!
# The documented invariants of `src/cli/args.ts`, stated about the model

Each proposition quotes the TS comment it formalizes (`path:line`). `Proofs.lean` proves every
one of them. A bare `args.ts:N` means `src/cli/args.ts:N`.
-/

namespace SomaVerify.CliArgs

open SomaVerify.JsString

/-! ## Vocabulary for the statements -/

/-- The tokens one parsed flag stands for: the flag, then its value if it has one. -/
def entryTokens : String × FlagValue → List String
  | (flag, .present) => [flag]
  | (flag, .str value) => [flag, value]

/-- The tokens a list of parsed flags stands for, in list order. -/
def flagTokens (flags : List (String × FlagValue)) : List String :=
  flags.flatMap entryTokens

/-- The kind of flag a stored value belongs to: `true` for a boolean flag, a string for a value
flag. -/
def FlagValue.kind : FlagValue → FlagKind
  | .present => .boolean
  | .str _ => .value

/-- The grammars `parseCli` passes to `parseArguments` (args.ts:262, 267, 272, 277, 287-291;
`sessions` reaches `sessionsGrammar` only with an action `readAction` accepted). -/
def grammarsUsed : List Grammar :=
  [COMMAND_GRAMMAR.setup, COMMAND_GRAMMAR.doctor, COMMAND_GRAMMAR.status, COMMAND_GRAMMAR.service,
   COMMAND_GRAMMAR.profile, sessionsGrammar "list", sessionsGrammar "show"]

/-- `tokens` without the first `flag` token and the token after it. -/
def removeFlagPair (flag : String) : List String → List String
  | [] => []
  | token :: rest => if token = flag then rest.drop 1 else token :: removeFlagPair flag rest

/-- `readProfile` with the body of args.ts:174 (`if (value === true) throw …`) replaced by an
arbitrary `outcome`. -/
def readProfileReplacing174 (outcome : Except String (Option String)) (parsed : Parsed) :
    Except String (Option String) :=
  match parsed.get PROFILE_FLAG with
  | none => .ok none
  | some .present => outcome
  | some (.str value) =>
    if !isProfileName value then .error (invalidProfileMessage value) else .ok (some value)

/-- `parseArguments` without args.ts:164-166 (the `minPositionals` check). -/
def parseArgumentsWithoutMinCheck (tokens : List String) (grammar : Grammar) (command : String) :
    Except String Parsed :=
  match walk grammar command tokens { flags := [], positionals := [] } with
  | .error message => .error message
  | .ok parsed =>
    if parsed.positionals.length > grammar.maxPositionals then
      .error (unexpectedArgumentMessage (parsed.positionals.getD grammar.maxPositionals "") command)
    else
      .ok parsed

/-- The argv heads whose tail `parseCli` parses with no positional allowed, each with the grammar
and the command label it uses (args.ts:261-279, 288-289). -/
def zeroPositionalHeads : List (List String × Grammar × String) :=
  [(["setup"], COMMAND_GRAMMAR.setup, "setup"),
   (["doctor"], COMMAND_GRAMMAR.doctor, "doctor"),
   (["status"], COMMAND_GRAMMAR.status, "status")] ++
  SERVICE_ACTIONS.map (fun action => (["service", action], COMMAND_GRAMMAR.service, "service")) ++
  PROFILE_ACTIONS.map (fun action => (["profile", action], COMMAND_GRAMMAR.profile, "profile")) ++
  [(["sessions", "list"], sessionsGrammar "list", "sessions list")]

/-- The grammars `parseCli` passes to `parseArguments`, with the command label it passes. -/
def labeledGrammars : List (Grammar × String) :=
  [(COMMAND_GRAMMAR.setup, "setup"), (COMMAND_GRAMMAR.doctor, "doctor"),
   (COMMAND_GRAMMAR.status, "status"), (COMMAND_GRAMMAR.service, "service"),
   (COMMAND_GRAMMAR.profile, "profile"), (sessionsGrammar "list", "sessions list"),
   (sessionsGrammar "show", "sessions show")]

/-- Every message `parseCli` can throw that repeats the argv token `token`, and nothing else from
the argv: the command labels and option lists in them are fixed text. -/
def cliErrorsNaming (token : String) : List String :=
  [unknownCommandMessage token, unexpectedArgumentMessage token "help",
   unexpectedArgumentMessage token "version", invalidProfileMessage token,
   unknownActionMessage "service" token SERVICE_ACTIONS,
   unknownActionMessage "profile" token PROFILE_ACTIONS,
   unknownActionMessage "sessions" token SESSIONS_ACTIONS] ++
  labeledGrammars.flatMap (fun labeled =>
    [unknownOptionMessage token labeled.1 labeled.2, repeatedOptionMessage token,
     requiresValueMessage token, unexpectedArgumentMessage token labeled.2])

/-- Every message `parseCli` can throw that repeats no argv token. -/
def cliErrorsNamingNothing : List String :=
  [missingCommandMessage, missingActionMessage "service" SERVICE_ACTIONS,
   missingActionMessage "profile" PROFILE_ACTIONS, missingActionMessage "sessions" SESSIONS_ACTIONS]

/-- The `--profile` tokens a profile field stands for. -/
def profileTokens : Option String → List String
  | none => []
  | some name => [PROFILE_FLAG, name]

/-- The token a boolean field stands for. -/
def flagIf (flag : String) : Bool → List String
  | true => [flag]
  | false => []

/-- The argv a parsed command stands for, with its flags in one canonical order. -/
def CliCommand.canonicalArgv : CliCommand → List String
  | .setup name resume => "setup" :: (profileTokens name ++ flagIf "--resume" resume)
  | .doctor name json => "doctor" :: (profileTokens name ++ flagIf "--json" json)
  | .status name json => "status" :: (profileTokens name ++ flagIf "--json" json)
  | .service action name => "service" :: action :: profileTokens name
  | .profile action name json => "profile" :: action :: (profileTokens name ++ flagIf "--json" json)
  | .sessions action name rest => "sessions" :: action :: (profileTokens name ++ rest)
  | .help => ["help"]
  | .version => ["version"]

/-! ## (a) Every token is consumed exactly once -/

/-- args.ts:4 "Every token is consumed exactly once"; args.ts:120 "Walk `tokens` against
`grammar`, consuming every one exactly once." -/
def ConsumesEveryTokenOnce : Prop :=
  ∀ tokens grammar command parsed, parseArguments tokens grammar command = .ok parsed →
    (parsed.positionals ++ flagTokens parsed.flags).Perm tokens

/-- args.ts:4 at the level of `parseCli`: a successful result, written back out, is the argv up to
order. `help` and `version` have three spellings each (args.ts:62-63). -/
def CliConsumesEveryTokenOnce : Prop :=
  ∀ argv command, parseCli argv = .ok command →
    (command = .help ∧ ∃ token ∈ HELP_TOKENS, argv = [token]) ∨
    (command = .version ∧ ∃ token ∈ VERSION_TOKENS, argv = [token]) ∨
    command.canonicalArgv.Perm argv

/-! ## (b) No flag twice -/

/-- args.ts:15 "a repeated flag … [is a] `CliArgError`"; args.ts:10-11 "`--profile preview
--profile production` silently kept the first and dropped the second". -/
def NoFlagTwice : Prop :=
  ∀ tokens grammar command parsed, parseArguments tokens grammar command = .ok parsed →
    (parsed.flags.map (·.1)).Nodup

/-! ## (c) Every flag is declared, with its kind -/

/-- args.ts:14-16 "an unrecognised flag, a flag valid for a *different* command, … a missing
value … are all `CliArgError`". -/
def FlagsDeclared : Prop :=
  ∀ tokens grammar command parsed, parseArguments tokens grammar command = .ok parsed →
    ∀ entry ∈ parsed.flags, grammar.flags.lookup entry.1 = some entry.2.kind

/-! ## (d) `--profile` is a value flag everywhere, so args.ts:174 is dead -/

/-- args.ts:75 `const PROFILE_ONLY = { [PROFILE_FLAG]: 'value' }`, and args.ts:283 "The handler's
own flags, plus `--profile`, which this layer consumes." -/
def ProfileIsValueFlag : Prop :=
  ∀ grammar ∈ grammarsUsed, grammar.flags.lookup PROFILE_FLAG = some .value

/-- args.ts:289-290 `{ ...handlerFlags, ...PROFILE_ONLY }`: spread last, `--profile` is a value
flag whatever the handler's table says about it. -/
def ProfileSpreadLastWins : Prop :=
  ∀ handlerFlags : FlagTable, (spread handlerFlags PROFILE_ONLY).lookup PROFILE_FLAG = some .value

/-- args.ts:174 `if (value === true) throw …` is unreachable from `parseCli`: whatever that line
did instead, `parseCli` would return the same thing for every argv. -/
def ReadProfileTrueBranchDead : Prop :=
  ∀ outcome argv, parseCliWith (readProfileReplacing174 outcome) argv = parseCli argv

/-! ## (e) The sessions tail is a re-ordering -/

/-- args.ts:202-204 "This is re-ordering, not re-interpretation: only tokens the operator
actually typed are emitted, `--profile` (consumed by this layer) is dropped, and every flag keeps
its value."; args.ts:207 "Positional first". Every flag stays next to its own value. -/
def SessionsTailReordered : Prop :=
  ∀ action tail command parsed,
    parseArguments tail (sessionsGrammar action) command = .ok parsed →
    ∃ entries, entries.Perm (parsed.flags.filter (·.1 != PROFILE_FLAG)) ∧
      normalizeSessionsArgv parsed (sessionsHandlerFlags action) =
        parsed.positionals ++ flagTokens entries

/-- args.ts:202-203, as a statement about the typed tail: the handler receives a permutation of
the tail with the `--profile <value>` pair taken out. -/
def SessionsTailIsTailWithoutProfile : Prop :=
  ∀ action tail command parsed,
    parseArguments tail (sessionsGrammar action) command = .ok parsed →
    (normalizeSessionsArgv parsed (sessionsHandlerFlags action)).Perm
      (removeFlagPair PROFILE_FLAG tail)

/-! ## (f) The session key is `args[0]` -/

/-- args.ts:195-200 "The handler's `parseShowArgs` reads the session key as `args[0]` … The strict
parser already knows which token was the positional, so it emits the key first and the flags
after it."; args.ts:207-208 "an absent key still yields an empty lead, so the handler reaches
its historical usage line". The handler treats a leading `-` as "no key"
(src/cli/sessions.ts:426). -/
def SessionsShowKeyFirst : Prop :=
  ∀ tail profile rest,
    parseCli ("sessions" :: "show" :: tail) = .ok (.sessions "show" profile rest) →
    ∃ parsed, parseArguments tail (sessionsGrammar "show") "sessions show" = .ok parsed ∧
      rest = normalizeSessionsArgv parsed SESSIONS_SHOW_FLAGS ∧
      ((parsed.positionals = [] ∧ ∀ token ∈ rest, jsStartsWith token "--" = true) ∨
       (∃ key flags, parsed.positionals = [key] ∧ rest = key :: flags ∧
          isOptionToken key = false ∧ ∀ token ∈ flags, jsStartsWith token "--" = true))

/-! ## (g) Stray positionals are refused -/

/-- args.ts:161-163: a successful parse never holds more positionals than the grammar allows. -/
def PositionalsWithinMax : Prop :=
  ∀ tokens grammar command parsed, parseArguments tokens grammar command = .ok parsed →
    parsed.positionals.length ≤ grammar.maxPositionals

/-- args.ts:16 "a stray positional … [is a] `CliArgError`": for every command that takes no
positional, a non-option token where an option could start makes `parseCli` fail, whatever
precedes and follows it. -/
def StrayPositionalRejected : Prop :=
  ∀ head ∈ zeroPositionalHeads, ∀ before stray after done result,
    walk head.2.1 head.2.2 before { flags := [], positionals := [] } = .ok done →
    isOptionToken stray = false →
    parseCli (head.1 ++ before ++ stray :: after) ≠ .ok result

/-! ## (h) `help` and `version` stand alone -/

/-- args.ts:239-240 "somawork help | --help | -h", "somawork version | --version | -V", and
args.ts:252, 256 `assertNoExtraTokens`. -/
def HelpVersionStandAlone : Prop :=
  (∀ token ∈ HELP_TOKENS, parseCli [token] = .ok .help ∧
    ∀ extra more,
      parseCli (token :: extra :: more) = .error (unexpectedArgumentMessage extra "help")) ∧
  (∀ token ∈ VERSION_TOKENS, parseCli [token] = .ok .version ∧
    ∀ extra more,
      parseCli (token :: extra :: more) = .error (unexpectedArgumentMessage extra "version"))

/-! ## (i) Messages name the offending token and nothing else -/

/-- args.ts:122-124 "no other argv token is ever echoed except the offending one itself": each
`parseArguments` error names one token of the tail, and that token is the offender. -/
def ParseErrorNamesOffender : Prop :=
  ∀ tokens grammar command message, parseArguments tokens grammar command = .error message →
    message = needsMoreMessage command grammar.minPositionals ∨
    ∃ token ∈ tokens,
      (isOptionToken token = true ∧ grammar.flags.lookup token = none ∧
        message = unknownOptionMessage token grammar command) ∨
      (grammar.flags.lookup token ≠ none ∧ message = repeatedOptionMessage token) ∨
      (grammar.flags.lookup token = some .value ∧ message = requiresValueMessage token) ∨
      (isOptionToken token = false ∧ message = unexpectedArgumentMessage token command)

/-- args.ts:16-17 "Messages name the offending flag or value and nothing else from the argv":
every `parseCli` error repeats at most one argv token. -/
def CliErrorNamesOneToken : Prop :=
  ∀ argv message, parseCli argv = .error message →
    message ∈ cliErrorsNamingNothing ∨ ∃ token ∈ argv, message ∈ cliErrorsNaming token

/-! ## Dead code the proofs expose (simplification candidates) -/

/-- args.ts:164-166: no grammar `parseCli` uses requires a positional, so removing the
`minPositionals` check changes no `parseArguments` result for them. -/
def MinPositionalCheckDead : Prop :=
  ∀ grammar ∈ grammarsUsed, ∀ tokens command,
    parseArgumentsWithoutMinCheck tokens grammar command = parseArguments tokens grammar command

/-- args.ts:137: every grammar `parseCli` uses declares a flag, so `|| 'no options'` never
applies. -/
def NoOptionsFallbackDead : Prop :=
  ∀ grammar ∈ grammarsUsed,
    expectedOptions grammar = ", ".intercalate (grammar.flags.map (·.1))

end SomaVerify.CliArgs
