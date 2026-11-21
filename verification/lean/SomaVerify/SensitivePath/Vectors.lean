import SomaVerify.Support.Json
import SomaVerify.Support.Vectors
import SomaVerify.SensitivePath.Model

/-!
# Conformance vectors for `SomaVerify.SensitivePath.Model`

Paths spelled from segment alphabets: every path of a first token and up to two more segments
over the full alphabet, every path of three segments below the root, HOME or `~` over a smaller
alphabet, every path of three segments below `/opt`, and targeted boundary cases (walks through
a sensitive directory, the shape a symbolic link gives them, and case variants). Then glob
patterns with and without a base path. Each case carries the model's `checkSensitivePath` or
`checkSensitiveGlob` result, and
`src/__tests__/sensitive-path-filter.lean-conformance.test.ts` replays it against the real
module.

HOME. The model runs with the stand-in HOME `/<HOME>`, a single segment spelled with `<` and
`>`, which no other token contains. The vector file writes it as the placeholder `<HOME>`, and
the test puts the module's HOME in its place. That is faithful only while the answer does not
depend on which absolute HOME it is. It does depend on it when a `..` climbs above HOME: the
path then lands in HOME's parent, so the answer depends on how deep the real HOME is
(`<HOME>/../etc/shadow` is `/etc/shadow` for HOME `/root` but `/home/etc/shadow` for
`/home/runner`). Such cases are left out (`climbsAboveHome`), checked on every string the
module resolves: the path, the glob pattern, its spellings and the paths a glob checks. The test
checks the other side: the real HOME must be canonical and not sensitive (so the directories
the module's walk passes on the way to it, which the stand-in does not have, flag nothing), and
no path spelled from the alphabet may reach it without the placeholder, in any case.

Run by `scripts/verification/lean-verify.sh` (`lake env lean --run`); the output is
`verification/vectors/sensitive-path.json`.
-/

namespace SomaVerify.SensitivePath.Vectors

open SomaVerify SomaVerify.SensitivePath

/-- A working directory for `path.resolve`. No vector reaches it: the stand-in HOME and every
base path below are absolute, and `path.resolve` only falls back to the working directory when
no argument is. -/
def cwd : List Char := "/cwd".toList

/-- The `os.homedir()` the model runs with. -/
def standInHome : List Char := "/<HOME>".toList

/-- The module's `HOME` for that `os.homedir()` (`moduleHome` leaves it as it is). -/
def home : List Char := moduleHome cwd standInHome

/-- How the vector file writes the stand-in HOME. -/
def placeholder : String := "<HOME>"

/-- A vector-file string as the model sees it: a leading placeholder is the stand-in HOME. -/
def toModel (text : String) : List Char :=
  if text.startsWith placeholder then '/' :: text.toList else text.toList

/-- A model string as the vector file writes it. -/
def toText (s : List Char) : String :=
  (String.ofList s).replace (String.ofList standInHome) placeholder

/-- The first segments that stand for HOME: the placeholder and the aliases `normalizePath`
expands. -/
def homeSpellings : List Seg :=
  placeholder.toList :: homeAliases

/-- Walk segments below HOME, `depth` levels down: true when a `..` climbs above HOME. -/
def climbsFrom (depth : Nat) : List Seg → Bool
  | [] => false
  | s :: rest =>
    if s = [] ∨ s = ['.'] then climbsFrom depth rest
    else if s = ['.', '.'] then depth == 0 || climbsFrom (depth - 1) rest
    else climbsFrom (depth + 1) rest

/-- Whether resolving the vector-file string `text` climbs above HOME. -/
def climbsAboveHome (text : String) : Bool :=
  match splitSlash text.toList with
  | first :: rest => homeSpellings.contains first && climbsFrom 0 rest
  | [] => false

/-- `reason` as the vector file writes it. -/
def reasonJson : Option String → Json
  | some r => .str (toText r.toList)
  | none => .null

/-- The expected result fields of a case. -/
def resultFields (r : Result) : List (String × Json) :=
  [("isSensitive", .bool r.isSensitive), ("reason", reasonJson r.reason)]

/-- A `checkSensitivePath` case. -/
def pathCase (input : String) : Json :=
  .obj ([("path", .str input)] ++ resultFields (checkSensitivePath home (toModel input)))

/-- A `checkSensitiveGlob` case; `basePath = none` is the one-argument call. -/
def globCase (pattern : String) (basePath : Option String) : Json :=
  let r := checkSensitiveGlob home cwd (toModel pattern) (basePath.map toModel)
  .obj ([("glob", .str pattern), ("basePath", (basePath.map Json.str).getD .null)] ++ resultFields r)

/-- Whether a glob case is independent of which HOME it runs with: no string the model resolves
(the pattern, its spellings and the paths it checks for them) climbs above HOME. -/
def globIsPortable (pattern : String) (basePath : Option String) : Bool :=
  let spellings := globSpellings cwd (toModel pattern) (basePath.map toModel)
  (pattern :: (spellings ++ spellings.flatMap globCandidates).map toText).all
    (fun t => !climbsAboveHome t)

/-! ## Paths -/

/-- First tokens: the root (an empty first segment), HOME, its aliases, and relative starts. -/
def roots : List String :=
  ["", placeholder, "~", "$HOME", "${HOME}", ".", "..", "x", ".ssh"]

/-- Tokens for the other segments: dot and empty segments, the names in the rule tables and
their near misses, and fillers. -/
def segments : List String :=
  ["~", ".ssh", ".sshx", "id_rsa", "..", ".", "", "work", "private", "tmp", "opt", "soma-work",
   "soma", "dev", "x", ".env", ".env.local", "config.json", "etc", "shadow", ".aws",
   "credentials.json", "secrets.yaml", "secret.yml", ".gitconfig", "Library", "Keychains",
   ".config", "gh", ".SSH", "ETC", "Shadow", ".ENV"]

/-- Tokens for three segments below the root or HOME: resolution, and the rules whose match
spans several segments. -/
def deepSegments : List String :=
  ["..", ".", "", ".ssh", ".sshx", "x", "private", "tmp", "opt", "soma-work", "soma", "dev",
   "config.json", "etc", "shadow", "Library", "Keychains", ".SSH"]

/-- Tokens for three segments below `/opt`: the service-config rule, which reaches four
segments deep. -/
def serviceSegments : List String :=
  ["soma-work", "soma", "dev", "config.json", ".env", "x", "..", ".", ""]

/-- All token lists of exactly `n` tokens over `alphabet`, in alphabet order. -/
def wordsOfLength (alphabet : List String) : Nat → List (List String)
  | 0 => [[]]
  | n + 1 => (wordsOfLength alphabet n).flatMap fun w => alphabet.map fun t => w ++ [t]

/-- Every path of one of `firsts` followed by exactly `n` tokens of `alphabet`. -/
def pathsOf (firsts alphabet : List String) (n : Nat) : List String :=
  firsts.flatMap fun r => (wordsOfLength alphabet n).map fun w => "/".intercalate (r :: w)

/-- The exhaustive families. They are disjoint: a path's token count is its segment count, as
no token contains `/`, and the first tokens of a family are distinct. -/
def exhaustivePaths : List String :=
  pathsOf roots segments 0 ++ pathsOf roots segments 1 ++ pathsOf roots segments 2 ++
    pathsOf ["", placeholder, "~"] deepSegments 3 ++
    pathsOf ["/opt"] serviceSegments 3

/-- Walks through a sensitive directory, as a symbolic link inside it would make them read
(`.aws/link -> .aws/deep/nested`), and walks that only pass by one. -/
def walkPaths : List String :=
  ["<HOME>/.aws/link/../../credentials", "<HOME>/.aws/link/../..", "<HOME>/.aws/a/b/../../../x",
   "~/.aws/link/../../credentials", "$HOME/.ssh/../safe", "${HOME}/.gnupg/..",
   "<HOME>/.ssh/..", "<HOME>/.ssh/../x", "<HOME>/.ssh/./../x", "<HOME>/.ssh//../.aws",
   "<HOME>/.config/gh/../../x", "<HOME>/.config/gh/..", "<HOME>/.config/../x",
   "<HOME>/Library/Keychains/../../x", "<HOME>/Library/../x", "<HOME>/.docker/x/../../y",
   "/etc/shadow/../passwd", "/etc/shadow/..", "/etc/shadowx/../passwd", "/etc/../x",
   "<HOME>/.sshx/../x", "<HOME>/x/../.ssh/../y", "/private/tmp/../etc/shadow/../x",
   "<HOME>/.SSH/../x", "<HOME>/.\u00DFh/../x"]

/-- Case variants: APFS compares names with Unicode case folding, so each of these opens the
entry it folds to. Upper and mixed case, U+017F and U+212A (simple folding to `s` and `k`),
U+00DF, U+1E9E and the U+FB00-U+FB06 ligatures (full folding to two or three letters), and near
misses. -/
def casePaths : List String :=
  ["<HOME>/.SSH/id_rsa", "<HOME>/.Ssh", "<HOME>/.SSHX/k", "<HOME>/.GNUPG/x", "<HOME>/.CONFIG/GH/hosts.yml",
   "<HOME>/.config/GH", "<HOME>/.Config/ghx", "<HOME>/LIBRARY/KEYCHAINS/x", "<HOME>/library/keychains",
   "<HOME>/.AWS", "<HOME>/.DOCKER/config.json", "<HOME>/.GITCONFIG", "<HOME>/.NETRC", "<HOME>/.Npmrc",
   "<HOME>/.CLAUDE/CREDENTIALS.JSON", "<HOME>/.GITCONFIGX", "/ETC/SHADOW", "/etc/Shadow/x", "/Etc/shadow",
   "/ETC/SHADOWX", "/app/.ENV", "/app/.Env.Local", "/app/.ENVX", "/app/X.ENV", "/app/CREDENTIALS.JSON",
   "/app/Credentials.Json", "/app/SECRETS.YAML", "/app/Secret.Toml", "/app/SECRETS.YAMLL",
   "/OPT/SOMA-WORK/dev/CONFIG.JSON", "/opt/Soma/PROD/Config.json", "/OPT/soma-work/a/b/config.json",
   "/OPT/SOMA-WORKX/dev/config.json", "/PRIVATE/TMP/x", "/Private/Tmp/.env", "/PRIVATE/tmp/../x",
   "/PRIVATE/ETC/shadow", "/Private/Etc/Shadow/x", "/private/ETC", "/PRIVATE/ETCX/shadow",
   "/SYSTEM/VOLUMES/DATA/PRIVATE/ETC/shadow", "/System/Volumes/Data/OPT/soma-work/dev/Config.json",
   "/SYSTEM/volumes/DATA/users/x",
   "/private/TMP", "/PRIVATE/TMPX/x", "~/.SSH/id_rsa", "$HOME/.AWS/credentials", "${HOME}/.Gnupg",
   "$home/.ssh/id_rsa", "<HOME>/.\u017Fsh/x", "<HOME>/.doc\u212Aer/config.json", "<HOME>/.\u00DFh/x",
   "<HOME>/.\u1E9Eh", "<HOME>/.\u00DFhx/k", "<HOME>/.gitcon\uFB01g", "<HOME>/.con\uFB01g/gh/x",
   "<HOME>/.con\uFB01g/ghx", "/opt/soma-work/dev/con\uFB01g.json", "/app/.\u00DFh", "/app/\uFB00",
   "/app/.\u212Anv", "/app/.env.\u212A", "/app/\uFB06", "/opt/soma-work/dev/\uFB03",
   "/app/secret\u017F.json", "/app/credential\u017F.json", "<HOME>/.ssh\u00DF", "/etc/\u017Fhadow"]

/-- Boundary cases outside the families: every table entry and a near miss of it, the edges of
each basename pattern (line terminators, which `.` does not match, and a character outside the
BMP, which it does), `/private/tmp`, `/private/etc` and `/System/Volumes/Data` spellings, alias near
misses, and non-ASCII segments. -/
def targetedPaths : List String :=
  ["<HOME>/.config/gh/hosts.yml", "<HOME>/.config/ghx", "<HOME>/.config/g", "<HOME>/.gnupg",
   "<HOME>/.gnupg/private-keys-v1.d", "<HOME>/.docker/config.json", "<HOME>/.dockerx",
   "<HOME>/.netrc", "<HOME>/.netrc/", "<HOME>/.npmrc", "<HOME>/x/../.npmrc",
   "<HOME>/.claude/credentials.json", "<HOME>/.claude/./credentials.json", "<HOME>/.claude",
   "<HOME>/.gitconfig/", "<HOME>/.gitconfigx", "<HOME>/Library/Keychainsx",
   "<HOME>/Library/./Keychains/login.keychain-db", "<HOME>/.ssh///",
   "/app/.env", "/app/.env.", "/app/.env..", "/app/.envx", "/app/x.env", "/app/.env.production",
   "/app/.env.\n", "/app/.env.\r", "/app/.env.a\u2028", "/app/.env.\u2029x", "/app/.env.😀",
   "/app/secrets.json", "/app/secret.json", "/app/secrets.toml", "/app/secret.yaml",
   "/app/secrets.yml", "/app/secretss.json", "/app/secrets.ym", "/app/Secrets.json",
   "/app/secrets.json.bak", "/app/secrets.", "/app/secret", "/app/secrets.jsonx",
   "/app/xsecrets.json", "/app/secrets.yamll", "/app/secret.",
   "/app/credentials.jsonx", "/app/xcredentials.json", "/app/credentials.json/",
   "/private/tmp/", "/private/tmpdata/x", "/private/tmp/../etc/shadow", "//private/tmp/x",
   "/private/./tmp/x", "/private/tmp//x/", "/tmp/../private/tmp/x",
   "/private/etc/shadow", "/private/etc", "/private/etc/", "/private/etcetera/x", "/private/etcx/shadow",
   "//private/etc/shadow", "/private/./etc/shadow", "/private/etc//shadow/", "/etc/../private/etc/shadow",
   "/private/etc/shadow/../x", "/private/etc/hosts", "/private/var/x", "/private",
   "/System/Volumes/Data/private/etc/shadow", "/system/volumes/data/private/etc/shadow",
   "/System/Volumes/Data/opt/soma-work/dev/config.json", "/system/volumes/data/opt/soma-work/dev/config.json",
   "/System/Volumes/Data/opt/soma/prod/.env", "/System/Volumes/Data", "/System/Volumes/Data/",
   "/System/Volumes/Data/private", "/System/Volumes/Data/private/etc", "/System/Volumes/Data/Users",
   "/System/Volumes/Data/tmp-not-a-firmlink/x", "/System/Volumes/Data/etc/shadow",
   "/System/Volumes/Datax/private/etc/shadow", "/System/Volumes/Data/privatex/etc/shadow",
   "/system/volumes/data/private/tmp/../etc/shadow", "/System/Volumes/Data/private/etc/shadow/../x",
   "//System/./Volumes/Data//private/etc/shadow", "/System/Volumes/Data/private/tmp/x/.env",
   "/opt/soma-work/a/b/config.json", "/opt/soma-workx/dev/config.json",
   "/opt/soma-work/dev/config.jsonx", "/opt/soma-work/dev/xconfig.json",
   "/opt/soma-work/dev/../config.json", "/opt/soma/prod/config.json", "/x/../opt/soma/dev/.env",
   "/etc/shadowx", "/etc/../etc/shadow", "/etc/./shadow/",
   "~//", "$HOME/", "${HOME}/", "$HOMEx/.ssh", "${HOME", "~x/.ssh", "~/./.ssh",
   "$HOME//.ssh/id_rsa", "${HOME}/x/../.aws/credentials", "/x/$HOME/.ssh", "/x/${HOME}/.ssh",
   "<HOME>/.ssh/κλειδί", "<HOME>/.sshé", "<HOME>/😀/../.ssh", "/😀/.env", "///", "/../.."]

/-- The path inputs. -/
def pathInputs : List String :=
  let exhaustive := exhaustivePaths
  let extra := (targetedPaths ++ walkPaths ++ casePaths).eraseDups
  (exhaustive ++ extra.filter (fun t => !exhaustive.contains t)).filter
    (fun p => !climbsAboveHome p)

/-! ## Globs -/

/-- First tokens of glob patterns. -/
def globRoots : List String :=
  ["", placeholder, "~", "$HOME", "x"]

/-- Concrete segments of glob patterns. -/
def globSegments : List String :=
  [".ssh", "..", ".", "", "x", "etc", "work", ".SSH"]

/-- The last part of a glob pattern: a metacharacter in every position of a segment, one that
also names `..`, and globs with concrete segments after them. -/
def globTails : List String :=
  ["*", "**", ".ss*", ".ssh*", "*.json", "{.ssh,x}", "[.]ssh", "?", "..*", "sha*", "*/../.ssh",
   ".SSH*", "..?"]

/-- Glob patterns without a base path. -/
def globPatterns : List String :=
  (List.range 3).flatMap fun n =>
    (pathsOf globRoots globSegments n).flatMap fun p => globTails.map fun t => p ++ "/" ++ t

/-- Base paths: the empty string (falsy, so ignored) and absolute paths. -/
def basePaths : List String :=
  ["", placeholder, "<HOME>/.ssh", "<HOME>/work", "/", "/etc", "/opt/soma-work", "/tmp",
   "<HOME>/.aws/link", "<HOME>/.SSH", "/private/etc", "/PRIVATE/etc/shadow",
   "/System/Volumes/Data/opt/soma-work", "/System/Volumes/Data/private/etc"]

/-- Patterns resolved against each base path, relative and absolute. -/
def basedPatterns : List String :=
  ["*", "**/*", ".ssh/*", "../.ssh/*", "../*", "id_*", "*/config.json", "dev/config.json",
   "shadow", ".", "", "..*", "~/.ssh/*", "/etc/sha*", "<HOME>/.aws/*", ".ss*", "x/../.ssh",
   "config.json", "../../credentials*", "../..", ".SSH/*", "..?"]

/-- The glob inputs. -/
def globInputs : List (String × Option String) :=
  ((globPatterns.map fun p => (p, none)) ++
    (basePaths.flatMap fun b => basedPatterns.map fun p => (p, some b))).filter
    (fun pb => globIsPortable pb.1 pb.2)

/-- The cases written to `verification/vectors/sensitive-path.json`. -/
def cases : List Json :=
  pathInputs.map pathCase ++ globInputs.map fun pb => globCase pb.1 pb.2

end SomaVerify.SensitivePath.Vectors

def main : IO Unit :=
  IO.print (SomaVerify.Vectors.render "sensitive-path" ``SomaVerify.SensitivePath.Vectors.cases
    SomaVerify.SensitivePath.Vectors.cases)
