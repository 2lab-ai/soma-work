-- models: src/webhook-url-validator.ts:205-215 at commit a8d2e7ca (registryBlocks, the loop)
-- models: src/webhook-url-validator.ts:217-219 at commit a8d2e7ca (isBlockedIpv4)
-- models: src/webhook-url-validator.ts:225-228 at commit a8d2e7ca (isBlockedIpv6)
-- models: src/webhook-url-validator.ts:240-248 at commit a8d2e7ca (ipVerdict)
-- models: src/webhook-url-validator.ts:255-257 at commit a8d2e7ca (isBlockedIp)
-- models: src/webhook-url-validator.ts:279-310 at commit a8d2e7ca (validateWebhookUrl)
-- models: src/webhook-url-validator.ts:326-367 at commit a8d2e7ca (validateWebhookUrlWithDns)

import SomaVerify.WebhookSsrf.Model

/-!
# The model before the proof-backed simplification

`Model.lean` mirrors the simplified `src/webhook-url-validator.ts`. The definitions the
simplification changed are kept here as they were at commit a8d2e7ca, copied character for
character from `Model.lean` at that commit, in namespace `Original`, so that `Proofs.lean` can
prove each simplified definition equal to its original for every input (`*_eq_original`).

Two definitions changed (`registryBlocks`, with its loop `registryLoop`, and
`validateWebhookUrlWithDns`); the others here are unchanged text that calls a changed one, copied
so that inside `Original` every name still means what it meant before. Names not defined here
(`parseIpv4`, `stripBrackets`, `checkedHostname`, the tables, ...) resolve to the shared
definitions of `Model.lean`, which the simplification did not touch.
-/

namespace SomaVerify.WebhookSsrf.Original

/-- The `for (const block of registry)` loop of TS `registryBlocks`, from the state
`(bestLength, blocked)`. -/
def registryLoop (address bits : Nat) : List RegistryBlock → Int → Bool → Bool
  | [], _, blocked => blocked
  | block :: rest, bestLength, blocked =>
    if decide ((block.len : Int) > bestLength) && block.toBlock.contains bits address then
      registryLoop address bits rest block.len (block.reach != .yes)
    else
      registryLoop address bits rest bestLength blocked

/-- TS `registryBlocks`: the most specific block containing `address` decides; it blocks unless
it says `True`. `bestLength = -1, blocked = false` before the loop. -/
def registryBlocks (address : Nat) (registry : List RegistryBlock) (bits : Nat) : Bool :=
  registryLoop address bits registry (-1) false

/-- TS `isBlockedIpv4`. -/
def isBlockedIpv4 (address : Nat) : Bool :=
  registryBlocks address ipv4Special 32 || ipv4Extra.any fun block => block.contains 32 address

/-- TS `isBlockedIpv6`: a NAT64 address takes the verdict of the IPv4 address in its low 32 bits
(`address & 0xffffffffn`); any other address is blocked unless it is in 2000::/3 and the IPv6
registry does not block it. -/
def isBlockedIpv6 (address : Nat) : Bool :=
  if nat64WellKnown.contains 128 address then isBlockedIpv4 (address &&& 0xffffffff)
  else !ipv6GlobalUnicast.contains 128 address || registryBlocks address ipv6Special 128

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

/-- TS `validateWebhookUrlWithDns`, with DNS as input: `answers4` and `answers6` are what
`dns.resolve4(hostname)` and `dns.resolve6(hostname)` yield, a rejection being `[]` as the TS
`.catch` makes it. An answer that is not an address blocks, like a blocked one. The second
component is the hostname the resolvers are called with, `none` when they are not called. -/
def validateWebhookUrlWithDns (url : Option ParsedUrl) (answers4 answers6 : List String) :
    Validation × Option String :=
  match validateWebhookUrl url with
  | .invalid error => (.invalid error, none)
  | .valid =>
    match url with
    | none => (.valid, none)
    | some url =>
      let hostname := stripBrackets (checkedHostname url.hostname)
      if isIpLiteral hostname then (.valid, none)
      else
        let allIps := answers4 ++ answers6
        if allIps.isEmpty then (.invalid "DNS 확인 실패: 호스트를 찾을 수 없습니다.", some hostname)
        else if allIps.any (fun ip => ipVerdict ip != some false) then
          (.invalid "내부 네트워크 주소로 확인되는 도메인은 등록할 수 없습니다.", some hostname)
        else (.valid, some hostname)

end SomaVerify.WebhookSsrf.Original
