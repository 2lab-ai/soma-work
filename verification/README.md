# Verification

Lean 4 proofs about models of selected soma-work functions, tied to the real TypeScript by
conformance vectors. One command runs everything: `npm run verify:lean`.

## What is proven, what is tested

| Claim | Evidence | Kind |
|---|---|---|
| The model has property P | a theorem in `lean/SomaVerify/<Module>/`, checked by Lean's kernel on standard axioms only | proven |
| The TS function behaves like the model | `vectors/<module>.json` replayed against the real exported function by a `*.lean-conformance.test.ts` | tested, on the vector domain |
| The vectors are the model's current output | the CI job **Lean Verify** regenerates them and fails on any difference | checked on pushes to `main` and same-repository PRs |

- Lean proves properties of a **model**: a Lean transcription of a TypeScript function, not the
  TypeScript itself.
- The model generates **conformance vectors** (inputs and the model's outputs), committed under
  `verification/vectors/`.
- vitest replays every vector against the **real exported function** and requires the same result.
- **Lean Verify** (`.github/workflows/lean-verify.yml`) rebuilds every proof, re-audits the
  axioms, regenerates the vectors and fails if the committed files drift from the model. It runs
  on pushes to `main` and on same-repository PRs; fork PRs are refused by the same guard as
  `ci.yml` and need a maintainer to run the gate from a same-repository branch.

Together: the theorem holds for the model, the model and the code agree on every vector, and the
vectors are the model's current output. Nothing stronger is claimed.

## Trust boundary

Trusted or tested, not proven:

- the JS engine, its regex engine, and the Node APIs the TS code calls;
- the correspondence between a model and its TS function beyond the vector domain (vectors
  sample the input space; they do not quantify over it);
- the JS semantics layer the models build on (`SomaVerify/Support/JsString.lean`: UTF-16 length,
  ECMAScript white space, trim). It is tested like any model, against the engine, by
  `scripts/verification/__tests__/js-string.lean-conformance.test.ts`;
- Lean's kernel, compiler and core library, at the version pinned in `lean/lean-toolchain`.
  Vectors come from compiled Lean. The source gate forbids `implemented_by` and `extern` in this
  package, so its own definitions run as the code the proofs are about; core operations they
  call (String and ByteArray primitives, for instance) run through core's native
  implementations, which are part of the trusted toolchain.

## Method

Verification-guided development as AWS describes it for Cedar ("How We Built Cedar: A
Verification-Guided Approach", FSE 2024 industry track): an executable Lean model, proofs about
the model, and differential testing of the production implementation against the model. Here the
differential tests are committed vector files, replayed by vitest.

## Layout

```
verification/
  lean/                   Lake package; core Lean only (no Mathlib, no dependencies)
    lean-toolchain        pinned toolchain
    lakefile.toml         builds every SomaVerify/** module by glob
    SomaVerify/Support/   shared helpers: Json (serializer), JsString (JS semantics), Vectors (file format)
    SomaVerify/<Module>/  one folder per verified module
  vectors/<module>.json   generated, committed, drift-checked in CI
scripts/verification/lean-verify.sh   the gate, locally and in CI
```

## Adding a module

1. Create `lean/SomaVerify/<Module>/` (CamelCase; `Support` is reserved for shared helpers):
   - `Model.lean`: the model. Header comment: `-- models: <repo path>:<line range>`, e.g.
     `-- models: src/example/module.ts:12-48`.
   - `Spec.lean`: the invariants, as Lean propositions.
   - `Proofs.lean`: the theorems.
   - `Vectors.lean`: a top-level `def main : IO Unit` that prints
     `SomaVerify.Vectors.render "<module>" ``<cases decl> <cases>`, where `<module>` is the folder
     name in kebab-case (`CliArgs` becomes `cli-args`). The gate rejects any other name.
2. Run `npm run verify:lean`. It writes `verification/vectors/<module>.json`; commit that file.
3. Add `<module>.lean-conformance.test.ts` next to the module's existing tests. It reads the vector
   file and calls the real exported function: no test-only exports, no re-implementation.
4. In the PR body, one table row per invariant:
   `| Invariant (English) | TS docstring line | Lean theorem |`.

No shared file changes: the lakefile, the axiom audit and vector generation all discover modules
by glob.

## Honesty gates

`scripts/verification/lean-verify.sh` fails closed on each of these:

- **escape hatches** in any `SomaVerify/**/*.lean`: `sorry`, `admit`, a user `axiom`,
  `native_decide` or `decide +native`, `implemented_by`, `extern`. The offending lines are
  printed. The match is textual, so keep these words out of comments too;
- **a vacuous build**: `lake build` that builds nothing, or that reports a declaration using
  `sorry`;
- **axioms**: any declaration in any module that depends on an axiom other than `propext`,
  `Classical.choice` and `Quot.sound`. Selection is by defining module, so a declaration outside
  the `SomaVerify` namespace is covered as well. The theorem count includes the lemmas Lean
  generates for inductive types and recursive definitions;
- **polluted vectors**: a generator that emits anything besides the vector document (warnings
  are errors, since `lean --run` prints them on stdout), that names a different module, or a
  vector file with no generator;
- **drift** (`--check`, what CI runs): any modified or untracked file under `verification/vectors`.

Each generator defines a top-level `main`, so two generators cannot be imported into one file.
The audit therefore runs one file for all other modules plus one per generator, and checks that
every module was audited exactly once.

## Commands

```
npm run verify:lean                                  # build, audit, regenerate vectors
bash scripts/verification/lean-verify.sh --check     # what CI runs: also fail on drift
npx vitest run scripts/verification/__tests__/       # replay the JS-semantics vectors
```

Lean comes from elan (`brew install elan-init`). The pinned toolchain installs on first use.
