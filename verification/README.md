# Verification

Lean 4 proofs about models of selected soma-work functions, tied to the real TypeScript by
conformance vectors. `npm run verify:lean` builds and audits the proofs and regenerates the
vectors; vitest replays the vectors against the TypeScript (`npm run test:release`, and CI).

## What is proven, what is tested

| Claim | Evidence | Kind |
|---|---|---|
| The model has property P | a theorem in `lean/SomaVerify/<Module>/`, checked by Lean's kernel on standard axioms only | proven |
| The TS function behaves like the model | `vectors/<module>.json` replayed against the real exported function by a `*.lean-conformance.test.ts` | tested, on the vector domain |
| The vectors are the model's current output | the CI job **Lean Verify** regenerates them and fails on any difference | checked on pushes to `main` and same-repository PRs |
| Every production file obeys a structural rule (layering, what the CLI and the MCP servers load) | an `ImportGraph` theorem over the graph the extractor writes from the checked-out sources | proven over that graph; the extractor is trusted |

- Lean proves properties of a **model**, a Lean transcription of a TypeScript function. The model
  generates **conformance vectors** (inputs and its outputs), committed under
  `verification/vectors/`, and vitest replays each one against the **real exported function**.
- **Lean Verify** (`.github/workflows/lean-verify.yml`) rebuilds and audits every proof,
  regenerates the vectors, fails on drift, then runs the gate's self-test. Fork PRs are refused by
  the same guard as `ci.yml`. The gate appends elan's and Homebrew's bin directories to `PATH`, so
  any Node stage runs on the Node the job itself set up.

Together: the theorem holds for the model, the model and the code agree on every vector, and the
vectors are the model's current output. Nothing stronger is claimed.

## Trust boundary

Trusted or tested, not proven:

- the JS engine, its regex engine, and the Node APIs the TS code calls;
- the correspondence between a model and its TS function beyond the vector domain (vectors
  sample the input space; they do not quantify over it);
- the JS semantics layer the models build on (`SomaVerify/Support/JsString.lean`: UTF-16 length,
  ECMAScript white space, trim, startsWith), tested against the engine like any model;
- Lean's kernel, compiler, core library and `leanchecker`, as pinned by `lean/lean-toolchain`.
  Vectors come from compiled Lean; the gate rejects every way this package could make its
  compiled code differ from its definitions, and core's native primitives are trusted.

The gate is not a sandbox: a same-repository PR can edit the gate script itself, and a Lean
module can run IO while it builds. It relies on the same fork guard and code review as `ci.yml`.

## Whole-code layer: the import graph

Besides the per-module models, `SomaVerify/ImportGraph/` proves facts about every production
TypeScript file at once. Stage 0 of the gate runs `scripts/verification/extract-import-graph.cjs`,
which compiles the repository with its own TypeScript and writes the runtime import graph (one node
per production file `git ls-files` lists, one edge per emitted `require`) to
`ImportGraph/Generated.lean`, gitignored and rebuilt on every run. The kernel then checks, over
that graph: `rules/packaging.md` rule 4 layering (`repo_respects_rule4`), that neither the
controller CLI nor any stdio MCP server loads an env-paths module (`cli_never_loads_env_paths`,
`mcp_servers_never_load_env_paths`), and that the graph covers every production file
(`repo_covered`). The extractor is trusted, not verified; `ImportGraph/Spec.lean` states what it
guarantees. `verification/LEDGER.md` (written by `scripts/verification/ledger.cjs`) records, per
production file, whether it also has a semantic model (`T2`) or only these theorems (`T1`).

## Method

Verification-guided development as AWS describes it for Cedar ("How We Built Cedar: A
Verification-Guided Approach", FSE 2024 industry track): an executable Lean model, proofs about
it, and differential testing of the production code against it; here, vectors replayed by vitest.

## Layout

```
verification/
  lean/                   Lake package; core Lean only (no Mathlib, no dependencies)
    lean-toolchain        pinned toolchain; lakefile.toml builds SomaVerify/** by glob
    SomaVerify/Support/   shared helpers: Json (serializer), JsString (JS semantics), Vectors (file format)
    SomaVerify/<Module>/  one folder per verified module
    SomaVerify/ImportGraph/  whole-code theorems; Generated.lean is written by the extractor
  vectors/<module>.json   generated, committed, drift-checked in CI
  LEDGER.md               per production file: T2 (semantic model) or T1 (import-graph theorems)
scripts/verification/lean-verify.sh   the gate, locally and in CI
scripts/verification/extract-*.cjs    stage 0: generated Lean data (the import graph)
```

## Adding a module

1. Create `lean/SomaVerify/<Module>/` (CamelCase; `Support` and `SelfTest` are reserved):
   - `Model.lean`: the model. Header comment: `-- models: <repo path>:<line range>`, e.g.
     `-- models: src/example/module.ts:12-48`.
   - `Spec.lean`: the invariants, as Lean propositions. `Proofs.lean`: the theorems.
   - `Vectors.lean`: a top-level `def main : IO Unit` that prints
     `SomaVerify.Vectors.render "<module>" ``<cases decl> <cases>`, where `<module>` is the folder
     name in kebab-case (`CliArgs` becomes `cli-args`). The gate rejects any other name.
2. Run `npm run verify:lean`. It writes `verification/vectors/<module>.json`; commit that file.
3. Add `<module>.lean-conformance.test.ts` next to the module's existing tests. It reads the vector
   file and calls the real exported function: no test-only exports, no re-implementation.
4. In the PR body, one table row per invariant:
   `| Invariant (English) | TS docstring line | Lean theorem |`.

Every file, generators included, imports only `Init` and `SomaVerify` modules and has no `partial
def` (use structural recursion, or `for` in `IO`). Deriving `Repr` or `BEq` on a nested inductive,
or `Ord` on a recursive one, also generates an opaque definition: write that instance by hand.
Write non-ASCII characters as `\u` escapes (`Char.ofNat` above U+FFFF). Discovery is by glob.

The source gate is a conservative writing policy, not a parser: if it flags harmless code, change
the code. It skips comments and literals, so prose and reason strings such as `"auto: native tool"`
or `"unsafe"` pass, and it matches `native` only in escape-hatch forms. It still rejects CRLF line
endings (use LF), and `sorry`/`axiom` as constructor names or `admit` in tactic position (rename
them). The declaration audit rejects any `opaque`, even one with a value: use `def`.

## Honesty gates

`scripts/verification/lean-verify.sh` fails closed on each of these:

- **source gate** (textual, fail-fast, code only): `sorry`, `axiom`, `partial`, `unsafe`,
  `implemented_by`, `extern`, `_unsafe_rec`, `skipKernelTC`; `admit` in tactic position;
  `native_decide`, `+native`, `decide (native := ..)`, `decide (config := {native := ..})`;
  `opaque` as a declaration; and, comments included, any invisible or non-ASCII white space;
- **a vacuous build**: `lake build` that builds nothing, or reports a declaration using `sorry`;
- **declaration audit**, per declaration of every module, however it was written: an axiom other
  than `propext`, `Classical.choice` and `Quot.sound`; anything `extern`, `implemented_by`,
  `unsafe` or opaque (what `partial def` compiles to); a hand-written `f._unsafe_rec`, which the
  code generator would run in place of `f`; an import outside `Init` and `SomaVerify`, since Lean's
  metaprogramming API can add declarations the kernel never checked;
- **kernel replay**: `leanchecker` re-checks every declaration of every module from its `.olean`;
- **polluted vectors**: a generator that prints anything besides the vector document (warnings
  are errors, since `lean --run` prints them on stdout), that names a different module, or a
  vector file with no generator;
- **drift** (`--check`): any modified or untracked file under `verification/vectors`.

`--selftest` plants each forbidden construct in a scratch copy; each soundness escape must be
rejected as CI runs the gate and again with the textual checks off (so the audit or the kernel
catches it alone), and a clean module full of the forbidden words as prose must pass. Counts
printed: theorems written in the sources, and theorem declarations checked (incl. generated).

## Commands

```
npm run verify:lean                                   # build, audit, replay, regenerate vectors
bash scripts/verification/lean-verify.sh --check      # what CI runs: also fail on drift
bash scripts/verification/lean-verify.sh --selftest   # every forbidden construct is rejected
npx vitest run scripts/verification/__tests__/        # replay the JS-semantics vectors
```

Lean comes from elan (`brew install elan-init`). The pinned toolchain installs on first use.
