-- models: packages/slack/src/followup-queue-store.ts:155-198 at b1e1b464 (validateItem, before phase 2)
-- models: packages/slack/src/followup-queue-store.ts:200-263 at b1e1b464 (validateSession, before phase 2)
-- models: packages/slack/src/followup-queue-store.ts:265-281 at b1e1b464 (parseFollowupQueueSnapshot, before phase 2)
import SomaVerify.FollowupSnapshot.Model

/-!
# The gate as phase 1 modeled it

The functions the proof-backed simplification changed, exactly as phase 1 transcribed them from
commit b1e1b464, before it: `validateItem` with `!steerUuid` (TS 195) and `validateSession` with
the `seqs` set (TS 221, 231, 246), plus the functions that call them. TS line numbers in this file
refer to that commit. Everything else is shared with `Model.lean`, whose functions the
simplification did not change.

Phase 1 left sparse arrays out of the value domain. On a hole the TS of that commit differed from
this model: its `forEach` skipped the index, where the model reads an `.undef` item. That was the
finding phase 2 fixed first (the gate now walks arrays with `for…of`), so on sparse arrays this
model describes the fixed TS, not the TS of that commit.

`Proofs.lean` shows the current gate equals this one on every input (`parse_eq_original`), which
is what carries the theorems of `ProofsOriginal.lean` over to the current gate.
-/

namespace SomaVerify.FollowupSnapshot.Original

open SomaVerify.FollowupSnapshot SomaVerify.JsString

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

end SomaVerify.FollowupSnapshot.Original
