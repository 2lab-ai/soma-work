import SomaVerify.FollowupSnapshot.ModelOriginal
import SomaVerify.FollowupSnapshot.Spec

/-!
# Proofs about the gate as phase 1 modeled it

The phase-1 proofs, about `ModelOriginal.lean` (the gate at commit b1e1b464, before the
proof-backed simplification); TS line numbers in this file refer to that commit. Inside this
namespace `validateItem`, `step`, `Acc`, … are the `Original` versions.

* **(a)** `validate_ok_iff`: the gate accepts a value exactly when `ValidSnapshot` holds for it.
* **(b)** `accumulator_eq_declarative`: the four `Set`s and three counters of TS 220-260, updated
  in `forEach` order, say the same as the declarative uniqueness and counting clauses.
* **(c)** `seq_check_unreachable` and `step_duplicate_seq_reports_id`: once the id check of TS
  230 has passed, the seq check of TS 231 cannot fire, so a repeated seq is always reported as a
  repeated id.
* **(d)** `parse_returns_input`: what the gate returns is its input.

`Proofs.lean` proves the current gate equal to this one and carries every result over.
-/

namespace SomaVerify.FollowupSnapshot.Original.Proofs

open SomaVerify.FollowupSnapshot SomaVerify.FollowupSnapshot.Spec SomaVerify.JsString

/-! ## `Except` plumbing -/

/-- A `do` step succeeds exactly when the first action succeeds and the rest succeeds on its
result. -/
theorem bind_ok_iff {ε α β : Type} {m : Except ε α} {f : α → Except ε β} {b : β} :
    (m >>= f) = .ok b ↔ ∃ a, m = .ok a ∧ f a = .ok b := by
  cases m <;> simp [bind, Except.bind]

/-- A plain value succeeds with exactly that value. -/
theorem pure_ok_iff {ε α : Type} {a b : α} : (pure a : Except ε α) = .ok b ↔ a = b := by
  simp [pure, Except.pure]

/-- `fail` never returns. -/
theorem fail_ne_ok {α : Type} {w y : String} {a : α} : (fail w y : Except String α) ≠ .ok a := by
  simp [fail]

/-- `fail` never returns, as a rewrite rule. -/
theorem fail_eq_ok_iff {α : Type} {w y : String} {a : α} :
    (fail w y : Except String α) = .ok a ↔ False :=
  ⟨fail_ne_ok, False.elim⟩

/-- An error short-circuits the rest of a `do` block. -/
theorem fail_bind {α β : Type} {w y : String} {f : α → Except String β} :
    (fail w y >>= f) = fail w y := rfl

/-- `if (c) fail(…)` followed by the rest `k` of the block: `do` notation puts `k` in both
branches, and the block succeeds exactly when `c` is false and `k` succeeds. -/
theorem ite_fail_ok_iff {α : Type} {c : Prop} [Decidable c] {w y : String}
    {k : Except String α} {b : α} :
    (if c then fail w y else k) = .ok b ↔ ¬c ∧ k = .ok b := by
  by_cases h : c <;> simp [h, fail]

/-- `List.forM` over a throwing body succeeds exactly when the body succeeds on every element.
Stated on `forM`, the form `simp` rewrites `List.forM` to (`List.forM_eq_forM`). -/
theorem forM_ok_iff {α : Type} {xs : List α} {f : α → Except String Unit} {u : Unit} :
    forM xs f = .ok u ↔ ∀ x ∈ xs, f x = .ok () := by
  induction xs with
  | nil => simp [pure, Except.pure]
  | cons x xs ih =>
    simp only [List.forM_cons, bind_ok_iff, List.mem_cons, forall_eq_or_imp]
    constructor
    · rintro ⟨⟨⟩, hx, hrest⟩
      exact ⟨hx, ih.1 hrest⟩
    · rintro ⟨hx, hrest⟩
      exact ⟨(), hx, ih.2 hrest⟩

/-- Mapping over a `do` step maps over its continuation. -/
theorem map_bind {ε α β γ : Type} (m : Except ε α) (g : α → Except ε β) (f : β → γ) :
    (m >>= g).map f = m >>= fun a => (g a).map f := by
  cases m <;> rfl

/-- Binding a mapped action is binding the action and applying the map first. -/
theorem bind_map {ε α β γ : Type} (m : Except ε α) (f : α → β) (k : β → Except ε γ) :
    (m.map f >>= k) = m >>= fun a => k (f a) := by
  cases m <;> rfl

/-- Mapping over a failure leaves the failure, message included. -/
theorem map_fail {α β : Type} {w y : String} {f : α → β} :
    (fail w y : Except String α).map f = fail w y := rfl

/-- Mapping over a success applies the function. -/
theorem map_pure {ε α β : Type} {a : α} {f : α → β} :
    (pure a : Except ε α).map f = pure (f a) := rfl

/-- A `do` step on a plain value continues with that value. -/
theorem pure_bind {ε α β : Type} {a : α} {f : α → Except ε β} : (pure a >>= f) = f a := rfl

/-! ## Field checks (TS 70-108) -/

/-- `record` (TS 70-73) passes exactly the non-null, non-array objects, and returns their
fields. -/
theorem record_ok_iff {v : JsVal} {w : String} {fs : List (String × JsVal)} :
    record v w = .ok fs ↔ v = .obj fs := by
  cases v <;> simp [record, fail, pure, Except.pure]

/-- `array` (TS 75-78) passes exactly the arrays, and returns their items. -/
theorem array_ok_iff {v : JsVal} {w : String} {xs : List JsVal} :
    array v w = .ok xs ↔ v = .arr xs := by
  cases v <;> simp [array, fail, pure, Except.pure]

/-- `text` (TS 80-83) passes exactly the strings of JS length > 0, which are the non-empty
strings. -/
theorem text_ok_iff {v : JsVal} {w s : String} : text v w = .ok s ↔ NonEmptyString v s := by
  cases v with
  | str t =>
    simp only [text, NonEmptyString, JsVal.str.injEq]
    by_cases h : utf16Length t = 0
    · have ht : t = "" := (utf16Length_eq_zero_iff t).1 h
      simp only [h, ↓reduceIte, fail_eq_ok_iff, false_iff]
      rintro ⟨rfl, hs⟩
      exact hs ht
    · have ht : t ≠ "" := fun e => h ((utf16Length_eq_zero_iff t).2 e)
      simp only [h, ↓reduceIte, pure_ok_iff]
      constructor
      · rintro rfl
        exact ⟨rfl, ht⟩
      · rintro ⟨rfl, _⟩
        rfl
  | _ => simp [text, NonEmptyString, fail]

/-- `optionalText` (TS 85-88) passes exactly `undefined` and strings. -/
theorem optionalText_ok_iff {v : JsVal} {w : String} {u : Unit} :
    optionalText v w = .ok u ↔ OptionalString v := by
  cases v <;> simp [optionalText, OptionalString, fail, pure, Except.pure]

/-- `optionalBool` (TS 90-92) passes exactly `undefined` and booleans. -/
theorem optionalBool_ok_iff {v : JsVal} {w : String} {u : Unit} :
    optionalBool v w = .ok u ↔ OptionalBool v := by
  cases v <;> simp [optionalBool, OptionalBool, fail, pure, Except.pure]

/-- `integer` (TS 94-99) passes exactly the safe integers `≥ min`, and returns their value. -/
theorem integer_ok_iff {v : JsVal} {w : String} {min n : Nat} :
    integer v w min = .ok n ↔ SafeIntegerAtLeast min v n := by
  cases v with
  | num x =>
    simp only [integer, SafeIntegerAtLeast, JsVal.num.injEq, exists_eq_left']
    cases h : x.safeInteger? with
    | none => simp [fail]
    | some i =>
      by_cases hi : i < (min : Int)
      · simp only [hi, ↓reduceIte, fail_eq_ok_iff, false_iff, not_and, Option.some.injEq]
        intro hin
        omega
      · simp only [hi, ↓reduceIte, pure_ok_iff, Option.some.injEq]
        constructor
        · rintro rfl
          omega
        · rintro ⟨rfl, _⟩
          simp
  | _ => simp [integer, SafeIntegerAtLeast, fail]

/-- `timestamp` (TS 101-104) passes exactly the finite Numbers that are not below 0. -/
theorem timestamp_ok_iff {v : JsVal} {w : String} {u : Unit} :
    timestamp v w = .ok u ↔ NonNegativeFinite v := by
  cases v with
  | num x =>
    simp only [timestamp, NonNegativeFinite, JsVal.num.injEq, exists_eq_left']
    cases hf : x.isFinite <;> cases hn : x.isNegative <;> simp [fail, pure, Except.pure]
  | _ => simp [timestamp, NonNegativeFinite, fail]

/-- `number` (TS 106-108) passes exactly the finite Numbers. -/
theorem number_ok_iff {v : JsVal} {w : String} {u : Unit} :
    number v w = .ok u ↔ FiniteNumber v := by
  cases v with
  | num x =>
    simp only [number, FiniteNumber, JsVal.num.injEq, exists_eq_left']
    cases hf : x.isFinite <;> simp [fail, pure, Except.pure]
  | _ => simp [number, FiniteNumber, fail]

/-! ## The stored Slack payload (TS 110-153) -/

/-- The `routeContext` block (TS 132-140) passes exactly when `routeContext` is absent or an
object whose listed fields are optional strings and booleans. -/
theorem validateRouteContext_ok_iff {v : JsVal} {w : String} {u : Unit} :
    validateRouteContext v w = .ok u ↔ ValidRouteContext v := by
  cases v with
  | undef => simp [validateRouteContext, ValidRouteContext, JsVal.isUndefined, pure, Except.pure]
  | obj fs =>
    simp [validateRouteContext, ValidRouteContext, JsVal.isUndefined, bind_ok_iff, record_ok_iff,
      forM_ok_iff, optionalText_ok_iff, optionalBool_ok_iff]
  | _ =>
    simp [validateRouteContext, ValidRouteContext, JsVal.isUndefined, bind_ok_iff, record_ok_iff]

/-- The `files` loop (TS 143-149) passes exactly when every entry is a valid file, whatever
index it starts from. -/
theorem validateFileEntries_ok_iff {w : String} {entries : List JsVal} {index : Nat} {u : Unit} :
    validateFileEntries w index entries = .ok u ↔ ∀ e ∈ entries, ValidFile e := by
  induction entries generalizing index with
  | nil => simp [validateFileEntries, pure, Except.pure]
  | cons e rest ih =>
    simp only [validateFileEntries, bind_ok_iff, record_ok_iff, List.forM_eq_forM, forM_ok_iff,
      text_ok_iff, number_ok_iff, ih, ValidFile, List.mem_cons, forall_eq_or_imp, pure_ok_iff,
      and_true]
    constructor
    · rintro ⟨fs, rfl, _, htexts, _, hsize, hrest⟩
      exact ⟨⟨fs, rfl, htexts, hsize⟩, hrest⟩
    · rintro ⟨⟨fs, rfl, htexts, hsize⟩, hrest⟩
      exact ⟨fs, rfl, (), htexts, (), hsize, hrest⟩

/-- The `files` block (TS 142-150) passes exactly when `files` is absent or an array of valid
files. -/
theorem validateFiles_ok_iff {v : JsVal} {w : String} {u : Unit} :
    validateFiles v w = .ok u ↔ ValidFiles v := by
  cases v with
  | undef => simp [validateFiles, ValidFiles, JsVal.isUndefined, pure, Except.pure]
  | arr xs =>
    simp [validateFiles, ValidFiles, JsVal.isUndefined, bind_ok_iff, array_ok_iff,
      validateFileEntries_ok_iff]
  | _ =>
    simp [validateFiles, ValidFiles, JsVal.isUndefined, bind_ok_iff, array_ok_iff]

/-- The payload check accepts exactly the payloads `ValidMessage` describes, and returns their
`channel` and `ts`. -/
theorem validateMessage_ok_iff {v : JsVal} {w : String} {m : String × String} :
    validateMessage v w = .ok m ↔ ValidMessage v m.1 m.2 := by
  obtain ⟨channel, ts⟩ := m
  cases v with
  | obj fs =>
    simp only [validateMessage, ValidMessage, bind_ok_iff, record_ok_iff, text_ok_iff,
      List.forM_eq_forM, forM_ok_iff, optionalText_ok_iff, optionalBool_ok_iff,
      validateRouteContext_ok_iff, validateFiles_ok_iff, pure_ok_iff, JsVal.obj.injEq,
      exists_eq_left', Prod.mk.injEq]
    constructor
    · rintro ⟨user, huser, _, hch, _, hts, _, htexts, _, hbools, _, hroute, _, hfiles, rfl, rfl⟩
      exact ⟨⟨user, huser⟩, hch, hts, htexts, hbools, hroute, hfiles⟩
    · rintro ⟨⟨user, huser⟩, hch, hts, htexts, hbools, hroute, hfiles⟩
      exact ⟨user, huser, channel, hch, ts, hts, (), htexts, (), hbools, (), hroute, (), hfiles,
        rfl, rfl⟩
  | _ => simp [validateMessage, ValidMessage, bind_ok_iff, record_ok_iff]

/-! ## One item (TS 155-198) -/

/-- `value === s` holds exactly for the string `s`. -/
theorem isString_iff {v : JsVal} {s : String} : v.isString s = true ↔ v = .str s := by
  cases v <;> simp [JsVal.isString]

/-- The state check (TS 169-170) passes exactly the ten listed state names. -/
theorem itemState_ok_iff {v : JsVal} {w s : String} :
    itemState v w = .ok s ↔ v = .str s ∧ s ∈ itemStates := by
  cases v with
  | str t =>
    simp only [itemState, JsVal.str.injEq]
    by_cases h : itemStates.contains t = true
    · have ht : t ∈ itemStates := List.contains_iff_mem.1 h
      simp only [h, ↓reduceIte, pure_ok_iff]
      constructor
      · rintro rfl
        exact ⟨rfl, ht⟩
      · rintro ⟨rfl, _⟩
        rfl
    · have ht : t ∉ itemStates := fun hm => h (List.contains_iff_mem.2 hm)
      simp only [h, Bool.false_eq_true, ↓reduceIte, fail_eq_ok_iff, false_iff, not_and]
      rintro rfl
      exact ht
  | _ => simp [itemState, fail]

/-- After TS 192 accepted it, the `steerUuid` value read by TS 193 is the one `SteerUuidField`
names. -/
theorem asString?_of_steerUuidField {v : JsVal} {o : Option String} (h : SteerUuidField v o) :
    v.asString? = o := by
  cases o with
  | none => simp only [SteerUuidField] at h; subst h; rfl
  | some u => simp only [SteerUuidField] at h; rw [h.1]; rfl

/-- TS 192-195 together: the three `steerUuid` checks pass exactly when the field is absent or a
non-empty string, and present whenever the state is `steered`. -/
theorem steerUuid_checks_iff {v : JsVal} {state : String} :
    (OptionalString v ∧ emptyText v.asString? = false ∧
        (state == "steered" && falsy v.asString?) = false) ↔
      (SteerUuidField v v.asString? ∧ (state = "steered" → v.asString? ≠ none)) := by
  cases v with
  | undef =>
    simp [OptionalString, emptyText, falsy, SteerUuidField, JsVal.asString?]
  | str u =>
    by_cases hu : u = ""
    · subst hu
      simp [OptionalString, emptyText, falsy, SteerUuidField, JsVal.asString?, utf16Length,
        utf16LengthList]
    · have hl : utf16Length u ≠ 0 := fun e => hu ((utf16Length_eq_zero_iff u).1 e)
      simp [OptionalString, emptyText, falsy, SteerUuidField, JsVal.asString?, hu, hl]
  | _ => simp [OptionalString, SteerUuidField, JsVal.asString?]

/-- The item check accepts exactly the items `ValidItem` describes, and returns the row it
reads. -/
theorem validateItem_ok_iff {v : JsVal} {key w : String} {row : ItemRow} :
    validateItem v key w = .ok row ↔ ValidItem key v row := by
  cases v with
  | obj fs =>
    simp only [validateItem, ValidItem, bind_ok_iff, fail_bind, ite_fail_ok_iff, record_ok_iff,
      text_ok_iff, integer_ok_iff, Bool.not_eq_true', Bool.not_eq_false, isString_iff,
      itemState_ok_iff, validateMessage_ok_iff, optionalText_ok_iff, timestamp_ok_iff,
      pure_ok_iff, JsVal.obj.injEq, exists_eq_left', Bool.not_eq_true, bne_eq_false_iff_eq]
    constructor
    · rintro ⟨id, hid, seq, hseq, epoch, hepoch, hkey, hidEq, state, ⟨hstate, hstates⟩, eventKey,
        hek, msg, hmsg, hekEq, context, hctx, _, hwd, _, henq, _, hupd, _, hreason, _, hsteerOpt,
        hempty, hfalsy, rfl⟩
      have hsteer := steerUuid_checks_iff.1 ⟨hsteerOpt, hempty, hfalsy⟩
      exact ⟨hid, hseq, ⟨epoch, hepoch⟩, hkey, hidEq, hstate, hstates, hek,
        ⟨msg.1, msg.2, hmsg, hekEq⟩, ⟨context, hctx, hwd⟩, henq, hupd, hreason, hsteer.1,
        hsteer.2⟩
    · rintro ⟨hid, hseq, ⟨epoch, hepoch⟩, hkey, hidEq, hstate, hstates, hek,
        ⟨channel, ts, hmsg, hekEq⟩, ⟨context, hctx, hwd⟩, henq, hupd, hreason, hsteerField,
        hsteered⟩
      have has := asString?_of_steerUuidField hsteerField
      have hchecks := (steerUuid_checks_iff (state := row.state)).2
        ⟨by rw [has]; exact hsteerField, by rw [has]; exact hsteered⟩
      refine ⟨row.id, hid, row.seq, hseq, epoch, hepoch, hkey, hidEq, row.state,
        ⟨hstate, hstates⟩, row.eventKey, hek, (channel, ts), hmsg, hekEq, context, hctx, (), hwd,
        (), henq, (), hupd, (), hreason, (), hchecks.1, hchecks.2.1, hchecks.2.2, ?_⟩
      rw [has]
  | _ => simp [validateItem, ValidItem, bind_ok_iff, record_ok_iff]

/-! ## The accumulator (TS 220-251) -/

/-- What TS 243-250 do to the accumulator once `row` passed its duplicate checks. -/
def _root_.SomaVerify.FollowupSnapshot.Original.Acc.push (acc : Acc) (row : ItemRow) : Acc where
  ids := acc.ids ++ [row.id]
  seqs := acc.seqs ++ [row.seq]
  eventKeys := acc.eventKeys ++ [row.eventKey]
  steerUuids := acc.steerUuids ++ row.steerUuid.toList
  maxSeq := max acc.maxSeq row.seq
  pendingDispatch := acc.pendingDispatch + (if isPendingDispatch row then 1 else 0)
  dispatched := acc.dispatched + (if isDispatched row then 1 else 0)

/-- `row` passes the duplicate checks of TS 230-244 against `acc`. -/
def Fresh (acc : Acc) (row : ItemRow) : Prop :=
  row.id ∉ acc.ids ∧ row.seq ∉ acc.seqs ∧ row.eventKey ∉ acc.eventKeys ∧
    ∀ uuid, row.steerUuid = some uuid → uuid ∉ acc.steerUuids

/-- The accumulator form of the session checks: each row passes the duplicate checks against the
accumulator of the rows before it, in `forEach` order. -/
def FreshInOrder : Acc → List ItemRow → Prop
  | _, [] => True
  | acc, row :: rows => Fresh acc row ∧ FreshInOrder (acc.push row) rows

/-- One step of the items loop (TS 230-250) succeeds exactly when the row is fresh against the
accumulator, and then returns the accumulator with the row pushed. -/
theorem step_ok_iff {w : String} {i : Nat} {row : ItemRow} {acc acc' : Acc} :
    step w i row acc = .ok acc' ↔ Fresh acc row ∧ acc' = acc.push row := by
  unfold step Fresh Acc.push isPendingDispatch isDispatched
  cases h : row.steerUuid with
  | none =>
    simp only [ite_fail_ok_iff, fail_bind, bind_ok_iff, pure_ok_iff, exists_eq_left',
      Option.toList_none, List.append_nil, reduceCtorEq, false_implies, implies_true, and_true]
    constructor
    · rintro ⟨h1, h2, h3, rfl⟩
      exact ⟨⟨by simpa using h1, by simpa using h2, by simpa using h3⟩, rfl⟩
    · rintro ⟨⟨h1, h2, h3⟩, rfl⟩
      exact ⟨by simpa using h1, by simpa using h2, by simpa using h3, rfl⟩
  | some u =>
    simp only [ite_fail_ok_iff, fail_bind, bind_ok_iff, pure_ok_iff, exists_eq_left',
      Option.toList_some, Option.some.injEq, forall_eq']
    constructor
    · rintro ⟨h1, h2, h3, h4, rfl⟩
      exact ⟨⟨by simpa using h1, by simpa using h2, by simpa using h3, by simpa using h4⟩, rfl⟩
    · rintro ⟨⟨h1, h2, h3, h4⟩, rfl⟩
      exact ⟨by simpa using h1, by simpa using h2, by simpa using h3, by simpa using h4, rfl⟩

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

/-! ## (b) The accumulator form equals the declarative form -/

/-- Appending one element to a duplicate-free list keeps it duplicate-free exactly when the
element is new. -/
theorem nodup_append_singleton_iff {α : Type} {l : List α} {x : α} (hl : l.Nodup) :
    (l ++ [x]).Nodup ↔ x ∉ l := by
  rw [List.nodup_append]
  constructor
  · rintro ⟨_, _, h⟩ hx
    exact h x hx x (List.mem_singleton_self x) rfl
  · intro hx
    refine ⟨hl, List.nodup_cons.2 ⟨List.not_mem_nil, List.nodup_nil⟩, ?_⟩
    intro a ha b hb hab
    rw [List.mem_singleton] at hb
    subst hb hab
    exact hx ha

/-- Appending an optional element: the same, when the element is present. -/
theorem nodup_append_toList_iff {α : Type} {l : List α} {o : Option α} (hl : l.Nodup) :
    (l ++ o.toList).Nodup ↔ ∀ x, o = some x → x ∉ l := by
  cases o with
  | none => simp [hl]
  | some x => simp [nodup_append_singleton_iff hl]

/-- Pushing a row keeps the four identity lists duplicate-free exactly when the row is fresh. -/
theorem fresh_iff_push_nodup {acc : Acc} {row : ItemRow} (hids : acc.ids.Nodup)
    (hseqs : acc.seqs.Nodup) (heks : acc.eventKeys.Nodup) (huuids : acc.steerUuids.Nodup) :
    Fresh acc row ↔ (acc.push row).ids.Nodup ∧ (acc.push row).seqs.Nodup ∧
      (acc.push row).eventKeys.Nodup ∧ (acc.push row).steerUuids.Nodup := by
  simp only [Fresh, Acc.push, nodup_append_singleton_iff hids, nodup_append_singleton_iff hseqs,
    nodup_append_singleton_iff heks, nodup_append_toList_iff huuids]

/-- From a duplicate-free accumulator, the rows pass the duplicate checks in order exactly when
the accumulator's lists extended with the rows' identities stay duplicate-free. -/
theorem freshInOrder_iff {rows : List ItemRow} : ∀ {acc : Acc}, acc.ids.Nodup →
    acc.seqs.Nodup → acc.eventKeys.Nodup → acc.steerUuids.Nodup →
    (FreshInOrder acc rows ↔
      (acc.ids ++ rows.map (·.id)).Nodup ∧ (acc.seqs ++ rows.map (·.seq)).Nodup ∧
        (acc.eventKeys ++ rows.map (·.eventKey)).Nodup ∧
        (acc.steerUuids ++ rows.filterMap (·.steerUuid)).Nodup) := by
  induction rows with
  | nil =>
    intro acc hids hseqs heks huuids
    simp [FreshInOrder, hids, hseqs, heks, huuids]
  | cons row rows ih =>
    intro acc hids hseqs heks huuids
    have e1 : acc.ids ++ (row :: rows).map (·.id) = (acc.push row).ids ++ rows.map (·.id) := by
      simp [Acc.push]
    have e2 : acc.seqs ++ (row :: rows).map (·.seq) = (acc.push row).seqs ++ rows.map (·.seq) := by
      simp [Acc.push]
    have e3 : acc.eventKeys ++ (row :: rows).map (·.eventKey) =
        (acc.push row).eventKeys ++ rows.map (·.eventKey) := by
      simp [Acc.push]
    have e4 : acc.steerUuids ++ (row :: rows).filterMap (·.steerUuid) =
        (acc.push row).steerUuids ++ rows.filterMap (·.steerUuid) := by
      cases h : row.steerUuid <;> simp [Acc.push, h]
    rw [e1, e2, e3, e4]
    simp only [FreshInOrder]
    constructor
    · rintro ⟨hf, hrest⟩
      obtain ⟨p1, p2, p3, p4⟩ := (fresh_iff_push_nodup hids hseqs heks huuids).1 hf
      exact (ih p1 p2 p3 p4).1 hrest
    · rintro ⟨n1, n2, n3, n4⟩
      have p1 := (List.nodup_append.1 n1).1
      have p2 := (List.nodup_append.1 n2).1
      have p3 := (List.nodup_append.1 n3).1
      have p4 := (List.nodup_append.1 n4).1
      exact ⟨(fresh_iff_push_nodup hids hseqs heks huuids).2 ⟨p1, p2, p3, p4⟩,
        (ih p1 p2 p3 p4).2 ⟨n1, n2, n3, n4⟩⟩

/-- The accumulator after pushing `rows`: the identity lists are the rows' identities in order,
the counters are counts, and `maxSeq` is below `n` exactly when every seq is. -/
theorem foldl_push {rows : List ItemRow} : ∀ {acc : Acc},
    (rows.foldl Acc.push acc).ids = acc.ids ++ rows.map (·.id) ∧
    (rows.foldl Acc.push acc).seqs = acc.seqs ++ rows.map (·.seq) ∧
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
    obtain ⟨h1, h2, h3, h4, h5, h6, h7⟩ := ih (acc := acc.push row)
    simp only [List.foldl_cons]
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · rw [h1]
      simp [Acc.push]
    · rw [h2]
      simp [Acc.push]
    · rw [h3]
      simp [Acc.push]
    · rw [h4]
      cases h : row.steerUuid <;> simp [Acc.push, h]
    · rw [h5, List.countP_cons]
      simp only [Acc.push]
      omega
    · rw [h6, List.countP_cons]
      simp only [Acc.push]
      omega
    · intro n
      rw [h7 n]
      simp only [Acc.push, Nat.max_lt, List.mem_cons, forall_eq_or_imp]
      constructor
      · rintro ⟨⟨ha, hr⟩, hrest⟩
        exact ⟨ha, hr, hrest⟩
      · rintro ⟨ha, hr, hrest⟩
        exact ⟨⟨ha, hr⟩, hrest⟩

/-- **(b)** The accumulator form of TS 220-260 — four `Set`s and three counters updated in
`forEach` order — says the same as the declarative `UniqueRows` and counts: the duplicate checks
pass on every row exactly when the four identity lists are duplicate-free, the two counters are
`countP` of the two state classes, and `nextSeq > maxSeq` exactly when `nextSeq` is past every
seq. -/
theorem accumulator_eq_declarative (rows : List ItemRow) :
    (FreshInOrder Acc.empty rows ↔ UniqueRows rows) ∧
    (rows.foldl Acc.push Acc.empty).pendingDispatch = rows.countP isPendingDispatch ∧
    (rows.foldl Acc.push Acc.empty).dispatched = rows.countP isDispatched ∧
    ∀ nextSeq, 1 ≤ nextSeq →
      ((rows.foldl Acc.push Acc.empty).maxSeq < nextSeq ↔ ∀ row ∈ rows, row.seq < nextSeq) := by
  obtain ⟨_, _, _, _, h5, h6, h7⟩ := foldl_push (rows := rows) (acc := Acc.empty)
  refine ⟨?_, ?_, ?_, ?_⟩
  · rw [freshInOrder_iff List.nodup_nil List.nodup_nil List.nodup_nil List.nodup_nil]
    simp [Acc.empty, UniqueRows]
  · rw [h5]
    simp [Acc.empty]
  · rw [h6]
    simp [Acc.empty]
  · intro nextSeq hn
    rw [h7 nextSeq]
    simp only [Acc.empty]
    constructor
    · exact fun h => h.2
    · exact fun h => ⟨by omega, h⟩

/-! ## One session (TS 200-263) -/

/-- The `freeze` block (TS 205-209) passes exactly when `freeze` is absent or an object with a
non-empty `reason` and a timestamp `at`. -/
theorem validateFreeze_ok_iff {v : JsVal} {w : String} {u : Unit} :
    validateFreeze v w = .ok u ↔ ValidFreeze v := by
  cases v with
  | undef => simp [validateFreeze, ValidFreeze, JsVal.isUndefined, pure, Except.pure]
  | obj fs =>
    simp [validateFreeze, ValidFreeze, JsVal.isUndefined, bind_ok_iff, record_ok_iff, text_ok_iff,
      timestamp_ok_iff]
  | _ => simp [validateFreeze, ValidFreeze, JsVal.isUndefined, bind_ok_iff, record_ok_iff]

/-- The session check (TS 200-263) accepts exactly the sessions `ValidSession` describes, and
returns their key. -/
theorem validateSession_ok_iff {v : JsVal} {w key : String} :
    validateSession v w = .ok key ↔ ValidSession v key := by
  cases v with
  | obj fs =>
    simp only [validateSession, ValidSession, bind_ok_iff, fail_bind, ite_fail_ok_iff,
      record_ok_iff, text_ok_iff, integer_ok_iff, validateFreeze_ok_iff, array_ok_iff,
      itemsLoop_ok_iff, pure_ok_iff, JsVal.obj.injEq, exists_eq_left', Nat.not_le, Nat.not_lt]
    constructor
    · rintro ⟨_, hk, nextSeq, hnext, _, hfreeze, turnEpoch, hte, entries, hitems, _,
        ⟨rows, hrows, hfio, rfl⟩, hmax, hpd, hd, rfl⟩
      obtain ⟨hU, hPD, hD, hMax⟩ := accumulator_eq_declarative rows
      have h1 : 1 ≤ nextSeq := by obtain ⟨_, _, _, h⟩ := hnext; exact h
      exact ⟨fs, nextSeq, entries, rows, rfl, hk, hnext, hfreeze, ⟨turnEpoch, hte⟩, hitems, hrows,
        hU.1 hfio, (hMax nextSeq h1).1 hmax, hPD ▸ hpd, hD ▸ hd⟩
    · rintro ⟨_, nextSeq, entries, rows, rfl, hk, hnext, hfreeze, ⟨turnEpoch, hte⟩, hitems, hrows,
        huniq, hlt, hpd, hd⟩
      obtain ⟨hU, hPD, hD, hMax⟩ := accumulator_eq_declarative rows
      have h1 : 1 ≤ nextSeq := by obtain ⟨_, _, _, h⟩ := hnext; exact h
      exact ⟨key, hk, nextSeq, hnext, (), hfreeze, turnEpoch, hte, entries, hitems, _,
        ⟨rows, hrows, hU.2 huniq, rfl⟩, (hMax nextSeq h1).2 hlt, hPD ▸ hpd, hD ▸ hd, rfl⟩
  | _ => simp [validateSession, ValidSession, bind_ok_iff, record_ok_iff]

/-! ## The snapshot (TS 265-281) -/

/-- The sessions loop (TS 273-278) succeeds exactly when every entry is a valid session and the
keys, after the ones already seen, are duplicate-free. -/
theorem sessionsLoop_ok_iff {entries : List JsVal} : ∀ {i : Nat} {keys0 : List String} {u : Unit},
    keys0.Nodup →
    (sessionsLoop i entries keys0 = .ok u ↔
      ∃ keys, Forall₂ ValidSession entries keys ∧ (keys0 ++ keys).Nodup) := by
  induction entries with
  | nil =>
    intro i keys0 u h0
    simp only [sessionsLoop, pure_ok_iff]
    constructor
    · intro _
      exact ⟨[], .nil, by simpa using h0⟩
    · intro _
      trivial
  | cons e es ih =>
    intro i keys0 u h0
    simp only [sessionsLoop, bind_ok_iff, fail_bind, ite_fail_ok_iff, validateSession_ok_iff,
      List.contains_iff_mem]
    constructor
    · rintro ⟨k, hk, hk0, hrest⟩
      have h0' : (keys0 ++ [k]).Nodup := (nodup_append_singleton_iff h0).2 hk0
      obtain ⟨keys, hkeys, hnd⟩ := (ih h0').1 hrest
      exact ⟨k :: keys, .cons hk hkeys, by simpa using hnd⟩
    · rintro ⟨_, hkeys', hnd⟩
      cases hkeys' with
      | @cons _ k _ keys hk hkeys =>
        have hnd' : (keys0 ++ [k] ++ keys).Nodup := by simpa using hnd
        have h0' := (List.nodup_append.1 hnd').1
        exact ⟨k, hk, (nodup_append_singleton_iff h0).1 h0', (ih h0').2 ⟨keys, hkeys, hnd'⟩⟩

/-- The gate returns exactly on the snapshots `ValidSnapshot` describes, and what it returns is
its input. -/
theorem parse_ok_iff {raw v : JsVal} :
    parseFollowupQueueSnapshot raw = .ok v ↔ ValidSnapshot raw ∧ v = raw := by
  cases raw with
  | obj fs =>
    simp only [parseFollowupQueueSnapshot, ValidSnapshot, bind_ok_iff, fail_bind, ite_fail_ok_iff,
      record_ok_iff, array_ok_iff, pure_ok_iff, JsVal.obj.injEq, exists_eq_left',
      Bool.not_eq_true', Bool.not_eq_false, sessionsLoop_ok_iff List.nodup_nil, List.nil_append]
    constructor
    · rintro ⟨hv, entries, hs, _, ⟨keys, hkeys, hnd⟩, rfl⟩
      exact ⟨⟨fs, entries, keys, rfl, hv, hs, hkeys, hnd⟩, rfl⟩
    · rintro ⟨⟨_, entries, keys, rfl, hv, hs, hkeys, hnd⟩, rfl⟩
      exact ⟨hv, entries, hs, (), ⟨keys, hkeys, hnd⟩, rfl⟩
  | _ => simp [parseFollowupQueueSnapshot, ValidSnapshot, bind_ok_iff, record_ok_iff]

/-- **(a) Soundness and completeness.** The gate accepts a value exactly when it satisfies the
declarative `ValidSnapshot`: every accepted value has every documented property (soundness),
and every value with all of them is accepted (completeness), so nothing is rejected that the
invariants allow and nothing is accepted that they forbid. -/
theorem validate_ok_iff {raw : JsVal} : validate raw = .ok () ↔ ValidSnapshot raw := by
  unfold validate
  cases h : parseFollowupQueueSnapshot raw with
  | error e =>
    simp only [Except.map, reduceCtorEq, false_iff]
    intro hv
    have hok := parse_ok_iff.2 ⟨hv, rfl⟩
    rw [h] at hok
    cases hok
  | ok v =>
    simp only [Except.map]
    exact ⟨fun _ => (parse_ok_iff.1 h).1, fun _ => trivial⟩

/-- **(d) The gate never repairs.** TS 266-267: "returns the input unchanged on success so no
field is lost in translation". Whatever the gate returns is its input — no field added, dropped
or rewritten, including fields the gate does not know. -/
theorem parse_returns_input {raw v : JsVal} (h : parseFollowupQueueSnapshot raw = .ok v) :
    v = raw :=
  (parse_ok_iff.1 h).2

/-- (d), as one equation: the gate is the identity on the snapshots it accepts and fails on the
others. -/
theorem parse_eq_validate_then_input (raw : JsVal) :
    parseFollowupQueueSnapshot raw = (validate raw).map fun _ => raw := by
  cases h : parseFollowupQueueSnapshot raw with
  | error e => simp [validate, h, Except.map]
  | ok v =>
    have := parse_returns_input h
    subst this
    simp [validate, h, Except.map]

/-! ## (c) The seq-duplicate branch (TS 231) is unreachable -/

/-- The invariant of the items loop behind TS 230-231: the id set is the seq set mapped through
`<sessionKey>#·`, in order. -/
def IdsMatchSeqs (key : String) (acc : Acc) : Prop :=
  acc.ids = acc.seqs.map (itemId key)

/-- The invariant holds before the first item (TS 220-221). -/
theorem idsMatchSeqs_empty (key : String) : IdsMatchSeqs key Acc.empty := rfl

/-- Pushing a row whose id is `<sessionKey>#<seq>` keeps the invariant. -/
theorem idsMatchSeqs_push {key : String} {acc : Acc} {row : ItemRow}
    (hinv : IdsMatchSeqs key acc) (hrow : row.id = itemId key row.seq) :
    IdsMatchSeqs key (acc.push row) := by
  unfold IdsMatchSeqs at hinv ⊢
  simp [Acc.push, hinv, hrow]

/-- **(c)** A seq already in the set is always an id already in the set. -/
theorem seq_duplicate_is_id_duplicate {key : String} {acc : Acc} {row : ItemRow}
    (hinv : IdsMatchSeqs key acc) (hrow : row.id = itemId key row.seq)
    (hdup : row.seq ∈ acc.seqs) : row.id ∈ acc.ids := by
  rw [hinv, hrow]
  exact List.mem_map_of_mem hdup

/-- **(c)** The observable error for a duplicate seq is TS 230's duplicate-id message: the id
check runs first and always fires. -/
theorem step_duplicate_seq_reports_id {key w : String} {i : Nat} {acc : Acc} {row : ItemRow}
    (hinv : IdsMatchSeqs key acc) (hrow : row.id = itemId key row.seq)
    (hdup : row.seq ∈ acc.seqs) :
    step w i row acc = fail s!"{w}.items[{i}].id" s!"is a duplicate ({row.id})" := by
  have hc : acc.ids.contains row.id = true :=
    List.contains_iff_mem.2 (seq_duplicate_is_id_duplicate hinv hrow hdup)
  unfold step
  simp only [hc, ↓reduceIte, fail_bind]

/-- **(c)** Hence the branch of TS 231 is never taken: when the id check of TS 230 passes, the
seq check fails to fire. -/
theorem seq_check_unreachable {key : String} {acc : Acc} {row : ItemRow}
    (hinv : IdsMatchSeqs key acc) (hrow : row.id = itemId key row.seq)
    (hid : acc.ids.contains row.id = false) : acc.seqs.contains row.seq = false := by
  cases h : acc.seqs.contains row.seq with
  | false => rfl
  | true =>
    have := List.contains_iff_mem.2
      (seq_duplicate_is_id_duplicate hinv hrow (List.contains_iff_mem.1 h))
    rw [hid] at this
    cases this

/-- TS 195: after TS 194 the uuid is `undefined` or non-empty, so `!steerUuid` there is
`steerUuid === undefined`. -/
theorem falsy_eq_isNone {o : Option String} (h : emptyText o = false) : falsy o = o.isNone := by
  cases o with
  | none => rfl
  | some u => simp_all [emptyText, falsy]

end SomaVerify.FollowupSnapshot.Original.Proofs
