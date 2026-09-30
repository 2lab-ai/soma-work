import SomaVerify.Support.Json

/-!
# Conformance-vector file format

Each `SomaVerify/<Module>/Vectors.lean` prints one document with `render`, and
`scripts/verification/lean-verify.sh` writes it to `verification/vectors/<module>.json`:

```
{"module":"<module>","generator":"<Lean decl>","lean":"<version>","count":N,"cases":[
<case 1>,
...
<case N>
]}
```

One case per line keeps review diffs readable. Everything else is `Json.render`, so the file
is a pure function of the case list and the Lean version that produced it: regenerating it on
an unchanged model is byte-identical, which is what the CI drift check relies on.
-/

namespace SomaVerify.Vectors

/-- The vector document for `module`. `generator` names the Lean declaration the cases come
from; pass it as a double-backtick literal (``` ``Foo.cases ```) so a renamed declaration is a
build error rather than a stale label. -/
def render (module : String) (generator : Lean.Name) (cases : List Json) : String :=
  "{\"module\":" ++ Json.quote module ++
    ",\"generator\":" ++ Json.quote generator.toString ++
    ",\"lean\":" ++ Json.quote Lean.versionString ++
    ",\"count\":" ++ toString cases.length ++
    ",\"cases\":[\n" ++
    ",\n".intercalate (cases.map Json.render) ++
    "\n]}\n"

end SomaVerify.Vectors
