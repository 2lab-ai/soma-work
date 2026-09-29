import SomaVerify.FollowupSnapshot.ProofsOriginal

/-!
# Proofs about the gate

The gate as it is now (`Model.lean`), after the proof-backed simplification of phase 2:

* **C1** deleted the `seqs` set: its declaration, its duplicate check and its `add` (at b1e1b464,
  TS 221, 231 and 246);
* **C2** replaced `!steerUuid` with `steerUuid === undefined` (TS 201).

`parse_eq_original` shows the simplified gate returns the same value or fails with the same
message as the original (`ModelOriginal.lean`) on every input. `ProofsOriginal.lean` holds the
phase-1 proofs about the original; this file carries them over:

* **(a)** `validate_ok_iff`: the gate accepts a value exactly when `ValidSnapshot` holds for it.
* **(b)** `accumulator_eq_declarative`: the three `Set`s and three counters of TS 226-263,
  updated in loop order, say the same as the declarative uniqueness and counting clauses: seq
  uniqueness included, because ids are `<sessionKey>#<seq>`.
* **(c)** `toString_injective`, `itemId_injective` and `ids_nodup_iff_seqs_nodup`: within a session
  a repeated seq is a repeated id. `step_repeated_seq_reports_id`: the simplified gate reports
  it with the duplicate-id message, as the original did.
* **(d)** `parse_returns_input`: what the gate returns is its input.

The field- and payload-level lemmas (`record_ok_iff`, `validateMessage_ok_iff`, …) are about
functions both models share, so the ones in `ProofsOriginal.lean` apply to this gate as they stand.
-/

namespace SomaVerify.FollowupSnapshot.Proofs

open SomaVerify.FollowupSnapshot SomaVerify.FollowupSnapshot.Spec SomaVerify.JsString
open SomaVerify.FollowupSnapshot.Original.Proofs (bind_ok_iff pure_ok_iff fail_bind
  ite_fail_ok_iff map_bind bind_map map_fail map_pure pure_bind nodup_append_singleton_iff
  nodup_append_toList_iff)

/-! ## (c) Ids are injective in seqs -/

/-- **(c)** Decimal printing of natural numbers is injective: core's `Nat.ofDigitChars` reads the
digits back (`Nat.ofDigitChars_ten_toDigits`), so two naturals with the same decimal string are
equal. -/
theorem toString_injective {a b : Nat} (h : toString a = toString b) : a = b := by
  have hd := congrArg (fun s : String => Nat.ofDigitChars 10 s.toList 0) h
  simpa [Nat.toString_eq_repr, Nat.toList_repr, Nat.ofDigitChars_ten_toDigits] using hd

/-- **(c)** For a fixed session key, the id `<sessionKey>#<seq>` (TS 173) determines the seq. -/
theorem itemId_injective {key : String} {a b : Nat} (h : itemId key a = itemId key b) :
    a = b := by
  unfold itemId at h
  have hl := congrArg String.toList h
  simp only [String.toList_append, List.append_assoc, List.append_cancel_left_eq] at hl
  exact toString_injective (String.ext hl)

/-- **(c)** Two ids of one session are equal exactly when their seqs are. -/
theorem itemId_eq_iff {key : String} {a b : Nat} : itemId key a = itemId key b ↔ a = b :=
  ⟨itemId_injective, fun h => h ▸ rfl⟩

/-- Every row of a valid session carries the id `<sessionKey>#<seq>`. -/
theorem id_eq_itemId_of_forall₂ {key : String} {entries : List JsVal} {rows : List ItemRow}
    (h : Forall₂ (ValidItem key) entries rows) : ∀ row ∈ rows, row.id = itemId key row.seq := by
  induction h with
  | nil => simp
  | cons hrow _ ih =>
    intro row hmem
    rw [List.mem_cons] at hmem
    rcases hmem with rfl | hmem
    · obtain ⟨_, _, _, _, _, _, hid, _⟩ := hrow
      exact hid
    · exact ih row hmem

/-- **(c)** Within one session two rows have the same id exactly when they have the same seq. -/
theorem id_eq_iff_seq_eq {key : String} {r₁ r₂ : ItemRow} (h₁ : r₁.id = itemId key r₁.seq)
    (h₂ : r₂.id = itemId key r₂.seq) : r₁.id = r₂.id ↔ r₁.seq = r₂.seq := by
  rw [h₁, h₂, itemId_eq_iff]

/-- **(c)** Hence a session has a duplicate id exactly when it has a duplicate seq: of the two
uniqueness clauses of `UniqueRows`, either implies the other. -/
theorem ids_nodup_iff_seqs_nodup {key : String} {rows : List ItemRow}
    (h : ∀ row ∈ rows, row.id = itemId key row.seq) :
    (rows.map (·.id)).Nodup ↔ (rows.map (·.seq)).Nodup := by
  have hmap : rows.map (·.id) = (rows.map (·.seq)).map (itemId key) := by
    rw [List.map_map]
    exact List.map_congr_left h
  rw [hmap]
  unfold List.Nodup
  rw [List.pairwise_map]
  exact List.Pairwise.iff fun a b => by simp [itemId_eq_iff]

/-- **(c)** In a session the gate accepts, its ids are duplicate-free exactly when its seqs
are, so either uniqueness clause of `UniqueRows` implies the other. -/
theorem validItems_ids_nodup_iff_seqs_nodup {key : String} {entries : List JsVal}
    {rows : List ItemRow} (h : Forall₂ (ValidItem key) entries rows) :
    (rows.map (·.id)).Nodup ↔ (rows.map (·.seq)).Nodup :=
  ids_nodup_iff_seqs_nodup (id_eq_itemId_of_forall₂ h)

/-! ## The simplified gate equals the original -/

/-- The original accumulator with its `seqs` set forgotten: the simplified accumulator. -/
def _root_.SomaVerify.FollowupSnapshot.Original.Acc.withoutSeqs (acc : Original.Acc) : Acc :=
  ⟨acc.ids, acc.eventKeys, acc.steerUuids, acc.maxSeq, acc.pendingDispatch, acc.dispatched⟩

/-- Before the first item the two accumulators agree. -/
theorem withoutSeqs_empty : Original.Acc.empty.withoutSeqs = Acc.empty := rfl

/-- **C2 equality.** `validateItem` testing `steerUuid === undefined` at TS 201 returns the same
row or fails with the same message as the original testing `!steerUuid`, on every input. The two
tests differ only on the empty uuid, which TS 200 rejects first. -/
theorem validateItem_eq_original (v : JsVal) (key w : String) :
    validateItem v key w = Original.validateItem v key w := by
  cases v with
  | obj fs =>
    simp only [validateItem, Original.validateItem, record, pure_bind]
    generalize (get fs "steerUuid").asString? = uuid
    cases uuid with
    | none => rfl
    | some u =>
      by_cases hl : utf16Length u = 0
      · simp only [emptyText, hl, beq_self_eq_true, ↓reduceIte, fail_bind]
      · have hne : (utf16Length u == 0) = false := by simpa using hl
        simp only [emptyText, Original.falsy, Option.isNone, hne]
  | _ => rfl

/-- One step, original against simplified: under the invariant that the id set is the seq set
mapped through `<sessionKey>#·`, the original's seq check never fires (`seq_check_unreachable`),
so both fail with the same message or both return the same accumulator, `seqs` aside. -/
theorem step_eq_original {key w : String} {i : Nat} {row : ItemRow} {acc : Original.Acc}
    (hinv : Original.Proofs.IdsMatchSeqs key acc) (hrow : row.id = itemId key row.seq) :
    (Original.step w i row acc).map Original.Acc.withoutSeqs = step w i row acc.withoutSeqs := by
  unfold Original.step step
  simp only [Original.Acc.withoutSeqs]
  by_cases hid : acc.ids.contains row.id = true
  · simp only [hid, ↓reduceIte, fail_bind, map_fail]
  · have hseq := Original.Proofs.seq_check_unreachable hinv hrow (Bool.not_eq_true _ ▸ hid)
    simp only [hid, hseq, Bool.false_eq_true, ↓reduceIte]
    by_cases hek : acc.eventKeys.contains row.eventKey = true
    · simp only [hek, ↓reduceIte, fail_bind, map_fail]
    · simp only [hek, Bool.false_eq_true, ↓reduceIte]
      cases hsu : row.steerUuid with
      | none =>
        simp only [pure_bind, map_pure]
        rfl
      | some u =>
        by_cases hu : acc.steerUuids.contains u = true
        · simp only [hu, ↓reduceIte, fail_bind, map_fail]
        · simp only [hu, Bool.false_eq_true, ↓reduceIte, pure_bind, map_pure]
          rfl

/-- The items loop, original against simplified: same error, or the same accumulator with
`seqs` forgotten. -/
theorem itemsLoop_eq_original {key w : String} {entries : List JsVal} :
    ∀ {i : Nat} {acc : Original.Acc}, Original.Proofs.IdsMatchSeqs key acc →
      (Original.itemsLoop key w i entries acc).map Original.Acc.withoutSeqs =
        itemsLoop key w i entries acc.withoutSeqs := by
  induction entries with
  | nil => intro i acc _; rfl
  | cons e es ih =>
    intro i acc hinv
    simp only [Original.itemsLoop, itemsLoop, map_bind, validateItem_eq_original]
    cases hv : Original.validateItem e key s!"{w}.items[{i}]" with
    | error err => rfl
    | ok row =>
      have hrow : row.id = itemId key row.seq := by
        obtain ⟨_, _, _, _, _, _, hid, _⟩ := Original.Proofs.validateItem_ok_iff.1 hv
        exact hid
      simp only [bind, Except.bind]
      rw [← step_eq_original hinv hrow]
      cases hs : Original.step w i row acc with
      | error err => rfl
      | ok acc₁ =>
        obtain ⟨_, rfl⟩ := Original.Proofs.step_ok_iff.1 hs
        exact ih (Original.Proofs.idsMatchSeqs_push hinv hrow)

/-- **C1 and C2 equality, one session.** The simplified session check returns the same key or
fails with the same message as the original, on every input. -/
theorem validateSession_eq_original (v : JsVal) (w : String) :
    validateSession v w = Original.validateSession v w := by
  have hloop : ∀ key entries, itemsLoop key w 0 entries Acc.empty =
      (Original.itemsLoop key w 0 entries Original.Acc.empty).map Original.Acc.withoutSeqs :=
    fun key _ => (itemsLoop_eq_original (Original.Proofs.idsMatchSeqs_empty key)).symm
  unfold validateSession Original.validateSession
  simp only [hloop, bind_map]
  rfl

/-- The sessions loop, simplified against original: equal on every input. -/
theorem sessionsLoop_eq_original (entries : List JsVal) :
    ∀ (i : Nat) (keys : List String),
      sessionsLoop i entries keys = Original.sessionsLoop i entries keys := by
  induction entries with
  | nil => intro i keys; rfl
  | cons e es ih =>
    intro i keys
    simp only [sessionsLoop, Original.sessionsLoop, validateSession_eq_original, ih]

/-- **C1 and C2 equality.** The simplified gate returns the same value or fails with the same
message as the original on every input: deleting the `seqs` set and testing
`steerUuid === undefined` changed nothing a caller can observe. -/
theorem parse_eq_original (raw : JsVal) :
    parseFollowupQueueSnapshot raw = Original.parseFollowupQueueSnapshot raw := by
  unfold parseFollowupQueueSnapshot Original.parseFollowupQueueSnapshot
  simp only [sessionsLoop_eq_original]

/-- The same, as a validator. -/
theorem validate_eq_original (raw : JsVal) : validate raw = Original.validate raw := by
  unfold validate Original.validate
  rw [parse_eq_original]

/-! ## (a) and (d) for the simplified gate, carried through the equality -/

/-- **(a) Soundness and completeness.** The gate accepts a value exactly when it satisfies the
declarative `ValidSnapshot`. -/
theorem validate_ok_iff {raw : JsVal} : validate raw = .ok () ↔ ValidSnapshot raw := by
  rw [validate_eq_original]
  exact Original.Proofs.validate_ok_iff

/-- The gate returns exactly on the snapshots `ValidSnapshot` describes, and what it returns is
its input. -/
theorem parse_ok_iff {raw v : JsVal} :
    parseFollowupQueueSnapshot raw = .ok v ↔ ValidSnapshot raw ∧ v = raw := by
  rw [parse_eq_original]
  exact Original.Proofs.parse_ok_iff

/-- **(d) The gate never repairs.** TS 269-270: "returns the input unchanged on success so no
field is lost in translation". -/
theorem parse_returns_input {raw v : JsVal} (h : parseFollowupQueueSnapshot raw = .ok v) :
    v = raw :=
  (parse_ok_iff.1 h).2

/-- (d), as one equation: the gate is the identity on the snapshots it accepts and fails on the
others. -/
theorem parse_eq_validate_then_input (raw : JsVal) :
    parseFollowupQueueSnapshot raw = (validate raw).map fun _ => raw := by
  rw [parse_eq_original, validate_eq_original]
  exact Original.Proofs.parse_eq_validate_then_input raw

/-- The sessions loop (TS 276-281) succeeds exactly when every entry is a valid session and the
keys, after the ones already seen, are duplicate-free. -/
theorem sessionsLoop_ok_iff {entries : List JsVal} {i : Nat} {keys0 : List String} {u : Unit}
    (h0 : keys0.Nodup) :
    sessionsLoop i entries keys0 = .ok u ↔
      ∃ keys, Forall₂ ValidSession entries keys ∧ (keys0 ++ keys).Nodup := by
  rw [sessionsLoop_eq_original]
  exact Original.Proofs.sessionsLoop_ok_iff h0

/-- The session check accepts exactly the sessions `ValidSession` describes, and returns their
key. -/
theorem validateSession_ok_iff {v : JsVal} {w key : String} :
    validateSession v w = .ok key ↔ ValidSession v key := by
  rw [validateSession_eq_original]
  exact Original.Proofs.validateSession_ok_iff

/-- The item check accepts exactly the items `ValidItem` describes, and returns the row it
reads. -/
theorem validateItem_ok_iff {v : JsVal} {key w : String} {row : ItemRow} :
    validateItem v key w = .ok row ↔ ValidItem key v row := by
  rw [validateItem_eq_original]
  exact Original.Proofs.validateItem_ok_iff

/-! ## (b) The simplified accumulator equals the declarative form -/

/-- What TS 247-253 do to the accumulator once `row` passed its duplicate checks. -/
def _root_.SomaVerify.FollowupSnapshot.Acc.push (acc : Acc) (row : ItemRow) : Acc where
  ids := acc.ids ++ [row.id]
  eventKeys := acc.eventKeys ++ [row.eventKey]
  steerUuids := acc.steerUuids ++ row.steerUuid.toList
  maxSeq := max acc.maxSeq row.seq
  pendingDispatch := acc.pendingDispatch + (if isPendingDispatch row then 1 else 0)
  dispatched := acc.dispatched + (if isDispatched row then 1 else 0)

/-- `row` passes the duplicate checks of TS 235-246 against `acc`. -/
def Fresh (acc : Acc) (row : ItemRow) : Prop :=
  row.id ∉ acc.ids ∧ row.eventKey ∉ acc.eventKeys ∧
    ∀ uuid, row.steerUuid = some uuid → uuid ∉ acc.steerUuids

/-- The accumulator form of the session checks: each row passes the duplicate checks against the
accumulator of the rows before it, in loop order. -/
def FreshInOrder : Acc → List ItemRow → Prop
  | _, [] => True
  | acc, row :: rows => Fresh acc row ∧ FreshInOrder (acc.push row) rows

/-- One step of the items loop (TS 235-253) succeeds exactly when the row is fresh against the
accumulator, and then returns the accumulator with the row pushed. -/
theorem step_ok_iff {w : String} {i : Nat} {row : ItemRow} {acc acc' : Acc} :
    step w i row acc = .ok acc' ↔ Fresh acc row ∧ acc' = acc.push row := by
  unfold step Fresh Acc.push isPendingDispatch isDispatched
  cases h : row.steerUuid with
  | none =>
    simp only [ite_fail_ok_iff, fail_bind, bind_ok_iff, pure_ok_iff, exists_eq_left',
      Option.toList_none, List.append_nil, reduceCtorEq, false_implies, implies_true, and_true]
    constructor
    · rintro ⟨h1, h2, rfl⟩
      exact ⟨⟨by simpa using h1, by simpa using h2⟩, rfl⟩
    · rintro ⟨⟨h1, h2⟩, rfl⟩
      exact ⟨by simpa using h1, by simpa using h2, rfl⟩
  | some u =>
    simp only [ite_fail_ok_iff, fail_bind, bind_ok_iff, pure_ok_iff, exists_eq_left',
      Option.toList_some, Option.some.injEq, forall_eq']
    constructor
    · rintro ⟨h1, h2, h3, rfl⟩
      exact ⟨⟨by simpa using h1, by simpa using h2, by simpa using h3⟩, rfl⟩
    · rintro ⟨⟨h1, h2, h3⟩, rfl⟩
      exact ⟨by simpa using h1, by simpa using h2, by simpa using h3, rfl⟩

/-- The items loop succeeds exactly when every entry is a valid item and the rows pass the
duplicate checks in order; the accumulator it returns is the rows pushed in order. -/
theorem itemsLoop_ok_iff {key w : String} {entries : List JsVal} {i : Nat} {acc acc' : Acc} :
    itemsLoop key w i entries acc = .ok acc' ↔
      ∃ rows, Forall₂ (ValidItem key) entries rows ∧ FreshInOrder acc rows ∧
        acc' = rows.foldl Acc.push acc := by
  induction entries generalizing i acc with
  | nil =>
    simp only [itemsLoop, pure_ok_iff]
    constructor
    · rintro rfl
      exact ⟨[], .nil, trivial, rfl⟩
    · rintro ⟨rows, hrows, _, rfl⟩
      cases hrows
      rfl
  | cons e es ih =>
    simp only [itemsLoop, bind_ok_iff, validateItem_ok_iff, step_ok_iff, ih]
    constructor
    · rintro ⟨row, hrow, _, ⟨hfresh, rfl⟩, rows, hrows, hfio, rfl⟩
      exact ⟨row :: rows, .cons hrow hrows, ⟨hfresh, hfio⟩, rfl⟩
    · rintro ⟨rows, hrows, hfio, rfl⟩
      cases hrows with
      | cons hrow hrows' => exact ⟨_, hrow, _, ⟨hfio.1, rfl⟩, _, hrows', hfio.2, rfl⟩

/-- Pushing a row keeps the three identity lists duplicate-free exactly when the row is fresh. -/
theorem fresh_iff_push_nodup {acc : Acc} {row : ItemRow} (hids : acc.ids.Nodup)
    (heks : acc.eventKeys.Nodup) (huuids : acc.steerUuids.Nodup) :
    Fresh acc row ↔ (acc.push row).ids.Nodup ∧ (acc.push row).eventKeys.Nodup ∧
      (acc.push row).steerUuids.Nodup := by
  simp only [Fresh, Acc.push, nodup_append_singleton_iff hids, nodup_append_singleton_iff heks,
    nodup_append_toList_iff huuids]

/-- From a duplicate-free accumulator, the rows pass the duplicate checks in order exactly when
the accumulator's lists extended with the rows' identities stay duplicate-free. -/
theorem freshInOrder_iff {rows : List ItemRow} : ∀ {acc : Acc}, acc.ids.Nodup →
    acc.eventKeys.Nodup → acc.steerUuids.Nodup →
    (FreshInOrder acc rows ↔
      (acc.ids ++ rows.map (·.id)).Nodup ∧ (acc.eventKeys ++ rows.map (·.eventKey)).Nodup ∧
        (acc.steerUuids ++ rows.filterMap (·.steerUuid)).Nodup) := by
  induction rows with
  | nil =>
    intro acc hids heks huuids
    simp [FreshInOrder, hids, heks, huuids]
  | cons row rows ih =>
    intro acc hids heks huuids
    have e1 : acc.ids ++ (row :: rows).map (·.id) = (acc.push row).ids ++ rows.map (·.id) := by
      simp [Acc.push]
    have e2 : acc.eventKeys ++ (row :: rows).map (·.eventKey) =
        (acc.push row).eventKeys ++ rows.map (·.eventKey) := by
      simp [Acc.push]
    have e3 : acc.steerUuids ++ (row :: rows).filterMap (·.steerUuid) =
        (acc.push row).steerUuids ++ rows.filterMap (·.steerUuid) := by
      cases h : row.steerUuid <;> simp [Acc.push, h]
    rw [e1, e2, e3]
    simp only [FreshInOrder]
    constructor
    · rintro ⟨hf, hrest⟩
      obtain ⟨p1, p2, p3⟩ := (fresh_iff_push_nodup hids heks huuids).1 hf
      exact (ih p1 p2 p3).1 hrest
    · rintro ⟨n1, n2, n3⟩
      have p1 := (List.nodup_append.1 n1).1
      have p2 := (List.nodup_append.1 n2).1
      have p3 := (List.nodup_append.1 n3).1
      exact ⟨(fresh_iff_push_nodup hids heks huuids).2 ⟨p1, p2, p3⟩,
        (ih p1 p2 p3).2 ⟨n1, n2, n3⟩⟩

/-- The accumulator after pushing `rows`: the identity lists are the rows' identities in order,
the counters are counts, and `maxSeq` is below `n` exactly when every seq is. -/
theorem foldl_push {rows : List ItemRow} : ∀ {acc : Acc},
    (rows.foldl Acc.push acc).ids = acc.ids ++ rows.map (·.id) ∧
    (rows.foldl Acc.push acc).eventKeys = acc.eventKeys ++ rows.map (·.eventKey) ∧
    (rows.foldl Acc.push acc).steerUuids = acc.steerUuids ++ rows.filterMap (·.steerUuid) ∧
    (rows.foldl Acc.push acc).pendingDispatch =
      acc.pendingDispatch + rows.countP isPendingDispatch ∧
    (rows.foldl Acc.push acc).dispatched = acc.dispatched + rows.countP isDispatched ∧
    ∀ n, ((rows.foldl Acc.push acc).maxSeq < n ↔ acc.maxSeq < n ∧ ∀ row ∈ rows, row.seq < n) := by
  induction rows with
  | nil => intro acc; simp
  | cons row rows ih =>
    intro acc
    obtain ⟨h1, h2, h3, h4, h5, h6⟩ := ih (acc := acc.push row)
    simp only [List.foldl_cons]
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
    · rw [h1]
      simp [Acc.push]
    · rw [h2]
      simp [Acc.push]
    · rw [h3]
      cases h : row.steerUuid <;> simp [Acc.push, h]
    · rw [h4, List.countP_cons]
      simp only [Acc.push]
      omega
    · rw [h5, List.countP_cons]
      simp only [Acc.push]
      omega
    · intro n
      rw [h6 n]
      simp only [Acc.push, Nat.max_lt, List.mem_cons, forall_eq_or_imp]
      constructor
      · rintro ⟨⟨ha, hr⟩, hrest⟩
        exact ⟨ha, hr, hrest⟩
      · rintro ⟨ha, hr, hrest⟩
        exact ⟨⟨ha, hr⟩, hrest⟩

/-- **(b)** The accumulator form of TS 226-263 (three `Set`s and three counters updated in loop
order) says the same as the declarative `UniqueRows` and counts, for the rows of one session
(ids are `<sessionKey>#<seq>`): the duplicate checks pass on every row exactly when all four
identity lists are duplicate-free, seqs included; the two counters are `countP` of the two state
classes; and `nextSeq > maxSeq` exactly when `nextSeq` is past every seq. -/
theorem accumulator_eq_declarative {key : String} (rows : List ItemRow)
    (hid : ∀ row ∈ rows, row.id = itemId key row.seq) :
    (FreshInOrder Acc.empty rows ↔ UniqueRows rows) ∧
    (rows.foldl Acc.push Acc.empty).pendingDispatch = rows.countP isPendingDispatch ∧
    (rows.foldl Acc.push Acc.empty).dispatched = rows.countP isDispatched ∧
    ∀ nextSeq, 1 ≤ nextSeq →
      ((rows.foldl Acc.push Acc.empty).maxSeq < nextSeq ↔ ∀ row ∈ rows, row.seq < nextSeq) := by
  obtain ⟨_, _, _, h4, h5, h6⟩ := foldl_push (rows := rows) (acc := Acc.empty)
  refine ⟨?_, ?_, ?_, ?_⟩
  · rw [freshInOrder_iff List.nodup_nil List.nodup_nil List.nodup_nil]
    simp only [Acc.empty, List.nil_append, UniqueRows, ← ids_nodup_iff_seqs_nodup hid]
    constructor
    · rintro ⟨h1, h2, h3⟩
      exact ⟨h1, h1, h2, h3⟩
    · rintro ⟨h1, _, h2, h3⟩
      exact ⟨h1, h2, h3⟩
  · rw [h4]
    simp [Acc.empty]
  · rw [h5]
    simp [Acc.empty]
  · intro nextSeq hn
    rw [h6 nextSeq]
    simp only [Acc.empty]
    constructor
    · exact fun h => h.2
    · exact fun h => ⟨by omega, h⟩

/-! ## (c) in the simplified gate -/

/-- **(c)** A repeated seq is still rejected, with the duplicate-id message: if the accumulator
holds the ids of earlier rows of the session and one of them has this row's seq, then it has this
row's id, and the id check of TS 235 fails. -/
theorem step_repeated_seq_reports_id {key w : String} {i : Nat} {acc : Acc} {row : ItemRow}
    {prev : List ItemRow} (hids : acc.ids = prev.map (·.id))
    (hprev : ∀ r ∈ prev, r.id = itemId key r.seq) (hrow : row.id = itemId key row.seq)
    (hdup : row.seq ∈ prev.map (·.seq)) :
    step w i row acc = fail s!"{w}.items[{i}].id" s!"is a duplicate ({row.id})" := by
  have hin : row.id ∈ acc.ids := by
    rw [hids]
    obtain ⟨r, hr, hseq⟩ := List.mem_map.1 hdup
    exact List.mem_map.2 ⟨r, hr, by rw [hprev r hr, hrow, hseq]⟩
  have hc : acc.ids.contains row.id = true := List.contains_iff_mem.2 hin
  unfold step
  simp only [hc, ↓reduceIte, fail_bind]

end SomaVerify.FollowupSnapshot.Proofs
