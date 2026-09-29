-- models: src/sensitive-path-filter.ts:21-56 (HOME, SENSITIVE_* tables, HOME_ALIASES)
-- models: src/sensitive-path-filter.ts:72-111 (checkSensitivePath)
-- models: src/sensitive-path-filter.ts:124-129 (checkSensitiveGlob)
-- models: src/sensitive-path-filter.ts:144-164 (normalizePath)
-- models: packages/common/src/path-utils.ts:28-38 (normalizeTmpPath)

/-!
# Model of the sensitive-path filter

`src/sensitive-path-filter.ts` decides whether a non-admin Read, Grep or Glob call names a
sensitive host file; `src/agent-runtime/policy/tool-policy.ts` denies the call when it does.
This file transcribes the path side of the module: `normalizePath`, `checkSensitivePath` and
`checkSensitiveGlob`, together with the JS string and Node `path.posix` operations they call.
`checkBashSensitivePaths` is not modeled: it pulls paths out of shell text with regular
expressions, a heuristic that stays outside the proofs (see `Spec.lean`).

Strings are `List Char`. A Lean string denotes a well-formed JS string (see
`SomaVerify/Support/JsString.lean`), and every literal below is ASCII, so the character counts
used for `slice` are UTF-16 lengths. The module's `HOME` constant is the parameter `home`;
`moduleHome` computes it from `os.homedir()` the way the module does when it loads. The process
working directory that `path.resolve` falls back to is the parameter `cwd`.

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
  match resolveSegs (splitSlash (joinSlash (fromLastAbsolute (args.filter (fun a => !a.isEmpty))))) with
  | [] => ['/']
  | r => renderAbs r

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

/-! ## The rule tables (lines 21-56) -/

/-- `HOME` (line 21): `os.homedir()`, with `/private/tmp` written `/tmp` as `normalizePath`
writes checked paths. -/
def moduleHome (homedir : List Char) : List Char :=
  normalizeTmpPath homedir

/-- `SENSITIVE_DIRECTORIES` (lines 24-32), in order. -/
def sensitiveDirectories (home : List Char) : List (List Char) :=
  [pathJoin [home, ".ssh".toList],
   pathJoin [home, ".gnupg".toList],
   pathJoin [home, ".config".toList, "gh".toList],
   pathJoin [home, ".aws".toList],
   pathJoin [home, ".docker".toList],
   pathJoin [home, "Library".toList, "Keychains".toList],
   "/etc/shadow".toList]

/-- `SENSITIVE_EXACT_FILES` (lines 35-40). The source holds them in a `Set` and only asks
membership, so the order is immaterial. -/
def sensitiveExactFiles (home : List Char) : List (List Char) :=
  [pathJoin [home, ".gitconfig".toList],
   pathJoin [home, ".netrc".toList],
   pathJoin [home, ".npmrc".toList],
   pathJoin [home, ".claude".toList, "credentials.json".toList]]

/-- ECMAScript LineTerminator (ECMA-262 section 12.3, Table 37): the characters that `.` in a
regular expression without the `s` flag does not match. -/
def isLineTerminator (c : Char) : Bool :=
  c == '\n' || c == '\r' || c == '\u2028' || c == '\u2029'

/-- `/^\.env(\..+)?$/` (line 44): `.env`, or `.env.` followed by one or more characters none of
which is a line terminator. -/
def matchesEnv (b : List Char) : Bool :=
  match b with
  | '.' :: 'e' :: 'n' :: 'v' :: rest =>
    match rest with
    | [] => true
    | '.' :: tail => !tail.isEmpty && tail.all (fun c => !isLineTerminator c)
    | _ => false
  | _ => false

/-- `/^credentials\.json$/` (line 45). -/
def matchesCredentials (b : List Char) : Bool :=
  b == "credentials.json".toList

/-- The alternation `(json|ya?ml|toml)` after the `.` of line 46. -/
def isSecretsExtension (e : List Char) : Bool :=
  e == "json".toList || e == "yaml".toList || e == "yml".toList || e == "toml".toList

/-- `/^secrets?\.(json|ya?ml|toml)$/` (line 46): `secret`, an optional `s`, `.`, and one of the
extensions. -/
def matchesSecrets (b : List Char) : Bool :=
  match b with
  | 's' :: 'e' :: 'c' :: 'r' :: 'e' :: 't' :: rest =>
    match rest with
    | 's' :: '.' :: e => isSecretsExtension e
    | '.' :: e => isSecretsExtension e
    | _ => false
  | _ => false

/-- `SENSITIVE_BASENAME_PATTERNS` (lines 43-47), in order. -/
def basenamePatterns : List (List Char → Bool) :=
  [matchesEnv, matchesCredentials, matchesSecrets]

/-- `SENSITIVE_SERVICE_CONFIGS` (lines 50-53), in order. -/
def serviceConfigs : List (List Char × List (List Char)) :=
  [("/opt/soma-work".toList, [".env".toList, "config.json".toList]),
   ("/opt/soma".toList, [".env".toList, "config.json".toList])]

/-- `HOME_ALIASES` (line 56), in order. -/
def homeAliases : List (List Char) :=
  ["~".toList, "$HOME".toList, "${HOME}".toList]

/-! ## `normalizePath` (lines 144-164) -/

/-- The `HOME_ALIASES` loop (lines 146-155): the first alias that `filePath` starts with,
followed by `/`, is replaced through `path.join(HOME, rest)`; a path equal to an alias becomes
`HOME`; otherwise the path is unchanged. -/
def expandHome (home filePath : List Char) : List (List Char) → List Char
  | [] => filePath
  | a :: aliases =>
    if (a ++ ['/']).isPrefixOf filePath then pathJoin [home, filePath.drop (a.length + 1)]
    else if filePath == a then home
    else expandHome home filePath aliases

/-- `normalizePath`: expand a home alias, resolve an absolute path's `.`, `..` and empty
segments (lines 159-161), map `/private/tmp` to `/tmp`, drop trailing slashes. -/
def normalizePath (home filePath : List Char) : List Char :=
  let expanded := expandHome home filePath homeAliases
  let resolved := if ['/'].isPrefixOf expanded then posixNormalize expanded else expanded
  stripTrailingSlashes (normalizeTmpPath resolved)

/-! ## `checkSensitivePath` (lines 72-111) -/

/-- `SensitivePathResult`: `reason` is `none` where the source leaves it `undefined`. -/
structure Result where
  isSensitive : Bool
  reason : Option String

/-- `{ isSensitive: false }`. -/
def notSensitive : Result := ⟨false, none⟩

/-- The directory test of line 78: the path is the directory or lies below it. -/
def underDirectory (normalized dir : List Char) : Bool :=
  normalized == dir || (dir ++ ['/']).isPrefixOf normalized

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

/-! ## `checkSensitiveGlob` (lines 124-129) -/

/-- The characters `resolved.split(/[*?{}[\]]/)` splits on (line 127). -/
def isGlobMeta (c : Char) : Bool :=
  c == '*' || c == '?' || c == '{' || c == '}' || c == '[' || c == ']'

/-- Line 125: `basePath ? path.resolve(basePath, pattern) : pattern`. `path.resolve` falls back
to the working directory `cwd` only when neither argument is absolute. -/
def globResolved (cwd pattern : List Char) (basePath : Option (List Char)) : List Char :=
  match basePath with
  | some b => if b.isEmpty then pattern else pathResolve [cwd, b, pattern]
  | none => pattern

/-- Line 127: the text before the first glob metacharacter, without trailing slashes. -/
def globPrefix (resolved : List Char) : List Char :=
  stripTrailingSlashes (resolved.takeWhile (fun c => !isGlobMeta c))

/-- `checkSensitiveGlob(pattern, basePath)`: the concrete prefix, checked as a path. -/
def checkSensitiveGlob (home cwd pattern : List Char) (basePath : Option (List Char)) : Result :=
  checkSensitivePath home (globPrefix (globResolved cwd pattern basePath))

end SomaVerify.SensitivePath
