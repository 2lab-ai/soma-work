import SomaVerify.SensitivePath.Model
import SomaVerify.SensitivePath.Spec

/-!
# Proofs of the sensitive-path invariants: strings, segments and normal forms

The invariants are stated in `Spec.lean`, for the model in `Model.lean`. The work here is in
relating string operations (prefix tests, `split('/')`, slicing) to segment lists: once a path is
written as `renderAbs segs`, every rule of the module is a statement about `segs`. This file
proves (a) `NormalizeIdempotent`, (e) `BasenameRuleDescribed` and (f) `ServiceRuleDescribed`.
`ProofsFold.lean` proves what case folding keeps. `ProofsCheck.lean` proves the invariants about
the checks: (b) to (b'''), `AliasesSpellHome`, (c), (d) to (d''), `globListed_spec` and
`ServiceConfigsFlagged`. `ProofsOriginal.lean` proves `StricterThanOriginal`.
-/

namespace SomaVerify.SensitivePath.Proofs

open SomaVerify.SensitivePath SomaVerify.SensitivePath.Spec

/-! ## `split('/')`, `join('/')` and `renderAbs` -/

theorem consHead_ne_nil (c : Char) (l : List Seg) : consHead c l ≠ [] := by
  cases l <;> simp [consHead]

/-- `split('/')` returns at least one segment. -/
theorem splitSlash_ne_nil (s : List Char) : splitSlash s ≠ [] := by
  cases s with
  | nil => simp [splitSlash]
  | cons c cs => by_cases h : c = '/' <;> simp [splitSlash, h, consHead_ne_nil]

/-- `consHead` only touches the first segment. -/
theorem consHead_append (c : Char) (l m : List Seg) (hl : l ≠ []) :
    consHead c (l ++ m) = consHead c l ++ m := by
  cases l with
  | nil => exact absurd rfl hl
  | cons w ws => simp [consHead]

/-- `split('/')` of `x + '/' + y` is the split of `x` followed by the split of `y`. -/
theorem splitSlash_append_slash (x y : List Char) :
    splitSlash (x ++ '/' :: y) = splitSlash x ++ splitSlash y := by
  induction x with
  | nil => simp [splitSlash]
  | cons c cs ih =>
    by_cases h : c = '/'
    · subst h; simp [splitSlash, ih]
    · simp [splitSlash, h, ih, consHead_append _ _ _ (splitSlash_ne_nil cs)]

/-- A string without `/` splits into itself. -/
theorem splitSlash_of_slashFree (w : List Char) (h : '/' ∉ w) : splitSlash w = [w] := by
  induction w with
  | nil => simp [splitSlash]
  | cons c cs ih =>
    have hc : c ≠ '/' := by rintro rfl; exact h (by simp)
    have hcs : '/' ∉ cs := fun m => h (by simp [m])
    simp [splitSlash, hc, ih hcs, consHead]

/-- No segment of a split contains `/`. -/
theorem slashFree_of_mem_splitSlash (s : List Char) : ∀ w ∈ splitSlash s, '/' ∉ w := by
  induction s with
  | nil => simp [splitSlash]
  | cons c cs ih =>
    by_cases h : c = '/'
    · subst h
      intro w hw
      simp only [splitSlash, ite_true, List.mem_cons] at hw
      rcases hw with rfl | hw
      · simp
      · exact ih w hw
    · intro w hw
      simp only [splitSlash, h, ite_false] at hw
      obtain ⟨v, vs, hv⟩ : ∃ v vs, splitSlash cs = v :: vs := by
        cases hs : splitSlash cs with
        | nil => exact absurd hs (splitSlash_ne_nil cs)
        | cons v vs => exact ⟨v, vs, rfl⟩
      rw [hv] at hw ih
      simp only [consHead, List.mem_cons] at hw
      rcases hw with rfl | hw
      · simp only [List.mem_cons, not_or]
        exact ⟨fun e => h e.symm, ih v (by simp)⟩
      · exact ih w (by simp [hw])

/-- `join('/')` of a first segment that starts with `c` starts with `c`. -/
theorem joinSlash_cons_cons (c : Char) (w : Seg) (ws : List Seg) :
    joinSlash ((c :: w) :: ws) = c :: joinSlash (w :: ws) := by
  cases ws <;> simp [joinSlash]

/-- `join('/')` of an empty first segment starts with `/`. -/
theorem joinSlash_nil_cons (l : List Seg) (hl : l ≠ []) : joinSlash ([] :: l) = '/' :: joinSlash l := by
  cases l with
  | nil => exact absurd rfl hl
  | cons t ts => simp [joinSlash]

/-- `join('/')` after `consHead c` puts `c` in front. -/
theorem joinSlash_consHead (c : Char) (l : List Seg) (hl : l ≠ []) :
    joinSlash (consHead c l) = c :: joinSlash l := by
  cases l with
  | nil => exact absurd rfl hl
  | cons w ws => simp [consHead, joinSlash_cons_cons]

/-- Joining a split gives the string back. -/
theorem joinSlash_splitSlash (s : List Char) : joinSlash (splitSlash s) = s := by
  induction s with
  | nil => simp [splitSlash, joinSlash]
  | cons c cs ih =>
    by_cases h : c = '/'
    · subst h; simp [splitSlash, joinSlash_nil_cons _ (splitSlash_ne_nil cs), ih]
    · simp [splitSlash, h, joinSlash_consHead _ _ (splitSlash_ne_nil cs), ih]

/-- `join('/')` of a concatenation, both parts non-empty. -/
theorem joinSlash_append (l m : List Seg) (hl : l ≠ []) (hm : m ≠ []) :
    joinSlash (l ++ m) = joinSlash l ++ '/' :: joinSlash m := by
  induction l with
  | nil => exact absurd rfl hl
  | cons s ss ih =>
    cases ss with
    | nil =>
      cases m with
      | nil => exact absurd rfl hm
      | cons t ts => simp [joinSlash]
    | cons s2 ss2 =>
      have := ih (by simp)
      simp only [List.cons_append] at this ⊢
      simp [joinSlash, this]

/-- Splitting a join gives the segments back, when none contains `/`. -/
theorem splitSlash_joinSlash (l : List Seg) (hne : l ≠ []) (h : ∀ w ∈ l, '/' ∉ w) :
    splitSlash (joinSlash l) = l := by
  induction l with
  | nil => exact absurd rfl hne
  | cons s ss ih =>
    cases ss with
    | nil => simp [joinSlash, splitSlash_of_slashFree s (h s (by simp))]
    | cons t ts =>
      have hs : '/' ∉ s := h s (by simp)
      have ht : ∀ w ∈ t :: ts, '/' ∉ w := fun w hw => h w (by simp [hw])
      rw [show joinSlash (s :: t :: ts) = s ++ '/' :: joinSlash (t :: ts) by simp [joinSlash],
        splitSlash_append_slash, splitSlash_of_slashFree s hs, ih (by simp) ht]
      simp

/-- `join('/')` of a first segment and the rest. -/
theorem joinSlash_cons_eq (s : Seg) (ss : List Seg) : joinSlash (s :: ss) = s ++ renderAbs ss := by
  induction ss generalizing s with
  | nil => simp [joinSlash, renderAbs]
  | cons t ts ih => simp [joinSlash, renderAbs, ih]

/-- An absolute path is the join of its segments after an empty first one. -/
theorem renderAbs_eq_joinSlash (r : List Seg) : renderAbs r = joinSlash ([] :: r) := by
  cases r with
  | nil => simp [renderAbs, joinSlash]
  | cons s ss => simp [renderAbs, joinSlash, joinSlash_cons_eq]

/-- Rendering is additive over concatenation. -/
theorem renderAbs_append (r t : List Seg) : renderAbs (r ++ t) = renderAbs r ++ renderAbs t := by
  induction r with
  | nil => simp [renderAbs]
  | cons s ss ih => simp [renderAbs, ih]

/-- The segments of `renderAbs r` are `r`, after the empty one before the leading `/`. -/
theorem splitSlash_renderAbs (r : List Seg) (h : ∀ w ∈ r, '/' ∉ w) :
    splitSlash (renderAbs r) = [] :: r := by
  rw [renderAbs_eq_joinSlash]
  exact splitSlash_joinSlash _ (by simp) (by
    intro w hw
    simp only [List.mem_cons] at hw
    rcases hw with rfl | hw
    · simp
    · exact h w hw)

theorem segmentsOf_renderAbs (r : List Seg) (h : ∀ w ∈ r, '/' ∉ w) : segmentsOf (renderAbs r) = r := by
  simp [segmentsOf, splitSlash_renderAbs r h]

theorem head_renderAbs (r : List Seg) (hr : r ≠ []) : (renderAbs r).head? = some '/' := by
  cases r with
  | nil => exact absurd rfl hr
  | cons s ss => simp [renderAbs]

/-- A string splits with an empty first segment exactly when it is empty or absolute. -/
theorem splitSlash_eq_nil_cons_iff (n : List Char) :
    splitSlash n = [] :: segmentsOf n ↔ n = [] ∨ n.head? = some '/' := by
  cases n with
  | nil => simp [splitSlash, segmentsOf]
  | cons c cs =>
    by_cases h : c = '/'
    · subst h; simp [splitSlash, segmentsOf]
    · obtain ⟨v, vs, hv⟩ : ∃ v vs, splitSlash cs = v :: vs := by
        cases hs : splitSlash cs with
        | nil => exact absurd hs (splitSlash_ne_nil cs)
        | cons v vs => exact ⟨v, vs, rfl⟩
      simp [splitSlash, segmentsOf, h, hv, consHead]

/-- An absolute string is the rendering of its segments. -/
theorem eq_renderAbs_segmentsOf (n : List Char) (h : n.head? = some '/') :
    n = renderAbs (segmentsOf n) := by
  have hs := (splitSlash_eq_nil_cons_iff n).2 (Or.inr h)
  rw [renderAbs_eq_joinSlash, ← hs, joinSlash_splitSlash]

/-- `n` is the directory `renderAbs d` or lies below it, in the sense of line 90, exactly when
`n`'s split extends `d`'s. -/
theorem underDirectory_renderAbs_iff (n : List Char) (d : List Seg) (hd : ∀ w ∈ d, '/' ∉ w) :
    underDirectory n (renderAbs d) = true ↔ ∃ t, splitSlash n = [] :: (d ++ t) := by
  unfold underDirectory
  simp only [Bool.or_eq_true, beq_iff_eq, List.isPrefixOf_iff_prefix]
  constructor
  · rintro (rfl | ⟨y, hy⟩)
    · exact ⟨[], by simp [splitSlash_renderAbs d hd]⟩
    · refine ⟨splitSlash y, ?_⟩
      rw [← hy, List.append_assoc, List.singleton_append, splitSlash_append_slash,
        splitSlash_renderAbs d hd]
      simp
  · rintro ⟨t, ht⟩
    have hn : n = joinSlash ([] :: (d ++ t)) := by rw [← ht, joinSlash_splitSlash]
    cases t with
    | nil => left; rw [hn, renderAbs_eq_joinSlash]; simp
    | cons t0 ts =>
      right
      refine ⟨joinSlash (t0 :: ts), ?_⟩
      rw [hn, show ([] :: (d ++ t0 :: ts) : List Seg) = ([] :: d) ++ (t0 :: ts) by simp,
        joinSlash_append _ _ (by simp) (by simp), renderAbs_eq_joinSlash]
      simp

/-- For a non-empty `d`: `n` is at or below `renderAbs d` exactly when `n` is absolute and its
segments begin with `d`. -/
theorem underDirectory_renderAbs_iff_prefix (n : List Char) (d : List Seg) (hd : ∀ w ∈ d, '/' ∉ w)
    (hne : d ≠ []) :
    underDirectory n (renderAbs d) = true ↔ n.head? = some '/' ∧ d <+: segmentsOf n := by
  rw [underDirectory_renderAbs_iff n d hd]
  constructor
  · rintro ⟨t, ht⟩
    have hsplit : splitSlash n = [] :: segmentsOf n := by simp [segmentsOf, ht]
    rcases (splitSlash_eq_nil_cons_iff n).1 hsplit with rfl | hh
    · simp [splitSlash] at ht; exact absurd ht.1 hne
    · exact ⟨hh, ⟨t, by simp [segmentsOf, ht]⟩⟩
  · rintro ⟨hh, t, ht⟩
    exact ⟨t, by rw [(splitSlash_eq_nil_cons_iff n).2 (Or.inr hh), ← ht]⟩

/-! ## Resolution of `.`, `..` and empty segments -/

theorem proper_of_resolveStep_mem (stack : List Seg) (s : Seg) (hstack : ∀ w ∈ stack, Proper w)
    (hs : '/' ∉ s) : ∀ w ∈ resolveStep stack s, Proper w := by
  unfold resolveStep
  split
  · exact hstack
  · split
    · intro w hw; exact hstack w (List.mem_of_mem_tail hw)
    · rename_i h1 h2
      intro w hw
      simp only [List.mem_cons] at hw
      rcases hw with rfl | hw
      · exact ⟨fun e => h1 (Or.inl e), hs, fun e => h1 (Or.inr e), h2⟩
      · exact hstack w hw

/-- Resolving keeps only proper segments. -/
theorem proper_of_foldl_resolveStep (l : List Seg) (stack : List Seg) (hstack : ∀ w ∈ stack, Proper w)
    (hl : ∀ w ∈ l, '/' ∉ w) : ∀ w ∈ l.foldl resolveStep stack, Proper w := by
  induction l generalizing stack with
  | nil => simpa using hstack
  | cons s ss ih =>
    simp only [List.foldl_cons]
    exact ih _ (proper_of_resolveStep_mem stack s hstack (hl s (by simp)))
      (fun w hw => hl w (by simp [hw]))

/-- Resolution leaves only proper segments. -/
theorem proper_of_mem_resolveSegs (l : List Seg) (hl : ∀ w ∈ l, '/' ∉ w) :
    ∀ w ∈ resolveSegs l, Proper w := by
  intro w hw
  simp only [resolveSegs, List.mem_reverse] at hw
  exact proper_of_foldl_resolveStep l [] (by simp) hl w hw

/-- A proper segment is kept. -/
theorem resolveStep_of_proper (stack : List Seg) (s : Seg) (hs : Proper s) :
    resolveStep stack s = s :: stack := by
  obtain ⟨h1, _, h3, h4⟩ := hs
  simp [resolveStep, h1, h3, h4]

/-- Resolving proper segments keeps them all. -/
theorem foldl_resolveStep_of_proper (l stack : List Seg) (hl : ∀ w ∈ l, Proper w) :
    l.foldl resolveStep stack = l.reverse ++ stack := by
  induction l generalizing stack with
  | nil => simp
  | cons s ss ih =>
    simp only [List.foldl_cons, resolveStep_of_proper stack s (hl s (by simp))]
    rw [ih _ (fun w hw => hl w (by simp [hw]))]
    simp

/-- Resolution does nothing to proper segments. -/
theorem resolveSegs_of_proper (l : List Seg) (hl : ∀ w ∈ l, Proper w) : resolveSegs l = l := by
  simp [resolveSegs, foldl_resolveStep_of_proper l [] hl]

/-- The empty segment before a leading `/` does not affect resolution. -/
theorem resolveSegs_nil_cons (l : List Seg) : resolveSegs ([] :: l) = resolveSegs l := by
  simp [resolveSegs, resolveStep]

/-- A trailing empty segment (a trailing `/`) does not affect resolution. -/
theorem resolveSegs_append_nil (l : List Seg) : resolveSegs (l ++ [[]]) = resolveSegs l := by
  simp [resolveSegs, List.foldl_append, resolveStep]

/-- Proper segments contain no `/`. -/
theorem proper_slashFree {l : List Seg} (h : ∀ w ∈ l, Proper w) : ∀ w ∈ l, '/' ∉ w :=
  fun w hw => (h w hw).2.1

/-! ## `path.posix.normalize` and `path.posix.join` -/

/-- Normalize spells the resolved segments, with one extra empty segment (a trailing `/`) when
nothing is left or the input ends with `/`. -/
theorem posixNormalize_eq (x : List Char) :
    ∃ e : List Seg, (e = [] ∨ e = [[]]) ∧ posixNormalize x = renderAbs (resolveSegs (splitSlash x) ++ e) := by
  unfold posixNormalize
  split
  · rename_i h; exact ⟨[[]], Or.inr rfl, by simp [h, renderAbs]⟩
  · rename_i r hr
    by_cases hl : x.getLast? = some '/'
    · exact ⟨[[]], Or.inr rfl, by simp [hl, renderAbs_append, renderAbs]⟩
    · exact ⟨[], Or.inl rfl, by simp [hl]⟩

/-- Resolved segments, with at most one empty segment appended, contain no `/`. -/
theorem slashFree_of_resolve_append (l : List Seg) (hl : ∀ w ∈ l, '/' ∉ w) (e : List Seg)
    (he : e = [] ∨ e = [[]]) : ∀ w ∈ resolveSegs l ++ e, '/' ∉ w := by
  intro w hw
  simp only [List.mem_append] at hw
  rcases hw with hw | hw
  · exact (proper_of_mem_resolveSegs l hl w hw).2.1
  · rcases he with rfl | rfl <;> simp_all

/-- Normalizing again resolves to the same segments. -/
theorem resolveSegs_splitSlash_posixNormalize (x : List Char) :
    resolveSegs (splitSlash (posixNormalize x)) = resolveSegs (splitSlash x) := by
  obtain ⟨e, he, hx⟩ := posixNormalize_eq x
  have hsf := slashFree_of_mem_splitSlash x
  rw [hx, splitSlash_renderAbs _ (slashFree_of_resolve_append _ hsf e he), resolveSegs_nil_cons]
  rcases he with rfl | rfl
  · simp [resolveSegs_of_proper _ (proper_of_mem_resolveSegs _ hsf)]
  · rw [resolveSegs_append_nil, resolveSegs_of_proper _ (proper_of_mem_resolveSegs _ hsf)]

/-- Normalize always returns an absolute path. -/
theorem posixNormalize_head (x : List Char) : (posixNormalize x).head? = some '/' := by
  unfold posixNormalize
  cases h : resolveSegs (splitSlash x) with
  | nil => simp
  | cons s ss => simp [renderAbs]

/-- A string ending in a non-empty run without `/` does not end with `/`. -/
theorem getLast?_append_ne_slash (x s : List Char) (hne : s ≠ []) (hsf : '/' ∉ s) :
    (x ++ s).getLast? ≠ some '/' := by
  rw [List.getLast?_append]
  obtain ⟨c, hc⟩ : ∃ c, s.getLast? = some c := by
    cases h : s.getLast? with
    | none => simp at h; exact absurd h hne
    | some c => exact ⟨c, rfl⟩
  rw [hc]
  intro h
  simp only [Option.some_or, Option.some.injEq] at h
  subst h
  exact hsf (List.mem_of_getLast? hc)

/-- A rendered path of proper segments does not end with `/`. -/
theorem getLast?_renderAbs_ne_slash (r : List Seg) (hr : ∀ w ∈ r, Proper w) :
    (renderAbs r).getLast? ≠ some '/' := by
  rcases List.eq_nil_or_concat r with rfl | ⟨r', s, rfl⟩
  · simp [renderAbs]
  · obtain ⟨hne, hsf, _, _⟩ := hr s (by simp)
    rw [List.concat_eq_append, renderAbs_append,
      show renderAbs [s] = ['/'] ++ s by simp [renderAbs], ← List.append_assoc]
    exact getLast?_append_ne_slash _ s hne hsf

/-- Normalize leaves a canonical absolute path unchanged. -/
theorem posixNormalize_renderAbs (r : List Seg) (hne : r ≠ []) (hr : ∀ w ∈ r, Proper w) :
    posixNormalize (renderAbs r) = renderAbs r := by
  unfold posixNormalize
  rw [splitSlash_renderAbs r (proper_slashFree hr), resolveSegs_nil_cons, resolveSegs_of_proper r hr]
  cases r with
  | nil => exact absurd rfl hne
  | cons s ss =>
    have h := getLast?_renderAbs_ne_slash (s :: ss) hr
    simp only [h, ite_false, List.append_nil]

/-- A non-empty list of proper segments: the location of a directory other than the root. -/
def Canonical (hs : List Seg) : Prop :=
  hs ≠ [] ∧ ∀ s ∈ hs, Proper s

instance (s : Seg) : Decidable (Proper s) :=
  inferInstanceAs (Decidable (s ≠ [] ∧ '/' ∉ s ∧ s ≠ ['.'] ∧ s ≠ ['.', '.']))

instance (hs : List Seg) : Decidable (Canonical hs) :=
  inferInstanceAs (Decidable (hs ≠ [] ∧ ∀ s ∈ hs, Proper s))

/-- Resolving a list that ends in proper segments resolves the rest and keeps them. -/
theorem resolveSegs_append_proper (l segs : List Seg) (hsegs : ∀ w ∈ segs, Proper w) :
    resolveSegs (l ++ segs) = resolveSegs l ++ segs := by
  unfold resolveSegs
  rw [List.foldl_append, foldl_resolveStep_of_proper segs _ hsegs]
  simp

/-- `path.join(HOME, s₁, …)` of an absolute HOME and proper segments: the location HOME resolves
to, followed by the segments. -/
theorem pathJoin_abs (home : List Char) (segs : List Seg) (hh : home.head? = some '/') (hne : segs ≠ [])
    (hsegs : ∀ w ∈ segs, Proper w) :
    pathJoin (home :: segs) = renderAbs (resolveSegs (splitSlash home) ++ segs) := by
  have hfilter : (home :: segs).filter (fun a => !a.isEmpty) = home :: segs := by
    rw [List.filter_eq_self]
    intro a ha
    simp only [List.mem_cons] at ha
    rcases ha with rfl | ha
    · cases a with
      | nil => simp at hh
      | cons c cs => simp
    · simpa using (hsegs a ha).1
  have hsplit : splitSlash (joinSlash (home :: segs)) = splitSlash home ++ segs := by
    rw [joinSlash_cons_eq]
    cases segs with
    | nil => exact absurd rfl hne
    | cons t ts =>
      rw [show renderAbs (t :: ts) = '/' :: (t ++ renderAbs ts) by rfl, splitSlash_append_slash,
        ← joinSlash_cons_eq, splitSlash_joinSlash _ (by simp) (proper_slashFree hsegs)]
  have hlast : (joinSlash (home :: segs)).getLast? ≠ some '/' := by
    obtain ⟨r', s, hrs⟩ : ∃ r' s, segs = r' ++ [s] := by
      rcases List.eq_nil_or_concat segs with h | ⟨r', s, h⟩
      · exact absurd h hne
      · exact ⟨r', s, by simpa using h⟩
    have hs : Proper s := hsegs s (by rw [hrs]; simp)
    rw [joinSlash_cons_eq, hrs, renderAbs_append, show renderAbs [s] = ['/'] ++ s by simp [renderAbs],
      ← List.append_assoc, ← List.append_assoc]
    exact getLast?_append_ne_slash _ s hs.1 hs.2.1
  have hres : resolveSegs (splitSlash (joinSlash (home :: segs))) = resolveSegs (splitSlash home) ++ segs := by
    rw [hsplit, resolveSegs_append_proper _ _ hsegs]
  have hne' : resolveSegs (splitSlash home) ++ segs ≠ [] := by simp [hne]
  unfold pathJoin posixNormalize
  rw [hfilter]
  generalize hx : resolveSegs (splitSlash (joinSlash (home :: segs))) = x at hres
  subst hres
  cases hx' : resolveSegs (splitSlash home) ++ segs with
  | nil => exact absurd hx' hne'
  | cons r rs => simp [hlast]

/-- `path.join(HOME, s₁, …)` of a canonical HOME and proper segments is their rendering. -/
theorem pathJoin_renderAbs (hs segs : List Seg) (hhome : Canonical hs) (hne : segs ≠ [])
    (hsegs : ∀ w ∈ segs, Proper w) :
    pathJoin (renderAbs hs :: segs) = renderAbs (hs ++ segs) := by
  rw [pathJoin_abs _ _ (head_renderAbs hs hhome.1) hne hsegs, splitSlash_renderAbs hs (proper_slashFree hhome.2),
    resolveSegs_nil_cons, resolveSegs_of_proper hs hhome.2]

/-! ## `normalizeTmpPath` -/

theorem tmpMapSegs_of_ne (r : List Seg) (h : ∀ rest, r ≠ privateSeg :: tmpSeg :: rest) :
    tmpMapSegs r = r := by
  unfold tmpMapSegs
  split
  · rename_i s t rest
    split
    · rename_i hst; exact absurd (by rw [hst.1, hst.2]) (h rest)
    · rfl
  · rfl

/-- `/private/tmp/…` maps to `/tmp/…`. -/
theorem tmpMapSegs_private_tmp (rest : List Seg) :
    tmpMapSegs (privateSeg :: tmpSeg :: rest) = tmpSeg :: rest := by
  simp [tmpMapSegs]

/-- `PRIVATE_TMP_PREFIX` is the rendering of the segments `private`, `tmp`. -/
theorem privateTmp_eq : privateTmp = renderAbs [privateSeg, tmpSeg] := by decide

/-- `PRIVATE_TMP_PREFIX` splits into an empty segment, `private` and `tmp`. -/
theorem splitSlash_privateTmp : splitSlash privateTmp = [[], privateSeg, tmpSeg] := by decide

/-- A path at or below `/private/tmp`, as segments, is mapped to `/tmp`. -/
theorem normalizeTmpPath_private_tmp (t : List Seg) :
    normalizeTmpPath (renderAbs (privateSeg :: tmpSeg :: t)) = renderAbs (tmpSeg :: t) := by
  have hsplit : renderAbs (privateSeg :: tmpSeg :: t) = privateTmp ++ renderAbs t := by
    rw [privateTmp_eq, ← renderAbs_append]; rfl
  have hlen : privateTmp.length = 12 := by decide
  have hpre : privateTmp.isPrefixOf (privateTmp ++ renderAbs t) = true :=
    List.isPrefixOf_iff_prefix.2 (List.prefix_append _ _)
  unfold normalizeTmpPath
  rw [hsplit, hpre]
  simp only [Bool.not_true, Bool.false_eq_true, ite_false]
  rw [List.drop_left' rfl]
  cases t with
  | nil => simp [renderAbs, tmpSeg]
  | cons s ss => simp [renderAbs, tmpSeg]

/-- Any other string is left alone. -/
theorem normalizeTmpPath_of_ne (s : List Char)
    (h : ∀ t, splitSlash s ≠ [] :: privateSeg :: tmpSeg :: t) : normalizeTmpPath s = s := by
  unfold normalizeTmpPath
  by_cases hpre : privateTmp.isPrefixOf s = true
  · obtain ⟨R, hR⟩ := List.isPrefixOf_iff_prefix.1 hpre
    subst hR
    simp only [hpre, Bool.not_true, Bool.false_eq_true, ite_false]
    rw [List.drop_left' rfl]
    cases R with
    | nil => exact absurd (by simp [splitSlash_privateTmp]) (h [])
    | cons c cs =>
      by_cases hc : c = '/'
      · subst hc
        exfalso
        apply h (splitSlash cs)
        rw [splitSlash_append_slash, splitSlash_privateTmp]
        rfl
      · have hc' : ('/' = c) = False := propext ⟨fun e => hc e.symm, False.elim⟩
        simp [List.isPrefixOf, hc']
  · simp [hpre]

/-- On a rendered absolute path (segments without `/`), `normalizeTmpPath` is `tmpMapSegs`. -/
theorem normalizeTmpPath_renderAbs (r : List Seg) (hr : ∀ w ∈ r, '/' ∉ w) :
    normalizeTmpPath (renderAbs r) = renderAbs (tmpMapSegs r) := by
  by_cases hpt : ∃ t, r = privateSeg :: tmpSeg :: t
  · obtain ⟨t, rfl⟩ := hpt
    rw [normalizeTmpPath_private_tmp, tmpMapSegs_private_tmp]
  · have hne : ∀ t, r ≠ privateSeg :: tmpSeg :: t := fun t e => hpt ⟨t, e⟩
    rw [tmpMapSegs_of_ne r hne]
    apply normalizeTmpPath_of_ne
    intro t ht
    rw [splitSlash_renderAbs r hr] at ht
    exact hne t (List.cons.inj ht).2

/-- A trailing empty segment (a trailing `/`) does not affect the `/private/tmp` mapping. -/
theorem tmpMapSegs_append_nil (r : List Seg) : tmpMapSegs (r ++ [[]]) = tmpMapSegs r ++ [[]] := by
  by_cases hpt : ∃ t, r = privateSeg :: tmpSeg :: t
  · obtain ⟨t, rfl⟩ := hpt
    simp [tmpMapSegs_private_tmp]
  · have hne : ∀ t, r ≠ privateSeg :: tmpSeg :: t := fun t e => hpt ⟨t, e⟩
    rw [tmpMapSegs_of_ne r hne, tmpMapSegs_of_ne]
    intro t ht
    match r, ht with
    | [], ht => simp at ht
    | [a], ht => simp [tmpSeg] at ht
    | a :: b :: rest, ht =>
      simp only [List.cons_append, List.cons.injEq] at ht
      exact hne rest (by rw [ht.1, ht.2.1])

/-- The `/private/tmp` mapping keeps segments proper. -/
theorem tmpMapSegs_proper (r : List Seg) (hr : ∀ w ∈ r, Proper w) : ∀ w ∈ tmpMapSegs r, Proper w := by
  by_cases hpt : ∃ t, r = privateSeg :: tmpSeg :: t
  · obtain ⟨t, rfl⟩ := hpt
    rw [tmpMapSegs_private_tmp]
    intro w hw
    simp only [List.mem_cons] at hw
    rcases hw with rfl | hw
    · exact ⟨by decide, by decide, by decide, by decide⟩
    · exact hr w (by simp [hw])
  · rw [tmpMapSegs_of_ne r (fun t e => hpt ⟨t, e⟩)]; exact hr

/-- Mapping `/private/tmp` twice is mapping it once. -/
theorem tmpMapSegs_idem (r : List Seg) : tmpMapSegs (tmpMapSegs r) = tmpMapSegs r := by
  by_cases hpt : ∃ t, r = privateSeg :: tmpSeg :: t
  · obtain ⟨t, rfl⟩ := hpt
    rw [tmpMapSegs_private_tmp, tmpMapSegs_of_ne]
    intro t' h
    simp only [List.cons.injEq] at h
    exact absurd h.1 (by decide)
  · rw [tmpMapSegs_of_ne r (fun t e => hpt ⟨t, e⟩), tmpMapSegs_of_ne r (fun t e => hpt ⟨t, e⟩)]

/-! ## Trailing slashes -/

theorem stripTrailingSlashes_append_slash (s : List Char) :
    stripTrailingSlashes (s ++ ['/']) = stripTrailingSlashes s := by
  simp [stripTrailingSlashes]

/-- A string not ending with `/` has nothing to strip. -/
theorem stripTrailingSlashes_of_getLast (s : List Char) (h : s.getLast? ≠ some '/') :
    stripTrailingSlashes s = s := by
  unfold stripTrailingSlashes
  cases hr : s.reverse with
  | nil => simp [List.reverse_eq_nil_iff.1 hr]
  | cons c cs =>
    have hc : c ≠ '/' := by
      intro e
      apply h
      rw [← List.head?_reverse, hr, e]; rfl
    rw [List.dropWhile_cons]
    simp [hc, ← hr]

/-- A rendered path of proper segments has no trailing slash to strip. -/
theorem stripTrailingSlashes_renderAbs (r : List Seg) (hr : ∀ w ∈ r, Proper w) :
    stripTrailingSlashes (renderAbs r) = renderAbs r :=
  stripTrailingSlashes_of_getLast _ (getLast?_renderAbs_ne_slash r hr)

/-- A string is its stripped form followed by slashes. -/
theorem eq_stripTrailingSlashes_append (s : List Char) :
    ∃ w, s = stripTrailingSlashes s ++ w ∧ ∀ c ∈ w, c = '/' := by
  refine ⟨(s.reverse.takeWhile (· == '/')).reverse, ?_, ?_⟩
  · unfold stripTrailingSlashes
    rw [← List.reverse_append, List.takeWhile_append_dropWhile, List.reverse_reverse]
  · intro c hc
    rw [List.mem_reverse] at hc
    have hall := List.all_takeWhile (p := (· == '/')) (l := s.reverse)
    rw [List.all_eq_true] at hall
    simpa using hall c hc

/-- Stripping trailing slashes twice is stripping them once. -/
theorem stripTrailingSlashes_idem (s : List Char) :
    stripTrailingSlashes (stripTrailingSlashes s) = stripTrailingSlashes s := by
  unfold stripTrailingSlashes
  rw [List.reverse_reverse]
  congr 1
  generalize s.reverse = l
  induction l with
  | nil => simp
  | cons c cs ih =>
    by_cases hc : c = '/'
    · simp [hc, ih]
    · simp [hc]


/-! ## `normalizePath` -/

theorem homeAliases_eq :
    homeAliases = [['~'], ['$', 'H', 'O', 'M', 'E'], ['$', '{', 'H', 'O', 'M', 'E', '}']] := rfl

/-- `s` is an alias, or an alias followed by `/`. -/
def MatchesAlias (s : List Char) : Prop :=
  ∃ a ∈ homeAliases, s = a ∨ (a ++ ['/']) <+: s

theorem expandHome_of_not_matches (home s : List Char) (aliases : List (List Char))
    (h : ∀ a ∈ aliases, ¬ (s = a ∨ (a ++ ['/']) <+: s)) : expandHome home s aliases = s := by
  induction aliases with
  | nil => rfl
  | cons a as ih =>
    have ha := h a (by simp)
    have hcond : (s == a || (a ++ ['/']).isPrefixOf s) = false := by
      cases e1 : (s == a)
      · cases e2 : (a ++ ['/']).isPrefixOf s
        · rfl
        · exact absurd (Or.inr (List.isPrefixOf_iff_prefix.1 e2)) ha
      · exact absurd (Or.inl (beq_iff_eq.1 e1)) ha
    simp only [expandHome, hcond, Bool.false_eq_true, ite_false]
    exact ih (fun a' ha' => h a' (by simp [ha']))

/-- No alias matches an absolute path: every alias starts with `~` or `$`. -/
theorem not_matchesAlias_of_head (s : List Char) (h : s.head? = some '/') : ¬ MatchesAlias s := by
  rintro ⟨a, ha, hm⟩
  rw [homeAliases_eq] at ha
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha
  rcases hm with rfl | ⟨t, ht⟩
  · rcases ha with rfl | rfl | rfl <;> simp at h
  · subst ht
    rcases ha with rfl | rfl | rfl <;> simp at h

/-- No alias matches the empty string. -/
theorem not_matchesAlias_nil : ¬ MatchesAlias [] := by
  rintro ⟨a, ha, hm⟩
  rw [homeAliases_eq] at ha
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha
  rcases hm with hm | hm
  · rcases ha with rfl | rfl | rfl <;> simp at hm
  · rcases ha with rfl | rfl | rfl <;> simp at hm

/-- A path that matches no alias is not expanded. -/
theorem expandHome_of_not_matchesAlias (home s : List Char) (h : ¬ MatchesAlias s) :
    expandHome home s homeAliases = s :=
  expandHome_of_not_matches home s homeAliases (fun a ha hm => h ⟨a, ha, hm⟩)

/-- An alias followed by `/` is HOME followed by `/`. -/
theorem expandHome_alias_slash (home rest a : List Char) (ha : a ∈ homeAliases) :
    expandHome home (a ++ '/' :: rest) homeAliases = home ++ '/' :: rest := by
  rw [homeAliases_eq] at ha ⊢
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha
  rcases ha with rfl | rfl | rfl <;> simp [expandHome, List.isPrefixOf]

/-- An alias alone is HOME. -/
theorem expandHome_alias (home a : List Char) (ha : a ∈ homeAliases) :
    expandHome home a homeAliases = home := by
  rw [homeAliases_eq] at ha ⊢
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha
  rcases ha with rfl | rfl | rfl <;> simp [expandHome, List.isPrefixOf]

/-- What `resolvePath` does after `path.posix.normalize`: `/private/tmp` mapping and trailing
slashes leave the resolved segments, with `/private/tmp` written `/tmp`. -/
theorem finish_posixNormalize (z : List Char) :
    stripTrailingSlashes (normalizeTmpPath (posixNormalize z)) =
      renderAbs (tmpMapSegs (resolveSegs (splitSlash z))) := by
  obtain ⟨e, he, hz⟩ := posixNormalize_eq z
  have hsf := slashFree_of_mem_splitSlash z
  have hproper := proper_of_mem_resolveSegs _ hsf
  rw [hz, normalizeTmpPath_renderAbs _ (slashFree_of_resolve_append _ hsf e he)]
  rcases he with rfl | rfl
  · rw [List.append_nil, stripTrailingSlashes_renderAbs _ (tmpMapSegs_proper _ hproper)]
  · rw [tmpMapSegs_append_nil, renderAbs_append,
      show renderAbs ([[]] : List Seg) = ['/'] by rfl, stripTrailingSlashes_append_slash,
      stripTrailingSlashes_renderAbs _ (tmpMapSegs_proper _ hproper)]

/-- `resolvePath` of an absolute path: its resolved segments, `/private/tmp` written `/tmp`. -/
theorem resolvePath_abs (x : List Char) (hx : x.head? = some '/') :
    resolvePath x = renderAbs (tmpMapSegs (resolveSegs (splitSlash x))) := by
  have hpre : ['/'].isPrefixOf x = true := by
    cases x with
    | nil => simp at hx
    | cons c cs => simp at hx; subst hx; simp [List.isPrefixOf]
  unfold resolvePath
  simp only [hpre, ite_true]
  exact finish_posixNormalize x

/-- A string that is not absolute is not under `/private/tmp`. -/
theorem normalizeTmpPath_rel (x : List Char) (hx : x.head? ≠ some '/') : normalizeTmpPath x = x := by
  apply normalizeTmpPath_of_ne
  intro t ht
  cases x with
  | nil => simp [splitSlash] at ht
  | cons c cs =>
    have hc : c ≠ '/' := fun e => hx (by simp [e])
    simp only [splitSlash, hc, ite_false] at ht
    cases hs : splitSlash cs with
    | nil => exact splitSlash_ne_nil cs hs
    | cons v vs => rw [hs] at ht; simp [consHead] at ht

/-- `resolvePath` of a string that is not absolute only drops trailing slashes. -/
theorem resolvePath_rel (x : List Char) (hx : x.head? ≠ some '/') :
    resolvePath x = stripTrailingSlashes x := by
  have hpre : ['/'].isPrefixOf x = false := by
    cases x with
    | nil => rfl
    | cons c cs =>
      have hc : ('/' = c) = False := propext ⟨fun e => hx (by simp [← e]), False.elim⟩
      simp [List.isPrefixOf, hc]
  unfold resolvePath
  simp only [hpre, Bool.false_eq_true, ite_false]
  rw [normalizeTmpPath_rel x hx]

/-- An absolute path normalizes to its resolved segments, `/private/tmp` written `/tmp`. -/
theorem normalizePath_abs (home x : List Char) (hx : x.head? = some '/') :
    normalizePath home x = renderAbs (tmpMapSegs (resolveSegs (splitSlash x))) := by
  unfold normalizePath
  rw [expandHome_of_not_matchesAlias home x (not_matchesAlias_of_head x hx)]
  exact resolvePath_abs x hx

/-- A path that is neither absolute nor starts with a HOME alias only loses trailing slashes. -/
theorem normalizePath_rel (home x : List Char) (hm : ¬ MatchesAlias x) (hx : x.head? ≠ some '/') :
    normalizePath home x = stripTrailingSlashes x := by
  unfold normalizePath
  rw [expandHome_of_not_matchesAlias home x hm]
  exact resolvePath_rel x hx

/-- The join `path.join(HOME, rest)` builds for an absolute HOME. -/
theorem pathJoin_home (home rest : List Char) (hh : home.head? = some '/') :
    pathJoin [home, rest] = posixNormalize (if rest.isEmpty then home else home ++ '/' :: rest) := by
  have hne : home.isEmpty = false := by cases home <;> simp_all
  unfold pathJoin
  cases rest with
  | nil => simp [hne, joinSlash]
  | cons c cs => simp [hne, joinSlash]

/-- HOME followed by `/` and anything is absolute. -/
theorem head_home_slash (home rest : List Char) (hh : home.head? = some '/') :
    (home ++ '/' :: rest).head? = some '/' := by
  cases home <;> simp_all

/-- For an absolute HOME, a path expands to an absolute path, or to itself when it is neither
absolute nor an alias. -/
theorem expandHome_cases (home p : List Char) (hh : home.head? = some '/') :
    (expandHome home p homeAliases).head? = some '/' ∨
      (¬ MatchesAlias p ∧ p.head? ≠ some '/' ∧ expandHome home p homeAliases = p) := by
  by_cases hm : MatchesAlias p
  · left
    obtain ⟨a, ha, heq | ⟨t, ht⟩⟩ := hm
    · rw [heq, expandHome_alias home a ha]; exact hh
    · subst ht
      rw [List.append_assoc, List.singleton_append, expandHome_alias_slash home t a ha]
      exact head_home_slash home t hh
  · by_cases hx : p.head? = some '/'
    · left; rw [expandHome_of_not_matchesAlias home p hm]; exact hx
    · right; exact ⟨hm, hx, expandHome_of_not_matchesAlias home p hm⟩

/-- For an absolute HOME, expanding twice is expanding once. -/
theorem expandHome_idem (home p : List Char) (hh : home.head? = some '/') :
    expandHome home (expandHome home p homeAliases) homeAliases = expandHome home p homeAliases := by
  rcases expandHome_cases home p hh with habs | ⟨hm, _, heq⟩
  · exact expandHome_of_not_matchesAlias home _ (not_matchesAlias_of_head _ habs)
  · rw [heq]; exact expandHome_of_not_matchesAlias home p hm

/-- An alias followed by `/` normalizes like HOME followed by `/`. -/
theorem normalizePath_alias_slash (home rest a : List Char) (hh : home.head? = some '/')
    (ha : a ∈ homeAliases) :
    normalizePath home (a ++ '/' :: rest) = normalizePath home (home ++ '/' :: rest) := by
  unfold normalizePath
  rw [expandHome_alias_slash home rest a ha,
    expandHome_of_not_matchesAlias home _ (not_matchesAlias_of_head _ (head_home_slash home rest hh))]

/-- An alias alone normalizes like HOME. -/
theorem normalizePath_alias (home a : List Char) (hh : home.head? = some '/') (ha : a ∈ homeAliases) :
    normalizePath home a = normalizePath home home := by
  unfold normalizePath
  rw [expandHome_alias home a ha, expandHome_of_not_matchesAlias home home (not_matchesAlias_of_head home hh)]

/-- The empty string normalizes to itself. -/
theorem normalizePath_nil (home : List Char) : normalizePath home [] = [] := by
  rw [normalizePath_rel home [] not_matchesAlias_nil (by simp)]
  rfl

/-- Stripping trailing slashes leaves a prefix. -/
theorem stripTrailingSlashes_prefix (s : List Char) : stripTrailingSlashes s <+: s := by
  obtain ⟨w, hw, _⟩ := eq_stripTrailingSlashes_append s
  exact ⟨w, hw.symm⟩

/-- Stripping trailing slashes cannot make a path match an alias. -/
theorem not_matchesAlias_strip (s : List Char) (hm : ¬ MatchesAlias s) :
    ¬ MatchesAlias (stripTrailingSlashes s) := by
  rintro ⟨a, ha, heq | hpre⟩
  · obtain ⟨w, hw, hslash⟩ := eq_stripTrailingSlashes_append s
    rw [heq] at hw
    cases w with
    | nil => exact hm ⟨a, ha, Or.inl (by simpa using hw)⟩
    | cons c cs =>
      have hc : c = '/' := hslash c (by simp)
      subst hc
      exact hm ⟨a, ha, Or.inr ⟨cs, by rw [hw]; simp⟩⟩
  · exact hm ⟨a, ha, Or.inr (hpre.trans (stripTrailingSlashes_prefix s))⟩

/-- Stripping trailing slashes cannot make a relative path absolute. -/
theorem head_strip (s : List Char) (hx : s.head? ≠ some '/') :
    (stripTrailingSlashes s).head? ≠ some '/' := by
  intro h
  apply hx
  obtain ⟨t, ht⟩ := stripTrailingSlashes_prefix s
  rw [← ht]
  cases hst : stripTrailingSlashes s with
  | nil => rw [hst] at h; simp at h
  | cons c cs => rw [hst] at h; simpa using h

/-- Every path normalizes to one of two forms: a rendered absolute path (proper segments, no
`/private/tmp` prefix left), or a relative path that only lost its trailing slashes. -/
theorem normalizePath_cases (home p : List Char) (hh : home.head? = some '/') :
    (∃ R : List Seg, normalizePath home p = renderAbs (tmpMapSegs (resolveSegs R)) ∧ ∀ w ∈ R, '/' ∉ w) ∨
    (¬ MatchesAlias p ∧ p.head? ≠ some '/' ∧ normalizePath home p = stripTrailingSlashes p) := by
  rcases expandHome_cases home p hh with habs | ⟨hm, hx, _⟩
  · left
    refine ⟨splitSlash (expandHome home p homeAliases), ?_, slashFree_of_mem_splitSlash _⟩
    unfold normalizePath
    exact resolvePath_abs _ habs
  · right
    exact ⟨hm, hx, normalizePath_rel home p hm hx⟩

/-- `normalizePath` on a rendered absolute path whose segments are proper and already mapped. -/
theorem normalizePath_renderAbs_tmpMap (home : List Char) (R : List Seg) (hR : ∀ w ∈ R, '/' ∉ w) :
    normalizePath home (renderAbs (tmpMapSegs (resolveSegs R))) = renderAbs (tmpMapSegs (resolveSegs R)) := by
  have hproper := tmpMapSegs_proper _ (proper_of_mem_resolveSegs R hR)
  generalize hr : tmpMapSegs (resolveSegs R) = r at hproper ⊢
  cases r with
  | nil => exact normalizePath_nil home
  | cons s ss =>
    rw [normalizePath_abs home _ (by simp [renderAbs]), splitSlash_renderAbs _ (proper_slashFree hproper),
      resolveSegs_nil_cons, resolveSegs_of_proper _ hproper, ← hr, tmpMapSegs_idem]

/-- (a) `normalizePath` is idempotent: its result is a normal form. -/
theorem normalizePath_idempotent (home : List Char) (hh : home.head? = some '/') :
    NormalizeIdempotent home := by
  intro p
  rcases normalizePath_cases home p hh with ⟨R, hp, hR⟩ | ⟨hm, hx, hp⟩
  · rw [hp]; exact normalizePath_renderAbs_tmpMap home R hR
  · rw [hp, normalizePath_rel home _ (not_matchesAlias_strip p hm) (head_strip p hx),
      stripTrailingSlashes_idem]

/-! ## `checkSensitivePath` -/

theorem ne_nil_of_head (x : List Char) (h : x.head? = some '/') : x ≠ [] := by
  rintro rfl; simp at h

/-- `path.join` never returns the empty string here. -/
theorem pathJoin_ne_nil (args : List (List Char)) : pathJoin args ≠ [] :=
  ne_nil_of_head _ (posixNormalize_head _)

/-- `checkSensitivePath` is the verdict on the normal form and the walk points. -/
theorem checkSensitivePath_eq_verdict (home p : List Char) :
    checkSensitivePath home p = verdict home (normalizePath home p) (walkPoints home p) :=
  rfl

/-- Normalization leaves no empty, `.` or `..` segment in an absolute path: the segments of an
absolute normal form are all proper. -/
theorem normalizePath_segments_proper (home : List Char) (hh : home.head? = some '/') (p : List Char)
    (hp : (normalizePath home p).head? = some '/') : ∀ w ∈ segmentsOf (normalizePath home p), Proper w := by
  rcases normalizePath_cases home p hh with ⟨R, hN, hR⟩ | ⟨_, hx, hN⟩
  · have hproper := tmpMapSegs_proper _ (proper_of_mem_resolveSegs R hR)
    rw [hN, segmentsOf_renderAbs _ (proper_slashFree hproper)]
    exact hproper
  · rw [hN] at hp
    exact absurd hp (head_strip p hx)


/-! ## (e) Basename patterns -/

theorem isLineTerminator_iff (c : Char) : isLineTerminator c = true ↔ c ∈ lineTerminators := by
  simp [isLineTerminator, lineTerminators, or_assoc]

/-- The transcription of `/^\.env(\..+)?$/` accepts exactly `EnvName`. -/
theorem matchesEnv_iff (b : List Char) : matchesEnv b = true ↔ EnvName b := by
  have e1 : ".env".toList = ['.', 'e', 'n', 'v'] := rfl
  have e2 : ".env.".toList = ['.', 'e', 'n', 'v', '.'] := rfl
  unfold matchesEnv EnvName
  rw [e1, e2]
  split
  · rename_i rest
    split
    · simp
    · rename_i tail
      constructor
      · intro h
        right
        simp only [Bool.and_eq_true, Bool.not_eq_true', List.isEmpty_eq_false_iff, List.all_eq_true] at h
        refine ⟨tail, h.1, fun c hc hlt => ?_, by simp⟩
        have := h.2 c hc
        rw [(isLineTerminator_iff c).2 hlt] at this
        simp at this
      · rintro (h | ⟨r, hr, hlt, h⟩)
        · simp at h
        · simp at h
          subst h
          simp only [Bool.and_eq_true, Bool.not_eq_true', List.isEmpty_eq_false_iff, List.all_eq_true]
          refine ⟨hr, fun c hc => ?_⟩
          cases hl : isLineTerminator c
          · rfl
          · exact absurd ((isLineTerminator_iff c).1 hl) (hlt c hc)
    · rename_i h1 h2
      simp only [Bool.false_eq_true, false_iff, not_or, not_exists, not_and]
      constructor
      · intro h; simp at h; exact h1 h
      · intro r _ _ h
        simp at h
        exact h2 r h
  · rename_i h
    simp only [Bool.false_eq_true, false_iff, not_or, not_exists, not_and]
    constructor
    · intro hb; subst hb; exact h [] rfl
    · intro r _ _ hb; subst hb; exact h ('.' :: r) rfl

/-- The transcription of `/^credentials\.json$/` accepts exactly `CredentialsName`. -/
theorem matchesCredentials_iff (b : List Char) : matchesCredentials b = true ↔ CredentialsName b := by
  simp [matchesCredentials, CredentialsName]

/-- The alternation `(json|ya?ml|toml)` accepts exactly its four extensions. -/
theorem isSecretsExtension_iff (e : List Char) :
    isSecretsExtension e = true ↔ e ∈ ["json".toList, "yaml".toList, "yml".toList, "toml".toList] := by
  simp [isSecretsExtension, or_assoc]

/-- The transcription of `/^secrets?\.(json|ya?ml|toml)$/` accepts exactly `SecretsName`. -/
theorem matchesSecrets_iff (b : List Char) : matchesSecrets b = true ↔ SecretsName b := by
  have e1 : "secret".toList = ['s', 'e', 'c', 'r', 'e', 't'] := rfl
  have e2 : "secrets".toList = ['s', 'e', 'c', 'r', 'e', 't', 's'] := rfl
  unfold matchesSecrets SecretsName
  simp only [List.mem_cons, List.mem_nil_iff, or_false, exists_eq_or_imp, exists_eq_left, e1, e2]
  split
  · rename_i rest
    split
    · rename_i ext
      rw [isSecretsExtension_iff]
      simp
    · rename_i ext h
      rw [isSecretsExtension_iff]
      simp
    · rename_i h1 h2
      simp only [Bool.false_eq_true, false_iff]
      simp only [List.cons_append, List.nil_append, List.cons.injEq, true_and]
      rintro ((h | h | h | h) | h | h | h | h)
      all_goals first | exact h2 _ h | exact h1 _ h
  · rename_i h
    simp only [Bool.false_eq_true, false_iff]
    simp only [List.cons_append, List.nil_append]
    rintro ((hb | hb | hb | hb) | hb | hb | hb | hb) <;> exact h _ hb

/-- (e) The basename rule of lines 99-104 flags exactly the names `.env` or `.env.` followed by
characters other than line terminators, `credentials.json`, and `secret` or `secrets` with the
extension `.json`, `.yaml`, `.yml` or `.toml`. -/
theorem basename_rule_described : BasenameRuleDescribed := by
  intro b
  simp only [basenamePatterns, List.any_cons, List.any_nil, Bool.or_false, Bool.or_eq_true,
    matchesEnv_iff, matchesCredentials_iff, matchesSecrets_iff]

/-! ## Lexical resolution: `Walk` and `resolveSegs` -/

theorem resolveStep_skip (stack : List Seg) (c : Seg) (h : c = [] ∨ c = ['.']) :
    resolveStep stack c = stack := by
  unfold resolveStep; rw [ite_eq_left h]

/-- `..` drops the last kept segment, if any. -/
theorem resolveStep_up (stack : List Seg) : resolveStep stack ['.', '.'] = stack.tail := by
  simp [resolveStep]

/-- Any other segment is kept. -/
theorem resolveStep_down (stack : List Seg) (c : Seg) (h1 : ¬ (c = [] ∨ c = ['.'])) (h2 : c ≠ ['.', '.']) :
    resolveStep stack c = c :: stack := by
  unfold resolveStep; rw [ite_eq_right h1, ite_eq_right h2]

/-- A `Walk` ends where the fold of `resolveStep` ends. -/
theorem walk_foldl {here segs there : List Seg} (h : Walk here segs there) :
    (segs.foldl resolveStep here.reverse).reverse = there := by
  induction h with
  | done here => simp
  | stay here c rest there hc _ ih =>
    rw [List.foldl_cons, resolveStep_skip _ _ hc]; exact ih
  | up here rest there _ ih =>
    rw [List.foldl_cons, resolveStep_up, List.tail_reverse]; exact ih
  | down here c rest there h1 h2 h3 _ ih =>
    rw [List.foldl_cons, resolveStep_down _ _ (by rintro (e | e) <;> contradiction) h3]
    simpa using ih

/-- The fold of `resolveStep` is a `Walk`. -/
theorem walk_of_foldl (here segs : List Seg) :
    Walk here segs ((segs.foldl resolveStep here.reverse).reverse) := by
  induction segs generalizing here with
  | nil => simpa using Walk.done here
  | cons c rest ih =>
    rw [List.foldl_cons]
    by_cases h1 : c = [] ∨ c = ['.']
    · rw [resolveStep_skip _ _ h1]; exact Walk.stay here c rest _ h1 (ih here)
    · by_cases h2 : c = ['.', '.']
      · subst h2
        rw [resolveStep_up, List.tail_reverse]
        exact Walk.up here rest _ (ih here.dropLast)
      · rw [resolveStep_down _ _ h1 h2]
        have := ih (here ++ [c])
        simp only [List.reverse_append, List.reverse_cons, List.reverse_nil, List.nil_append,
          List.singleton_append] at this
        exact Walk.down here c rest _ (fun e => h1 (Or.inl e)) (fun e => h1 (Or.inr e)) h2 this

/-- `resolveSegs` computes the location `Walk` defines, from the root. -/
theorem walk_iff_resolveSegs (segs there : List Seg) : Walk [] segs there ↔ resolveSegs segs = there := by
  constructor
  · intro h; simpa [resolveSegs] using walk_foldl h
  · rintro rfl; simpa [resolveSegs] using walk_of_foldl [] segs

/-- Every absolute path names exactly one location. -/
theorem names_resolveSegs (p : List Char) (hp : p.head? = some '/') :
    Names p (resolveSegs (splitSlash p)) :=
  ⟨hp, (walk_iff_resolveSegs _ _).2 rfl⟩

/-- An absolute path names one location only. -/
theorem names_unique {p : List Char} {l₁ l₂ : List Seg} (h₁ : Names p l₁) (h₂ : Names p l₂) : l₁ = l₂ := by
  rw [← (walk_iff_resolveSegs _ _).1 h₁.2, ← (walk_iff_resolveSegs _ _).1 h₂.2]

/-- An absolute path normalizes to the location it names, `/private/tmp` written `/tmp`. -/
theorem normalizePath_of_names (home p : List Char) (loc : List Seg) (h : Names p loc) :
    normalizePath home p = renderAbs (tmpMapSegs loc) := by
  rw [normalizePath_abs home p h.1, (walk_iff_resolveSegs _ _).1 h.2]

/-- Walks compose: walking `a` and then `b` is walking `a ++ b`. -/
theorem walk_append {here mid there : List Seg} {a b : List Seg} (ha : Walk here a mid) (hb : Walk mid b there) :
    Walk here (a ++ b) there := by
  induction ha with
  | done _ => exact hb
  | stay here c rest _ hc _ ih => exact Walk.stay here c _ there hc (ih hb)
  | up here rest _ _ ih => exact Walk.up here _ there (ih hb)
  | down here c rest _ h1 h2 h3 _ ih => exact Walk.down here c _ there h1 h2 h3 (ih hb)

/-- `/etc/shadow` is the rendering of its segments. -/
theorem renderAbs_etc_shadow : "/etc/shadow".toList = renderAbs ["etc".toList, "shadow".toList] := by decide

/-- The directory names a sensitive HOME directory adds to HOME. -/
def homeDirSuffixes : List (List Seg) :=
  [[".ssh".toList], [".gnupg".toList], [".config".toList, "gh".toList], [".aws".toList],
   [".docker".toList], ["Library".toList, "Keychains".toList]]

/-- The sensitive directories are HOME followed by a `homeDirSuffixes` entry, or `/etc/shadow`. -/
theorem mem_sensitiveDirSegs_iff (hs d : List Seg) :
    d ∈ sensitiveDirSegs hs ↔ (∃ e ∈ homeDirSuffixes, d = hs ++ e) ∨ d = ["etc".toList, "shadow".toList] := by
  simp only [sensitiveDirSegs, homeDirSuffixes, List.mem_cons, List.mem_nil_iff, or_false,
    exists_eq_or_imp, exists_eq_left]
  constructor
  · rintro (h | h | h | h | h | h | h)
    all_goals first | exact Or.inr h | skip
    all_goals (left; subst h; simp)
  · rintro ((h | h | h | h | h | h) | h)
    all_goals simp [h]

/-- Every `homeDirSuffixes` entry is non-empty and does not start with `tmp`. -/
theorem homeDirSuffixes_wf : ∀ e ∈ homeDirSuffixes, e ≠ [] ∧ e.head? ≠ some tmpSeg := by
  decide

/-- `tmpMapSegs` looks only at the first two segments. -/
theorem tmpMapSegs_append_left (a b : List Seg) (ha : a ≠ []) (hb : ¬ (a.length = 1 ∧ a.head? = some privateSeg ∧ b.head? = some tmpSeg)) :
    tmpMapSegs (a ++ b) = tmpMapSegs a ++ b := by
  match a, ha, hb with
  | [a1], _, hb =>
    cases b with
    | nil => simp
    | cons b1 bs =>
      have hne : ¬ (a1 = privateSeg ∧ b1 = tmpSeg) := fun h => hb ⟨rfl, by simp [h.1], by simp [h.2]⟩
      simp only [List.cons_append, List.nil_append, tmpMapSegs, ite_eq_right hne]
  | a1 :: a2 :: ar, _, _ =>
    simp only [List.cons_append, tmpMapSegs]
    split <;> simp

/-! ## (f) Service configs -/

/-- The basename of a rendered path is its last segment. -/
theorem basename_renderAbs_append (r : List Seg) (f : Seg) (hr : ∀ w ∈ r, '/' ∉ w) (hne : f ≠ [])
    (hf : '/' ∉ f) : basename (renderAbs (r ++ [f])) = f := by
  have hlast : (renderAbs (r ++ [f])).getLast? ≠ some '/' := by
    rw [renderAbs_append, show renderAbs [f] = ['/'] ++ f by simp [renderAbs], ← List.append_assoc]
    exact getLast?_append_ne_slash _ f hne hf
  have hsf : ∀ w ∈ r ++ [f], '/' ∉ w := by
    intro w hw
    rcases List.mem_append.1 hw with h | h
    · exact hr w h
    · simp at h; subst h; exact hf
  unfold basename
  rw [stripTrailingSlashes_of_getLast _ hlast, splitSlash_renderAbs _ hsf, List.getLast?_cons,
    List.getLast?_concat]
  rfl

/-- One service-config entry matches exactly the absolute paths `dir/f` and `dir/m/f` for a file
name `f` it lists. -/
theorem serviceConfigHit_iff (n : List Char) (d : List Seg) (files : List Seg) (hd : Canonical d) :
    serviceConfigHit n (renderAbs d) files = true ↔
      n.head? = some '/' ∧ ∃ f ∈ files, segmentsOf n = d ++ [f] ∨ ∃ m, segmentsOf n = d ++ [m, f] := by
  have hdsf : ∀ w ∈ d, '/' ∉ w := proper_slashFree hd.2
  have hhead_d : (renderAbs d).head? = some '/' := head_renderAbs d hd.1
  unfold serviceConfigHit
  by_cases hpre : (renderAbs d ++ ['/']).isPrefixOf n = true
  · obtain ⟨y, hy⟩ := List.isPrefixOf_iff_prefix.1 hpre
    subst hy
    have hdrop : ((renderAbs d ++ ['/']) ++ y).drop ((renderAbs d).length + 1) = y :=
      List.drop_left' (by simp)
    have hsplit : splitSlash ((renderAbs d ++ ['/']) ++ y) = [] :: (d ++ splitSlash y) := by
      rw [List.append_assoc, List.singleton_append, splitSlash_append_slash, splitSlash_renderAbs d hdsf]
      simp
    have hsegs : segmentsOf ((renderAbs d ++ ['/']) ++ y) = d ++ splitSlash y := by
      unfold segmentsOf; rw [hsplit]; rfl
    have hhead : ((renderAbs d ++ ['/']) ++ y).head? = some '/' := by
      cases hx : renderAbs d with
      | nil => rw [hx] at hhead_d; simp at hhead_d
      | cons c cs => rw [hx] at hhead_d; simpa using hhead_d
    rw [hpre, hdrop, hsegs, hhead]
    have hne := splitSlash_ne_nil y
    generalize splitSlash y = parts at hne ⊢
    match parts, hne with
    | [f], _ => simp
    | [m, f], _ => simp
    | _ :: _ :: _ :: _, _ => simp
  · have hfalse : ¬ (n.head? = some '/' ∧ ∃ f ∈ files, segmentsOf n = d ++ [f] ∨ ∃ m, segmentsOf n = d ++ [m, f]) := by
      rintro ⟨hhead, f, _, hs⟩
      apply hpre
      rw [List.isPrefixOf_iff_prefix, eq_renderAbs_segmentsOf n hhead]
      rcases hs with hs | ⟨m, hs⟩ <;> rw [hs, renderAbs_append] <;> simp [renderAbs]
    simp only [Bool.not_eq_true] at hpre
    simp only [hpre, Bool.not_false, ite_true, Bool.false_eq_true, false_iff]
    exact hfalse

/-- `SENSITIVE_SERVICE_CONFIGS` renders `serviceDirSegs`, each with `serviceTableFileNames`. -/
theorem serviceConfigs_eq : serviceConfigs = serviceDirSegs.map (fun d => (renderAbs d, serviceTableFileNames)) := by
  decide

/-- (f) The service-config rule matches exactly `config.json` directly in `/opt/soma-work` or
`/opt/soma`, or in exactly one directory below one of them. -/
theorem service_rule_described : ServiceRuleDescribed := by
  intro n
  have hdirs : ∀ d ∈ serviceDirSegs, Canonical d := by decide
  rw [serviceConfigRule, serviceConfigs_eq, List.any_map, List.any_eq_true]
  simp only [Function.comp_def]
  constructor
  · rintro ⟨d, hd, hhit⟩
    obtain ⟨hhead, f, hf, hs⟩ := (serviceConfigHit_iff n d _ (hdirs d hd)).1 hhit
    exact ⟨hhead, d, hd, f, hf, hs⟩
  · rintro ⟨hhead, d, hd, f, hf, hs⟩
    exact ⟨d, hd, (serviceConfigHit_iff n d _ (hdirs d hd)).2 ⟨hhead, f, hf, hs⟩⟩

/-- The basename of an absolute path whose last segment is `.env` is `.env`. -/
theorem basename_of_segments_env (n : List Char) (dir : List Seg) (hhead : n.head? = some '/')
    (hs : segmentsOf n = dir ++ [".env".toList] ∨ ∃ m, segmentsOf n = dir ++ [m, ".env".toList]) :
    basename n = ".env".toList := by
  have hsf : ∀ w ∈ segmentsOf n, '/' ∉ w := fun w hw =>
    slashFree_of_mem_splitSlash n w (List.mem_of_mem_tail hw)
  rw [eq_renderAbs_segmentsOf n hhead]
  rcases hs with hs | ⟨m, hs⟩
  · rw [hs] at hsf ⊢
    exact basename_renderAbs_append dir _ (fun w hw => hsf w (List.mem_append_left _ hw)) (by decide)
      (by decide)
  · rw [hs] at hsf ⊢
    rw [show dir ++ [m, ".env".toList] = (dir ++ [m]) ++ [".env".toList] by simp]
    refine basename_renderAbs_append _ _ (fun w hw => hsf w ?_) (by decide) (by decide)
    rcases List.mem_append.1 hw with h | h
    · exact List.mem_append_left _ h
    · simp at h; subst h; simp

end SomaVerify.SensitivePath.Proofs
