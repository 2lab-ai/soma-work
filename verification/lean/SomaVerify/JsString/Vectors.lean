import SomaVerify.Support.Json
import SomaVerify.Support.JsString
import SomaVerify.Support.Vectors

/-!
# Conformance vectors for `SomaVerify.Support.JsString`

Each case is one call, `{"fn":<name>,"args":[...],"expect":<model result>}`, and
`scripts/verification/__tests__/js-string.lean-conformance.test.ts` replays it against the
engine's own `String.prototype` method of that name. Three families:

1. `length` and `trim` on every string of length 0..3 over `alphabet`;
2. `length` and `trim` on a sweep of single code points (every white-space code point, the pinned
   exclusions, a few other non-ASCII scalars), alone and embedded as `a<c>b` and `<c>a<c>`;
3. `startsWith` on every pair of strings of length 0..2 over `prefixAlphabet`.

Run by `scripts/verification/lean-verify.sh` (`lake env lean --run`); the output is
`verification/vectors/js-string.json`. Non-ASCII characters are written as `\u` escapes, or as
`Char.ofNat` above U+FFFF, where Lean has no escape.
-/

namespace SomaVerify.JsString.Vectors

open SomaVerify SomaVerify.JsString

/-- ASCII letters, ASCII white space (space, tab, LF), U+00A0 NO-BREAK SPACE, U+FEFF ZERO WIDTH
NO-BREAK SPACE, U+2028 LINE SEPARATOR, U+3000 IDEOGRAPHIC SPACE and U+1F600, a surrogate pair
in JS. -/
def alphabet : List Char :=
  ['a', ' ', '\t', '\n', '\u00A0', '\uFEFF', '\u2028', '\u3000', Char.ofNat 0x1F600,
    'b']

/-- Code points swept one at a time: every white-space code point, the pinned exclusions
(U+0085, U+180E, U+200B), and non-white-space scalars from Latin-1, CJK and beyond the BMP. -/
def sweepCodePoints : List Nat :=
  jsWhitespaceCodePoints ++ [0x0085, 0x180E, 0x200B] ++ [0x00E9, 0x4E2D, 0x1F600]

/-- The sweep minus the characters `alphabet` already covers: those appear alone and embedded
among the strings of length 0..3, and a repeated case would add nothing. -/
def sweepChars : List Char :=
  (sweepCodePoints.map Char.ofNat).filter fun c => !alphabet.contains c

/-- For `startsWith`: two letters and two scalars whose UTF-16 encodings share their first code
unit (U+1F600 is D83D DE00, U+1F601 is D83D DE01), so a comparison that stops after one code
unit is caught. -/
def prefixAlphabet : List Char :=
  ['a', 'b', Char.ofNat 0x1F600, Char.ofNat 0x1F601]

/-- No alphabet repeats a character, and every code point above is a Unicode scalar value, so
`Char.ofNat` keeps it (an invalid one would silently become U+0000). -/
theorem alphabets_spec :
    alphabet.length = 10 ∧ alphabet.Nodup ∧ sweepCodePoints.Nodup ∧ prefixAlphabet.Nodup ∧
      (sweepCodePoints ++ [0x1F601]).all (fun n => (Char.ofNat n).toNat == n) = true := by
  decide

/-- All strings of exactly `n` characters over `chars`, ordered by position in `chars`. -/
def wordsOfLength (chars : List Char) : Nat → List (List Char)
  | 0 => [[]]
  | n + 1 => (wordsOfLength chars n).flatMap fun w => chars.map fun c => w ++ [c]

/-- All strings of length 0..`n` over `chars`, shortest first. -/
def wordsUpTo (chars : List Char) (n : Nat) : List String :=
  (List.range (n + 1)).flatMap fun k => (wordsOfLength chars k).map String.ofList

/-- Inputs for `length` and `trim`: the exhaustive family, then the sweep. -/
def unaryInputs : List String :=
  wordsUpTo alphabet 3 ++
    sweepChars.flatMap fun c =>
      [String.ofList [c], String.ofList ['a', c, 'b'], String.ofList [c, 'a', c]]

/-- One call of `fn` on `args`, and the model's result. -/
def call (fn : String) (args : List String) (result : Json) : Json :=
  .obj [("fn", .str fn), ("args", .arr (args.map fun a => .str a)), ("expect", result)]

/-- The cases written to `verification/vectors/js-string.json`. -/
def cases : List Json :=
  (unaryInputs.flatMap fun s =>
      [call "length" [s] (.num (utf16Length s)), call "trim" [s] (.str (jsTrim s))]) ++
    ((wordsUpTo prefixAlphabet 2).flatMap fun s =>
      (wordsUpTo prefixAlphabet 2).map fun t =>
        call "startsWith" [s, t] (.bool (jsStartsWith s t)))

end SomaVerify.JsString.Vectors

def main : IO Unit :=
  IO.print (SomaVerify.Vectors.render "js-string" ``SomaVerify.JsString.Vectors.cases
    SomaVerify.JsString.Vectors.cases)
