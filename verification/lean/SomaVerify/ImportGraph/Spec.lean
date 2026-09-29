import SomaVerify.ImportGraph.Model

/-!
# What the import-graph theorems say, and what they take on trust

## Trusted: the extractor

`Generated.lean` is written by `scripts/verification/extract-import-graph.cjs`, which
`scripts/verification/lean-verify.sh` runs before every build, from the checked-out sources. That
program is not verified: the theorems are about the graph it writes, and hold for the repository
only as far as the graph is the repository's. It guarantees (its header has the details):

- nodes: one per production TypeScript file `git ls-files` lists (`*.ts`, `*.tsx`, `*.mts`,
  `*.cts`, minus declaration files, `*.test.*`, `*.spec.*`, and anything under `__tests__/`,
  `__fixtures__/` or `node_modules/`), numbered in path order; `paths[i]` is the path of node
  `i`, and `layers[i]` the group its path prefix puts it in.
- edges: `⟨i, j⟩` exactly when compiling node `i` to CommonJS with the repository's TypeScript
  emits a `require` that loads node `j`. `import()` compiles to a `require`, so lazy loads are
  edges; `import type`, and imports whose bindings are used only as types, are erased by the
  compiler and are not.
- resolution: a specifier resolves the way Node's CommonJS loader resolves it in the compiled
  layout, a workspace package name through that package's `exports`, and the file reached is
  mapped back to its source. Node built-ins and npm dependencies are dropped.
- completeness: an in-repo specifier that reaches no production file, a load whose specifier is
  not a string literal, and a production file the compiler did not emit each stop the extractor
  before it writes anything.
- MCP server entries: `mcpServerEntries` are the source files of the `bin` targets of every
  workspace package under `packages/mcp-servers/`; a package there without one stops the
  extractor.

Not modeled. The graph is the output of tsc, which is what `dist/` runs. Runners that compile one
file at a time with esbuild (tsx, vitest) cannot tell a re-exported type (`export { T } from`)
from a value, so under them a module may also load the file such a re-export names, which the
graph has no edge to. Anything that is not a module load (a child process, a worker, a file read
at run time) is not an edge.

`scripts/verification/__tests__/import-graph.test.ts` checks the extractor's output against facts
read off the sources, including that its MCP server entries are the servers the daemon launches,
and that it fails on a specifier it cannot resolve.

## Proven (`Proofs.lean`)

For every graph, each checker of `Model.lean` implies the statement below that it stands for.
The kernel evaluates the checkers on `Generated.graph`, which yields the statements for the
repository.
-/

namespace SomaVerify.ImportGraph

/-- rules/packaging.md:26: "**의존 방향은 단방향:** `common ← process-shared ← slack ← src`.
역참조(common이 slack을 import) 금지. `src`만 모두를 조립한다." (The dependency direction is one
way; a reverse import, such as common importing slack, is forbidden.)

`ReverseImport a b`: a file in layer `a` loading a file in layer `b` goes against that order, `b`
standing above `a`. These are all six such pairs; the rule says nothing about other groups. -/
inductive ReverseImport : Layer → Layer → Prop where
  | commonProcessShared : ReverseImport .common .processShared
  | commonSlack : ReverseImport .common .slack
  | commonSrc : ReverseImport .common .src
  | processSharedSlack : ReverseImport .processShared .slack
  | processSharedSrc : ReverseImport .processShared .src
  | slackSrc : ReverseImport .slack .src

/-- Rule 4 for a whole graph: every runtime edge joins two nodes of the graph, and none is a
reverse import. -/
def RespectsRule4 (g : Graph) : Prop :=
  ∀ e ∈ g.edges, e.src < g.nodeCount ∧ e.dst < g.nodeCount ∧ ¬ReverseImport (g.layer e.src) (g.layer e.dst)

/-- `Reaches g r v`: loading node `r` can load node `v`, through zero or more runtime edges. -/
inductive Reaches (g : Graph) (r : Nat) : Nat → Prop where
  | refl : Reaches g r r
  | step {u v : Nat} : Reaches g r u → ⟨u, v⟩ ∈ g.edges → Reaches g r v

/-- CLAUDE.md:99: "`src/cli/`가 import하는 모듈은 **module load 시 부수효과가 없어야** 한다.
`@soma/common/env-paths`는 로드 시 `git`을 실행하고 배너를 출력하므로, 순수 리졸버는
`@soma/common/soma-paths`에 있다. 여기서 실수하면 `--json` 첫 바이트가 배너가 된다." (Modules the
controller CLI imports must not have load-time side effects; env-paths runs `git` and prints a
banner when it loads, so a slip makes the banner the first bytes of `--json` output.)

`NeverLoads g r targets`: whichever code paths run, loading node `r` loads no node of
`targets`, directly or through any chain of loads. `Proofs.lean` roots it at `src/cli/index.ts`,
the `somawork` bin entry, so it covers what that entry can load; a file under `src/cli/` the
entry never loads is outside it. -/
def NeverLoads (g : Graph) (r : Nat) (targets : List Nat) : Prop :=
  ∀ t ∈ targets, ¬Reaches g r t

/-- packages/process-shared/src/mcp/base-mcp-server.ts:72: `const transport = new
StdioServerTransport();` (packages/mcp-servers/cron/cron-mcp-server.ts:675 constructs one
directly): an MCP server speaks JSON-RPC on its own stdout, which is how this repository's client
reads a server too (packages/process-shared/src/mcp/mcp-client.ts:114: "Handle stdout - JSON-RPC
messages"). packages/common/src/env-paths.ts:94 writes its banner with `console.log`, to stdout,
when the module loads.

`NoEntryLoads g entries targets`: no entry loads a target, directly or through any chain of
loads, so no target's load-time output is written by an entry's process. -/
def NoEntryLoads (g : Graph) (entries targets : List Nat) : Prop :=
  ∀ r ∈ entries, NeverLoads g r targets

/-- Coverage: the graph has exactly `fileCount` nodes, the number of production TypeScript files
the extractor counted in `git ls-files` before compiling anything. -/
def Covers (g : Graph) (fileCount : Nat) : Prop :=
  g.nodeCount = fileCount

end SomaVerify.ImportGraph
