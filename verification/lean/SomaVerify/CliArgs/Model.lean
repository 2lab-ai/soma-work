-- models: src/cli/args.ts:55-85 (action tables, command and help/version tokens, grammars)
-- models: src/cli/args.ts:126-169 (parseArguments)
-- models: src/cli/args.ts:171-179 (readProfile)
-- models: src/cli/args.ts:181-190 (readAction)
-- models: src/cli/args.ts:206-217 (normalizeSessionsArgv)
-- models: src/cli/args.ts:219-223 (assertNoExtraTokens)
-- models: src/cli/args.ts:242-304 (parseCli)
-- models: src/cli/sessions.ts:133,171-184 (SessionsFlagKind, SESSIONS_LIST/SHOW_FLAGS)
-- models: src/cli/profile.ts:9,31-33 (PROFILE_NAMES, isProfileName)
import SomaVerify.Support.JsString

/-!
# Model of `src/cli/args.ts`

A transcription of `somawork`'s argument parser: the same tables, the same branch order, the
same early returns (`throw` is `.error`), the same message text.

JavaScript data is represented as follows.

* A `Readonly<Record<string, FlagKind>>` object literal is its list of own properties in
  `Object.keys` order (`FlagTable`). ECMA-262 OrdinaryOwnPropertyKeys lists array-index keys
  first and every other string key in creation order; every key here starts with `--`, so none
  is an array index and the order is creation order. Object literals and spreads are built with
  `defineEntry` / `spread`, so `Object.keys` order and "a later entry overwrites an earlier one"
  are computed, not assumed. `grammar.flags[token]` is `List.lookup`: the tokens looked up all
  start with `-`, and no `Object.prototype` property name does, so the prototype chain never
  answers (the conformance vectors pin `--constructor`, `--__proto__`, `--toString` and friends).
* The `Map<string, string | true>` of `ParsedArguments` is its entries in insertion order.
  `Map.prototype.set` is only called after `flags.has(token)` returned false (args.ts:140), so
  it always appends a new entry.
* `CliArgError` is `Except.error` carrying the message; nothing else is ever thrown.
* `parseCli` is `parseCliWith readProfile`. The reader is a parameter only so `Spec.lean` can
  state that removing args.ts:174 changes no result; the TS has exactly one reader.
-/

namespace SomaVerify.CliArgs

open SomaVerify.JsString

/-- `SessionsFlagKind` (src/cli/sessions.ts:133), imported as `FlagKind` (args.ts:67): whether
a flag stands alone or consumes the next token. -/
inductive FlagKind where
  | boolean
  | value
  deriving DecidableEq, Repr

/-- The own properties of a `Record<string, FlagKind>` object, in `Object.keys` order. -/
abbrev FlagTable := List (String × FlagKind)

/-- CreateDataPropertyOrThrow on an ordinary object, which is what both an object-literal entry
and each property copied by a spread do: an existing key keeps its position and takes the new
value; a new key is appended. -/
def defineEntry (table : FlagTable) (entry : String × FlagKind) : FlagTable :=
  if table.any (fun e => e.1 == entry.1) then
    table.map (fun e => if e.1 == entry.1 then entry else e)
  else
    table ++ [entry]

/-- The object literal `{ ...base, ...more }` (and `{ ...base, k: v }` with `more = [(k, v)]`):
a fresh object, then every own property of `base`, then every property of `more`, each defined
in order. -/
def spread (base more : FlagTable) : FlagTable :=
  more.foldl defineEntry (base.foldl defineEntry [])

/-- `interface Grammar` (args.ts:69-73). -/
structure Grammar where
  flags : FlagTable
  minPositionals : Nat
  maxPositionals : Nat

/-- args.ts:55 -/
def SERVICE_ACTIONS : List String := ["install", "start", "stop", "restart", "status"]
/-- args.ts:56 -/
def PROFILE_ACTIONS : List String := ["list", "show", "remove"]
/-- args.ts:57 -/
def SESSIONS_ACTIONS : List String := ["list", "show"]
/-- args.ts:60 -/
def PUBLIC_COMMANDS : List String := ["setup", "doctor", "status", "service", "profile", "sessions"]
/-- args.ts:62 (a `Set`; only `has` is used) -/
def HELP_TOKENS : List String := ["help", "--help", "-h"]
/-- args.ts:63 (a `Set`; only `has` is used) -/
def VERSION_TOKENS : List String := ["version", "--version", "-V"]
/-- args.ts:65 -/
def PROFILE_FLAG : String := "--profile"
/-- args.ts:75: `{ [PROFILE_FLAG]: 'value' }` -/
def PROFILE_ONLY : FlagTable := [(PROFILE_FLAG, .value)]

/-- src/cli/sessions.ts:171-178 -/
def SESSIONS_LIST_FLAGS : FlagTable :=
  [("--user", .value), ("--model", .value), ("--since", .value), ("--until", .value),
   ("--limit", .value), ("--json", .boolean)]

/-- src/cli/sessions.ts:181-184 -/
def SESSIONS_SHOW_FLAGS : FlagTable :=
  [("--conversation", .boolean), ("--json", .boolean)]

/-- src/cli/profile.ts:9 -/
def PROFILE_NAMES : List String := ["preview", "production"]

/-- src/cli/profile.ts:31-33 -/
def isProfileName (value : String) : Bool :=
  PROFILE_NAMES.contains value

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

/-- A value stored in `ParsedArguments.flags` (args.ts:115): `true` for a boolean flag
(`present`), or the string that followed a value flag. -/
inductive FlagValue where
  | present
  | str (value : String)
  deriving DecidableEq, Repr

/-- `interface ParsedArguments` (args.ts:114-117). -/
structure Parsed where
  flags : List (String × FlagValue)
  positionals : List String

/-- `parsed.flags.get(flag)` -/
def Parsed.get (parsed : Parsed) (flag : String) : Option FlagValue :=
  parsed.flags.lookup flag

/-- `parsed.flags.has(flag)` -/
def Parsed.has (parsed : Parsed) (flag : String) : Bool :=
  (parsed.flags.lookup flag).isSome

/-- args.ts:137: `Object.keys(grammar.flags).join(', ') || 'no options'` -/
def expectedOptions (grammar : Grammar) : String :=
  let joined := ", ".intercalate (grammar.flags.map (·.1))
  if joined.isEmpty then "no options" else joined

/-- args.ts:136-138 -/
def unknownOptionMessage (token : String) (grammar : Grammar) (command : String) : String :=
  s!"Unknown option \"{token}\" for \"{command}\". Expected one of: {expectedOptions grammar}."

/-- args.ts:141 -/
def repeatedOptionMessage (token : String) : String :=
  s!"Option \"{token}\" was given more than once."

/-- args.ts:151, and args.ts:174 with `PROFILE_FLAG` -/
def requiresValueMessage (token : String) : String :=
  s!"Option \"{token}\" requires a value."

/-- args.ts:162, and args.ts:221 -/
def unexpectedArgumentMessage (token command : String) : String :=
  s!"Unexpected argument \"{token}\" for \"{command}\"."

/-- args.ts:165 -/
def needsMoreMessage (command : String) (count : Nat) : String :=
  s!"\"{command}\" needs {count} more argument(s)."

/-- args.ts:133: `token.startsWith('-') && token !== '-'` -/
def isOptionToken (token : String) : Bool :=
  jsStartsWith token "-" && token != "-"

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

/-- args.ts:176 -/
def invalidProfileMessage (value : String) : String :=
  s!"Invalid --profile value \"{value}\". Expected one of: preview, production."

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

/-- args.ts:184 -/
def missingActionMessage (parent : String) (allowed : List String) : String :=
  s!"Missing action for \"{parent}\". Expected one of: {", ".intercalate allowed}."

/-- args.ts:187 -/
def unknownActionMessage (parent action : String) (allowed : List String) : String :=
  s!"Unknown \"{parent}\" action \"{action}\". Expected one of: {", ".intercalate allowed}."

/-- `readAction` (args.ts:181-190). `rest[0] === undefined` exactly when `rest` is empty, since
argv holds strings only. -/
def readAction (rest : List String) (parent : String) (allowed : List String) :
    Except String String :=
  match rest.head? with
  | none => .error (missingActionMessage parent allowed)
  | some action =>
    if !allowed.contains action then
      .error (unknownActionMessage parent action allowed)
    else
      .ok action

/-- `normalizeSessionsArgv` (args.ts:206-217): start from the positionals, then for each key of
the handler's table in `Object.keys` order, the flag and, unless its value is `true`, the
value. -/
def normalizeSessionsArgv (parsed : Parsed) (handlerFlags : FlagTable) : List String :=
  (handlerFlags.map (·.1)).foldl
    (fun out flag =>
      match parsed.get flag with
      | none => out
      | some .present => out ++ [flag]
      | some (.str value) => out ++ [flag, value])
    parsed.positionals

/-- `assertNoExtraTokens` (args.ts:219-223). -/
def assertNoExtraTokens (rest : List String) (command : String) : Except String Unit :=
  match rest with
  | [] => .ok ()
  | first :: _ => .error (unexpectedArgumentMessage first command)

/-- The value `parseCli` returns (`CliCommand`, args.ts:32-46). `profile = none` is the
`profile: undefined` field; `help` and `version` have no `profile` field at all. -/
inductive CliCommand where
  | setup (profile : Option String) (resume : Bool)
  | doctor (profile : Option String) (json : Bool)
  | status (profile : Option String) (json : Bool)
  | service (action : String) (profile : Option String)
  | profile (action : String) (profile : Option String) (json : Bool)
  | sessions (action : String) (profile : Option String) (rest : List String)
  | help
  | version
  deriving DecidableEq, Repr

/-- args.ts:246-248 -/
def missingCommandMessage : String :=
  s!"Missing command. Expected one of: {", ".intercalate PUBLIC_COMMANDS} (or \"help\"). " ++
    "Run \"somawork help\"."

/-- args.ts:300-302 -/
def unknownCommandMessage (command : String) : String :=
  s!"Unknown command \"{command}\". Expected one of: " ++
    s!"{", ".intercalate PUBLIC_COMMANDS} (or \"help\")."

/-- args.ts:286: `action === 'list' ? SESSIONS_LIST_FLAGS : SESSIONS_SHOW_FLAGS` -/
def sessionsHandlerFlags (action : String) : FlagTable :=
  if action = "list" then SESSIONS_LIST_FLAGS else SESSIONS_SHOW_FLAGS

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

end SomaVerify.CliArgs
