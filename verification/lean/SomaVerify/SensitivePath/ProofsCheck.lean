import SomaVerify.SensitivePath.Model
import SomaVerify.SensitivePath.Spec
import SomaVerify.SensitivePath.Proofs
import SomaVerify.SensitivePath.ProofsFold

/-!
# Proofs of the sensitive-path invariants: the checks

`Proofs.lean` relates strings to segment lists and `ProofsFold.lean` shows what case folding
keeps. This file proves the invariants of `Spec.lean` about `checkSensitivePath` and
`checkSensitiveGlob`: (b) to (b'''), the HOME aliases, (c), (d) to (d''), the glob's listed
directory, and the observed service rule (f).

Three facts carry most of it. `verdict` reports sensitive exactly when one of its four rules
matches (`verdict_isSensitive`). A point is at or below a sensitive directory exactly when its
`canon` segments begin with that directory's (`dir_rule_segment_aligned`): the directory test
compares keys, and the key of an absolute string is the rendering of its segments' `canon`. And
for an absolute path the normal form and the walk points are the renderings of the locations
its walk passes through (`point_visits`, `visits_point`), so a directory hit among them is a
visit to a sensitive directory.

Where a statement needs HOME absolute it takes `home.head? = some '/'`, or `Names home hloc`
where it also needs HOME's location; the module's HOME is always absolute
(`moduleHome_absolute`), and the `_at_load` forms state the invariants for it.
-/

namespace SomaVerify.SensitivePath.Proofs

open SomaVerify.SensitivePath SomaVerify.SensitivePath.Spec

/-! ## Segments and keys -/

/-- The segments of a string contain no `/`. -/
theorem segmentsOf_slashFree (n : List Char) : ∀ w ∈ segmentsOf n, '/' ∉ w := fun w hw =>
  slashFree_of_mem_splitSlash n w (List.mem_of_mem_tail hw)

/-- The location an absolute path names is made of proper segments. -/
theorem names_proper {p : List Char} {loc : List Seg} (h : Names p loc) : ∀ w ∈ loc, Proper w := by
  rw [← (walk_iff_resolveSegs _ _).1 h.2]
  exact proper_of_mem_resolveSegs _ (slashFree_of_mem_splitSlash _)

/-- The key of an absolute path is the rendering of its segments' `canon`. -/
theorem foldKey_abs (n : List Char) (hhead : n.head? = some '/') :
    foldKey n = renderAbs (canon (segmentsOf n)) := by
  have h := foldKey_renderAbs _ (segmentsOf_slashFree n)
  rwa [← eq_renderAbs_segmentsOf n hhead] at h

/-- Extending a location keeps its `canon` as a prefix, unless the location is a lone segment
that folds to `private` (which `/private/tmp` would rewrite). -/
theorem canon_append (D U : List Seg) (hD : D ≠ []) (hp : D.map fold ≠ [privateSeg]) :
    canon (D ++ U) = canon D ++ U.map fold := by
  unfold canon
  rw [List.map_append]
  apply tmpMapSegs_append_left
  · simpa using hD
  · rintro ⟨hlen, hhead, -⟩
    apply hp
    generalize D.map fold = a at hlen hhead
    match a with
    | [] => simp at hlen
    | [x] => simp at hhead; rw [hhead]
    | _ :: _ :: _ => simp at hlen

/-- Only a lone segment folding to `private` has `canon` equal to `[private]`. -/
theorem map_fold_of_canon_private (d : List Seg) (h : canon d = [privateSeg]) : d.map fold = [privateSeg] := by
  unfold canon at h
  generalize d.map fold = a at h ⊢
  match a with
  | [] => exact absurd h (by decide)
  | [x] => exact h
  | x :: y :: r =>
    by_cases hc : x = privateSeg ∧ y = tmpSeg
    · rw [show tmpMapSegs (x :: y :: r) = tmpSeg :: r from ite_eq_left hc] at h
      simp only [List.cons.injEq] at h
      exact absurd h.1 (by decide)
    · rw [show tmpMapSegs (x :: y :: r) = x :: y :: r from ite_eq_right hc] at h
      simp at h

/-! ## The rule tables -/

/-- The sensitive HOME directories add a non-empty run of proper segments to HOME, and none of
them is a lone segment that folds to `private`. -/
theorem homeDirSuffixes_props :
    ∀ e ∈ homeDirSuffixes, e ≠ [] ∧ (∀ w ∈ e, Proper w) ∧ e.map fold ≠ [privateSeg] := by
  decide

/-- For a HOME of proper segments, every sensitive directory is a non-empty list of proper
segments other than a lone segment folding to `private`. -/
theorem sensitiveDirSegs_wf (hloc : List Seg) (hh : ∀ w ∈ hloc, Proper w) :
    ∀ d ∈ sensitiveDirSegs hloc, d ≠ [] ∧ (∀ w ∈ d, Proper w) ∧ d.map fold ≠ [privateSeg] := by
  intro d hd
  rcases (mem_sensitiveDirSegs_iff hloc d).1 hd with ⟨e, he, rfl⟩ | rfl
  · obtain ⟨hne, hproper, hpriv⟩ := homeDirSuffixes_props e he
    refine ⟨by simp [hne], ?_, ?_⟩
    · intro w hw
      rcases List.mem_append.1 hw with hw | hw
      · exact hh w hw
      · exact hproper w hw
    · rw [List.map_append]
      cases hloc with
      | nil => simpa using hpriv
      | cons x xs =>
        cases e with
        | nil => exact absurd rfl hne
        | cons y ys => simp
  · decide

/-- For a HOME that names `hloc`, `SENSITIVE_DIRECTORIES` renders `sensitiveDirSegs hloc`. -/
theorem sensitiveDirectories_eq (home : List Char) (hloc : List Seg) (hn : Names home hloc) :
    sensitiveDirectories home = (sensitiveDirSegs hloc).map renderAbs := by
  have hR : resolveSegs (splitSlash home) = hloc := (walk_iff_resolveSegs _ _).1 hn.2
  have h1 : sensitiveDirectories home =
      homeDirSuffixes.map (fun e => pathJoin (home :: e)) ++ ["/etc/shadow".toList] := rfl
  have h2 : sensitiveDirSegs hloc =
      homeDirSuffixes.map (fun e => hloc ++ e) ++ [["etc".toList, "shadow".toList]] := rfl
  rw [h1, h2, List.map_append, List.map_map]
  congr 1
  · apply List.map_congr_left
    intro e he
    obtain ⟨hne, hproper, -⟩ := homeDirSuffixes_props e he
    rw [Function.comp_apply, pathJoin_abs home e hn.1 hne hproper, hR]

/-- A location below a sensitive directory of HOME, written with `/private/tmp` as `/tmp` in
HOME, is below the matching directory of that HOME. -/
theorem insideSensitive_tmpMapSegs (hloc v : List Seg) (h : InsideSensitive hloc v) :
    InsideSensitive (tmpMapSegs hloc) v := by
  obtain ⟨d, hd, hpre⟩ := h
  rcases (mem_sensitiveDirSegs_iff hloc d).1 hd with ⟨e, he, rfl⟩ | rfl
  · refine ⟨tmpMapSegs hloc ++ e, (mem_sensitiveDirSegs_iff _ _).2 (Or.inl ⟨e, he, rfl⟩), ?_⟩
    obtain ⟨hene, hehead⟩ := homeDirSuffixes_wf e he
    cases hloc with
    | nil => exact hpre
    | cons x xs =>
      rw [← tmpMapSegs_append_left (x :: xs) e (by simp) (by
        rintro ⟨-, -, h⟩
        cases e with
        | nil => exact hene rfl
        | cons e1 es => exact hehead (by simpa using h)), canon_tmpMapSegs]
      exact hpre
  · exact ⟨_, (mem_sensitiveDirSegs_iff _ _).2 (Or.inr rfl), hpre⟩

/-- Being at or below a sensitive directory survives extending the location. -/
theorem insideSensitive_of_prefix (hloc : List Seg) (hh : ∀ w ∈ hloc, Proper w) (v T : List Seg)
    (h : InsideSensitive hloc v) (hp : v <+: T) : InsideSensitive hloc T := by
  obtain ⟨d, hd, hpre⟩ := h
  obtain ⟨U, rfl⟩ := hp
  obtain ⟨hdne, -, hdpriv⟩ := sensitiveDirSegs_wf hloc hh d hd
  have hcne : canon d ≠ [] := tmpMapSegs_ne_nil _ (by simpa using hdne)
  refine ⟨d, hd, ?_⟩
  have hvne : v ≠ [] := by
    rintro rfl
    exact hcne (List.prefix_nil.1 (by simpa [canon, tmpMapSegs] using hpre))
  by_cases hpv : v.map fold = [privateSeg]
  · exfalso
    have hcv : canon v = [privateSeg] := by unfold canon; rw [hpv]; rfl
    rw [hcv] at hpre
    obtain ⟨t, ht⟩ := hpre
    apply hdpriv
    apply map_fold_of_canon_private
    generalize canon d = c at ht hcne
    match c, ht with
    | [], _ => exact absurd rfl hcne
    | y :: ys, ht =>
      simp only [List.cons_append, List.cons.injEq, List.append_eq_nil_iff] at ht
      rw [ht.1, ht.2.1]
  · rw [canon_append v U hvne hpv]
    exact hpre.trans (List.prefix_append _ _)

/-! ## `verdict` -/

/-- `verdict` reports sensitive exactly when one of its rules matches: the directory rule on the
normalized path or a walk point, or the exact-file, basename or service-config rule. -/
theorem verdict_isSensitive (home n : List Char) (walk : List (List Char)) :
    (verdict home n walk).isSensitive =
      (((n :: walk).findSome? (directoryHit home)).isSome ||
        ((sensitiveExactFiles home).map foldKey).contains (foldKey n) ||
        basenamePatterns.any (fun test => test (fold (basename n))) ||
        serviceConfigRule (foldKey n)) := by
  unfold verdict
  cases (n :: walk).findSome? (directoryHit home) with
  | some dir => rfl
  | none =>
    cases ((sensitiveExactFiles home).map foldKey).contains (foldKey n) <;>
    cases basenamePatterns.any (fun test => test (fold (basename n))) <;>
    cases serviceConfigRule (foldKey n) <;> rfl

/-- With no directory hit on either list of points, the verdict does not depend on the walk. -/
theorem verdict_eq_of_findSome_none (home n : List Char) (walk walk' : List (List Char))
    (h : (n :: walk).findSome? (directoryHit home) = none)
    (h' : (n :: walk').findSome? (directoryHit home) = none) :
    verdict home n walk = verdict home n walk' := by
  unfold verdict
  rw [h, h']

/-- A directory hit on one of the points makes the verdict sensitive. -/
theorem verdict_isSensitive_of_hit (home n x : List Char) (walk : List (List Char))
    (hx : x ∈ n :: walk) (hit : (directoryHit home x).isSome = true) :
    (verdict home n walk).isSensitive = true := by
  rw [verdict_isSensitive, List.findSome?_isSome_iff.2 ⟨x, hx, hit⟩]
  rfl

/-! ## (c) The directory rule -/

/-- (c) The directory test is segment-aligned: for a HOME naming `hloc`, a point is at or below a
sensitive directory exactly when it is absolute and that directory's `canon` segments begin its
`canon` segments. -/
theorem dir_rule_segment_aligned (home : List Char) (hloc : List Seg) (hn : Names home hloc) :
    DirectoryRuleSegmentAligned home hloc := by
  intro n
  have hwf := sensitiveDirSegs_wf hloc (names_proper hn)
  have key : ∀ d ∈ sensitiveDirSegs hloc, underDirectory (foldKey n) (foldKey (renderAbs d)) = true ↔
      n.head? = some '/' ∧ canon d <+: canon (segmentsOf n) := by
    intro d hd
    obtain ⟨hne, hproper, -⟩ := hwf d hd
    have hdsf := proper_slashFree hproper
    have hcne : canon d ≠ [] := tmpMapSegs_ne_nil _ (by simpa using hne)
    rw [foldKey_renderAbs d hdsf, underDirectory_renderAbs_iff_prefix _ _ (canon_slashFree d hdsf) hcne]
    by_cases hhead : n.head? = some '/'
    · rw [foldKey_abs n hhead, segmentsOf_renderAbs _ (canon_slashFree _ (segmentsOf_slashFree n))]
      constructor
      · rintro ⟨-, h⟩; exact ⟨hhead, h⟩
      · rintro ⟨-, h⟩
        refine ⟨head_renderAbs _ ?_, h⟩
        intro e; rw [e] at h; exact hcne (List.prefix_nil.1 h)
    · constructor
      · rintro ⟨h, -⟩; exact absurd h (foldKey_rel n hhead)
      · rintro ⟨h, -⟩; exact absurd h hhead
  unfold directoryHit
  rw [sensitiveDirectories_eq home hloc hn, List.find?_isSome]
  constructor
  · rintro ⟨x, hx, hu⟩
    obtain ⟨d, hd, rfl⟩ := List.mem_map.1 hx
    obtain ⟨hh, hp⟩ := (key d hd).1 hu
    exact ⟨hh, d, hd, hp⟩
  · rintro ⟨hh, d, hd, hp⟩
    exact ⟨renderAbs d, List.mem_map.2 ⟨d, hd, rfl⟩, (key d hd).2 ⟨hh, hp⟩⟩

/-- A string that is not absolute is never at or below a sensitive directory. -/
theorem directoryHit_rel (home : List Char) (hh : home.head? = some '/') (x : List Char)
    (hx : x.head? ≠ some '/') : directoryHit home x = none := by
  cases h : directoryHit home x with
  | none => rfl
  | some d =>
    have := (dir_rule_segment_aligned home _ (names_resolveSegs home hh) x).1 (by simp [h])
    exact absurd this.1 hx

/-- The rendering of a location, `/private/tmp` written `/tmp`, is at or below a sensitive
directory exactly when the location is inside one. -/
theorem directoryHit_tmpMap_iff (home : List Char) (hloc : List Seg) (hn : Names home hloc)
    (v : List Seg) (hv : ∀ w ∈ v, '/' ∉ w) :
    (directoryHit home (renderAbs (tmpMapSegs v))).isSome = true ↔ InsideSensitive hloc v := by
  have hsf := tmpMapSegs_slashFree v hv
  rw [dir_rule_segment_aligned home hloc hn, segmentsOf_renderAbs _ hsf, canon_tmpMapSegs]
  constructor
  · rintro ⟨-, d, hd, hp⟩; exact ⟨d, hd, hp⟩
  · rintro ⟨d, hd, hp⟩
    refine ⟨head_renderAbs _ (tmpMapSegs_ne_nil _ ?_), d, hd, hp⟩
    rintro rfl
    obtain ⟨hne, -, -⟩ := sensitiveDirSegs_wf hloc (names_proper hn) d hd
    have hcne : canon d ≠ [] := tmpMapSegs_ne_nil _ (by simpa using hne)
    exact hcne (List.prefix_nil.1 (by simpa [canon, tmpMapSegs] using hp))

/-- (d) For a HOME naming `hloc`, every path whose normal form is at or below a sensitive
directory is reported sensitive. -/
theorem flagged_when_normalized_under (home : List Char) (hloc : List Seg) (hn : Names home hloc) :
    FlaggedWhenNormalizedUnder home hloc := by
  intro p d hhead hd hpre
  rw [checkSensitivePath_eq_verdict]
  exact verdict_isSensitive_of_hit home _ _ _ (List.mem_cons_self ..)
    ((dir_rule_segment_aligned home hloc hn _).2 ⟨hhead, d, hd, hpre⟩)

/-! ## Walk points and the locations a walk visits -/

/-- `resolvePath` of a rendered list of slash-free segments: their resolution, `/private/tmp`
written `/tmp`. -/
theorem resolvePath_renderAbs (P : List Seg) (hP : ∀ w ∈ P, '/' ∉ w) :
    resolvePath (renderAbs P) = renderAbs (tmpMapSegs (resolveSegs P)) := by
  cases P with
  | nil => rfl
  | cons s ss =>
    rw [resolvePath_abs _ (head_renderAbs _ (by simp)), splitSlash_renderAbs _ hP, resolveSegs_nil_cons]

/-- An absolute path splits into an empty segment followed by its segments. -/
theorem splitSlash_abs (p : List Char) (hp : p.head? = some '/') : splitSlash p = [] :: segmentsOf p :=
  (splitSlash_eq_nil_cons_iff p).2 (Or.inr hp)

/-- The walk points of an absolute path: the location reached after each number of its segments,
`/private/tmp` written `/tmp`. -/
theorem walkPoints_abs (home p : List Char) (hp : p.head? = some '/') :
    walkPoints home p = (List.range ((segmentsOf p).length + 1)).map
      (fun j => renderAbs (tmpMapSegs (resolveSegs ((segmentsOf p).take j)))) := by
  unfold walkPoints
  dsimp only
  rw [expandHome_of_not_matchesAlias home p (not_matchesAlias_of_head p hp), splitSlash_abs p hp,
    List.length_cons]
  apply List.map_congr_left
  intro j _
  rw [List.take_succ_cons, ← renderAbs_eq_joinSlash,
    resolvePath_renderAbs _ (fun w hw => segmentsOf_slashFree p w (List.mem_of_mem_take hw))]

/-- `Visits`, computed: where `resolveSegs` is after some number of the split pieces. -/
theorem visits_iff (p : List Char) (v : List Seg) :
    Visits p v ↔ p.head? = some '/' ∧ ∃ i, resolveSegs ((splitSlash p).take i) = v := by
  unfold Visits
  simp only [walk_iff_resolveSegs]

/-- A location a walk visits is made of segments without `/`. -/
theorem visits_slashFree {p : List Char} {v : List Seg} (hv : Visits p v) : ∀ w ∈ v, '/' ∉ w := by
  obtain ⟨-, i, hw⟩ := (visits_iff p v).1 hv
  rw [← hw]
  exact proper_slashFree (proper_of_mem_resolveSegs _
    (fun w hw' => slashFree_of_mem_splitSlash p w (List.mem_of_mem_take hw')))

/-- Every location the walk of a path visits is, rendered, one of its walk points. -/
theorem visits_point (home p : List Char) (v : List Seg) (hv : Visits p v) :
    renderAbs (tmpMapSegs v) ∈ walkPoints home p := by
  obtain ⟨hp, i, hw⟩ := (visits_iff p v).1 hv
  rw [walkPoints_abs home p hp, List.mem_map]
  rw [splitSlash_abs p hp] at hw
  cases i with
  | zero =>
    refine ⟨0, List.mem_range.2 (Nat.succ_pos _), ?_⟩
    rw [← hw]; rfl
  | succ k =>
    rw [List.take_succ_cons, resolveSegs_nil_cons] at hw
    by_cases hk : k ≤ (segmentsOf p).length
    · exact ⟨k, List.mem_range.2 (Nat.lt_succ_of_le hk), by rw [hw]⟩
    · refine ⟨(segmentsOf p).length, List.mem_range.2 (Nat.lt_succ_self _), ?_⟩
      rw [← hw, List.take_length, List.take_of_length_le (by omega)]

/-- Every point the check looks at for an absolute path, its normal form and its walk points, is
the rendering of a location its walk visits. -/
theorem point_visits (home p x : List Char) (hp : p.head? = some '/')
    (hx : x ∈ normalizePath home p :: walkPoints home p) :
    ∃ v, Visits p v ∧ x = renderAbs (tmpMapSegs v) := by
  rcases List.mem_cons.1 hx with rfl | hx
  · exact ⟨resolveSegs (splitSlash p), (visits_iff p _).2 ⟨hp, (splitSlash p).length, by rw [List.take_length]⟩,
      normalizePath_abs home p hp⟩
  · rw [walkPoints_abs home p hp, List.mem_map] at hx
    obtain ⟨j, -, rfl⟩ := hx
    refine ⟨resolveSegs ((segmentsOf p).take j), (visits_iff p _).2 ⟨hp, j + 1, ?_⟩, rfl⟩
    rw [splitSlash_abs p hp, List.take_succ_cons, resolveSegs_nil_cons]

/-- If the walk of an absolute path visits no location inside a sensitive directory, no point the
check looks at is a directory hit. -/
theorem findSome_none_of_not_visits (home : List Char) (hloc : List Seg) (hn : Names home hloc)
    (p : List Char) (hp : p.head? = some '/') (h : ∀ v, Visits p v → ¬ InsideSensitive hloc v) :
    (normalizePath home p :: walkPoints home p).findSome? (directoryHit home) = none := by
  rw [List.findSome?_eq_none_iff]
  intro x hx
  obtain ⟨v, hv, rfl⟩ := point_visits home p x hp hx
  cases hd : directoryHit home (renderAbs (tmpMapSegs v)) with
  | none => rfl
  | some d =>
    exact absurd ((directoryHit_tmpMap_iff home hloc hn v (visits_slashFree hv)).1 (by simp [hd])) (h v hv)

/-! ## (b'), (b'') and (d'): walks and locations -/

/-- (b'') Every absolute path whose walk passes through a sensitive directory is reported
sensitive, wherever the walk ends. -/
theorem walk_through_sensitive_flagged (home : List Char) : WalkThroughSensitiveFlagged home := by
  intro hloc hn p v hv hin
  rw [checkSensitivePath_eq_verdict]
  exact verdict_isSensitive_of_hit home _ _ _ (List.mem_cons_of_mem _ (visits_point home p v hv))
    ((directoryHit_tmpMap_iff home hloc hn v (visits_slashFree hv)).2 hin)

/-- (b') Two absolute spellings of one location whose walks pass through no sensitive directory
get the same result. -/
theorem same_location_same_result (home : List Char) : SameLocationSameResult home := by
  intro hloc hn p q loc hp hq hvp hvq
  have hnp := findSome_none_of_not_visits home hloc hn p hp.1 hvp
  have hnq := findSome_none_of_not_visits home hloc hn q hq.1 hvq
  rw [normalizePath_of_names home p loc hp] at hnp
  rw [normalizePath_of_names home q loc hq] at hnq
  rw [checkSensitivePath_eq_verdict, checkSensitivePath_eq_verdict, normalizePath_of_names home p loc hp,
    normalizePath_of_names home q loc hq]
  exact verdict_eq_of_findSome_none home _ _ _ hnp hnq

/-- (d') Every absolute spelling of a location at or below a sensitive directory is reported
sensitive. -/
theorem flagged_wherever_named (home : List Char) : FlaggedWhereverNamed home := by
  intro hloc hn p loc hp hin
  refine walk_through_sensitive_flagged home hloc hn p loc ((visits_iff p loc).2 ⟨hp.1, (splitSlash p).length, ?_⟩) hin
  rw [List.take_length]
  exact (walk_iff_resolveSegs _ _).1 hp.2

/-! ## (d') for the module as loaded -/

/-- `path.resolve(cwd, homedir)`, for an absolute working directory, resolves to the location
`HomeNames` gives. -/
theorem resolveSegs_pathResolve (cwd homedir : List Char) (hloc : List Seg) (hcwd : cwd.head? = some '/')
    (h : HomeNames cwd homedir hloc) :
    resolveSegs (splitSlash (joinSlash (fromLastAbsolute ([cwd, homedir].filter (fun a => !a.isEmpty))))) = hloc := by
  obtain ⟨c, hc, hw⟩ := h
  have hcR : resolveSegs (splitSlash cwd) = c := (walk_iff_resolveSegs _ _).1 hc.2
  have hcne : cwd.isEmpty = false := by cases cwd <;> simp_all
  cases homedir with
  | nil =>
    have hfold := walk_foldl hw
    simp only [List.head?_nil, reduceCtorEq, ite_false, splitSlash, List.foldl_cons, List.foldl_nil,
      resolveStep_skip _ _ (Or.inl rfl), List.reverse_reverse] at hfold
    subst hfold
    simpa [hcne, fromLastAbsolute, joinSlash] using hcR
  | cons h0 hs =>
    by_cases habs : h0 = '/'
    · subst habs
      simp only [List.head?_cons, ite_true] at hw
      have := (walk_iff_resolveSegs _ _).1 hw
      simpa [hcne, fromLastAbsolute, joinSlash] using this
    · have hne : (some h0 = some '/') = False := by simp [habs]
      simp only [List.head?_cons, hne, ite_false] at hw
      have hfold := walk_foldl hw
      have hfilter : [cwd, h0 :: hs].filter (fun a => !a.isEmpty) = [cwd, h0 :: hs] := by simp [hcne]
      have hfrom : fromLastAbsolute [cwd, h0 :: hs] = [cwd, h0 :: hs] := by simp [fromLastAbsolute, habs]
      rw [hfilter, hfrom, show joinSlash [cwd, h0 :: hs] = cwd ++ '/' :: (h0 :: hs) from rfl,
        splitSlash_append_slash]
      unfold resolveSegs at hcR ⊢
      rw [List.foldl_append]
      have hA : (splitSlash cwd).foldl resolveStep [] = c.reverse := by
        rw [← hcR, List.reverse_reverse]
      rw [hA]
      exact hfold

/-- The location of a directory as Node's `path.resolve` spells it. -/
theorem names_renderDir (L : List Seg) (hL : ∀ w ∈ L, Proper w) : Names (renderDir L) L := by
  cases L with
  | nil => exact ⟨rfl, (walk_iff_resolveSegs _ _).2 (by decide)⟩
  | cons s ss =>
    refine ⟨head_renderAbs _ (by simp), (walk_iff_resolveSegs _ _).2 ?_⟩
    show resolveSegs (splitSlash (renderAbs (s :: ss))) = s :: ss
    rw [splitSlash_renderAbs _ (proper_slashFree hL), resolveSegs_nil_cons, resolveSegs_of_proper _ hL]

/-- `normalizeTmpPath` on a directory as `path.resolve` spells it. -/
theorem normalizeTmpPath_renderDir (L : List Seg) (hL : ∀ w ∈ L, '/' ∉ w) :
    normalizeTmpPath (renderDir L) = renderDir (tmpMapSegs L) := by
  cases L with
  | nil => rfl
  | cons s ss =>
    rw [show renderDir (s :: ss) = renderAbs (s :: ss) from rfl, normalizeTmpPath_renderAbs _ hL]
    cases h : tmpMapSegs (s :: ss) with
    | nil => exact absurd h (tmpMapSegs_ne_nil _ (by simp))
    | cons t ts => rfl

/-- The module's `HOME` names the location of `os.homedir()`, `/private/tmp` written `/tmp`. -/
theorem moduleHome_names (cwd homedir : List Char) (hloc : List Seg) (hcwd : cwd.head? = some '/')
    (h : HomeNames cwd homedir hloc) : Names (moduleHome cwd homedir) (tmpMapSegs hloc) := by
  have hR := resolveSegs_pathResolve cwd homedir hloc hcwd h
  have hproper : ∀ w ∈ hloc, Proper w := by
    rw [← hR]; exact proper_of_mem_resolveSegs _ (slashFree_of_mem_splitSlash _)
  unfold moduleHome pathResolve
  rw [hR, normalizeTmpPath_renderDir _ (proper_slashFree hproper)]
  exact names_renderDir _ (tmpMapSegs_proper _ hproper)

/-- (d') For the module as loaded, whatever `os.homedir()` returns and wherever it points: every
absolute path whose walk passes through a sensitive directory of that home directory is reported
sensitive. -/
theorem flagged_wherever_named_at_load : FlaggedWhereverNamedAtLoad := by
  intro cwd homedir hloc hcwd hhome p v hv hin
  exact walk_through_sensitive_flagged _ _ (moduleHome_names cwd homedir hloc hcwd hhome) p v hv
    (insideSensitive_tmpMapSegs hloc v hin)

/-! ## (b) The normal form, and the HOME aliases -/

/-- For an absolute HOME, the normal form never matches a HOME alias. -/
theorem not_matchesAlias_normalizePath (home p : List Char) (hh : home.head? = some '/') :
    ¬ MatchesAlias (normalizePath home p) := by
  rcases normalizePath_cases home p hh with ⟨R, hN, -⟩ | ⟨hm, -, hN⟩
  · rw [hN]
    cases tmpMapSegs (resolveSegs R) with
    | nil => exact not_matchesAlias_nil
    | cons s ss => exact not_matchesAlias_of_head _ (by simp [renderAbs])
  · rw [hN]; exact not_matchesAlias_strip p hm

/-- The walk points of a path that is neither absolute nor an alias are not absolute. -/
theorem walkPoints_rel (home s : List Char) (hm : ¬ MatchesAlias s) (hs : s.head? ≠ some '/') :
    ∀ x ∈ walkPoints home s, x.head? ≠ some '/' := by
  intro x hx
  unfold walkPoints at hx
  dsimp only at hx
  rw [expandHome_of_not_matchesAlias home s hm, List.mem_map] at hx
  obtain ⟨i, -, rfl⟩ := hx
  have hj : (joinSlash ((splitSlash s).take (i + 1))).head? ≠ some '/' := by
    cases s with
    | nil => simp [splitSlash, joinSlash]
    | cons c cs =>
      have hc : c ≠ '/' := fun e => hs (by simp [e])
      obtain ⟨w, ws, hws⟩ : ∃ w ws, splitSlash cs = w :: ws := by
        cases h : splitSlash cs with
        | nil => exact absurd h (splitSlash_ne_nil cs)
        | cons w ws => exact ⟨w, ws, rfl⟩
      simp only [splitSlash, hc, ite_false, hws, consHead, List.take_succ_cons]
      rw [joinSlash_cons_cons]
      simpa using hc
  rw [resolvePath_rel _ hj]
  exact head_strip _ hj

/-- For an absolute HOME, a directory hit on a walk point of a normal form is a hit on the normal
form: the walk of a normal form visits only its prefixes. -/
theorem walkPoints_normalizePath_hit (home p x : List Char) (hh : home.head? = some '/')
    (hx : x ∈ walkPoints home (normalizePath home p)) (hit : (directoryHit home x).isSome = true) :
    (directoryHit home (normalizePath home p)).isSome = true := by
  have hn := names_resolveSegs home hh
  by_cases hN : (normalizePath home p).head? = some '/'
  · obtain ⟨v, hv, rfl⟩ := point_visits home _ x hN (List.mem_cons_of_mem _ hx)
    have hin := (directoryHit_tmpMap_iff home _ hn v (visits_slashFree hv)).1 hit
    have hproper := normalizePath_segments_proper home hh p hN
    have hpre : v <+: segmentsOf (normalizePath home p) := by
      obtain ⟨-, i, hw⟩ := (visits_iff _ v).1 hv
      rw [splitSlash_abs _ hN] at hw
      cases i with
      | zero => rw [← hw]; exact List.nil_prefix
      | succ k =>
        rw [List.take_succ_cons, resolveSegs_nil_cons,
          resolveSegs_of_proper _ (fun w hw' => hproper w (List.mem_of_mem_take hw'))] at hw
        rw [← hw]; exact List.take_prefix _ _
    obtain ⟨d, hd, hdp⟩ := insideSensitive_of_prefix _ (names_proper hn) v _ hin hpre
    exact (dir_rule_segment_aligned home _ hn _).2 ⟨hN, d, hd, hdp⟩
  · have hrel := walkPoints_rel home _ (not_matchesAlias_normalizePath home p hh) hN x hx
    rw [directoryHit_rel home hh x hrel] at hit
    simp at hit

/-- (b) For an absolute HOME, checking a path gives what checking its normal form gives, unless the
path is reported sensitive. -/
theorem check_refines_normal_form (home : List Char) (hh : home.head? = some '/') :
    CheckRefinesNormalForm home := by
  intro p
  by_cases hs : (checkSensitivePath home p).isSensitive = true
  · exact Or.inr hs
  · left
    have hnone : (normalizePath home p :: walkPoints home p).findSome? (directoryHit home) = none := by
      rw [checkSensitivePath_eq_verdict, verdict_isSensitive] at hs
      cases h : (normalizePath home p :: walkPoints home p).findSome? (directoryHit home) with
      | none => rfl
      | some d => rw [h] at hs; simp at hs
    rw [checkSensitivePath_eq_verdict, checkSensitivePath_eq_verdict (p := normalizePath home p),
      normalizePath_idempotent home hh p]
    apply verdict_eq_of_findSome_none _ _ _ _ hnone
    rw [List.findSome?_eq_none_iff] at hnone ⊢
    intro x hx
    rcases List.mem_cons.1 hx with rfl | hx
    · exact hnone _ (List.mem_cons_self ..)
    · cases hd : directoryHit home x with
      | none => rfl
      | some d =>
        have := walkPoints_normalizePath_hit home p x hh hx (by simp [hd])
        rw [hnone _ (List.mem_cons_self ..)] at this
        simp at this

/-- `checkSensitivePath` depends on a path only through its alias expansion. -/
theorem checkSensitivePath_of_expandHome (home p q : List Char)
    (h : expandHome home p homeAliases = expandHome home q homeAliases) :
    checkSensitivePath home p = checkSensitivePath home q := by
  unfold checkSensitivePath normalizePath walkPoints
  rw [h]

/-- For an absolute HOME, `~`, `$HOME` and `${HOME}`, alone or followed by `/`, are checked as HOME
spelled out. -/
theorem aliases_spell_home (home : List Char) (hh : home.head? = some '/') : AliasesSpellHome home := by
  intro a ha
  refine ⟨checkSensitivePath_of_expandHome _ _ _ ?_, fun rest => checkSensitivePath_of_expandHome _ _ _ ?_⟩
  · rw [expandHome_alias home a ha, expandHome_of_not_matchesAlias home home (not_matchesAlias_of_head home hh)]
  · rw [expandHome_alias_slash home rest a ha,
      expandHome_of_not_matchesAlias _ _ (not_matchesAlias_of_head _ (head_home_slash home rest hh))]

/-! ## (f) Service configs, observed through `checkSensitivePath` -/

/-- An absolute normal form is the rendering of proper segments. -/
theorem normalizePath_abs_form (home p : List Char) (h : (normalizePath home p).head? = some '/') :
    ∃ L : List Seg, (∀ w ∈ L, Proper w) ∧ normalizePath home p = renderAbs L := by
  unfold normalizePath at h ⊢
  by_cases hE : (expandHome home p homeAliases).head? = some '/'
  · exact ⟨_, tmpMapSegs_proper _ (proper_of_mem_resolveSegs _ (slashFree_of_mem_splitSlash _)),
      resolvePath_abs _ hE⟩
  · rw [resolvePath_rel _ hE] at h
    exact absurd h (head_strip _ hE)

/-- The basename of a rendered path of proper segments is its last segment. -/
theorem basename_renderAbs_proper (L : List Seg) (hL : ∀ w ∈ L, Proper w) :
    basename (renderAbs L) = L.getLast?.getD [] := by
  unfold basename
  rw [stripTrailingSlashes_renderAbs L hL, splitSlash_renderAbs L (proper_slashFree hL), List.getLast?_cons,
    Option.getD_some]

/-- (f) Every service config file, `.env` or `config.json` in any case, directly in a service
directory or one directory below it, is reported sensitive: `.env` by the basename rule,
`config.json` by the service-config rule. -/
theorem service_configs_flagged (home : List Char) : ServiceConfigsFlagged home := by
  intro p hhead hsvc
  obtain ⟨L, hL, hN⟩ := normalizePath_abs_form home p hhead
  have hLsf := proper_slashFree hL
  rw [hN, segmentsOf_renderAbs L hLsf] at hsvc
  obtain ⟨dir, hdir, f, hf, hs⟩ := hsvc
  have hcsf := canon_slashFree L hLsf
  have hcne : canon L ≠ [] := by rcases hs with hs | ⟨m, hs⟩ <;> rw [hs] <;> simp
  rw [checkSensitivePath_eq_verdict, verdict_isSensitive]
  simp only [serviceFileNames, List.mem_cons, List.mem_nil_iff, or_false] at hf
  rcases hf with rfl | rfl
  · have hlast : (canon L).getLast? = some ".env".toList := by
      rcases hs with hs | ⟨m, hs⟩ <;> rw [hs] <;> simp
    have hb : fold (basename (normalizePath home p)) = ".env".toList := by
      rw [hN, basename_renderAbs_proper L hL]
      unfold canon at hlast
      rw [getLast?_tmpMapSegs, List.getLast?_map] at hlast
      cases h : L.getLast? with
      | none => rw [h] at hlast; simp at hlast
      | some w => rw [h] at hlast; simpa using hlast
    have hrule : basenamePatterns.any (fun test => test (fold (basename (normalizePath home p)))) = true := by
      rw [hb]; decide
    simp [hrule]
  · have hrule : serviceConfigRule (foldKey (normalizePath home p)) = true := by
      rw [hN, foldKey_renderAbs L hLsf]
      refine (service_rule_described _).2
        ⟨head_renderAbs _ hcne, dir, hdir, "config.json".toList, by simp [serviceTableFileNames], ?_⟩
      rw [segmentsOf_renderAbs _ hcsf]
      exact hs
    simp [hrule]

/-! ## (d'') Globs -/

/-- `checkSensitiveGlob` reports a glob sensitive whenever one of the paths it checks is. -/
theorem checkSensitiveGlob_of_candidate (home cwd pattern : List Char) (basePath : Option (List Char))
    (t : List Char) (ht : t ∈ (globSpellings cwd pattern basePath).flatMap globCandidates)
    (hs : (checkSensitivePath home t).isSensitive = true) :
    (checkSensitiveGlob home cwd pattern basePath).isSensitive = true := by
  unfold checkSensitiveGlob
  have hsome : ((((globSpellings cwd pattern basePath).flatMap globCandidates).map
      (checkSensitivePath home)).find? (fun r => r.isSensitive)).isSome = true :=
    List.find?_isSome.2 ⟨_, List.mem_map.2 ⟨t, ht, rfl⟩, hs⟩
  obtain ⟨r, hr⟩ := Option.isSome_iff_exists.1 hsome
  rw [hr]
  simpa using List.find?_some hr

/-- (d'') A glob is reported sensitive whenever one of the paths it is checked through is. -/
theorem glob_checks_its_directories (home : List Char) : GlobChecksItsDirectories home := by
  intro cwd pattern basePath s hs t ht h
  exact checkSensitiveGlob_of_candidate home cwd pattern basePath t (List.mem_flatMap.2 ⟨s, hs, ht⟩) h

/-- (d'') `globListed` is the directory a glob lists: the concrete text up to its last `/`. -/
theorem globListed_spec (spelling : List Char) : ListedDirectory spelling (globListed spelling) := by
  unfold ListedDirectory globListed cutToLastSlash
  generalize globConcrete spelling = c
  refine ⟨(c.reverse.takeWhile (· != '/')).reverse, ?_, ?_, ?_⟩
  · rw [← List.reverse_append, List.takeWhile_append_dropWhile, List.reverse_reverse]
  · intro hm
    rw [List.mem_reverse] at hm
    have hall := List.all_takeWhile (p := (· != '/')) (l := c.reverse)
    rw [List.all_eq_true] at hall
    simpa using hall _ hm
  · cases h : c.reverse.dropWhile (· != '/') with
    | nil => left; rfl
    | cons x xs =>
      right
      rw [List.getLast?_reverse, List.head?_cons]
      have := List.head?_dropWhile_not (· != '/') c.reverse
      rw [h] at this
      simpa using this

/-! ## (b''') Case folding -/

/-- Joining folded segments is folding the join. -/
theorem joinSlash_map_fold : ∀ L : List Seg, joinSlash (L.map fold) = fold (joinSlash L)
  | [] => rfl
  | [_] => rfl
  | s :: t :: ts => by
    have ih := joinSlash_map_fold (t :: ts)
    simp only [List.map_cons] at ih ⊢
    simp only [joinSlash]
    rw [ih, fold_append, fold_cons, foldChar_slash]
    rfl

/-- Trailing slashes of a concatenation: those of the second part, and of the first part too when
the second part is all slashes. -/
theorem stripTrailingSlashes_append (a b : List Char) :
    stripTrailingSlashes (a ++ b) =
      if stripTrailingSlashes b = [] then stripTrailingSlashes a else a ++ stripTrailingSlashes b := by
  unfold stripTrailingSlashes
  rw [List.reverse_append, List.dropWhile_append]
  by_cases h : b.reverse.dropWhile (· == '/') = []
  · simp [h]
  · simp [h]

/-- One character folded, then stripped of trailing slashes. -/
theorem stripTrailingSlashes_foldChar (c : Char) :
    stripTrailingSlashes (foldChar c) = fold (stripTrailingSlashes [c]) := by
  by_cases hc : c = '/'
  · subst hc; decide
  · have h1 : stripTrailingSlashes [c] = [c] := stripTrailingSlashes_of_getLast _ (by simp [hc])
    have h2 : stripTrailingSlashes (foldChar c) = foldChar c := by
      apply stripTrailingSlashes_of_getLast
      intro h
      exact hc ((slash_mem_foldChar c).1 (List.mem_of_getLast? h))
    rw [h1, h2]
    simp [fold]

/-- Folding commutes with dropping trailing slashes. -/
theorem stripTrailingSlashes_fold (s : List Char) :
    stripTrailingSlashes (fold s) = fold (stripTrailingSlashes s) := by
  induction s with
  | nil => rfl
  | cons c cs ih =>
    rw [fold_cons, stripTrailingSlashes_append, ih, show c :: cs = [c] ++ cs from rfl,
      stripTrailingSlashes_append]
    by_cases hs : stripTrailingSlashes cs = []
    · rw [ite_eq_left ((fold_eq_nil _).2 hs), ite_eq_left hs, stripTrailingSlashes_foldChar]
    · rw [ite_eq_right (fun h => hs ((fold_eq_nil _).1 h)), ite_eq_right hs, fold_append]
      simp [fold]

/-- Folding commutes with `basename`. -/
theorem fold_basename (s : List Char) : fold (basename s) = basename (fold s) := by
  unfold basename
  rw [stripTrailingSlashes_fold, splitSlash_fold, List.getLast?_map]
  cases (splitSlash (stripTrailingSlashes s)).getLast? <;> rfl

/-- The key of a resolved path does not see case: resolving the folded path gives the same key. -/
theorem foldKey_resolvePath_fold (x : List Char) : foldKey (resolvePath (fold x)) = foldKey (resolvePath x) := by
  by_cases hx : x.head? = some '/'
  · have hfx : (fold x).head? = some '/' := (head_fold x).2 hx
    have hR := proper_of_mem_resolveSegs (splitSlash x) (slashFree_of_mem_splitSlash x)
    have hRf : ∀ w ∈ (resolveSegs (splitSlash x)).map fold, Proper w := fun w hw => by
      obtain ⟨v, hv, rfl⟩ := List.mem_map.1 hw; exact proper_fold v (hR v hv)
    rw [resolvePath_abs _ hfx, resolvePath_abs _ hx, splitSlash_fold, resolveSegs_map_fold,
      foldKey_renderAbs _ (tmpMapSegs_slashFree _ (proper_slashFree hRf)),
      foldKey_renderAbs _ (tmpMapSegs_slashFree _ (proper_slashFree hR)),
      canon_tmpMapSegs, canon_tmpMapSegs, canon_map_fold]
  · have hfx : (fold x).head? ≠ some '/' := fun h => hx ((head_fold x).1 h)
    rw [resolvePath_rel _ hfx, resolvePath_rel _ hx]
    unfold foldKey
    rw [stripTrailingSlashes_fold, fold_fold]

/-- The folded basename of a resolved path does not see case either. -/
theorem fold_basename_resolvePath_fold (x : List Char) :
    fold (basename (resolvePath (fold x))) = fold (basename (resolvePath x)) := by
  by_cases hx : x.head? = some '/'
  · have hfx : (fold x).head? = some '/' := (head_fold x).2 hx
    have hR := proper_of_mem_resolveSegs (splitSlash x) (slashFree_of_mem_splitSlash x)
    have hRf : ∀ w ∈ (resolveSegs (splitSlash x)).map fold, Proper w := fun w hw => by
      obtain ⟨v, hv, rfl⟩ := List.mem_map.1 hw; exact proper_fold v (hR v hv)
    rw [resolvePath_abs _ hfx, resolvePath_abs _ hx, splitSlash_fold, resolveSegs_map_fold,
      basename_renderAbs_proper _ (tmpMapSegs_proper _ hRf), basename_renderAbs_proper _ (tmpMapSegs_proper _ hR),
      getLast?_tmpMapSegs, getLast?_tmpMapSegs, List.getLast?_map]
    cases (resolveSegs (splitSlash x)).getLast? with
    | none => rfl
    | some w => exact fold_fold w
  · have hfx : (fold x).head? ≠ some '/' := fun h => hx ((head_fold x).1 h)
    rw [resolvePath_rel _ hfx, resolvePath_rel _ hx, fold_basename, fold_basename, stripTrailingSlashes_fold,
      fold_fold]

/-- Two strings that fold alike resolve to the same key. -/
theorem foldKey_resolvePath_congr (x y : List Char) (h : fold x = fold y) :
    foldKey (resolvePath x) = foldKey (resolvePath y) := by
  rw [← foldKey_resolvePath_fold x, h, foldKey_resolvePath_fold]

/-- Two strings that fold alike resolve to basenames that fold alike. -/
theorem fold_basename_resolvePath_congr (x y : List Char) (h : fold x = fold y) :
    fold (basename (resolvePath x)) = fold (basename (resolvePath y)) := by
  rw [← fold_basename_resolvePath_fold x, h, fold_basename_resolvePath_fold]

/-- A string folds to one starting with a character that folds to itself and is not a lower-case
ASCII letter exactly when it starts with that character. -/
theorem head_fold_of_self (s : List Char) (d : Char) (hd : foldChar d = [d]) (hdl : d ∉ lowerAscii) :
    (fold s).head? = some d ↔ s.head? = some d := by
  cases s with
  | nil => simp
  | cons c cs =>
    rw [fold_cons]
    obtain ⟨e, es, he⟩ : ∃ e es, foldChar c = e :: es := by
      cases h : foldChar c with
      | nil => exact absurd h (foldChar_ne_nil c)
      | cons e es => exact ⟨e, es, rfl⟩
    rw [he]
    simp only [List.cons_append, List.head?_cons, Option.some.injEq]
    constructor
    · intro hed
      rcases foldChar_cases c with h | h
      · rw [h] at he
        simp only [List.cons.injEq] at he
        rw [he.1, hed]
      · exact absurd (hed ▸ h.2 e (by rw [he]; simp)) hdl
    · intro hcd
      rw [hcd, hd] at he
      simp only [List.cons.injEq] at he
      exact he.1.symm

/-- Folding a path that does not start with `$` cannot make it match a HOME alias. -/
theorem not_matchesAlias_fold (p : List Char) (hp : p.head? ≠ some '$') (hm : ¬ MatchesAlias p) :
    ¬ MatchesAlias (fold p) := by
  have hdollar : ∀ a : List Char, a.head? = some '$' → ¬ (fold p = a ∨ (a ++ ['/']) <+: fold p) := by
    intro a ha h
    apply hp
    refine (head_fold_of_self p '$' (by decide) (by decide)).1 ?_
    rcases h with h | ⟨t, ht⟩
    · rw [h]; exact ha
    · rw [← ht]
      cases a with
      | nil => simp at ha
      | cons x xs => simpa using ha
  rintro ⟨a, ha, h⟩
  rw [homeAliases_eq] at ha
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha
  rcases ha with rfl | rfl | rfl
  · have hhead : (fold p).head? = some '~' := by
      rcases h with h | ⟨t, ht⟩
      · rw [h]; rfl
      · rw [← ht]; rfl
    obtain ⟨cs, rfl⟩ : ∃ cs, p = '~' :: cs := by
      have := (head_fold_of_self p '~' (by decide) (by decide)).1 hhead
      cases p with
      | nil => simp at this
      | cons c cs => simp at this; exact ⟨cs, by rw [this]⟩
    rw [fold_cons, show foldChar '~' = ['~'] by decide, List.singleton_append] at h
    apply hm
    rcases h with h | ⟨t, ht⟩
    · simp only [List.cons.injEq, true_and] at h
      rw [(fold_eq_nil cs).1 h]
      exact ⟨['~'], by decide, Or.inl rfl⟩
    · simp only [List.cons_append, List.cons.injEq, true_and] at ht
      have hcs : cs.head? = some '/' := (head_fold cs).1 (by rw [← ht]; rfl)
      cases cs with
      | nil => simp at hcs
      | cons c r =>
        simp only [List.head?_cons, Option.some.injEq] at hcs
        subst hcs
        exact ⟨['~'], by decide, Or.inr ⟨r, rfl⟩⟩
  · exact hdollar _ rfl h
  · exact hdollar _ rfl h

/-- For a path that does not start with `$`, the folded path expands to what the path expands to,
folded. -/
theorem fold_expandHome_fold (home p : List Char) (hp : p.head? ≠ some '$') :
    fold (expandHome home (fold p) homeAliases) = fold (expandHome home p homeAliases) := by
  by_cases hm : MatchesAlias p
  · obtain ⟨a, ha, h⟩ := hm
    have ha' := ha
    rw [homeAliases_eq] at ha'
    simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha'
    rcases ha' with rfl | rfl | rfl
    · rcases h with rfl | ⟨t, rfl⟩
      · rw [show fold ['~'] = ['~'] by decide]
      · have hf : fold ((['~'] ++ ['/']) ++ t) = ['~'] ++ '/' :: fold t := by
          rw [fold_append, fold_append, show fold ['~'] = ['~'] by decide,
            show fold ['/'] = ['/'] by decide]
          rfl
        have hp' : (['~'] ++ ['/']) ++ t = ['~'] ++ '/' :: t := by simp
        rw [hf, hp', expandHome_alias_slash home (fold t) _ ha, expandHome_alias_slash home t _ ha,
          fold_append, fold_append, fold_cons, fold_cons, fold_fold]
    · exfalso; rcases h with rfl | ⟨t, rfl⟩ <;> exact hp rfl
    · exfalso; rcases h with rfl | ⟨t, rfl⟩ <;> exact hp rfl
  · rw [expandHome_of_not_matchesAlias home p hm,
      expandHome_of_not_matchesAlias home _ (not_matchesAlias_fold p hp hm), fold_fold]

/-- Two paths whose expansions fold alike have walk points with the same keys. -/
theorem walkPoints_map_foldKey (home p q : List Char)
    (h : fold (expandHome home p homeAliases) = fold (expandHome home q homeAliases)) :
    (walkPoints home p).map foldKey = (walkPoints home q).map foldKey := by
  unfold walkPoints
  dsimp only
  have hs : (splitSlash (expandHome home p homeAliases)).map fold =
      (splitSlash (expandHome home q homeAliases)).map fold := by
    rw [← splitSlash_fold, ← splitSlash_fold, h]
  have hlen : (splitSlash (expandHome home p homeAliases)).length =
      (splitSlash (expandHome home q homeAliases)).length := by
    rw [← List.length_map (f := fold), hs, List.length_map]
  rw [hlen, List.map_map, List.map_map]
  apply List.map_congr_left
  intro i _
  simp only [Function.comp_apply]
  apply foldKey_resolvePath_congr
  rw [← joinSlash_map_fold, ← joinSlash_map_fold, List.map_take, List.map_take, hs]

/-- The directory hits of a list of points depend only on the points' keys. -/
theorem findSome_directoryHit_map (home : List Char) (l : List (List Char)) :
    l.findSome? (directoryHit home) =
      (l.map foldKey).findSome? (fun k => (sensitiveDirectories home).find? (fun dir => underDirectory k (foldKey dir))) := by
  rw [List.findSome?_map]
  rfl

/-- Whether `verdict` reports sensitive depends only on the keys of the points and the folded
basename. -/
theorem verdict_isSensitive_congr (home n n' : List Char) (walk walk' : List (List Char))
    (hk : foldKey n = foldKey n') (hb : fold (basename n) = fold (basename n'))
    (hw : walk.map foldKey = walk'.map foldKey) :
    (verdict home n walk).isSensitive = (verdict home n' walk').isSensitive := by
  rw [verdict_isSensitive, verdict_isSensitive, findSome_directoryHit_map, findSome_directoryHit_map,
    List.map_cons, List.map_cons, hk, hw, hb]

/-- (b''') Folding a path that does not start with `$` leaves `isSensitive` as it was. -/
theorem fold_invariant (home : List Char) : FoldInvariant home := by
  intro p hp
  have h := fold_expandHome_fold home p hp
  rw [checkSensitivePath_eq_verdict, checkSensitivePath_eq_verdict]
  exact verdict_isSensitive_congr home _ _ _ _ (foldKey_resolvePath_congr _ _ h)
    (fold_basename_resolvePath_congr _ _ h) (walkPoints_map_foldKey home _ _ h)

/-! ## The module as loaded -/

/-- `path.resolve` returns an absolute path. -/
theorem renderDir_head (r : List Seg) : (renderDir r).head? = some '/' := by
  cases r with
  | nil => rfl
  | cons s ss => simp [renderDir, renderAbs]

/-- `normalizeTmpPath` keeps a path absolute. -/
theorem normalizeTmpPath_head (x : List Char) (hx : x.head? = some '/') :
    (normalizeTmpPath x).head? = some '/' := by
  unfold normalizeTmpPath
  split
  · exact hx
  · dsimp only
    split
    · exact hx
    · rfl

/-- The HOME the module computes when it loads is absolute, whatever `os.homedir()` returns. -/
theorem moduleHome_absolute (cwd homedir : List Char) : (moduleHome cwd homedir).head? = some '/' :=
  normalizeTmpPath_head _ (renderDir_head _)

/-- (a) for the module as loaded. -/
theorem normalizePath_idempotent_at_load (cwd homedir : List Char) :
    NormalizeIdempotent (moduleHome cwd homedir) :=
  normalizePath_idempotent _ (moduleHome_absolute cwd homedir)

/-- (b) for the module as loaded. -/
theorem check_refines_normal_form_at_load (cwd homedir : List Char) :
    CheckRefinesNormalForm (moduleHome cwd homedir) :=
  check_refines_normal_form _ (moduleHome_absolute cwd homedir)

/-- The HOME aliases, for the module as loaded. -/
theorem aliases_spell_home_at_load (cwd homedir : List Char) :
    AliasesSpellHome (moduleHome cwd homedir) :=
  aliases_spell_home _ (moduleHome_absolute cwd homedir)

/-- (c) for the module as loaded, with the location of `os.homedir()`, `/private/tmp` written
`/tmp`. -/
theorem dir_rule_segment_aligned_at_load (cwd homedir : List Char) (hloc : List Seg)
    (hcwd : cwd.head? = some '/') (h : HomeNames cwd homedir hloc) :
    DirectoryRuleSegmentAligned (moduleHome cwd homedir) (tmpMapSegs hloc) :=
  dir_rule_segment_aligned _ _ (moduleHome_names cwd homedir hloc hcwd h)

/-- (d) for the module as loaded, with the location of `os.homedir()`, `/private/tmp` written
`/tmp`. -/
theorem flagged_when_normalized_under_at_load (cwd homedir : List Char) (hloc : List Seg)
    (hcwd : cwd.head? = some '/') (h : HomeNames cwd homedir hloc) :
    FlaggedWhenNormalizedUnder (moduleHome cwd homedir) (tmpMapSegs hloc) :=
  flagged_when_normalized_under _ _ (moduleHome_names cwd homedir hloc hcwd h)

end SomaVerify.SensitivePath.Proofs
