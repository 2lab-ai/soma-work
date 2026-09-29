/-!
# JavaScript string semantics used by module models

ECMA-262 (15th edition, ES2024) section 6.1.4 defines a JS string as a sequence of UTF-16 code
units. A Lean `String` is a sequence of Unicode scalar values, so it denotes exactly the
well-formed JS strings (no lone surrogates). Every definition below works on `String.toList`
and cites the clause it models.

These definitions are part of the trusted model, so they are tested as well as proved about:
`SomaVerify/JsString/Vectors.lean` generates `verification/vectors/js-string.json`, and
`scripts/verification/__tests__/js-string.lean-conformance.test.ts` replays it against the
engine's own `.length`, `.trim()` and `.startsWith()`.
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

/-- The white space `String.prototype.trim` removes, in code point order. ECMA-262 section
22.1.3.32.1 (TrimString) defines it as the union of WhiteSpace and LineTerminator:

* WhiteSpace, section 12.2 Table 36: U+0009, U+000B, U+000C, U+FEFF, and general category
  Space_Separator (U+0020, U+00A0, U+1680, U+2000..U+200A, U+202F, U+205F, U+3000);
* LineTerminator, section 12.3 Table 37: U+000A, U+000D, U+2028, U+2029. -/
def jsWhitespaceCodePoints : List Nat :=
  [0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680,
   0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
   0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]

/-- JS white space, as `jsWhitespaceCodePoints`. This is neither Lean's `Char.isWhitespace`
(space, tab, CR and LF only) nor Unicode's White_Space property (which includes U+0085 and
excludes U+FEFF). -/
def jsIsWhitespace (c : Char) : Bool :=
  jsWhitespaceCodePoints.contains c.toNat

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

/-! ## Length -/

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

/-! ## White space -/

/-- Twenty-five distinct code points: Tables 36 and 37 plus Space_Separator. -/
theorem jsWhitespaceCodePoints_spec :
    jsWhitespaceCodePoints.length = 25 ∧ jsWhitespaceCodePoints.Nodup := by
  decide

theorem jsIsWhitespace_iff (c : Char) :
    jsIsWhitespace c = true ↔ c.toNat ∈ jsWhitespaceCodePoints := by
  simp [jsIsWhitespace]

/-- Pinned exclusions, the places a hand-written white-space set usually goes wrong:
U+0085 NEXT LINE has Unicode White_Space but is not ECMAScript white space (section 12.2,
Note 2); U+180E MONGOLIAN VOWEL SEPARATOR left Space_Separator in Unicode 6.3; U+200B ZERO WIDTH
SPACE was never Space_Separator. -/
theorem jsIsWhitespace_exclusions :
    jsIsWhitespace '\u0085' = false ∧ jsIsWhitespace '\u180E' = false ∧
      jsIsWhitespace '\u200B' = false := by
  decide

/-- Pinned inclusions from outside Space_Separator: U+FEFF (Table 36) and U+2028 (Table 37). -/
theorem jsIsWhitespace_inclusions :
    jsIsWhitespace '\uFEFF' = true ∧ jsIsWhitespace '\u2028' = true := by
  decide

/-! ## Trim

Together, `jsTrim_decomposition`, `jsTrim_no_leading_whitespace` and
`jsTrim_no_trailing_whitespace` pin TrimString down completely: the result is the input with a
white-space prefix and a white-space suffix removed, and neither end of the result is white
space, so the removed runs are the maximal ones. -/

/-- Every element `takeWhile p` keeps satisfies `p`. -/
theorem all_takeWhile {α : Type} (p : α → Bool) :
    ∀ (l : List α), ∀ c ∈ l.takeWhile p, p c = true
  | [] => by simp
  | x :: xs => by
    intro c hc
    rw [List.takeWhile_cons] at hc
    split at hc
    · rcases List.mem_cons.mp hc with rfl | hc
      · assumption
      · exact all_takeWhile p xs c hc
    · simp at hc

/-- A list whose first element, if any, fails `p` is unchanged by `dropWhile p`. -/
theorem dropWhile_eq_self {α : Type} {p : α → Bool} {l : List α}
    (h : ∀ c, l.head? = some c → p c = false) : l.dropWhile p = l := by
  cases l with
  | nil => rfl
  | cons x xs => exact List.dropWhile_cons_of_neg (by simp [h x rfl])

theorem jsTrimList_eq (cs : List Char) :
    jsTrimList cs = ((cs.dropWhile jsIsWhitespace).reverse.dropWhile jsIsWhitespace).reverse :=
  rfl

theorem jsTrimList_decomposition (cs : List Char) :
    ∃ pre suf, cs = pre ++ jsTrimList cs ++ suf ∧
      (∀ c ∈ pre, jsIsWhitespace c = true) ∧ (∀ c ∈ suf, jsIsWhitespace c = true) := by
  refine ⟨cs.takeWhile jsIsWhitespace,
    ((cs.dropWhile jsIsWhitespace).reverse.takeWhile jsIsWhitespace).reverse, ?_, ?_, ?_⟩
  · have back := congrArg List.reverse
      (List.takeWhile_append_dropWhile (p := jsIsWhitespace)
        (l := (cs.dropWhile jsIsWhitespace).reverse))
    rw [List.reverse_append, List.reverse_reverse] at back
    rw [jsTrimList_eq, List.append_assoc, back, List.takeWhile_append_dropWhile]
  · exact all_takeWhile _ _
  · intro c hc
    exact all_takeWhile _ _ c (List.mem_reverse.mp hc)

theorem jsTrimList_head? (cs : List Char) :
    ∀ c, (jsTrimList cs).head? = some c → jsIsWhitespace c = false := by
  intro c h
  rw [jsTrimList_eq, List.head?_reverse] at h
  have split := List.takeWhile_append_dropWhile (p := jsIsWhitespace)
    (l := (cs.dropWhile jsIsWhitespace).reverse)
  have last : ((cs.dropWhile jsIsWhitespace).reverse).getLast? = some c := by
    rw [← split, List.getLast?_append, h]
    rfl
  rw [List.getLast?_reverse] at last
  have first := List.head?_dropWhile_not jsIsWhitespace cs
  rw [last] at first
  exact first

theorem jsTrimList_getLast? (cs : List Char) :
    ∀ c, (jsTrimList cs).getLast? = some c → jsIsWhitespace c = false := by
  intro c h
  rw [jsTrimList_eq, List.getLast?_reverse] at h
  have first := List.head?_dropWhile_not jsIsWhitespace (cs.dropWhile jsIsWhitespace).reverse
  rw [h] at first
  exact first

theorem jsTrimList_idempotent (cs : List Char) : jsTrimList (jsTrimList cs) = jsTrimList cs := by
  have front : (jsTrimList cs).dropWhile jsIsWhitespace = jsTrimList cs :=
    dropWhile_eq_self (jsTrimList_head? cs)
  have back : (jsTrimList cs).reverse.dropWhile jsIsWhitespace = (jsTrimList cs).reverse :=
    dropWhile_eq_self fun c hc => jsTrimList_getLast? cs c (by rwa [List.head?_reverse] at hc)
  rw [jsTrimList_eq (jsTrimList cs), front, back, List.reverse_reverse]

theorem jsTrim_empty : jsTrim "" = "" := by
  simp [jsTrim, jsTrimList]

/-- Trimming twice is trimming once. -/
theorem jsTrim_idempotent (s : String) : jsTrim (jsTrim s) = jsTrim s := by
  simp only [jsTrim, String.toList_ofList, jsTrimList_idempotent]

/-- The input is a white-space prefix, then `jsTrim s`, then a white-space suffix. -/
theorem jsTrim_decomposition (s : String) :
    ∃ pre suf, s.toList = pre ++ (jsTrim s).toList ++ suf ∧
      (∀ c ∈ pre, jsIsWhitespace c = true) ∧ (∀ c ∈ suf, jsIsWhitespace c = true) := by
  simpa only [jsTrim, String.toList_ofList] using jsTrimList_decomposition s.toList

/-- `jsTrim s` does not start with white space. -/
theorem jsTrim_no_leading_whitespace (s : String) :
    ∀ c, (jsTrim s).toList.head? = some c → jsIsWhitespace c = false := by
  simpa only [jsTrim, String.toList_ofList] using jsTrimList_head? s.toList

/-- `jsTrim s` does not end with white space. -/
theorem jsTrim_no_trailing_whitespace (s : String) :
    ∀ c, (jsTrim s).toList.getLast? = some c → jsIsWhitespace c = false := by
  simpa only [jsTrim, String.toList_ofList] using jsTrimList_getLast? s.toList

/-! ## startsWith -/

/-- Step "If searchLength = 0, return true" of section 22.1.3.24. -/
theorem jsStartsWith_empty (s : String) : jsStartsWith s "" = true := by
  simp [jsStartsWith]

/-- `jsStartsWith s t` holds exactly when `s` is `t` followed by something. -/
theorem jsStartsWith_iff (s t : String) :
    jsStartsWith s t = true ↔ ∃ rest, s.toList = t.toList ++ rest := by
  rw [jsStartsWith, List.isPrefixOf_iff_prefix]
  constructor
  · rintro ⟨rest, h⟩
    exact ⟨rest, h.symm⟩
  · rintro ⟨rest, h⟩
    exact ⟨rest, h.symm⟩

end SomaVerify.JsString
