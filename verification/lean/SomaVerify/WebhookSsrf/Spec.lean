import SomaVerify.WebhookSsrf.Model

/-!
# Specification of `src/webhook-url-validator.ts`

The documented behaviour as propositions over address numbers (IPv4 below 2^32, IPv6 below
2^128). Each definition quotes the TS line it formalizes; `ts:N` is
`src/webhook-url-validator.ts:N`.

## The registry tables, and how the copies are kept in sync

`ipv4Special` and `ipv6Special` (Model.lean) transcribe the IANA special-purpose registries
vendored in `verification/iana/`. The TS holds the same rows as text, in the exported
`IPV4_SPECIAL_PURPOSE` and `IPV6_SPECIAL_PURPOSE` (ts:36-92). Both copies come from the same
vendored CSV files (fetched 2026-09-29), in registry order, footnote markers dropped, with the one
row that lists two blocks split in two. Three checks tie them together:

* `Vectors.lean` reads the vendored CSV files and stops, writing no vectors, unless the Lean tables
  list exactly their rows, and unless every row's `cidr` parses with the model's parser to exactly
  the row's `base` and `len`.
* `src/__tests__/webhook-url-validator.lean-conformance.test.ts` reads the same CSV files and
  requires the exported TS tables to equal them, row for row, so an extra, missing or changed TS
  row fails there directly.
* The conformance vectors probe the first and last address of every row, and the neighbour on
  each side, in both families (dotted quads, compressed IPv6 as the engine writes it, bracketed),
  against the real `isBlockedIp`. TS `parseBlock` (ts:169-177) parses the TS copy when the module
  loads, and a row it parses differently changes a verdict at one of those addresses.

The spec reads the tables; it does not re-derive them. The theorems (Proofs.lean) show that the TS
algorithm (a longest-prefix loop over shifted bigints, masks, shifts) meets these declarative
statements at every address. Text is read by the model's parsers (`parseIpv4`, `parseIpv6`),
which the vectors test against the TS; they are not proven against the RFC 4291 grammar.
-/

namespace SomaVerify.WebhookSsrf.Spec

open SomaVerify.WebhookSsrf

/-- `address` lies in `block`, between its first address `base` and its last,
`base + 2 ^ (bits - len) - 1`. -/
def Mem (bits : Nat) (block : Block) (address : Nat) : Prop :=
  block.base ≤ address ∧ address < block.base + 2 ^ (bits - block.len)

/-! ## Addresses -/

/-- (i) ts:201-202: "blocked when a block containing `address` is not "Globally Reachable: True" (N/A
and the empty cell fail closed) and no more specific block containing it is". Stated over address
ranges: some block containing the address is not `True`, and no more specific block containing it
says `True`. -/
def RegistryBlocked (bits : Nat) (registry : List RegistryBlock) (address : Nat) : Prop :=
  ∃ r ∈ registry, Mem bits r.toBlock address ∧ r.reach ≠ .yes ∧
    ∀ r' ∈ registry, Mem bits r'.toBlock address → r.len < r'.len → r'.reach ≠ .yes

/-- ts:94: "IPv4 multicast (RFC 5771): blocked although the registry does not list it" —
224.0.0.0/4. -/
def ipv4Multicast : Block := ⟨"224.0.0.0/4", 0xe0000000, 4⟩

/-- ts:6: "2. Private/reserved IP ranges blocked"; ts:7: "3. Loopback, link-local, metadata
endpoints blocked". For IPv4 that is rule (i) on the IPv4 registry, plus multicast. -/
def Blocked4 (address : Nat) : Prop :=
  RegistryBlocked 32 ipv4Special address ∨ Mem 32 ipv4Multicast address

/-- ts:98: "2000::/3, the only "Global Unicast" allocation of the IANA IPv6 Address Space
registry". -/
def globalUnicast : Block := ⟨"2000::/3", 0x20000000000000000000000000000000, 3⟩

/-- ts:106: "NAT64 well-known prefix (RFC 6052), outside 2000::/3 and "Globally Reachable: True". It
carries an IPv4 address in its low 32 bits". -/
def nat64 : Block := ⟨"64:ff9b::/96", 0x0064ff9b000000000000000000000000, 96⟩

/-- ts:99-101: "IPv6 outside it is blocked, NAT64 aside ... Inside it, the special-purpose
registry decides"; ts:106-107: NAT64 "is blocked when that address is". An IPv6 address is allowed
iff it is in 2000::/3 and the most specific registry row containing it, if any, says `True` (no
`RegistryBlocked`), or it is in 64:ff9b::/96 and the IPv4 address in its low 32 bits is allowed. -/
def Allowed6 (address : Nat) : Prop :=
  (Mem 128 globalUnicast address ∧ ¬ RegistryBlocked 128 ipv6Special address) ∨
    (Mem 128 nat64 address ∧ ¬ Blocked4 (address % 2 ^ 32))

/-- ts:6-7 for IPv6: everything `Allowed6` does not allow. -/
def Blocked6 (address : Nat) : Prop :=
  ¬ Allowed6 address

/-- ts:100-101: "that covers ::, ::1, IPv4-compatible and IPv4-mapped addresses, fc00::/7,
fe80::/10, fec0::/10, ff00::/8". The blocks the old code, the brief and the registries name as not
reachable, listed to state that the rule blocks all of them without a table entry of its own. -/
def coveredOutsideGlobalUnicast : List Block := [
  ⟨"::/96", 0, 96⟩,
  ⟨"::ffff:0:0/96", 0x00000000000000000000ffff00000000, 96⟩,
  ⟨"fc00::/7", 0xfc000000000000000000000000000000, 7⟩,
  ⟨"fe80::/10", 0xfe800000000000000000000000000000, 10⟩,
  ⟨"fec0::/10", 0xfec00000000000000000000000000000, 10⟩,
  ⟨"ff00::/8", 0xff000000000000000000000000000000, 8⟩]

/-- 6to4, 2002::/16 (RFC 3056): inside 2000::/3, blocked by its registry row (`N/A`). -/
def sixToFour : Block := ⟨"2002::/16", 0x20020000000000000000000000000000, 16⟩

/-- ts:247-249: "Check if a hostname is a blocked IP address ... IPv6 brackets are allowed. A
hostname that is not an IP address is not blocked here; text with a ':' that does not parse counts
as an unreadable IPv6 literal and is blocked."

Irreducible: the parsers are structural, so unfolding this on a hostname would run them; proofs
unfold it explicitly. -/
@[irreducible] def HostnameBlocked (hostname : String) : Prop :=
  match parseIpv4 (stripBrackets hostname) with
  | some ipv4 => Blocked4 ipv4
  | none =>
    match parseIpv6 (stripBrackets hostname) with
    | some ipv6 => Blocked6 ipv6
    | none => (stripBrackets hostname).toList.contains ':' = true

/-- ts:353: "An answer that is not an IP address cannot be checked, so it blocks too (fail
closed)." A resolver answer is safe iff it is an address the spec does not block. -/
def AnswerSafe (answer : String) : Prop :=
  match parseIpv4 (stripBrackets answer) with
  | some ipv4 => ¬ Blocked4 ipv4
  | none =>
    match parseIpv6 (stripBrackets answer) with
    | some ipv6 => ¬ Blocked6 ipv6
    | none => False

/-! ## URLs -/

/-- ts:5: "1. Only HTTPS URLs allowed"; ts:283: "HTTPS only". -/
def HttpsOnly : Prop :=
  ∀ url : ParsedUrl, url.protocol ≠ "https:" →
    validateWebhookUrl (some url) = .invalid "HTTPS URL만 등록 가능합니다."

/-- ts:288: "Blocked hostnames — strip trailing dots (FQDN normalization: `localhost.` →
`localhost`)"; ts:256: "lower-cased, every trailing dot stripped". -/
def BlockedNamesRejected : Prop :=
  ∀ url : ParsedUrl, url.protocol = "https:" →
    checkedHostname url.hostname ∈ blockedHostnames →
      validateWebhookUrl (some url) = .invalid "내부 네트워크 주소는 등록할 수 없습니다."

/-- ts:256: "every trailing dot stripped": the checked hostname never ends in a dot. -/
def NoTrailingDot : Prop :=
  ∀ hostname : String, (checkedHostname hostname).toList.getLast? ≠ some '.'

/-- ts:290: "A host made only of dots leaves nothing to check": such an https URL is rejected as
malformed. -/
def EmptyHostRejected : Prop :=
  ∀ url : ParsedUrl, url.protocol = "https:" → checkedHostname url.hostname = "" →
    validateWebhookUrl (some url) = .invalid "올바른 URL 형식이 아닙니다."

/-- ts:299: "Blocked IP ranges": an https URL whose hostname is a blocked address is rejected. -/
def BlockedAddressesRejected : Prop :=
  ∀ url : ParsedUrl, url.protocol = "https:" →
    HostnameBlocked (checkedHostname url.hostname) →
      validateWebhookUrl (some url) = .invalid "내부 네트워크 주소는 등록할 수 없습니다."

/-- ts:327: "Skip DNS resolution only when the URL parser itself produced an IP literal, and an
allowed one". An IP-literal URL, one whose hostname as the URL parser produced it is an IPv4
address or a bracketed IPv6 address, gets the first pass's verdict, whatever DNS would say, and
the resolvers are not called.

Stated for a hostname in the form the first pass examines, lower-case and without a trailing dot
(`checkedHostname url.hostname = url.hostname`), which is how the URL parser writes every IP host:
`Vectors.lean` requires it of every URL vector whose hostname is an IP literal, and the
conformance test checks each vector's hostname against the engine. That `ipVerdict` ignores ASCII
case, which would shrink the hypothesis to "no trailing dot", is not proven. -/
def IpLiteralsSkipDns : Prop :=
  ∀ (url : ParsedUrl) (answers4 answers6 : List String),
    checkedHostname url.hostname = url.hostname → isIpLiteral (stripBrackets url.hostname) = true →
      validateWebhookUrlWithDns (some url) answers4 answers6 = (validateWebhookUrl (some url), none)

/-- ts:327-330: DNS is skipped only for an IP literal the URL parser itself produced, and "a
dotted quad followed by two or more dots stays a DNS name (`1.2.3.4..`) and is resolved"; ts:333:
"The resolvers take the hostname the first pass examined, without IPv6 brackets". Whenever the
first pass accepts a URL whose hostname, as the URL parser produced it, is not an address the spec
allows (`AnswerSafe`, the test every resolver answer must pass), the resolvers are called with the
checked hostname, brackets stripped. A DNS name is never accepted without DNS, not even one the
first pass examined, dots stripped, as an allowed address. -/
def DnsNamesResolved : Prop :=
  ∀ (url : ParsedUrl) (answers4 answers6 : List String),
    validateWebhookUrl (some url) = .valid → ¬ AnswerSafe url.hostname →
      (validateWebhookUrlWithDns (some url) answers4 answers6).2 =
        some (stripBrackets (checkedHostname url.hostname))

/-- ts:8: "4. DNS resolution validates resolved IPs (anti-rebinding)"; ts:310: "Resolves the
hostname and checks all returned IPs against blocked ranges"; ts:353 (unreadable answers block).
Whenever the resolvers are called, the URL is accepted iff they answered something and every answer
is safe. -/
def ResolvedIpsChecked : Prop :=
  ∀ (url : Option ParsedUrl) (answers4 answers6 : List String),
    (validateWebhookUrlWithDns url answers4 answers6).2.isSome = true →
      ((validateWebhookUrlWithDns url answers4 answers6).1 = .valid ↔
        (answers4 ++ answers6 ≠ [] ∧ ∀ ip ∈ answers4 ++ answers6, AnswerSafe ip))

/-- ts:333-334 with ts:256: the resolvers get the hostname the first pass examined, lower-cased,
without its trailing dots and without IPv6 brackets. -/
def ResolversGetCheckedHostname : Prop :=
  ∀ (url : ParsedUrl) (answers4 answers6 : List String) (queried : String),
    (validateWebhookUrlWithDns (some url) answers4 answers6).2 = some queried →
      queried = stripBrackets (checkedHostname url.hostname)

end SomaVerify.WebhookSsrf.Spec
