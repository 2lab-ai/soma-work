-- models: packages/slack/src/cct/action-value.ts:43-52 (constants)
-- models: packages/slack/src/cct/action-value.ts:60-63 (DecodedCctActionValue)
-- models: packages/slack/src/cct/action-value.ts:77-92 (encodeCctActionValue)
-- models: packages/slack/src/cct/action-value.ts:109-128 (decodeCctActionValue)
-- models: packages/slack/src/cct/action-value.ts:138-142 (readCctActionPayload)
import SomaVerify.Support.Json
import SomaVerify.Support.JsString

/-!
# Model of the CCT button-value codec

`packages/slack/src/cct/action-value.ts` stamps a card's render mode and an inner payload onto
a Slack button value, `cm:<mode>|<payload>`, and reads it back. Each definition below
transcribes one TS declaration: the same checks in the same order, with the same results. Line
numbers in comments refer to that file.

A JS string is a sequence of UTF-16 code units, a Lean `String` a sequence of Unicode scalar
values (`SomaVerify/Support/JsString.lean`). `.length`, `.trim()` and `.startsWith()` go through
`utf16Length`, `jsTrim` and `jsStartsWith`. The decoder's `slice` and `indexOf` (lines 116-123)
are modeled on characters, which is exact for the arguments the decoder passes:

* `PREFIX` is three ASCII characters (three code units), and `raw.slice(PREFIX.length)`
  (line 116) runs only once `raw` starts with `PREFIX`, so it drops exactly those three
  characters;
* `SEP` is U+007C, one code unit outside the surrogate range, so in a well-formed string the
  first `|` code unit of `tail` is the first `|` character. `tail.indexOf(SEP)` counts code
  units, which differs from a character position when an astral character comes before the
  separator; the decoder uses it only to slice around the separator (lines 122-123), and those
  slices are the characters before it and the characters after it either way.

The conformance vectors put astral characters on both sides of the separator.
-/

namespace SomaVerify.CctActionValue

open SomaVerify.JsString

/-- `const PREFIX = 'cm:'` (line 43). -/
def PREFIX : String := "cm:"

/-- `const SEP = '|'` (line 44): a one-character string in the TS, that character here. -/
def SEP : Char := '|'

/-- `const SLACK_BUTTON_VALUE_MAX = 2000` (line 50). -/
def SLACK_BUTTON_VALUE_MAX : Nat := 2000

/-- `const VALID_MODES = new Set<CctCardMode>(['admin', 'readonly'])` (line 52).
`VALID_MODES.has(x)` is `VALID_MODES.contains x`. -/
def VALID_MODES : List String := ["admin", "readonly"]

/-- The decoder's argument `raw: unknown` (line 109): a string, or any other JS value (`null`,
`undefined`, a number, an object, ...). The decoder only asks `typeof raw !== 'string'`
(line 110), so every non-string value is one case here; the conformance test passes real ones
to the TS. -/
inductive RawValue where
  | str (s : String)
  | nonString
  deriving DecidableEq, Repr

/-- `DecodedCctActionValue` (lines 60-63). `mode` is a `String`, as it is at run time: the TS
narrows it with a cast (line 127) after the `VALID_MODES` check (line 126), and that it is one
of the two modes is a theorem (`decode_tagged_sound`), not a type. -/
inductive Decoded where
  | tagged (mode payload : String)
  | legacy (payload : String)
  | invalid (raw : RawValue)
  deriving DecidableEq, Repr

/-- One code point as `JSON.stringify` writes it inside a string literal (ECMA-262,
QuoteJSONString): the seven characters with a short escape (backspace, tab, line feed, form
feed, carriage return, quotation mark, reverse solidus) as that escape; any other code point
below U+0020 as `\u00xx` in lower-case hexadecimal (UnicodeEscape); everything else as itself.
QuoteJSONString's remaining case, a lone surrogate, cannot occur in a Lean `String`. -/
def jsonQuoteChar (c : Char) : List Char :=
  if c.toNat == 0x08 then ['\\', 'b']
  else if c.toNat == 0x09 then ['\\', 't']
  else if c.toNat == 0x0A then ['\\', 'n']
  else if c.toNat == 0x0C then ['\\', 'f']
  else if c.toNat == 0x0D then ['\\', 'r']
  else if c == '"' then ['\\', '"']
  else if c == '\\' then ['\\', '\\']
  else if c.toNat < 0x20 then
    ['\\', 'u', '0', '0', Json.hexDigit (c.toNat / 16), Json.hexDigit (c.toNat % 16)]
  else [c]

/-- `JSON.stringify(s)` for a string `s` (line 80): `s` between quotation marks, each code point
written by `jsonQuoteChar`. -/
def jsonStringify (s : String) : String :=
  String.ofList ('"' :: s.toList.flatMap jsonQuoteChar ++ ['"'])

/-- `encodeCctActionValue({ mode, payload })` (lines 77-92). `.ok` is the returned string,
`.error` the message of the thrown `Error`. `mode` and `payload` are strings here, so the
`typeof payload !== 'string'` disjunct of line 82 is false and is left out; the conformance
test covers it by passing non-string payloads to the TS. -/
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

/-- `tail.indexOf(SEP)` (line 117) as a character position in `tail`, `none` for `-1`. See the
module note on code units. -/
def indexOfSep : List Char → Option Nat
  | [] => none
  | c :: cs => if c == SEP then some 0 else (indexOfSep cs).map (· + 1)

/-- `decodeCctActionValue(raw)` (lines 109-128). -/
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

/-- `readCctActionPayload(raw)` (lines 138-142); `none` is `null`. -/
def readCctActionPayload (raw : RawValue) : Option String :=
  -- line 139
  match decodeCctActionValue raw with
  -- line 140
  | .invalid _ => none
  -- line 141
  | .tagged _ payload => some payload
  | .legacy payload => some payload

end SomaVerify.CctActionValue
