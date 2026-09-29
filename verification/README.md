# Verification

Lean 4 proofs about models of selected soma-work functions, tied to the real TypeScript by
conformance vectors. `npm run verify:lean` builds and audits the proofs and regenerates the
vectors; replaying the vectors against the TypeScript is ordinary vitest (`npm run test:release`,
and CI).

## What is proven, what is tested

| Claim | Evidence | Kind |
|---|---|---|
| The model has property P | a theorem in `lean/SomaVerify/<Module>/`, checked by Lean's kernel on standard axioms only | proven |
| The TS function behaves like the model | `vectors/<module>.json` replayed against the real exported function by a `*.lean-conformance.test.ts` | tested, on the vector domain |
| The vectors are the model's current output | the CI job **Lean Verify** regenerates them and fails on any difference | checked on pushes to `main` and same-repository PRs |

- Lean proves properties of a **model**: a Lean transcription of a TypeScript function, not the
  TypeScript itself. The model generates **conformance vectors** (inputs and its outputs),
  committed under `verification/vectors/`, and vitest replays every vector against the **real
  exported function**.
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
- Lean's kernel, compiler, core library and `leanchecker`, at the version pinned in
  `lean/lean-toolchain`. Vectors come from compiled Lean. The gate rejects every way this
  package could make its compiled code differ from its definitions (below); the core operations
  those definitions call run on core's native implementations, part of the trusted toolchain.

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

Every file, generators included, imports only `Init` and other `SomaVerify` modules and has no
`partial def`: use structural recursion, or a `for` loop in `IO`. Deriving `Repr` or `BEq` on a
nested inductive generates a partial definition too. Write non-ASCII characters as `\u` escapes
(or `Char.ofNat` above U+FFFF). No shared file changes: everything is discovered by glob.

## Honesty gates

`scripts/verification/lean-verify.sh` fails closed on each of these:

- **source gate** (textual, fail-fast): the words `sorry`, `admit`, `axiom`, `native...`,
  `implemented_by`, `extern`, `partial`, `unsafe`, `opaque`, `_unsafe_rec`, `skipKernelTC`
  anywhere in `SomaVerify/**/*.lean`, comments included, so keep them out of comments; and any
  invisible or non-ASCII white-space character;
- **a vacuous build**: `lake build` that builds nothing, or reports a declaration using `sorry`;
- **declaration audit**, per declaration of every module, however it was written: an axiom other
  than `propext`, `Classical.choice` and `Quot.sound`; anything `extern`, `implemented_by`,
  `unsafe` or opaque (what `partial def` compiles to); a hand-written `f._unsafe_rec`, which the
  code generator would run in place of `f`; an import outside `Init` and `SomaVerify`, since Lean's
  metaprogramming API can add declarations the kernel never checked;
- **kernel replay**: `leanchecker` re-checks every declaration of every module from the `.olean`
  files;
- **polluted vectors**: a generator that prints anything besides the vector document (warnings
  are errors, since `lean --run` prints them on stdout), that names a different module, or a
  vector file with no generator;
- **drift** (`--check`): any modified or untracked file under `verification/vectors`.

`--selftest` plants each forbidden construct as a module in a scratch copy. Each soundness escape
must be rejected twice: as CI runs the gate, and with the textual checks off, which shows the
declaration audit or the kernel catches it alone. An invisible character is a readability rule,
not a soundness one, so only the source gate rejects it. A clean module must pass both ways.

The gate prints two counts: theorems written in the sources, and theorem declarations the kernel
checked, which also include lemmas Lean generates for inductive types and recursive definitions.

## Commands

```
npm run verify:lean                                   # build, audit, replay, regenerate vectors
bash scripts/verification/lean-verify.sh --check      # what CI runs: also fail on drift
bash scripts/verification/lean-verify.sh --selftest   # every forbidden construct is rejected
npx vitest run scripts/verification/__tests__/        # replay the JS-semantics vectors
```

Lean comes from elan (`brew install elan-init`). The pinned toolchain installs on first use.
