-- models: packages/slack/src/followup-queue-store.ts:47-64 (ITEM_STATES, PENDING_DISPATCH_STATES)
-- models: packages/slack/src/followup-queue-store.ts:66-68 (fail)
-- models: packages/slack/src/followup-queue-store.ts:70-73 (record)
-- models: packages/slack/src/followup-queue-store.ts:75-78 (array)
-- models: packages/slack/src/followup-queue-store.ts:80-83 (text)
-- models: packages/slack/src/followup-queue-store.ts:85-88 (optionalText)
-- models: packages/slack/src/followup-queue-store.ts:90-92 (optionalBool)
-- models: packages/slack/src/followup-queue-store.ts:94-99 (integer)
-- models: packages/slack/src/followup-queue-store.ts:101-104 (timestamp)
-- models: packages/slack/src/followup-queue-store.ts:106-108 (number)
-- models: packages/slack/src/followup-queue-store.ts:119-153 (validateMessage)
-- models: packages/slack/src/followup-queue-store.ts:155-198 (validateItem)
-- models: packages/slack/src/followup-queue-store.ts:200-263 (validateSession)
-- models: packages/slack/src/followup-queue-store.ts:265-281 (parseFollowupQueueSnapshot)
import SomaVerify.Support.JsString

/-!
# Model of the follow-up queue snapshot gate

`parseFollowupQueueSnapshot` and every helper it calls, one TS statement at a time: the same
checks, in the same order, failing with the same message. Each definition names the TS lines it
transcribes. Where the TS inlines a block (the `routeContext`, `files` and `freeze` blocks, the
state check), the model gives it a name and calls it at the same point, so the order of checks is
unchanged.

## Which values

The gate reads `unknown`. In production that is always a `JSON.parse` result: `load()` parses the
file (`readJsonWithBackup`, TS 331), and `save()` (TS 344) receives the queue's commit, which
`FollowupQueue.commit` passes as `cloneJson(next)`, i.e. `JSON.parse(JSON.stringify(next))`
(packages/slack/src/followup-queue.ts:274-276, 957-958). `JsVal` is those values plus the two that
a caller outside that path can add and the TS tests do add: an explicit `undefined` and `NaN`.

Not modeled, because neither entry point can produce them: sparse arrays, accessors, objects with
a prototype other than `Object.prototype`, and objects with repeated keys (a JS object has
distinct keys; `JSON.parse` keeps the last of repeated ones). No key the gate reads exists on
`Object.prototype`, so a property read never reaches an inherited property.
-/

namespace SomaVerify.FollowupSnapshot

open SomaVerify.JsString

/-- A JavaScript Number (ECMA-262 section 6.1.6.1), described by what the gate can observe of
it. `dec neg m k` is the finite value `(-1)^neg * m / 10^k`, i.e. the Number a decimal literal
denotes; `dec true 0 0` is -0. The conformance vectors only use literals whose binary64 value has
the same integrality, sign and magnitude class as the decimal (small integers, 2^53 - 1, 2^53,
halves), so the decimal reading and the engine's reading agree on every predicate below. -/
inductive JsNum where
  | dec (neg : Bool) (m : Nat) (k : Nat)
  | posInf
  | negInf
  | nan
  deriving DecidableEq, Repr

namespace JsNum

/-- `Number.MAX_SAFE_INTEGER`, 2^53 - 1 (ECMA-262 section 21.1.2.6). -/
def maxSafeInteger : Nat := 9007199254740991

/-- An integer-valued decimal: `dec (i < 0) |i| 0`. -/
def int (i : Int) : JsNum := .dec (decide (i < 0)) i.natAbs 0

/-- `Number.isSafeInteger(x)` (ECMA-262 section 21.1.2.5): an integral Number whose magnitude is
at most 2^53 - 1. Returns the integer it denotes; -0 is a safe integer and denotes 0. -/
def safeInteger? : JsNum → Option Int
  | .dec neg m k =>
    if m % 10 ^ k = 0 ∧ m / 10 ^ k ≤ maxSafeInteger then
      some (if neg then -((m / 10 ^ k : Nat) : Int) else ((m / 10 ^ k : Nat) : Int))
    else none
  | _ => none

/-- `Number.isFinite(x)` (ECMA-262 section 21.1.2.2): neither NaN nor an infinity. -/
def isFinite : JsNum → Bool
  | .dec .. => true
  | _ => false

/-- `x < 0` (ECMA-262 section 7.2.13, IsLessThan): false for -0 and NaN, true for -Infinity. -/
def isNegative : JsNum → Bool
  | .dec neg m _ => neg && m != 0
  | .negInf => true
  | _ => false

/-- `x === 1` (ECMA-262 section 7.2.15, IsStrictlyEqual on Numbers). -/
def isOne : JsNum → Bool
  | .dec neg m k => !neg && m == 10 ^ k
  | _ => false

end JsNum

/-- A JavaScript value as the gate sees it. Object fields are the object's own properties; a
field set to `.undef` is an own property holding `undefined`, which a read cannot tell apart from
an absent one (both read as `undefined`). -/
inductive JsVal where
  | undef
  | null
  | bool (b : Bool)
  | num (x : JsNum)
  | str (s : String)
  | arr (items : List JsVal)
  | obj (fields : List (String × JsVal))
  deriving Inhabited

namespace JsVal

/-- `value === undefined`. -/
def isUndefined : JsVal → Bool
  | .undef => true
  | _ => false

/-- `value === s` for a string `s`: IsStrictlyEqual is true only for a string with the same code
units. -/
def isString (s : String) : JsVal → Bool
  | .str t => t == s
  | _ => false

/-- `value === 1`. -/
def isOne : JsVal → Bool
  | .num x => x.isOne
  | _ => false

/-- `value as string | undefined` after `optionalText` accepted it (TS 193): the string, if
any. -/
def asString? : JsVal → Option String
  | .str s => some s
  | _ => none

end JsVal

/-- `object[key]` (ECMA-262 section 10.1.8.1, OrdinaryGet): the own property `key`, or
`undefined` when there is none. -/
def get : List (String × JsVal) → String → JsVal
  | [], _ => .undef
  | (k, v) :: rest, key => if k = key then v else get rest key

/-- TS 47-61, in declaration order (the order matters: TS 170 prints it with `join('/')`). -/
def itemStates : List String :=
  ["queued", "steered", "reserved", "claimed", "dispatched", "resolved", "failed", "uncertain",
    "paused", "cancelled"]

/-- TS 64. -/
def pendingDispatchStates : List String := ["reserved", "claimed"]

/-- The field lists of the loops in TS 125, 128, 134, 137 and 145. -/
def messageOptionalTextFields : List String :=
  ["team", "thread_ts", "text", "inlineDirectiveRawText", "modelOverride"]
def messageOptionalBoolFields : List String := ["synthetic", "skipDispatch"]
def routeOptionalTextFields : List String := ["sourceChannel", "sourceThreadTs"]
def routeOptionalBoolFields : List String :=
  ["skipAutoBotThread", "compactRedispatch", "goalContinuation"]
def fileTextFields : List String :=
  ["id", "name", "mimetype", "filetype", "url_private", "url_private_download"]

/-- TS 66-68. `where` is a Lean keyword, hence `where_`. -/
def fail {α : Type} (where_ why : String) : Except String α :=
  .error ("followup-queue-store: " ++ where_ ++ " " ++ why)

/-- TS 70-73: `typeof value !== 'object' || value === null || Array.isArray(value)` fails; the
value itself is returned, here as its fields. -/
def record (value : JsVal) (where_ : String) : Except String (List (String × JsVal)) :=
  match value with
  | .obj fields => pure fields
  | _ => fail where_ "is not an object"

/-- TS 75-78. -/
def array (value : JsVal) (where_ : String) : Except String (List JsVal) :=
  match value with
  | .arr items => pure items
  | _ => fail where_ "is not an array"

/-- TS 80-83: `typeof value !== 'string' || value.length === 0` fails. `.length` counts UTF-16
code units (`Support/JsString`). -/
def text (value : JsVal) (where_ : String) : Except String String :=
  match value with
  | .str s => if utf16Length s = 0 then fail where_ "is not a non-empty string" else pure s
  | _ => fail where_ "is not a non-empty string"

/-- TS 85-88: `value !== undefined && typeof value !== 'string'` fails. -/
def optionalText (value : JsVal) (where_ : String) : Except String Unit :=
  match value with
  | .undef | .str _ => pure ()
  | _ => fail where_ "is not a string"

/-- TS 90-92: `value !== undefined && typeof value !== 'boolean'` fails. -/
def optionalBool (value : JsVal) (where_ : String) : Except String Unit :=
  match value with
  | .undef | .bool _ => pure ()
  | _ => fail where_ "is not a boolean"

/-- TS 94-99: `typeof value !== 'number' || !Number.isSafeInteger(value) || value < min` fails,
the three disjuncts in that order, each with the same message. Returns the integer, which is
`≥ min ≥ 0`. -/
def integer (value : JsVal) (where_ : String) (min : Nat) : Except String Nat :=
  match value with
  | .num x =>
    match x.safeInteger? with
    | some i =>
      if i < (min : Int) then fail where_ s!"is not a safe integer >= {min}" else pure i.toNat
    | none => fail where_ s!"is not a safe integer >= {min}"
  | _ => fail where_ s!"is not a safe integer >= {min}"

/-- TS 101-104: `typeof value !== 'number' || !Number.isFinite(value) || value < 0` fails. -/
def timestamp (value : JsVal) (where_ : String) : Except String Unit :=
  match value with
  | .num x =>
    if !x.isFinite || x.isNegative then fail where_ "is not a non-negative finite number"
    else pure ()
  | _ => fail where_ "is not a non-negative finite number"

/-- TS 106-108: `typeof value !== 'number' || !Number.isFinite(value)` fails. -/
def number (value : JsVal) (where_ : String) : Except String Unit :=
  match value with
  | .num x => if !x.isFinite then fail where_ "is not a finite number" else pure ()
  | _ => fail where_ "is not a finite number"

/-- TS 132-140, the `routeContext` block of `validateMessage`; `value` is
`message.routeContext`. -/
def validateRouteContext (value : JsVal) (where_ : String) : Except String Unit := do
  unless value.isUndefined do
    let route ← record value s!"{where_}.routeContext"
    routeOptionalTextFields.forM fun field =>
      optionalText (get route field) s!"{where_}.routeContext.{field}"
    routeOptionalBoolFields.forM fun field =>
      optionalBool (get route field) s!"{where_}.routeContext.{field}"

/-- TS 143-149, the `forEach` over `message.files` from entry `index` on. -/
def validateFileEntries (where_ : String) : Nat → List JsVal → Except String Unit
  | _, [] => pure ()
  | index, entry :: rest => do
    let file ← record entry s!"{where_}.files[{index}]"
    fileTextFields.forM fun field => do
      let _ ← text (get file field) s!"{where_}.files[{index}].{field}"
      pure ()
    number (get file "size") s!"{where_}.files[{index}].size"
    validateFileEntries where_ (index + 1) rest

/-- TS 142-150, the `files` block of `validateMessage`; `value` is `message.files`. -/
def validateFiles (value : JsVal) (where_ : String) : Except String Unit := do
  unless value.isUndefined do
    let entries ← array value s!"{where_}.files"
    validateFileEntries where_ 0 entries

/-- TS 119-153. Returns `(channel, ts)`. -/
def validateMessage (value : JsVal) (where_ : String) : Except String (String × String) := do
  let message ← record value where_
  let _ ← text (get message "user") s!"{where_}.user"
  let channel ← text (get message "channel") s!"{where_}.channel"
  let ts ← text (get message "ts") s!"{where_}.ts"
  messageOptionalTextFields.forM fun field =>
    optionalText (get message field) s!"{where_}.{field}"
  messageOptionalBoolFields.forM fun field =>
    optionalBool (get message field) s!"{where_}.{field}"
  validateRouteContext (get message "routeContext") where_
  validateFiles (get message "files") where_
  pure (channel, ts)

/-- What `validateItem` returns (TS 160). -/
structure ItemRow where
  id : String
  seq : Nat
  eventKey : String
  state : String
  steerUuid : Option String
  deriving DecidableEq, Repr

/-- `id` as TS 167 builds it: the template literal `${sessionKey}#${seq}`. A safe integer
`>= 1` prints in decimal without exponent, which is `toString` on `Nat`. -/
def itemId (sessionKey : String) (seq : Nat) : String :=
  sessionKey ++ "#" ++ toString seq

/-- TS 169-170: `const state = item.state`; `ITEM_STATES.includes(state)` is true only for one of
the listed strings. -/
def itemState (value : JsVal) (where_ : String) : Except String String :=
  match value with
  | .str s =>
    if itemStates.contains s then pure s
    else fail s!"{where_}.state" ("is not one of " ++ "/".intercalate itemStates)
  | _ => fail s!"{where_}.state" ("is not one of " ++ "/".intercalate itemStates)

/-- TS 194, `steerUuid !== undefined && steerUuid.length === 0`. -/
def emptyText : Option String → Bool
  | some s => utf16Length s == 0
  | none => false

/-- TS 195, `!steerUuid`: `undefined` and the empty string are falsy, every other string is
truthy (ECMA-262 section 7.1.2, ToBoolean). -/
def falsy : Option String → Bool
  | some s => utf16Length s == 0
  | none => true

/-- TS 155-198. -/
def validateItem (value : JsVal) (sessionKey where_ : String) : Except String ItemRow := do
  let item ← record value where_
  let id ← text (get item "id") s!"{where_}.id"
  let seq ← integer (get item "seq") s!"{where_}.seq" 1
  let _ ← integer (get item "epoch") s!"{where_}.epoch" 0
  if !(get item "sessionKey").isString sessionKey then
    fail s!"{where_}.sessionKey" s!"does not match its session ({sessionKey})"
  if id != itemId sessionKey seq then
    fail s!"{where_}.id" s!"is not \"<sessionKey>#<seq>\" ({sessionKey}#{seq})"
  let state ← itemState (get item "state") where_
  let eventKey ← text (get item "eventKey") s!"{where_}.eventKey"
  let message ← validateMessage (get item "message") s!"{where_}.message"
  if eventKey != message.1 ++ ":" ++ message.2 then
    fail s!"{where_}.eventKey" "does not match its message channel:ts"
  let context ← record (get item "context") s!"{where_}.context"
  optionalText (get context "workingDirectory") s!"{where_}.context.workingDirectory"
  timestamp (get item "enqueuedAt") s!"{where_}.enqueuedAt"
  timestamp (get item "updatedAt") s!"{where_}.updatedAt"
  optionalText (get item "stateReason") s!"{where_}.stateReason"
  optionalText (get item "steerUuid") s!"{where_}.steerUuid"
  let steerUuid := (get item "steerUuid").asString?
  if emptyText steerUuid then fail s!"{where_}.steerUuid" "is empty"
  if state == "steered" && falsy steerUuid then
    fail s!"{where_}.steerUuid" "is missing on a steered item"
  pure { id, seq, eventKey, state, steerUuid }

/-- The accumulators of `validateSession` (TS 220-226). The lists stand for the `Set`s: `has` is
membership, and `add` only ever receives an element the preceding `has` rejected, so appending
keeps each list free of duplicates. -/
structure Acc where
  ids : List String
  seqs : List Nat
  eventKeys : List String
  steerUuids : List String
  maxSeq : Nat
  pendingDispatch : Nat
  dispatched : Nat

/-- TS 220-226, before the first item. -/
def Acc.empty : Acc := ⟨[], [], [], [], 0, 0, 0⟩

/-- TS 230-250: one `forEach` step after `validateItem` returned `item` for entry `index`. -/
def step (where_ : String) (index : Nat) (item : ItemRow) (acc : Acc) : Except String Acc := do
  if acc.ids.contains item.id then
    fail s!"{where_}.items[{index}].id" s!"is a duplicate ({item.id})"
  if acc.seqs.contains item.seq then
    fail s!"{where_}.items[{index}].seq" s!"is a duplicate ({item.seq})"
  if acc.eventKeys.contains item.eventKey then
    fail s!"{where_}.items[{index}].eventKey" s!"is a duplicate ({item.eventKey})"
  let steerUuids ← match item.steerUuid with
    | some uuid => do
      if acc.steerUuids.contains uuid then
        fail s!"{where_}.items[{index}].steerUuid" s!"is a duplicate ({uuid})"
      pure (acc.steerUuids ++ [uuid])
    | none => pure acc.steerUuids
  pure {
    ids := acc.ids ++ [item.id]
    seqs := acc.seqs ++ [item.seq]
    eventKeys := acc.eventKeys ++ [item.eventKey]
    steerUuids := steerUuids
    maxSeq := max acc.maxSeq item.seq
    pendingDispatch := acc.pendingDispatch + (if pendingDispatchStates.contains item.state then 1 else 0)
    dispatched := acc.dispatched + (if item.state == "dispatched" then 1 else 0) }

/-- TS 228-251: `array(session.items, …).forEach((entry, index) => …)` from entry `index` on. Each
entry is validated (TS 229) before its duplicate checks run, so an invalid entry after a
duplicate is never reached. -/
def itemsLoop (sessionKey where_ : String) : Nat → List JsVal → Acc → Except String Acc
  | _, [], acc => pure acc
  | index, entry :: rest, acc => do
    let item ← validateItem entry sessionKey s!"{where_}.items[{index}]"
    let acc ← step where_ index item acc
    itemsLoop sessionKey where_ (index + 1) rest acc

/-- TS 205-209, the `freeze` block of `validateSession`; `value` is `session.freeze`. -/
def validateFreeze (value : JsVal) (where_ : String) : Except String Unit := do
  unless value.isUndefined do
    let freeze ← record value s!"{where_}.freeze"
    let _ ← text (get freeze "reason") s!"{where_}.freeze.reason"
    timestamp (get freeze "at") s!"{where_}.freeze.at"

/-- TS 200-263. Returns the session key. -/
def validateSession (value : JsVal) (where_ : String) : Except String String := do
  let session ← record value where_
  let sessionKey ← text (get session "sessionKey") s!"{where_}.sessionKey"
  let nextSeq ← integer (get session "nextSeq") s!"{where_}.nextSeq" 1
  validateFreeze (get session "freeze") where_
  let _ ← integer (get session "turnEpoch") s!"{where_}.turnEpoch" 0
  let entries ← array (get session "items") s!"{where_}.items"
  let acc ← itemsLoop sessionKey where_ 0 entries Acc.empty
  if nextSeq ≤ acc.maxSeq then
    fail s!"{where_}.nextSeq" s!"({nextSeq}) collides with an existing seq (max {acc.maxSeq})"
  if acc.pendingDispatch > 1 then
    fail s!"{where_}.items" s!"has {acc.pendingDispatch} items in reserved/claimed (max 1)"
  if acc.dispatched > 1 then
    fail s!"{where_}.items" s!"has {acc.dispatched} items in dispatched (max 1)"
  pure sessionKey

/-- TS 273-278: the `forEach` over `snapshot.sessions` from entry `index` on; `keys` is the `Set`
of the keys seen so far. -/
def sessionsLoop : Nat → List JsVal → List String → Except String Unit
  | _, [], _ => pure ()
  | index, entry :: rest, keys => do
    let sessionKey ← validateSession entry s!"snapshot.sessions[{index}]"
    if keys.contains sessionKey then
      fail s!"snapshot.sessions[{index}].sessionKey" s!"is a duplicate ({sessionKey})"
    sessionsLoop (index + 1) rest (keys ++ [sessionKey])

/-- TS 269-281. `record` returns its argument itself (TS 72), so `return snapshot` returns
`raw`. -/
def parseFollowupQueueSnapshot (raw : JsVal) : Except String JsVal := do
  let snapshot ← record raw "snapshot"
  if !(get snapshot "version").isOne then fail "snapshot.version" "is not 1"
  let entries ← array (get snapshot "sessions") "snapshot.sessions"
  sessionsLoop 0 entries []
  pure raw

/-- The gate as a validator: `ok ()` exactly when `parseFollowupQueueSnapshot` returns. -/
def validate (raw : JsVal) : Except String Unit :=
  (parseFollowupQueueSnapshot raw).map fun _ => ()

end SomaVerify.FollowupSnapshot
