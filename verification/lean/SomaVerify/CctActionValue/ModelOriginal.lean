-- models: packages/slack/src/cct/action-value.ts:77-92 (encodeCctActionValue, pre-simplification)
-- models: packages/slack/src/cct/action-value.ts:109-128 (decodeCctActionValue, pre-simplification)
-- models: packages/slack/src/cct/action-value.ts:138-142 (readCctActionPayload, pre-simplification)
import SomaVerify.CctActionValue.Model

/-!
# The codec before the simplification

`encodeCctActionValue`, `decodeCctActionValue` and `readCctActionPayload` as they stood before
three checks were deleted from `packages/slack/src/cct/action-value.ts`; `Model.lean` has the
current functions. Line numbers below are those of the earlier file. It already had the
blank-payload check on line 125,
`if (payload.trim().length === 0) return { kind: 'invalid', raw };`, and differed from the
current file in three lines only:

    82   if (typeof payload !== 'string' || payload.length === 0 || payload.trim().length === 0) {
    111  if (raw.length === 0 || raw.trim().length === 0) return { kind: 'invalid', raw };
    124  if (mode.length === 0) return { kind: 'invalid', raw };

The current file has `typeof payload !== 'string' || payload.trim().length === 0` on line 82,
`raw.trim().length === 0` on line 111 and nothing in place of line 124.
`Proofs.encode_eq_original`, `Proofs.decode_eq_original` and `Proofs.read_eq_original` prove
that the deletions change no result. Constants, types and helpers are shared with `Model.lean`;
the three checks are the only difference.
-/

namespace SomaVerify.CctActionValue.Original

open SomaVerify.JsString SomaVerify.CctActionValue

/-- `encodeCctActionValue({ mode, payload })` before the simplification (lines 77-92). -/
def encodeCctActionValue (mode payload : String) : Except String String :=
  -- line 79
  if !VALID_MODES.contains mode then
    -- line 80
    .error ("encodeCctActionValue: unknown mode " ++ jsonStringify mode)
  -- line 82
  else if utf16Length payload == 0 || utf16Length (jsTrim payload) == 0 then
    -- line 83
    .error "encodeCctActionValue: payload must be a non-empty, non-whitespace string"
  else
    -- line 85
    let encoded := PREFIX ++ mode ++ SEP.toString ++ payload
    -- line 86
    if utf16Length encoded > SLACK_BUTTON_VALUE_MAX then
      -- lines 87-89
      .error ("encodeCctActionValue: encoded value " ++ toString (utf16Length encoded) ++
        " chars exceeds Slack cap " ++ toString SLACK_BUTTON_VALUE_MAX)
    else
      -- line 91
      .ok encoded

/-- `decodeCctActionValue(raw)` before the simplification (lines 109-128). -/
def decodeCctActionValue : RawValue → Decoded
  -- line 110
  | .nonString => .invalid .nonString
  | .str raw =>
    -- line 111
    if utf16Length raw == 0 || utf16Length (jsTrim raw) == 0 then .invalid (.str raw)
    -- lines 112-115
    else if !jsStartsWith raw PREFIX then .legacy raw
    else
      -- line 116
      let tail := raw.toList.drop PREFIX.length
      -- line 117
      match indexOfSep tail with
      -- lines 118-121
      | none => .invalid (.str raw)
      | some sepIdx =>
        -- line 122
        let mode := String.ofList (tail.take sepIdx)
        -- line 123
        let payload := String.ofList (tail.drop (sepIdx + 1))
        -- line 124
        if utf16Length mode == 0 then .invalid (.str raw)
        -- line 125
        else if utf16Length (jsTrim payload) == 0 then .invalid (.str raw)
        -- line 126
        else if !VALID_MODES.contains mode then .invalid (.str raw)
        -- line 127
        else .tagged mode payload

/-- `readCctActionPayload(raw)` before the simplification (lines 138-142), calling the decoder
above. -/
def readCctActionPayload (raw : RawValue) : Option String :=
  -- line 139
  match SomaVerify.CctActionValue.Original.decodeCctActionValue raw with
  -- line 140
  | .invalid _ => none
  -- line 141
  | .tagged _ payload => some payload
  | .legacy payload => some payload

end SomaVerify.CctActionValue.Original
