import SomaVerify.SensitivePath.Model
import SomaVerify.SensitivePath.ModelOriginal

/-!
# Invariants of the sensitive-path filter

What `src/sensitive-path-filter.ts` documents, stated over the model in `Model.lean`:

* `src/sensitive-path-filter.ts:4-5`: "Blocks non-admin users from reading sensitive host files
  via Claude tools (Read, Bash cat/head/tail, Glob, Grep)."
* `src/sensitive-path-filter.ts:24`: "Directories where any path underneath is blocked."
* `src/sensitive-path-filter.ts:144`: "Check if an absolute path points to a sensitive location."
* `src/sensitive-path-filter.ts:43`: "Regex patterns for sensitive basenames."
* `src/sensitive-path-filter.ts:51`: "Service config files containing secrets. Only specific files
  are blocked, not the whole directory."
* `src/sensitive-path-filter.ts:171`: "A service config sits in its directory or one directory below
  it: /opt/soma-work/{,*/}{file}" (at 168903e8, line 99: "Match subdirectories:
  /opt/soma-work/*/{file}").
* `src/sensitive-path-filter.ts:194`: "Check if a glob pattern targets a sensitive directory."
* `packages/common/src/path-utils.ts:11-21`: `/private/tmp` and `/tmp` name the same directory
  on macOS, and the module writes both as `/tmp`.
* `README.md:398`: the service runs on macOS, whose default file system (APFS) compares names
  case-insensitively.

A "path" is what a Read, Grep or Glob call names: blocking every file underneath a directory
means blocking every spelling of those files, so the statements below quantify over spellings,
and compare names the way the file system does (`canon`: case-folded, `/private/tmp` the same
as `/tmp`). A HOME is an absolute path, as the module's always is (`moduleHome_absolute`).

Outside these statements (trust boundary):

* Bash. `checkBashSensitivePaths` pulls paths out of shell text with regular expressions
  (`src/sensitive-path-filter.ts:85-137, 213-326`). Which files a shell command reads is not
  decidable from its text (variables, quoting, globbing, command substitution, the working
  directory), so no statement here is about Bash commands; regression tests in
  `src/__tests__/sensitive-path-filter.test.ts` cover them. Commands other than the listed
  readers are not examined at all.
* Relative paths and the working directory. The tools resolve relative paths, and a Glob's
  relative base, against a working directory the module never sees, so the module checks them
  as written; the statements below are about absolute paths and HOME aliases.
* Symbolic links outside the sensitive directories. Resolution here is lexical, like Node's
  `path.posix.normalize`; after a symbolic link the operating system climbs `..` from the link's
  target instead. A walk that enters a sensitive directory is flagged wherever it ends
  (`WalkThroughSensitiveFlagged`), so a link inside one cannot lead out of the check; a link
  elsewhere that points into one is not seen.
* `~user`. Only `~`, `$HOME` and `${HOME}` are expanded.
* Glob partial segments. A segment holding a metacharacter matches names the module does not
  list: the check covers the text before the first metacharacter and the directory the glob
  lists (`ListedDirectory`), not the names the partial segment could match (`~/.ss*/id_rsa`).
* Unicode normalization. Names are compared case-folded (`fold`), not normalized (NFC or NFD);
  every sensitive name is ASCII.
* The operating system's read deny list. `getSensitiveReadDenyPaths` builds one; nothing applies
  it.
-/

namespace SomaVerify.SensitivePath.Spec

open SomaVerify.SensitivePath

/-- A segment an absolute path is left with once resolved: not empty, no `/`, not `.` or `..`. -/
def Proper (s : Seg) : Prop :=
  s ≠ [] ∧ '/' ∉ s ∧ s ≠ ['.'] ∧ s ≠ ['.', '.']

/-- The segments of an absolute path, in order: those of `/a/b` are `a` and `b`. -/
def segmentsOf (n : List Char) : List Seg :=
  (splitSlash n).tail

/-- The segment `private`. -/
def privateSeg : Seg := "private".toList

/-- The segment `tmp`. -/
def tmpSeg : Seg := "tmp".toList

/-- `/private/tmp` rewritten to `/tmp`, on segments. -/
def tmpMapSegs (r : List Seg) : List Seg :=
  match r with
  | s :: t :: rest => if s = privateSeg ∧ t = tmpSeg then tmpSeg :: rest else r
  | _ => r

/-- Where a location is on the file system the module guards: every name case-folded (APFS
compares names that way, `README.md:398`), and `/private/tmp` the same directory as `/tmp`
(`packages/common/src/path-utils.ts:11-21`). Two locations are the same directory there when
`canon` makes them equal. -/
def canon (l : List Seg) : List Seg :=
  tmpMapSegs (l.map fold)

/-- `SENSITIVE_DIRECTORIES` (`src/sensitive-path-filter.ts:25-33`) as locations, for a HOME at
the location `hloc`. -/
def sensitiveDirSegs (hloc : List Seg) : List (List Seg) :=
  [hloc ++ [".ssh".toList],
   hloc ++ [".gnupg".toList],
   hloc ++ [".config".toList, "gh".toList],
   hloc ++ [".aws".toList],
   hloc ++ [".docker".toList],
   hloc ++ ["Library".toList, "Keychains".toList],
   ["etc".toList, "shadow".toList]]

/-- The location `v` is at or below a sensitive directory of a HOME at `hloc`, on that file
system. -/
def InsideSensitive (hloc v : List Seg) : Prop :=
  ∃ d ∈ sensitiveDirSegs hloc, canon d <+: canon v

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

/-- The walk of the absolute path `p` passes through `v`: `v` is where it is after some number of
`p`'s segments (the root before the first, the location `p` names after the last). Without
symbolic links only the last one is read; after a symbolic link, `..` climbs from the link's
target, so a walk that passes through a directory may end anywhere below it. -/
def Visits (p : List Char) (v : List Seg) : Prop :=
  p.head? = some '/' ∧ ∃ i, Walk [] ((splitSlash p).take i) v

/-- `os.homedir()` names the location `hloc`; a relative one is resolved from the working
directory `cwd`, as `path.resolve` resolves it. -/
def HomeNames (cwd homedir : List Char) (hloc : List Seg) : Prop :=
  ∃ c, Names cwd c ∧ Walk (if homedir.head? = some '/' then [] else c) (splitSlash homedir) hloc

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

/-- The service directories of `SENSITIVE_SERVICE_CONFIGS` (`src/sensitive-path-filter.ts:54-57`)
as segment lists. -/
def serviceDirSegs : List (List Seg) :=
  [["opt".toList, "soma-work".toList], ["opt".toList, "soma".toList]]

/-- The service config files, the ones line 51 documents: `.env` and `config.json`. -/
def serviceFileNames : List Seg :=
  [".env".toList, "config.json".toList]

/-- The file names `SENSITIVE_SERVICE_CONFIGS` lists since the simplification: `config.json`.
The basename patterns catch every `.env` before the table is consulted. -/
def serviceTableFileNames : List Seg :=
  ["config.json".toList]

/-- A service-config rule that matches exactly the files named `files` directly in a service
directory or exactly one directory below it. -/
def ServiceRuleMatches (rule : List Char → Bool) (files : List Seg) : Prop :=
  ∀ n, rule n = true ↔
    n.head? = some '/' ∧ ∃ dir ∈ serviceDirSegs, ∃ f ∈ files,
      segmentsOf n = dir ++ [f] ∨ ∃ m, segmentsOf n = dir ++ [m, f]

/-! ## The invariants -/

/-- (a) `normalizePath` returns a normal form: normalizing twice is normalizing once.
`packages/common/src/path-utils.ts:14-15`: "We standardize on the shorter /tmp form";
`src/sensitive-path-filter.ts:144`: "Check if an absolute path points to a sensitive location."
A check keyed on where a path points needs one form per location, and a form that is stable. -/
def NormalizeIdempotent (home : List Char) : Prop :=
  ∀ p, normalizePath home (normalizePath home p) = normalizePath home p

/-- (b) Checking a path gives what checking its normal form gives, or flags the path: the only
answer the path's own spelling can change is to block it (a walk through a sensitive
directory). `src/sensitive-path-filter.ts:144`: "Check if an absolute path points to a sensitive
location." -/
def CheckRefinesNormalForm (home : List Char) : Prop :=
  ∀ p, checkSensitivePath home p = checkSensitivePath home (normalizePath home p) ∨
    (checkSensitivePath home p).isSensitive = true

/-- (b') Two absolute spellings of the same location whose walks pass through no sensitive
directory get the same result, whatever `.`, `..` and empty segments they are spelled with: the
verdict depends only on the location. `src/sensitive-path-filter.ts:144`: "Check if an absolute
path points to a sensitive location." -/
def SameLocationSameResult (home : List Char) : Prop :=
  ∀ hloc, Names home hloc → ∀ p q loc, Names p loc → Names q loc →
    (∀ v, Visits p v → ¬ InsideSensitive hloc v) → (∀ v, Visits q v → ¬ InsideSensitive hloc v) →
    checkSensitivePath home p = checkSensitivePath home q

/-- (b'') Every absolute path whose walk passes through a sensitive directory is reported
sensitive, wherever the walk ends: after a symbolic link inside the directory, `..` climbs from
the link's target, so the walk may end anywhere below it. `src/sensitive-path-filter.ts:24`:
"Directories where any path underneath is blocked." -/
def WalkThroughSensitiveFlagged (home : List Char) : Prop :=
  ∀ hloc, Names home hloc → ∀ p v, Visits p v → InsideSensitive hloc v →
    (checkSensitivePath home p).isSensitive = true

/-- (b''') The verdict does not depend on case: folding a path (other than one starting with `$`,
which may be a `$HOME` alias that folding turns into `$home`) leaves `isSensitive` as it was.
`README.md:398` and APFS: names that fold alike name the same file. -/
def FoldInvariant (home : List Char) : Prop :=
  ∀ p, p.head? ≠ some '$' →
    (checkSensitivePath home (fold p)).isSensitive = (checkSensitivePath home p).isSensitive

/-- The HOME aliases are checked as HOME spelled out, alone or followed by `/`.
`src/sensitive-path-filter.ts:4-5`: "Blocks non-admin users from reading sensitive host files
via Claude tools (Read, Bash cat/head/tail, Glob, Grep)"; `~` is expanded by the original code
and `$HOME`, `${HOME}` are how a shell spells the same directory. -/
def AliasesSpellHome (home : List Char) : Prop :=
  ∀ a ∈ homeAliases, checkSensitivePath home a = checkSensitivePath home home ∧
    ∀ rest, checkSensitivePath home (a ++ '/' :: rest) = checkSensitivePath home (home ++ '/' :: rest)

/-- (c) The directory test of `src/sensitive-path-filter.ts:123` is segment-aligned: a point is at
or below a sensitive directory exactly when it is absolute and that directory's segments begin
its segments, compared as `canon` compares them. So a directory never covers a sibling whose
name merely starts with its name (`.sshx` next to `.ssh`). `src/sensitive-path-filter.ts:24`:
"Directories where any path underneath is blocked." -/
def DirectoryRuleSegmentAligned (home : List Char) (hloc : List Seg) : Prop :=
  ∀ n, (directoryHit home n).isSome = true ↔
    n.head? = some '/' ∧ ∃ d ∈ sensitiveDirSegs hloc, canon d <+: canon (segmentsOf n)

/-- (d) Every path whose normal form lies at or below a sensitive directory is reported
sensitive. `src/sensitive-path-filter.ts:24`: "Directories where any path underneath is
blocked." -/
def FlaggedWhenNormalizedUnder (home : List Char) (hloc : List Seg) : Prop :=
  ∀ p d, (normalizePath home p).head? = some '/' → d ∈ sensitiveDirSegs hloc →
    canon d <+: canon (segmentsOf (normalizePath home p)) →
    (checkSensitivePath home p).isSensitive = true

/-- (d') Every absolute spelling of a location at or below a sensitive directory is reported
sensitive. `src/sensitive-path-filter.ts:24`: "Directories where any path underneath is
blocked." -/
def FlaggedWhereverNamed (home : List Char) : Prop :=
  ∀ hloc, Names home hloc → ∀ p loc, Names p loc → InsideSensitive hloc loc →
    (checkSensitivePath home p).isSensitive = true

/-- (d') For the module as loaded, whatever `os.homedir()` returns and wherever it points: every
absolute path whose walk passes through a sensitive directory of that home directory is reported
sensitive. `src/sensitive-path-filter.ts:24`: "Directories where any path underneath is
blocked." -/
def FlaggedWhereverNamedAtLoad : Prop :=
  ∀ cwd homedir hloc, cwd.head? = some '/' → HomeNames cwd homedir hloc →
    ∀ p v, Visits p v → InsideSensitive hloc v →
      (checkSensitivePath (moduleHome cwd homedir) p).isSensitive = true

/-- (d'') A glob is reported sensitive whenever one of the paths it is checked through is: the
concrete prefix and the listed directory of the pattern resolved against its base, and of the
pattern written after its base. `src/sensitive-path-filter.ts:194`: "Check if a glob pattern
targets a sensitive directory." -/
def GlobChecksItsDirectories (home : List Char) : Prop :=
  ∀ cwd pattern basePath, ∀ s ∈ globSpellings cwd pattern basePath, ∀ t ∈ globCandidates s,
    (checkSensitivePath home t).isSensitive = true →
    (checkSensitiveGlob home cwd pattern basePath).isSensitive = true

/-- (d'') The directory a glob lists: the text before the first metacharacter, without the
partial segment the metacharacter is in (a segment that holds a metacharacter is a pattern, not
a directory). `globListed_spec` shows the model's `globListed` is this directory. -/
def ListedDirectory (spelling listed : List Char) : Prop :=
  ∃ w, globConcrete spelling = listed ++ w ∧ '/' ∉ w ∧ (listed = [] ∨ listed.getLast? = some '/')

/-- (e) The basename rule is the union of the three patterns of lines 45-47.
`src/sensitive-path-filter.ts:43`: "Regex patterns for sensitive basenames." -/
def BasenameRuleDescribed : Prop :=
  ∀ b, basenamePatterns.any (fun test => test b) = true ↔
    EnvName b ∨ CredentialsName b ∨ SecretsName b

/-- (f) The service-config rule matches exactly the files its table lists, directly in a
service directory or exactly one directory below it. `src/sensitive-path-filter.ts:51`: "Service
config files containing secrets. Only specific files are blocked, not the whole directory."; the
comment above the loop: "A service config sits in its directory or one directory below it". -/
def ServiceRuleDescribed : Prop :=
  ServiceRuleMatches serviceConfigRule serviceTableFileNames

/-- (f) What the service rule is for, observed through `checkSensitivePath`: every service config
file, `.env` or `config.json` in any case, directly in a service directory or one directory below
it, is reported sensitive. `src/sensitive-path-filter.ts:51`: "Service config files containing
secrets." -/
def ServiceConfigsFlagged (home : List Char) : Prop :=
  ∀ p, (normalizePath home p).head? = some '/' →
    (∃ dir ∈ serviceDirSegs, ∃ f ∈ serviceFileNames,
      canon (segmentsOf (normalizePath home p)) = dir ++ [f] ∨
        ∃ m, canon (segmentsOf (normalizePath home p)) = dir ++ [m, f]) →
    (checkSensitivePath home p).isSensitive = true

/-- The changes since the phase-1 model (`ModelOriginal.lean`) only add blocks: every path and
glob the phase-1 `checkSensitivePath` and `checkSensitiveGlob` reported sensitive is still
reported sensitive. -/
def StricterThanOriginal (home : List Char) : Prop :=
  (∀ p, (Original.checkSensitivePath home p).isSensitive = true →
    (checkSensitivePath home p).isSensitive = true) ∧
  (∀ cwd pattern basePath, (Original.checkSensitiveGlob home cwd pattern basePath).isSensitive = true →
    (checkSensitiveGlob home cwd pattern basePath).isSensitive = true)

end SomaVerify.SensitivePath.Spec
