/-!
# Minimal JSON values and a deterministic compact serializer

Just enough JSON for the conformance-vector generators (`SomaVerify/<Module>/Vectors.lean`).

Rendering is compact (no insignificant whitespace) and keeps object fields in the order given,
so the text is a pure function of the value. Strings are escaped per RFC 8259 section 7: the
quotation mark, the reverse solidus and the control characters U+0000..U+001F are escaped
(controls as lower-case `\u00xx`); every other character is emitted as itself, i.e. as raw
UTF-8 in the output file.
-/

namespace SomaVerify

/-- A JSON value. Numbers are integers only: nothing a vector records is fractional. Object
fields are an ordered list, so rendering never depends on a map's iteration order. -/
inductive Json where
  | null
  | bool (b : Bool)
  | num (n : Int)
  | str (s : String)
  | arr (items : List Json)
  | obj (fields : List (String × Json))
  deriving Inhabited

namespace Json

/-- RFC 8259 section 7: the characters that must not appear unescaped inside a string. -/
def mustEscape (c : Char) : Bool :=
  c == '"' || c == '\\' || c.toNat < 0x20

/-- Lower-case hexadecimal digit of `n`, for `n < 16`. -/
def hexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat (0x30 + n) else Char.ofNat (0x61 + (n - 10))

/-- One character as it appears inside a JSON string literal. -/
def escapeChar (c : Char) : List Char :=
  if c == '"' then ['\\', '"']
  else if c == '\\' then ['\\', '\\']
  else if c.toNat < 0x20 then ['\\', 'u', '0', '0', hexDigit (c.toNat / 16), hexDigit (c.toNat % 16)]
  else [c]

/-- `escapeChar` over a character list. -/
def escapeList : List Char → List Char
  | [] => []
  | c :: cs => escapeChar c ++ escapeList cs

/-- The body of the JSON string literal for `s`, without the surrounding quotes. -/
def escapeString (s : String) : String :=
  String.ofList (escapeList s.toList)

/-- `s` as a JSON string literal. -/
def quote (s : String) : String :=
  "\"" ++ escapeString s ++ "\""

mutual
/-- Compact rendering: no whitespace between tokens, array items and object fields in list
order. -/
def render : Json → String
  | .null => "null"
  | .bool true => "true"
  | .bool false => "false"
  | .num n => toString n
  | .str s => quote s
  | .arr items => "[" ++ renderItems items ++ "]"
  | .obj fields => "{" ++ renderFields fields ++ "}"

/-- Comma-separated array items. -/
def renderItems : List Json → String
  | [] => ""
  | [j] => render j
  | j :: rest => render j ++ "," ++ renderItems rest

/-- Comma-separated `"key":value` object fields. -/
def renderFields : List (String × Json) → String
  | [] => ""
  | [(k, v)] => quote k ++ ":" ++ render v
  | (k, v) :: rest => quote k ++ ":" ++ render v ++ "," ++ renderFields rest
end

theorem escapeChar_of_mustEscape_false {c : Char} (h : mustEscape c = false) :
    escapeChar c = [c] := by
  simp only [mustEscape, Bool.or_eq_false_iff, beq_eq_false_iff_ne, ne_eq,
    decide_eq_false_iff_not, Nat.not_lt] at h
  obtain ⟨⟨hq, hb⟩, hc⟩ := h
  simp [escapeChar, hq, hb, Nat.not_lt.mpr hc]

theorem escapeList_append (xs ys : List Char) :
    escapeList (xs ++ ys) = escapeList xs ++ escapeList ys := by
  induction xs with
  | nil => rfl
  | cons c cs ih => simp [escapeList, ih]

theorem escapeList_of_mustEscape_false {cs : List Char} (h : ∀ c ∈ cs, mustEscape c = false) :
    escapeList cs = cs := by
  induction cs with
  | nil => rfl
  | cons c cs ih =>
    simp only [List.mem_cons, forall_eq_or_imp] at h
    simp [escapeList, escapeChar_of_mustEscape_false h.1, ih h.2]

/-- A string containing nothing RFC 8259 requires to be escaped is emitted verbatim. -/
theorem escapeString_of_mustEscape_false {s : String}
    (h : ∀ c ∈ s.toList, mustEscape c = false) : escapeString s = s := by
  simp [escapeString, escapeList_of_mustEscape_false h]

/-- Every hexadecimal digit the escaper can emit is a printable ASCII character. -/
theorem hexDigit_printable : ∀ n, n < 16 → 0x30 ≤ (hexDigit n).toNat ∧ (hexDigit n).toNat < 0x80 := by
  decide

/-- The escaped text never contains a raw control character (RFC 8259 section 7 forbids them
inside a string), whatever the input. -/
theorem escapeList_no_control (cs : List Char) : ∀ c ∈ escapeList cs, 0x20 ≤ c.toNat := by
  induction cs with
  | nil => simp [escapeList]
  | cons x xs ih =>
    intro c hc
    simp only [escapeList, List.mem_append] at hc
    rcases hc with hx | hrest
    · unfold escapeChar at hx
      split at hx
      · simp at hx; rcases hx with rfl | rfl <;> decide
      · split at hx
        · simp at hx; rcases hx with rfl | rfl <;> decide
        · split at hx
          · rename_i hlt
            have hi : x.toNat / 16 < 16 := by omega
            have hj : x.toNat % 16 < 16 := Nat.mod_lt _ (by decide)
            have h1 := (hexDigit_printable _ hi).1
            have h2 := (hexDigit_printable _ hj).1
            simp at hx
            rcases hx with rfl | rfl | rfl | rfl | rfl | rfl
            all_goals first | decide | omega
          · rename_i hge
            simp at hx
            subst hx
            omega
    · exact ih c hrest

/-- A worked example, checked by the kernel: quote, reverse solidus and a newline. -/
theorem escapeString_example : escapeString "a\"b\\c\n" = "a\\\"b\\\\c\\u000a" := by
  decide

end Json
end SomaVerify
