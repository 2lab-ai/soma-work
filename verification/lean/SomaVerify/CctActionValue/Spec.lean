import SomaVerify.CctActionValue.Model
import SomaVerify.CctActionValue.ModelOriginal

/-!
# What the CCT button-value codec promises

The invariants its doc comments state, as propositions about the model. Each cites the comment
it formalizes as `path:line` and quotes it. `Proofs.lean` proves each one under the same name in
snake case (`RoundTrip` as `round_trip`).

The last section compares the current functions with the ones in `ModelOriginal.lean`, the
functions before three redundant checks were deleted, and states that the deletions change no
result.
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
`'cm:'` (no mode, no `|`); `'cm:admin'` (no `|`); `'cm:admin|'` / `'cm:admin| '` (empty /
whitespace-only payload); `'cm:|abc'` (empty mode); `'cm:bad|abc'` (unknown mode)". Each listed
value decodes to `invalid`, carrying the value. -/
def InvalidMatrix : Prop :=
  decodeCctActionValue .nonString = .invalid .nonString ∧
  decodeCctActionValue (.str "") = .invalid (.str "") ∧
  (∀ s, jsTrim s = "" → decodeCctActionValue (.str s) = .invalid (.str s)) ∧
  decodeCctActionValue (.str "cm:") = .invalid (.str "cm:") ∧
  decodeCctActionValue (.str "cm:admin") = .invalid (.str "cm:admin") ∧
  decodeCctActionValue (.str "cm:admin|") = .invalid (.str "cm:admin|") ∧
  decodeCctActionValue (.str "cm:admin| ") = .invalid (.str "cm:admin| ") ∧
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

/-- packages/slack/src/cct/action-value.ts:31, "`'cm:admin| '` (whitespace-only payload)", for
every mode position without a separator and every payload that trims to empty (checked on
packages/slack/src/cct/action-value.ts:124). -/
def BlankPayloadInvalid : Prop :=
  ∀ mode payload, SEP ∉ mode.toList → jsTrim payload = "" →
    decodeCctActionValue (.str (wire mode payload)) = .invalid (.str (wire mode payload))

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
string }`", with packages/slack/src/cct/action-value.ts:31-33 (empty or whitespace-only payload,
empty mode and unknown mode are invalid): a tagged result never has a mode outside the two or a
payload that is empty or white space only. -/
def TaggedSound : Prop :=
  ∀ raw mode payload, decodeCctActionValue raw = .tagged mode payload →
    mode ∈ VALID_MODES ∧ jsTrim payload ≠ ""

/-- packages/slack/src/cct/action-value.ts:104-105: "split on the FIRST `|` only. So
`cm:admin|abc|def` → `{ mode: 'admin', payload: 'abc|def' }`". The decoder returns
`tagged mode payload` exactly for the wire form of a valid mode and a payload that is not
blank. -/
def TaggedIff : Prop :=
  ∀ raw mode payload, decodeCctActionValue raw = .tagged mode payload ↔
    (raw = .str (wire mode payload) ∧ mode ∈ VALID_MODES ∧ jsTrim payload ≠ "")

/-- packages/slack/src/cct/action-value.ts:97-98: "Decoder is INTENTIONALLY conservative: a
malformed `cm:`-prefixed value is `invalid`"; packages/slack/src/cct/action-value.ts:68-71, the
encoder "Throws on: unknown mode; empty / whitespace-only payload; encoded result exceeds Slack's
2000-char button-value cap". A value the encoder cannot produce is malformed: for every value
within the cap, the decoder returns `tagged mode payload` exactly when encoding `mode` and
`payload` returns that value. -/
def TaggedIffEncoded : Prop :=
  ∀ s mode payload, utf16Length s ≤ SLACK_BUTTON_VALUE_MAX →
    (decodeCctActionValue (.str s) = .tagged mode payload ↔
      encodeCctActionValue mode payload = .ok s)

/-- `TaggedIffEncoded` as sets: within the cap, the values the decoder reads as tagged are
exactly the values the encoder returns. -/
def TaggedImage : Prop :=
  ∀ s, utf16Length s ≤ SLACK_BUTTON_VALUE_MAX →
    ((∃ mode payload, decodeCctActionValue (.str s) = .tagged mode payload) ↔
      ∃ mode payload, encodeCctActionValue mode payload = .ok s)

/-! ## readCctActionPayload -/

/-- packages/slack/src/cct/action-value.ts:131: "Returns null on `invalid`". The reader returns
`null` exactly when the decoder returns `invalid`. -/
def ReadNoneIff : Prop :=
  ∀ raw, readCctActionPayload raw = none ↔ decodeCctActionValue raw = .invalid raw

/-- packages/slack/src/cct/action-value.ts:130-131: "pull the inner payload from a button value,
regardless of `tagged` vs `legacy` form". The reader returns a payload exactly when the decoder
returns it, tagged or legacy. -/
def ReadSomeIff : Prop :=
  ∀ raw payload, readCctActionPayload raw = some payload ↔
    ((∃ mode, decodeCctActionValue raw = .tagged mode payload) ∨
      decodeCctActionValue raw = .legacy payload)

/-! ## The simplification changes no result

`Original.encodeCctActionValue`, `Original.decodeCctActionValue` and
`Original.readCctActionPayload` (`ModelOriginal.lean`) are the functions before three checks
were deleted: `payload.length === 0 ||` from packages/slack/src/cct/action-value.ts:82,
`raw.length === 0 ||` from packages/slack/src/cct/action-value.ts:111, and
`if (mode.length === 0) return { kind: 'invalid', raw };`, which stood between the current
lines 123 and 124. Each proposition says the current function returns exactly what the earlier
one returned, on every input: the same value, the same error message, the same `raw`. -/

/-- The encoder without `payload.length === 0 ||` on packages/slack/src/cct/action-value.ts:82
behaves as before: `payload.trim().length === 0` already holds for the empty payload, and both
disjuncts threw the same message. -/
def EncodeEqOriginal : Prop :=
  ∀ mode payload, encodeCctActionValue mode payload = Original.encodeCctActionValue mode payload

/-- The decoder without `raw.length === 0 ||` on packages/slack/src/cct/action-value.ts:111 and
without the check `mode.length === 0` behaves as before: the empty string trims to the empty
string, and an empty mode fails `VALID_MODES.has` on packages/slack/src/cct/action-value.ts:125,
which returns the same `{ kind: 'invalid', raw }`. -/
def DecodeEqOriginal : Prop :=
  ∀ raw, decodeCctActionValue raw = Original.decodeCctActionValue raw

/-- `readCctActionPayload` (packages/slack/src/cct/action-value.ts:137-141, unchanged) calls the
decoder, so it behaves as before as well. -/
def ReadEqOriginal : Prop :=
  ∀ raw, readCctActionPayload raw = Original.readCctActionPayload raw

end SomaVerify.CctActionValue.Spec
