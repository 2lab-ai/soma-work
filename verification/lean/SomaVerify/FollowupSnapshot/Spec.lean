import SomaVerify.FollowupSnapshot.Model

/-!
# The snapshot gate's invariants, stated declaratively

`ValidSnapshot raw` says what a snapshot the gate accepts looks like, without the gate's
machinery: no accumulators, no loop order, no error messages. Uniqueness is `List.Nodup`, the
ceilings are `List.countP`, and "`nextSeq` is past every seq" is a `∀`. `Proofs.lean` shows the
model accepts exactly these values (`validate_ok_iff`).

The atomic JavaScript predicates (`JsNum.safeInteger?`, `JsNum.isFinite`, `JsNum.isNegative`,
`JsVal.isOne`, the property read `get`) and the field-name lists are the model's vocabulary,
reused here: this file adds the structure over them, i.e. which fields are required, which are
optional, what must be unique and what is bounded.

Each definition quotes the TS comment it formalizes (packages/slack/src/followup-queue-store.ts),
or names the TS lines that are its only source when the code carries no comment.
-/

namespace SomaVerify.FollowupSnapshot.Spec

open SomaVerify.FollowupSnapshot

/-- `R` relates the two lists position by position. -/
inductive Forall₂ {α β : Type} (R : α → β → Prop) : List α → List β → Prop
  | nil : Forall₂ R [] []
  | cons {a : α} {b : β} {as : List α} {bs : List β} :
      R a b → Forall₂ R as bs → Forall₂ R (a :: as) (b :: bs)

/-! ## Field shapes (TS 70-108) -/

/-- The string `s`, not empty (TS 80-83). -/
def NonEmptyString (v : JsVal) (s : String) : Prop :=
  v = .str s ∧ s ≠ ""

/-- TS 85: "Optional fields are checked when present and left untouched when absent." -/
def OptionalString (v : JsVal) : Prop :=
  v = .undef ∨ ∃ s, v = .str s

/-- Same rule for booleans (TS 90-92). -/
def OptionalBool (v : JsVal) : Prop :=
  v = .undef ∨ ∃ b, v = .bool b

/-- A Number that is a safe integer denoting `n`, and `n ≥ min` (TS 94-99). -/
def SafeIntegerAtLeast (min : Nat) (v : JsVal) (n : Nat) : Prop :=
  ∃ x, v = .num x ∧ x.safeInteger? = some (n : Int) ∧ min ≤ n

/-- A finite Number that is not below 0 (TS 101-104). -/
def NonNegativeFinite (v : JsVal) : Prop :=
  ∃ x, v = .num x ∧ x.isFinite = true ∧ x.isNegative = false

/-- A finite Number (TS 106-108). -/
def FiniteNumber (v : JsVal) : Prop :=
  ∃ x, v = .num x ∧ x.isFinite = true

/-! ## The stored Slack payload (TS 110-153) -/

/-- One entry of `message.files` (TS 144-148). -/
def ValidFile (v : JsVal) : Prop :=
  ∃ fs, v = .obj fs ∧ (∀ f ∈ fileTextFields, ∃ s, NonEmptyString (get fs f) s) ∧
    FiniteNumber (get fs "size")

/-- `message.routeContext` (TS 132-140): absent, or an object of optional strings and
booleans. -/
def ValidRouteContext (v : JsVal) : Prop :=
  v = .undef ∨ ∃ fs, v = .obj fs ∧
    (∀ f ∈ routeOptionalTextFields, OptionalString (get fs f)) ∧
    (∀ f ∈ routeOptionalBoolFields, OptionalBool (get fs f))

/-- `message.files` (TS 142-150): absent, or an array of valid entries. -/
def ValidFiles (v : JsVal) : Prop :=
  v = .undef ∨ ∃ entries, v = .arr entries ∧ ∀ e ∈ entries, ValidFile e

/-- TS 113-117: "The object is checked, never rebuilt: unknown/newer optional fields … must
survive a round-trip verbatim". So this is a predicate on the payload, and says nothing about
fields it does not name. `channel` and `ts` are the values `eventKey` must agree with. -/
def ValidMessage (v : JsVal) (channel ts : String) : Prop :=
  ∃ fs, v = .obj fs ∧
    (∃ user, NonEmptyString (get fs "user") user) ∧
    NonEmptyString (get fs "channel") channel ∧
    NonEmptyString (get fs "ts") ts ∧
    (∀ f ∈ messageOptionalTextFields, OptionalString (get fs f)) ∧
    (∀ f ∈ messageOptionalBoolFields, OptionalBool (get fs f)) ∧
    ValidRouteContext (get fs "routeContext") ∧
    ValidFiles (get fs "files")

/-! ## One item (TS 155-198) -/

/-- The `steerUuid` field and the value the row carries for it. TS 188-191: "the uuid is the
ONLY identity a settlement receipt carries (06 §6.6), so an empty one names nothing". -/
def SteerUuidField (v : JsVal) : Option String → Prop
  | none => v = .undef
  | some uuid => v = .str uuid ∧ uuid ≠ ""

/-- The item `v` of the session `key`, read as `row`. TS 155: "Identity must be self-consistent
— a mismatch means tampered/skewed state, not a repair job": the item names its session, its id
is `<sessionKey>#<seq>` (TS 167), and its `eventKey` is its message's `channel:ts` (TS 174).
TS 189-191: "a `steered` row without one [a uuid] can never be resolved, unsteered or cancelled
— it would sit in the panel forever". -/
def ValidItem (key : String) (v : JsVal) (row : ItemRow) : Prop :=
  ∃ fs, v = .obj fs ∧
    NonEmptyString (get fs "id") row.id ∧
    SafeIntegerAtLeast 1 (get fs "seq") row.seq ∧
    (∃ epoch, SafeIntegerAtLeast 0 (get fs "epoch") epoch) ∧
    get fs "sessionKey" = .str key ∧
    row.id = itemId key row.seq ∧
    get fs "state" = .str row.state ∧ row.state ∈ itemStates ∧
    NonEmptyString (get fs "eventKey") row.eventKey ∧
    (∃ channel ts, ValidMessage (get fs "message") channel ts ∧
      row.eventKey = channel ++ ":" ++ ts) ∧
    (∃ context, get fs "context" = .obj context ∧
      OptionalString (get context "workingDirectory")) ∧
    NonNegativeFinite (get fs "enqueuedAt") ∧
    NonNegativeFinite (get fs "updatedAt") ∧
    OptionalString (get fs "stateReason") ∧
    SteerUuidField (get fs "steerUuid") row.steerUuid ∧
    (row.state = "steered" → row.steerUuid ≠ none)

/-! ## One session (TS 200-263) -/

/-- TS 63: "At most one item per session may be setting up a dispatch (single winner, A12)." -/
def isPendingDispatch (row : ItemRow) : Bool :=
  pendingDispatchStates.contains row.state

/-- TS 258: "One in-flight turn per session, enforced by `markDispatched`." -/
def isDispatched (row : ItemRow) : Bool :=
  row.state == "dispatched"

/-- The session's rows are pairwise distinct in each identity the queue addresses them by.
TS 232-233: "Two rows for one Slack event means the dedup key (A3) was already broken on disk".
TS 235-238: "the uuid is how a settlement is addressed (`mutateBySteerUuid`), so two rows sharing
one would make a single receipt settle whichever the scan hit first". Ids and seqs: TS 230-231
(no comment there). -/
def UniqueRows (rows : List ItemRow) : Prop :=
  (rows.map (·.id)).Nodup ∧ (rows.map (·.seq)).Nodup ∧ (rows.map (·.eventKey)).Nodup ∧
    (rows.filterMap (·.steerUuid)).Nodup

/-- `session.freeze` (TS 205-209): absent, or a non-empty reason and a timestamp. -/
def ValidFreeze (v : JsVal) : Prop :=
  v = .undef ∨ ∃ fs, v = .obj fs ∧ (∃ reason, NonEmptyString (get fs "reason") reason) ∧
    NonNegativeFinite (get fs "at")

/-- The session `v`, whose key is `key`.
TS 211-217: `turnEpoch` is "Required, not optional … defaulting a missing value to 0 would
silently mint a turn generation".
TS 253: "A reused nextSeq would hand a later enqueue an id that already exists."
TS 255-256: "`dispatched` + `reserved` is legal …; two items *setting up* a dispatch is not".
TS 258-259: "Two on disk is skew or tampering". -/
def ValidSession (v : JsVal) (key : String) : Prop :=
  ∃ fs nextSeq entries rows, v = .obj fs ∧
    NonEmptyString (get fs "sessionKey") key ∧
    SafeIntegerAtLeast 1 (get fs "nextSeq") nextSeq ∧
    ValidFreeze (get fs "freeze") ∧
    (∃ turnEpoch, SafeIntegerAtLeast 0 (get fs "turnEpoch") turnEpoch) ∧
    get fs "items" = .arr entries ∧
    Forall₂ (ValidItem key) entries rows ∧
    UniqueRows rows ∧
    (∀ row ∈ rows, row.seq < nextSeq) ∧
    rows.countP isPendingDispatch ≤ 1 ∧
    rows.countP isDispatched ≤ 1

/-! ## The snapshot (TS 265-281) -/

/-- What the gate accepts. TS 15-19: everything read back is "validated in full and
**rejected**, never silently repaired"; TS 276: session keys are unique. -/
def ValidSnapshot (raw : JsVal) : Prop :=
  ∃ fs entries keys, raw = .obj fs ∧
    (get fs "version").isOne = true ∧
    get fs "sessions" = .arr entries ∧
    Forall₂ ValidSession entries keys ∧
    keys.Nodup

end SomaVerify.FollowupSnapshot.Spec
