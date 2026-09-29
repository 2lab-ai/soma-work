import SomaVerify.Support.Json
import SomaVerify.Support.JsString
import SomaVerify.Support.Vectors

/-!
# Conformance vectors for `SomaVerify.Support.JsString`

Every string of length 0..3 over a ten-character alphabet, with the model's `utf16Length` and
`jsTrim` for each. `scripts/verification/__tests__/js-string.lean-conformance.test.ts` replays
them against the engine's own `.length` and `.trim()`.

Run by `scripts/verification/lean-verify.sh` (`lake env lean --run`); the output is
`verification/vectors/js-string.json`.
-/

namespace SomaVerify.JsString.Vectors

open SomaVerify SomaVerify.JsString

/-- ASCII letters, ASCII white space (space, tab, LF), U+00A0 NO-BREAK SPACE, U+FEFF ZERO WIDTH
NO-BREAK SPACE, U+2028 LINE SEPARATOR, U+3000 IDEOGRAPHIC SPACE and U+1F600 (outside the BMP,
so a surrogate pair in JS). Written as escapes so no invisible character depends on an
editor; deduplicated so the inputs below are distinct. -/
def alphabet : List Char :=
  ['a', ' ', '\t', '\n', ' ', '﻿', ' ', '　', Char.ofNat 0x1F600, 'b'].eraseDups

/-- Deduplication removed nothing, and `Char.ofNat 0x1F600` is the intended scalar value (an
invalid code point would have silently become U+0000). -/
theorem alphabet_spec :
    alphabet.length = 10 ∧ (Char.ofNat 0x1F600).toNat = 0x1F600 := by
  decide

/-- All strings of exactly `n` characters over `alphabet`, ordered by alphabet position. -/
def wordsOfLength : Nat → List (List Char)
  | 0 => [[]]
  | n + 1 => (wordsOfLength n).flatMap fun w => alphabet.map fun c => w ++ [c]

/-- Every string of length 0..3 over `alphabet`, shortest first. -/
def inputs : List String :=
  (List.range 4).flatMap fun n => (wordsOfLength n).map String.ofList

/-- One vector: the input and what the model says JS returns for it. -/
def case (s : String) : Json :=
  .obj [("input", .str s),
        ("expect", .obj [("length", .num (utf16Length s)), ("trim", .str (jsTrim s))])]

/-- The cases written to `verification/vectors/js-string.json`. -/
def cases : List Json :=
  inputs.map case

end SomaVerify.JsString.Vectors

def main : IO Unit :=
  IO.print (SomaVerify.Vectors.render "js-string" ``SomaVerify.JsString.Vectors.cases
    SomaVerify.JsString.Vectors.cases)
