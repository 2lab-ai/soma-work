import SomaVerify.Support.Json
import SomaVerify.Support.Vectors
import SomaVerify.WebhookSsrf.Model
import SomaVerify.WebhookSsrf.Spec

/-!
# Conformance vectors for `src/webhook-url-validator.ts`

Before writing anything, the generator checks the model's tables:

* `ipv4Special` and `ipv6Special` list exactly the blocks and "Globally Reachable" values of the
  vendored registries `verification/iana/*.csv`, in file order (footnote markers dropped, the one
  two-block row split);
* every block's `cidr` text parses, with the model's own parser, to exactly its `base` and `len`;
* every address written below parses back to itself.

Any failure stops the run with an error, so `lean-verify.sh` writes no vector file. The paths are
relative to `verification/lean`, where `lean-verify.sh` runs the generators.

Two kinds of case follow, one per line of `verification/vectors/webhook-ssrf.json`:

* `ip`: a hostname for `isBlockedIp`. The first and last address, and the neighbour on each side,
  of every registry row, of multicast, 2000::/3 and 64:ff9b::/96, and of the blocks the IPv6 rule
  covers without an entry of its own (`Spec.coveredOutsideGlobalUnicast`, 6to4); every /8's first
  and last IPv4 address; the IPv4-mapped, IPv4-compatible, NAT64 and 6to4 forms of every IPv4 edge
  address, also with the dotted tails DNS resolvers print; the first pieces the replaced code's
  text prefixes matched; malformed and non-canonical text. Canonical texts (`canonical: true`) are `render4`/`render6` output, which
  the conformance test also checks against the engine's own serializer.
* `url`: a URL for `validateWebhookUrl` and `validateWebhookUrlWithDns`, with the `protocol` and
  `hostname` the model assumes `new URL` returns (`url: null` when it throws), and one or more DNS
  scenarios: resolver answers (unreadable ones included), the hostname the resolvers must be
  called with (`null`: not called), and the result.

`src/__tests__/webhook-url-validator.lean-conformance.test.ts` replays every case.
-/

namespace SomaVerify.WebhookSsrf.Vectors

open SomaVerify SomaVerify.WebhookSsrf

/-! ## The tables against the vendored registries -/

/-- RFC 4180 CSV, from state `(inQuotes, field, row, rows)`: fields separated by `,`, records by
CRLF or LF, `"` quoting with `""` for a literal quote; a quoted field may span lines. The field
and the lists are accumulated reversed. -/
def csvGo : List Char → Bool → List Char → List String → List (List String) → List (List String)
  | [], _, field, row, rows =>
    let row := (String.ofList field.reverse :: row).reverse
    if row == [""] then rows.reverse else (row :: rows).reverse
  | '"' :: '"' :: rest, true, field, row, rows => csvGo rest true ('"' :: field) row rows
  | '"' :: rest, true, field, row, rows => csvGo rest false field row rows
  | c :: rest, true, field, row, rows => csvGo rest true (c :: field) row rows
  | '"' :: rest, false, field, row, rows => csvGo rest true field row rows
  | ',' :: rest, false, field, row, rows =>
    csvGo rest false [] (String.ofList field.reverse :: row) rows
  | '\r' :: '\n' :: rest, false, field, row, rows =>
    csvGo rest false [] [] ((String.ofList field.reverse :: row).reverse :: rows)
  | '\n' :: rest, false, field, row, rows =>
    csvGo rest false [] [] ((String.ofList field.reverse :: row).reverse :: rows)
  | c :: rest, false, field, row, rows => csvGo rest false (c :: field) row rows

/-- The records of a CSV file. -/
def parseCsv (text : String) : List (List String) :=
  csvGo text.toList false [] [] []

/-- `s` without leading and trailing spaces. -/
def trimSpaces (s : String) : String :=
  String.ofList ((s.toList.dropWhile (· == ' ')).reverse.dropWhile (· == ' ')).reverse

/-- A registry cell without its footnote marker (`N/A [2]` → `N/A`), trimmed. -/
def dropFootnote (cell : String) : String :=
  match cell.splitOn " [" with
  | first :: _ => trimSpaces first
  | [] => trimSpaces cell

/-- Position of `name` in a header row. -/
def columnOf (name : String) : List String → Nat → Option Nat
  | [], _ => none
  | x :: xs, i => if x == name then some i else columnOf name xs (i + 1)

/-- `(block, "Globally Reachable")` for every block of a registry file, in file order. A cell
listing several blocks (`192.0.0.170/32, 192.0.0.171/32`) gives one pair per block. -/
def registryRows (records : List (List String)) : Option (List (String × String)) :=
  match records with
  | [] => none
  | header :: rows => do
    let blockColumn ← columnOf "Address Block" header 0
    let reachColumn ← columnOf "Globally Reachable" header 0
    some (rows.flatMap fun row =>
      ((row.getD blockColumn "").splitOn ",").map fun block =>
        (dropFootnote block, dropFootnote (row.getD reachColumn "")))

/-- The same pairs, from a model table. -/
def tableRows (table : List RegistryBlock) : List (String × String) :=
  table.map fun r => (r.cidr, r.reach.text)

/-- `cidr` parses, with the model's parser for `bits`, to exactly `base` and `len`. -/
def blockParses (bits : Nat) (b : Block) : Bool :=
  match b.cidr.splitOn "/" with
  | [address, length] =>
    (if bits == 32 then parseIpv4 address else parseIpv6 address) == some b.base &&
      length.toNat? == some b.len
  | _ => false

/-- Stop the run, before any output, unless `ok`. -/
def require (ok : Bool) (message : String) : IO Unit :=
  unless ok do
    throw (IO.userError s!"webhook-ssrf vectors: {message}")

/-- The registry checks described in the module header. -/
def checkTables : IO Unit := do
  let v4 ← IO.FS.readFile "../iana/iana-ipv4-special-registry-1.csv"
  let v6 ← IO.FS.readFile "../iana/iana-ipv6-special-registry-1.csv"
  require (registryRows (parseCsv v4) == some (tableRows ipv4Special))
    "ipv4Special differs from verification/iana/iana-ipv4-special-registry-1.csv"
  require (registryRows (parseCsv v6) == some (tableRows ipv6Special))
    "ipv6Special differs from verification/iana/iana-ipv6-special-registry-1.csv"
  for b in ipv4Special.map (·.toBlock) ++ ipv4Extra do
    require (blockParses 32 b) s!"{b.cidr} does not parse to base {b.base} and length {b.len}"
  for b in ipv6Special.map (·.toBlock) ++ [ipv6GlobalUnicast, nat64WellKnown] do
    require (blockParses 128 b) s!"{b.cidr} does not parse to base {b.base} and length {b.len}"

/-! ## Addresses -/

/-- Ascending, without repeats. -/
def sortedUnique (xs : List Nat) : List Nat :=
  let rec go : List Nat → List Nat
    | a :: b :: rest => if a == b then go (b :: rest) else a :: go (b :: rest)
    | rest => rest
  go (xs.mergeSort (· ≤ ·))

/-- A block's first and last address, and the neighbour on each side within `[0, 2^bits)`. -/
def edges (bits : Nat) (b : Block) : List Nat :=
  let last := b.base + 2 ^ (bits - b.len) - 1
  (if b.base > 0 then [b.base - 1] else []) ++ [b.base, last] ++
    (if last + 1 < 2 ^ bits then [last + 1] else [])

/-- The edges of every IPv4 block the classifier consults. -/
def ipv4Edges : List Nat :=
  sortedUnique ((ipv4Special.map (·.toBlock) ++ ipv4Extra).flatMap (edges 32))

/-- The first and last address of every /8. -/
def ipv4Slash8 : List Nat :=
  (List.range 256).flatMap fun a => [a * 2 ^ 24, a * 2 ^ 24 + 2 ^ 24 - 1]

/-- 8.8.8.8, 1.1.1.1, 93.184.216.34, 169.254.169.254. -/
def ipv4Named : List Nat := [0x08080808, 0x01010101, 0x5db8d822, 0xa9fea9fe]

/-- Every IPv4 address the `ip` cases write. -/
def ipv4Addresses : List Nat :=
  sortedUnique (ipv4Edges ++ ipv4Slash8 ++ ipv4Named)

/-- The IPv6 blocks whose edges are probed: every registry row, the two blocks the classifier
consults besides the registry, and the blocks the rule covers without entries of its own. -/
def ipv6ProbedBlocks : List Block :=
  ipv6Special.map (·.toBlock) ++ [ipv6GlobalUnicast, nat64WellKnown] ++
    Spec.coveredOutsideGlobalUnicast ++ [Spec.sixToFour]

/-- The edges of every IPv6 block in `ipv6ProbedBlocks`. -/
def ipv6Edges : List Nat :=
  sortedUnique (ipv6ProbedBlocks.flatMap (edges 128))

/-- The IPv4-mapped, IPv4-compatible, NAT64 and 6to4 addresses carrying `v`. -/
def embeddings (v : Nat) : List Nat :=
  [0xffff * 2 ^ 32 + v, v, 0x64ff9b * 2 ^ 96 + v, 0x2002 * 2 ^ 112 + v * 2 ^ 80]

/-- First pieces the replaced code's `startsWith` tests matched or just missed, as spelled
without leading zeros: `fc`, `fd`, `fc0`..`fdf`, `fe8`..`feb`, and the real fc00::/7 and fe80::/10
edges. -/
def textualFirstPieces : List Nat :=
  [0xfb, 0xfc, 0xfd, 0xfe, 0xfbf, 0xfc0, 0xfdf, 0xfe0, 0xfe7, 0xfe8, 0xfeb, 0xfec,
    0xfbff, 0xfc00, 0xfdff, 0xfe00, 0xfe7f, 0xfe80, 0xfebf, 0xfec0]

/-- Public addresses: 2606:4700:4700::1111 (the BUG A probe), 2001:4860:4860::8888, and
64:ff9b::808:808 (NAT64 of 8.8.8.8). -/
def ipv6Named : List Nat :=
  [0x26064700470000000000000000001111, 0x20014860486000000000000000008888,
    0x0064ff9b000000000000000008080808]

/-- IPv6 addresses written canonically and bracketed. -/
def ipv6Probed : List Nat :=
  sortedUnique (ipv6Edges ++ textualFirstPieces.map (· * 2 ^ 112 + 1) ++ ipv6Named)

/-- Every IPv6 address the `ip` cases write canonically. -/
def ipv6Addresses : List Nat :=
  sortedUnique (ipv6Probed ++ ipv4Edges.flatMap embeddings)

/-- The dotted-tail spellings a resolver prints (`::ffff:127.0.0.1`, `::127.0.0.1`) and the
NAT64 one, with the address each denotes. -/
def dottedTails (v : Nat) : List (String × Nat) :=
  [("::ffff:" ++ render4 v, 0xffff * 2 ^ 32 + v), ("::" ++ render4 v, v),
    ("64:ff9b::" ++ render4 v, 0x64ff9b * 2 ^ 96 + v)]

/-- Hand-picked hostnames: non-canonical spellings, malformed text, names. -/
def otherHostnames : List String := [
  "", "[", "]", "[]", ":", ":::", "::::", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8::",
  "::1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8",
  "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "0::1", "::0", "::0.0.0.1",
  "::0.0.0.0", "12345::", "g::1", "fe80::1%eth0", "fe80::1%25eth0", "::1 ", " ::1", "[::1",
  "::1]", "[[::1]]", "[::1]]", "1.2.3", "1.2.3.4.5", "256.0.0.1", "127.0.0.256", "1.2.3.-1",
  "01.2.3.4", "010.0.0.1", "0127.0.0.1", " 127.0.0.1", "127.0.0.1 ", "127.0.0.1.",
  "0x7f.0.0.1", "127.1", "2130706433", "localhost", "localhost.", "example.com",
  "metadata.google.internal", "::ffff:1.2.3", "::ffff:1.2.3.4.5", "::1.2.3.4:5", "1.2.3.4::",
  "1.2.3.4::1", "::FFFF:127.0.0.1", "::ffff:0:127.0.0.1", "1:2:3:4:5:6:1.2.3.4",
  "1:2:3:4:5:6:7:1.2.3.4", "::1.2.3.04", "１２７.0.0.1", "FC00::1", "FE80::1", "FF02::1",
  "::FFFF:7F00:1", "2001:DB8::1", "[127.0.0.1]", "[10.0.0.1]", "[8.8.8.8]"]

/-! ## Cases -/

/-- `{ valid: true }` or `{ valid: false, error }`. -/
def validationJson : Validation → Json
  | .valid => .obj [("valid", .bool true)]
  | .invalid error => .obj [("valid", .bool false), ("error", .str error)]

/-- An `ip` case: what `isBlockedIp(input)` returns. -/
def ipCase (input : String) (canonical : Bool) : Json :=
  .obj [("kind", .str "ip"), ("input", .str input), ("canonical", .bool canonical),
    ("expect", .obj [("blocked", .bool (isBlockedIp input))])]

/-- `ip` cases, the first occurrence of each input kept. -/
def ipInputs : List (String × Bool) :=
  let canonical4 := ipv4Addresses.map fun v => (render4 v, true)
  let bracketed4 := ipv4Edges.map fun v => ("[" ++ render4 v ++ "]", false)
  let canonical6 := ipv6Addresses.map fun n => (render6 n, true)
  let bracketed6 := ipv6Probed.map fun n => ("[" ++ render6 n ++ "]", false)
  let dotted := ipv4Edges.flatMap fun v => (dottedTails v).map fun (t, _) => (t, false)
  let others := otherHostnames.map fun t => (t, false)
  let all := canonical4 ++ bracketed4 ++ canonical6 ++ bracketed6 ++ dotted ++ others
  all.foldl (fun (acc : Array (String × Bool)) (t, c) =>
    if acc.any (·.1 == t) then acc else acc.push (t, c)) #[] |>.toList

/-- A URL and what the model assumes `new URL(input)` returns. -/
structure UrlInput where
  input : String
  url : Option ParsedUrl

/-- `https://<host>/hook` and `http://<host>/hook` for a hostname already in URL-parser form. -/
def hostUrls (host : String) : List UrlInput :=
  [⟨"https://" ++ host ++ "/hook", some ⟨"https:", host⟩⟩,
    ⟨"http://" ++ host ++ "/hook", some ⟨"http:", host⟩⟩]

/-- URLs whose parse the model assumes; the conformance test checks each against the engine. -/
def namedUrls : List UrlInput := [
  ⟨"https://255.255.255.255/x", some ⟨"https:", "255.255.255.255"⟩⟩,
  ⟨"https://224.0.0.1/x", some ⟨"https:", "224.0.0.1"⟩⟩,
  ⟨"https://192.0.0.1/x", some ⟨"https:", "192.0.0.1"⟩⟩,
  ⟨"https://[::127.0.0.1]/x", some ⟨"https:", "[::7f00:1]"⟩⟩,
  ⟨"https://[64:ff9b::7f00:1]/x", some ⟨"https:", "[64:ff9b::7f00:1]"⟩⟩,
  ⟨"https://[2002:7f00:1::]/x", some ⟨"https:", "[2002:7f00:1::]"⟩⟩,
  ⟨"https://[ff02::1]/x", some ⟨"https:", "[ff02::1]"⟩⟩,
  ⟨"https://[fec0::1]/x", some ⟨"https:", "[fec0::1]"⟩⟩,
  ⟨"https://[2606:4700:4700::1111]/x", some ⟨"https:", "[2606:4700:4700::1111]"⟩⟩,
  ⟨"https://[::ffff:8.8.8.8]/x", some ⟨"https:", "[::ffff:808:808]"⟩⟩,
  ⟨"https://[fc::1]/x", some ⟨"https:", "[fc::1]"⟩⟩,
  ⟨"https://[fe8::1]/x", some ⟨"https:", "[fe8::1]"⟩⟩,
  ⟨"https://[::808:808]/x", some ⟨"https:", "[::808:808]"⟩⟩,
  ⟨"https://[64:ff9b::808:808]/x", some ⟨"https:", "[64:ff9b::808:808]"⟩⟩,
  ⟨"https://127.0.0.1./x", some ⟨"https:", "127.0.0.1"⟩⟩,
  ⟨"https://10.0.0.1./", some ⟨"https:", "10.0.0.1"⟩⟩,
  ⟨"https://0x7f.1/", some ⟨"https:", "127.0.0.1"⟩⟩,
  ⟨"https://2130706433/", some ⟨"https:", "127.0.0.1"⟩⟩,
  ⟨"https://127.1/", some ⟨"https:", "127.0.0.1"⟩⟩,
  ⟨"https://0.0.0.0/", some ⟨"https:", "0.0.0.0"⟩⟩,
  ⟨"https://[0:0:0:0:0:0:0:1]/", some ⟨"https:", "[::1]"⟩⟩,
  ⟨"https://[::FFFF:7F00:1]/", some ⟨"https:", "[::ffff:7f00:1]"⟩⟩,
  ⟨"https://[::1]:8443/", some ⟨"https:", "[::1]"⟩⟩,
  ⟨"https://[::]/", some ⟨"https:", "[::]"⟩⟩,
  ⟨"https://localhost/hook", some ⟨"https:", "localhost"⟩⟩,
  ⟨"https://localhost./x", some ⟨"https:", "localhost."⟩⟩,
  ⟨"https://localhost../x", some ⟨"https:", "localhost.."⟩⟩,
  ⟨"https://localhost.../x", some ⟨"https:", "localhost..."⟩⟩,
  ⟨"https://LOCALHOST../", some ⟨"https:", "localhost.."⟩⟩,
  ⟨"https://metadata.google.internal../computeMetadata/v1/", some ⟨"https:", "metadata.google.internal.."⟩⟩,
  ⟨"https://localhost%2e/", some ⟨"https:", "localhost."⟩⟩,
  ⟨"https://./x", some ⟨"https:", "."⟩⟩,
  ⟨"https://.../x", some ⟨"https:", "..."⟩⟩,
  ⟨"https://%2e/x", some ⟨"https:", "."⟩⟩,
  ⟨"https://LOCALHOST/", some ⟨"https:", "localhost"⟩⟩,
  ⟨"https://metadata.google.internal/computeMetadata/v1/", some ⟨"https:", "metadata.google.internal"⟩⟩,
  ⟨"https://Metadata.Google.Internal./", some ⟨"https:", "metadata.google.internal."⟩⟩,
  ⟨"https://example.com/webhook", some ⟨"https:", "example.com"⟩⟩,
  ⟨"https://example.com./hook", some ⟨"https:", "example.com."⟩⟩,
  ⟨"https://example.com../hook", some ⟨"https:", "example.com.."⟩⟩,
  ⟨"HTTPS://EXAMPLE.COM/", some ⟨"https:", "example.com"⟩⟩,
  ⟨"https://api.example.com:8443/hook", some ⟨"https:", "api.example.com"⟩⟩,
  ⟨"https://xn--nxasmq6b.example./", some ⟨"https:", "xn--nxasmq6b.example."⟩⟩,
  ⟨"http://example.com/webhook", some ⟨"http:", "example.com"⟩⟩,
  ⟨"http://localhost./", some ⟨"http:", "localhost."⟩⟩,
  ⟨"ftp://example.com/file", some ⟨"ftp:", "example.com"⟩⟩,
  ⟨"file:///etc/passwd", some ⟨"file:", ""⟩⟩,
  ⟨"not-a-url", none⟩,
  ⟨"https://[::1/", none⟩,
  ⟨"https://[fe80::1%25eth0]/", none⟩,
  ⟨"https://exa mple.com/", none⟩,
  ⟨"https://", none⟩,
  ⟨"", none⟩]

/-- Every URL case: both schemes for each IPv4 edge and each probed IPv6 address, then the
named URLs. -/
def urlInputs : List UrlInput :=
  ipv4Edges.flatMap (fun v => hostUrls (render4 v)) ++
    ipv6Probed.flatMap (fun n => hostUrls ("[" ++ render6 n ++ "]")) ++ namedUrls

/-- Resolver answers tried when a URL reaches DNS: none; public; private IPv4; public IPv6;
IPv4-compatible and IPv4-mapped loopback as resolvers print them; one bad answer among good; and
answers that are not addresses, which block (fail closed). -/
def dnsAnswers : List (List String × List String) :=
  [([], []), (["93.184.216.34"], []), (["10.0.0.1"], []), ([], ["2606:4700:4700::1111"]),
    ([], ["::127.0.0.1"]), (["93.184.216.34"], ["::ffff:127.0.0.1"]),
    (["93.184.216.34", "192.168.1.1"], []), (["not-an-ip"], []), ([], ["fe80::1%eth0"]),
    (["93.184.216.34"], ["2606:4700:4700::1111", ""])]

/-- The scenarios of a URL: every entry of `dnsAnswers` if it reaches DNS, else one with no
answers (the resolvers must not be called). -/
def scenarios (url : Option ParsedUrl) : List (List String × List String) :=
  if (validateWebhookUrlWithDns url [] []).2.isSome then dnsAnswers else [([], [])]

/-- A list of strings as JSON. -/
def strings (xs : List String) : Json :=
  .arr (xs.map .str)

/-- A `url` case. -/
def urlCase (u : UrlInput) : Json :=
  let urlJson := match u.url with
    | none => Json.null
    | some p => .obj [("protocol", .str p.protocol), ("hostname", .str p.hostname)]
  let premise := match u.url with
    | none => []
    | some p =>
      let host := stripBrackets (checkedHostname p.hostname)
      [("dnsHost", Json.str host), ("ipLiteral", .bool (isIpLiteral host))]
  let dns := (scenarios u.url).map fun (answers4, answers6) =>
    let (result, queried) := validateWebhookUrlWithDns u.url answers4 answers6
    Json.obj [("resolve4", strings answers4), ("resolve6", strings answers6),
      ("queried", match queried with | none => .null | some h => .str h),
      ("result", validationJson result)]
  .obj ([("kind", .str "url"), ("input", .str u.input), ("url", urlJson)] ++ premise ++
    [("expect", .obj [("static", validationJson (validateWebhookUrl u.url)), ("dns", .arr dns)])])

/-- The cases written to `verification/vectors/webhook-ssrf.json`. -/
def cases : List Json :=
  ipInputs.map (fun (t, c) => ipCase t c) ++ urlInputs.map urlCase

/-- Every address written above parses back to itself, so each canonical `ip` case's expected
verdict is the numeric classifier's verdict on that address. -/
def checkRoundTrips : IO Unit := do
  for v in ipv4Addresses do
    require (parseIpv4 (render4 v) == some v) s!"{render4 v} does not parse back to {v}"
  for n in ipv6Addresses do
    require (parseIpv6 (render6 n) == some n) s!"{render6 n} does not parse back to {n}"
  for v in ipv4Edges do
    for (t, n) in dottedTails v do
      require (parseIpv6 t == some n) s!"{t} does not parse to {n}"

end SomaVerify.WebhookSsrf.Vectors

def main : IO Unit := do
  SomaVerify.WebhookSsrf.Vectors.checkTables
  SomaVerify.WebhookSsrf.Vectors.checkRoundTrips
  IO.print (SomaVerify.Vectors.render "webhook-ssrf" ``SomaVerify.WebhookSsrf.Vectors.cases
    SomaVerify.WebhookSsrf.Vectors.cases)
