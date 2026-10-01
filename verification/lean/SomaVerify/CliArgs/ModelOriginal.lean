-- models: src/cli/args.ts@79eb7ffd:69-73 (Grammar, with minPositionals)
-- models: src/cli/args.ts@79eb7ffd:77-85 (COMMAND_GRAMMAR, with the sessions entry)
-- models: src/cli/args.ts@79eb7ffd:126-169 (parseArguments, with the minPositionals check)
-- models: src/cli/args.ts@79eb7ffd:137 (the `|| 'no options'` fallback)
-- models: src/cli/args.ts@79eb7ffd:171-179 (readProfile, with the `value === true` branch)
-- models: src/cli/args.ts@79eb7ffd:242-304 (parseCli, with two sessions grammar literals)
import SomaVerify.CliArgs.Model

/-!
# The model of `src/cli/args.ts` before its simplification

The phase-1 model of `args.ts` (commit 79eb7ffd), kept so `Equivalence.lean` can prove the
simplified model returns the same result for every argv.

The simplification changed only the definitions below. Every other definition of the phase-1
model (the types, tables and messages, `isOptionToken`, `readAction`, `normalizeSessionsArgv`,
`assertNoExtraTokens`, `sessionsHandlerFlags`) models TS text the simplification did not
change, and is shared with `Model.lean` unchanged. So the phase-1 model is exactly the
definitions below plus those shared ones. The definitions below are copied verbatim from the
phase-1 `Model.lean`, and their `args.ts:N` references point at `args.ts` as of 79eb7ffd.
-/

namespace SomaVerify.CliArgs.Original

open SomaVerify.JsString

/-- `interface Grammar` (args.ts:69-73). -/
structure Grammar where
  flags : FlagTable
  minPositionals : Nat
  maxPositionals : Nat

/-- The six entries of `COMMAND_GRAMMAR` (args.ts:77-85). -/
structure CommandGrammar where
  setup : Grammar
  doctor : Grammar
  status : Grammar
  service : Grammar
  profile : Grammar
  sessions : Grammar

/-- args.ts:77-85. `sessions` is never read by `parseCli` (args.ts:83); it is kept because the
TS table has it. -/
def COMMAND_GRAMMAR : CommandGrammar where
  setup := ⟨spread PROFILE_ONLY [("--resume", .boolean)], 0, 0⟩
  doctor := ⟨spread PROFILE_ONLY [("--json", .boolean)], 0, 0⟩
  status := ⟨spread PROFILE_ONLY [("--json", .boolean)], 0, 0⟩
  service := ⟨PROFILE_ONLY, 0, 0⟩
  profile := ⟨spread PROFILE_ONLY [("--json", .boolean)], 0, 0⟩
  sessions := ⟨PROFILE_ONLY, 0, 0⟩

/-- args.ts:137: `Object.keys(grammar.flags).join(', ') || 'no options'` -/
def expectedOptions (grammar : Grammar) : String :=
  let joined := ", ".intercalate (grammar.flags.map (·.1))
  if joined.isEmpty then "no options" else joined

/-- args.ts:136-138 -/
def unknownOptionMessage (token : String) (grammar : Grammar) (command : String) : String :=
  s!"Unknown option \"{token}\" for \"{command}\". Expected one of: {expectedOptions grammar}."

/-- args.ts:165 -/
def needsMoreMessage (command : String) (count : Nat) : String :=
  s!"\"{command}\" needs {count} more argument(s)."

/-- The loop of args.ts:130-159. The head of the list is `tokens[i]`; the head of the rest is
`tokens[i + 1]`, and a value flag continues after it (`i += 1` then `i++`). -/
def walk (grammar : Grammar) (command : String) : List String → Parsed → Except String Parsed
  | [], parsed => .ok parsed
  | token :: tokens, parsed =>
    if isOptionToken token then
      match grammar.flags.lookup token with
      | none => .error (unknownOptionMessage token grammar command)
      | some kind =>
        if parsed.has token then .error (repeatedOptionMessage token)
        else
          match kind with
          | .boolean =>
            walk grammar command tokens { parsed with flags := parsed.flags ++ [(token, .present)] }
          | .value =>
            match tokens with
            | [] => .error (requiresValueMessage token)
            | value :: tokens' =>
              if jsStartsWith value "--" then .error (requiresValueMessage token)
              else
                walk grammar command tokens'
                  { parsed with flags := parsed.flags ++ [(token, .str value)] }
    else
      walk grammar command tokens { parsed with positionals := parsed.positionals ++ [token] }

/-- `parseArguments` (args.ts:126-169). `positionals[grammar.maxPositionals]` is in range
whenever it is read, so the `getD` default is never used. -/
def parseArguments (tokens : List String) (grammar : Grammar) (command : String) :
    Except String Parsed :=
  match walk grammar command tokens { flags := [], positionals := [] } with
  | .error message => .error message
  | .ok parsed =>
    if parsed.positionals.length > grammar.maxPositionals then
      .error (unexpectedArgumentMessage (parsed.positionals.getD grammar.maxPositionals "") command)
    else if parsed.positionals.length < grammar.minPositionals then
      .error (needsMoreMessage command grammar.minPositionals)
    else
      .ok parsed

/-- `readProfile` (args.ts:171-179). The result is the profile name itself (`ProfileName` is a
string union). -/
def readProfile (parsed : Parsed) : Except String (Option String) :=
  match parsed.get PROFILE_FLAG with
  | none => .ok none
  | some .present => .error (requiresValueMessage PROFILE_FLAG)
  | some (.str value) =>
    if !isProfileName value then
      .error (invalidProfileMessage value)
    else
      .ok (some value)

/-- args.ts:287-290: the handler's own table with `PROFILE_ONLY` spread after it; `show` takes
one optional positional (the session key). -/
def sessionsGrammar (action : String) : Grammar :=
  let handlerFlags := sessionsHandlerFlags action
  if action = "list" then
    ⟨spread handlerFlags PROFILE_ONLY, 0, 0⟩
  else
    ⟨spread handlerFlags PROFILE_ONLY, 0, 1⟩

/-- `parseCli` (args.ts:242-304) with the profile reader as a parameter. The `switch` arms
`case 'doctor': case 'status':` share one body in the TS (args.ts:265-269); here each tag has
its own arm with that body. -/
def parseCliWith (readProfile : Parsed → Except String (Option String)) (argv : List String) :
    Except String CliCommand :=
  match argv with
  | [] => .error missingCommandMessage
  | command :: rest =>
    if HELP_TOKENS.contains command then do
      assertNoExtraTokens rest "help"
      pure .help
    else if VERSION_TOKENS.contains command then do
      assertNoExtraTokens rest "version"
      pure .version
    else
      match command with
      | "setup" => do
        let parsed ← parseArguments rest COMMAND_GRAMMAR.setup "setup"
        let profile ← readProfile parsed
        pure (.setup profile (parsed.has "--resume"))
      | "doctor" => do
        let parsed ← parseArguments rest COMMAND_GRAMMAR.doctor "doctor"
        let profile ← readProfile parsed
        pure (.doctor profile (parsed.has "--json"))
      | "status" => do
        let parsed ← parseArguments rest COMMAND_GRAMMAR.status "status"
        let profile ← readProfile parsed
        pure (.status profile (parsed.has "--json"))
      | "service" => do
        let action ← readAction rest "service" SERVICE_ACTIONS
        let parsed ← parseArguments (rest.drop 1) COMMAND_GRAMMAR.service "service"
        let profile ← readProfile parsed
        pure (.service action profile)
      | "profile" => do
        let action ← readAction rest "profile" PROFILE_ACTIONS
        let parsed ← parseArguments (rest.drop 1) COMMAND_GRAMMAR.profile "profile"
        let profile ← readProfile parsed
        pure (.profile action profile (parsed.has "--json"))
      | "sessions" => do
        let action ← readAction rest "sessions" SESSIONS_ACTIONS
        let parsed ← parseArguments (rest.drop 1) (sessionsGrammar action) s!"sessions {action}"
        let profile ← readProfile parsed
        pure (.sessions action profile
          (normalizeSessionsArgv parsed (sessionsHandlerFlags action)))
      | _ => .error (unknownCommandMessage command)

/-- `parseCli` (args.ts:242-304). -/
def parseCli (argv : List String) : Except String CliCommand :=
  parseCliWith readProfile argv

end SomaVerify.CliArgs.Original
