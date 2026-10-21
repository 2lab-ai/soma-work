import SomaVerify.Support.Json
import SomaVerify.Support.Vectors
import SomaVerify.ToolPolicy.Model

/-!
# Conformance vectors for `SomaVerify.ToolPolicy`

`verification/vectors/tool-policy.json` holds seven kinds of case, told apart by `kind`.

Replayed by `tool-policy.lean-conformance.test.ts`, which mocks the guard primitives with each
row's `prims` and calls the real `evaluateToolPolicy` once per entry of `calls`. Every call also
carries `sensitiveCall`, the sensitive-path check and arguments the model says the policy passes
it (`sensitiveCall`, `null` for none); the mocked checks answer only that exact call and throw on
any other, so a wrong argument or a wrong check fails the replay.

* `table`: the truth table. Every combination of mode, `isAdmin`, `aborted`, handoff presence
  and the six primitive values, each either silent or firing with a fixed payload:
  3 × 2^9 = 1536 rows. Each row has nine calls, one per path through the tool-name tests of the
  TS: Bash, Read, Glob, Grep with and without a path, a native tool without a sensitive-path
  check, the PR-create MCP tool, another `mcp__` tool, and a tool the policy does not govern.
* `tool-names`: every native tool and a set of near misses (case, spacing, look-alike letters,
  prefixes, the empty name), with no primitive firing, each firing alone, and all firing, in
  every mode, for admins and non-admins.
* `boundary`: the payloads the table holds fixed. A sensitive result without a reason or with
  an empty one, an empty MCP deny reason, PR-issue results without a reason or a message,
  empty and longer rule-id lists, Grep `path` values that are empty, blank, not strings or
  missing, and undefined tool inputs.
* `arguments`: Glob, Read, Bash and Grep inputs that differ only in the properties the
  sensitive-path call takes its arguments from (a string, the empty string, other values, a
  missing property), with the other candidate properties present, so an argument read from the
  wrong property changes the call.
* `incident`: the only rows with an `incidentReadOnly` context. Every allowlist of
  `incidentAllowLists` (the live one, exact names, an empty list, a wildcard-looking entry, a
  prefix, native tool names, the PR-create tool) with every pattern of `patterns` (nothing
  firing, each deny condition alone, a dangerous Bash, everything at once), in every mode, for
  admins and non-admins. Each row calls the allow-listed tools, near misses of them, native tools
  including `Task` and `Agent`, and tools the policy has never heard of.

Replayed by `tool-policy.concrete.lean-conformance.test.ts` against the real modules, no mocks:

* `constants`: `NATIVE_BYPASS_TOOLS`, `TOOL_POLICY_MATCHERS` and
  `INCIDENT_TOOL_POLICY_MATCHERS` as the model has them.
* `concrete`: real tool calls, some in an incident session. Each lists the primitive calls the
  policy makes for it, with the values the test first checks against the real primitives; the
  model's input is built from the same values, so a vector cannot assert one thing and model
  another. The sensitive-path entry is the model's `sensitiveCall` for the case's input, not
  written by hand.

Run by `scripts/verification/lean-verify.sh` (`lake env lean --run`); the output is
`verification/vectors/tool-policy.json`.
-/

namespace SomaVerify.ToolPolicy.Vectors

open SomaVerify SomaVerify.ToolPolicy

/-! ## JSON for the values the tests pass to the TS or compare with its result -/

def modeName : Mode → String
  | .auto => "auto"
  | .bypass => "bypass"
  | .legacy => "legacy"

def decisionName : Decision → String
  | .allow => "allow"
  | .deny => "deny"
  | .classify => "classify"
  | .pass => "pass"

/-- An optional string property: present with its value, or left out. -/
def opt (key : String) : Option String → List (String × Json)
  | some v => [(key, .str v)]
  | none => []

def strs (xs : List String) : Json :=
  .arr (xs.map .str)

/-- `ToolPolicyResult`, without the properties the TS leaves `undefined`. -/
def resultJson (r : Result) : Json :=
  .obj ([("decision", .str (decisionName r.decision)), ("reason", .str r.reason)] ++
    opt "denyMessage" r.denyMessage ++
    match r.matchedRuleIds with
    | some ids => [("matchedRuleIds", strs ids)]
    | none => [])

def sensitiveJson (s : SensitivePathResult) : Json :=
  .obj ([("isSensitive", .bool s.isSensitive)] ++ opt "reason" s.reason)

def prIssueJson (p : PrIssueGuardResult) : Json :=
  .obj ([("blocked", .bool p.blocked)] ++ opt "reason" p.reason ++ opt "message" p.message)

def bashJson (b : BashPermission) : Json :=
  .obj [("decision", .str (match b.decision with | .allow => "allow" | .ask => "ask")),
    ("matchedRuleIds", strs b.matchedRuleIds)]

def mcpJson : Option String → Json
  | some s => .str s
  | none => .null

/-- A sensitive-path call as the tests expect it: the check's name and its arguments, a Glob base
path that is `undefined` written as `null`; `null` for no call. -/
def sensitiveCallJson : Option SensitiveCall → Json
  | some (.bash command) => .obj [("fn", .str "checkBashSensitivePaths"), ("args", strs [command])]
  | some (.path filePath) => .obj [("fn", .str "checkSensitivePath"), ("args", strs [filePath])]
  | some (.glob pattern basePath) =>
    .obj [("fn", .str "checkSensitiveGlob"), ("args", .arr [.str pattern, (basePath.map .str).getD .null])]
  | none => .null

/-- `IncidentReadOnlyContext`, with the TS field name. -/
def incidentJson (inc : IncidentReadOnly) : Json :=
  .obj [("allowedMcpTools", strs inc.allowedMcpTools)]

/-- The `incidentReadOnly` property: present with its value, or left out. -/
def incidentProp : Option IncidentReadOnly → List (String × Json)
  | some inc => [("incidentReadOnly", incidentJson inc)]
  | none => []

def primsJson (p : Primitives) : Json :=
  .obj [("ssh", .bool p.ssh), ("sensitive", sensitiveJson p.sensitive),
    ("crossUser", .bool p.crossUser), ("mcpDenied", mcpJson p.mcpDenied),
    ("prIssue", prIssueJson p.prIssue), ("bash", bashJson p.bash)]

/-! ## Mocked rows -/

/-- A context and the primitive values its calls share. -/
structure Row where
  mode : Mode
  isAdmin : Bool
  aborted : Bool
  handoff : Bool
  prims : Primitives
  /-- `ctx.incidentReadOnly`; `none` leaves it undefined -/
  incident : Option IncidentReadOnly := none

/-- A call: the tool name and the exact `toolInput` handed to the TS (`none` is `undefined`). -/
structure Call where
  tool : String
  input : Option Json

def Row.toInput (r : Row) (c : Call) : Input :=
  { toolName := c.tool, command := jsonField "command" c.input,
    filePath := jsonField "file_path" c.input, pattern := jsonField "pattern" c.input,
    path := jsonField "path" c.input, isAdmin := r.isAdmin, mode := r.mode,
    aborted := r.aborted, handoff := r.handoff, prims := r.prims }

def callJson (r : Row) (c : Call) : Json :=
  .obj [("tool", .str c.tool), ("input", c.input.getD .null),
    ("sensitiveCall", sensitiveCallJson (sensitiveCall (r.toInput c))),
    ("expect", resultJson (evaluateToolPolicy r.incident (r.toInput c)))]

def rowJson (kind : String) (calls : List Call) (r : Row) : Json :=
  .obj ([("kind", .str kind), ("mode", .str (modeName r.mode)), ("isAdmin", .bool r.isAdmin),
    ("aborted", .bool r.aborted), ("handoff", .bool r.handoff), ("prims", primsJson r.prims)] ++
    incidentProp r.incident ++
    [("calls", .arr (calls.map (callJson r)))])

/-- Every primitive silent: nothing sensitive, no deny reason, not blocked, not dangerous. -/
def quiet : Primitives :=
  { ssh := false, sensitive := { isSensitive := false }, crossUser := false, mcpDenied := none,
    prIssue := { blocked := false }, bash := { decision := .allow, matchedRuleIds := [] } }

def sensitiveHit : SensitivePathResult :=
  { isSensitive := true, reason := some "sensitive-reason" }

def mcpReason : String := "mcp-reason"

/-- A block with a `PrIssueGuardReason` and a message. -/
def prBlocked : PrIssueGuardResult :=
  { blocked := true, reason := some "missing-closes-issue", message := some "pr-message" }

def bashAsk : BashPermission :=
  { decision := .ask, matchedRuleIds := ["rule-a"] }

def bools : List Bool := [false, true]

def modes : List Mode := [.auto, .bypass, .legacy]

/-- The 64 combinations of the six primitive values. -/
def tablePrims : List Primitives :=
  bools.flatMap fun ssh =>
  bools.flatMap fun sensitive =>
  bools.flatMap fun crossUser =>
  bools.flatMap fun mcp =>
  bools.flatMap fun pr =>
  bools.map fun ask =>
    { ssh,
      sensitive := if sensitive then sensitiveHit else quiet.sensitive,
      crossUser,
      mcpDenied := if mcp then some mcpReason else none,
      prIssue := if pr then prBlocked else quiet.prIssue,
      bash := if ask then bashAsk else quiet.bash }

/-- The truth table's rows: mode × `isAdmin` × `aborted` × handoff × `tablePrims`. -/
def tableRows : List Row :=
  modes.flatMap fun mode =>
  bools.flatMap fun isAdmin =>
  bools.flatMap fun aborted =>
  bools.flatMap fun handoff =>
  tablePrims.map fun prims => { mode, isAdmin, aborted, handoff, prims }

/-- An empty tool input, `{}`. -/
def empty : Option Json := some (.obj [])

/-- A Grep input whose `path` is a non-empty string, so the sensitive-path check runs. -/
def grepPath : Option Json := some (.obj [("path", .str "/tmp/U0VECTOR01/src")])

/-- One call per path through the TS tests on the tool name. -/
def tableCalls : List Call :=
  [⟨"Bash", empty⟩, ⟨"Read", empty⟩, ⟨"Glob", empty⟩, ⟨"Grep", grepPath⟩, ⟨"Grep", empty⟩,
    ⟨"Write", empty⟩, ⟨prCreateMcpTool, empty⟩, ⟨"mcp__server-tools__db_query", empty⟩,
    ⟨"Skill", empty⟩]

/-- Every native tool, then names that must not be mistaken for Bash, a native tool or the
PR-create tool, and names that must count as `mcp__` tools. `"Bаsh"` has a Cyrillic `а`. -/
def toolNames : List Call :=
  nativeBypassTools.map (fun t => ⟨t, if t = "Grep" then grepPath else empty⟩) ++
  ["Bash", prCreateMcpTool, "mcp__server-tools__db_query", "mcp__x__y", "mcp__",
    "mcp__github__create_pull_requests", "mcp__github__create_pull_reques", "bash", "BASH",
    "Bash ", " Bash", "BashOutput", "Bаsh", "read", "WRITE", "Grep2", "Web Fetch", "mcp_",
    "mcp_github_create_pull_request", "MCP__x__y", "xmcp__y", "", "Skill", "ExitPlanMode",
    "AskUserQuestion"].map (fun t => ⟨t, empty⟩)

def allFiring : Primitives :=
  { ssh := true, sensitive := sensitiveHit, crossUser := true, mcpDenied := some mcpReason,
    prIssue := prBlocked, bash := bashAsk }

/-- `(aborted, handoff, prims)`: nothing firing, each deny condition's inputs alone, a dangerous
Bash alone, and everything at once. -/
def patterns : List (Bool × Bool × Primitives) :=
  [(false, false, quiet),
    (true, false, quiet),
    (false, false, { quiet with ssh := true }),
    (false, false, { quiet with sensitive := sensitiveHit }),
    (false, false, { quiet with crossUser := true }),
    (false, false, { quiet with mcpDenied := some mcpReason }),
    (false, true, { quiet with prIssue := prBlocked }),
    (false, false, { quiet with bash := bashAsk }),
    (true, true, allFiring)]

def namesRows : List Row :=
  modes.flatMap fun mode =>
  bools.flatMap fun isAdmin =>
  patterns.map fun (aborted, handoff, prims) => { mode, isAdmin, aborted, handoff, prims }

/-- A non-admin auto-mode row without abort or handoff. -/
def autoRow (prims : Primitives) : Row :=
  { mode := .auto, isAdmin := false, aborted := false, handoff := false, prims }

def sensitiveCalls : List Call :=
  [⟨"Bash", empty⟩, ⟨"Read", empty⟩, ⟨"Glob", empty⟩, ⟨"Grep", grepPath⟩, ⟨"Write", empty⟩]

def mcpCalls : List Call :=
  [⟨"mcp__server-tools__db_query", empty⟩, ⟨prCreateMcpTool, empty⟩, ⟨"mcp__", empty⟩,
    ⟨"Bash", empty⟩, ⟨"Read", empty⟩]

def prCalls : List Call :=
  [⟨"Bash", empty⟩, ⟨prCreateMcpTool, empty⟩, ⟨"Read", empty⟩,
    ⟨"mcp__server-tools__db_query", empty⟩]

/-- Grep `path` values of every kind `typeof v === 'string' && v` distinguishes, and undefined
tool inputs for the tools whose checks read the input. -/
def pathCalls : List Call :=
  [⟨"Grep", some (.obj [("path", .str "")])⟩, ⟨"Grep", some (.obj [("path", .str " ")])⟩,
    ⟨"Grep", some (.obj [("path", .num 7)])⟩, ⟨"Grep", some (.obj [("path", .null)])⟩,
    ⟨"Grep", some (.obj [("path", .bool true)])⟩, ⟨"Grep", some (.obj [("path", .obj [])])⟩,
    ⟨"Grep", some (.obj [("pattern", .str "TODO")])⟩, ⟨"Grep", none⟩, ⟨"Grep", grepPath⟩,
    ⟨"Read", none⟩, ⟨"Glob", none⟩, ⟨"Bash", none⟩, ⟨"Write", none⟩]

def boundaryRows : List (Row × List Call) :=
  ([{ isSensitive := true }, { isSensitive := true, reason := some "" },
      { isSensitive := false, reason := some "ignored-reason" }] : List SensitivePathResult).map
    (fun s => (autoRow { quiet with sensitive := s }, sensitiveCalls)) ++
  [(autoRow { quiet with mcpDenied := some "" }, mcpCalls),
    ({ autoRow { quiet with mcpDenied := some "" } with isAdmin := true }, mcpCalls)] ++
  ([{ blocked := true }, { blocked := true, reason := some "wrong-issue-number" },
      { blocked := true, message := some "pr-message" },
      { blocked := true, reason := some "", message := some "" },
      { blocked := false, reason := some "wrong-issue-number", message := some "pr-message" }] :
      List PrIssueGuardResult).map
    (fun p => ({ mode := .bypass, isAdmin := false, aborted := false, handoff := true,
                 prims := { quiet with prIssue := p } }, prCalls)) ++
  ([{ decision := .ask, matchedRuleIds := [] },
      { decision := .ask, matchedRuleIds := ["rule-a", "rule-b", "rule-c"] },
      { decision := .allow, matchedRuleIds := ["rule-a"] }] : List BashPermission).map
    (fun b => (autoRow { quiet with bash := b }, [⟨"Bash", empty⟩, ⟨"Bash", none⟩])) ++
  [(autoRow { quiet with sensitive := sensitiveHit }, pathCalls),
    ({ autoRow { quiet with sensitive := sensitiveHit } with isAdmin := true }, pathCalls)]

/-- A tool input with the given properties. -/
def inputOf (props : List (String × Json)) : Option Json :=
  some (.obj props)

/-- Inputs that differ only in the properties the sensitive-path call takes its arguments from:
a string, the empty string, other values and a missing property, often with the other candidate
properties present, so an argument read from the wrong property changes the call. The first two
Glob inputs are the pair a reviewer found the phase-1 model could not tell apart. -/
def argumentCalls : List Call :=
  [⟨"Glob", inputOf [("pattern", .str "*"), ("path", .str "SECRETBASE")]⟩,
    ⟨"Glob", inputOf [("pattern", .str "*"), ("path", .str "/tmp")]⟩,
    ⟨"Glob", inputOf [("pattern", .str "*"), ("path", .str "")]⟩,
    ⟨"Glob", inputOf [("pattern", .str "*"), ("path", .num 7)]⟩,
    ⟨"Glob", inputOf [("pattern", .str "*"), ("path", .null)]⟩,
    ⟨"Glob", inputOf [("pattern", .str "*"), ("path", .obj [])]⟩,
    ⟨"Glob", inputOf [("pattern", .str "*")]⟩,
    ⟨"Glob", inputOf [("pattern", .str ""), ("path", .str "/tmp")]⟩,
    ⟨"Glob", inputOf [("pattern", .num 7), ("path", .str "/tmp")]⟩,
    ⟨"Glob", inputOf [("path", .str "/tmp")]⟩,
    ⟨"Glob", inputOf [("pattern", .str "*"), ("path", .str "/tmp"), ("file_path", .str "/x"),
      ("command", .str "cat /y")]⟩,
    ⟨"Read", inputOf [("file_path", .str "/a")]⟩,
    ⟨"Read", inputOf [("file_path", .str "/a"), ("path", .str "/b"), ("pattern", .str "/c")]⟩,
    ⟨"Read", inputOf [("file_path", .str "")]⟩,
    ⟨"Read", inputOf [("file_path", .num 7)]⟩,
    ⟨"Read", inputOf [("file_path", .null)]⟩,
    ⟨"Read", inputOf [("path", .str "/b")]⟩,
    ⟨"Bash", inputOf [("command", .str "cat /a")]⟩,
    ⟨"Bash", inputOf [("command", .str "cat /a"), ("file_path", .str "/b"), ("path", .str "/c")]⟩,
    ⟨"Bash", inputOf [("command", .str "")]⟩,
    ⟨"Bash", inputOf [("command", .num 7)]⟩,
    ⟨"Bash", inputOf [("command", .obj [])]⟩,
    ⟨"Bash", inputOf [("file_path", .str "/b")]⟩,
    ⟨"Grep", inputOf [("path", .str "/a"), ("file_path", .str "/b"), ("pattern", .str "TODO")]⟩,
    ⟨"Grep", inputOf [("file_path", .str "/b"), ("pattern", .str "TODO")]⟩]

/-- The argument calls, for a non-admin whose sensitive-path check comes back clear and one whose
check comes back sensitive. -/
def argumentRows : List Row :=
  [autoRow quiet, autoRow { quiet with sensitive := sensitiveHit }]

/-- The one tool an incident attempt may call, `INCIDENT_EVIDENCE_TOOL`
(src/incident/sdk-options.ts:66). -/
def evidenceTool : String := "mcp__incident_evidence__collect"

/-- The live allowlist (src/incident/sdk-options.ts:389), two exact names, and lists that must
allow nothing beyond the exact `mcp__` names they hold: empty, a wildcard-looking entry, a prefix
of the evidence tool, native tool names with the bare `mcp__` prefix, and the PR-create tool,
which the PR-issue guard still checks first. -/
def incidentAllowLists : List IncidentReadOnly :=
  [{ allowedMcpTools := [evidenceTool] },
    { allowedMcpTools := [evidenceTool, "mcp__server-tools__db_query"] },
    { allowedMcpTools := [] },
    { allowedMcpTools := ["mcp__incident_evidence__*"] },
    { allowedMcpTools := ["mcp__incident_evidence"] },
    { allowedMcpTools := ["Bash", "Read", "Glob", "Grep", "Write", "Task", "Agent", "Skill",
        "mcp__"] },
    { allowedMcpTools := [prCreateMcpTool] }]

/-- The allow-listed tools, near misses of them (a prefix, an extension, another tool of the same
server, case, a trailing space, the wildcard entry's own name, the bare prefix), the PR-create
tool, native tools including the subagent tools `Task` and `Agent`, and tools the policy does not
know. -/
def incidentCalls : List Call :=
  [⟨evidenceTool, some (.obj [("incident", .str "INC-42")])⟩,
    ⟨"mcp__server-tools__db_query", empty⟩,
    ⟨"mcp__incident_evidence__*", empty⟩,
    ⟨"mcp__incident_evidence", empty⟩,
    ⟨"mcp__incident_evidence__", empty⟩,
    ⟨"mcp__incident_evidence__collect_all", empty⟩,
    ⟨"mcp__incident_evidence__restart", empty⟩,
    ⟨"MCP__incident_evidence__collect", empty⟩,
    ⟨"mcp__incident_evidence__collect ", empty⟩,
    ⟨"mcp__", empty⟩,
    ⟨prCreateMcpTool, empty⟩,
    ⟨"Bash", empty⟩, ⟨"Read", empty⟩, ⟨"Glob", empty⟩, ⟨"Grep", grepPath⟩, ⟨"Write", empty⟩,
    ⟨"Task", empty⟩, ⟨"Agent", empty⟩, ⟨"Skill", empty⟩, ⟨"WebFetch", empty⟩,
    ⟨"SomeFutureTool", empty⟩, ⟨"", empty⟩]

/-- Every incident allowlist × `patterns` × mode × `isAdmin`. -/
def incidentRows : List Row :=
  incidentAllowLists.flatMap fun inc =>
  modes.flatMap fun mode =>
  bools.flatMap fun isAdmin =>
  patterns.map fun (aborted, handoff, prims) =>
    { mode, isAdmin, aborted, handoff, prims, incident := some inc }

/-! ## Constants -/

def constantsJson : Json :=
  .obj [("kind", .str "constants"), ("nativeBypassTools", strs nativeBypassTools),
    ("toolPolicyMatchers", strs toolPolicyMatchers),
    ("incidentToolPolicyMatchers",
      .arr (incidentToolPolicyMatchers.map fun m => (m.map .str).getD .null))]

/-! ## Concrete calls, replayed without mocks -/

/-- A primitive call a concrete case makes. Its expected value is taken from the case's `prims`,
the same values the model input is built from. -/
inductive Pre where
  | isSshCommand (command : String)
  /-- the sensitive-path call the model says the policy makes for the case's input
  (`sensitiveCall`); a case lists it only when there is one -/
  | sensitive
  | isCrossUserAccess (command user : String)
  /-- called with the case's tool name, tool input and handoff context -/
  | handlePrIssuePrecondition
  /-- called with the case's disabled rules as the `isRuleDisabled` predicate -/
  | bypassBashPermissionDecision (command : String)

/-- The session owner of every concrete case (the user id of `tool-policy.test.ts`). -/
def sessionUser : String := "U0PARITY01"

/-- Stands for `os.homedir()`. The test substitutes it before calling anything, so the vector
file names no home directory and holds on any machine. -/
def home : String := "{{HOME}}"

structure Concrete where
  name : String
  tool : String
  input : Json
  isAdmin : Bool := false
  mode : Mode
  aborted : Bool := false
  handoff : Option Json := none
  disabledRules : List String := []
  prims : Primitives := quiet
  /-- `ctx.incidentReadOnly`; `none` leaves it undefined -/
  incident : Option IncidentReadOnly := none
  pre : List Pre

def Concrete.toInput (c : Concrete) : Input :=
  { toolName := c.tool, command := jsonField "command" (some c.input),
    filePath := jsonField "file_path" (some c.input), pattern := jsonField "pattern" (some c.input),
    path := jsonField "path" (some c.input), isAdmin := c.isAdmin, mode := c.mode,
    aborted := c.aborted, handoff := c.handoff.isSome, prims := c.prims }

/-- The model's sensitive-path call for a concrete case, with the value the case gives it. A case
that lists `.sensitive` without making a call gets `fn: "no-sensitive-call"`, which the test
rejects. -/
def sensitivePreJson (c : Concrete) : Json :=
  match sensitiveCallJson (sensitiveCall c.toInput) with
  | .obj fields => .obj (fields ++ [("result", sensitiveJson c.prims.sensitive)])
  | _ => .obj [("fn", .str "no-sensitive-call")]

def preJson (c : Concrete) : Pre → Json
  | .isSshCommand command =>
    .obj [("fn", .str "isSshCommand"), ("args", strs [command]), ("result", .bool c.prims.ssh)]
  | .sensitive => sensitivePreJson c
  | .isCrossUserAccess command user =>
    .obj [("fn", .str "isCrossUserAccess"), ("args", strs [command, user]),
      ("result", .bool c.prims.crossUser)]
  | .handlePrIssuePrecondition =>
    .obj [("fn", .str "handlePrIssuePrecondition"),
      ("args", .arr [.obj [("toolName", .str c.tool), ("toolInput", c.input),
        ("handoffContext", c.handoff.getD .null)]]),
      ("result", prIssueJson c.prims.prIssue)]
  | .bypassBashPermissionDecision command =>
    .obj [("fn", .str "bypassBashPermissionDecision"), ("args", strs [command]),
      ("disabledRules", strs c.disabledRules), ("result", bashJson c.prims.bash)]

def concreteJson (c : Concrete) : Json :=
  .obj [("kind", .str "concrete"), ("name", .str c.name), ("tool", .str c.tool),
    ("input", c.input),
    ("ctx", .obj ([("user", .str sessionUser), ("isAdmin", .bool c.isAdmin),
      ("mode", .str (modeName c.mode)), ("aborted", .bool c.aborted),
      ("handoffContext", c.handoff.getD .null), ("mcpDenied", mcpJson c.prims.mcpDenied),
      ("disabledRules", strs c.disabledRules)] ++ incidentProp c.incident)),
    ("pre", .arr (c.pre.map (preJson c))),
    ("expect", resultJson (evaluateToolPolicy c.incident c.toInput))]

def bashInput (command : String) : Json :=
  .obj [("command", .str command)]

/-- The primitives a Bash call consults, in the order the policy consults them. -/
def bashPre (command : String) : List Pre :=
  [.isSshCommand command, .sensitive, .isCrossUserAccess command sessionUser,
    .bypassBashPermissionDecision command]

/-- The primitives a Bash call consults before the incident tier, in that order:
`bypassBashPermissionDecision` belongs to the mode tier, which an incident session never
reaches. -/
def incidentBashPre (command : String) : List Pre :=
  [.isSshCommand command, .sensitive, .isCrossUserAccess command sessionUser]

def issueUrl : String := "https://github.com/2lab-ai/soma-work/issues/696"

/-- The blocking handoff context of `tool-policy.test.ts`, with a `handoffKind` from the
`HandoffKind` union: a GitHub source issue, so a PR body must contain `Closes #696`. -/
def blockingHandoff : Json :=
  .obj [("handoffKind", .str "plan-to-work"), ("sourceIssueUrl", .str issueUrl),
    ("escapeEligible", .bool false), ("tier", .null), ("issueRequiredByUser", .bool false),
    ("parentEpicUrl", .null), ("chainId", .str "chain-1"), ("hopBudget", .num 3)]

/-- U+1F6AB NO ENTRY SIGN, which starts every PR-issue block message (pr-issue-guard.ts:188). -/
def noEntrySign : Char := Char.ofNat 0x1F6AB

/-- `Char.ofNat` maps an invalid code point to U+0000; this one is valid. -/
theorem noEntrySign_spec : noEntrySign.toNat = 0x1F6AB := by
  decide

/-- `formatBlockMessage(reason, blockingHandoff, tool)` — pr-issue-guard.ts:180-277 — for the
given cause-and-fix lines. -/
def blockMessage (tool reason : String) (causeAndFix : List String) : String :=
  "\n".intercalate
    ([String.singleton noEntrySign ++
        " PR creation blocked: handoff session lacks linked-issue evidence.",
      "", "Tool: " ++ tool, "Reason: " ++ reason, "",
      "handoffContext:", "  sourceIssueUrl: " ++ issueUrl, "  escapeEligible: false",
      "  issueRequiredByUser: false", "  chainId: chain-1", ""] ++ causeAndFix)

def ghPrCreateNoMarker : String := "gh pr create --title x --body \"no marker\""

def ghPrCreateCloses : String := "gh pr create --body \"Closes #696\""

def missingClosesMessage : String :=
  blockMessage "Bash" "missing-closes-issue"
    ["Cause: handoff session has `sourceIssueUrl=" ++ issueUrl ++ "` but the PR body does",
      "not contain `Closes #696`.",
      "",
      "Fix: include `Closes #696` in the PR body. Use inline content (literal string or",
      "heredoc) — shell variable indirection (`--body \"$VAR\"`) is not visible to the static check."]

def unknownShapeMessage : String :=
  blockMessage prCreateMcpTool "unknown-tool-shape"
    ["Cause: tool input did not have the expected shape (missing or non-string body field).",
      "Cannot validate marker presence.",
      "",
      "Fix: ensure the tool call provides a string body field."]

/-- The one sensitive path the concrete cases use, spelled plainly (no `..`, `.`, `//`, `~` or
`$HOME` forms, which the sensitive-path check may normalize differently over time). -/
def sshKey : String := home ++ "/.ssh/id_rsa"

/-- What the sensitive-path checks return for `sshKey`. -/
def sshKeySensitive : SensitivePathResult :=
  { isSensitive := true, reason := some ("Access to " ++ home ++ "/.ssh/ is restricted") }

def rmRules : List String := ["rm-recursive", "rm-force"]

/-- The incident context of a live incident attempt (src/incident/sdk-options.ts:389). -/
def liveIncident : IncidentReadOnly :=
  { allowedMcpTools := [evidenceTool] }

def concreteCases : List Concrete :=
  [{ name := "read-sensitive-nonadmin-auto", tool := "Read",
     input := .obj [("file_path", .str sshKey)], mode := .auto,
     prims := { quiet with sensitive := sshKeySensitive }, pre := [.sensitive] },
   { name := "read-sensitive-admin-bypass", tool := "Read",
     input := .obj [("file_path", .str sshKey)], isAdmin := true, mode := .bypass,
     prims := { quiet with sensitive := sshKeySensitive }, pre := [.sensitive] },
   { name := "read-safe-legacy", tool := "Read",
     input := .obj [("file_path", .str ("/tmp/" ++ sessionUser ++ "/notes.txt"))],
     mode := .legacy, pre := [.sensitive] },
   { name := "grep-sensitive-nonadmin-auto", tool := "Grep",
     input := .obj [("pattern", .str "BEGIN"), ("path", .str sshKey)], mode := .auto,
     prims := { quiet with sensitive := sshKeySensitive }, pre := [.sensitive] },
   { name := "glob-sensitive-nonadmin-bypass", tool := "Glob",
     input := .obj [("pattern", .str sshKey)], mode := .bypass,
     prims := { quiet with sensitive := sshKeySensitive }, pre := [.sensitive] },
   { name := "glob-sensitive-base-nonadmin-auto", tool := "Glob",
     input := .obj [("pattern", .str "*"), ("path", .str (home ++ "/.ssh"))], mode := .auto,
     prims := { quiet with sensitive := sshKeySensitive }, pre := [.sensitive] },
   { name := "glob-safe-base-nonadmin-auto", tool := "Glob",
     input := .obj [("pattern", .str "*"), ("path", .str "/tmp")], mode := .auto,
     pre := [.sensitive] },
   { name := "bash-ssh-nonadmin-bypass", tool := "Bash", input := bashInput "ssh prod-host",
     mode := .bypass, prims := { quiet with ssh := true }, pre := bashPre "ssh prod-host" },
   { name := "bash-ssh-admin-auto", tool := "Bash", input := bashInput "ssh prod-host",
     isAdmin := true, mode := .auto, prims := { quiet with ssh := true },
     pre := bashPre "ssh prod-host" },
   { name := "bash-cross-user-admin-bypass", tool := "Bash",
     input := bashInput "cat /tmp/U0OTHERUSR9/secret", isAdmin := true, mode := .bypass,
     prims := { quiet with crossUser := true }, pre := bashPre "cat /tmp/U0OTHERUSR9/secret" },
   { name := "bash-cross-user-nonadmin-legacy", tool := "Bash",
     input := bashInput "cat /tmp/U0OTHERUSR9/secret", mode := .legacy,
     prims := { quiet with crossUser := true }, pre := bashPre "cat /tmp/U0OTHERUSR9/secret" },
   { name := "bash-rm-auto-classify", tool := "Bash", input := bashInput "rm -rf /tmp/x",
     mode := .auto, prims := { quiet with bash := { decision := .ask, matchedRuleIds := rmRules } },
     pre := bashPre "rm -rf /tmp/x" },
   { name := "bash-rm-auto-rules-disabled", tool := "Bash", input := bashInput "rm -rf /tmp/x",
     mode := .auto, disabledRules := rmRules, pre := bashPre "rm -rf /tmp/x" },
   { name := "bash-rm-bypass", tool := "Bash", input := bashInput "rm -rf /tmp/x",
     mode := .bypass, prims := { quiet with bash := { decision := .ask, matchedRuleIds := rmRules } },
     pre := bashPre "rm -rf /tmp/x" },
   { name := "bash-rm-legacy", tool := "Bash", input := bashInput "rm -rf /tmp/x",
     mode := .legacy, prims := { quiet with bash := { decision := .ask, matchedRuleIds := rmRules } },
     pre := bashPre "rm -rf /tmp/x" },
   { name := "bash-ls-auto", tool := "Bash", input := bashInput "ls", mode := .auto,
     pre := bashPre "ls" },
   { name := "bash-ls-aborted-bypass", tool := "Bash", input := bashInput "ls", mode := .bypass,
     aborted := true, pre := bashPre "ls" },
   { name := "mcp-denied-nonadmin-auto", tool := "mcp__server-tools__db_query", input := .obj [],
     mode := .auto, prims := { quiet with mcpDenied := some "no active grant" }, pre := [] },
   { name := "mcp-denied-admin-auto", tool := "mcp__server-tools__db_query", input := .obj [],
     isAdmin := true, mode := .auto, prims := { quiet with mcpDenied := some "no active grant" },
     pre := [] },
   { name := "pr-create-bash-blocked-bypass", tool := "Bash", input := bashInput ghPrCreateNoMarker,
     mode := .bypass, handoff := some blockingHandoff,
     prims := { quiet with prIssue := { blocked := true, reason := some "missing-closes-issue",
                                        message := some missingClosesMessage } },
     pre := bashPre ghPrCreateNoMarker ++ [.handlePrIssuePrecondition] },
   { name := "pr-create-bash-closes-auto", tool := "Bash", input := bashInput ghPrCreateCloses,
     mode := .auto, handoff := some blockingHandoff,
     pre := bashPre ghPrCreateCloses ++ [.handlePrIssuePrecondition] },
   { name := "pr-create-mcp-no-body-auto", tool := prCreateMcpTool,
     input := .obj [("title", .str "x")], mode := .auto, handoff := some blockingHandoff,
     prims := { quiet with prIssue := { blocked := true, reason := some "unknown-tool-shape",
                                        message := some unknownShapeMessage } },
     pre := [.handlePrIssuePrecondition] },
   { name := "incident-evidence-tool-legacy", tool := evidenceTool,
     input := .obj [("incident", .str "INC-42")], mode := .legacy, incident := some liveIncident,
     pre := [] },
   { name := "incident-evidence-tool-grant-denied", tool := evidenceTool, input := .obj [],
     mode := .legacy, incident := some liveIncident,
     prims := { quiet with mcpDenied := some "no active grant" }, pre := [] },
   { name := "incident-evidence-tool-grant-denied-admin-bypass", tool := evidenceTool,
     input := .obj [], isAdmin := true, mode := .bypass, incident := some liveIncident,
     prims := { quiet with mcpDenied := some "no active grant" }, pre := [] },
   { name := "incident-read-sensitive-admin-bypass", tool := "Read",
     input := .obj [("file_path", .str sshKey)], isAdmin := true, mode := .bypass,
     incident := some liveIncident, prims := { quiet with sensitive := sshKeySensitive },
     pre := [.sensitive] },
   { name := "incident-bash-ssh-admin-auto", tool := "Bash", input := bashInput "ssh prod-host",
     isAdmin := true, mode := .auto, incident := some liveIncident,
     prims := { quiet with ssh := true }, pre := incidentBashPre "ssh prod-host" },
   { name := "incident-bash-ls-admin-bypass", tool := "Bash", input := bashInput "ls",
     isAdmin := true, mode := .bypass, incident := some liveIncident,
     pre := incidentBashPre "ls" },
   { name := "incident-read-safe-legacy", tool := "Read",
     input := .obj [("file_path", .str ("/tmp/" ++ sessionUser ++ "/notes.txt"))],
     mode := .legacy, incident := some liveIncident, pre := [.sensitive] },
   { name := "incident-read-sensitive-nonadmin-auto", tool := "Read",
     input := .obj [("file_path", .str sshKey)], mode := .auto, incident := some liveIncident,
     prims := { quiet with sensitive := sshKeySensitive }, pre := [.sensitive] },
   { name := "incident-bash-cross-user-admin-bypass", tool := "Bash",
     input := bashInput "cat /tmp/U0OTHERUSR9/secret", isAdmin := true, mode := .bypass,
     incident := some liveIncident, prims := { quiet with crossUser := true },
     pre := incidentBashPre "cat /tmp/U0OTHERUSR9/secret" },
   { name := "incident-agent-admin-bypass", tool := "Agent",
     input := .obj [("prompt", .str "read evidence")], isAdmin := true, mode := .bypass,
     incident := some liveIncident, pre := [] }]

/-- The cases written to `verification/vectors/tool-policy.json`. -/
def cases : List Json :=
  tableRows.map (rowJson "table" tableCalls) ++
  namesRows.map (rowJson "tool-names" toolNames) ++
  boundaryRows.map (fun (r, calls) => rowJson "boundary" calls r) ++
  argumentRows.map (rowJson "arguments" argumentCalls) ++
  incidentRows.map (rowJson "incident" incidentCalls) ++
  [constantsJson] ++
  concreteCases.map concreteJson

end SomaVerify.ToolPolicy.Vectors

def main : IO Unit :=
  IO.print (SomaVerify.Vectors.render "tool-policy" ``SomaVerify.ToolPolicy.Vectors.cases
    SomaVerify.ToolPolicy.Vectors.cases)
