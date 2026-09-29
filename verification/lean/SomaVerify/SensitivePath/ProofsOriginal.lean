import SomaVerify.SensitivePath.Model
import SomaVerify.SensitivePath.ModelOriginal
import SomaVerify.SensitivePath.Spec
import SomaVerify.SensitivePath.Proofs

/-!
# The simplified model equals the phase-1 model

`ModelOriginal.lean` keeps the phase-1 definitions the simplification changed. This file proves
the phase-1 service-rule theorems for them, and then that every simplified function returns
exactly what its original returns, for every argument: same sensitivity, same reason text.
Theorems about `checkSensitivePath` and `checkSensitiveGlob` therefore hold for both models.
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
theorem original_serviceConfigHit_iff (n : List Char) (d : List Seg) (file : Seg) (hd : HomeCanonical d) (hf : Proper file) :
    Original.serviceConfigHit n (renderAbs d) file = true ↔
      n.head? = some '/' ∧ (segmentsOf n = d ++ [file] ∨ ∃ m, segmentsOf n = d ++ [m, file]) := by
  have hjoin : pathJoin [renderAbs d, file] = renderAbs (d ++ [file]) :=
    pathJoin_renderAbs d [file] hd (by simp [hf])
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
  have hdirs : ∀ d ∈ serviceDirSegs, HomeCanonical d := by decide
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
  have hdirs : ∀ d ∈ serviceDirSegs, HomeCanonical d := by decide
  obtain ⟨hhead, hsegs⟩ := (original_serviceConfigHit_iff n d _ (hdirs d hd) (by decide)).1 h
  have hsf : ∀ w ∈ segmentsOf n, '/' ∉ w := fun w hw =>
    slashFree_of_mem_splitSlash n w (List.mem_of_mem_tail hw)
  have hb : basename n = ".env".toList := by
    rw [eq_renderAbs_segmentsOf n hhead]
    rcases hsegs with hs | ⟨m, hs⟩
    · rw [hs] at hsf ⊢
      exact basename_renderAbs_append d _ (fun w hw => hsf w (List.mem_append_left _ hw)) (by decide)
        (by decide)
    · rw [hs] at hsf ⊢
      rw [show d ++ [m, ".env".toList] = (d ++ [m]) ++ [".env".toList] by simp]
      refine basename_renderAbs_append _ _ (fun w hw => hsf w ?_) (by decide) (by decide)
      rcases List.mem_append.1 hw with h | h
      · exact List.mem_append_left _ h
      · simp at h; subst h; simp
  rw [hb]
  decide


/-! ## Simplified equals original -/

/-- Where the basename rule does not match, the two service-config rules agree: the entries the
simplification dropped (`.env`) only match paths whose basename is `.env`. -/
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

/-- The simplified checks return exactly what the original checks return, on every normalized
path: the rules before the service-config rule are unchanged, and it is only consulted where
the basename rule did not match. -/
theorem verdict_eq_original (home n : List Char) : verdict home n = Original.verdict home n := by
  unfold verdict Original.verdict
  cases (sensitiveDirectories home).find? (underDirectory n) with
  | some dir => rfl
  | none =>
    by_cases hb : basenamePatterns.any (fun test => test (basename n)) = true
    · simp only [hb, ite_true]
    · rw [serviceConfigRule_eq_original n (by simpa using hb)]

/-- C2, C3, C5: the simplified `checkSensitivePath` returns exactly what the phase-1
`checkSensitivePath` returns, for every HOME and path. The early return for `""` is subsumed
(`verdict_nil`). -/
theorem checkSensitivePath_eq_original (home p : List Char) :
    checkSensitivePath home p = Original.checkSensitivePath home p := by
  unfold Original.checkSensitivePath
  cases p with
  | nil =>
    rw [checkSensitivePath_eq_verdict, normalizePath_nil, verdict_nil]
    rfl
  | cons c cs =>
    simp only [List.isEmpty_cons, Bool.false_eq_true, ite_false]
    rw [checkSensitivePath_eq_verdict, verdict_eq_original]

/-- `checkSensitiveGlob` returns exactly what the phase-1 `checkSensitiveGlob` returns. -/
theorem checkSensitiveGlob_eq_original (home cwd pattern : List Char) (basePath : Option (List Char)) :
    checkSensitiveGlob home cwd pattern basePath = Original.checkSensitiveGlob home cwd pattern basePath := by
  unfold checkSensitiveGlob Original.checkSensitiveGlob
  exact checkSensitivePath_eq_original home _

/-- The simplification changed no answer. -/
theorem simplified_equals_original : SimplifiedEqualsOriginal :=
  ⟨checkSensitivePath_eq_original, checkSensitiveGlob_eq_original⟩

end SomaVerify.SensitivePath.ProofsOriginal
