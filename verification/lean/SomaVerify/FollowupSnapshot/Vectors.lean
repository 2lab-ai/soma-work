import SomaVerify.Support.Json
import SomaVerify.Support.Vectors
import SomaVerify.FollowupSnapshot.Model

/-!
# Conformance vectors for `parseFollowupQueueSnapshot`

Each case is a snapshot document and what the model says the gate does with it: `{"ok":true}`
(it returns its input) or `{"error":"<message>"}` (it throws with exactly that message).
`packages/slack/src/__tests__/followup-queue-store.lean-conformance.test.ts` hands every document
to the real `parseFollowupQueueSnapshot` and requires the same outcome.

Documents are built from one valid item, session and snapshot, then varied:

* every field of the snapshot, session, item, message, `routeContext`, file and context, each
  removed, set to an explicit `undefined`, and replaced by one value of every JSON type (null,
  `true`, the number 7, the empty and a non-empty string, an empty array, an empty object) plus a
  few values specific to it (a mismatching id or eventKey, an unknown state, `false`); the nine
  number fields (`version`, `nextSeq`, `turnEpoch`, `freeze.at`, `seq`, `epoch`, `enqueuedAt`,
  `updatedAt` and a file's `size`) also get the boundary numbers (0, -0, -1, 1, 1.0, 1.5, -0.5,
  2^53 - 1, 2^53, NaN, ±Infinity, the string "1");
* exhaustively: every pair of the 10 item states in a two-item session, every triple of the four
  dispatch-related states (`queued`, `reserved`, `claimed`, `dispatched`) in a three-item session,
  and every `nextSeq` in 1..6 against eight seq sets;
* duplicates of id, seq, eventKey and steerUuid, alone and combined, and next to invalid items (the
  order of checks decides which message wins);
* two sessions: duplicate keys, an invalid second session, and identities shared across sessions
  (per-session, so accepted).

## Encoding

JSON cannot write `undefined`, NaN, the infinities or -0, and `Support/Json` numbers are integers.
A safe integer is written as a plain JSON number; every other number, and `undefined`, as
`{"$js":"<JS literal>"}`, a finite number as a decimal without exponent. The model reads a number
as the exact decimal it is (`JsNum`) and the code gets the Number the parser rounds its literal
to, so a vector compares the two only if every number in it is a Number's value. Both ends check
it: `main` refuses to print a document carrying a number that is not (`JsNum.isNumberValue`), and
the test decodes a plain number only if it is a safe integer and a marker only if its literal is
exactly the Number it parses to (compared in BigInt). `main` also refuses a document with a
repeated key (a JS object has distinct keys, and the model's property read takes the first) or
with a real `$js` key, and refuses repeated case names.
-/

namespace SomaVerify.FollowupSnapshot.Vectors

open SomaVerify SomaVerify.FollowupSnapshot

/-! ## Encoding model values as vector JSON -/

/-- The JS literal of the finite decimal `(-1)^neg * m / 10^k`, e.g. `1.5`, `-0`, `1.0`. -/
def decimalLiteral (neg : Bool) (m k : Nat) : String :=
  let digits := (toString m).toList
  let padded := List.replicate (k + 1 - digits.length) '0' ++ digits
  let whole := String.ofList (padded.take (padded.length - k))
  let body := if k = 0 then whole else whole ++ "." ++ String.ofList (padded.drop (padded.length - k))
  (if neg then "-" else "") ++ body

/-- A value as its JS literal: one JSON cannot carry, or a number other than a safe integer. -/
def marker (literal : String) : Json :=
  .obj [("$js", .str literal)]

/-- A plain JSON number for a safe integer, and a marker for every other number. The test reads a
plain number exactly when it comes back a safe integer (an integer literal parses to one only when
it is one), so it can check that every plain number was read exactly; 2^53 goes in a marker. -/
def encodeNum : JsNum → Json
  | .dec neg m k =>
    if k = 0 ∧ m ≤ JsNum.maxSafeInteger ∧ ¬(neg = true ∧ m = 0) then
      .num (if neg then -(m : Int) else (m : Int))
    else marker (decimalLiteral neg m k)
  | .posInf => marker "Infinity"
  | .negInf => marker "-Infinity"
  | .nan => marker "NaN"

mutual
def encode : JsVal → Json
  | .undef => marker "undefined"
  | .null => .null
  | .bool b => .bool b
  | .num x => encodeNum x
  | .str s => .str s
  | .arr items => .arr (encodeItems items)
  | .obj fields => .obj (encodeFields fields)

def encodeItems : List JsVal → List Json
  | [] => []
  | v :: rest => encode v :: encodeItems rest

def encodeFields : List (String × JsVal) → List (String × Json)
  | [] => []
  | (k, v) :: rest => (k, encode v) :: encodeFields rest
end

mutual
/-- Distinct keys in every object, and no key named `$js`. -/
def wellFormed : JsVal → Bool
  | .arr items => wellFormedItems items
  | .obj fields =>
    let keys := fields.map (·.1)
    keys.eraseDups.length == keys.length && !keys.contains "$js" && wellFormedFields fields
  | _ => true

def wellFormedItems : List JsVal → Bool
  | [] => true
  | v :: rest => wellFormed v && wellFormedItems rest

def wellFormedFields : List (String × JsVal) → Bool
  | [] => true
  | (_, v) :: rest => wellFormed v && wellFormedFields rest
end

mutual
/-- Every number in the value is the value of a Number (`JsNum.isNumberValue`). -/
def numberValues : JsVal → Bool
  | .num x => x.isNumberValue
  | .arr items => numberValuesItems items
  | .obj fields => numberValuesFields fields
  | _ => true

def numberValuesItems : List JsVal → Bool
  | [] => true
  | v :: rest => numberValues v && numberValuesItems rest

def numberValuesFields : List (String × JsVal) → Bool
  | [] => true
  | (_, v) :: rest => numberValues v && numberValuesFields rest
end

/-! ## Building documents -/

def str (s : String) : JsVal := .str s
def int (i : Int) : JsVal := .num (JsNum.int i)
def dec (neg : Bool) (m k : Nat) : JsVal := .num (.dec neg m k)

def negZero : JsVal := dec true 0 0
def oneAndHalf : JsVal := dec false 15 1
def maxSafe : JsVal := int 9007199254740991
def twoPow53 : JsVal := int 9007199254740992
def nan : JsVal := .num .nan
def inf : JsVal := .num .posInf
def negInf : JsVal := .num .negInf

/-- Replace field `k`, or append it when absent (`none` removes it): keys stay distinct. -/
def setField : List (String × JsVal) → String → Option JsVal → List (String × JsVal)
  | [], k, some v => [(k, v)]
  | [], _, none => []
  | (k', v') :: rest, k, value =>
    if k' = k then
      match value with
      | some v => (k, v) :: rest
      | none => rest
    else (k', v') :: setField rest k value

/-- `set doc k value` on an object; other values are returned unchanged. -/
def set (doc : JsVal) (k : String) (value : Option JsVal) : JsVal :=
  match doc with
  | .obj fields => .obj (setField fields k value)
  | other => other

def message (ts : String) : JsVal :=
  .obj [("user", str "U1"), ("channel", str "C1"), ("ts", str ts)]

/-- A valid item: `id`, `eventKey` and the message are derived from the key and seq. -/
def item (key : String) (seq : Nat) (state : String := "queued") : JsVal :=
  .obj [("id", str (itemId key seq)), ("sessionKey", str key), ("seq", int seq), ("epoch", int 0),
    ("state", str state), ("eventKey", str s!"C1:{seq}"), ("message", message (toString seq)),
    ("context", .obj []), ("enqueuedAt", int 0), ("updatedAt", int 0)]

/-- A valid item in `state`; a `steered` one gets the uuid `u<seq>`. -/
def itemIn (key : String) (seq : Nat) (state : String) : JsVal :=
  if state = "steered" then set (item key seq state) "steerUuid" (some (str s!"u{seq}"))
  else item key seq state

def session (key : String) (nextSeq : Nat) (items : List JsVal) : JsVal :=
  .obj [("sessionKey", str key), ("nextSeq", int nextSeq), ("turnEpoch", int 0),
    ("items", .arr items)]

def snapshot (sessions : List JsVal) : JsVal :=
  .obj [("version", int 1), ("sessions", .arr sessions)]

/-- The single-item snapshot every field variation starts from. -/
def baseItem : JsVal := item "s1" 1
def withItem (it : JsVal) : JsVal := snapshot [session "s1" 2 [it]]
def withSession (s : JsVal) : JsVal := snapshot [s]
def baseSession : JsVal := session "s1" 2 [baseItem]

def getField (doc : JsVal) (k : String) : JsVal :=
  match doc with
  | .obj fields => get fields k
  | _ => .undef

/-- Set a field of the base item's message. -/
def withMessageField (k : String) (value : Option JsVal) : JsVal :=
  withItem (set baseItem "message" (some (set (getField baseItem "message") k value)))

def validFile : JsVal :=
  .obj [("id", str "F1"), ("name", str "log.txt"), ("mimetype", str "text/plain"),
    ("filetype", str "text"), ("url_private", str "u"), ("url_private_download", str "d"),
    ("size", int 42)]

def withFiles (files : JsVal) : JsVal := withMessageField "files" (some files)

/-! ## Value families -/

/-- Values of every JSON type, removal and an explicit `undefined`. -/
def anyType : List (String × Option JsVal) :=
  [("absent", none), ("undefined", some .undef), ("null", some .null), ("true", some (.bool true)),
    ("number 7", some (int 7)), ("empty string", some (str "")), ("string", some (str "x")),
    ("array", some (.arr [])), ("object", some (.obj []))]

/-- Numbers at the edges of the safe-integer and finiteness checks. -/
def boundaryNumbers : List (String × Option JsVal) :=
  [("0", some (int 0)), ("-0", some negZero), ("-1", some (int (-1))), ("1", some (int 1)),
    ("1.0", some (dec false 10 1)), ("1.5", some oneAndHalf), ("-0.5", some (dec true 5 1)),
    ("2^53-1", some maxSafe), ("2^53", some twoPow53), ("NaN", some nan), ("Infinity", some inf),
    ("-Infinity", some negInf), ("string 1", some (str "1"))]

/-- A number field: the boundary numbers, then every JSON type, removal and an explicit
`undefined`. -/
def numberField : List (String × Option JsVal) :=
  boundaryNumbers ++ anyType

def optionalStringField : List (String × Option JsVal) :=
  anyType ++ [("string 5", some (str "5"))]

def optionalBoolField : List (String × Option JsVal) :=
  anyType ++ [("false", some (.bool false))]

/-! ## Cases -/

/-- One vector: the document and what the model says the gate does with it. -/
def case (name : String) (doc : JsVal) : String × JsVal × Json :=
  let expect : Json :=
    match parseFollowupQueueSnapshot doc with
    | .ok _ => .obj [("ok", .bool true)]
    | .error message => .obj [("error", .str message)]
  (name, doc, .obj [("name", .str name), ("input", encode doc), ("expect", expect)])

def topLevel : List (String × JsVal × Json) :=
  [case "snapshot: undefined" .undef, case "snapshot: null" .null,
    case "snapshot: boolean" (.bool true), case "snapshot: number" (int 1),
    case "snapshot: string" (str "snapshot"), case "snapshot: array" (.arr []),
    case "snapshot: empty object" (.obj []), case "snapshot: empty and valid" (snapshot []),
    case "snapshot: one valid session" (withItem baseItem),
    case "snapshot: sessions [null]" (snapshot [.null]),
    case "snapshot: sessions [[]]" (snapshot [.arr []]),
    case "snapshot: sessions [string]" (snapshot [str "s1"])] ++
  (anyType ++ boundaryNumbers).map (fun (label, value) =>
    case s!"snapshot.version: {label}" (set (snapshot []) "version" value)) ++
  anyType.map (fun (label, value) =>
    case s!"snapshot.sessions: {label}" (set (snapshot []) "sessions" value))

def sessionFields : List (String × JsVal × Json) :=
  (optionalStringField ++ [("other key s2", some (str "s2"))]).map (fun (label, value) =>
    case s!"session.sessionKey: {label}" (withSession (set baseSession "sessionKey" value))) ++
  (numberField ++ [("2", some (int 2)), ("3", some (int 3)), ("2.0", some (dec false 20 1))]).map
    (fun (label, value) =>
      case s!"session.nextSeq: {label}" (withSession (set baseSession "nextSeq" value))) ++
  numberField.map (fun (label, value) =>
    case s!"session.turnEpoch: {label}" (withSession (set baseSession "turnEpoch" value))) ++
  anyType.map (fun (label, value) =>
    case s!"session.items: {label}" (withSession (set baseSession "items" value))) ++
  [case "session.items: [null]" (withSession (set baseSession "items" (some (.arr [.null])))),
    case "session.items: [undefined]" (withSession (set baseSession "items" (some (.arr [.undef])))),
    case "session.items: [[]]" (withSession (set baseSession "items" (some (.arr [.arr []]))))] ++
  anyType.map (fun (label, value) =>
    case s!"session.freeze: {label}" (withSession (set baseSession "freeze" value))) ++
  (optionalStringField.map (fun (label, value) =>
    case s!"session.freeze.reason: {label}"
      (withSession (set baseSession "freeze" (some (set (.obj [("at", int 0)]) "reason" value)))))) ++
  (numberField.map (fun (label, value) =>
    case s!"session.freeze.at: {label}"
      (withSession (set baseSession "freeze" (some (set (.obj [("reason", str "stop")]) "at" value))))))

def itemFields : List (String × JsVal × Json) :=
  (optionalStringField ++
      [("s1#2", some (str "s1#2")), ("s1#01", some (str "s1#01")), ("s1#1.0", some (str "s1#1.0")),
        ("S1#1", some (str "S1#1")), ("s1#1 trailing space", some (str "s1#1 ")),
        ("s2#1", some (str "s2#1")), ("s1#1", some (str "s1#1"))]).map (fun (label, value) =>
    case s!"item.id: {label}" (withItem (set baseItem "id" value))) ++
  numberField.map (fun (label, value) =>
    case s!"item.seq: {label}" (withItem (set baseItem "seq" value))) ++
  numberField.map (fun (label, value) =>
    case s!"item.epoch: {label}" (withItem (set baseItem "epoch" value))) ++
  (optionalStringField ++ [("s2", some (str "s2")), ("s1", some (str "s1"))]).map
    (fun (label, value) => case s!"item.sessionKey: {label}" (withItem (set baseItem "sessionKey" value))) ++
  (itemStates.map (fun state => case s!"item.state: {state}" (withItem (itemIn "s1" 1 state)))) ++
  ((anyType ++ [("exploded", some (str "exploded")), ("Queued", some (str "Queued"))]).map
    (fun (label, value) => case s!"item.state: {label}" (withItem (set baseItem "state" value)))) ++
  ((optionalStringField ++ [("C1:2", some (str "C1:2")), ("C9:1", some (str "C9:1")),
      ("C1:1 trailing space", some (str "C1:1 ")), ("C1:1", some (str "C1:1"))]).map
    (fun (label, value) => case s!"item.eventKey: {label}" (withItem (set baseItem "eventKey" value)))) ++
  (anyType.map (fun (label, value) =>
    case s!"item.message: {label}" (withItem (set baseItem "message" value)))) ++
  (anyType.map (fun (label, value) =>
    case s!"item.context: {label}" (withItem (set baseItem "context" value)))) ++
  (optionalStringField.map (fun (label, value) =>
    case s!"item.context.workingDirectory: {label}"
      (withItem (set baseItem "context" (some (set (.obj []) "workingDirectory" value)))))) ++
  (numberField.map (fun (label, value) =>
    case s!"item.enqueuedAt: {label}" (withItem (set baseItem "enqueuedAt" value)))) ++
  (numberField.map (fun (label, value) =>
    case s!"item.updatedAt: {label}" (withItem (set baseItem "updatedAt" value)))) ++
  (optionalStringField.map (fun (label, value) =>
    case s!"item.stateReason: {label}" (withItem (set baseItem "stateReason" value)))) ++
  (optionalStringField.map (fun (label, value) =>
    case s!"item.steerUuid (queued): {label}" (withItem (set baseItem "steerUuid" value)))) ++
  (optionalStringField.map (fun (label, value) =>
    case s!"item.steerUuid (steered): {label}"
      (withItem (set (item "s1" 1 "steered") "steerUuid" value))))

def messageFields : List (String × JsVal × Json) :=
  (["user", "channel", "ts"].flatMap fun field =>
    optionalStringField.map fun (label, value) =>
      case s!"message.{field}: {label}" (withMessageField field value)) ++
  (messageOptionalTextFields.flatMap fun field =>
    optionalStringField.map fun (label, value) =>
      case s!"message.{field}: {label}" (withMessageField field value)) ++
  (messageOptionalBoolFields.flatMap fun field =>
    optionalBoolField.map fun (label, value) =>
      case s!"message.{field}: {label}" (withMessageField field value)) ++
  [case "message: unknown field survives" (withMessageField "clientMsgId" (some (str "m-1")))] ++
  (anyType.map fun (label, value) =>
    case s!"message.routeContext: {label}" (withMessageField "routeContext" value)) ++
  (routeOptionalTextFields.flatMap fun field =>
    optionalStringField.map fun (label, value) =>
      case s!"message.routeContext.{field}: {label}"
        (withMessageField "routeContext" (some (set (.obj []) field value)))) ++
  (routeOptionalBoolFields.flatMap fun field =>
    optionalBoolField.map fun (label, value) =>
      case s!"message.routeContext.{field}: {label}"
        (withMessageField "routeContext" (some (set (.obj []) field value)))) ++
  (anyType.map fun (label, value) =>
    case s!"message.files: {label}" (withMessageField "files" value)) ++
  [case "message.files: [null]" (withFiles (.arr [.null])),
    case "message.files: [file]" (withFiles (.arr [validFile])),
    case "message.files: [file, file]" (withFiles (.arr [validFile, validFile])),
    case "message.files: [file, null]" (withFiles (.arr [validFile, .null]))] ++
  (fileTextFields.flatMap fun field =>
    optionalStringField.map fun (label, value) =>
      case s!"message.files[0].{field}: {label}" (withFiles (.arr [set validFile field value]))) ++
  (numberField.map fun (label, value) =>
    case s!"message.files[0].size: {label}" (withFiles (.arr [set validFile "size" value])))

def itemWithMessage (key : String) (seq : Nat) (ts : String) : JsVal :=
  set (set (item key seq) "message" (some (message ts))) "eventKey" (some (str s!"C1:{ts}"))

def duplicates : List (String × JsVal × Json) :=
  [case "duplicate: same item twice (id and seq)"
      (snapshot [session "s1" 2 [baseItem, baseItem]]),
    case "duplicate: seq 1 twice, second id tampered"
      (snapshot [session "s1" 2 [baseItem, set (itemWithMessage "s1" 1 "2") "id" (some (str "s1#1-dup"))]]),
    case "duplicate: id and seq of item 0, other message"
      (snapshot [session "s1" 2 [baseItem, itemWithMessage "s1" 1 "2"]]),
    case "duplicate: eventKey only"
      (snapshot [session "s1" 3 [baseItem, itemWithMessage "s1" 2 "1"]]),
    case "duplicate: steerUuid, both steered"
      (snapshot [session "s1" 3 [set (item "s1" 1 "steered") "steerUuid" (some (str "u")),
        set (item "s1" 2 "steered") "steerUuid" (some (str "u"))]]),
    case "duplicate: steerUuid, steered and resolved"
      (snapshot [session "s1" 3 [set (item "s1" 1 "resolved") "steerUuid" (some (str "u")),
        set (item "s1" 2 "steered") "steerUuid" (some (str "u"))]]),
    case "duplicate: steerUuid on queued items"
      (snapshot [session "s1" 3 [set (item "s1" 1) "steerUuid" (some (str "u")),
        set (item "s1" 2) "steerUuid" (some (str "u"))]]),
    case "duplicate: distinct steerUuids are fine"
      (snapshot [session "s1" 3 [itemIn "s1" 1 "steered", itemIn "s1" 2 "steered"]]),
    case "duplicate: eventKey and steerUuid, eventKey reported"
      (snapshot [session "s1" 3 [set (itemWithMessage "s1" 1 "9") "steerUuid" (some (str "u")),
        set (itemWithMessage "s1" 2 "9") "steerUuid" (some (str "u"))]]),
    case "duplicate: items[2] repeats items[0]"
      (snapshot [session "s1" 4 [baseItem, item "s1" 2, baseItem]]),
    case "duplicate: items[1] repeats items[0], items[2] invalid"
      (snapshot [session "s1" 4 [baseItem, baseItem, .null]]),
    case "duplicate: items[1] invalid, items[2] repeats items[0]"
      (snapshot [session "s1" 4 [baseItem, .null, baseItem]]),
    case "duplicate: seq 2 then seq 1 then seq 2"
      (snapshot [session "s1" 4 [item "s1" 2, baseItem, item "s1" 2]])]

/-- Every pair of states in a two-item session (exhaustive: 10 × 10). -/
def statePairs : List (String × JsVal × Json) :=
  itemStates.flatMap fun a => itemStates.map fun b =>
    case s!"states: {a}, {b}" (snapshot [session "s1" 3 [itemIn "s1" 1 a, itemIn "s1" 2 b]])

/-- Every triple over the dispatch-related states in a three-item session (exhaustive: 4^3). -/
def stateTriples : List (String × JsVal × Json) :=
  let states := ["queued", "reserved", "claimed", "dispatched"]
  states.flatMap fun a => states.flatMap fun b => states.map fun c =>
    case s!"states: {a}, {b}, {c}"
      (snapshot [session "s1" 4 [itemIn "s1" 1 a, itemIn "s1" 2 b, itemIn "s1" 3 c]])

/-- Every `nextSeq` in 1..6 against eight seq sets (exhaustive over that grid). -/
def nextSeqGrid : List (String × JsVal × Json) :=
  let seqSets : List (List Nat) := [[], [1], [2], [5], [1, 2], [2, 1], [1, 3], [3, 1, 2]]
  seqSets.flatMap fun seqs => (List.range 6).map fun n =>
    case s!"nextSeq {n + 1} with seqs {seqs}"
      (snapshot [session "s1" (n + 1) (seqs.map fun q => item "s1" q)])

def twoSessions : List (String × JsVal × Json) :=
  [case "sessions: two distinct keys"
      (snapshot [session "s1" 2 [item "s1" 1], session "s2" 2 [item "s2" 1]]),
    case "sessions: duplicate key"
      (snapshot [session "s1" 2 [item "s1" 1], session "s1" 2 [item "s1" 1]]),
    case "sessions: duplicate empty sessions"
      (snapshot [session "s1" 1 [], session "s1" 1 []]),
    case "sessions: second invalid"
      (snapshot [session "s1" 2 [item "s1" 1], session "s2" 1 [item "s2" 1]]),
    case "sessions: first invalid, keys duplicate"
      (snapshot [session "s1" 1 [item "s1" 1], session "s1" 2 [item "s1" 1]]),
    case "sessions: item of s1 filed under s2"
      (snapshot [session "s1" 2 [item "s1" 1], session "s2" 2 [item "s1" 1]]),
    case "sessions: same eventKey, seq and steerUuid in both"
      (snapshot [session "s1" 2 [itemIn "s1" 1 "steered"], session "s2" 2 [itemIn "s2" 1 "steered"]]),
    case "sessions: dispatched in each"
      (snapshot [session "s1" 2 [item "s1" 1 "dispatched"], session "s2" 2 [item "s2" 1 "dispatched"]]),
    case "sessions: key containing #"
      (snapshot [session "s#1" 3 [item "s#1" 1, item "s#1" 2]]),
    case "sessions: keys s and s#1 side by side"
      (snapshot [session "s" 2 [item "s" 1], session "s#1" 2 [item "s#1" 1]])]

def all : List (String × JsVal × Json) :=
  topLevel ++ sessionFields ++ itemFields ++ messageFields ++ duplicates ++ statePairs ++
    stateTriples ++ nextSeqGrid ++ twoSessions

/-- The cases written to `verification/vectors/followup-snapshot.json`. -/
def cases : List Json :=
  all.map (·.2.2)

/-- Every document has distinct keys and no `$js` key, and no two cases share a name. -/
def checked : Bool :=
  all.all (fun c => wellFormed c.2.1) &&
    ((all.map (·.1)).eraseDups.length == all.length)

/-- The cases whose document carries a number that is no Number's value. On such a number the
model judges the exact decimal and the code the Number `JSON.parse` rounds it to, so the vector
would compare two different inputs (see `JsNum`). -/
def notNumberValues : List String :=
  all.filterMap fun c => if numberValues c.2.1 then none else some c.1

end SomaVerify.FollowupSnapshot.Vectors

def main : IO Unit := do
  unless SomaVerify.FollowupSnapshot.Vectors.checked do
    throw (IO.userError "followup-snapshot vectors: a document repeats a key or uses $js, or a name repeats")
  let inexact := SomaVerify.FollowupSnapshot.Vectors.notNumberValues
  unless inexact.isEmpty do
    throw (IO.userError s!"followup-snapshot vectors: a number is not the value of any JS Number (JsNum.isNumberValue) in: {"; ".intercalate inexact}")
  IO.print (SomaVerify.Vectors.render "followup-snapshot" ``SomaVerify.FollowupSnapshot.Vectors.cases
    SomaVerify.FollowupSnapshot.Vectors.cases)
