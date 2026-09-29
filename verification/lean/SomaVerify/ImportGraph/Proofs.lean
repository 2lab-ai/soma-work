import SomaVerify.ImportGraph.Spec
import SomaVerify.ImportGraph.Generated

/-!
# The import-graph theorems

First, for every graph, each checker of `Model.lean` implies the statement of `Spec.lean` it
stands for. Then the instances: the kernel evaluates each checker on `Generated.graph`
(`decide +kernel`, standard axioms only), and soundness turns the `true` into the statement about
the repository. The checkers are each run once over the whole edge list; the build log of
`lean-verify.sh` shows how long this module takes.
-/

namespace SomaVerify.ImportGraph

/-! ## The checkers are sound, for every graph -/

/-- `allowed` is rule 4 for one pair of layers, no stricter and no looser: it accepts a pair
exactly when the pair is not a reverse import. -/
theorem allowed_iff_not_reverse (a b : Layer) : allowed a b = true ↔ ¬ReverseImport a b := by
  constructor
  · intro h hr
    cases hr <;> revert h <;> decide
  · intro h
    cases a <;> cases b <;> first | rfl | exact absurd (by constructor) h

/-- If the layering checker accepts a graph, rule 4 holds for it: every edge joins two nodes of
the graph, and none is a reverse import. -/
theorem layeringOk_sound {g : Graph} (h : layeringOk g = true) : RespectsRule4 g := by
  simp only [layeringOk, edgesInRange, Bool.and_eq_true, List.all_eq_true, decide_eq_true_eq] at h
  intro e he
  exact ⟨(h.1 e he).1, (h.1 e he).2, (allowed_iff_not_reverse _ _).mp (h.2 e he)⟩

/-- A closure certificate is sound: if `S` contains `root` and every edge leaving a node of `S`
lands in `S`, then every node reachable from `root` is in `S`. -/
theorem closureOk_sound {g : Graph} {root : Nat} {S : List Nat} (h : closureOk g root S = true)
    {v : Nat} (hv : Reaches g root v) : v ∈ S := by
  simp only [closureOk, closedUnder, Bool.and_eq_true, List.all_eq_true, Bool.or_eq_true,
    Bool.not_eq_true', List.contains_iff_mem] at h
  induction hv with
  | refl => exact h.1
  | step _ he ih =>
    rcases h.2 _ he with hout | hin
    · rw [List.contains_iff_mem.mpr ih] at hout
      contradiction
    · exact hin

/-- If a closure certificate for `root` excludes every target, loading `root` never loads a
target. -/
theorem neverLoads_of_certificate {g : Graph} {root : Nat} {S targets : List Nat}
    (hS : closureOk g root S = true) (hT : excludes S targets = true) : NeverLoads g root targets := by
  intro t ht hreach
  simp only [excludes, List.all_eq_true, Bool.not_eq_true'] at hT
  have hout := hT t ht
  rw [List.contains_iff_mem.mpr (closureOk_sound hS hreach)] at hout
  contradiction

/-! ## On the repository -/

/-- Rule 4 holds for the production code: every runtime load between `packages/common`,
`packages/process-shared`, `packages/slack` and `src` goes down the order
`common ← process-shared ← slack ← src`, never up, and every edge joins two production files. -/
theorem repo_respects_rule4 : RespectsRule4 Generated.graph :=
  layeringOk_sound (by decide +kernel)

/-- The controller CLI never loads env-paths: node `cliRoot` is `src/cli/index.ts`, `envPaths`
are `src/env-paths.ts` and `packages/common/src/env-paths.ts`, and no chain of runtime loads from
the first reaches either of the others, counting lazy `import()` loads as well as static ones. -/
theorem cli_never_loads_env_paths :
    Generated.paths.size = Generated.graph.nodeCount ∧
      Generated.paths[Generated.cliRoot]? = some "src/cli/index.ts" ∧
      Generated.envPaths.map (Generated.paths[·]?) =
        [some "src/env-paths.ts", some "packages/common/src/env-paths.ts"] ∧
      NeverLoads Generated.graph Generated.cliRoot Generated.envPaths :=
  ⟨by decide +kernel, by decide +kernel, by decide +kernel,
    neverLoads_of_certificate (S := Generated.cliClosure) (by decide +kernel) (by decide +kernel)⟩

/-- Coverage: the graph has one node for each production TypeScript file `git ls-files` lists. -/
theorem repo_covered : Covers Generated.graph Generated.productionFileCount := by
  unfold Covers
  decide +kernel

end SomaVerify.ImportGraph

-- One line in the build log, for a reader of the gate's output: the size of the graph, and of
-- the closure certificate (an upper bound on what the CLI can load; the theorem uses only that).
open SomaVerify.ImportGraph in
#eval
  let g := Generated.graph
  s!"import graph: {g.nodeCount} production files, {g.edges.length} runtime edges; \
    {Generated.paths[Generated.cliRoot]!} loads at most {Generated.cliClosure.length} of them, \
    none of {Generated.envPaths.map (Generated.paths[·]!)}"
