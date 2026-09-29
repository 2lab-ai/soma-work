-- models: src/webhook-url-validator.ts:23 (GloballyReachable)
-- models: src/webhook-url-validator.ts:36-63 (IPV4_SPECIAL_PURPOSE)
-- models: src/webhook-url-validator.ts:66-92 (IPV6_SPECIAL_PURPOSE)
-- models: src/webhook-url-validator.ts:95 (IPV4_ALSO_BLOCKED)
-- models: src/webhook-url-validator.ts:103, 109 (IPV6_GLOBAL_UNICAST_CIDR, NAT64_WELL_KNOWN_CIDR)
-- models: src/webhook-url-validator.ts:112-123 (parseIpv4)
-- models: src/webhook-url-validator.ts:129-145 (parseGroups)
-- models: src/webhook-url-validator.ts:151-161 (parseIpv6)
-- models: src/webhook-url-validator.ts:163-166, 184-186 (Block, RegistryBlock)
-- models: src/webhook-url-validator.ts:169-177, 188-198 (parseBlock and the parsed tables)
-- models: src/webhook-url-validator.ts:179-182 (inBlock)
-- models: src/webhook-url-validator.ts:204-211 (registryBlocks)
-- models: src/webhook-url-validator.ts:213-215 (isBlockedIpv4)
-- models: src/webhook-url-validator.ts:221-224 (isBlockedIpv6)
-- models: src/webhook-url-validator.ts:227-229 (stripBrackets)
-- models: src/webhook-url-validator.ts:236-244 (ipVerdict)
-- models: src/webhook-url-validator.ts:251-253 (isBlockedIp)
-- models: src/webhook-url-validator.ts:259-264 (checkedHostname)
-- models: src/webhook-url-validator.ts:275-306 (validateWebhookUrl)
-- models: src/webhook-url-validator.ts:322-359 (validateWebhookUrlWithDns; the resolvers' answers
--         are inputs)
-- models: src/webhook-url-validator.ts:21-29, 34-73 at commit 60d74c71 (the replaced
--         isPrivateIpv4 and isBlockedIp; section `Legacy`, for the no-regression theorems)

import SomaVerify.Support.Json

/-!
# Model of `src/webhook-url-validator.ts`

Addresses are numbers: an IPv4 address is a `Nat` below 2^32, an IPv6 address a `Nat` below
2^128, both read most significant bit first. The TS computes on `bigint`, whose `>>`, `<<`, `&`
and `|` on non-negative values are the `Nat` operations `>>>`, `<<<`, `&&&` and `|||` used here.

The TS tables hold address blocks as text (`'2001:db8::/32'`) and parse them when the module loads
(`parseBlock`). The tables below hold the parsed result as well as the text: proofs need the
numbers, and `Vectors.lean` checks at every run that parsing each `cidr` with this model's parser
gives exactly `base` and `len`.

The WHATWG URL parser is not modeled. `ParsedUrl` is what `new URL(raw)` hands the validator,
and every URL vector records it so the conformance test can check it against the engine.
-/

namespace SomaVerify.WebhookSsrf

/-! ## Tables -/

/-- The registries' "Globally Reachable" column, footnote markers dropped: TS `GloballyReachable`,
`'True' | 'False' | 'N/A' | ''`. `blank` is the registry's own empty cell. -/
inductive Reach where
  | yes
  | no
  | na
  | blank
  deriving DecidableEq, Repr

/-- The column value as the TS table spells it. -/
def Reach.text : Reach → String
  | .yes => "True"
  | .no => "False"
  | .na => "N/A"
  | .blank => ""

/-- TS `Block` plus the text it was parsed from: the block's first address and prefix length. -/
structure Block where
  cidr : String
  base : Nat
  len : Nat
  deriving Repr

/-- TS `RegistryBlock`: a block and its "Globally Reachable" value. -/
structure RegistryBlock extends Block where
  reach : Reach
  deriving Repr

/-- TS `IPV4_SPECIAL_PURPOSE` after `parseBlock`: the IANA IPv4 Special-Purpose Address Registry
(`verification/iana/iana-ipv4-special-registry-1.csv`), in registry order. -/
def ipv4Special : List RegistryBlock := [
  ⟨⟨"0.0.0.0/8", 0x00000000, 8⟩, .no⟩,
  ⟨⟨"0.0.0.0/32", 0x00000000, 32⟩, .no⟩,
  ⟨⟨"10.0.0.0/8", 0x0a000000, 8⟩, .no⟩,
  ⟨⟨"100.64.0.0/10", 0x64400000, 10⟩, .no⟩,
  ⟨⟨"127.0.0.0/8", 0x7f000000, 8⟩, .no⟩,
  ⟨⟨"169.254.0.0/16", 0xa9fe0000, 16⟩, .no⟩,
  ⟨⟨"172.16.0.0/12", 0xac100000, 12⟩, .no⟩,
  ⟨⟨"192.0.0.0/24", 0xc0000000, 24⟩, .no⟩,
  ⟨⟨"192.0.0.0/29", 0xc0000000, 29⟩, .no⟩,
  ⟨⟨"192.0.0.8/32", 0xc0000008, 32⟩, .no⟩,
  ⟨⟨"192.0.0.9/32", 0xc0000009, 32⟩, .yes⟩,
  ⟨⟨"192.0.0.10/32", 0xc000000a, 32⟩, .yes⟩,
  ⟨⟨"192.0.0.170/32", 0xc00000aa, 32⟩, .no⟩,
  ⟨⟨"192.0.0.171/32", 0xc00000ab, 32⟩, .no⟩,
  ⟨⟨"192.0.2.0/24", 0xc0000200, 24⟩, .no⟩,
  ⟨⟨"192.31.196.0/24", 0xc01fc400, 24⟩, .yes⟩,
  ⟨⟨"192.52.193.0/24", 0xc034c100, 24⟩, .yes⟩,
  ⟨⟨"192.88.99.0/24", 0xc0586300, 24⟩, .blank⟩,
  ⟨⟨"192.88.99.2/32", 0xc0586302, 32⟩, .no⟩,
  ⟨⟨"192.168.0.0/16", 0xc0a80000, 16⟩, .no⟩,
  ⟨⟨"192.175.48.0/24", 0xc0af3000, 24⟩, .yes⟩,
  ⟨⟨"198.18.0.0/15", 0xc6120000, 15⟩, .no⟩,
  ⟨⟨"198.51.100.0/24", 0xc6336400, 24⟩, .no⟩,
  ⟨⟨"203.0.113.0/24", 0xcb007100, 24⟩, .no⟩,
  ⟨⟨"240.0.0.0/4", 0xf0000000, 4⟩, .no⟩,
  ⟨⟨"255.255.255.255/32", 0xffffffff, 32⟩, .no⟩]

/-- TS `IPV6_SPECIAL_PURPOSE` after `parseBlock`: the IANA IPv6 Special-Purpose Address Registry
(`verification/iana/iana-ipv6-special-registry-1.csv`), in registry order. -/
def ipv6Special : List RegistryBlock := [
  ⟨⟨"::1/128", 0x00000000000000000000000000000001, 128⟩, .no⟩,
  ⟨⟨"::/128", 0x00000000000000000000000000000000, 128⟩, .no⟩,
  ⟨⟨"::ffff:0:0/96", 0x00000000000000000000ffff00000000, 96⟩, .no⟩,
  ⟨⟨"64:ff9b::/96", 0x0064ff9b000000000000000000000000, 96⟩, .yes⟩,
  ⟨⟨"64:ff9b:1::/48", 0x0064ff9b000100000000000000000000, 48⟩, .no⟩,
  ⟨⟨"100::/64", 0x01000000000000000000000000000000, 64⟩, .no⟩,
  ⟨⟨"100:0:0:1::/64", 0x01000000000000010000000000000000, 64⟩, .no⟩,
  ⟨⟨"2001::/23", 0x20010000000000000000000000000000, 23⟩, .no⟩,
  ⟨⟨"2001::/32", 0x20010000000000000000000000000000, 32⟩, .na⟩,
  ⟨⟨"2001:1::1/128", 0x20010001000000000000000000000001, 128⟩, .yes⟩,
  ⟨⟨"2001:1::2/128", 0x20010001000000000000000000000002, 128⟩, .yes⟩,
  ⟨⟨"2001:1::3/128", 0x20010001000000000000000000000003, 128⟩, .yes⟩,
  ⟨⟨"2001:2::/48", 0x20010002000000000000000000000000, 48⟩, .no⟩,
  ⟨⟨"2001:3::/32", 0x20010003000000000000000000000000, 32⟩, .yes⟩,
  ⟨⟨"2001:4:112::/48", 0x20010004011200000000000000000000, 48⟩, .yes⟩,
  ⟨⟨"2001:10::/28", 0x20010010000000000000000000000000, 28⟩, .blank⟩,
  ⟨⟨"2001:20::/28", 0x20010020000000000000000000000000, 28⟩, .yes⟩,
  ⟨⟨"2001:30::/28", 0x20010030000000000000000000000000, 28⟩, .yes⟩,
  ⟨⟨"2001:db8::/32", 0x20010db8000000000000000000000000, 32⟩, .no⟩,
  ⟨⟨"2002::/16", 0x20020000000000000000000000000000, 16⟩, .na⟩,
  ⟨⟨"2620:4f:8000::/48", 0x2620004f800000000000000000000000, 48⟩, .yes⟩,
  ⟨⟨"3fff::/20", 0x3fff0000000000000000000000000000, 20⟩, .no⟩,
  ⟨⟨"5f00::/16", 0x5f000000000000000000000000000000, 16⟩, .no⟩,
  ⟨⟨"fc00::/7", 0xfc000000000000000000000000000000, 7⟩, .no⟩,
  ⟨⟨"fe80::/10", 0xfe800000000000000000000000000000, 10⟩, .no⟩]

/-- TS `IPV4_EXTRA`: multicast, 224.0.0.0/4. -/
def ipv4Extra : List Block := [⟨"224.0.0.0/4", 0xe0000000, 4⟩]

/-- TS `IPV6_GLOBAL_UNICAST`: 2000::/3, the only "Global Unicast" allocation of the IANA IPv6
Address Space registry (https://www.iana.org/assignments/ipv6-address-space/; its XML carried
`<updated>2025-10-23</updated>` when read on 2026-09-29). -/
def ipv6GlobalUnicast : Block := ⟨"2000::/3", 0x20000000000000000000000000000000, 3⟩

/-- TS `NAT64_WELL_KNOWN`: 64:ff9b::/96 (RFC 6052). -/
def nat64WellKnown : Block := ⟨"64:ff9b::/96", 0x0064ff9b000000000000000000000000, 96⟩

/-! ## Classifier -/

/-- TS `inBlock`: `address >> (bits - length) === base >> (bits - length)`. -/
def Block.contains (bits : Nat) (block : Block) (address : Nat) : Bool :=
  address >>> (bits - block.len) == block.base >>> (bits - block.len)

/-- TS `registryBlocks`: blocked when a block containing `address` is not `True` and no more
specific block containing it is. `containing` is `registry.filter(...)`; `any` is `some`. -/
def registryBlocks (address : Nat) (registry : List RegistryBlock) (bits : Nat) : Bool :=
  let containing := registry.filter fun block => block.toBlock.contains bits address
  containing.any fun block =>
    block.reach != .yes &&
      !containing.any fun other => decide (other.len > block.len) && other.reach == .yes

/-- TS `isBlockedIpv4`. -/
def isBlockedIpv4 (address : Nat) : Bool :=
  registryBlocks address ipv4Special 32 || ipv4Extra.any fun block => block.contains 32 address

/-- TS `isBlockedIpv6`: a NAT64 address takes the verdict of the IPv4 address in its low 32 bits
(`address & 0xffffffffn`); any other address is blocked unless it is in 2000::/3 and the IPv6
registry does not block it. -/
def isBlockedIpv6 (address : Nat) : Bool :=
  if nat64WellKnown.contains 128 address then isBlockedIpv4 (address &&& 0xffffffff)
  else !ipv6GlobalUnicast.contains 128 address || registryBlocks address ipv6Special 128

/-! ## Text

The parsers work on the characters of the text (`String.toList`), with JS `split` written out as
the structural `splitOnChar` and `splitOnDoubleColon`, so the kernel can evaluate them on concrete
text. -/

/-- JS `text.split(sep)` for a one-character `sep`: the pieces between its occurrences, `[[]]`
for empty text. -/
def splitOnChar (sep : Char) : List Char → List (List Char)
  | [] => [[]]
  | c :: rest =>
    match splitOnChar sep rest with
    | [] => [[c]]
    | piece :: pieces => if c == sep then [] :: piece :: pieces else (c :: piece) :: pieces

/-- JS `text.split('::')`, from the piece read so far (reversed): scanning left to right, each
`::` ends a piece, so of overlapping colons the leftmost pair counts (`:::` is `["", ":"]`). -/
def splitOnDoubleColon : List Char → List Char → List (List Char)
  | ':' :: ':' :: rest, piece => piece.reverse :: splitOnDoubleColon rest []
  | c :: rest, piece => splitOnDoubleColon rest (c :: piece)
  | [], piece => [piece.reverse]

/-- `/^[0-9]{1,3}$/.test(part)`: one to three ASCII digits. -/
def isDecOctetText (part : List Char) : Bool :=
  1 ≤ part.length && part.length ≤ 3 && part.all Char.isDigit

/-- `Number(part)` for ASCII digits: their decimal value. -/
def decimalValue (part : List Char) : Nat :=
  part.foldl (fun value c => value * 10 + (c.toNat - '0'.toNat)) 0

/-- One character of `[0-9a-f]` under the regex flag `i`, i.e. also `A-F`. Non-unicode JS regexes
never case-fold a non-ASCII character onto ASCII (ECMA-262 Canonicalize), so nothing else matches. -/
def isHexChar (c : Char) : Bool :=
  c.isDigit || ('a' ≤ c && c ≤ 'f') || ('A' ≤ c && c ≤ 'F')

/-- The value of a hex digit accepted by `isHexChar`. -/
def hexCharValue (c : Char) : Nat :=
  if c.isDigit then c.toNat - '0'.toNat
  else if 'a' ≤ c && c ≤ 'f' then c.toNat - 'a'.toNat + 10
  else c.toNat - 'A'.toNat + 10

/-- `Number.parseInt(field, 16)` on hex digits. -/
def hexValue (field : List Char) : Nat :=
  field.foldl (fun value c => value * 16 + hexCharValue c) 0

/-- TS `parseIpv4` on the characters of `text`: `text.split('.')`, exactly four parts, each
`/^[0-9]{1,3}$/` and at most 255, accumulated as `value * 256 + octet`; the loop's `return null`
is `none` in `Option`. -/
def parseIpv4Chars (text : List Char) : Option Nat :=
  let parts := splitOnChar '.' text
  if parts.length != 4 then none
  else
    parts.foldlM (init := 0) fun value part =>
      if !isDecOctetText part then none
      else
        let octet := decimalValue part
        if octet > 255 then none else some (value * 256 + octet)

/-- TS `parseIpv4`. -/
def parseIpv4 (text : String) : Option Nat :=
  parseIpv4Chars text.toList

/-- The `for` loop of TS `parseGroups` over `fields`; `rest = []` is `i === fields.length - 1`. -/
def parseFields (ipv4Tail : Bool) : List (List Char) → Option (List Nat)
  | [] => some []
  | field :: rest =>
    if 1 ≤ field.length && field.length ≤ 4 && field.all isHexChar then
      (parseFields ipv4Tail rest).map (hexValue field :: ·)
    else if ipv4Tail && rest.isEmpty then
      match parseIpv4Chars field with
      | none => none
      | some ipv4 => some [ipv4 >>> 16, ipv4 &&& 0xffff]
    else
      none

/-- TS `parseGroups`: `''` has no groups, anything else is `part.split(':')`. -/
def parseGroups (part : List Char) (ipv4Tail : Bool) : Option (List Nat) :=
  if part.isEmpty then some [] else parseFields ipv4Tail (splitOnChar ':' part)

/-- TS `parseIpv6`: split on `::`, groups on each side, zero-fill to eight groups, then
`groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n)`. -/
def parseIpv6 (text : String) : Option Nat :=
  let halves := splitOnDoubleColon text.toList []
  if halves.length > 2 then none
  else
    let head := parseGroups (halves.getD 0 []) (halves.length == 1)
    let tail := if halves.length == 2 then parseGroups (halves.getD 1 []) true else some []
    match head, tail with
    | some head, some tail =>
      let explicit := head.length + tail.length
      if (if halves.length == 1 then explicit != 8 else explicit > 7) then none
      else
        some ((head ++ List.replicate (8 - explicit) 0 ++ tail).foldl
          (fun value group => (value <<< 16) ||| group) 0)
    | _, _ => none

/-- TS `stripBrackets`: `hostname.replace(/^\[|\]$/g, '')` removes a leading `[` and a trailing
`]`, each independently. -/
def stripBrackets (hostname : String) : String :=
  let cs := hostname.toList
  let cs := if cs.head? == some '[' then cs.tail else cs
  let cs := if cs.getLast? == some ']' then cs.dropLast else cs
  String.ofList cs

/-- TS `ipVerdict`: IPv4 first, then IPv6, brackets stripped. Text with a `:` that neither
parses is an unreadable IPv6 literal and blocked (`clean.includes(':')`); other text is not an
address (`none`). -/
def ipVerdict (hostname : String) : Option Bool :=
  let clean := stripBrackets hostname
  match parseIpv4 clean with
  | some ipv4 => some (isBlockedIpv4 ipv4)
  | none =>
    match parseIpv6 clean with
    | some ipv6 => some (isBlockedIpv6 ipv6)
    | none => if clean.toList.contains ':' then some true else none

/-- TS `isBlockedIp`: `ipVerdict(hostname) === true`, so text that is not an address, and has no
`:`, is not blocked. -/
def isBlockedIp (hostname : String) : Bool :=
  ipVerdict hostname == some true

/-! ## URL -/

/-- The two fields of `new URL(raw)` the validator reads. -/
structure ParsedUrl where
  protocol : String
  hostname : String
  deriving Repr

/-- TS `WebhookUrlValidation`: `{ valid: true }` or `{ valid: false, error }`. -/
inductive Validation where
  | valid
  | invalid (error : String)
  deriving DecidableEq, Repr

/-- TS `BLOCKED_HOSTNAMES`. -/
def blockedHostnames : List String := ["localhost", "metadata.google.internal"]

/-- TS `checkedHostname`: `hostname.toLowerCase()`, then every trailing `.` removed (the TS loop
walks back over them). The WHATWG host parser turns every https hostname into ASCII (IDNA ToASCII),
so ASCII lower-casing is the whole of `toLowerCase` on its output; the URL vectors check each
hostname against the engine. -/
def checkedHostname (hostname : String) : String :=
  String.ofList (((hostname.map Char.toLower).toList.reverse.dropWhile (· == '.')).reverse)

/-- TS `validateWebhookUrl`; `none` is `new URL(raw)` throwing. -/
def validateWebhookUrl : Option ParsedUrl → Validation
  | none => .invalid "올바른 URL 형식이 아닙니다."
  | some url =>
    if url.protocol != "https:" then .invalid "HTTPS URL만 등록 가능합니다."
    else
      let hostname := checkedHostname url.hostname
      if hostname == "" then .invalid "올바른 URL 형식이 아닙니다."
      else if blockedHostnames.contains hostname then .invalid "내부 네트워크 주소는 등록할 수 없습니다."
      else if isBlockedIp hostname then .invalid "내부 네트워크 주소는 등록할 수 없습니다."
      else .valid

/-- `net.isIP(hostname) !== 0`, which the DNS pass asked before the simplification
(`Original.validateWebhookUrlWithDns`). Node's `net.isIP` is trusted, not modeled: on the hostnames
the URL parser produces it agrees with this model's parsers, which the URL vectors check case by
case against the engine. `Spec.IpLiteralsSkipDns` states the documented behaviour with it. -/
def isIpLiteral (hostname : String) : Bool :=
  (parseIpv4 hostname).isSome || (parseIpv6 hostname).isSome

/-- TS `validateWebhookUrlWithDns`, with DNS as input: `answers4` and `answers6` are what
`dns.resolve4(hostname)` and `dns.resolve6(hostname)` yield, a rejection being `[]` as the TS
`.catch` makes it. An answer that is not an address blocks, like a blocked one. The second
component is the hostname the resolvers are called with, `none` when they are not called. An IP
literal is recognised by the first pass's own classification, `ipVerdict(checked) === false`
(`Original.validateWebhookUrlWithDns`, the version before, asked Node's `net.isIP`). -/
def validateWebhookUrlWithDns (url : Option ParsedUrl) (answers4 answers6 : List String) :
    Validation × Option String :=
  match validateWebhookUrl url with
  | .invalid error => (.invalid error, none)
  | .valid =>
    match url with
    | none => (.valid, none)
    | some url =>
      let checked := checkedHostname url.hostname
      if ipVerdict checked == some false then (.valid, none)
      else
        let hostname := stripBrackets checked
        let allIps := answers4 ++ answers6
        if allIps.isEmpty then (.invalid "DNS 확인 실패: 호스트를 찾을 수 없습니다.", some hostname)
        else if allIps.any (fun ip => ipVerdict ip != some false) then
          (.invalid "내부 네트워크 주소로 확인되는 도메인은 등록할 수 없습니다.", some hostname)
        else (.valid, some hostname)

/-! ## Address text

Not a model of the TS: how the engine writes addresses, used for the conformance vectors and to
state what the replaced code saw. The conformance test checks `render6` against the engine's own
serializer on every canonical IPv6 vector. -/

/-- Dotted-quad text of an IPv4 address, as the WHATWG IPv4 serializer writes it. -/
def render4 (n : Nat) : String :=
  s!"{n / 2 ^ 24 % 256}.{n / 2 ^ 16 % 256}.{n / 2 ^ 8 % 256}.{n % 256}"

/-- Shortest lower-case hex digits of a 16-bit piece. -/
def hexText (g : Nat) : List Char :=
  if g < 0x10 then [Json.hexDigit g]
  else if g < 0x100 then [Json.hexDigit (g / 0x10), Json.hexDigit (g % 0x10)]
  else if g < 0x1000 then
    [Json.hexDigit (g / 0x100), Json.hexDigit (g / 0x10 % 0x10), Json.hexDigit (g % 0x10)]
  else
    [Json.hexDigit (g / 0x1000 % 0x10), Json.hexDigit (g / 0x100 % 0x10),
      Json.hexDigit (g / 0x10 % 0x10), Json.hexDigit (g % 0x10)]

/-- The eight 16-bit pieces of an IPv6 address, most significant first. -/
def pieces (n : Nat) : List Nat :=
  (List.range 8).map fun i => n / 2 ^ (16 * (7 - i)) % 0x10000

/-- Length of the run of zero pieces starting at the head of `ps`. -/
def zeroRun (ps : List Nat) : Nat :=
  (ps.takeWhile (· == 0)).length

/-- WHATWG URL Standard, IPv6 serializer, steps 2-3: the index of the first piece of the first
longest run of zero pieces, if that run is longer than one piece. -/
def compressAt (ps : List Nat) : Option Nat :=
  let best := (List.range 8).foldl
    (fun (best : Nat × Nat) i => if zeroRun (ps.drop i) > best.2 then (i, zeroRun (ps.drop i)) else best)
    (0, 0)
  if best.2 > 1 then some best.1 else none

/-- WHATWG URL Standard, IPv6 serializer, step 5, from piece `index` on. -/
def serializePieces (compress : Option Nat) : List Nat → Nat → Bool → String
  | [], _, _ => ""
  | piece :: rest, index, ignore0 =>
    if ignore0 && piece == 0 then serializePieces compress rest (index + 1) true
    else if compress == some index then
      (if index == 0 then "::" else ":") ++ serializePieces compress rest (index + 1) true
    else
      String.ofList (hexText piece) ++ (if index != 7 then ":" else "") ++
        serializePieces compress rest (index + 1) false

/-- The WHATWG IPv6 serializer: the text `new URL('https://[..]').hostname` puts in brackets. -/
def render6 (n : Nat) : String :=
  serializePieces (compressAt (pieces n)) (pieces n) 0 false

/-! ## Legacy

The code the security fix replaced (src/webhook-url-validator.ts at commit 60d74c71), on the text
the engine writes for an address: the "original code" of the no-regression theorems
(`original_blocked4_still_blocked`, `original_blocked6_still_blocked`). Only those use it. (Namespace
`Original` is the model before the proof-backed simplification, in `ModelOriginal.lean`.) -/

namespace Legacy

/-- `isPrivateIpv4(a, b)` at 60d74c71, lines 21-29. -/
def isPrivateIpv4 (a b : Nat) : Bool :=
  if a == 127 || a == 10 || a == 0 then true
  else if a == 172 && 16 ≤ b && b ≤ 31 then true
  else if a == 192 && b == 168 then true
  else if a == 169 && b == 254 then true
  else if a == 100 && 64 ≤ b && b ≤ 127 then true
  else if a == 198 && (b == 18 || b == 19) then true
  else false

/-- `isBlockedIp(render4 n)` at 60d74c71: only the dotted-quad regex (lines 58-62) matches that
text, and it passes the first two octets on. -/
def blocked4 (n : Nat) : Bool :=
  isPrivateIpv4 (n / 2 ^ 24 % 256) (n / 2 ^ 16 % 256)

/-- `lower.startsWith(p)` for the patterns of lines 67-68, on text that begins with `t`. -/
def prefixHit (t : List Char) : Bool :=
  ['f', 'c'].isPrefixOf t || ['f', 'd'].isPrefixOf t || ['f', 'e', '8'].isPrefixOf t ||
    ['f', 'e', '9'].isPrefixOf t || ['f', 'e', 'a'].isPrefixOf t || ['f', 'e', 'b'].isPrefixOf t

/-- `isBlockedIp(render6 n)` at 60d74c71, branch by branch:

* line 39: `render6` writes 0 as `::` and 1 as `::1`, and never writes `::0`;
* lines 49-55: `render6` writes an address of `::ffff:0:0/96` as `::ffff:X:Y` (the five leading
  zero pieces are the longest run), which the hex regex matches with `hi = X`;
* lines 42-46 and 58-62 never match `render6` output, which has no dots;
* lines 65-70: the text starts with the first piece's hex digits and then `:` when that piece is
  not 0, and with `::` or `0:` when it is. The patterns are hex digits only, so the test is the
  prefix test on those digits followed by `:`. -/
def blocked6 (n : Nat) : Bool :=
  let hi := n / 2 ^ 16 % 0x10000
  let first := n / 2 ^ 112 % 0x10000
  if n == 0 || n == 1 then true
  else if n / 2 ^ 32 == 0xffff then isPrivateIpv4 ((hi >>> 8) &&& 0xff) (hi &&& 0xff)
  else first != 0 && prefixHit (hexText first ++ [':'])

end Legacy

end SomaVerify.WebhookSsrf
