import SomaVerify.CctActionValue.Model
import SomaVerify.CctActionValue.Spec

/-!
# Proofs of the CCT button-value codec's invariants

Every proposition of `Spec.lean` is proved here under its name in snake case; the lemmas before
them take the model apart. Line numbers refer to `packages/slack/src/cct/action-value.ts`.
Everything rests on the standard axioms only (checked by `scripts/verification/lean-verify.sh`).
-/

namespace SomaVerify.CctActionValue.Proofs

open SomaVerify.JsString SomaVerify.CctActionValue SomaVerify.CctActionValue.Spec

/-! ## Facts about the constants and JS strings -/

/-- `PREFIX` is the three characters `c`, `m`, `:`. -/
theorem PREFIX_toList : PREFIX.toList = ['c', 'm', ':'] := by
  decide

/-- `PREFIX` has three characters. -/
theorem PREFIX_length : PREFIX.length = 3 := by
  decide

/-- `PREFIX` is ASCII, so its JS length equals its character count: the model's
`raw.toList.drop PREFIX.length` drops what `raw.slice(PREFIX.length)` (line 116) drops. -/
theorem utf16Length_PREFIX : utf16Length PREFIX = PREFIX.length := by
  decide

/-- The characters of the wire form: `c m :`, the mode, `|`, the payload. -/
theorem wire_toList (mode payload : String) :
    (wire mode payload).toList = 'c' :: 'm' :: ':' :: (mode.toList ++ SEP :: payload.toList) := by
  simp [wire, String.toList_append, PREFIX_toList]

/-- `dropWhile` removes everything exactly when every element satisfies the predicate. -/
theorem dropWhile_eq_nil_iff {p : Char → Bool} {l : List Char} :
    l.dropWhile p = [] ↔ ∀ c ∈ l, p c = true := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    rw [List.dropWhile_cons]
    by_cases hx : p x = true
    · simp [hx, ih]
    · simp [hx]

/-- If everything `dropWhile` leaves satisfies the predicate, so does the whole list (what it
leaves would otherwise start with an element that fails it). -/
theorem all_of_all_dropWhile {p : Char → Bool} {l : List Char}
    (h : ∀ c ∈ l.dropWhile p, p c = true) : ∀ c ∈ l, p c = true := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    rw [List.dropWhile_cons] at h
    by_cases hx : p x = true
    · simp only [hx, ite_true] at h
      intro c hc
      rcases List.mem_cons.mp hc with rfl | hc
      · exact hx
      · exact ih h c hc
    · simp only [hx, Bool.false_eq_true, ite_false] at h
      exact absurd (h x List.mem_cons_self) hx

/-- Trimming leaves nothing exactly when every character is JS white space. -/
theorem jsTrimList_eq_nil_iff (cs : List Char) :
    jsTrimList cs = [] ↔ ∀ c ∈ cs, jsIsWhitespace c = true := by
  unfold jsTrimList
  rw [List.reverse_eq_nil_iff, dropWhile_eq_nil_iff]
  constructor
  · intro h
    apply all_of_all_dropWhile
    intro c hc
    exact h c (List.mem_reverse.mpr hc)
  · intro h c hc
    exact h c ((List.dropWhile_suffix _).subset (List.mem_reverse.mp hc))

/-- `s.trim()` is empty exactly when every character of `s` is JS white space: a string
starting with a letter, such as every `cm:` value, never trims to empty. -/
theorem jsTrim_eq_empty_iff (s : String) :
    jsTrim s = "" ↔ ∀ c ∈ s.toList, jsIsWhitespace c = true := by
  rw [jsTrim, String.ofList_eq_empty_iff, jsTrimList_eq_nil_iff]

/-- Lines 82 and 111 share the test `x.length === 0 || x.trim().length === 0`. Its first
disjunct is redundant, because the empty string trims to the empty string: the test and its
second disjunct are the same Boolean for every string. -/
theorem redundant_length_disjunct (s : String) :
    (utf16Length s == 0 || utf16Length (jsTrim s) == 0) = (utf16Length (jsTrim s) == 0) := by
  by_cases h : s = ""
  · subst h
    simp [jsTrim_empty]
  · have : (utf16Length s == 0) = false := by
      simp [utf16Length_eq_zero_iff, h]
    simp [this]

/-- The test of lines 82 and 111 holds exactly when the string trims to empty ("empty /
whitespace-only"). -/
theorem blank_iff (s : String) :
    (utf16Length s == 0 || utf16Length (jsTrim s) == 0) = true ↔ jsTrim s = "" := by
  rw [redundant_length_disjunct]
  simp [utf16Length_eq_zero_iff]

/-- `VALID_MODES.has(m)` is membership. -/
theorem contains_VALID_MODES (m : String) : VALID_MODES.contains m = true ↔ m ∈ VALID_MODES :=
  List.contains_iff_mem

/-- The valid modes are `admin` and `readonly`. -/
theorem mem_VALID_MODES (m : String) : m ∈ VALID_MODES ↔ m = "admin" ∨ m = "readonly" := by
  simp [VALID_MODES]

/-- No valid mode contains `|`, so the first `|` of a wire form ends the mode. -/
theorem SEP_not_mem_of_valid {m : String} (h : m ∈ VALID_MODES) : SEP ∉ m.toList := by
  rw [mem_VALID_MODES] at h
  rcases h with rfl | rfl <;> decide

/-- No valid mode is empty. -/
theorem ne_empty_of_valid {m : String} (h : m ∈ VALID_MODES) : m ≠ "" := by
  rw [mem_VALID_MODES] at h
  rcases h with rfl | rfl <;> decide

/-- `indexOf('|')` is `-1` exactly when there is no `|`. -/
theorem indexOfSep_eq_none_iff (l : List Char) : indexOfSep l = none ↔ SEP ∉ l := by
  induction l with
  | nil => simp [indexOfSep]
  | cons c cs ih =>
    by_cases hc : c = SEP
    · subst hc
      simp [indexOfSep]
    · simp [indexOfSep, hc, ih, Ne.symm hc]

/-- `indexOf('|')` finds the first `|`: after a stretch without one, it is the length of that
stretch. -/
theorem indexOfSep_append (xs ys : List Char) (h : SEP ∉ xs) :
    indexOfSep (xs ++ SEP :: ys) = some xs.length := by
  induction xs with
  | nil => simp [indexOfSep]
  | cons c cs ih =>
    have hc : c ≠ SEP := fun e => h (e ▸ List.mem_cons_self)
    have hcs : SEP ∉ cs := fun e => h (List.mem_cons_of_mem _ e)
    simp [indexOfSep, hc, ih hcs]

/-- Where `indexOf('|')` points there is a `|`: the list is the part before it, `|`, and the part
after it (the two slices of lines 122-123). -/
theorem indexOfSep_eq_some {l : List Char} {i : Nat} (h : indexOfSep l = some i) :
    l = l.take i ++ SEP :: l.drop (i + 1) := by
  induction l generalizing i with
  | nil => simp [indexOfSep] at h
  | cons c cs ih =>
    by_cases hc : c = SEP
    · subst hc
      simp [indexOfSep] at h
      subst h
      simp
    · simp [indexOfSep, hc] at h
      obtain ⟨j, hj, rfl⟩ := h
      simp [← ih hj]

/-! ## The decoder, branch by branch -/

/-- On a string that starts with `cm:`, the decoder passes lines 111 and 112 and runs lines
116-127 on the rest of the string. -/
theorem decode_str_of_prefixed {s : String} {t : List Char}
    (hs : s.toList = 'c' :: 'm' :: ':' :: t) :
    decodeCctActionValue (.str s) =
      match indexOfSep t with
      | none => .invalid (.str s)
      | some i =>
        if utf16Length (String.ofList (t.take i)) == 0 then .invalid (.str s)
        else if utf16Length (String.ofList (t.drop (i + 1))) == 0 then .invalid (.str s)
        else if !VALID_MODES.contains (String.ofList (t.take i)) then .invalid (.str s)
        else .tagged (String.ofList (t.take i)) (String.ofList (t.drop (i + 1))) := by
  have hne : jsTrim s ≠ "" := by
    rw [ne_eq, jsTrim_eq_empty_iff, hs]
    intro h
    exact absurd (h 'c' List.mem_cons_self) (by decide)
  have hblank : (utf16Length s == 0 || utf16Length (jsTrim s) == 0) = false := by
    rw [Bool.eq_false_iff]
    intro h
    exact hne ((blank_iff s).mp h)
  have hstart : jsStartsWith s PREFIX = true := by
    simp [jsStartsWith, hs, PREFIX_toList]
  have htail : s.toList.drop PREFIX.length = t := by
    rw [hs, PREFIX_length]
    rfl
  simp only [decodeCctActionValue, hblank, hstart, htail, Bool.false_eq_true, ite_false,
    Bool.not_true]
  cases indexOfSep t <;> rfl

/-- On the wire form of a mode without `|`, the decoder splits at the separator after the mode
and applies lines 124-126 to that mode and payload. -/
theorem decode_wire (mode payload : String) (hm : SEP ∉ mode.toList) :
    decodeCctActionValue (.str (wire mode payload)) =
      if utf16Length mode == 0 then .invalid (.str (wire mode payload))
      else if utf16Length payload == 0 then .invalid (.str (wire mode payload))
      else if !VALID_MODES.contains mode then .invalid (.str (wire mode payload))
      else .tagged mode payload := by
  rw [decode_str_of_prefixed (wire_toList mode payload), indexOfSep_append _ _ hm]
  simp [String.ofList_toList]

/-- The wire form of a valid mode and a non-empty payload decodes to that mode and payload,
whatever the payload contains. -/
theorem decode_wire_valid {mode payload : String} (hm : mode ∈ VALID_MODES)
    (hp : payload ≠ "") :
    decodeCctActionValue (.str (wire mode payload)) = .tagged mode payload := by
  rw [decode_wire _ _ (SEP_not_mem_of_valid hm)]
  have h1 : (utf16Length mode == 0) = false := by
    simp [utf16Length_eq_zero_iff, ne_empty_of_valid hm]
  have h2 : (utf16Length payload == 0) = false := by
    simp [utf16Length_eq_zero_iff, hp]
  simp [h1, h2, hm]

/-- Line 111: a string that trims to empty (the empty string included) is invalid. -/
theorem decode_blank {s : String} (h : jsTrim s = "") :
    decodeCctActionValue (.str s) = .invalid (.str s) := by
  simp [decodeCctActionValue, (blank_iff s).mpr h]

/-- Lines 112-115: a string that is not blank and does not start with `cm:` is legacy, carrying the
whole string. -/
theorem decode_unprefixed {s : String} (hb : jsTrim s ≠ "")
    (hst : jsStartsWith s PREFIX = false) :
    decodeCctActionValue (.str s) = .legacy s := by
  have hblank : (utf16Length s == 0 || utf16Length (jsTrim s) == 0) = false := by
    rw [Bool.eq_false_iff]
    exact fun h => hb ((blank_iff s).mp h)
  simp [decodeCctActionValue, hblank, hst]

/-- A string that starts with `cm:` is `c m :` followed by the rest. -/
theorem prefixed_toList {s : String} (h : jsStartsWith s PREFIX = true) :
    ∃ t, s.toList = 'c' :: 'm' :: ':' :: t := by
  simp only [jsStartsWith, PREFIX_toList, List.isPrefixOf_iff_prefix] at h
  obtain ⟨t, ht⟩ := h
  exact ⟨t, ht.symm⟩

/-- A string that starts with `cm:` decodes to `invalid`, or to `tagged` when it is the wire form
of a valid mode and a non-empty payload. -/
theorem decode_prefixed {s : String} (hst : jsStartsWith s PREFIX = true) :
    decodeCctActionValue (.str s) = .invalid (.str s) ∨
      ∃ mode payload, s = wire mode payload ∧ mode ∈ VALID_MODES ∧ payload ≠ "" ∧
        decodeCctActionValue (.str s) = .tagged mode payload := by
  obtain ⟨t, hs⟩ := prefixed_toList hst
  rw [decode_str_of_prefixed hs]
  cases hi : indexOfSep t with
  | none => exact Or.inl rfl
  | some i =>
    dsimp only
    by_cases h1 : (utf16Length (String.ofList (t.take i)) == 0) = true
    · exact Or.inl (ite_eq_left h1)
    · rw [ite_eq_right h1]
      by_cases h2 : (utf16Length (String.ofList (t.drop (i + 1))) == 0) = true
      · exact Or.inl (ite_eq_left h2)
      · rw [ite_eq_right h2]
        by_cases h3 : (!VALID_MODES.contains (String.ofList (t.take i))) = true
        · exact Or.inl (ite_eq_left h3)
        · rw [ite_eq_right h3]
          refine Or.inr ⟨_, _, ?_, ?_, ?_, rfl⟩
          · apply String.ext
            rw [wire_toList, String.toList_ofList, String.toList_ofList, hs,
              ← indexOfSep_eq_some hi]
          · rw [← contains_VALID_MODES]
            simpa using h3
          · intro he
            apply h2
            rw [he]
            decide

/-- Every string decodes in one of four ways: blank and invalid; not blank, not prefixed and
legacy; prefixed and invalid; prefixed, the wire form of a valid mode and a non-empty payload,
and tagged. -/
theorem decode_str_cases (s : String) :
    (jsTrim s = "" ∧ decodeCctActionValue (.str s) = .invalid (.str s)) ∨
    (jsTrim s ≠ "" ∧ jsStartsWith s PREFIX = false ∧
      decodeCctActionValue (.str s) = .legacy s) ∨
    (jsStartsWith s PREFIX = true ∧ decodeCctActionValue (.str s) = .invalid (.str s)) ∨
    (jsStartsWith s PREFIX = true ∧ ∃ mode payload, s = wire mode payload ∧
      mode ∈ VALID_MODES ∧ payload ≠ "" ∧
      decodeCctActionValue (.str s) = .tagged mode payload) := by
  by_cases hb : jsTrim s = ""
  · exact Or.inl ⟨hb, decode_blank hb⟩
  · cases hst : jsStartsWith s PREFIX with
    | false => exact Or.inr (Or.inl ⟨hb, rfl, decode_unprefixed hb hst⟩)
    | true =>
      rcases decode_prefixed hst with h | h
      · exact Or.inr (Or.inr (Or.inl ⟨rfl, h⟩))
      · exact Or.inr (Or.inr (Or.inr ⟨rfl, h⟩))

/-! ## Encode -/

/-- Failing `VALID_MODES.has` (line 79) means the mode is not valid. -/
theorem not_valid_of_not_contains {mode : String} (h : (!VALID_MODES.contains mode) = true) :
    mode ∉ VALID_MODES := by
  intro hm
  rw [(contains_VALID_MODES mode).mpr hm] at h
  exact Bool.false_ne_true h

/-- Passing `VALID_MODES.has` (line 79) means the mode is valid. -/
theorem valid_of_not_not_contains {mode : String} (h : ¬(!VALID_MODES.contains mode) = true) :
    mode ∈ VALID_MODES := by
  rw [← contains_VALID_MODES]
  cases hc : VALID_MODES.contains mode
  · rw [hc] at h
    exact absurd rfl h
  · rfl

/-- `EncodeOk`: the encoder returns a value exactly for a valid mode, a payload that is not blank
and a wire form within 2000 code units, and the value is that wire form. -/
theorem encode_ok : EncodeOk := by
  intro mode payload encoded
  unfold encodeCctActionValue
  split
  · rename_i h
    have hm := not_valid_of_not_contains h
    constructor
    · intro he
      cases he
    · rintro ⟨hm', -⟩
      exact absurd hm' hm
  · rename_i h
    have hm := valid_of_not_not_contains h
    split
    · rename_i hb
      have hp := (blank_iff payload).mp hb
      constructor
      · intro he
        cases he
      · rintro ⟨-, hp', -⟩
        exact absurd hp hp'
    · rename_i hb
      have hp : jsTrim payload ≠ "" := fun hp => hb ((blank_iff payload).mpr hp)
      dsimp only
      split
      · rename_i hl
        constructor
        · intro he
          cases he
        · rintro ⟨-, -, hl', -⟩
          exact absurd hl' (Nat.not_le.mpr hl)
      · rename_i hl
        constructor
        · intro he
          cases he
          exact ⟨hm, hp, Nat.not_lt.mp hl, rfl⟩
        · rintro ⟨-, -, -, rfl⟩
          rfl

/-- `EncodeFailureSet`: the encoder throws exactly when the mode is unknown, the payload is empty
or white space only, or the wire form exceeds 2000 code units. -/
theorem encode_failure_set : EncodeFailureSet := by
  intro mode payload
  unfold encodeCctActionValue
  split
  · rename_i h
    exact ⟨fun _ => Or.inl (not_valid_of_not_contains h), fun _ => ⟨_, rfl⟩⟩
  · rename_i h
    have hm := valid_of_not_not_contains h
    split
    · rename_i hb
      exact ⟨fun _ => Or.inr (Or.inl ((blank_iff payload).mp hb)), fun _ => ⟨_, rfl⟩⟩
    · rename_i hb
      have hp : jsTrim payload ≠ "" := fun hp => hb ((blank_iff payload).mpr hp)
      dsimp only
      split
      · rename_i hl
        exact ⟨fun _ => Or.inr (Or.inr hl), fun _ => ⟨_, rfl⟩⟩
      · rename_i hl
        constructor
        · rintro ⟨_, he⟩
          cases he
        · rintro (hm' | hp' | hl')
          · exact absurd hm hm'
          · exact absurd hp' hp
          · exact absurd hl' hl

/-! ## Encode and decode are inverse -/

/-- `RoundTrip`: every value the encoder returns decodes to `tagged` with the mode and payload it
was built from. -/
theorem round_trip : RoundTrip := by
  intro mode payload encoded h
  obtain ⟨hm, hp, -, rfl⟩ := (encode_ok mode payload encoded).mp h
  refine decode_wire_valid hm fun he => hp ?_
  rw [he]
  exact jsTrim_empty

/-- `RoundTripOfValid`: for either mode and any payload that is not blank and fits the cap, the
encoder returns the wire form and the decoder gives the mode and payload back. -/
theorem round_trip_of_valid : RoundTripOfValid := by
  intro mode payload hm hp hl
  have h := (encode_ok mode payload (wire mode payload)).mpr ⟨hm, hp, hl, rfl⟩
  exact ⟨h, round_trip mode payload _ h⟩

/-- An instance of the round trip for a payload that is itself an encoded value, `|` and `cm:`
included: nothing in `decode_wire_valid` excludes such payloads. -/
theorem round_trip_nested :
    decodeCctActionValue (.str (wire "readonly" "cm:admin|x")) = .tagged "readonly" "cm:admin|x" :=
  decode_wire_valid (by decide) (by decide)

/-! ## The invalid matrix -/

/-- `NoSeparatorInvalid`: `cm:` followed by anything without `|` is invalid. -/
theorem no_separator_invalid : NoSeparatorInvalid := by
  intro t ht
  have hs : (PREFIX ++ t).toList = 'c' :: 'm' :: ':' :: t.toList := by
    simp [String.toList_append, PREFIX_toList]
  rw [decode_str_of_prefixed hs, (indexOfSep_eq_none_iff _).mpr ht]

/-- The empty string has JS length 0. -/
theorem utf16Length_empty : utf16Length "" = 0 := by
  decide

/-- `EmptyPayloadInvalid`: `cm:<mode>|` with nothing after the separator is invalid. -/
theorem empty_payload_invalid : EmptyPayloadInvalid := by
  intro mode hm
  rw [decode_wire _ _ hm]
  simp [utf16Length_empty]

/-- `EmptyModeInvalid`: `cm:|<payload>` is invalid, whatever the payload. -/
theorem empty_mode_invalid : EmptyModeInvalid := by
  intro payload
  rw [decode_wire _ _ (by simp)]
  simp [utf16Length_empty]

/-- `UnknownModeInvalid`: `cm:<mode>|<payload>` with a mode that is not `admin` or `readonly` is
invalid, whatever the payload. -/
theorem unknown_mode_invalid : UnknownModeInvalid := by
  intro mode payload hsep hm
  rw [decode_wire _ _ hsep]
  simp [hm]

/-- `InvalidMatrix`: every entry of the doc comment's invalid matrix (lines 25-33) decodes to
`invalid`, carrying the input: a non-string, `''`, any white-space-only string, `cm:`,
`cm:admin`, `cm:admin|`, `cm:|abc` and `cm:bad|abc`. -/
theorem invalid_matrix : InvalidMatrix := by
  have e1 : ("cm:" : String) = PREFIX ++ "" := by decide
  have e2 : ("cm:admin" : String) = PREFIX ++ "admin" := by decide
  have e3 : ("cm:admin|" : String) = wire "admin" "" := by decide
  have e4 : ("cm:|abc" : String) = wire "" "abc" := by decide
  have e5 : ("cm:bad|abc" : String) = wire "bad" "abc" := by decide
  refine ⟨rfl, decode_blank jsTrim_empty, fun s h => decode_blank h, ?_, ?_, ?_, ?_, ?_⟩
  · rw [e1]
    exact no_separator_invalid "" (by decide)
  · rw [e2]
    exact no_separator_invalid "admin" (by decide)
  · rw [e3]
    exact empty_payload_invalid "admin" (by decide)
  · rw [e4]
    exact empty_mode_invalid "abc"
  · rw [e5]
    exact unknown_mode_invalid "bad" "abc" (by decide) (by decide)

/-- `InvalidCarriesRaw`: an `invalid` result carries exactly the input it was given. -/
theorem invalid_carries_raw : InvalidCarriesRaw := by
  intro raw r h
  cases raw with
  | nonString =>
    simp [decodeCctActionValue] at h
    exact h.symm
  | str s =>
    rcases decode_str_cases s with
        ⟨-, hd⟩ | ⟨-, -, hd⟩ | ⟨-, hd⟩ | ⟨-, _, _, -, -, -, hd⟩ <;>
      rw [hd] at h <;> simp at h
    all_goals exact h.symm

/-! ## Legacy and tagged -/

/-- `LegacyIff`: the decoder returns `legacy` exactly for strings that are not blank and do not
start with `cm:`, and the legacy payload is the whole input. -/
theorem legacy_iff : LegacyIff := by
  intro raw payload
  constructor
  · intro h
    cases raw with
    | nonString => simp [decodeCctActionValue] at h
    | str s =>
      rcases decode_str_cases s with
          ⟨-, hd⟩ | ⟨hb, hst, hd⟩ | ⟨-, hd⟩ | ⟨-, _, _, -, -, -, hd⟩ <;>
        rw [hd] at h <;> simp at h
      subst h
      exact ⟨rfl, hb, hst⟩
  · rintro ⟨rfl, hb, hst⟩
    exact decode_unprefixed hb hst

/-- `PrefixedNeverLegacy`: a value starting with `cm:` is never read as legacy, however malformed
the rest is. -/
theorem prefixed_never_legacy : PrefixedNeverLegacy := by
  intro s payload hst h
  obtain ⟨hs, -, hst'⟩ := (legacy_iff (.str s) payload).mp h
  cases hs
  simp [hst] at hst'

/-- `TaggedIff`: the decoder returns `tagged mode payload` exactly for the wire form of a valid
mode and a non-empty payload; the split is at the first `|`. -/
theorem tagged_iff : TaggedIff := by
  intro raw mode payload
  constructor
  · intro h
    cases raw with
    | nonString => simp [decodeCctActionValue] at h
    | str s =>
      rcases decode_str_cases s with ⟨-, hd⟩ | ⟨-, -, hd⟩ | ⟨-, hd⟩ |
          ⟨-, m, p, hs, hm, hp, hd⟩ <;> rw [hd] at h <;> simp at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨by rw [hs], hm, hp⟩
  · rintro ⟨rfl, hm, hp⟩
    exact decode_wire_valid hm hp

/-- `TaggedSound`: a tagged result always has mode `admin` or `readonly` and a non-empty payload.
-/
theorem tagged_sound : TaggedSound := by
  intro raw mode payload h
  have := (tagged_iff raw mode payload).mp h
  exact ⟨this.2.1, this.2.2⟩

/-! ## readCctActionPayload -/

/-- `ReadNoneIff`: `readCctActionPayload` returns `null` exactly when the decoder returns
`invalid`. -/
theorem read_none_iff : ReadNoneIff := by
  intro raw
  unfold readCctActionPayload
  cases h : decodeCctActionValue raw with
  | invalid r => simp [invalid_carries_raw raw r h]
  | tagged m p => simp
  | legacy p => simp

/-- `ReadSomeIff`: `readCctActionPayload` returns a payload exactly when the decoder returns it,
from a tagged or a legacy value. -/
theorem read_some_iff : ReadSomeIff := by
  intro raw payload
  unfold readCctActionPayload
  cases decodeCctActionValue raw with
  | invalid r => simp
  | tagged m p => simp [eq_comm]
  | legacy p => simp [eq_comm]

/-! ## Simplification candidates -/

/-- `DecodeVariantIsModel`: with both checks kept, `decodeVariant` is the decoder as written. -/
theorem decode_variant_is_model : DecodeVariantIsModel := by
  intro raw
  cases raw <;> rfl

/-- `EncodeVariantIsModel`: with the check kept, `encodeVariant` is the encoder as written. -/
theorem encode_variant_is_model : EncodeVariantIsModel := by
  intro mode payload
  rfl

/-- `RedundantRawLengthCheck`: deleting `raw.length === 0 ||` from line 111 changes no decoder
result, whether or not line 124 is kept. -/
theorem redundant_raw_length_check : RedundantRawLengthCheck := by
  intro keep124 raw
  cases raw with
  | nonString => rfl
  | str s =>
    simp only [decodeVariant, Bool.false_and, Bool.false_or, Bool.true_and,
      redundant_length_disjunct]

/-- Lines 124-127 give the same result as lines 125-127: an empty mode fails `VALID_MODES.has`
on line 126, and lines 124, 125 and 126 all return the same `invalid`. -/
theorem mode_check_redundant (raw : RawValue) (mode payload : String) :
    (if utf16Length mode == 0 then Decoded.invalid raw
      else if utf16Length payload == 0 then .invalid raw
      else if !VALID_MODES.contains mode then .invalid raw
      else .tagged mode payload) =
    (if utf16Length payload == 0 then .invalid raw
      else if !VALID_MODES.contains mode then .invalid raw
      else .tagged mode payload) := by
  by_cases hm : (utf16Length mode == 0) = true
  · have hc : VALID_MODES.contains mode = false := by
      have he : mode = "" := by
        simpa [utf16Length_eq_zero_iff] using hm
      subst he
      decide
    rw [ite_eq_left hm, hc]
    simp
  · rw [ite_eq_right hm]

/-- `RedundantModeLengthCheck`: deleting line 124 changes no decoder result, whether or not the
length disjunct of line 111 is kept. -/
theorem redundant_mode_length_check : RedundantModeLengthCheck := by
  intro keep111 raw
  cases raw with
  | nonString => rfl
  | str s =>
    simp only [decodeVariant, Bool.false_and, Bool.true_and, Bool.false_eq_true, ↓reduceIte,
      mode_check_redundant]

/-- `RedundantPayloadLengthCheck`: deleting `payload.length === 0 ||` from line 82 changes no
encoder result, error messages included. -/
theorem redundant_payload_length_check : RedundantPayloadLengthCheck := by
  intro mode payload
  simp only [encodeVariant, Bool.false_and, Bool.false_or, Bool.true_and,
    redundant_length_disjunct]

/-- All three deletions at once: the decoder without the length disjunct of line 111 and without
line 124, and the encoder without the length disjunct of line 82, return exactly what the TS
returns now. -/
theorem redundant_checks :
    (∀ raw, decodeVariant false false raw = decodeCctActionValue raw) ∧
      ∀ mode payload, encodeVariant false mode payload = encodeCctActionValue mode payload := by
  refine ⟨fun raw => ?_, fun mode payload => ?_⟩
  · rw [redundant_raw_length_check, redundant_mode_length_check, decode_variant_is_model]
  · rw [redundant_payload_length_check, encode_variant_is_model]

/-! ## Observation (not a documented invariant) -/

/-- The decoder accepts a tagged value whose payload is white space only, which the encoder
refuses to produce: `cm:admin| ` decodes to mode `admin`, payload one space, while encoding that
mode and payload throws. The doc comment lists only the empty payload `cm:admin|` as invalid, so
this is recorded rather than changed; `tagged_iff` and `encode_ok` give the general shape. -/
theorem blank_payload_asymmetry :
    decodeCctActionValue (.str "cm:admin| ") = .tagged "admin" " " ∧
      ∃ msg, encodeCctActionValue "admin" " " = .error msg := by
  have e : ("cm:admin| " : String) = wire "admin" " " := by decide
  refine ⟨?_, (encode_failure_set "admin" " ").mpr (Or.inr (Or.inl (by decide)))⟩
  rw [e]
  exact decode_wire_valid (by decide) (by decide)

end SomaVerify.CctActionValue.Proofs
