import SomaVerify.Support.Json
import SomaVerify.Support.Vectors
import SomaVerify.CliArgs.Model

/-!
# Conformance vectors for `SomaVerify.CliArgs`

Each case is an argv and what the model's `parseCli` returns for it: the command object, or
`{"error": <message>}` for a `CliArgError`. `src/cli/__tests__/args.lean-conformance.test.ts`
replays every case against the real `parseCli`.

The domain, deduplicated by construction (the three parts differ in length or in tokens):

1. `shortArgvs`: every argv of length 0..2 over `vocabulary` (every command, help and version
   token, action, flag, profile name, and the edge tokens). This covers every dispatch branch
   and every flag directly after every command.
2. `tailArgvs`: for each command head that reaches `parseArguments` (`setup`, `doctor`,
   `status`, and each action of `service`, `profile`, `sessions`), every tail of length up to
   2 over all flags and edge tokens, and every tail of length 3 over the head's own flags, one
   flag that belongs to another command, and the edge tokens. That is every argv of length
   3..4 (3..5 after an action) over the head's vocabulary.
3. `targetedArgvs`: longer and odd inputs: the filter sets and orderings from `args.test.ts`,
   error priority, quoting and escaping in messages, empty strings, `Object.prototype` names,
   case variants.

Every argv of length up to 4 over the whole vocabulary would be about 1.5 million cases; the
parser only ever looks at one command head at a time, so part 2 is exhaustive per head instead.

Run by `scripts/verification/lean-verify.sh` (`lake env lean --run`); the output is
`verification/vectors/cli-args.json`.
-/

namespace SomaVerify.CliArgs.Vectors

open SomaVerify SomaVerify.CliArgs

/-- Every flag any grammar `parseCli` uses declares, in first-seen order. -/
def allFlags : List String :=
  ((COMMAND_GRAMMAR.setup.flags ++ COMMAND_GRAMMAR.doctor.flags ++ COMMAND_GRAMMAR.status.flags ++
      COMMAND_GRAMMAR.service.flags ++ COMMAND_GRAMMAR.profile.flags ++
      (sessionsGrammar "list").flags ++ (sessionsGrammar "show").flags).map (·.1)).eraseDups

/-- Tokens that are neither commands nor flags: both profile names, a stray word, a value word,
a lone `-` (a positional, args.ts:133), `-x` (an option token, but accepted as a value,
args.ts:150) and `--` (an option token, refused as a value). -/
def edgeTokens : List String :=
  PROFILE_NAMES ++ ["extra", "U1", "-", "-x", "--"]

/-- The vocabulary of `shortArgvs`. -/
def vocabulary : List String :=
  (PUBLIC_COMMANDS ++ HELP_TOKENS ++ VERSION_TOKENS ++ SERVICE_ACTIONS ++ PROFILE_ACTIONS ++
    SESSIONS_ACTIONS ++ allFlags ++ edgeTokens).eraseDups

/-- The sizes above, pinned so a table change is visible here: 6 commands, 6 help and version
tokens, 7 more actions (`status`, `list` and `show` are shared), 9 flags, 7 edge tokens. -/
theorem vocabulary_spec : allFlags.length = 9 ∧ vocabulary.length = 35 := by
  decide

/-- All lists of exactly `n` tokens over `vocab`, ordered by vocabulary position. -/
def wordsOfLength (vocab : List String) : Nat → List (List String)
  | 0 => [[]]
  | n + 1 => (wordsOfLength vocab n).flatMap fun w => vocab.map fun t => w ++ [t]

/-- Part 1: every argv of length 0..2 over `vocabulary`. -/
def shortArgvs : List (List String) :=
  (List.range 3).flatMap (wordsOfLength vocabulary)

/-- A command head that reaches `parseArguments`, the grammar it uses, and a flag that is valid
for some other command but not for this one. -/
structure Head where
  argv : List String
  grammar : Grammar
  foreignFlag : String

/-- Every head `parseCli` accepts before walking the tail. -/
def heads : List Head :=
  [⟨["setup"], COMMAND_GRAMMAR.setup, "--json"⟩,
   ⟨["doctor"], COMMAND_GRAMMAR.doctor, "--resume"⟩,
   ⟨["status"], COMMAND_GRAMMAR.status, "--resume"⟩] ++
  SERVICE_ACTIONS.map (fun a => ⟨["service", a], COMMAND_GRAMMAR.service, "--json"⟩) ++
  PROFILE_ACTIONS.map (fun a => ⟨["profile", a], COMMAND_GRAMMAR.profile, "--resume"⟩) ++
  [⟨["sessions", "list"], sessionsGrammar "list", "--conversation"⟩,
   ⟨["sessions", "show"], sessionsGrammar "show", "--user"⟩]

/-- Part 2 for one head: tails of length 0..2 over all flags and edge tokens, and tails of
length 3 over the head's own flags, its foreign flag and the edge tokens. Argvs of length 2 or
less are already in part 1. -/
def headArgvs (h : Head) : List (List String) :=
  let short := (List.range 3).flatMap (wordsOfLength (allFlags ++ edgeTokens))
  let long := wordsOfLength (h.grammar.flags.map (·.1) ++ [h.foreignFlag] ++ edgeTokens) 3
  ((short ++ long).map (h.argv ++ ·)).filter (·.length ≥ 3)

/-- Part 2. -/
def tailArgvs : List (List String) :=
  heads.flatMap headArgvs

/-- Part 3. None of these is in part 1 or 2 (the conformance test checks that no argv repeats). -/
def targetedArgvs : List (List String) :=
  [ -- args.test.ts: the full list filter set, and the normalized orderings
    ["sessions", "list", "--user", "U1", "--model", "opus", "--since", "2026-01-01",
      "--until", "2026-02-01", "--limit", "5", "--json"],
    ["sessions", "list", "--json", "--limit", "5", "--model", "opus", "--user", "U1"],
    ["sessions", "list", "--profile", "production", "--user", "U1"],
    ["sessions", "show", "k", "--conversation", "--json", "--profile", "preview"],
    ["sessions", "show", "--profile", "preview", "k", "--json"],
    ["sessions", "show", "--conversation", "k", "--json"],
    ["sessions", "show", "abc", "--profile", "preview", "--conversation"],
    ["sessions", "show", "--json", "k"],
    ["sessions", "list", "--model", "opus"],
    ["doctor", "--profile", "preview", "--profile", "production"],
    ["sessions", "show", "k", "--user", "U1"],
    ["sessions", "show", "k", "--raw"],
    ["sessions", "show", "k", "--conversation", "--conversation"],
    ["_capture-slack-auth", "--socket", "/tmp/s"],
    ["_print-slack-manifest", "--manifest", "/tmp/m.json"],
    -- every list filter, reversed, with --profile in the middle
    ["sessions", "list", "--json", "--limit", "5", "--profile", "preview", "--until", "2026-02-01",
      "--since", "2026-01-01", "--model", "opus", "--user", "U1"],
    -- the session key in every position, around --profile and both handler flags
    ["sessions", "show", "--json", "--profile", "preview", "k"],
    ["sessions", "show", "--profile", "production", "--conversation", "k", "--json"],
    ["sessions", "show", "--conversation", "--json", "--profile", "preview", "k"],
    ["sessions", "show", "k", "--json", "--conversation", "--profile", "production"],
    -- error priority: walk errors, then the positional count, then the profile value
    ["setup", "now", "--bogus"],
    ["sessions", "show", "--profile", "staging", "a", "b"],
    ["sessions", "show", "--profile", "staging", "--bogus"],
    ["service", "nuke", "--bogus"],
    ["sessions", "list", "--user", "U1", "--model", "opus", "--user", "U2"],
    ["setup", "--resume", "--profile", "preview", "now"],
    ["profile", "remove", "--json", "--profile", "preview", "--json"],
    -- help and version with several extra tokens
    ["help", "--json", "extra"],
    ["-V", "-V", "-V"],
    ["--help", "setup", "--profile", "preview"],
    ["version", "sessions", "list", "--json"],
    -- values: a single dash is a value, a double dash is not
    ["sessions", "list", "--limit", "-5"],
    ["sessions", "list", "--limit", "--5"],
    ["sessions", "list", "--since", "-", "--until", "-x"],
    -- quoting and escaping inside messages and values
    ["setup", "a\"b"],
    ["doctor", "--profile", "back\\slash"],
    ["status", "--bad\"flag"],
    ["line\nbreak"],
    ["sessions", "list", "--user", "tab\there"],
    ["setup", "--profile", "préview"],
    ["setup", "—json"],
    ["doctor", "--json", "😀"],
    ["service", "stop", "--profile", "production", " "],
    -- empty strings
    [""],
    ["setup", ""],
    ["setup", "--profile", ""],
    ["service", ""],
    ["sessions", "list", "--user", ""],
    ["sessions", "show", ""],
    ["help", ""],
    -- Object.prototype names, as flags, commands and actions
    ["setup", "--constructor"],
    ["setup", "--__proto__"],
    ["doctor", "--toString"],
    ["status", "--hasOwnProperty"],
    ["profile", "list", "-constructor"],
    ["constructor"],
    ["__proto__"],
    ["toString"],
    ["service", "constructor"],
    ["sessions", "__proto__"],
    ["profile", "hasOwnProperty"],
    ["sessions", "show", "__proto__"],
    -- case and spelling variants
    ["Setup"],
    ["HELP"],
    ["-H"],
    ["-v"],
    ["--Help"],
    ["setup", "--RESUME"],
    ["doctor", "--Json"],
    ["doctor", "--json=true"],
    ["setup", "--profile=preview"],
    ["doctor", "---json"],
    ["doctor", "-json"],
    ["service", "Start"],
    ["setup", "--profile", "Preview"] ]

/-- The model's `parseCli` result for a profile field: `null` stands for `profile: undefined`. -/
def profileJson : Option String → Json
  | none => .null
  | some name => .str name

/-- The command object `parseCli` returns, field for field. -/
def commandJson : CliCommand → Json
  | .setup profile resume =>
    .obj [("command", .str "setup"), ("profile", profileJson profile), ("resume", .bool resume)]
  | .doctor profile json =>
    .obj [("command", .str "doctor"), ("profile", profileJson profile), ("json", .bool json)]
  | .status profile json =>
    .obj [("command", .str "status"), ("profile", profileJson profile), ("json", .bool json)]
  | .service action profile =>
    .obj [("command", .str "service"), ("action", .str action), ("profile", profileJson profile)]
  | .profile action profile json =>
    .obj [("command", .str "profile"), ("action", .str action), ("profile", profileJson profile),
      ("json", .bool json)]
  | .sessions action profile rest =>
    .obj [("command", .str "sessions"), ("action", .str action), ("profile", profileJson profile),
      ("rest", .arr (rest.map .str))]
  | .help => .obj [("command", .str "help")]
  | .version => .obj [("command", .str "version")]

/-- One vector: the argv and what the model says `parseCli` does with it. -/
def case (argv : List String) : Json :=
  let expect :=
    match parseCli argv with
    | .ok command => commandJson command
    | .error message => .obj [("error", .str message)]
  .obj [("argv", .arr (argv.map .str)), ("expect", expect)]

/-- The cases written to `verification/vectors/cli-args.json`. -/
def cases : List Json :=
  (shortArgvs ++ tailArgvs ++ targetedArgvs).map case

end SomaVerify.CliArgs.Vectors

def main : IO Unit :=
  IO.print (SomaVerify.Vectors.render "cli-args" ``SomaVerify.CliArgs.Vectors.cases
    SomaVerify.CliArgs.Vectors.cases)
