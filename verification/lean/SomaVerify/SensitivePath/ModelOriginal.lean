-- models: src/sensitive-path-filter.ts at 168903e8, lines 50-53 (SENSITIVE_SERVICE_CONFIGS)
-- models: src/sensitive-path-filter.ts at 168903e8, lines 72-111 (checkSensitivePath)
-- models: src/sensitive-path-filter.ts at 168903e8, lines 124-129 (checkSensitiveGlob)
import SomaVerify.SensitivePath.Model

/-!
# The phase-1 model, kept as the original

The model as verified at 168903e8, for the definitions the simplification changed:
`checkSensitivePath` lost its early return for the empty path, and the service-config table and
loop took the form that `service_rule_described` proves they had. Everything else is shared
with `Model.lean` unchanged. `ProofsOriginal.lean` proves each simplified function equal to its
original here, so every theorem about the original carries over.
-/

namespace SomaVerify.SensitivePath.Original

open SomaVerify.SensitivePath

/-- `SENSITIVE_SERVICE_CONFIGS` (lines 50-53), in order. -/
def serviceConfigs : List (List Char × List (List Char)) :=
  [("/opt/soma-work".toList, [".env".toList, "config.json".toList]),
   ("/opt/soma".toList, [".env".toList, "config.json".toList])]

/-- The body of the inner service-config loop (lines 96-106) for one `dir` and `file`: true
where the source returns. -/
def serviceConfigHit (normalized dir file : List Char) : Bool :=
  if normalized == pathJoin [dir, file] then true
  else if (dir ++ ['/']).isPrefixOf normalized && ('/' :: file).isSuffixOf normalized then
    let relative := normalized.drop (dir.length + 1)
    let parts := splitSlash relative
    parts.length == 2 && parts[1]? == some file
  else false

/-- Whether the service-config loop (lines 94-108) returns. Every return there carries the same
reason, so which entry matched first does not matter. -/
def serviceConfigRule (normalized : List Char) : Bool :=
  serviceConfigs.any (fun entry => entry.2.any (fun file => serviceConfigHit normalized entry.1 file))

/-- Lines 77-110, the checks on the normalized path, in source order; each returns on the
first rule that matches. -/
def verdict (home normalized : List Char) : Result :=
  match (sensitiveDirectories home).find? (underDirectory normalized) with
  | some dir => ⟨true, some ("Access to " ++ String.ofList dir ++ "/ is restricted")⟩
  | none =>
    if (sensitiveExactFiles home).contains normalized then
      ⟨true, some ("Access to " ++ String.ofList normalized ++ " is restricted")⟩
    else if basenamePatterns.any (fun test => test (basename normalized)) then
      ⟨true, some ("File " ++ String.ofList (basename normalized) ++ " matches sensitive pattern")⟩
    else if serviceConfigRule normalized then
      ⟨true, some ("Service config " ++ String.ofList normalized ++ " is restricted")⟩
    else notSensitive

/-- `checkSensitivePath(filePath)`: the empty path is not sensitive (line 73); anything else is
normalized and checked. -/
def checkSensitivePath (home filePath : List Char) : Result :=
  if filePath.isEmpty then notSensitive else verdict home (normalizePath home filePath)

/-- `checkSensitiveGlob(pattern, basePath)` (lines 124-129): the concrete prefix, checked as a
path. -/
def checkSensitiveGlob (home cwd pattern : List Char) (basePath : Option (List Char)) : Result :=
  checkSensitivePath home (globPrefix (globResolved cwd pattern basePath))

end SomaVerify.SensitivePath.Original
