/-!
# JavaScript string semantics used by module models

ECMA-262 (15th edition, ES2024) section 6.1.4 defines a JS string as a sequence of UTF-16 code
units. A Lean `String` is a sequence of Unicode scalar values, so it denotes exactly the
well-formed JS strings (no lone surrogates). Every definition below works on `String.toList`
and cites the clause it models.

These definitions are part of the trusted model, so they are tested as well as proved about:
`SomaVerify/JsString/Vectors.lean` generates `verification/vectors/js-string.json`, and
`scripts/verification/__tests__/js-string.lean-conformance.test.ts` replays it against the
engine's own `.length` and `.trim()`.
-/

namespace SomaVerify.JsString

/-- Code units one scalar value occupies in UTF-16: 2 above U+FFFF (a surrogate pair), else 1.
ECMA-262 section 11.1.1, Static Semantics: UTF16EncodeCodePoint. -/
def utf16Units (c : Char) : Nat :=
  if c.toNat > 0xFFFF then 2 else 1

/-- `utf16Units` summed over a character list. -/
def utf16LengthList : List Char → Nat
  | [] => 0
  | c :: cs => utf16Units c + utf16LengthList cs

/-- JS `s.length`: ECMA-262 section 22.1.4.1 (`length` of String instances) is "the number of
elements in the String value", and by section 6.1.4 the elements are UTF-16 code units. A
scalar value above U+FFFF therefore counts 2. -/
def utf16Length (s : String) : Nat :=
  utf16LengthList s.toList

/-- The white space `String.prototype.trim` removes. ECMA-262 section 22.1.3.32.1 (TrimString)
defines it as the union of WhiteSpace and LineTerminator:

* WhiteSpace, section 12.2 Table 36: U+0009, U+000B, U+000C, U+FEFF, and general category
  Space_Separator (U+0020, U+00A0, U+1680, U+2000..U+200A, U+202F, U+205F, U+3000);
* LineTerminator, section 12.3 Table 37: U+000A, U+000D, U+2028, U+2029.

This is neither Lean's `Char.isWhitespace` (space, tab, CR and LF only) nor Unicode's
White_Space property (which includes U+0085 and excludes U+FEFF). -/
def jsIsWhitespace (c : Char) : Bool :=
  let n := c.toNat
  n == 0x0009 || n == 0x000A || n == 0x000B || n == 0x000C || n == 0x000D ||
  n == 0x0020 || n == 0x00A0 || n == 0x1680 ||
  (decide (0x2000 ≤ n) && decide (n ≤ 0x200A)) ||
  n == 0x2028 || n == 0x2029 || n == 0x202F || n == 0x205F || n == 0x3000 || n == 0xFEFF

/-- TrimString with `where = start+end` on a character list: drop leading, then trailing,
white space. -/
def jsTrimList (cs : List Char) : List Char :=
  ((cs.dropWhile jsIsWhitespace).reverse.dropWhile jsIsWhitespace).reverse

/-- JS `s.trim()`: ECMA-262 section 22.1.3.32 (String.prototype.trim) returns
TrimString(S, start+end) (section 22.1.3.32.1), "a copy of S with both leading and trailing
white space removed", white space being `jsIsWhitespace`. Every white-space code point is in
the BMP, so removing whole scalar values removes exactly the code units the engine removes. -/
def jsTrim (s : String) : String :=
  String.ofList (jsTrimList s.toList)

/-- JS `s.startsWith(searchString)` with `position` omitted: ECMA-262 section 22.1.3.24
(String.prototype.startsWith) is true iff the code units of `searchString` equal the first code
units of `s`. For well-formed strings that is a character-list prefix test, because a
well-formed `searchString` cannot end inside a surrogate pair. -/
def jsStartsWith (s searchString : String) : Bool :=
  searchString.toList.isPrefixOf s.toList

theorem utf16Units_pos (c : Char) : 0 < utf16Units c := by
  unfold utf16Units
  split <;> decide

theorem utf16LengthList_eq_zero_iff (cs : List Char) : utf16LengthList cs = 0 ↔ cs = [] := by
  cases cs with
  | nil => simp [utf16LengthList]
  | cons c cs =>
    have := utf16Units_pos c
    simp [utf16LengthList]
    omega

/-- Only the empty string has JS length 0. -/
theorem utf16Length_eq_zero_iff (s : String) : utf16Length s = 0 ↔ s = "" := by
  rw [utf16Length, utf16LengthList_eq_zero_iff, String.toList_eq_nil_iff]

theorem utf16LengthList_append (xs ys : List Char) :
    utf16LengthList (xs ++ ys) = utf16LengthList xs + utf16LengthList ys := by
  induction xs with
  | nil => simp [utf16LengthList]
  | cons c cs ih => simp [utf16LengthList, ih]; omega

/-- JS length is additive over concatenation. -/
theorem utf16Length_append (s t : String) :
    utf16Length (s ++ t) = utf16Length s + utf16Length t := by
  simp [utf16Length, String.toList_append, utf16LengthList_append]

theorem jsTrim_empty : jsTrim "" = "" := by
  simp [jsTrim, jsTrimList]

theorem jsTrim_isEmpty_of_eq_empty {s : String} (h : s = "") : (jsTrim s).isEmpty = true := by
  subst h
  simp [jsTrim_empty]

/-- Step "If searchLength = 0, return true" of section 22.1.3.24. -/
theorem jsStartsWith_empty (s : String) : jsStartsWith s "" = true := by
  simp [jsStartsWith]

/-- Pinned exclusions, the places a hand-written white-space set usually goes wrong:
U+0085 NEXT LINE has Unicode White_Space but is not ECMAScript white space (section 12.2,
Note 2); U+180E MONGOLIAN VOWEL SEPARATOR left Space_Separator in Unicode 6.3; U+200B ZERO WIDTH
SPACE was never Space_Separator. -/
theorem jsIsWhitespace_exclusions :
    jsIsWhitespace '\u0085' = false ∧ jsIsWhitespace '᠎' = false ∧
      jsIsWhitespace '​' = false := by
  decide

/-- Pinned inclusions from outside Space_Separator: U+FEFF (Table 36) and U+2028 (Table 37). -/
theorem jsIsWhitespace_inclusions :
    jsIsWhitespace '﻿' = true ∧ jsIsWhitespace ' ' = true := by
  decide

end SomaVerify.JsString
