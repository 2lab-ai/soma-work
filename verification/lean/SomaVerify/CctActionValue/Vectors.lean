import SomaVerify.Support.Json
import SomaVerify.Support.JsString
import SomaVerify.Support.Vectors
import SomaVerify.CctActionValue.Model

/-!
# Conformance vectors for `SomaVerify.CctActionValue`

Two kinds of case, one per line of `verification/vectors/cct-action-value.json`:

* decode cases, `{"raw":…,"decode":…,"read":…}`: a string, the model's `decodeCctActionValue`
  for it as the TS object, and its `readCctActionPayload` (`null` for `none`);
* encode cases, `{"mode":…,"payload":…,"encode":…}`: the arguments and either `{"ok":<value>}`
  or `{"throws":<message>}`.

`src/slack/cct/__tests__/action-value.lean-conformance.test.ts` replays every case against the
real exported functions.

Decode inputs. Of the strings of length 0 to 5 over `alphabet` (about 800,000), four families
are kept, which keeps the file under 3 MB (adding every string of length 4 would take it to
about 6 MB):

1. every string of length 0 to 3;
2. every string of length 4 or 5 that starts with `cm:`;
3. every string of length 4 or 5 over `core`;
4. every string of length 4 or 5 over `blanks`.

Beyond length 5:

5. `structured`: `cm:<mode>|<payload>` for every `mode` in `modeLike` and every `payload` in
   `payloadLike` (valid modes) or `payloadFew` (the others), and `cm:<mode>` with no separator;
6. `targeted`: white space before and after a tagged value, astral characters in every
   position, characters that are white space in JS or only look like it, the examples from the
   TS doc comments, and values longer than the encoder's cap.

Encode inputs: both modes with every payload in `payloadLike`; `unknownModes`, including one for
each branch of `jsonQuoteChar`; which of the three errors wins when several apply; and encoded
lengths 1996 to 2001 around the cap, with and without astral characters.

Repeated inputs are dropped, first occurrence kept, so every case is distinct.

Run by `scripts/verification/lean-verify.sh` (`lake env lean --run`).
-/

namespace SomaVerify.CctActionValue.Vectors

open SomaVerify SomaVerify.JsString SomaVerify.CctActionValue

/-- U+1F600, outside the BMP: two UTF-16 code units in JS. -/
def astral : Char := Char.ofNat 0x1F600

/-- `Char.ofNat` of an invalid code point silently gives U+0000; this one is the intended
scalar value. -/
theorem astral_spec : astral.toNat = 0x1F600 := by
  decide

/-- The exhaustive alphabet: ASCII `c m : | a d n r o l y`, space, TAB, U+3000 IDEOGRAPHIC
SPACE and U+FEFF ZERO WIDTH NO-BREAK SPACE. In this file every input character outside
printable ASCII is written as an escape or with `Char.ofNat`, so none is invisible in the
source. -/
def alphabet : List Char :=
  ['c', 'm', ':', '|', 'a', 'd', 'n', 'r', 'o', 'l', 'y', ' ', '\t', '\u3000', '\uFEFF']

/-- The characters lengths 4 and 5 run over: the prefix, the separator, one other letter,
ASCII and non-ASCII white space. -/
def core : List Char :=
  ['c', 'm', ':', '|', 'a', ' ', '\u3000']

/-- The alphabet's white space. -/
def blanks : List Char :=
  [' ', '\t', '\u3000', '\uFEFF']

/-- The alphabet has no repeats, `core` and `blanks` are drawn from it, and `blanks` is
exactly the part of it `String.prototype.trim` removes. -/
theorem alphabet_spec :
    alphabet.eraseDups = alphabet ∧ core.all alphabet.contains ∧
      blanks.all alphabet.contains ∧ alphabet.filter jsIsWhitespace = blanks := by
  decide

/-- Every string of exactly `n` characters over `cs`, in alphabet order. -/
def wordsOver (cs : List Char) : Nat → List String
  | 0 => [""]
  | n + 1 => (wordsOver cs n).flatMap fun w => cs.map w.push

/-- Every string of `lo` to `hi` characters over `cs`, shortest first. -/
def wordsBetween (cs : List Char) (lo hi : Nat) : List String :=
  (List.range' lo (hi + 1 - lo)).flatMap (wordsOver cs)

/-- `n` copies of `s`, concatenated. -/
def rep (n : Nat) (s : String) : String :=
  String.join (List.replicate n s)

/-- Strings for the mode position of `cm:<mode>|<payload>`: the two valid modes, the invalid
matrix's empty and unknown modes (lines 32-33), and near misses (case, truncation, extension,
white space around, a nested prefix, an astral character). None contains `|`. -/
def modeLike : List String :=
  ["admin", "readonly", "", "bad",
   "Admin", "ADMIN", "Readonly", "readOnly",
   "admi", "dmin", "adminn", "readonl", "eadonly", "readonlyy", "read", "only", "a", "r",
   " admin", "admin ", "\tadmin", "admin\t", "\u3000admin", "admin\u3000", "\uFEFFadmin",
   "admin\uFEFF", " readonly", "readonly ",
   "cm", "cm:", "cm:admin", "admin:", "admin readonly", "adminreadonly", "readonlyadmin",
   astral.toString, "admin" ++ astral.toString]

/-- Payloads beyond the short exhaustive ones: astral characters (alone, after a letter, around
a separator), payloads that are encoded values or start with the prefix, several separators,
white space around text, U+0085 / U+200B / U+180E (not white space in JS), U+00A0 / U+2028
(white space in JS), a key-id-like value and one wrapped by the auth-origin codec. -/
def payloadExtra : List String :=
  [astral.toString, "a" ++ astral.toString, astral.toString ++ "|" ++ astral.toString,
   "cm:admin|x", "cm:readonly|", "cm:", "cm:|", "abc|def", "x|y|z", " x ", "\u3000\u3000\u3000",
   "\u0085", "\u200B", "\u180E", "\u00A0", "\u2028", "\u00A0x\u2028", "slot-A", "ao:0|slot-A"]

/-- Payloads for the valid modes: every string of length 0 to 2 over `alphabet`, then
`payloadExtra`. -/
def payloadLike : List String :=
  wordsBetween alphabet 0 2 ++ payloadExtra

/-- Payloads for the other modes, where they decide nothing: empty, text, white space, a
separator, an encoded value, an astral character. -/
def payloadFew : List String :=
  ["", "x", " ", "|", "x|y", "cm:admin|x", astral.toString]

/-- Family 5: `cm:<mode>|<payload>` and `cm:<mode>`. -/
def structured : List String :=
  (modeLike.flatMap fun m =>
      (if VALID_MODES.contains m then payloadLike else payloadFew).map fun p =>
        PREFIX ++ m ++ SEP.toString ++ p) ++
    modeLike.map (PREFIX ++ ·)

/-- Family 6: hand-picked decode inputs. -/
def targeted : List String :=
  -- white space before a tagged value, JS white space or not: no longer starts with `cm:`
  (["\t", " ", "\u3000", "\uFEFF", "\n", "\u00A0", "\u2028", "\u0085", "\u200B"].map
      (· ++ "cm:admin|x")) ++
  -- white space after a tagged value stays in the payload
  (blanks.map fun c => "cm:readonly|x".push c) ++
  -- astral characters in every position
  [astral.toString, astral.toString ++ "cm:admin|x", "c" ++ astral.toString,
   "cm:" ++ astral.toString, "cm:" ++ astral.toString ++ "|x",
   "cm:admin" ++ astral.toString ++ "|x",
   "cm:admin|" ++ astral.toString, "cm:readonly|" ++ astral.toString ++ "|" ++ astral.toString,
   "cm:admin|x" ++ astral.toString ++ "y", rep 3 astral.toString] ++
  -- not white space in JS, so a legacy value on its own
  ["\u0085", "\u200B", "\u180E", "\x00", "\x01", "\x7f"] ++
  -- white space in JS outside `alphabet`, so invalid on its own
  ["\n", "\r", "\x0b", "\x0c", "\u00A0", "\u1680", "\u2000", "\u200A", "\u2028", "\u2029",
   "\u202F", "\u205F", " \n\r\u2028 "] ++
  -- the TS doc comments' examples (lines 29-33 and 105) and the legacy values of the unit tests
  ["cm:admin|abc|def", "cm:bad|abc", "cm:|abc", "cm:admin|", "cm:admin", "cm:", "keyid-123",
   "next", "refresh_card", "cm", "CM:admin|x", "cm;admin|x", "cm:admin/x", "cm:admin|slot-A"] ++
  -- longer than the encoder's cap: the decoder has no length limit
  ["cm:admin|" ++ rep 1992 "x", rep 2001 "x"]

/-- Modes outside `VALID_MODES`: `modeLike`'s, then one string for each branch of
`jsonQuoteChar` (the seven short escapes, other code points below U+0020, DEL, the Unicode line
and paragraph separators, non-ASCII and astral characters) and two mixtures. -/
def unknownModes : List String :=
  modeLike.filter (fun m => !VALID_MODES.contains m) ++
  ["\x08", "\t", "\n", "\x0c", "\r", "\"", "\\", "\x00", "\x01", "\x1f", "\x7f", "\u2028",
   "\u2029", "\u00E9", "\u00A0", "\uFEFF", "a\"b\\c\nd", "admin\n"]

/-- `utf16Length` of `cm:<mode>|`: the part of an encoded value that is not payload. -/
def headLength (mode : String) : Nat :=
  utf16Length (PREFIX ++ mode ++ SEP.toString)

/-- Payloads for `mode` whose encoded value is 1996 to 2001 code units long, so the cap at 2000
is crossed: ASCII only; ending in an astral character (the last two code units), so at 2001 the
value has 2000 characters but 2001 code units; astral only, at the lengths of the right parity;
white space up to one letter, at 2000 and 2001. -/
def capPayloads (mode : String) : List String :=
  let h := headLength mode
  ((List.range' 1996 6).flatMap fun n =>
      [rep (n - h) "x", rep (n - h - 2) "x" ++ astral.toString]) ++
    ((List.range' 1996 6).filterMap fun n =>
      if (n - h) % 2 == 0 then some (rep ((n - h) / 2) astral.toString) else none) ++
    [rep (2000 - h - 1) " " ++ "x", rep (2001 - h - 1) " " ++ "x"]

/-- Several errors at once: the mode is checked first (line 79), then the payload (line 82),
then the length (line 86). -/
def precedence : List (String × String) :=
  [("bad", ""), ("bad", " "), ("bad", rep 2001 "x"), ("", "\u3000"),
   ("admin", rep 2001 " "), ("readonly", rep 1995 "\uFEFF")]

/-- The first entry of each run of entries with equal values, in a list of `(value, position)`
entries; tail-recursive, since the lists here have tens of thousands of entries. -/
def firstOfRuns {α : Type} [BEq α] : List (α × Nat) → List (α × Nat)
  | [] => []
  | x :: rest => go x.1 rest [x]
where
  go (prev : α) : List (α × Nat) → List (α × Nat) → List (α × Nat)
    | [], acc => acc.reverse
    | y :: ys, acc => if y.1 == prev then go prev ys acc else go y.1 ys (y :: acc)

/-- `xs` without repeats, first occurrences kept, in order. `lt` is a strict total order on
values, `==` its equality. Sorting the entries by value, then position, puts each value's first
occurrence at the head of its run of equal values; the survivors are put back in position
order. -/
def dedupe {α : Type} [BEq α] (lt : α → α → Bool) (xs : List α) : List α :=
  let byValue := xs.zipIdx.mergeSort fun a b => lt a.1 b.1 || (a.1 == b.1 && a.2 ≤ b.2)
  ((firstOfRuns byValue).mergeSort fun a b => a.2 ≤ b.2).map (·.1)

/-- The strict order on strings: lexicographic by code point. -/
def stringLt (a b : String) : Bool :=
  decide (a < b)

/-- The strict order on pairs of strings: by the first, then the second. -/
def pairLt (a b : String × String) : Bool :=
  stringLt a.1 b.1 || (a.1 == b.1 && stringLt a.2 b.2)

/-- The decode inputs, families 1 to 6 in order. -/
def decodeInputs : List String :=
  dedupe stringLt <|
    wordsBetween alphabet 0 3 ++
    (wordsBetween alphabet 1 2).map (PREFIX ++ ·) ++
    wordsBetween core 4 5 ++
    wordsBetween blanks 4 5 ++
    structured ++
    targeted

/-- The encode inputs as `(mode, payload)`. -/
def encodeInputs : List (String × String) :=
  dedupe pairLt <|
    (VALID_MODES.flatMap fun m => payloadLike.map (m, ·)) ++
    unknownModes.map (·, "x") ++
    precedence ++
    VALID_MODES.flatMap fun m => (capPayloads m).map (m, ·)

/-- A decoder result as the TS returns it. An `invalid` result carries the string it was given
(`Proofs.invalid_carries_raw`), so the non-string case, written without `raw`, never occurs here;
if it did, the replay would fail on it. -/
def decodedJson : Decoded → Json
  | .tagged m p => .obj [("kind", .str "tagged"), ("mode", .str m), ("payload", .str p)]
  | .legacy p => .obj [("kind", .str "legacy"), ("payload", .str p)]
  | .invalid (.str s) => .obj [("kind", .str "invalid"), ("raw", .str s)]
  | .invalid .nonString => .obj [("kind", .str "invalid")]

/-- One decode case: the input, the decoder's result and `readCctActionPayload`'s. -/
def decodeCase (s : String) : Json :=
  .obj [("raw", .str s),
        ("decode", decodedJson (decodeCctActionValue (.str s))),
        ("read", match readCctActionPayload (.str s) with
          | some p => .str p
          | none => .null)]

/-- One encode case: the arguments and the returned value or the thrown message. -/
def encodeCase (mode payload : String) : Json :=
  .obj [("mode", .str mode), ("payload", .str payload),
        ("encode", match encodeCctActionValue mode payload with
          | .ok v => .obj [("ok", .str v)]
          | .error msg => .obj [("throws", .str msg)])]

/-- The cases written to `verification/vectors/cct-action-value.json`. -/
def cases : List Json :=
  decodeInputs.map decodeCase ++ encodeInputs.map fun (m, p) => encodeCase m p

end SomaVerify.CctActionValue.Vectors

def main : IO Unit :=
  IO.print (SomaVerify.Vectors.render "cct-action-value" ``SomaVerify.CctActionValue.Vectors.cases
    SomaVerify.CctActionValue.Vectors.cases)
