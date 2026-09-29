import SomaVerify.ToolPolicy.Model

/-!
# What `evaluateToolPolicy` is documented to do

Each statement quotes the TS docstring or comment it formalizes. Paths are relative to the
repository root; a bare line number refers to `src/agent-runtime/policy/tool-policy.ts`.
`Proofs.lean` proves every statement for `evaluate`.

The guard conditions are written from the comments, not copied from the guards: `Proofs.lean`
shows that each guard fires exactly when its condition holds (`GuardConditions`).
-/

namespace SomaVerify.ToolPolicy

open SomaVerify.JsString

/-! ## The deny-guard conditions -/

/-- 132-133: "Abort guard (Bash only): deny all Bash after session abort". -/
def AbortCond (i : Input) : Prop :=
  i.toolName = "Bash" ∧ i.aborted = true

/-- 138: "SSH ban (Bash, non-admin)." -/
def SshCond (i : Input) : Prop :=
  i.toolName = "Bash" ∧ i.isAdmin = false ∧ i.prims.ssh = true

/-- 143: "Sensitive-path (non-admin; Bash/Read/Glob/Grep)."; 99-101: "Bash→command,
Read→file_path, Glob→pattern+path, Grep→path (only when present)". A Grep path is present when
`typeof input.path === 'string' && input.path` (112). -/
def SensitiveCond (i : Input) : Prop :=
  i.isAdmin = false ∧ i.prims.sensitive.isSensitive = true ∧
    (i.toolName = "Bash" ∨ i.toolName = "Read" ∨ i.toolName = "Glob" ∨
      (i.toolName = "Grep" ∧ i.path.isNonEmptyString = true))

/-- 151: "Cross-user directory isolation (Bash, always — even in bypass mode)." -/
def CrossUserCond (i : Input) : Prop :=
  i.toolName = "Bash" ∧ i.prims.crossUser = true

/-- 156: "MCP tool permission (mcp__ tools, non-admin)"; 90: `checkMcpToolPermission` "Returns
a deny reason for a permission-gated MCP tool, else null." -/
def McpCond (i : Input) : Prop :=
  jsStartsWith i.toolName "mcp__" = true ∧ i.isAdmin = false ∧ i.prims.mcpDenied ≠ none

/-- 165-166: "PR-issue precondition (#696) — handoff sessions must link a source issue before
creating a PR"; 88: "`undefined` → the PR-issue precondition is inactive"; 168: the guard runs
for `Bash` and `PR_CREATE_MCP_TOOL`. -/
def PrIssueCond (i : Input) : Prop :=
  i.handoff = true ∧ (i.toolName = "Bash" ∨ i.toolName = prCreateMcpTool) ∧
    i.prims.prIssue.blocked = true

/-- Some guard of the deny tier has its condition met. -/
def DenyCond (i : Input) : Prop :=
  AbortCond i ∨ SshCond i ∨ SensitiveCond i ∨ CrossUserCond i ∨ McpCond i ∨ PrIssueCond i

/-- The tools the mode tier decides for: Bash and `NATIVE_BYPASS_TOOLS` (187-190, 198-206;
bypass-permission-guard.ts:38 "Native tools that need an explicit `'allow'` decision"). -/
def Governed (toolName : String) : Prop :=
  toolName = "Bash" ∨ toolName ∈ nativeBypassTools

/-! ## The deny tier as a list, to state that its order does not matter -/

/-- The deny tier in source order (130-177). -/
def denyTier : List (Input → Option Result) :=
  [abortGuard, sshGuard, sensitiveGuard, crossUserGuard, mcpGuard, prIssueGuard]

/-- `evaluate` with the deny tier run in the order `guards`: the first guard in the list that
fires decides, otherwise the mode tier does. -/
def evaluateWith (guards : List (Input → Option Result)) (i : Input) : Result :=
  match guards.findSome? (fun g => g i) with
  | some r => r
  | none => modeTier i

/-! ## The invariants -/

/-- The guards fire exactly under their documented conditions (the comments quoted on
`AbortCond` .. `PrIssueCond`). -/
def GuardConditions : Prop :=
  ∀ i : Input,
    (abortGuard i ≠ none ↔ AbortCond i) ∧ (sshGuard i ≠ none ↔ SshCond i) ∧
    (sensitiveGuard i ≠ none ↔ SensitiveCond i) ∧ (crossUserGuard i ≠ none ↔ CrossUserCond i) ∧
    (mcpGuard i ≠ none ↔ McpCond i) ∧ (prIssueGuard i ≠ none ↔ PrIssueCond i)

/-- (a) 132-133: "Abort guard (Bash only): deny all Bash after session abort". It is the first
step, so its own reason is the one returned. -/
def AbortDenies : Prop :=
  ∀ i : Input, AbortCond i →
    evaluate i = { decision := .deny, reason := "abort-guard: session aborted" }

/-- (b) 151: "Cross-user directory isolation (Bash, always — even in bypass mode)."; the
`isCrossUserAccess` docstring (soma-lib, `src/domain/command-safety/index.ts:397`): "Enforces
per-user filesystem isolation — always deny, regardless of bypass mode." Every mode, admin or
not. -/
def CrossUserIsolation : Prop :=
  ∀ i : Input, CrossUserCond i → ∀ (mode : Mode) (isAdmin : Bool),
    (evaluate { i with mode := mode, isAdmin := isAdmin }).decision = .deny

/-- (c) 19: "Precedence (highest wins): **deny > ask > allow > pass**"; 184-185: "The hard-deny
tier above still protects multi-tenant isolation". A met deny condition decides, whatever the
mode. -/
def DenyDominance : Prop :=
  ∀ i : Input, DenyCond i → (evaluate i).decision = .deny

/-- (c) permission-mode.ts:23-25: "The hard-deny tier in `evaluateToolPolicy` is
mode-independent and always runs first; mode only governs the allow / ask / classify decision
that follows." Under a met deny condition the whole result, reason included, ignores the mode. -/
def DenyTierModeIndependent : Prop :=
  ∀ (i : Input) (mode : Mode), DenyCond i → evaluate { i with mode := mode } = evaluate i

/-- (c) 179: "ALLOW / ASK / CLASSIFY tier (only reached when no deny fired)": the only denials
are the deny tier's. -/
def DenyExactly : Prop :=
  ∀ i : Input, (evaluate i).decision = .deny ↔ DenyCond i

/-- `evaluateWith` in source order is `evaluate`, so the next two statements are about the
function the TS implements. -/
def EvaluateWithSourceOrder : Prop :=
  ∀ i : Input, evaluateWith denyTier i = evaluate i

/-- (d) 130: "DENY tier (any one wins; order within the tier is immaterial)". Immaterial for
the decision: any reordering of the tier decides the same. -/
def DecisionOrderInvariant : Prop :=
  ∀ (guards : List (Input → Option Result)) (i : Input),
    guards.Perm denyTier → (evaluateWith guards i).decision = (evaluate i).decision

/-- (d) The limit of 130: the reason names the guard that returned first, so a reordering can
change it (51: "Human-readable reason, prefixed with the guard that decided"). -/
def ReasonOrderDependent : Prop :=
  ∃ (guards : List (Input → Option Result)) (i : Input),
    guards.Perm denyTier ∧ (evaluateWith guards i).reason ≠ (evaluate i).reason

/-- (e) 79: "`legacy` → `pass` (defer to the SDK per-tool prompt)"; 180-181: "`legacy` falls
through to `pass` below so the SDK runs its own per-tool permission prompt". -/
def LegacyNeverAllows : Prop :=
  ∀ i : Input, i.mode = .legacy →
    (evaluate i).decision ≠ .allow ∧ (evaluate i).decision ≠ .classify ∧
      (evaluate i).decision ≠ .ask

/-- (e) The same comments, positively: without a deny, legacy passes. -/
def LegacyPasses : Prop :=
  ∀ i : Input, i.mode = .legacy → ¬DenyCond i → (evaluate i).decision = .pass

/-- (f) 42-44: "`classify` is the auto-mode-only outcome: the static layer flagged a
dangerous-rule hit"; 81: "`auto` → allow non-dangerous; a dangerous-rule hit → `classify`";
195-196. -/
def ClassifyIff : Prop :=
  ∀ i : Input, (evaluate i).decision = .classify ↔
    i.mode = .auto ∧ i.toolName = "Bash" ∧ ¬DenyCond i ∧ i.prims.bash.decision = .ask

/-- (f) 60-63: `matchedRuleIds` are the "Dangerous-rule ids that fired, set ONLY for the
`classify` decision". -/
def MatchedRuleIdsOnlyClassify : Prop :=
  ∀ i : Input, (evaluate i).matchedRuleIds ≠ none ↔ (evaluate i).decision = .classify

/-- (f) 60-62: on `classify` they are the ids `bypassBashPermissionDecision` matched, "so the
caller can hand them to the safety classifier as context", and the reason lists them. -/
def ClassifyCarriesRuleIds : Prop :=
  ∀ i : Input, (evaluate i).decision = .classify →
    (evaluate i).matchedRuleIds = some i.prims.bash.matchedRuleIds ∧
      (evaluate i).reason = "auto-classify: " ++ ",".intercalate i.prims.bash.matchedRuleIds

/-- (g) 74: "admins bypass the ssh / sensitive / mcp guards." Exactly those: an admin gets the
result of a non-admin whose ssh, sensitive-path and MCP checks all come back clear. Nothing else
depends on `isAdmin`, so abort, cross-user and PR-issue apply to admins unchanged. -/
def AdminSkipsExactlySshSensitiveMcp : Prop :=
  ∀ i : Input,
    evaluate { i with isAdmin := true } =
      evaluate { i with
        isAdmin := false,
        prims := { i.prims with ssh := false, sensitive := { isSensitive := false },
                                mcpDenied := none } }

/-- (g) 151: cross-user is "always"; 132-133 and 165-166 carry no admin exemption. The abort,
cross-user and PR-issue guards still deny an admin. -/
def AdminKeepsAbortCrossUserPrIssue : Prop :=
  ∀ i : Input, i.isAdmin = true → AbortCond i ∨ CrossUserCond i ∨ PrIssueCond i →
    (evaluate i).decision = .deny

/-- (h) 19-22: "`pass` means 'no policy opinion'"; 211: "default: no policy opinion (legacy
mode, or an ungoverned tool) → defer". -/
def PassIff : Prop :=
  ∀ i : Input, (evaluate i).decision = .pass ↔
    ¬DenyCond i ∧ (i.mode = .legacy ∨ ¬Governed i.toolName)

/-- (i) 47 and 19 name `ask` (`ToolPolicyDecision`, "deny > ask > allow > pass"), but no path
returns it: dangerous Bash in auto mode becomes `classify` (201: "Defer to the guardian
classifier instead of asking the human outright"). -/
def NeverAsk : Prop :=
  ∀ i : Input, (evaluate i).decision ≠ .ask

/-- 80: "`bypass` → `allow` everything governed (unsafe — even dangerous Bash)"; 183-184:
"allow every governed tool with no prompt — including a dangerous Bash". -/
def BypassAllowsGoverned : Prop :=
  ∀ i : Input, i.mode = .bypass → ¬DenyCond i → Governed i.toolName →
    (evaluate i).decision = .allow

/-- 81: "`auto` → allow non-dangerous"; 195: "non-dangerous Bash + native tools run". -/
def AutoAllowsNonDangerous : Prop :=
  ∀ i : Input, i.mode = .auto → ¬DenyCond i → Governed i.toolName →
    (i.toolName = "Bash" → i.prims.bash.decision = .allow) → (evaluate i).decision = .allow

/-- 54-57: `denyMessage` is "Only set for the PR-issue deny". Whenever it is set, the result is
the PR-issue guard's own result. -/
def DenyMessageOnlyPrIssue : Prop :=
  ∀ i : Input, (evaluate i).denyMessage ≠ none → prIssueGuard i = some (evaluate i)

/-- 90: `checkMcpToolPermission` "Returns a deny reason for a permission-gated MCP tool, else
null."; 156-157. Every non-null value denies a non-admin `mcp__` call, with that reason. -/
def McpDenyReasonDenies : Prop :=
  ∀ (i : Input) (denied : String), jsStartsWith i.toolName "mcp__" = true →
    i.isAdmin = false → i.prims.mcpDenied = some denied →
    evaluate i = { decision := .deny, reason := "mcp-permission: " ++ denied }

/-- 215: `TOOL_POLICY_MATCHERS` are "The matchers a SDK PreToolUse hook must register to cover
every governed tool." Every call the policy has an opinion on belongs to one of the three
matchers: `Bash`, a native tool, or an `mcp__` tool. How the SDK matches a matcher string to a
tool name is SDK behavior, outside the model. -/
def OpinionOnlyOnMatchedTools : Prop :=
  ∀ i : Input, (evaluate i).decision ≠ .pass →
    i.toolName = "Bash" ∨ i.toolName ∈ nativeBypassTools ∨ jsStartsWith i.toolName "mcp__" = true

end SomaVerify.ToolPolicy
