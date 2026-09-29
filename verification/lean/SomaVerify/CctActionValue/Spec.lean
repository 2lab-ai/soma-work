import SomaVerify.CctActionValue.Model

/-!
# What the CCT button-value codec promises

The invariants its doc comments state, as propositions about the model. Each cites the comment
it formalizes as `path:line` and quotes it. `Proofs.lean` proves each one under the same name in
snake case (`RoundTrip` as `round_trip`).

The last section is not about the TS as written: it defines the simplifications the proofs
allow, for the next phase, and states that they change no result.
-/

namespace SomaVerify.CctActionValue.Spec

open SomaVerify.JsString SomaVerify.CctActionValue

/-- The wire form `cm:<mode>|<payload>`, built on packages/slack/src/cct/action-value.ts:85.
packages/slack/src/cct/action-value.ts:19-20: "`cm:admin|<payload>` — card was posted in admin
mode", "`cm:readonly|<payload>` — card was posted in readonly mode". -/
def wire (mode payload : String) : String :=
  PREFIX ++ mode ++ SEP.toString ++ payload

/-! ## Encode and decode are inverse -/

/-- packages/slack/src/cct/action-value.ts:14-16: "Encoding mode + payload here lets handlers
reconstruct the card"; packages/slack/src/cct/action-value.ts:104-107: "split on the FIRST `|`
only ... (a payload may itself contain `|` ...) without forcing the caller to escape". Every
value the encoder returns decodes to the mode and payload it was built from, whatever the
payload contains. -/
def RoundTrip : Prop :=
  ∀ mode payload encoded, encodeCctActionValue mode payload = .ok encoded →
    decodeCctActionValue (.str encoded) = .tagged mode payload

/-- The same from the inputs' side: for either mode and any payload that is not blank and whose
wire form fits the cap, encoding returns the wire form and decoding it gives the inputs back. -/
def RoundTripOfValid : Prop :=
  ∀ mode payload, mode ∈ VALID_MODES → jsTrim payload ≠ "" →
    utf16Length (wire mode payload) ≤ SLACK_BUTTON_VALUE_MAX →
      encodeCctActionValue mode payload = .ok (wire mode payload) ∧
        decodeCctActionValue (.str (wire mode payload)) = .tagged mode payload

/-! ## Encode -/

/-- packages/slack/src/cct/action-value.ts:68-71: "Throws on: unknown mode; empty /
whitespace-only payload; encoded result exceeds Slack's 2000-char button-value cap". The encoder
throws on exactly these three conditions: on each of them, and on nothing else. -/
def EncodeFailureSet : Prop :=
  ∀ mode payload, (∃ msg, encodeCctActionValue mode payload = .error msg) ↔
    (mode ∉ VALID_MODES ∨ jsTrim payload = "" ∨
      utf16Length (wire mode payload) > SLACK_BUTTON_VALUE_MAX)

/-- packages/slack/src/cct/action-value.ts:19-20 (the wire form) and
packages/slack/src/cct/action-value.ts:35-37: "encoded results are length-checked at encode
time". The encoder returns a value exactly for a valid mode, a payload that is not blank and a
wire form within the cap, and that value is the wire form. -/
def EncodeOk : Prop :=
  ∀ mode payload encoded, encodeCctActionValue mode payload = .ok encoded ↔
    (mode ∈ VALID_MODES ∧ jsTrim payload ≠ "" ∧
      utf16Length (wire mode payload) ≤ SLACK_BUTTON_VALUE_MAX ∧ encoded = wire mode payload)

/-! ## Decode: the invalid matrix -/

/-- packages/slack/src/cct/action-value.ts:25-33: "Invalid matrix (decoder rejects all of these
— NO legacy fallback): `null` / `undefined` / non-string; empty string `''`; whitespace-only;
`'cm:'` (no mode, no `|`); `'cm:admin'` (no `|`); `'cm:admin|'` (empty payload); `'cm:|abc'`
(empty mode); `'cm:bad|abc'` (unknown mode)". Each listed value decodes to `invalid`, carrying
the value. -/
def InvalidMatrix : Prop :=
  decodeCctActionValue .nonString = .invalid .nonString ∧
  decodeCctActionValue (.str "") = .invalid (.str "") ∧
  (∀ s, jsTrim s = "" → decodeCctActionValue (.str s) = .invalid (.str s)) ∧
  decodeCctActionValue (.str "cm:") = .invalid (.str "cm:") ∧
  decodeCctActionValue (.str "cm:admin") = .invalid (.str "cm:admin") ∧
  decodeCctActionValue (.str "cm:admin|") = .invalid (.str "cm:admin|") ∧
  decodeCctActionValue (.str "cm:|abc") = .invalid (.str "cm:|abc") ∧
  decodeCctActionValue (.str "cm:bad|abc") = .invalid (.str "cm:bad|abc")

/-- packages/slack/src/cct/action-value.ts:29-30, "`'cm:'` (no mode, no `|`)", "`'cm:admin'` (no
`|`)", and packages/slack/src/cct/action-value.ts:119, "prefix without the `|` separator", for
every tail: a prefixed value with no separator is invalid. -/
def NoSeparatorInvalid : Prop :=
  ∀ t, SEP ∉ t.toList →
    decodeCctActionValue (.str (PREFIX ++ t)) = .invalid (.str (PREFIX ++ t))

/-- packages/slack/src/cct/action-value.ts:31, "`'cm:admin|'` (empty payload)", for every mode
position without a separator in it. -/
def EmptyPayloadInvalid : Prop :=
  ∀ mode, SEP ∉ mode.toList →
    decodeCctActionValue (.str (wire mode "")) = .invalid (.str (wire mode ""))

/-- packages/slack/src/cct/action-value.ts:32, "`'cm:|abc'` (empty mode)", for every payload. -/
def EmptyModeInvalid : Prop :=
  ∀ payload, decodeCctActionValue (.str (wire "" payload)) = .invalid (.str (wire "" payload))

/-- packages/slack/src/cct/action-value.ts:33, "`'cm:bad|abc'` (unknown mode)", for every mode
position without a separator that is not a valid mode, and every payload. -/
def UnknownModeInvalid : Prop :=
  ∀ mode payload, SEP ∉ mode.toList → mode ∉ VALID_MODES →
    decodeCctActionValue (.str (wire mode payload)) = .invalid (.str (wire mode payload))

/-- packages/slack/src/cct/action-value.ts:57-58: "`invalid` carries the raw input for
logging". -/
def InvalidCarriesRaw : Prop :=
  ∀ raw r, decodeCctActionValue raw = .invalid r → r = raw

/-! ## Decode: legacy and tagged -/

/-- packages/slack/src/cct/action-value.ts:21, "`<payload>` — legacy form (no `cm:` prefix)";
packages/slack/src/cct/action-value.ts:56, "`legacy` carries a non-empty string with NO
prefix"; packages/slack/src/cct/action-value.ts:113, "Legacy: any non-empty, non-whitespace
string with no `cm:` prefix". The decoder returns `legacy` exactly for the strings that are not
blank and do not start with `cm:`, and the payload is the whole input. -/
def LegacyIff : Prop :=
  ∀ raw payload, decodeCctActionValue raw = .legacy payload ↔
    (raw = .str payload ∧ jsTrim payload ≠ "" ∧ jsStartsWith payload PREFIX = false)

/-- packages/slack/src/cct/action-value.ts:97-98: "a malformed `cm:`-prefixed value is
`invalid`, NOT `legacy`". A value that starts with `cm:` never decodes to `legacy`. -/
def PrefixedNeverLegacy : Prop :=
  ∀ s payload, jsStartsWith s PREFIX = true → decodeCctActionValue (.str s) ≠ .legacy payload

/-- packages/slack/src/cct/action-value.ts:61, "`{ kind: 'tagged'; mode: CctCardMode; payload:
string }`", with packages/slack/src/cct/action-value.ts:31-33 (empty payload, empty mode and
unknown mode are invalid): a tagged result never has an empty payload or a mode outside the
two. -/
def TaggedSound : Prop :=
  ∀ raw mode payload, decodeCctActionValue raw = .tagged mode payload →
    mode ∈ VALID_MODES ∧ payload ≠ ""

/-- packages/slack/src/cct/action-value.ts:104-105: "split on the FIRST `|` only. So
`cm:admin|abc|def` → `{ mode: 'admin', payload: 'abc|def' }`". The decoder returns
`tagged mode payload` exactly for the wire form of a valid mode and a non-empty payload. -/
def TaggedIff : Prop :=
  ∀ raw mode payload, decodeCctActionValue raw = .tagged mode payload ↔
    (raw = .str (wire mode payload) ∧ mode ∈ VALID_MODES ∧ payload ≠ "")

/-! ## readCctActionPayload -/

/-- packages/slack/src/cct/action-value.ts:132: "Returns null on `invalid`". The reader returns
`null` exactly when the decoder returns `invalid`. -/
def ReadNoneIff : Prop :=
  ∀ raw, readCctActionPayload raw = none ↔ decodeCctActionValue raw = .invalid raw

/-- packages/slack/src/cct/action-value.ts:131-132: "pull the inner payload from a button value,
regardless of `tagged` vs `legacy` form". The reader returns a payload exactly when the decoder
returns it, tagged or legacy. -/
def ReadSomeIff : Prop :=
  ∀ raw payload, readCctActionPayload raw = some payload ↔
    ((∃ mode, decodeCctActionValue raw = .tagged mode payload) ∨
      decodeCctActionValue raw = .legacy payload)

/-! ## Simplification candidates (not the TS as written)

`decodeVariant keep111 keep124` is `decodeCctActionValue` with two checks made optional:
`keep111` keeps `raw.length === 0 ||` on packages/slack/src/cct/action-value.ts:111, `keep124`
keeps packages/slack/src/cct/action-value.ts:124 (`mode.length === 0`). `encodeVariant keep82`
is `encodeCctActionValue` with `payload.length === 0 ||` on
packages/slack/src/cct/action-value.ts:82 optional. The `true` instances are the model
(`DecodeVariantIsModel`, `EncodeVariantIsModel`); the `Redundant*` propositions say that
dropping a check changes no result, for any setting of the other. -/

/-- `decodeCctActionValue` with the length disjunct of packages/slack/src/cct/action-value.ts:111
and the check of packages/slack/src/cct/action-value.ts:124 optional. -/
def decodeVariant (keep111 keep124 : Bool) : RawValue → Decoded
  | .nonString => .invalid .nonString
  | .str raw =>
    if (keep111 && utf16Length raw == 0) || utf16Length (jsTrim raw) == 0 then .invalid (.str raw)
    else if !jsStartsWith raw PREFIX then .legacy raw
    else
      let tail := raw.toList.drop PREFIX.length
      match indexOfSep tail with
      | none => .invalid (.str raw)
      | some sepIdx =>
        let mode := String.ofList (tail.take sepIdx)
        let payload := String.ofList (tail.drop (sepIdx + 1))
        if keep124 && utf16Length mode == 0 then .invalid (.str raw)
        else if utf16Length payload == 0 then .invalid (.str raw)
        else if !VALID_MODES.contains mode then .invalid (.str raw)
        else .tagged mode payload

/-- `encodeCctActionValue` with the length disjunct of packages/slack/src/cct/action-value.ts:82
optional. -/
def encodeVariant (keep82 : Bool) (mode payload : String) : Except String String :=
  if !VALID_MODES.contains mode then
    .error ("encodeCctActionValue: unknown mode " ++ jsonStringify mode)
  else if (keep82 && utf16Length payload == 0) || utf16Length (jsTrim payload) == 0 then
    .error "encodeCctActionValue: payload must be a non-empty, non-whitespace string"
  else
    let encoded := PREFIX ++ mode ++ SEP.toString ++ payload
    if utf16Length encoded > SLACK_BUTTON_VALUE_MAX then
      .error ("encodeCctActionValue: encoded value " ++ toString (utf16Length encoded) ++
        " chars exceeds Slack cap " ++ toString SLACK_BUTTON_VALUE_MAX)
    else
      .ok encoded

/-- With every check kept, `decodeVariant` is the model, so the propositions below are about the
TS as written. -/
def DecodeVariantIsModel : Prop :=
  ∀ raw, decodeVariant true true raw = decodeCctActionValue raw

/-- With the check kept, `encodeVariant` is the model. -/
def EncodeVariantIsModel : Prop :=
  ∀ mode payload, encodeVariant true mode payload = encodeCctActionValue mode payload

/-- packages/slack/src/cct/action-value.ts:111: `raw.length === 0` is implied by
`raw.trim().length === 0`, so dropping it changes no result. -/
def RedundantRawLengthCheck : Prop :=
  ∀ keep124 raw, decodeVariant false keep124 raw = decodeVariant true keep124 raw

/-- packages/slack/src/cct/action-value.ts:124: an empty mode fails `VALID_MODES.has` on
packages/slack/src/cct/action-value.ts:126, which returns the same `{ kind: 'invalid', raw }` (as
does line 125 in between), so dropping the check changes no result. -/
def RedundantModeLengthCheck : Prop :=
  ∀ keep111 raw, decodeVariant keep111 false raw = decodeVariant keep111 true raw

/-- packages/slack/src/cct/action-value.ts:82: `payload.length === 0` is implied by
`payload.trim().length === 0`, and both throw the same message, so dropping it changes no
result. Strings only: the `typeof payload !== 'string'` disjunct before it stays. -/
def RedundantPayloadLengthCheck : Prop :=
  ∀ mode payload, encodeVariant false mode payload = encodeVariant true mode payload

end SomaVerify.CctActionValue.Spec
