-- models: src/sensitive-path-filter.ts:19-83 (HOME, SENSITIVE_* tables, HOME_ALIASES, FOLDED_LETTERS, keys)
-- models: src/sensitive-path-filter.ts:144-182 (checkSensitivePath)
-- models: src/sensitive-path-filter.ts:194-211 (checkSensitiveGlob)
-- models: src/sensitive-path-filter.ts:328-365 (expandHome, normalizePath, resolvePath, walkPoints, fold, foldKey)
-- models: packages/common/src/path-utils.ts:28-38 (normalizeTmpPath)

/-!
# Model of the sensitive-path filter

`src/sensitive-path-filter.ts` decides whether a non-admin Read, Grep or Glob call names a
sensitive host file; `src/agent-runtime/policy/tool-policy.ts` denies the call when it does.
This file transcribes the path side of the module: `normalizePath`, `walkPoints`, `fold`,
`checkSensitivePath` and `checkSensitiveGlob`, together with the JS string and Node `path.posix`
operations they call. `checkBashSensitivePaths` is not modeled: it pulls paths out of shell text
with regular expressions, a heuristic that stays outside the proofs (see `Spec.lean`).

Strings are `List Char`. A Lean string denotes a well-formed JS string (see
`SomaVerify/Support/JsString.lean`), and every literal below that is sliced is ASCII, so the
character counts used for `slice` are UTF-16 lengths. The module's `HOME` constant is the
parameter `home`; `moduleHome` computes it from `os.homedir()` the way the module does when it
loads. The process working directory that `path.resolve` falls back to is the parameter `cwd`.

The Node functions are transcribed from their documented behavior, for the inputs the module
gives them. `Vectors.lean` replays the whole model against the real module, so those
transcriptions are tested along with the rest.
-/

namespace SomaVerify.SensitivePath

/-- A path segment: the text between two `/`. -/
abbrev Seg := List Char

/-! ## JS string operations -/

/-- Put `c` in front of the first segment. -/
def consHead (c : Char) : List Seg → List Seg
  | [] => [[c]]
  | w :: ws => (c :: w) :: ws

/-- JS `s.split('/')`: the segments between slashes, empty ones included, so `""` splits into
`[""]` and `"/a"` into `["", "a"]`. -/
def splitSlash : List Char → List Seg
  | [] => [[]]
  | c :: cs => if c = '/' then [] :: splitSlash cs else consHead c (splitSlash cs)

/-- JS `segments.join('/')`. -/
def joinSlash : List Seg → List Char
  | [] => []
  | [s] => s
  | s :: t :: ts => s ++ '/' :: joinSlash (t :: ts)

/-- JS `s.replace(/\/+$/, '')`: `s` without its trailing slashes. -/
def stripTrailingSlashes (s : List Char) : List Char :=
  (s.reverse.dropWhile (· == '/')).reverse

/-! ## Node `path.posix` -/

/-- An absolute path spelled from its segments, `/s₁/…/sₙ`; no segments spell `""`. -/
def renderAbs : List Seg → List Char
  | [] => []
  | s :: ss => '/' :: (s ++ renderAbs ss)

/-- How Node spells a resolved directory: `renderAbs` of its segments, and `/` for the root. -/
def renderDir : List Seg → List Char
  | [] => ['/']
  | s :: ss => renderAbs (s :: ss)

/-- One step of Node's `normalizeString` on an absolute path, over the segments kept so far,
last kept first: an empty or `.` segment is dropped, `..` drops the last kept segment (at the
root there is none, so `..` stays at the root), and any other segment is kept. -/
def resolveStep (stack : List Seg) (s : Seg) : List Seg :=
  if s = [] ∨ s = ['.'] then stack
  else if s = ['.', '.'] then stack.tail
  else s :: stack

/-- The segments an absolute path resolves to, in order. -/
def resolveSegs (segs : List Seg) : List Seg :=
  (segs.foldl resolveStep []).reverse

/-- Node `path.posix.normalize(s)` for an absolute `s`, the only kind the model passes it: the
resolved segments, `/` when none are left, and a trailing `/` kept when `s` ends with one. -/
def posixNormalize (s : List Char) : List Char :=
  match resolveSegs (splitSlash s) with
  | [] => ['/']
  | r => renderAbs r ++ (if s.getLast? = some '/' then ['/'] else [])

/-- Node `path.posix.join(...args)` when the first argument is absolute: the non-empty
arguments joined with `/`, then normalized. -/
def pathJoin (args : List (List Char)) : List Char :=
  posixNormalize (joinSlash (args.filter (fun a => !a.isEmpty)))

/-- The arguments `path.posix.resolve` uses: from the last absolute one on. -/
def fromLastAbsolute : List (List Char) → List (List Char)
  | [] => []
  | a :: rest => if rest.any (fun b => b.head? == some '/') then fromLastAbsolute rest else a :: rest

/-- Node `path.posix.resolve(...args)`, with the process working directory (absolute) as the
first argument, where Node falls back to it: from the last absolute argument on, the non-empty
arguments joined with `/` and resolved, spelled without a trailing `/` (the root is `/`). -/
def pathResolve (args : List (List Char)) : List Char :=
  renderDir (resolveSegs (splitSlash (joinSlash (fromLastAbsolute (args.filter (fun a => !a.isEmpty))))))

/-- Node `path.posix.basename(s)`: the last segment once trailing slashes are dropped; `""` for
`""` and for a path made of slashes only. -/
def basename (s : List Char) : List Char :=
  ((splitSlash (stripTrailingSlashes s)).getLast?).getD []

/-! ## `normalizeTmpPath` (`packages/common/src/path-utils.ts:28-38`) -/

/-- `PRIVATE_TMP_PREFIX`. -/
def privateTmp : List Char := "/private/tmp".toList

/-- `/private/tmp` and `/private/tmp/…` become `/tmp` and `/tmp/…`; anything else, including a
false prefix such as `/private/tmpdata`, is returned unchanged. -/
def normalizeTmpPath (inputPath : List Char) : List Char :=
  if !privateTmp.isPrefixOf inputPath then inputPath
  else
    let rest := inputPath.drop privateTmp.length
    if rest != [] && !(['/'].isPrefixOf rest) then inputPath
    else "/tmp".toList ++ rest

/-! ## The rule tables (lines 19-83) -/

/-- `HOME` (line 22): `os.homedir()` resolved against the working directory, with `/private/tmp`
written `/tmp` as `normalizePath` writes checked paths. It is absolute whatever `os.homedir()`
returns. -/
def moduleHome (cwd homedir : List Char) : List Char :=
  normalizeTmpPath (pathResolve [cwd, homedir])

/-- `SENSITIVE_DIRECTORIES` (lines 25-33), in order. -/
def sensitiveDirectories (home : List Char) : List (List Char) :=
  [pathJoin [home, ".ssh".toList],
   pathJoin [home, ".gnupg".toList],
   pathJoin [home, ".config".toList, "gh".toList],
   pathJoin [home, ".aws".toList],
   pathJoin [home, ".docker".toList],
   pathJoin [home, "Library".toList, "Keychains".toList],
   "/etc/shadow".toList]

/-- `SENSITIVE_EXACT_FILES` (lines 36-41). The source holds them in a `Set` and only asks
membership (of their keys, line 83), so the order is immaterial. -/
def sensitiveExactFiles (home : List Char) : List (List Char) :=
  [pathJoin [home, ".gitconfig".toList],
   pathJoin [home, ".netrc".toList],
   pathJoin [home, ".npmrc".toList],
   pathJoin [home, ".claude".toList, "credentials.json".toList]]

/-- ECMAScript LineTerminator (ECMA-262 section 12.3, Table 37): the characters that `.` in a
regular expression without the `s` flag does not match. -/
def isLineTerminator (c : Char) : Bool :=
  c == '\n' || c == '\r' || c == '\u2028' || c == '\u2029'

/-- `/^\.env(\..+)?$/` (line 45): `.env`, or `.env.` followed by one or more characters none of
which is a line terminator. -/
def matchesEnv (b : List Char) : Bool :=
  match b with
  | '.' :: 'e' :: 'n' :: 'v' :: rest =>
    match rest with
    | [] => true
    | '.' :: tail => !tail.isEmpty && tail.all (fun c => !isLineTerminator c)
    | _ => false
  | _ => false

/-- `/^credentials\.json$/` (line 46). -/
def matchesCredentials (b : List Char) : Bool :=
  b == "credentials.json".toList

/-- The alternation `(json|ya?ml|toml)` after the `.` of line 47. -/
def isSecretsExtension (e : List Char) : Bool :=
  e == "json".toList || e == "yaml".toList || e == "yml".toList || e == "toml".toList

/-- `/^secrets?\.(json|ya?ml|toml)$/` (line 47): `secret`, an optional `s`, `.`, and one of the
extensions. -/
def matchesSecrets (b : List Char) : Bool :=
  match b with
  | 's' :: 'e' :: 'c' :: 'r' :: 'e' :: 't' :: rest =>
    match rest with
    | 's' :: '.' :: e => isSecretsExtension e
    | '.' :: e => isSecretsExtension e
    | _ => false
  | _ => false

/-- `SENSITIVE_BASENAME_PATTERNS` (lines 44-48), in order. -/
def basenamePatterns : List (List Char → Bool) :=
  [matchesEnv, matchesCredentials, matchesSecrets]

/-- `SENSITIVE_SERVICE_CONFIGS` (lines 54-57), in order. No `.env`: the basename patterns catch
every `.env` first. -/
def serviceConfigs : List (List Char × List (List Char)) :=
  [("/opt/soma-work".toList, ["config.json".toList]),
   ("/opt/soma".toList, ["config.json".toList])]

/-- `HOME_ALIASES` (line 60), in order. -/
def homeAliases : List (List Char) :=
  ["~".toList, "$HOME".toList, "${HOME}".toList]

/-- `FOLDED_LETTERS` (lines 67-79): the code points other than A-Z that `fold` rewrites, with what
it writes for each. -/
def foldedLetters : List (Char × List Char) :=
  [('ß', "ss".toList), ('ſ', "s".toList), ('ẞ', "ss".toList), ('K', "k".toList),
   ('ﬀ', "ff".toList), ('ﬁ', "fi".toList), ('ﬂ', "fl".toList), ('ﬃ', "ffi".toList),
   ('ﬄ', "ffl".toList), ('ﬅ', "st".toList), ('ﬆ', "st".toList)]

/-! ## `expandHome`, `normalizePath`, `resolvePath`, `walkPoints`, `fold`, `foldKey` (lines 328-365) -/

/-- `expandHome`: the first alias that `filePath` equals, or starts with followed by `/`, is
replaced by `HOME`; any other path is unchanged. -/
def expandHome (home filePath : List Char) : List (List Char) → List Char
  | [] => filePath
  | a :: aliases =>
    if filePath == a || (a ++ ['/']).isPrefixOf filePath then home ++ filePath.drop a.length
    else expandHome home filePath aliases

/-- `resolvePath`: resolve an absolute path's `.`, `..` and empty segments, map `/private/tmp` to
`/tmp`, drop trailing slashes. -/
def resolvePath (expanded : List Char) : List Char :=
  let resolved := if ['/'].isPrefixOf expanded then posixNormalize expanded else expanded
  stripTrailingSlashes (normalizeTmpPath resolved)

/-- `normalizePath`: expand a home alias, then `resolvePath`. -/
def normalizePath (home filePath : List Char) : List Char :=
  resolvePath (expandHome home filePath homeAliases)

/-- `walkPoints`: where the walk of the path is after each of its segments, that is each prefix of
the expanded path's segments, joined and resolved. -/
def walkPoints (home filePath : List Char) : List (List Char) :=
  let segments := splitSlash (expandHome home filePath homeAliases)
  (List.range segments.length).map fun i => resolvePath (joinSlash (segments.take (i + 1)))

/-- What `fold`'s replacement callback returns for one character: its `FOLDED_LETTERS` entry, or
`c.toLowerCase()`, which for the other characters the regular expression matches (A-Z) is the
ASCII lower-case letter. `Char.toLower` also keeps every character the expression does not
match, as the replacement does. -/
def foldChar (c : Char) : List Char :=
  match foldedLetters.lookup c with
  | some s => s
  | none => [c.toLower]

/-- `fold(text)`. -/
def fold (s : List Char) : List Char :=
  s.flatMap foldChar

/-- `foldKey(normalized)`: folded, then `/private/tmp` written `/tmp` again. -/
def foldKey (normalized : List Char) : List Char :=
  normalizeTmpPath (fold normalized)

/-! ## `checkSensitivePath` (lines 144-182) -/

/-- `SensitivePathResult`: `reason` is `none` where the source leaves it `undefined`. -/
structure Result where
  isSensitive : Bool
  reason : Option String

/-- `{ isSensitive: false }`. -/
def notSensitive : Result := ⟨false, none⟩

/-- The directory test of line 153, on keys: the path is the directory or lies below it. -/
def underDirectory (normalized dir : List Char) : Bool :=
  normalized == dir || (dir ++ ['/']).isPrefixOf normalized

/-- Lines 122-123 for one point: the first sensitive directory whose key the point's key is at or
below (`DIRECTORY_KEYS` holds the keys in table order). -/
def directoryHit (home point : List Char) : Option (List Char) :=
  (sensitiveDirectories home).find? (fun dir => underDirectory (foldKey point) (foldKey dir))

/-- The body of the service-config loop (lines 174-178) for one entry: below `dir`, at most two
segments, the last one of `files`. `split` never returns an empty list, so the last segment
always exists. -/
def serviceConfigHit (key dir : List Char) (files : List (List Char)) : Bool :=
  if !(dir ++ ['/']).isPrefixOf key then false
  else
    let parts := splitSlash (key.drop (dir.length + 1))
    parts.length ≤ 2 && files.contains (parts.getLast?.getD [])

/-- Whether the service-config loop (lines 173-179) returns. Every return there carries the same
reason, so which entry matched first does not matter. -/
def serviceConfigRule (key : List Char) : Bool :=
  serviceConfigs.any (fun entry => serviceConfigHit key entry.1 entry.2)

/-- Lines 121-151, in source order, each returning on the first rule that matches: the directory
rule on the normalized path and then on each walk point, then the exact files, the basename
patterns and the service configs on the normalized path. -/
def verdict (home normalized : List Char) (walk : List (List Char)) : Result :=
  match (normalized :: walk).findSome? (directoryHit home) with
  | some dir => ⟨true, some ("Access to " ++ String.ofList dir ++ "/ is restricted")⟩
  | none =>
    if ((sensitiveExactFiles home).map foldKey).contains (foldKey normalized) then
      ⟨true, some ("Access to " ++ String.ofList normalized ++ " is restricted")⟩
    else if basenamePatterns.any (fun test => test (fold (basename normalized))) then
      ⟨true, some ("File " ++ String.ofList (basename normalized) ++ " matches sensitive pattern")⟩
    else if serviceConfigRule (foldKey normalized) then
      ⟨true, some ("Service config " ++ String.ofList normalized ++ " is restricted")⟩
    else notSensitive

/-- `checkSensitivePath(filePath)`. -/
def checkSensitivePath (home filePath : List Char) : Result :=
  verdict home (normalizePath home filePath) (walkPoints home filePath)

/-! ## `checkSensitiveGlob` (lines 194-211) -/

/-- The characters `spelling.split(/[*?{}[\]]/)` splits on (line 204). -/
def isGlobMeta (c : Char) : Bool :=
  c == '*' || c == '?' || c == '{' || c == '}' || c == '[' || c == ']'

/-- Lines 168-170: with a base path (a non-empty one: `''` is falsy), `path.resolve(basePath,
pattern)` and the pattern written after the base (the pattern alone when absolute); without
one, the pattern. `path.resolve` falls back to the working directory `cwd` only when neither
argument is absolute. -/
def globSpellings (cwd pattern : List Char) (basePath : Option (List Char)) : List (List Char) :=
  match basePath with
  | some b =>
    if b.isEmpty then [pattern]
    else [pathResolve [cwd, b, pattern], if ['/'].isPrefixOf pattern then pattern else b ++ '/' :: pattern]
  | none => [pattern]

/-- Line 174: the text before the first glob metacharacter. -/
def globConcrete (spelling : List Char) : List Char :=
  spelling.takeWhile (fun c => !isGlobMeta c)

/-- `concrete.replace(/\/+$/, '')` (line 205): the concrete text without trailing slashes. -/
def globPrefix (spelling : List Char) : List Char :=
  stripTrailingSlashes (globConcrete spelling)

/-- `s.slice(0, s.lastIndexOf('/') + 1)` (line 205): `s` up to and including its last `/`, and
`""` when it has none. -/
def cutToLastSlash (s : List Char) : List Char :=
  (s.reverse.dropWhile (· != '/')).reverse

/-- The directory the glob lists (line 205): the concrete text cut back to its last `/`, since the
segment the metacharacter is in is a pattern, not a directory. -/
def globListed (spelling : List Char) : List Char :=
  cutToLastSlash (globConcrete spelling)

/-- The two paths line 205 checks for one spelling: the concrete text without trailing slashes,
and the directory the glob lists. -/
def globCandidates (spelling : List Char) : List (List Char) :=
  [globPrefix spelling, globListed spelling]

/-- `checkSensitiveGlob(pattern, basePath)`: the first sensitive result among the candidates of
the spellings, in order. -/
def checkSensitiveGlob (home cwd pattern : List Char) (basePath : Option (List Char)) : Result :=
  ((((globSpellings cwd pattern basePath).flatMap globCandidates).map (checkSensitivePath home)).find?
    (fun r => r.isSensitive)).getD notSensitive

end SomaVerify.SensitivePath
