import SomaVerify.SensitivePath.Model
import SomaVerify.SensitivePath.Spec
import SomaVerify.SensitivePath.Proofs

/-!
# Proofs of the sensitive-path invariants: case folding

`fold` rewrites a character as one or more characters. Everything the rules depend on survives
it: a character folds to `/` or `.` only if it is that character, every character folds to at
least one character, and folding twice is folding once. So folding commutes with `split('/')`,
with resolution and with the `/private` mapping up to `canon`, and a normalized path's key
(`foldKey`) is its segments' `canon`.
-/

namespace SomaVerify.SensitivePath.Proofs

open SomaVerify.SensitivePath SomaVerify.SensitivePath.Spec

/-! ## One character -/

/-- The ASCII lower-case letters. -/
def lowerAscii : List Char := "abcdefghijklmnopqrstuvwxyz".toList

/-- A `List.lookup` hit is an entry of the list. -/
theorem mem_of_lookup {β : Type} (c : Char) (b : β) :
    ∀ l : List (Char × β), l.lookup c = some b → (c, b) ∈ l
  | [], h => by simp [List.lookup] at h
  | (k, v) :: es, h => by
    unfold List.lookup at h
    split at h
    · rename_i hk
      have hck : c = k := beq_iff_eq.1 hk
      simp only [Option.some.injEq] at h
      subst hck; subst h
      exact List.mem_cons_self
    · exact List.mem_cons_of_mem _ (mem_of_lookup c b es h)

/-- Every `FOLDED_LETTERS` entry is one or more lower-case ASCII letters. -/
theorem foldedLetters_lower : ∀ e ∈ foldedLetters, e.2 ≠ [] ∧ ∀ d ∈ e.2, d ∈ lowerAscii := by
  decide

/-- `Char.toLower` keeps a character, or makes it a lower-case ASCII letter. -/
theorem toLower_cases (c : Char) : c.toLower = c ∨ c.toLower ∈ lowerAscii := by
  by_cases h : c.val ≥ 'A'.val ∧ c.val ≤ 'Z'.val
  · right
    have hn : c.toNat ∈ List.range' 65 26 := by
      have h1 : 65 ≤ c.toNat := by
        have := h.1
        simp only [GE.ge, UInt32.le_iff_toNat_le] at this
        exact this
      have h2 : c.toNat ≤ 90 := by
        have := h.2
        simp only [UInt32.le_iff_toNat_le] at this
        exact this
      simp only [List.mem_range'_1]
      omega
    have key : ∀ n ∈ List.range' 65 26, (Char.ofNat n).toLower ∈ lowerAscii := by decide
    have := key _ hn
    rwa [Char.ofNat_toNat] at this
  · left
    unfold Char.toLower
    rw [dite_eq_right h]

/-- A character folds to itself, or to one or more lower-case ASCII letters. -/
theorem foldChar_cases (c : Char) : foldChar c = [c] ∨ (foldChar c ≠ [] ∧ ∀ d ∈ foldChar c, d ∈ lowerAscii) := by
  unfold foldChar
  split
  · rename_i s hs
    exact Or.inr (foldedLetters_lower _ (mem_of_lookup c s _ hs))
  · rcases toLower_cases c with h | h
    · left; rw [h]
    · right; exact ⟨by simp, by simp [h]⟩

/-- A lower-case ASCII letter folds to itself. -/
theorem foldChar_lower : ∀ d ∈ lowerAscii, foldChar d = [d] := by
  decide

theorem foldChar_ne_nil (c : Char) : foldChar c ≠ [] := by
  rcases foldChar_cases c with h | h
  · rw [h]; simp
  · exact h.1

/-- Only `/` folds to something containing `/`. -/
theorem slash_mem_foldChar (c : Char) : '/' ∈ foldChar c ↔ c = '/' := by
  constructor
  · intro hm
    rcases foldChar_cases c with h | h
    · rw [h] at hm; simp at hm; exact hm.symm
    · exact absurd (h.2 '/' hm) (by decide)
  · rintro rfl; decide

/-- Only `.` folds to something containing `.`. -/
theorem dot_mem_foldChar (c : Char) : '.' ∈ foldChar c ↔ c = '.' := by
  constructor
  · intro hm
    rcases foldChar_cases c with h | h
    · rw [h] at hm; simp at hm; exact hm.symm
    · exact absurd (h.2 '.' hm) (by decide)
  · rintro rfl; decide

theorem foldChar_slash : foldChar '/' = ['/'] := by decide

theorem foldChar_dot : foldChar '.' = ['.'] := by decide

/-- Folding keeps line terminators and makes none. -/
theorem foldChar_lineTerminator (c : Char) (hc : c ∉ lineTerminators) : ∀ d ∈ foldChar c, d ∉ lineTerminators := by
  intro d hd
  rcases foldChar_cases c with h | h
  · rw [h] at hd; simp at hd; rw [hd]; exact hc
  · have := h.2 d hd
    intro hlt
    simp only [lineTerminators, List.mem_cons, List.mem_nil_iff, or_false] at hlt
    rcases hlt with rfl | rfl | rfl | rfl <;> exact absurd this (by decide)

/-! ## Strings -/

@[simp] theorem fold_nil : fold [] = [] := rfl

theorem fold_cons (c : Char) (s : List Char) : fold (c :: s) = foldChar c ++ fold s := by
  simp [fold]

theorem fold_append (a b : List Char) : fold (a ++ b) = fold a ++ fold b := by
  simp [fold]

/-- Folding twice is folding once. -/
theorem fold_fold (s : List Char) : fold (fold s) = fold s := by
  induction s with
  | nil => rfl
  | cons c cs ih =>
    rw [fold_cons, fold_append, ih]
    congr 1
    rcases foldChar_cases c with h | h
    · rw [h, fold_cons, fold_nil, List.append_nil, h]
    · have : ∀ l : List Char, (∀ d ∈ l, d ∈ lowerAscii) → fold l = l := by
        intro l hl
        induction l with
        | nil => rfl
        | cons d ds ihl =>
          rw [fold_cons, foldChar_lower d (hl d (by simp)), ihl (fun x hx => hl x (by simp [hx]))]
          rfl
      exact this _ h.2

/-- Only the empty string folds to the empty string. -/
theorem fold_eq_nil (s : List Char) : fold s = [] ↔ s = [] := by
  cases s with
  | nil => simp
  | cons c cs =>
    simp only [fold_cons, List.append_eq_nil_iff, reduceCtorEq, iff_false, not_and]
    intro h; exact absurd h (foldChar_ne_nil c)

/-- Only `.` folds to `.`. -/
theorem fold_eq_dot (s : List Char) : fold s = ['.'] ↔ s = ['.'] := by
  constructor
  · intro h
    cases s with
    | nil => simp at h
    | cons c cs =>
      rw [fold_cons] at h
      have hne := foldChar_ne_nil c
      cases hf : foldChar c with
      | nil => exact absurd hf hne
      | cons d ds =>
        rw [hf] at h
        simp only [List.cons_append, List.cons.injEq, List.append_eq_nil_iff] at h
        obtain ⟨rfl, -, hcs⟩ := h
        have hc : c = '.' := (dot_mem_foldChar c).1 (by rw [hf]; simp)
        rw [hc, (fold_eq_nil cs).1 hcs]
  · rintro rfl; decide

/-- Only `..` folds to `..`. -/
theorem fold_eq_dotdot (s : List Char) : fold s = ['.', '.'] ↔ s = ['.', '.'] := by
  constructor
  · intro h
    cases s with
    | nil => simp at h
    | cons c cs =>
      rw [fold_cons] at h
      have hne := foldChar_ne_nil c
      cases hf : foldChar c with
      | nil => exact absurd hf hne
      | cons d ds =>
        rw [hf] at h
        simp only [List.cons_append, List.cons.injEq] at h
        obtain ⟨rfl, h⟩ := h
        have hc : c = '.' := (dot_mem_foldChar c).1 (by rw [hf]; simp)
        subst hc
        rw [foldChar_dot] at hf
        simp only [List.cons.injEq] at hf
        rw [← hf.2, List.nil_append] at h
        rw [(fold_eq_dot cs).1 h]
  · rintro rfl; decide

/-- A string without `/` folds to one. -/
theorem slashFree_fold (s : List Char) (h : '/' ∉ s) : '/' ∉ fold s := by
  intro hm
  simp only [fold, List.mem_flatMap] at hm
  obtain ⟨c, hc, hmc⟩ := hm
  exact h (by rw [← (slash_mem_foldChar c).1 hmc]; exact hc)

/-- `split('/')` of the $s$ folded splits $s$ and folds each segment. -/
theorem splitSlash_fold (s : List Char) : splitSlash (fold s) = (splitSlash s).map fold := by
  induction s with
  | nil => rfl
  | cons c cs ih =>
    rw [fold_cons]
    by_cases hc : c = '/'
    · subst hc
      rw [foldChar_slash]
      simp [splitSlash, ih]
    · have hw : '/' ∉ foldChar c := fun hm => hc ((slash_mem_foldChar c).1 hm)
      -- `split('/')` of a slash-free prefix glues it to the first segment
      have glue : ∀ (w x : List Char), '/' ∉ w →
          splitSlash (w ++ x) = (w ++ (splitSlash x).headD []) :: (splitSlash x).tail := by
        intro w x hwx
        induction w with
        | nil =>
          obtain ⟨v, vs, hv⟩ : ∃ v vs, splitSlash x = v :: vs := by
            cases h : splitSlash x with
            | nil => exact absurd h (splitSlash_ne_nil x)
            | cons v vs => exact ⟨v, vs, rfl⟩
          simp [hv]
        | cons d ds ihw =>
          have hd : d ≠ '/' := fun e => hwx (by simp [e])
          have hds : '/' ∉ ds := fun m => hwx (by simp [m])
          simp only [List.cons_append, splitSlash, hd, ite_false, ihw hds, consHead]
      obtain ⟨v, vs, hv⟩ : ∃ v vs, splitSlash cs = v :: vs := by
        cases h : splitSlash cs with
        | nil => exact absurd h (splitSlash_ne_nil cs)
        | cons v vs => exact ⟨v, vs, rfl⟩
      rw [glue _ _ hw, ih, hv]
      simp [splitSlash, hc, hv, consHead, fold_cons]

/-- Rendering commutes with folding. -/
theorem renderAbs_map_fold (r : List Seg) : renderAbs (r.map fold) = fold (renderAbs r) := by
  induction r with
  | nil => rfl
  | cons s ss ih =>
    simp only [List.map_cons, renderAbs, ih, fold_cons, foldChar_slash, fold_append]
    rfl

/-- A folded string starts with `/` exactly when the string does. -/
theorem head_fold (s : List Char) : (fold s).head? = some '/' ↔ s.head? = some '/' := by
  cases s with
  | nil => simp
  | cons c cs =>
    rw [fold_cons]
    cases hf : foldChar c with
    | nil => exact absurd hf (foldChar_ne_nil c)
    | cons d ds =>
      simp only [List.cons_append, List.head?_cons, Option.some.injEq]
      constructor
      · rintro rfl; exact (slash_mem_foldChar c).1 (by rw [hf]; simp)
      · rintro rfl; rw [foldChar_slash] at hf; simp at hf; exact hf.1.symm

/-! ## Segments -/

/-- Folding a segment keeps it empty, `.` or `..` exactly when it was. -/
theorem resolveStep_map_fold (stack : List Seg) (s : Seg) :
    resolveStep (stack.map fold) (fold s) = (resolveStep stack s).map fold := by
  unfold resolveStep
  by_cases h1 : s = [] ∨ s = ['.']
  · have : fold s = [] ∨ fold s = ['.'] := by
      rcases h1 with rfl | rfl
      · left; rfl
      · right; decide
    rw [ite_eq_left this, ite_eq_left h1]
  · have : ¬ (fold s = [] ∨ fold s = ['.']) := by
      rintro (h | h)
      · exact h1 (Or.inl ((fold_eq_nil s).1 h))
      · exact h1 (Or.inr ((fold_eq_dot s).1 h))
    rw [ite_eq_right this, ite_eq_right h1]
    by_cases h2 : s = ['.', '.']
    · rw [ite_eq_left ((fold_eq_dotdot s).2 h2), ite_eq_left h2, List.map_tail]
    · rw [ite_eq_right (fun h => h2 ((fold_eq_dotdot s).1 h)), ite_eq_right h2, List.map_cons]

/-- Resolution commutes with folding. -/
theorem resolveSegs_map_fold (segs : List Seg) : resolveSegs (segs.map fold) = (resolveSegs segs).map fold := by
  unfold resolveSegs
  suffices h : ∀ stack : List Seg, (segs.map fold).foldl resolveStep (stack.map fold) =
      (segs.foldl resolveStep stack).map fold by
    have h0 := h []
    simp only [List.map_nil] at h0
    rw [h0, List.map_reverse]
  induction segs with
  | nil => intro stack; rfl
  | cons s ss ih =>
    intro stack
    simp only [List.map_cons, List.foldl_cons]
    rw [resolveStep_map_fold, ih]

/-- Folding segments keeps them proper. -/
theorem proper_fold (s : Seg) (h : Proper s) : Proper (fold s) := by
  obtain ⟨h1, h2, h3, h4⟩ := h
  exact ⟨fun e => h1 ((fold_eq_nil s).1 e), slashFree_fold s h2, fun e => h3 ((fold_eq_dot s).1 e),
    fun e => h4 ((fold_eq_dotdot s).1 e)⟩

theorem map_fold_fold (l : List Seg) : (l.map fold).map fold = l.map fold := by
  simp [fold_fold]

/-- Folding keeps the segments the links read. -/
theorem fold_linked : ∀ x ∈ linkedSegs, fold x = x := by decide
theorem fold_firmlink : ∀ x ∈ firmlinkSegs, fold x = x := by decide
theorem fold_private : fold privateSeg = privateSeg := by decide
theorem map_fold_dataVolume : dataVolumeSegs.map fold = dataVolumeSegs := by decide

/-- The `/private` links before folding change nothing `canon` sees. -/
theorem canon_privateMapSegs (l : List Seg) : canon (privateMapSegs l) = canon l := by
  unfold privateMapSegs
  rcases linkMapSegs_cases [privateSeg] linkedSegs l with ⟨x, hx, rest, rfl, he⟩ | ⟨-, he⟩
  · rw [he]
    obtain ⟨hxp, hxs, -, -⟩ := linkedSegs_props x hx
    unfold canon
    simp only [List.map_cons, List.cons_append, List.nil_append, fold_private, fold_linked x hx]
    rw [aliasMapSegs_of_head x _ hxs hxp]
    unfold aliasMapSegs
    rw [show firmlinkMapSegs (privateSeg :: x :: rest.map fold) = privateSeg :: x :: rest.map fold from
      linkMapSegs_of_head _ _ _ "system".toList rfl (by simp only [List.head?_cons]; decide),
      privateMapSegs_link x hx]
  · rw [he]

/-- The firmlinks before folding change nothing `canon` sees. -/
theorem canon_firmlinkMapSegs (l : List Seg) : canon (firmlinkMapSegs l) = canon l := by
  unfold firmlinkMapSegs
  rcases linkMapSegs_cases dataVolumeSegs firmlinkSegs l with ⟨x, hx, rest, rfl, he⟩ | ⟨-, he⟩
  · rw [he]
    obtain ⟨hxs, -, -⟩ := firmlinkSegs_props x hx
    unfold canon
    rw [List.map_cons, List.map_append, map_fold_dataVolume, List.map_cons, fold_firmlink x hx]
    unfold aliasMapSegs
    rw [firmlinkMapSegs_link x hx,
      show firmlinkMapSegs (x :: rest.map fold) = x :: rest.map fold from
        linkMapSegs_of_head _ _ _ "system".toList rfl (by simpa using hxs)]
  · rw [he]

/-- Writing a path through its links before folding changes nothing `canon` sees. -/
theorem canon_aliasMapSegs (l : List Seg) : canon (aliasMapSegs l) = canon l := by
  unfold aliasMapSegs
  rw [canon_privateMapSegs, canon_firmlinkMapSegs]

/-- The phase-1 `/private/tmp` mapping changes nothing `canon` sees either. -/
theorem canon_tmpMapSegs (l : List Seg) : canon (tmpMapSegs l) = canon l := by
  by_cases hpt : ∃ t, l = privateSeg :: tmpSeg :: t
  · obtain ⟨t, rfl⟩ := hpt
    rw [tmpMapSegs_private_tmp, ← canon_privateMapSegs (privateSeg :: tmpSeg :: t),
      privateMapSegs_link tmpSeg (by decide)]
  · rw [tmpMapSegs_of_ne l (fun t e => hpt ⟨t, e⟩)]

/-- Folding before `canon` changes nothing. -/
theorem canon_map_fold (l : List Seg) : canon (l.map fold) = canon l := by
  unfold canon; rw [map_fold_fold]

/-- The last segment of `canon`: the folded last segment. -/
theorem getLast?_canon (l : List Seg) : (canon l).getLast? = (l.map fold).getLast? :=
  getLast?_aliasMapSegs _

theorem canon_nil : canon [] = [] := by decide

/-- The last segment survives the phase-1 `/private/tmp` mapping. -/
theorem getLast?_tmpMapSegs (l : List Seg) : (tmpMapSegs l).getLast? = l.getLast? := by
  by_cases hpt : ∃ t, l = privateSeg :: tmpSeg :: t
  · obtain ⟨t, rfl⟩ := hpt
    rw [tmpMapSegs_private_tmp]
    cases t with
    | nil => rfl
    | cons u us => simp [List.getLast?_cons]
  · rw [tmpMapSegs_of_ne l (fun t e => hpt ⟨t, e⟩)]

/-- `canon` keeps segments free of `/`. -/
theorem canon_slashFree (l : List Seg) (h : ∀ w ∈ l, '/' ∉ w) : ∀ w ∈ canon l, '/' ∉ w := by
  apply aliasMapSegs_slashFree
  intro w hw
  obtain ⟨v, hv, rfl⟩ := List.mem_map.1 hw
  exact slashFree_fold v (h v hv)

/-- `canon` keeps segments proper. -/
theorem canon_proper (l : List Seg) (h : ∀ w ∈ l, Proper w) : ∀ w ∈ canon l, Proper w := by
  apply aliasMapSegs_proper
  intro w hw
  obtain ⟨v, hv, rfl⟩ := List.mem_map.1 hw
  exact proper_fold v (h v hv)

/-- The key of a rendered path is the rendering of its segments' `canon`. -/
theorem foldKey_renderAbs (r : List Seg) (h : ∀ w ∈ r, '/' ∉ w) : foldKey (renderAbs r) = renderAbs (canon r) := by
  unfold foldKey canon
  rw [← renderAbs_map_fold, normalizeLinks_renderAbs]
  intro w hw
  obtain ⟨v, hv, rfl⟩ := List.mem_map.1 hw
  exact slashFree_fold v (h v hv)

/-- The key of a string that is not absolute is not absolute. -/
theorem foldKey_rel (x : List Char) (hx : x.head? ≠ some '/') : (foldKey x).head? ≠ some '/' := by
  unfold foldKey
  have : (fold x).head? ≠ some '/' := fun h => hx ((head_fold x).1 h)
  rw [normalizeLinks_rel _ this]
  exact this

/-- `aliasMapSegs` of a list and of a list extended by a segment that no link reads agree on the
part they share. -/
theorem aliasMapSegs_append_cons (F R : List Seg) (x : Seg) (hx : x ∉ aliasHeads) :
    aliasMapSegs (F ++ x :: R) = aliasMapSegs F ++ x :: R :=
  aliasMapSegs_append_head F (x :: R) (fun y hy => by simp only [List.head?_cons, Option.some.injEq] at hy; exact hy ▸ hx)

end SomaVerify.SensitivePath.Proofs
