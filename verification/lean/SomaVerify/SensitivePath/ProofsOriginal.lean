import SomaVerify.SensitivePath.Model
import SomaVerify.SensitivePath.ModelOriginal
import SomaVerify.SensitivePath.Spec
import SomaVerify.SensitivePath.Proofs
import SomaVerify.SensitivePath.ProofsFold
import SomaVerify.SensitivePath.ProofsCheck

/-!
# The current model is stricter than the phase-1 model

`ModelOriginal.lean` keeps the phase-1 definitions that have changed since. This file proves the
phase-1 service-rule theorems for them, and then `StricterThanOriginal`: every path and glob the
phase-1 checks report sensitive, the current checks report sensitive too.

For an absolute HOME both models normalize a path to the same string. Each phase-1 rule then has a
current rule that keeps its matches: the directory and exact-file rules compare keys (`foldKey`)
where phase 1 compared the strings, the basename patterns see the folded basename, the dropped
`.env` service entries are caught by the basename rule, and the glob check still checks the
concrete prefix of the resolved pattern, among other candidates.

The HOME must be absolute: with HOME `foo`, phase 1 sends `~/.ssh/x` through `path.join`, which
makes it `/foo/.ssh/x`, below its `/foo/.ssh`, while the current model keeps the relative
`foo/.ssh/x` and checks it as written. The module's HOME is always absolute
(`moduleHome_absolute`), so the relation holds for the module as loaded
(`stricter_than_original_at_load`).
-/

namespace SomaVerify.SensitivePath.ProofsOriginal

open SomaVerify.SensitivePath SomaVerify.SensitivePath.Spec SomaVerify.SensitivePath.Proofs

/-! ## Phase-1 service-config theorems, for the original definitions -/

/-- `parts.length === 2 && parts[1] === file` says `parts` is `[m, file]`. -/
theorem length_two_iff (l : List Seg) (f : Seg) :
    (l.length == 2 && l[1]? == some f) = true ↔ ∃ m, l = [m, f] := by
  constructor
  · intro h
    match l with
    | [] => simp at h
    | [_] => simp at h
    | [m, g] => simp at h; exact ⟨m, by rw [h]⟩
    | _ :: _ :: _ :: _ => simp at h
  · rintro ⟨m, rfl⟩; simp

/-- One entry of the original service-config loop matches exactly the absolute paths `dir/file`
and `dir/m/file`. -/
theorem original_serviceConfigHit_iff (n : List Char) (d : List Seg) (file : Seg) (hd : Canonical d)
    (hf : Proper file) :
    Original.serviceConfigHit n (renderAbs d) file = true ↔
      n.head? = some '/' ∧ (segmentsOf n = d ++ [file] ∨ ∃ m, segmentsOf n = d ++ [m, file]) := by
  have hjoin : pathJoin [renderAbs d, file] = renderAbs (d ++ [file]) :=
    pathJoin_renderAbs d [file] hd (by simp) (by simp [hf])
  have hdsf : ∀ w ∈ d, '/' ∉ w := proper_slashFree hd.2
  have hfsf : '/' ∉ file := hf.2.1
  have hdf : ∀ w ∈ d ++ [file], '/' ∉ w := by
    intro w hw
    rcases List.mem_append.1 hw with h | h
    · exact hdsf w h
    · simp at h; subst h; exact hfsf
  have hdne : d ≠ [] := hd.1
  unfold Original.serviceConfigHit
  rw [hjoin]
  by_cases h1 : n = renderAbs (d ++ [file])
  · subst h1
    simp only [beq_self_eq_true, ite_true, true_iff]
    exact ⟨head_renderAbs _ (by simp), Or.inl (segmentsOf_renderAbs _ hdf)⟩
  · have hb : (n == renderAbs (d ++ [file])) = false := by simp [h1]
    rw [hb]
    simp only [Bool.false_eq_true, ite_false]
    constructor
    · intro h
      split at h
      · rename_i hcond
        simp only [Bool.and_eq_true, List.isPrefixOf_iff_prefix] at hcond
        obtain ⟨⟨y, hy⟩, _⟩ := hcond
        subst hy
        have hdrop : ((renderAbs d ++ ['/']) ++ y).drop ((renderAbs d).length + 1) = y :=
          List.drop_left' (by simp)
        rw [hdrop] at h
        obtain ⟨m, hm⟩ := (length_two_iff _ _).1 h
        have hsplit : splitSlash ((renderAbs d ++ ['/']) ++ y) = [] :: (d ++ splitSlash y) := by
          rw [List.append_assoc, List.singleton_append, splitSlash_append_slash, splitSlash_renderAbs d hdsf]
          simp
        refine ⟨?_, Or.inr ⟨m, ?_⟩⟩
        · have hh := head_renderAbs d hdne
          cases hx : renderAbs d with
          | nil => rw [hx] at hh; simp at hh
          | cons c cs => rw [hx] at hh; simpa using hh
        · unfold segmentsOf; rw [hsplit, hm]; rfl
      · contradiction
    · rintro ⟨hhead, h | ⟨m, hm⟩⟩
      · exact absurd (by rw [eq_renderAbs_segmentsOf n hhead, h]) h1
      · have hmsf : '/' ∉ m := by
          have hmem : m ∈ segmentsOf n := by rw [hm]; simp
          exact slashFree_of_mem_splitSlash n m (List.mem_of_mem_tail hmem)
        have hn : n = (renderAbs d ++ ['/']) ++ (m ++ '/' :: file) := by
          rw [eq_renderAbs_segmentsOf n hhead, hm, renderAbs_append]
          simp [renderAbs]
        have hcond : ((renderAbs d ++ ['/']).isPrefixOf n && ('/' :: file).isSuffixOf n) = true := by
          simp only [Bool.and_eq_true, List.isPrefixOf_iff_prefix, List.isSuffixOf_iff_suffix]
          refine ⟨⟨_, hn.symm⟩, ⟨renderAbs d ++ '/' :: m, ?_⟩⟩
          rw [hn]; simp
        rw [ite_eq_left hcond]
        have hdrop : n.drop ((renderAbs d).length + 1) = m ++ '/' :: file := by
          rw [hn]; exact List.drop_left' (by simp)
        rw [hdrop, length_two_iff]
        exact ⟨m, by rw [splitSlash_append_slash, splitSlash_of_slashFree m hmsf,
          splitSlash_of_slashFree file hfsf]; rfl⟩

/-- The original `SENSITIVE_SERVICE_CONFIGS` renders `serviceDirSegs` × `serviceFileNames`. -/
theorem original_serviceConfigs_eq :
    Original.serviceConfigs = serviceDirSegs.map (fun d => (renderAbs d, serviceFileNames)) := by
  decide

/-- (f), phase 1: the original service-config rule (lines 94-108 at 168903e8) matches exactly
`.env` and `config.json` directly in `/opt/soma-work` or `/opt/soma`, or in exactly one
directory below one of them. -/
theorem original_service_rule_described : ServiceRuleMatches Original.serviceConfigRule serviceFileNames := by
  intro n
  have hdirs : ∀ d ∈ serviceDirSegs, Canonical d := by decide
  have hfiles : ∀ f ∈ serviceFileNames, Proper f := by decide
  rw [Original.serviceConfigRule, original_serviceConfigs_eq, List.any_map, List.any_eq_true]
  simp only [Function.comp_def, List.any_eq_true]
  constructor
  · rintro ⟨d, hd, f, hf, hhit⟩
    have := (original_serviceConfigHit_iff n d f (hdirs d hd) (hfiles f hf)).1 hhit
    exact ⟨this.1, d, hd, f, hf, this.2⟩
  · rintro ⟨hhead, d, hd, f, hf, h⟩
    exact ⟨d, hd, f, hf, (original_serviceConfigHit_iff n d f (hdirs d hd) (hfiles f hf)).2 ⟨hhead, h⟩⟩

/-- The `.env` entries of the original `SENSITIVE_SERVICE_CONFIGS` never decide a result: whenever
one matches, the basename rule, which runs first, has already matched. -/
theorem original_service_env_entry_shadowed (n : List Char) (d : List Seg) (hd : d ∈ serviceDirSegs)
    (h : Original.serviceConfigHit n (renderAbs d) ".env".toList = true) :
    basenamePatterns.any (fun test => test (basename n)) = true := by
  have hdirs : ∀ d ∈ serviceDirSegs, Canonical d := by decide
  obtain ⟨hhead, hsegs⟩ := (original_serviceConfigHit_iff n d _ (hdirs d hd) (by decide)).1 h
  rw [basename_of_segments_env n d hhead hsegs]
  decide

/-- Where the basename rule does not match, the current and the original service-config rules
agree on a path: the entries the simplification dropped (`.env`) only match paths whose basename
is `.env`. -/
theorem serviceConfigRule_eq_original (n : List Char)
    (hb : basenamePatterns.any (fun test => test (basename n)) = false) :
    serviceConfigRule n = Original.serviceConfigRule n := by
  cases hnew : serviceConfigRule n <;> cases hold : Original.serviceConfigRule n
  · rfl
  · exfalso
    obtain ⟨hhead, dir, hdir, f, hf, hs⟩ := (original_service_rule_described n).1 hold
    simp only [serviceFileNames, List.mem_cons, List.mem_nil_iff, or_false] at hf
    rcases hf with rfl | rfl
    · rw [basename_of_segments_env n dir hhead hs] at hb
      exact absurd hb (by decide)
    · have := (service_rule_described n).2
        ⟨hhead, dir, hdir, "config.json".toList, by simp [serviceTableFileNames], hs⟩
      rw [hnew] at this
      exact absurd this (by decide)
  · exfalso
    obtain ⟨hhead, dir, hdir, f, hf, hs⟩ := (service_rule_described n).1 hnew
    have := (original_service_rule_described n).2
      ⟨hhead, dir, hdir, f, by simp [serviceTableFileNames] at hf; simp [serviceFileNames, hf], hs⟩
    rw [hold] at this
    exact absurd this (by decide)
  · rfl

/-! ## Both models normalize alike -/

/-- The phase-1 alias loop leaves a path that matches no alias unchanged. -/
theorem original_expandHome_of_not_matches (home s : List Char) (aliases : List (List Char))
    (h : ∀ a ∈ aliases, ¬ (s = a ∨ (a ++ ['/']) <+: s)) : Original.expandHome home s aliases = s := by
  induction aliases with
  | nil => rfl
  | cons a as ih =>
    have ha := h a (by simp)
    have h1 : (a ++ ['/']).isPrefixOf s = false := by
      cases e : (a ++ ['/']).isPrefixOf s
      · rfl
      · exact absurd (Or.inr (List.isPrefixOf_iff_prefix.1 e)) ha
    have h2 : (s == a) = false := by
      cases e : (s == a)
      · rfl
      · exact absurd (Or.inl (beq_iff_eq.1 e)) ha
    simp only [Original.expandHome, h1, h2, Bool.false_eq_true, ite_false]
    exact ih (fun a' ha' => h a' (by simp [ha']))

/-- Phase 1: an alias followed by `/` is `path.join(HOME, rest)`. -/
theorem original_expandHome_alias_slash (home rest a : List Char) (ha : a ∈ homeAliases) :
    Original.expandHome home (a ++ '/' :: rest) homeAliases = pathJoin [home, rest] := by
  rw [homeAliases_eq] at ha ⊢
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha
  rcases ha with rfl | rfl | rfl <;> simp [Original.expandHome, List.isPrefixOf]

/-- Phase 1: an alias alone is HOME. -/
theorem original_expandHome_alias (home a : List Char) (ha : a ∈ homeAliases) :
    Original.expandHome home a homeAliases = home := by
  rw [homeAliases_eq] at ha ⊢
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at ha
  rcases ha with rfl | rfl | rfl <;> simp [Original.expandHome, List.isPrefixOf]

/-- For an absolute HOME, the phase-1 `normalizePath` and the current one return the same string
for every path. They differ only on an alias followed by `/`, which phase 1 sends through
`path.join(HOME, rest)` and the current model writes as `HOME + '/' + rest`; both resolve to the
same segments. -/
theorem original_normalizePath (home p : List Char) (hh : home.head? = some '/') :
    Original.normalizePath home p = normalizePath home p := by
  show resolvePath (Original.expandHome home p homeAliases) = resolvePath (expandHome home p homeAliases)
  by_cases hm : MatchesAlias p
  · obtain ⟨a, ha, heq | ⟨t, ht⟩⟩ := hm
    · rw [heq, original_expandHome_alias home a ha, expandHome_alias home a ha]
    · subst ht
      rw [List.append_assoc, List.singleton_append, original_expandHome_alias_slash home t a ha,
        expandHome_alias_slash home t a ha, pathJoin_home home t hh,
        resolvePath_abs _ (posixNormalize_head _), resolveSegs_splitSlash_posixNormalize,
        resolvePath_abs _ (head_home_slash home t hh)]
      cases t with
      | nil =>
        simp only [List.isEmpty_nil, ite_true]
        rw [splitSlash_append_slash, show splitSlash ([] : List Char) = [[]] from rfl,
          resolveSegs_append_nil]
      | cons c cs => simp
  · rw [original_expandHome_of_not_matches home p homeAliases (fun a ha hm' => hm ⟨a, ha, hm'⟩),
      expandHome_of_not_matchesAlias home p hm]

/-! ## Each phase-1 rule is kept -/

/-- Phase 1's `verdict` reports a path sensitive only through one of its four rules. -/
theorem original_verdict_cases (home n : List Char) (h : (Original.verdict home n).isSensitive = true) :
    (∃ dir ∈ sensitiveDirectories home, underDirectory n dir = true) ∨
      (sensitiveExactFiles home).contains n = true ∨
      basenamePatterns.any (fun test => test (basename n)) = true ∨
      Original.serviceConfigRule n = true := by
  unfold Original.verdict at h
  split at h
  · rename_i dir hfind
    exact Or.inl ⟨dir, List.mem_of_find?_eq_some hfind, List.find?_some hfind⟩
  · split at h
    · rename_i he; exact Or.inr (Or.inl he)
    · split at h
      · rename_i hb; exact Or.inr (Or.inr (Or.inl hb))
      · split at h
        · rename_i hs; exact Or.inr (Or.inr (Or.inr hs))
        · simp [notSensitive] at h

/-- The current `verdict` reports a path sensitive whenever one of its rules matches the
normalized path, whatever the walk points are. -/
theorem verdict_isSensitive_of (home n : List Char) (walk : List (List Char))
    (h : (directoryHit home n).isSome = true ∨
      ((sensitiveExactFiles home).map foldKey).contains (foldKey n) = true ∨
      basenamePatterns.any (fun test => test (fold (basename n))) = true ∨
      serviceConfigRule (foldKey n) = true) :
    (verdict home n walk).isSensitive = true := by
  unfold verdict
  split
  · rfl
  · rename_i hnone
    have hdir : directoryHit home n = none := by
      rw [List.findSome?_cons] at hnone
      split at hnone
      · simp at hnone
      · assumption
    split
    · rfl
    · split
      · rfl
      · split
        · rfl
        · rename_i he hb hs
          rcases h with h | h | h | h
          · rw [hdir] at h; simp at h
          · exact absurd h he
          · exact absurd h hb
          · exact absurd h hs

/-- For an absolute HOME, every entry of `SENSITIVE_DIRECTORIES` is the rendering of a non-empty
list of proper segments other than a lone `private`. -/
theorem sensitiveDirectories_renderAbs (home : List Char) (hh : home.head? = some '/') :
    ∀ dir ∈ sensitiveDirectories home, ∃ D : List Seg, dir = renderAbs D ∧ D ≠ [] ∧
      (∀ w ∈ D, Proper w) ∧ D.map fold ≠ [privateSeg] := by
  have hsd : sensitiveDirectories home =
      homeDirSuffixes.map (fun e => pathJoin (home :: e)) ++ ["/etc/shadow".toList] := rfl
  intro dir hdir
  rw [hsd, List.mem_append] at hdir
  rcases hdir with hdir | hdir
  · obtain ⟨e, he, rfl⟩ := List.mem_map.1 hdir
    obtain ⟨hne, hproper, hpriv⟩ := homeDirSuffixes_props e he
    have hH := proper_of_mem_resolveSegs (splitSlash home) (slashFree_of_mem_splitSlash home)
    refine ⟨resolveSegs (splitSlash home) ++ e, pathJoin_abs home e hh hne hproper, by simp [hne], ?_, ?_⟩
    · intro w hw
      rcases List.mem_append.1 hw with hw | hw
      · exact hH w hw
      · exact hproper w hw
    · intro heq
      rw [List.map_append] at heq
      cases hR : resolveSegs (splitSlash home) with
      | nil => rw [hR] at heq; simp only [List.map_nil, List.nil_append] at heq; exact hpriv heq
      | cons x xs =>
        rw [hR] at heq
        cases e with
        | nil => exact hne rfl
        | cons y ys => simp at heq
  · simp only [List.mem_singleton] at hdir
    subst hdir
    exact ⟨["etc".toList, "shadow".toList], renderAbs_etc_shadow, by decide, by decide, by decide⟩

/-- The directory rule: for an absolute HOME, a path phase 1 finds at or below a sensitive
directory has its key at or below that directory's key. -/
theorem underDirectory_foldKey (home n dir : List Char) (hh : home.head? = some '/')
    (hdir : dir ∈ sensitiveDirectories home) (hu : underDirectory n dir = true) :
    underDirectory (foldKey n) (foldKey dir) = true := by
  obtain ⟨D, rfl, hne, hproper, hpriv⟩ := sensitiveDirectories_renderAbs home hh dir hdir
  have hDsf := proper_slashFree hproper
  obtain ⟨hhead, U, hU⟩ := (underDirectory_renderAbs_iff_prefix n D hDsf hne).1 hu
  have hsf : ∀ w ∈ segmentsOf n, '/' ∉ w := fun w hw =>
    slashFree_of_mem_splitSlash n w (List.mem_of_mem_tail hw)
  have hcne : canon D ≠ [] := tmpMapSegs_ne_nil _ (by simpa using hne)
  rw [foldKey_abs n hhead, foldKey_renderAbs D hDsf,
    underDirectory_renderAbs_iff_prefix _ _ (canon_slashFree D hDsf) hcne,
    segmentsOf_renderAbs _ (canon_slashFree _ hsf), ← hU, canon_append D U hne hpriv]
  exact ⟨head_renderAbs _ (by simp [hcne]), List.prefix_append _ _⟩

/-- The exact-file rule: a path phase 1 finds in `SENSITIVE_EXACT_FILES` has its key among the
keys. -/
theorem exactFiles_foldKey (home n : List Char) (h : (sensitiveExactFiles home).contains n = true) :
    ((sensitiveExactFiles home).map foldKey).contains (foldKey n) = true := by
  rw [List.contains_iff_mem] at h ⊢
  exact List.mem_map.2 ⟨n, h, rfl⟩

/-- The basename rule: a basename a pattern matches still matches once folded. -/
theorem basename_rule_fold (b : List Char) (h : basenamePatterns.any (fun test => test b) = true) :
    basenamePatterns.any (fun test => test (fold b)) = true := by
  refine (basename_rule_described (fold b)).2 ?_
  rcases (basename_rule_described b).1 h with h | h | h
  · left
    rcases h with rfl | ⟨r, hr, hlt, rfl⟩
    · left; decide
    · right
      refine ⟨fold r, fun e => hr ((fold_eq_nil r).1 e), ?_, ?_⟩
      · intro c hc
        simp only [fold, List.mem_flatMap] at hc
        obtain ⟨d, hd, hcd⟩ := hc
        exact foldChar_lineTerminator d (hlt d hd) c hcd
      · rw [fold_append, show fold ".env.".toList = ".env.".toList by decide]
  · right; left
    unfold CredentialsName at h ⊢
    rw [h]; decide
  · right; right
    obtain ⟨stem, hstem, ext, hext, rfl⟩ := h
    have hfixed : ∀ stem ∈ ["secret".toList, "secrets".toList],
        ∀ ext ∈ ["json".toList, "yaml".toList, "yml".toList, "toml".toList],
          fold (stem ++ '.' :: ext) = stem ++ '.' :: ext := by
      decide
    exact ⟨stem, hstem, ext, hext, hfixed stem hstem ext hext⟩

/-- The current service-config rule matches a path's key whenever it matches the path. -/
theorem serviceConfigRule_foldKey (n : List Char) (h : serviceConfigRule n = true) :
    serviceConfigRule (foldKey n) = true := by
  obtain ⟨hhead, dir, hdir, f, hf, hs⟩ := (service_rule_described n).1 h
  have hdirs : ∀ d ∈ serviceDirSegs, d.map fold = d ∧ tmpMapSegs d = d ∧ d.length = 2 := by decide
  obtain ⟨hdf, hdt, hdl⟩ := hdirs dir hdir
  have hcanon : ∀ X : List Seg, canon (dir ++ X) = dir ++ X.map fold := by
    intro X
    unfold canon
    rw [List.map_append, hdf, tmpMapSegs_append_left dir _ (by intro e; simp [e] at hdl)
      (by intro e; rw [hdl] at e; simp at e), hdt]
  have hf' : fold f = f := by
    simp only [serviceTableFileNames, List.mem_singleton] at hf
    subst hf; decide
  have hsf : ∀ w ∈ segmentsOf n, '/' ∉ w := fun w hw =>
    slashFree_of_mem_splitSlash n w (List.mem_of_mem_tail hw)
  have hcsf := canon_slashFree _ hsf
  have hcne : canon (segmentsOf n) ≠ [] := by
    rcases hs with hs | ⟨m, hs⟩ <;> rw [hs, hcanon] <;> simp
  refine (service_rule_described (foldKey n)).2 ⟨?_, dir, hdir, f, hf, ?_⟩
  · rw [foldKey_abs n hhead]; exact head_renderAbs _ hcne
  · rw [foldKey_abs n hhead, segmentsOf_renderAbs _ hcsf]
    rcases hs with hs | ⟨m, hs⟩
    · left; rw [hs, hcanon]; simp [hf']
    · right; exact ⟨fold m, by rw [hs, hcanon]; simp [hf']⟩

/-- The service-config rule: a path phase 1's table matches is matched by the current basename
rule (the `.env` entries) or by the current table on its key (`config.json`). -/
theorem serviceConfigRule_of_original (n : List Char) (h : Original.serviceConfigRule n = true) :
    basenamePatterns.any (fun test => test (fold (basename n))) = true ∨
      serviceConfigRule (foldKey n) = true := by
  by_cases hb : basenamePatterns.any (fun test => test (basename n)) = true
  · exact Or.inl (basename_rule_fold _ hb)
  · right
    rw [← serviceConfigRule_eq_original n (by simpa using hb)] at h
    exact serviceConfigRule_foldKey n h

/-- For an absolute HOME, the current `verdict` reports sensitive every normalized path the
phase-1 `verdict` does. -/
theorem verdict_stricter (home n : List Char) (walk : List (List Char)) (hh : home.head? = some '/')
    (h : (Original.verdict home n).isSensitive = true) : (verdict home n walk).isSensitive = true := by
  apply verdict_isSensitive_of
  rcases original_verdict_cases home n h with ⟨dir, hdir, hu⟩ | he | hb | hs
  · left
    unfold directoryHit
    exact List.find?_isSome.2 ⟨dir, hdir, underDirectory_foldKey home n dir hh hdir hu⟩
  · exact Or.inr (Or.inl (exactFiles_foldKey home n he))
  · exact Or.inr (Or.inr (Or.inl (basename_rule_fold _ hb)))
  · rcases serviceConfigRule_of_original n hs with h | h
    · exact Or.inr (Or.inr (Or.inl h))
    · exact Or.inr (Or.inr (Or.inr h))

/-! ## Stricter than the original -/

/-- For an absolute HOME, `checkSensitivePath` reports sensitive every path the phase-1
`checkSensitivePath` does. -/
theorem checkSensitivePath_stricter (home p : List Char) (hh : home.head? = some '/')
    (h : (Original.checkSensitivePath home p).isSensitive = true) :
    (checkSensitivePath home p).isSensitive = true := by
  unfold Original.checkSensitivePath at h
  split at h
  · simp [notSensitive] at h
  · rw [original_normalizePath home p hh] at h
    rw [checkSensitivePath_eq_verdict]
    exact verdict_stricter home _ _ hh h

/-- The path phase 1 checks for a glob, the concrete prefix of the pattern resolved against its
base, is one of the paths the current check checks. -/
theorem original_glob_candidate (cwd pattern : List Char) (basePath : Option (List Char)) :
    globPrefix (Original.globResolved cwd pattern basePath) ∈
      (globSpellings cwd pattern basePath).flatMap globCandidates := by
  rw [List.mem_flatMap]
  refine ⟨Original.globResolved cwd pattern basePath, ?_, by simp [globCandidates]⟩
  unfold Original.globResolved globSpellings
  cases basePath with
  | none => simp
  | some b => by_cases hb : b.isEmpty <;> simp [hb]

/-- For an absolute HOME, the current checks report sensitive every path and glob the phase-1
checks do. -/
theorem stricter_than_original (home : List Char) (hh : home.head? = some '/') :
    StricterThanOriginal home :=
  ⟨fun p h => checkSensitivePath_stricter home p hh h,
   fun cwd pattern basePath h =>
     checkSensitiveGlob_of_candidate home cwd pattern basePath _ (original_glob_candidate cwd pattern basePath)
       (checkSensitivePath_stricter home _ hh h)⟩

/-- For the module as loaded, whatever the working directory and `os.homedir()`: the current
checks report sensitive every path and glob the phase-1 checks do. -/
theorem stricter_than_original_at_load (cwd homedir : List Char) :
    StricterThanOriginal (moduleHome cwd homedir) :=
  stricter_than_original _ (moduleHome_absolute cwd homedir)

end SomaVerify.SensitivePath.ProofsOriginal
