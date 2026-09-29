import SomaVerify.SensitivePath.Model

/-!
# Invariants of the sensitive-path filter

What `src/sensitive-path-filter.ts` documents, stated over the model in `Model.lean`:

* `src/sensitive-path-filter.ts:4-5`: "Blocks non-admin users from reading sensitive host files
  via Claude tools (Read, Bash cat/head/tail, Glob, Grep)."
* `src/sensitive-path-filter.ts:23`: "Directories where any path underneath is blocked."
* `src/sensitive-path-filter.ts:71`: "Check if an absolute path points to a sensitive location."
* `src/sensitive-path-filter.ts:42`: "Regex patterns for sensitive basenames."
* `src/sensitive-path-filter.ts:49`: "Service config files containing secrets. Only specific files
  are blocked, not the whole directory."
* `src/sensitive-path-filter.ts:99`: "Match subdirectories: /opt/soma-work/*/{file}"
* `packages/common/src/path-utils.ts:11-21`: `/private/tmp` and `/tmp` name the same directory
  on macOS, and the module writes both as `/tmp`.

A "path" is what a Read, Grep or Glob call names: blocking every file underneath a directory
means blocking every spelling of those files, so the statements below quantify over spellings.
`src/sensitive-path-filter.ts:156-161` is where the model's spelling-independence comes from
(the fix for `.`, `..` and empty segments); it is not the source of any statement here.

Outside these statements (trust boundary):

* Bash. `checkBashSensitivePaths` pulls paths out of shell text with regular expressions
  (`src/sensitive-path-filter.ts:58-64, 131-142`). Which files a shell command reads is not
  decidable from its text (variables, quoting, globbing, command substitution, the working
  directory), so no statement here is about Bash commands; regression tests in
  `src/__tests__/sensitive-path-filter.test.ts` cover them.
* Relative paths. The tools resolve them against a working directory the module never sees, so
  the module checks them as written; the statements below are about absolute paths and HOME
  aliases.
* Symbolic links. Resolution here is lexical, like Node's `path.posix.normalize`: a `..` after a
  symbolic link is resolved against the link's name, not its target.
-/

namespace SomaVerify.SensitivePath.Spec

open SomaVerify.SensitivePath

/-- A segment an absolute path is left with once resolved: not empty, no `/`, not `.` or `..`. -/
def Proper (s : Seg) : Prop :=
  s ≠ [] ∧ '/' ∉ s ∧ s ≠ ['.'] ∧ s ≠ ['.', '.']

/-- A HOME in canonical form: an absolute path other than `/`, with no empty, `.` or `..` segment
and no trailing slash; `hs` are its segments, so the path is `renderAbs hs`. The model assumes
`os.homedir()` returns such a path; the module's `HOME` constant is then one as well
(`moduleHome`, which only rewrites `/private/tmp` to `/tmp`). -/
def HomeCanonical (hs : List Seg) : Prop :=
  hs ≠ [] ∧ ∀ s ∈ hs, Proper s

/-- A HOME constant outside `/private/tmp`. `FlaggedWhereverNamed` needs it and is false
without it: every checked path has `/private/tmp` rewritten to `/tmp`, so no checked path is
ever under a directory built from a HOME under `/private/tmp`. The module's own `HOME` always
satisfies it, because `moduleHome` rewrites `/private/tmp` in HOME too
(`src/sensitive-path-filter.ts:19-21`); `FlaggedWhereverNamedAtLoad` is the statement for the
module as loaded, with no such assumption. -/
def HomeOutsidePrivateTmp (hs : List Seg) : Prop :=
  ¬ (["private".toList, "tmp".toList] <+: hs)

/-- The segments of an absolute path, in order: those of `/a/b` are `a` and `b`. -/
def segmentsOf (n : List Char) : List Seg :=
  (splitSlash n).tail

/-- `SENSITIVE_DIRECTORIES` (`src/sensitive-path-filter.ts:24-32`) as segment lists, for HOME
`renderAbs hs`. -/
def sensitiveDirSegs (hs : List Seg) : List (List Seg) :=
  [hs ++ [".ssh".toList],
   hs ++ [".gnupg".toList],
   hs ++ [".config".toList, "gh".toList],
   hs ++ [".aws".toList],
   hs ++ [".docker".toList],
   hs ++ ["Library".toList, "Keychains".toList],
   ["etc".toList, "shadow".toList]]

/-- Lexical pathname resolution, after POSIX.1-2017 section 4.13 (Pathname Resolution) without
symbolic links: `Walk here segs there` holds when walking `segs` from the directory `here`
(its segments from the root) ends in `there`. An empty segment (from `//`, POSIX section 3.271)
and `.` stay where they are, `..` goes to the parent, and at the root `..` stays at the root
(the choice section 4.13 allows and Linux and macOS make). -/
inductive Walk : List Seg → List Seg → List Seg → Prop
  | done (here : List Seg) : Walk here [] here
  | stay (here : List Seg) (c : Seg) (rest there : List Seg) :
      (c = [] ∨ c = ['.']) → Walk here rest there → Walk here (c :: rest) there
  | up (here rest there : List Seg) :
      Walk here.dropLast rest there → Walk here (['.', '.'] :: rest) there
  | down (here : List Seg) (c : Seg) (rest there : List Seg) :
      c ≠ [] → c ≠ ['.'] → c ≠ ['.', '.'] → Walk (here ++ [c]) rest there →
      Walk here (c :: rest) there

/-- The absolute path `p` names the location `loc`. -/
def Names (p : List Char) (loc : List Seg) : Prop :=
  p.head? = some '/' ∧ Walk [] (splitSlash p) loc

/-- ECMAScript LineTerminator (ECMA-262 section 12.3, Table 37). -/
def lineTerminators : List Char :=
  ['\n', '\r', '\u2028', '\u2029']

/-- `/^\.env(\..+)?$/`: `.env`, or `.env.` and then at least one character, none of them a line
terminator (`.` does not match those without the `s` flag). -/
def EnvName (b : List Char) : Prop :=
  b = ".env".toList ∨ ∃ r, r ≠ [] ∧ (∀ c ∈ r, c ∉ lineTerminators) ∧ b = ".env.".toList ++ r

/-- `/^credentials\.json$/`. -/
def CredentialsName (b : List Char) : Prop :=
  b = "credentials.json".toList

/-- `/^secrets?\.(json|ya?ml|toml)$/`. -/
def SecretsName (b : List Char) : Prop :=
  ∃ stem ∈ ["secret".toList, "secrets".toList],
    ∃ ext ∈ ["json".toList, "yaml".toList, "yml".toList, "toml".toList], b = stem ++ '.' :: ext

/-- The service directories of `SENSITIVE_SERVICE_CONFIGS` (`src/sensitive-path-filter.ts:50-53`)
as segment lists. -/
def serviceDirSegs : List (List Seg) :=
  [["opt".toList, "soma-work".toList], ["opt".toList, "soma".toList]]

/-- The file names of `SENSITIVE_SERVICE_CONFIGS`. -/
def serviceFileNames : List Seg :=
  [".env".toList, "config.json".toList]

/-! ## The invariants -/

/-- (a) `normalizePath` returns a normal form: normalizing twice is normalizing once.
`packages/common/src/path-utils.ts:14-15`: "We standardize on the shorter /tmp form";
`src/sensitive-path-filter.ts:71`: "Check if an absolute path points to a sensitive location."
A check keyed on where a path points needs one form per location, and a form that is stable. -/
def NormalizeIdempotent (home : List Char) : Prop :=
  ∀ p, normalizePath home (normalizePath home p) = normalizePath home p

/-- (b) Checking a path and checking its normal form give the same result.
`src/sensitive-path-filter.ts:71`: "Check if an absolute path points to a sensitive
location." -/
def CheckInvariantUnderNormalize (home : List Char) : Prop :=
  ∀ p, checkSensitivePath home p = checkSensitivePath home (normalizePath home p)

/-- (b') Two absolute spellings of the same location get the same result, whatever `.`, `..`
and empty segments they are spelled with. `src/sensitive-path-filter.ts:71`: "Check if an
absolute path points to a sensitive location." -/
def SameLocationSameResult (home : List Char) : Prop :=
  ∀ p q loc, Names p loc → Names q loc → checkSensitivePath home p = checkSensitivePath home q

/-- The HOME aliases are checked as HOME spelled out, alone or followed by `/`.
`src/sensitive-path-filter.ts:4-5`: "Blocks non-admin users from reading sensitive host files
via Claude tools (Read, Bash cat/head/tail, Glob, Grep)"; `~` is expanded by the original code
and `$HOME`, `${HOME}` are how a shell spells the same directory. -/
def AliasesSpellHome (home : List Char) : Prop :=
  ∀ a ∈ homeAliases, checkSensitivePath home a = checkSensitivePath home home ∧
    ∀ rest, checkSensitivePath home (a ++ '/' :: rest) = checkSensitivePath home (home ++ '/' :: rest)

/-- (c) The directory test of `src/sensitive-path-filter.ts:78` is segment-aligned: a string is
at or below a sensitive directory exactly when it is absolute and that directory's segments
begin its segments. So a directory never covers a sibling whose name merely starts with its
name (`.sshx` next to `.ssh`). `src/sensitive-path-filter.ts:23`: "Directories where any path
underneath is blocked." -/
def DirectoryRuleSegmentAligned (hs : List Seg) : Prop :=
  ∀ n, (sensitiveDirectories (renderAbs hs)).any (underDirectory n) = true ↔
    n.head? = some '/' ∧ ∃ d ∈ sensitiveDirSegs hs, d <+: segmentsOf n

/-- (d) Every path whose normal form lies at or below a sensitive directory is reported
sensitive. `src/sensitive-path-filter.ts:23`: "Directories where any path underneath is
blocked." -/
def FlaggedWhenNormalizedUnder (hs : List Seg) : Prop :=
  ∀ p d, (normalizePath (renderAbs hs) p).head? = some '/' → d ∈ sensitiveDirSegs hs →
    d <+: segmentsOf (normalizePath (renderAbs hs) p) →
    (checkSensitivePath (renderAbs hs) p).isSensitive = true

/-- (d') For a HOME constant `renderAbs hs`: every absolute spelling of a location at or below a
sensitive directory is reported sensitive. `src/sensitive-path-filter.ts:23`: "Directories
where any path underneath is blocked." -/
def FlaggedWhereverNamed (hs : List Seg) : Prop :=
  ∀ p loc d, Names p loc → d ∈ sensitiveDirSegs hs → d <+: loc →
    (checkSensitivePath (renderAbs hs) p).isSensitive = true

/-- (d') For the module as loaded, whatever canonical path `os.homedir()` returns: every absolute
spelling of a location at or below one of the sensitive directories of that home directory is
reported sensitive. `src/sensitive-path-filter.ts:23`: "Directories where any path underneath
is blocked." -/
def FlaggedWhereverNamedAtLoad : Prop :=
  ∀ hs, HomeCanonical hs → ∀ p loc d, Names p loc → d ∈ sensitiveDirSegs hs → d <+: loc →
    (checkSensitivePath (moduleHome (renderAbs hs)) p).isSensitive = true

/-- (d'') For the module as loaded: a glob is reported sensitive when its concrete prefix (the text before the first glob
metacharacter, `src/sensitive-path-filter.ts:126`) names a location at or below a sensitive
directory. `src/sensitive-path-filter.ts:123`: "Check if a glob pattern targets a sensitive
directory." -/
def GlobFlaggedWherePrefixNamed : Prop :=
  ∀ hs, HomeCanonical hs → ∀ cwd pattern basePath loc d,
    Names (globPrefix (globResolved cwd pattern basePath)) loc → d ∈ sensitiveDirSegs hs → d <+: loc →
    (checkSensitiveGlob (moduleHome (renderAbs hs)) cwd pattern basePath).isSensitive = true

/-- (e) The basename rule is the union of the three patterns of lines 44-46.
`src/sensitive-path-filter.ts:42`: "Regex patterns for sensitive basenames." -/
def BasenameRuleDescribed : Prop :=
  ∀ b, basenamePatterns.any (fun test => test b) = true ↔
    EnvName b ∨ CredentialsName b ∨ SecretsName b

/-- (f) The service-config rule matches exactly the service files directly in a service
directory or exactly one directory below it. `src/sensitive-path-filter.ts:49`: "Service config
files containing secrets. Only specific files are blocked, not the whole directory.";
`src/sensitive-path-filter.ts:99`: "Match subdirectories: /opt/soma-work/*/{file}". -/
def ServiceRuleDescribed : Prop :=
  ∀ n, serviceConfigRule n = true ↔
    n.head? = some '/' ∧ ∃ dir ∈ serviceDirSegs, ∃ f ∈ serviceFileNames,
      segmentsOf n = dir ++ [f] ∨ ∃ m, segmentsOf n = dir ++ [m, f]

end SomaVerify.SensitivePath.Spec
