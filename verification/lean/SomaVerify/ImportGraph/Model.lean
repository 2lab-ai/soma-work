-- models: scripts/verification/extract-import-graph.cjs:482-546 (extractGraph: nodes, edges, CLI root, certificate)
-- models: scripts/verification/extract-import-graph.cjs:370-406 (collectLoads: an edge is a `require` in the emit)
-- models: scripts/verification/extract-import-graph.cjs:66-98 (GROUPS, layerOf: the layer of each node)
-- models: rules/packaging.md:26 (rule 4's order, as `Layer.rank`)

/-!
# The runtime import graph, and the checkers the theorems run on it

`scripts/verification/extract-import-graph.cjs` writes one `Graph` to `Generated.lean`: a node for
each production TypeScript file, numbered from 0 in path order and tagged with the `Layer` its
path prefix puts it in, and an `Edge` for each (importer, imported) pair such that compiling the
importer to CommonJS emits a `require` that loads the imported file.

The checkers are Boolean functions, so the kernel can evaluate them on that concrete graph
(`decide +kernel` in `Proofs.lean`), which also shows that each checker implies the declarative
statement in `Spec.lean` it stands for.
-/

namespace SomaVerify.ImportGraph

/-- The group of a production file, by path prefix (`GROUPS` in the extractor; the first match
wins). rules/packaging.md rule 4 orders the first four; the others are unconstrained. -/
inductive Layer where
  /-- `packages/common/` -/
  | common
  /-- `packages/process-shared/` -/
  | processShared
  /-- `packages/slack/` -/
  | slack
  /-- `src/` -/
  | src
  /-- `somalib/` -/
  | somalib
  /-- `packages/test-utils/` -/
  | testUtils
  /-- `packages/mcp-servers/` -/
  | mcpServers
  /-- `scripts/` -/
  | scripts
  /-- Any other path; today only the root `vitest.config.ts`. -/
  | other
  deriving DecidableEq, Repr

/-- A runtime load: compiling node `src` emits a `require` that resolves to node `dst`. -/
structure Edge where
  src : Nat
  dst : Nat
  deriving DecidableEq, Repr

/-- The nodes are `0 .. layers.length - 1`, node `i` in layer `layers[i]`; `edges` lists each
(importer, imported) pair once. -/
structure Graph where
  layers : List Layer
  edges : List Edge

namespace Graph

/-- The number of nodes. -/
def nodeCount (g : Graph) : Nat :=
  g.layers.length

/-- The layer of node `i`; `other` past the last node, which is why the checkers below also
check that every edge joins two nodes. -/
def layer (g : Graph) (i : Nat) : Layer :=
  g.layers.getD i .other

end Graph

/-- Position in rule 4's order `common ← process-shared ← slack ← src`, bottom first; `none` for
a group rule 4 does not rank. -/
def Layer.rank : Layer → Option Nat
  | .common => some 0
  | .processShared => some 1
  | .slack => some 2
  | .src => some 3
  | _ => none

/-- May a file in layer `a` load a file in layer `b`? When rule 4 ranks both, only if `b` is not
above `a`; otherwise, yes. -/
def allowed (a b : Layer) : Bool :=
  match a.rank, b.rank with
  | some ra, some rb => decide (rb ≤ ra)
  | _, _ => true

/-- Both ends of every edge are nodes of the graph. -/
def edgesInRange (g : Graph) : Bool :=
  g.edges.all fun e => decide (e.src < g.nodeCount) && decide (e.dst < g.nodeCount)

/-- The layering checker: every edge joins two nodes and is `allowed`. -/
def layeringOk (g : Graph) : Bool :=
  edgesInRange g && g.edges.all fun e => allowed (g.layer e.src) (g.layer e.dst)

/-- `S` is closed under the edges: every edge that starts in `S` ends in `S`. -/
def closedUnder (g : Graph) (S : List Nat) : Bool :=
  g.edges.all fun e => !S.contains e.src || S.contains e.dst

/-- The closure-certificate checker: `S` contains `root` and is closed under the edges. -/
def closureOk (g : Graph) (root : Nat) (S : List Nat) : Bool :=
  S.contains root && closedUnder g S

/-- No node of `targets` is in `S`. -/
def excludes (S targets : List Nat) : Bool :=
  targets.all fun t => !S.contains t

end SomaVerify.ImportGraph
