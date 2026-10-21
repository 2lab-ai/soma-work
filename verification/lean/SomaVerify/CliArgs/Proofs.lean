import SomaVerify.CliArgs.Spec

/-!
# Proofs of the `src/cli/args.ts` invariants

Every proposition of `Spec.lean` is proved here, about the model in `Model.lean`. The walker
lemmas go by the functional induction principle Lean derives for `walk` (`walk.induct`), one
case per branch of the loop in args.ts:128-157. A bare `args.ts:N` means `src/cli/args.ts:N`.
-/

namespace SomaVerify.CliArgs

open SomaVerify.JsString

/-! ## Association lists -/

theorem beq_false_of_ne {a b : String} (h : a ≠ b) : (a == b) = false := by
  simpa using h

/-- A key is absent from an association list exactly when `lookup` finds nothing. -/
theorem lookup_eq_none_iff {β : Type} {k : String} :
    ∀ {l : List (String × β)}, l.lookup k = none ↔ k ∉ l.map (·.1)
  | [] => by simp [List.lookup]
  | (k', v) :: rest => by
    rw [List.lookup_cons]
    by_cases h : k = k'
    · subst h
      simp
    · rw [beq_false_of_ne h]
      simp only [List.map_cons, List.mem_cons, not_or]
      rw [lookup_eq_none_iff]
      simp [h]

/-- `lookup` only returns a value stored under the key it was asked for. -/
theorem mem_of_lookup_eq_some {β : Type} {k : String} {v : β} :
    ∀ {l : List (String × β)}, l.lookup k = some v → (k, v) ∈ l
  | [], h => by simp [List.lookup] at h
  | (k', v') :: rest, h => by
    rw [List.lookup_cons] at h
    by_cases hk : k = k'
    · subst hk
      simp only [beq_self_eq_true, Option.some.injEq] at h
      subst h
      exact List.mem_cons_self
    · rw [beq_false_of_ne hk] at h
      exact List.mem_cons_of_mem _ (mem_of_lookup_eq_some h)

/-- With distinct keys, every stored entry is what `lookup` returns for its key. -/
theorem lookup_eq_some_of_mem {β : Type} {k : String} {v : β} :
    ∀ {l : List (String × β)}, (l.map (·.1)).Nodup → (k, v) ∈ l → l.lookup k = some v
  | [], _, h => by simp at h
  | (k', v') :: rest, hnd, h => by
    rw [List.map_cons, List.nodup_cons] at hnd
    rw [List.lookup_cons]
    rcases List.mem_cons.mp h with hhead | htail
    · cases hhead
      simp
    · have hk : k ≠ k' := by
        intro hk
        exact hnd.1 (List.mem_map.mpr ⟨(k, v), htail, by simp [hk]⟩)
      rw [beq_false_of_ne hk]
      exact lookup_eq_some_of_mem hnd.2 htail

/-- Distinct keys make distinct entries. -/
theorem nodup_of_nodup_keys {β : Type} :
    ∀ {l : List (String × β)}, (l.map (·.1)).Nodup → l.Nodup
  | [], _ => List.nodup_nil
  | e :: rest, hnd => by
    rw [List.map_cons, List.nodup_cons] at hnd
    refine List.nodup_cons.mpr ⟨fun hmem => hnd.1 (List.mem_map.mpr ⟨e, hmem, rfl⟩), ?_⟩
    exact nodup_of_nodup_keys hnd.2

/-- Appending an entry under a fresh key keeps the keys distinct. -/
theorem nodup_keys_append {β : Type} {l : List (String × β)} {k : String} {v : β}
    (hnd : (l.map (·.1)).Nodup) (hfresh : l.lookup k = none) :
    ((l ++ [(k, v)]).map (·.1)).Nodup := by
  rw [List.map_append, List.nodup_append]
  refine ⟨hnd, by simp, ?_⟩
  intro a ha b hb hab
  simp only [List.map_cons, List.map_nil, List.mem_singleton] at hb
  subst hb
  subst hab
  exact (lookup_eq_none_iff.mp hfresh) ha

/-- `parsed.flags.has(k)` is false exactly when `get` finds nothing. -/
theorem has_eq_false_iff {parsed : Parsed} {k : String} :
    parsed.has k = false ↔ parsed.flags.lookup k = none := by
  unfold Parsed.has
  cases parsed.flags.lookup k <;> simp

/-- A flag set under another key does not change `has` for `k`. -/
theorem has_append_ne {flags : List (String × FlagValue)} {positionals : List String}
    {k t : String} {v : FlagValue} (h : t ≠ k) :
    ({ flags := flags ++ [(t, v)], positionals := positionals } : Parsed).has k =
      ({ flags := flags, positionals := positionals } : Parsed).has k := by
  simp only [Parsed.has, List.lookup_append, List.lookup_cons, List.lookup_nil,
    beq_false_of_ne (Ne.symm h)]
  cases flags.lookup k <;> rfl

/-- After `set(k, v)`, `has(k)` holds. -/
theorem has_append_self {flags : List (String × FlagValue)} {positionals : List String}
    {k : String} {v : FlagValue} :
    ({ flags := flags ++ [(k, v)], positionals := positionals } : Parsed).has k = true := by
  simp only [Parsed.has, List.lookup_append, List.lookup_cons, beq_self_eq_true]
  cases flags.lookup k <;> rfl

/-! ## Token lists -/

theorem flagTokens_append (a b : List (String × FlagValue)) :
    flagTokens (a ++ b) = flagTokens a ++ flagTokens b := by
  simp [flagTokens, List.flatMap_append]

@[simp] theorem flagTokens_nil : flagTokens [] = [] := rfl

@[simp] theorem flagTokens_present (flag : String) : flagTokens [(flag, .present)] = [flag] := rfl

@[simp] theorem flagTokens_str (flag value : String) :
    flagTokens [(flag, .str value)] = [flag, value] := rfl

/-- `getD` inside the bounds returns an element of the list. -/
theorem getD_mem {α : Type} {d : α} :
    ∀ {l : List α} {n : Nat}, n < l.length → l.getD n d ∈ l
  | [], _, h => by simp at h
  | a :: rest, 0, _ => by simp
  | a :: rest, n + 1, h => by
    simp only [List.length_cons, Nat.add_lt_add_iff_right] at h
    simp only [List.getD_cons_succ]
    exact List.mem_cons_of_mem _ (getD_mem h)

/-! ## The walker (args.ts:128-157) -/

section Walk

variable {grammar : Grammar} {command : String}

/-! One lemma per branch of the loop body (args.ts:131-156). -/

theorem walk_nil (acc : Parsed) : walk grammar command [] acc = .ok acc := by
  rw [walk.eq_def]

/-- args.ts:156: a token that is not an option is a positional. -/
theorem walk_positional {token : String} {tokens : List String} {acc : Parsed}
    (hopt : ¬isOptionToken token = true) :
    walk grammar command (token :: tokens) acc =
      walk grammar command tokens
        { flags := acc.flags, positionals := acc.positionals ++ [token] } := by
  rw [walk.eq_def]
  simp only [hopt, Bool.false_eq_true, ↓reduceIte]

/-- args.ts:133-137 -/
theorem walk_unknown {token : String} {tokens : List String} {acc : Parsed}
    (hopt : isOptionToken token = true) (hlook : grammar.flags.lookup token = none) :
    walk grammar command (token :: tokens) acc =
      .error (unknownOptionMessage token grammar command) := by
  rw [walk.eq_def]
  simp only [hopt, hlook, ↓reduceIte]

/-- args.ts:138-140 -/
theorem walk_repeated {token : String} {tokens : List String} {acc : Parsed} {kind : FlagKind}
    (hopt : isOptionToken token = true) (hlook : grammar.flags.lookup token = some kind)
    (hhas : acc.has token = true) :
    walk grammar command (token :: tokens) acc = .error (repeatedOptionMessage token) := by
  rw [walk.eq_def]
  simp only [hopt, hlook, hhas, ↓reduceIte]

/-- args.ts:141-144 -/
theorem walk_boolean {token : String} {tokens : List String} {acc : Parsed}
    (hopt : isOptionToken token = true) (hhas : ¬acc.has token = true)
    (hlook : grammar.flags.lookup token = some .boolean) :
    walk grammar command (token :: tokens) acc =
      walk grammar command tokens
        { flags := acc.flags ++ [(token, .present)], positionals := acc.positionals } := by
  rw [walk.eq_def]
  simp only [hopt, hlook, hhas, Bool.false_eq_true, ↓reduceIte]

/-- args.ts:145-150, the value is missing. -/
theorem walk_value_missing {token : String} {acc : Parsed}
    (hopt : isOptionToken token = true) (hhas : ¬acc.has token = true)
    (hlook : grammar.flags.lookup token = some .value) :
    walk grammar command [token] acc = .error (requiresValueMessage token) := by
  rw [walk.eq_def]
  simp only [hopt, hlook, hhas, Bool.false_eq_true, ↓reduceIte]

/-- args.ts:145-150, the next token starts with `--`. -/
theorem walk_value_dash {token value : String} {tokens : List String} {acc : Parsed}
    (hopt : isOptionToken token = true) (hhas : ¬acc.has token = true)
    (hstart : jsStartsWith value "--" = true) (hlook : grammar.flags.lookup token = some .value) :
    walk grammar command (token :: value :: tokens) acc = .error (requiresValueMessage token) := by
  rw [walk.eq_def]
  simp only [hopt, hlook, hhas, hstart, Bool.false_eq_true, ↓reduceIte]

/-- args.ts:151-153 -/
theorem walk_value {token value : String} {tokens : List String} {acc : Parsed}
    (hopt : isOptionToken token = true) (hhas : ¬acc.has token = true)
    (hstart : ¬jsStartsWith value "--" = true) (hlook : grammar.flags.lookup token = some .value) :
    walk grammar command (token :: value :: tokens) acc =
      walk grammar command tokens
        { flags := acc.flags ++ [(token, .str value)], positionals := acc.positionals } := by
  rw [walk.eq_def]
  simp only [hopt, hlook, hhas, hstart, Bool.false_eq_true, ↓reduceIte]

/-- Every token is accounted for: the positionals and the flag tokens the walk ends with are a
permutation of what it started with plus the tokens it read. -/
theorem walk_perm : ∀ (tokens : List String) (acc parsed : Parsed),
    walk grammar command tokens acc = .ok parsed →
    (parsed.positionals ++ flagTokens parsed.flags).Perm
      (acc.positionals ++ flagTokens acc.flags ++ tokens) := by
  intro tokens acc
  induction tokens, acc using walk.induct grammar with
  | case1 acc =>
    intro parsed h
    rw [walk_nil, Except.ok.injEq] at h
    subst h
    simp
  | case2 token tokens acc hopt hlook =>
    intro parsed h
    simp [walk_unknown hopt hlook] at h
  | case3 token tokens acc hopt kind hlook hhas =>
    intro parsed h
    simp [walk_repeated hopt hlook hhas] at h
  | case4 token tokens acc hopt hhas hlook ih =>
    intro parsed h
    rw [walk_boolean hopt hhas hlook] at h
    simpa [flagTokens_append, List.append_assoc] using ih parsed h
  | case5 token acc hopt hhas hlook =>
    intro parsed h
    simp [walk_value_missing hopt hhas hlook] at h
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro parsed h
    simp [walk_value_dash hopt hhas hstart hlook] at h
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro parsed h
    rw [walk_value hopt hhas hstart hlook] at h
    simpa [flagTokens_append, List.append_assoc] using ih parsed h
  | case8 token tokens acc hopt ih =>
    intro parsed h
    rw [walk_positional hopt] at h
    refine (ih parsed h).trans ?_
    simp only [List.append_assoc, List.singleton_append]
    exact List.Perm.append_left _ List.perm_middle.symm

/-- The walk never stores a flag twice. -/
theorem walk_nodup : ∀ (tokens : List String) (acc parsed : Parsed),
    walk grammar command tokens acc = .ok parsed →
    (acc.flags.map (·.1)).Nodup → (parsed.flags.map (·.1)).Nodup := by
  intro tokens acc
  induction tokens, acc using walk.induct grammar with
  | case1 acc =>
    intro parsed h hnd
    rw [walk_nil, Except.ok.injEq] at h
    subst h
    exact hnd
  | case2 token tokens acc hopt hlook =>
    intro parsed h
    simp [walk_unknown hopt hlook] at h
  | case3 token tokens acc hopt kind hlook hhas =>
    intro parsed h
    simp [walk_repeated hopt hlook hhas] at h
  | case4 token tokens acc hopt hhas hlook ih =>
    intro parsed h hnd
    rw [walk_boolean hopt hhas hlook] at h
    exact ih parsed h
      (nodup_keys_append hnd (has_eq_false_iff.mp (Bool.eq_false_iff.mpr hhas)))
  | case5 token acc hopt hhas hlook =>
    intro parsed h
    simp [walk_value_missing hopt hhas hlook] at h
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro parsed h
    simp [walk_value_dash hopt hhas hstart hlook] at h
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro parsed h hnd
    rw [walk_value hopt hhas hstart hlook] at h
    exact ih parsed h
      (nodup_keys_append hnd (has_eq_false_iff.mp (Bool.eq_false_iff.mpr hhas)))
  | case8 token tokens acc hopt ih =>
    intro parsed h hnd
    rw [walk_positional hopt] at h
    exact ih parsed h hnd

/-- Every stored flag is declared by the grammar, with the kind its value witnesses. -/
theorem walk_declared : ∀ (tokens : List String) (acc parsed : Parsed),
    walk grammar command tokens acc = .ok parsed →
    (∀ entry ∈ acc.flags, grammar.flags.lookup entry.1 = some entry.2.kind) →
    ∀ entry ∈ parsed.flags, grammar.flags.lookup entry.1 = some entry.2.kind := by
  intro tokens acc
  induction tokens, acc using walk.induct grammar with
  | case1 acc =>
    intro parsed h hacc
    rw [walk_nil, Except.ok.injEq] at h
    subst h
    exact hacc
  | case2 token tokens acc hopt hlook =>
    intro parsed h
    simp [walk_unknown hopt hlook] at h
  | case3 token tokens acc hopt kind hlook hhas =>
    intro parsed h
    simp [walk_repeated hopt hlook hhas] at h
  | case4 token tokens acc hopt hhas hlook ih =>
    intro parsed h hacc
    rw [walk_boolean hopt hhas hlook] at h
    refine ih parsed h ?_
    intro entry hmem
    rcases List.mem_append.mp hmem with hmem | hmem
    · exact hacc entry hmem
    · simp only [List.mem_singleton] at hmem
      subst hmem
      exact hlook
  | case5 token acc hopt hhas hlook =>
    intro parsed h
    simp [walk_value_missing hopt hhas hlook] at h
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro parsed h
    simp [walk_value_dash hopt hhas hstart hlook] at h
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro parsed h hacc
    rw [walk_value hopt hhas hstart hlook] at h
    refine ih parsed h ?_
    intro entry hmem
    rcases List.mem_append.mp hmem with hmem | hmem
    · exact hacc entry hmem
    · simp only [List.mem_singleton] at hmem
      subst hmem
      exact hlook
  | case8 token tokens acc hopt ih =>
    intro parsed h hacc
    rw [walk_positional hopt] at h
    exact ih parsed h hacc

/-- The walk only appends positionals, and never an option token. -/
theorem walk_positionals : ∀ (tokens : List String) (acc parsed : Parsed),
    walk grammar command tokens acc = .ok parsed →
    ∃ more, parsed.positionals = acc.positionals ++ more ∧
      ∀ p ∈ more, isOptionToken p = false := by
  intro tokens acc
  induction tokens, acc using walk.induct grammar with
  | case1 acc =>
    intro parsed h
    rw [walk_nil, Except.ok.injEq] at h
    subst h
    exact ⟨[], by simp, by simp⟩
  | case2 token tokens acc hopt hlook =>
    intro parsed h
    simp [walk_unknown hopt hlook] at h
  | case3 token tokens acc hopt kind hlook hhas =>
    intro parsed h
    simp [walk_repeated hopt hlook hhas] at h
  | case4 token tokens acc hopt hhas hlook ih =>
    intro parsed h
    rw [walk_boolean hopt hhas hlook] at h
    exact ih parsed h
  | case5 token acc hopt hhas hlook =>
    intro parsed h
    simp [walk_value_missing hopt hhas hlook] at h
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro parsed h
    simp [walk_value_dash hopt hhas hstart hlook] at h
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro parsed h
    rw [walk_value hopt hhas hstart hlook] at h
    exact ih parsed h
  | case8 token tokens acc hopt ih =>
    intro parsed h
    rw [walk_positional hopt] at h
    obtain ⟨more, hmore, hopts⟩ := ih parsed h
    refine ⟨token :: more, by simp [hmore], ?_⟩
    intro p hp
    rcases List.mem_cons.mp hp with hp | hp
    · subst hp
      simpa using hopt
    · exact hopts p hp

/-- A walk that finished `before` continues on `after` from where it stopped. -/
theorem walk_append : ∀ (before : List String) (acc mid : Parsed) (after : List String),
    walk grammar command before acc = .ok mid →
    walk grammar command (before ++ after) acc = walk grammar command after mid := by
  intro before acc
  induction before, acc using walk.induct grammar with
  | case1 acc =>
    intro mid after h
    rw [walk_nil, Except.ok.injEq] at h
    subst h
    rfl
  | case2 token tokens acc hopt hlook =>
    intro mid after h
    simp [walk_unknown hopt hlook] at h
  | case3 token tokens acc hopt kind hlook hhas =>
    intro mid after h
    simp [walk_repeated hopt hlook hhas] at h
  | case4 token tokens acc hopt hhas hlook ih =>
    intro mid after h
    rw [walk_boolean hopt hhas hlook] at h
    rw [List.cons_append, walk_boolean hopt hhas hlook]
    exact ih mid after h
  | case5 token acc hopt hhas hlook =>
    intro mid after h
    simp [walk_value_missing hopt hhas hlook] at h
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro mid after h
    simp [walk_value_dash hopt hhas hstart hlook] at h
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro mid after h
    rw [walk_value hopt hhas hstart hlook] at h
    rw [List.cons_append, List.cons_append, walk_value hopt hhas hstart hlook]
    exact ih mid after h
  | case8 token tokens acc hopt ih =>
    intro mid after h
    rw [walk_positional hopt] at h
    rw [List.cons_append, walk_positional hopt]
    exact ih mid after h

end Walk

/-! ## `parseArguments` (args.ts:124-164) -/

/-- A successful `parseArguments` is a successful walk within the positional bounds. -/
theorem parseArguments_ok {tokens : List String} {grammar : Grammar} {command : String}
    {parsed : Parsed} (h : parseArguments tokens grammar command = .ok parsed) :
    walk grammar command tokens { flags := [], positionals := [] } = .ok parsed ∧
      parsed.positionals.length ≤ grammar.maxPositionals := by
  unfold parseArguments at h
  split at h
  · simp at h
  · rename_i result hwalk
    split at h
    · simp at h
    · simp only [Except.ok.injEq] at h
      subst h
      exact ⟨hwalk, by omega⟩

/-- (a) args.ts:4, 118: every token of the tail is consumed exactly once. -/
theorem consumesEveryTokenOnce : ConsumesEveryTokenOnce := by
  intro tokens grammar command parsed h
  simpa using walk_perm tokens _ parsed (parseArguments_ok h).1

/-- (b) args.ts:16: no flag is stored twice. -/
theorem noFlagTwice : NoFlagTwice := by
  intro tokens grammar command parsed h
  exact walk_nodup tokens _ parsed (parseArguments_ok h).1 List.nodup_nil

/-- (c) args.ts:15-17: every stored flag is declared by the grammar with the matching kind. -/
theorem flagsDeclared : FlagsDeclared := by
  intro tokens grammar command parsed h
  exact walk_declared tokens _ parsed (parseArguments_ok h).1 (by simp)

/-- (g) args.ts:159-161: a successful parse holds no more positionals than the grammar allows. -/
theorem positionalsWithinMax : PositionalsWithinMax := by
  intro tokens grammar command parsed h
  exact (parseArguments_ok h).2

/-! ## `Except` plumbing -/

theorem ok_bind {α β : Type} (a : α) (f : α → Except String β) :
    (Except.ok a >>= f) = f a := rfl

theorem error_bind {α β : Type} (e : String) (f : α → Except String β) :
    (Except.error e >>= f) = Except.error e := rfl

theorem bind_eq_ok {α β : Type} {m : Except String α} {f : α → Except String β} {b : β}
    (h : (m >>= f) = .ok b) : ∃ a, m = .ok a ∧ f a = .ok b := by
  cases m with
  | error e => simp [error_bind] at h
  | ok a => exact ⟨a, rfl, h⟩

theorem bind_eq_error {α β : Type} {m : Except String α} {f : α → Except String β}
    {e : String}
    (h : (m >>= f) = .error e) : m = .error e ∨ ∃ a, m = .ok a ∧ f a = .error e := by
  cases m with
  | error e' => exact Or.inl (by simpa [error_bind] using h)
  | ok a => exact Or.inr ⟨a, rfl, h⟩

/-! ## `parseCli` dispatch (args.ts:237-299) -/

/-- The `switch` of args.ts:255-298 as a chain of string comparisons, in the same order. -/
theorem parseCli_cons (command : String) (rest : List String) :
    parseCli (command :: rest) =
      if HELP_TOKENS.contains command then do
        assertNoExtraTokens rest "help"
        pure .help
      else if VERSION_TOKENS.contains command then do
        assertNoExtraTokens rest "version"
        pure .version
      else if command = "setup" then do
        let parsed ← parseArguments rest COMMAND_GRAMMAR.setup "setup"
        let profile ← readProfile parsed
        pure (.setup profile (parsed.has "--resume"))
      else if command = "doctor" then do
        let parsed ← parseArguments rest COMMAND_GRAMMAR.doctor "doctor"
        let profile ← readProfile parsed
        pure (.doctor profile (parsed.has "--json"))
      else if command = "status" then do
        let parsed ← parseArguments rest COMMAND_GRAMMAR.status "status"
        let profile ← readProfile parsed
        pure (.status profile (parsed.has "--json"))
      else if command = "service" then do
        let action ← readAction rest "service" SERVICE_ACTIONS
        let parsed ← parseArguments (rest.drop 1) COMMAND_GRAMMAR.service "service"
        let profile ← readProfile parsed
        pure (.service action profile)
      else if command = "profile" then do
        let action ← readAction rest "profile" PROFILE_ACTIONS
        let parsed ← parseArguments (rest.drop 1) COMMAND_GRAMMAR.profile "profile"
        let profile ← readProfile parsed
        pure (.profile action profile (parsed.has "--json"))
      else if command = "sessions" then do
        let action ← readAction rest "sessions" SESSIONS_ACTIONS
        let parsed ← parseArguments (rest.drop 1) (sessionsGrammar action) s!"sessions {action}"
        let profile ← readProfile parsed
        pure (.sessions action profile
          (normalizeSessionsArgv parsed (sessionsHandlerFlags action)))
      else .error (unknownCommandMessage command) := by
  by_cases hh : HELP_TOKENS.contains command = true
  · simp only [parseCli, hh, ↓reduceIte]
  by_cases hv : VERSION_TOKENS.contains command = true
  · simp only [parseCli, hh, hv, Bool.false_eq_true, ↓reduceIte]
  by_cases h1 : command = "setup"
  · subst h1; rfl
  by_cases h2 : command = "doctor"
  · subst h2; rfl
  by_cases h3 : command = "status"
  · subst h3; rfl
  by_cases h4 : command = "service"
  · subst h4; rfl
  by_cases h5 : command = "profile"
  · subst h5; rfl
  by_cases h6 : command = "sessions"
  · subst h6; rfl
  simp only [parseCli, hh, hv, h1, h2, h3, h4, h5, h6, Bool.false_eq_true, ↓reduceIte]

theorem contains_of_mem {a : String} {l : List String} (h : a ∈ l) : l.contains a = true := by
  simpa using h

/-- `readAction` accepts an allowed first token and leaves the rest to `parseArguments`. -/
theorem readAction_of_mem {action parent : String} {allowed tail : List String}
    (h : action ∈ allowed) : readAction (action :: tail) parent allowed = .ok action := by
  simp [readAction, h]

theorem parseCli_setup (rest : List String) :
    parseCli ("setup" :: rest) =
      (parseArguments rest COMMAND_GRAMMAR.setup "setup" >>= fun parsed =>
        readProfile parsed >>= fun profile => pure (.setup profile (parsed.has "--resume"))) := rfl

theorem parseCli_doctor (rest : List String) :
    parseCli ("doctor" :: rest) =
      (parseArguments rest COMMAND_GRAMMAR.doctor "doctor" >>= fun parsed =>
        readProfile parsed >>= fun profile => pure (.doctor profile (parsed.has "--json"))) := rfl

theorem parseCli_status (rest : List String) :
    parseCli ("status" :: rest) =
      (parseArguments rest COMMAND_GRAMMAR.status "status" >>= fun parsed =>
        readProfile parsed >>= fun profile => pure (.status profile (parsed.has "--json"))) := rfl

theorem parseCli_service {action : String} (h : action ∈ SERVICE_ACTIONS) (tail : List String) :
    parseCli ("service" :: action :: tail) =
      (parseArguments tail COMMAND_GRAMMAR.service "service" >>= fun parsed =>
        readProfile parsed >>= fun profile => pure (.service action profile)) := by
  simp only [SERVICE_ACTIONS, List.mem_cons, List.not_mem_nil, or_false] at h
  rcases h with rfl | rfl | rfl | rfl | rfl <;> rfl

theorem parseCli_profile {action : String} (h : action ∈ PROFILE_ACTIONS) (tail : List String) :
    parseCli ("profile" :: action :: tail) =
      (parseArguments tail COMMAND_GRAMMAR.profile "profile" >>= fun parsed =>
        readProfile parsed >>= fun profile =>
          pure (.profile action profile (parsed.has "--json"))) := by
  simp only [PROFILE_ACTIONS, List.mem_cons, List.not_mem_nil, or_false] at h
  rcases h with rfl | rfl | rfl <;> rfl

theorem parseCli_sessions_list (tail : List String) :
    parseCli ("sessions" :: "list" :: tail) =
      (parseArguments tail (sessionsGrammar "list") "sessions list" >>= fun parsed =>
        readProfile parsed >>= fun profile =>
          pure (.sessions "list" profile (normalizeSessionsArgv parsed SESSIONS_LIST_FLAGS))) := rfl

theorem parseCli_sessions_show (tail : List String) :
    parseCli ("sessions" :: "show" :: tail) =
      (parseArguments tail (sessionsGrammar "show") "sessions show" >>= fun parsed =>
        readProfile parsed >>= fun profile =>
          pure (.sessions "show" profile (normalizeSessionsArgv parsed SESSIONS_SHOW_FLAGS))) := rfl

/-! ## (d) `--profile` is a value flag everywhere -/

theorem lookup_none_of_not_any {table : FlagTable} {k : String}
    (h : ¬table.any (fun e => e.1 == k) = true) : table.lookup k = none := by
  rw [lookup_eq_none_iff]
  intro hk
  obtain ⟨e, he, rfl⟩ := List.mem_map.mp hk
  exact h (List.any_eq_true.mpr ⟨e, he, by simp⟩)

theorem lookup_map_replace {k : String} {v : FlagKind} :
    ∀ {table : FlagTable}, table.any (fun e => e.1 == k) = true →
      (table.map (fun e => if e.1 == k then (k, v) else e)).lookup k = some v
  | [], h => by simp at h
  | (k', v') :: rest, h => by
    by_cases hk : k' = k
    · subst hk
      simp
    · have hrest : rest.any (fun e => e.1 == k) = true := by simpa [hk] using h
      simp only [List.map_cons, beq_false_of_ne hk, Bool.false_eq_true, ↓reduceIte,
        List.lookup_cons, beq_false_of_ne (Ne.symm hk)]
      exact lookup_map_replace hrest

/-- Defining a property on an object literal makes it read back as the defined value. -/
theorem lookup_defineEntry_self (table : FlagTable) (k : String) (v : FlagKind) :
    (defineEntry table (k, v)).lookup k = some v := by
  unfold defineEntry
  split
  · exact lookup_map_replace (by assumption)
  · rename_i h
    rw [List.lookup_append, lookup_none_of_not_any h]
    simp [List.lookup]

/-- (d) args.ts:283: spread last, `PROFILE_ONLY` makes `--profile` a value flag whatever the
handler's table says. -/
theorem profileSpreadLastWins : ProfileSpreadLastWins := by
  intro handlerFlags
  unfold spread PROFILE_ONLY
  exact lookup_defineEntry_self _ _ _

/-- (d) args.ts:75, 278: `--profile` is a value flag in every grammar `parseCli` uses. -/
theorem profileIsValueFlag : ProfileIsValueFlag := by
  unfold ProfileIsValueFlag
  decide

theorem sessionsGrammar_profile (action : String) :
    (sessionsGrammar action).flags.lookup PROFILE_FLAG = some .value :=
  profileSpreadLastWins (sessionsHandlerFlags action)

/-- After a parse against a grammar where `--profile` is a value flag, `--profile` is never
stored as `true`. -/
theorem get_profile_ne_present {tokens : List String} {grammar : Grammar} {command : String}
    {parsed : Parsed} (hg : grammar.flags.lookup PROFILE_FLAG = some .value)
    (h : parseArguments tokens grammar command = .ok parsed) :
    parsed.get PROFILE_FLAG ≠ some .present := by
  intro hp
  have := flagsDeclared tokens grammar command parsed h _ (mem_of_lookup_eq_some hp)
  simp [hg, FlagValue.kind] at this

/-! ## (h) `help` and `version` stand alone -/

/-- (h) args.ts:234-235, 247, 251: each help and version spelling parses alone, and any extra
token is refused by name. -/
theorem helpVersionStandAlone : HelpVersionStandAlone := by
  refine ⟨?_, ?_⟩
  · intro token htoken
    simp only [HELP_TOKENS, List.mem_cons, List.not_mem_nil, or_false] at htoken
    rcases htoken with rfl | rfl | rfl <;> exact ⟨rfl, fun _ _ => rfl⟩
  · intro token htoken
    simp only [VERSION_TOKENS, List.mem_cons, List.not_mem_nil, or_false] at htoken
    rcases htoken with rfl | rfl | rfl <;> exact ⟨rfl, fun _ _ => rfl⟩

/-! ## (g) Stray positionals are refused -/

/-- A non-option token where an option could start ends in a failed parse when the grammar
takes no positional. -/
theorem parseArguments_stray {grammar : Grammar} {command : String}
    {before after : List String} {stray : String} {done : Parsed}
    (hmax : grammar.maxPositionals = 0)
    (hdone : walk grammar command before { flags := [], positionals := [] } = .ok done)
    (hstray : isOptionToken stray = false) :
    ∀ parsed, parseArguments (before ++ stray :: after) grammar command ≠ .ok parsed := by
  intro parsed h
  obtain ⟨hwalk, hle⟩ := parseArguments_ok h
  rw [walk_append _ _ _ _ hdone, walk_positional (by simp [hstray])] at hwalk
  obtain ⟨more, hmore, _⟩ := walk_positionals _ _ _ hwalk
  rw [hmore, hmax] at hle
  simp at hle

/-- A successful `parseCli` on a zero-positional head went through a successful
`parseArguments` on the tail. -/
theorem parseArguments_ok_of_parseCli {head : List String × Grammar × String}
    (hhead : head ∈ zeroPositionalHeads) {tail : List String} {result : CliCommand}
    (h : parseCli (head.1 ++ tail) = .ok result) :
    ∃ parsed, parseArguments tail head.2.1 head.2.2 = .ok parsed := by
  simp only [zeroPositionalHeads, List.mem_append, List.mem_cons, List.mem_map,
    List.not_mem_nil, or_false] at hhead
  rcases hhead with
    (((rfl | rfl | rfl) | ⟨action, haction, rfl⟩) | ⟨action, haction, rfl⟩) | rfl
  · obtain ⟨parsed, hp, _⟩ := bind_eq_ok (by simpa [parseCli_setup] using h)
    exact ⟨parsed, hp⟩
  · obtain ⟨parsed, hp, _⟩ := bind_eq_ok (by simpa [parseCli_doctor] using h)
    exact ⟨parsed, hp⟩
  · obtain ⟨parsed, hp, _⟩ := bind_eq_ok (by simpa [parseCli_status] using h)
    exact ⟨parsed, hp⟩
  · obtain ⟨parsed, hp, _⟩ := bind_eq_ok (by simpa [parseCli_service haction] using h)
    exact ⟨parsed, hp⟩
  · obtain ⟨parsed, hp, _⟩ := bind_eq_ok (by simpa [parseCli_profile haction] using h)
    exact ⟨parsed, hp⟩
  · obtain ⟨parsed, hp, _⟩ := bind_eq_ok (by simpa [parseCli_sessions_list] using h)
    exact ⟨parsed, hp⟩

/-- (g) args.ts:17: for every command that takes no positional, a stray positional makes
`parseCli` fail, wherever it stands after a complete prefix. -/
theorem strayPositionalRejected : StrayPositionalRejected := by
  intro head hhead before stray after done result hdone hstray hresult
  obtain ⟨parsed, hp⟩ := parseArguments_ok_of_parseCli hhead (tail := before ++ stray :: after)
    (by simpa [List.append_assoc] using hresult)
  have hmax : head.2.1.maxPositionals = 0 := by
    simp only [zeroPositionalHeads, List.mem_append, List.mem_cons, List.mem_map,
      List.not_mem_nil, or_false] at hhead
    rcases hhead with
      (((rfl | rfl | rfl) | ⟨action, _, rfl⟩) | ⟨action, _, rfl⟩) | rfl <;> rfl
  exact parseArguments_stray hmax hdone hstray parsed hp

/-! ## (e) The sessions tail is a re-ordering -/

/-- The entries of `flags` stored under `keys`, in `keys` order: what `normalizeSessionsArgv`
emits after the positionals. -/
def select (flags : List (String × FlagValue)) (keys : List String) : List (String × FlagValue) :=
  keys.filterMap fun k => (flags.lookup k).map (k, ·)

theorem filterMap_congr' {α β : Type} {f g : α → Option β} :
    ∀ {l : List α}, (∀ a ∈ l, f a = g a) → l.filterMap f = l.filterMap g
  | [], _ => rfl
  | a :: l, h => by
    rw [List.filterMap_cons, List.filterMap_cons, h a List.mem_cons_self,
      filterMap_congr' (fun b hb => h b (List.mem_cons_of_mem _ hb))]

theorem select_append (flags : List (String × FlagValue)) (ks₁ ks₂ : List String) :
    select flags (ks₁ ++ ks₂) = select flags ks₁ ++ select flags ks₂ := by
  simp [select, List.filterMap_append]

theorem flagTokens_perm {l₁ l₂ : List (String × FlagValue)} (h : l₁.Perm l₂) :
    (flagTokens l₁).Perm (flagTokens l₂) :=
  h.flatMap_right _

/-- `normalizeSessionsArgv` (args.ts:201-212) is the positionals, then the flag tokens of the
handler's keys in table order. -/
theorem normalize_eq (parsed : Parsed) (handlerFlags : FlagTable) :
    normalizeSessionsArgv parsed handlerFlags =
      parsed.positionals ++ flagTokens (select parsed.flags (handlerFlags.map (·.1))) := by
  unfold normalizeSessionsArgv
  generalize handlerFlags.map (·.1) = keys
  generalize parsed.positionals = acc
  induction keys generalizing acc with
  | nil => simp [select]
  | cons k ks ih =>
    rw [List.foldl_cons, ih]
    simp only [select, List.filterMap_cons, Parsed.get]
    cases h : parsed.flags.lookup k with
    | none => simp
    | some v => cases v <;> simp [flagTokens, entryTokens, List.append_assoc]

theorem mem_select {flags : List (String × FlagValue)} {keys : List String}
    {e : String × FlagValue} :
    e ∈ select flags keys ↔ e.1 ∈ keys ∧ flags.lookup e.1 = some e.2 := by
  unfold select
  rw [List.mem_filterMap]
  constructor
  · rintro ⟨k, hk, hmap⟩
    rw [Option.map_eq_some_iff] at hmap
    obtain ⟨v, hv, rfl⟩ := hmap
    exact ⟨hk, hv⟩
  · rintro ⟨hk, hv⟩
    exact ⟨e.1, hk, by rw [hv]; rfl⟩

theorem select_nodup {flags : List (String × FlagValue)} {keys : List String}
    (hkeys : keys.Nodup) :
    (select flags keys).Nodup := by
  unfold select
  refine List.Pairwise.filterMap _ ?_ hkeys
  intro a a' hne b hb b' hb' heq
  rw [Option.map_eq_some_iff] at hb hb'
  obtain ⟨v, _, rfl⟩ := hb
  obtain ⟨v', _, rfl⟩ := hb'
  exact hne (congrArg Prod.fst heq)

/-- With distinct keys covering every stored flag, `select` is a re-ordering of the flags. -/
theorem select_perm {flags : List (String × FlagValue)} {keys : List String}
    (hkeys : keys.Nodup) (hflags : (flags.map (·.1)).Nodup)
    (hsub : ∀ e ∈ flags, e.1 ∈ keys) :
    (select flags keys).Perm flags := by
  rw [List.perm_ext_iff_of_nodup (select_nodup hkeys) (nodup_of_nodup_keys hflags)]
  intro e
  rw [mem_select]
  constructor
  · rintro ⟨_, hv⟩
    exact mem_of_lookup_eq_some hv
  · intro he
    exact ⟨hsub e he, lookup_eq_some_of_mem hflags he⟩

theorem mem_keys_of_lookup_eq_some {β : Type} {l : List (String × β)} {k : String} {v : β}
    (h : l.lookup k = some v) : k ∈ l.map (·.1) :=
  List.mem_map.mpr ⟨(k, v), mem_of_lookup_eq_some h, rfl⟩

theorem lookup_filter_ne {β : Type} {P k : String} (hk : k ≠ P) :
    ∀ (l : List (String × β)), (l.filter (fun e => e.1 != P)).lookup k = l.lookup k
  | [] => rfl
  | (k', v) :: rest => by
    by_cases h : k' = P
    · subst h
      simp [lookup_filter_ne hk rest, List.lookup_cons, beq_false_of_ne hk]
    · simp [h, List.lookup_cons, lookup_filter_ne hk rest]

theorem select_filter_ne {l : List (String × FlagValue)} {P : String} {keys : List String}
    (h : P ∉ keys) : select (l.filter (fun e => e.1 != P)) keys = select l keys := by
  unfold select
  apply filterMap_congr'
  intro k hk
  rw [lookup_filter_ne]
  intro heq
  subst heq
  exact h hk

theorem sessionsGrammar_flags (action : String) :
    (sessionsGrammar action).flags = sessionsHandlerFlags action ++ PROFILE_ONLY := by
  by_cases h : action = "list"
  · simp only [sessionsGrammar, sessionsHandlerFlags, h, ↓reduceIte]
    decide
  · simp only [sessionsGrammar, sessionsHandlerFlags, h, ↓reduceIte]
    decide

theorem handlerKeys_nodup (action : String) : ((sessionsHandlerFlags action).map (·.1)).Nodup := by
  unfold sessionsHandlerFlags
  split <;> decide

theorem profile_not_handlerKey (action : String) :
    PROFILE_FLAG ∉ (sessionsHandlerFlags action).map (·.1) := by
  unfold sessionsHandlerFlags
  split <;> decide

/-- Every stored flag other than `--profile` is one of the handler's keys. -/
theorem sessions_flag_is_handlerKey {action : String} {tail : List String} {command : String}
    {parsed : Parsed} (h : parseArguments tail (sessionsGrammar action) command = .ok parsed) :
    ∀ e ∈ parsed.flags, e.1 ≠ PROFILE_FLAG →
      e.1 ∈ (sessionsHandlerFlags action).map (·.1) := by
  intro e he hne
  have hdecl := flagsDeclared tail _ command parsed h e he
  rw [sessionsGrammar_flags, List.lookup_append] at hdecl
  have hprof : PROFILE_ONLY.lookup e.1 = none := by
    simp [PROFILE_ONLY, List.lookup, beq_false_of_ne hne]
  rw [hprof] at hdecl
  cases hl : (sessionsHandlerFlags action).lookup e.1 with
  | none => simp [hl] at hdecl
  | some kind => exact mem_keys_of_lookup_eq_some hl

/-- (e) args.ts:197-199, 202: the handler's tail is the positionals, then a re-ordering of the
parsed flags without `--profile`, each flag next to its own value. -/
theorem sessionsTailReordered : SessionsTailReordered := by
  intro action tail command parsed h
  refine ⟨select parsed.flags ((sessionsHandlerFlags action).map (·.1)), ?_, normalize_eq _ _⟩
  rw [← select_filter_ne (profile_not_handlerKey action)]
  apply select_perm (handlerKeys_nodup action)
  · exact (noFlagTwice tail _ command parsed h).sublist (List.filter_sublist.map _)
  · intro e he
    rw [List.mem_filter] at he
    exact sessions_flag_is_handlerKey h e he.1 (by simpa using he.2)

section Remove

variable {grammar : Grammar} {command P : String}

/-- Once `P` is stored, every flag stored later has another key (a repeat is refused), so the
stored flags without `P` account for the remaining tokens as they are. -/
theorem walk_perm_after :
    ∀ (tokens : List String) (acc parsed : Parsed),
      walk grammar command tokens acc = .ok parsed →
      acc.has P = true →
      (parsed.positionals ++ flagTokens (parsed.flags.filter (fun e => e.1 != P))).Perm
        (acc.positionals ++ flagTokens (acc.flags.filter (fun e => e.1 != P)) ++ tokens) := by
  intro tokens acc
  induction tokens, acc using walk.induct grammar with
  | case1 acc =>
    intro parsed h _
    rw [walk_nil, Except.ok.injEq] at h
    subst h
    simp
  | case2 token tokens acc hopt hlook =>
    intro parsed h
    simp [walk_unknown hopt hlook] at h
  | case3 token tokens acc hopt kind hlook hhas =>
    intro parsed h
    simp [walk_repeated hopt hlook hhas] at h
  | case4 token tokens acc hopt hhas hlook ih =>
    intro parsed h hP
    rw [walk_boolean hopt hhas hlook] at h
    have hne : token ≠ P := by
      intro heq
      subst heq
      exact hhas hP
    have ih' := ih parsed h (by rw [has_append_ne hne]; exact hP)
    refine ih'.trans ?_
    simp [List.filter_append, flagTokens_append, hne, List.append_assoc]
  | case5 token acc hopt hhas hlook =>
    intro parsed h
    simp [walk_value_missing hopt hhas hlook] at h
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro parsed h
    simp [walk_value_dash hopt hhas hstart hlook] at h
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro parsed h hP
    rw [walk_value hopt hhas hstart hlook] at h
    have hne : token ≠ P := by
      intro heq
      subst heq
      exact hhas hP
    have ih' := ih parsed h (by rw [has_append_ne hne]; exact hP)
    refine ih'.trans ?_
    simp [List.filter_append, flagTokens_append, hne, List.append_assoc]
  | case8 token tokens acc hopt ih =>
    intro parsed h hP
    rw [walk_positional hopt] at h
    refine (ih parsed h hP).trans ?_
    simp only [List.append_assoc, List.singleton_append]
    exact List.Perm.append_left _ List.perm_middle.symm

/-- Before `P` is stored, the walk accounts for the tokens with the `P <value>` pair taken out. -/
theorem walk_perm_before (hPopt : isOptionToken P = true) (hPdash : jsStartsWith P "--" = true)
    (hkind : grammar.flags.lookup P = some .value) :
    ∀ (tokens : List String) (acc parsed : Parsed),
      walk grammar command tokens acc = .ok parsed →
      ¬acc.has P = true →
      (parsed.positionals ++ flagTokens (parsed.flags.filter (fun e => e.1 != P))).Perm
        (acc.positionals ++ flagTokens (acc.flags.filter (fun e => e.1 != P)) ++
          removeFlagPair P tokens) := by
  intro tokens acc
  induction tokens, acc using walk.induct grammar with
  | case1 acc =>
    intro parsed h _
    rw [walk_nil, Except.ok.injEq] at h
    subst h
    simp [removeFlagPair]
  | case2 token tokens acc hopt hlook =>
    intro parsed h
    simp [walk_unknown hopt hlook] at h
  | case3 token tokens acc hopt kind hlook hhas =>
    intro parsed h
    simp [walk_repeated hopt hlook hhas] at h
  | case4 token tokens acc hopt hhas hlook ih =>
    intro parsed h hP
    rw [walk_boolean hopt hhas hlook] at h
    have hne : token ≠ P := by
      intro heq
      subst heq
      rw [hkind] at hlook
      cases hlook
    have ih' := ih parsed h (by rw [has_append_ne hne]; exact hP)
    refine ih'.trans ?_
    simp [List.filter_append, flagTokens_append, hne, removeFlagPair, List.append_assoc]
  | case5 token acc hopt hhas hlook =>
    intro parsed h
    simp [walk_value_missing hopt hhas hlook] at h
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro parsed h
    simp [walk_value_dash hopt hhas hstart hlook] at h
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro parsed h hP
    rw [walk_value hopt hhas hstart hlook] at h
    by_cases heq : token = P
    · subst heq
      have after := walk_perm_after tokens' _ parsed h has_append_self
      refine after.trans ?_
      simp [List.filter_append, removeFlagPair]
    · have hvalue : value ≠ P := by
        intro hv
        subst hv
        exact hstart hPdash
      have ih' := ih parsed h (by rw [has_append_ne heq]; exact hP)
      refine ih'.trans ?_
      simp [List.filter_append, flagTokens_append, heq, hvalue, removeFlagPair, List.append_assoc]
  | case8 token tokens acc hopt ih =>
    intro parsed h hP
    rw [walk_positional hopt] at h
    have hne : token ≠ P := by
      intro heq
      subst heq
      exact hopt hPopt
    refine (ih parsed h hP).trans ?_
    simp only [removeFlagPair, hne, ↓reduceIte, List.append_assoc, List.singleton_append]
    exact List.Perm.append_left _ List.perm_middle.symm

end Remove

/-- (e) args.ts:197-198: the handler receives a permutation of the typed tail with the
`--profile <value>` pair taken out. -/
theorem sessionsTailIsTailWithoutProfile : SessionsTailIsTailWithoutProfile := by
  intro action tail command parsed h
  obtain ⟨entries, hperm, heq⟩ := sessionsTailReordered action tail command parsed h
  rw [heq]
  have hwalk := (parseArguments_ok h).1
  have hbefore := walk_perm_before (P := PROFILE_FLAG) (by decide) (by decide)
    (sessionsGrammar_profile action) tail _ parsed hwalk (by simp [Parsed.has, List.lookup])
  simp only [List.filter_nil, flagTokens_nil, List.append_nil, List.nil_append] at hbefore
  exact (List.Perm.append_left _ (flagTokens_perm hperm)).trans hbefore

/-! ## (f) The session key is `args[0]` -/

/-- A flag the grammar declares boolean is stored as `true`. -/
theorem stored_present_of_boolean {tokens : List String} {grammar : Grammar} {command : String}
    {parsed : Parsed} (h : parseArguments tokens grammar command = .ok parsed)
    {flag : String} {value : FlagValue} (hmem : (flag, value) ∈ parsed.flags)
    (hkind : grammar.flags.lookup flag = some .boolean) : value = .present := by
  have hdecl := flagsDeclared tokens grammar command parsed h _ hmem
  rw [hkind] at hdecl
  cases value with
  | present => rfl
  | str s => simp [FlagValue.kind] at hdecl

/-- (f) args.ts:190-195, 202-203: for `sessions show`, the handler's `args[0]` is the session key
when one was given, and a flag (so, for the handler, no key) when none was. -/
theorem sessionsShowKeyFirst : SessionsShowKeyFirst := by
  intro tail profile rest h
  rw [parseCli_sessions_show] at h
  obtain ⟨parsed, hp, h2⟩ := bind_eq_ok h
  obtain ⟨p, _, h3⟩ := bind_eq_ok h2
  have hrest : rest = normalizeSessionsArgv parsed SESSIONS_SHOW_FLAGS := by
    have h3' : CliCommand.sessions "show" p (normalizeSessionsArgv parsed SESSIONS_SHOW_FLAGS) =
        .sessions "show" profile rest := by
      simpa [pure, Except.pure] using h3
    injection h3' with _ _ h3''
    exact h3''.symm
  refine ⟨parsed, hp, hrest, ?_⟩
  have hflags : ∀ token ∈ flagTokens (select parsed.flags (SESSIONS_SHOW_FLAGS.map (·.1))),
      jsStartsWith token "--" = true := by
    intro token htoken
    simp only [flagTokens, List.mem_flatMap] at htoken
    obtain ⟨⟨k, v⟩, he, htok⟩ := htoken
    rw [mem_select] at he
    obtain ⟨hkey, hv⟩ := he
    have hbool : (sessionsGrammar "show").flags.lookup k = some .boolean := by
      simp only [SESSIONS_SHOW_FLAGS, List.map_cons, List.map_nil, List.mem_cons,
        List.not_mem_nil, or_false] at hkey
      rcases hkey with rfl | rfl <;> decide
    have hpresent := stored_present_of_boolean hp (mem_of_lookup_eq_some hv) hbool
    subst hpresent
    simp only [entryTokens, List.mem_singleton] at htok
    subst htok
    simp only [SESSIONS_SHOW_FLAGS, List.map_cons, List.map_nil, List.mem_cons,
      List.not_mem_nil, or_false] at hkey
    rcases hkey with rfl | rfl <;> decide
  have hle := (parseArguments_ok hp).2
  have hmax : (sessionsGrammar "show").maxPositionals = 1 := by decide
  obtain ⟨more, hmore, hopts⟩ := walk_positionals tail _ parsed (parseArguments_ok hp).1
  simp only [List.nil_append] at hmore
  rw [hrest, normalize_eq]
  match hpos : parsed.positionals with
  | [] =>
    left
    exact ⟨rfl, fun token htoken => hflags token (by simpa using htoken)⟩
  | [key] =>
    right
    refine ⟨key, _, rfl, rfl, ?_, hflags⟩
    rw [hmore] at hpos
    exact hopts key (by simp [hpos])
  | _ :: _ :: _ =>
    rw [hpos, hmax] at hle
    simp at hle

/-! ## (i) Messages name the offending token and nothing else -/

/-- Each error the walk throws names one token it read, and that token is the offender. -/
theorem walk_error {grammar : Grammar} {command : String} :
    ∀ (tokens : List String) (acc : Parsed) (message : String),
      walk grammar command tokens acc = .error message →
      ∃ token ∈ tokens,
        (isOptionToken token = true ∧ grammar.flags.lookup token = none ∧
          message = unknownOptionMessage token grammar command) ∨
        (grammar.flags.lookup token ≠ none ∧ message = repeatedOptionMessage token) ∨
        (grammar.flags.lookup token = some .value ∧ message = requiresValueMessage token) := by
  intro tokens acc
  induction tokens, acc using walk.induct grammar with
  | case1 acc =>
    intro message h
    rw [walk_nil] at h
    cases h
  | case2 token tokens acc hopt hlook =>
    intro message h
    rw [walk_unknown hopt hlook, Except.error.injEq] at h
    exact ⟨token, List.mem_cons_self, Or.inl ⟨hopt, hlook, h.symm⟩⟩
  | case3 token tokens acc hopt kind hlook hhas =>
    intro message h
    rw [walk_repeated hopt hlook hhas, Except.error.injEq] at h
    exact ⟨token, List.mem_cons_self, Or.inr (Or.inl ⟨by simp [hlook], h.symm⟩)⟩
  | case4 token tokens acc hopt hhas hlook ih =>
    intro message h
    rw [walk_boolean hopt hhas hlook] at h
    obtain ⟨t, ht, hcase⟩ := ih message h
    exact ⟨t, List.mem_cons_of_mem _ ht, hcase⟩
  | case5 token acc hopt hhas hlook =>
    intro message h
    rw [walk_value_missing hopt hhas hlook, Except.error.injEq] at h
    exact ⟨token, List.mem_cons_self, Or.inr (Or.inr ⟨hlook, h.symm⟩)⟩
  | case6 token acc hopt hhas value tokens' hstart hlook =>
    intro message h
    rw [walk_value_dash hopt hhas hstart hlook, Except.error.injEq] at h
    exact ⟨token, List.mem_cons_self, Or.inr (Or.inr ⟨hlook, h.symm⟩)⟩
  | case7 token acc hopt hhas value tokens' hstart hlook ih =>
    intro message h
    rw [walk_value hopt hhas hstart hlook] at h
    obtain ⟨t, ht, hcase⟩ := ih message h
    exact ⟨t, List.mem_cons_of_mem _ (List.mem_cons_of_mem _ ht), hcase⟩
  | case8 token tokens acc hopt ih =>
    intro message h
    rw [walk_positional hopt] at h
    obtain ⟨t, ht, hcase⟩ := ih message h
    exact ⟨t, List.mem_cons_of_mem _ ht, hcase⟩

/-- The positional args.ts:160 names is a non-option token of the tail. -/
theorem unexpected_token {tokens : List String} {grammar : Grammar} {command : String}
    {parsed : Parsed}
    (hwalk : walk grammar command tokens { flags := [], positionals := [] } = .ok parsed)
    (hgt : parsed.positionals.length > grammar.maxPositionals) :
    parsed.positionals.getD grammar.maxPositionals "" ∈ tokens ∧
      isOptionToken (parsed.positionals.getD grammar.maxPositionals "") = false := by
  have hmem := getD_mem (d := "") hgt
  constructor
  · have hperm := walk_perm tokens _ parsed hwalk
    simp only [List.nil_append, flagTokens_nil, List.append_nil] at hperm
    exact hperm.mem_iff.mp (List.mem_append_left _ hmem)
  · obtain ⟨more, hmore, hopts⟩ := walk_positionals tokens _ parsed hwalk
    simp only [List.nil_append] at hmore
    exact hopts _ (hmore ▸ hmem)

/-- Every `parseArguments` error names one offending token of the tail. -/
theorem parseArguments_error {tokens : List String} {grammar : Grammar} {command message : String}
    (h : parseArguments tokens grammar command = .error message) :
    ∃ token ∈ tokens,
      (isOptionToken token = true ∧ grammar.flags.lookup token = none ∧
        message = unknownOptionMessage token grammar command) ∨
      (grammar.flags.lookup token ≠ none ∧ message = repeatedOptionMessage token) ∨
      (grammar.flags.lookup token = some .value ∧ message = requiresValueMessage token) ∨
      (isOptionToken token = false ∧ message = unexpectedArgumentMessage token command) := by
  unfold parseArguments at h
  split at h
  · rename_i msg hwalk
    rw [Except.error.injEq] at h
    subst h
    obtain ⟨token, htoken, hcase⟩ := walk_error tokens _ msg hwalk
    refine ⟨token, htoken, ?_⟩
    rcases hcase with hc | hc | hc
    · exact Or.inl hc
    · exact Or.inr (Or.inl hc)
    · exact Or.inr (Or.inr (Or.inl hc))
  · rename_i parsed hwalk
    split at h
    · rename_i hgt
      rw [Except.error.injEq] at h
      subst h
      obtain ⟨hmem, hopt⟩ := unexpected_token hwalk hgt
      exact ⟨_, hmem, Or.inr (Or.inr (Or.inr ⟨hopt, rfl⟩))⟩
    · cases h

/-- (i) args.ts:120-122: each `parseArguments` error names one token of the tail, the offender. -/
theorem parseErrorNamesOffender : ParseErrorNamesOffender := by
  intro tokens grammar command message h
  exact parseArguments_error h

theorem parse_error_in_cliErrors {tokens : List String} {grammar : Grammar} {label message : String}
    (hlabeled : (grammar, label) ∈ labeledGrammars)
    (h : parseArguments tokens grammar label = .error message) :
    ∃ token ∈ tokens, message ∈ cliErrorsNaming token := by
  obtain ⟨token, htoken, hcase⟩ := parseArguments_error h
  refine ⟨token, htoken, ?_⟩
  simp only [cliErrorsNaming, List.mem_append, List.mem_flatMap]
  right
  refine ⟨(grammar, label), hlabeled, ?_⟩
  rcases hcase with ⟨_, _, rfl⟩ | ⟨_, rfl⟩ | ⟨_, rfl⟩ | ⟨_, rfl⟩ <;> simp

theorem readProfile_error_in_cliErrors {tokens : List String} {grammar : Grammar}
    {command message : String} {parsed : Parsed}
    (hp : parseArguments tokens grammar command = .ok parsed)
    (h : readProfile parsed = .error message) :
    ∃ token ∈ tokens, message ∈ cliErrorsNaming token := by
  unfold readProfile at h
  cases hv : parsed.get PROFILE_FLAG with
  | none =>
    rw [hv] at h
    cases h
  | some value =>
    cases value with
    | present =>
      rw [hv] at h
      cases h
    | str value =>
      rw [hv] at h
      simp only at h
      split at h
      · rw [Except.error.injEq] at h
        subst h
        refine ⟨value, ?_, by simp [cliErrorsNaming]⟩
        have hperm := consumesEveryTokenOnce tokens grammar command parsed hp
        refine hperm.mem_iff.mp (List.mem_append_right _ ?_)
        simp only [flagTokens, List.mem_flatMap]
        exact ⟨_, mem_of_lookup_eq_some hv, by simp [entryTokens]⟩
      · cases h

theorem readAction_ok {rest : List String} {parent action : String} {allowed : List String}
    (h : readAction rest parent allowed = .ok action) :
    action ∈ allowed ∧ rest.head? = some action := by
  unfold readAction at h
  cases hr : rest.head? with
  | none =>
    rw [hr] at h
    cases h
  | some first =>
    rw [hr] at h
    simp only at h
    split at h
    · cases h
    · rename_i hc
      rw [Except.ok.injEq] at h
      subst h
      exact ⟨by simpa using hc, rfl⟩

theorem readAction_error {rest : List String} {parent message : String} {allowed : List String}
    (h : readAction rest parent allowed = .error message) :
    message = missingActionMessage parent allowed ∨
      ∃ first, rest.head? = some first ∧
        message = unknownActionMessage parent first allowed := by
  unfold readAction at h
  cases hr : rest.head? with
  | none =>
    rw [hr, Except.error.injEq] at h
    exact Or.inl h.symm
  | some first =>
    rw [hr] at h
    simp only at h
    split at h
    · rw [Except.error.injEq] at h
      exact Or.inr ⟨first, rfl, h.symm⟩
    · cases h

theorem mem_of_head? {α : Type} {l : List α} {a : α} (h : l.head? = some a) : a ∈ l := by
  cases l with
  | nil => cases h
  | cons b rest =>
    simp only [List.head?_cons, Option.some.injEq] at h
    subst h
    exact List.mem_cons_self

/-- The error branches of a command that reads an action, then parses the rest of the tail. -/
theorem action_command_error {command : String} {rest : List String} {parent label message : String}
    {allowed : List String} {grammar : String → Grammar}
    {mk : String → Option String → Parsed → CliCommand}
    (hlabeled : ∀ action ∈ allowed, (grammar action, label) ∈ labeledGrammars)
    (hmissing : missingActionMessage parent allowed ∈ cliErrorsNamingNothing)
    (hunknown : ∀ first, unknownActionMessage parent first allowed ∈ cliErrorsNaming first)
    (h : (readAction rest parent allowed >>= fun action =>
        parseArguments (rest.drop 1) (grammar action) label >>= fun parsed =>
          readProfile parsed >>= fun profile => pure (mk action profile parsed)) = .error message) :
    message ∈ cliErrorsNamingNothing ∨
      ∃ token ∈ command :: rest, message ∈ cliErrorsNaming token := by
  rcases bind_eq_error h with h | ⟨action, ha, h⟩
  · rcases readAction_error h with rfl | ⟨first, hfirst, rfl⟩
    · exact Or.inl hmissing
    · exact Or.inr ⟨first, List.mem_cons_of_mem _ (mem_of_head? hfirst), hunknown first⟩
  · obtain ⟨hmem, _⟩ := readAction_ok ha
    right
    rcases bind_eq_error h with h | ⟨parsed, hp, h⟩
    · obtain ⟨token, htoken, hmsg⟩ := parse_error_in_cliErrors (hlabeled action hmem) h
      exact ⟨token, List.mem_cons_of_mem _ (List.mem_of_mem_drop htoken), hmsg⟩
    · rcases bind_eq_error h with h | ⟨_, _, h⟩
      · obtain ⟨token, htoken, hmsg⟩ := readProfile_error_in_cliErrors hp h
        exact ⟨token, List.mem_cons_of_mem _ (List.mem_of_mem_drop htoken), hmsg⟩
      · cases h

/-- The error branches of a command that parses its whole tail. -/
theorem plain_command_error {command : String} {rest : List String} {label message : String}
    {grammar : Grammar} {mk : Option String → Parsed → CliCommand}
    (hl : (grammar, label) ∈ labeledGrammars)
    (h : (parseArguments rest grammar label >>= fun parsed =>
          readProfile parsed >>= fun profile => pure (mk profile parsed)) = .error message) :
    ∃ token ∈ command :: rest, message ∈ cliErrorsNaming token := by
  rcases bind_eq_error h with h | ⟨parsed, hp, h⟩
  · obtain ⟨token, htoken, hmsg⟩ := parse_error_in_cliErrors hl h
    exact ⟨token, List.mem_cons_of_mem _ htoken, hmsg⟩
  · rcases bind_eq_error h with h | ⟨_, _, h⟩
    · obtain ⟨token, htoken, hmsg⟩ := readProfile_error_in_cliErrors hp h
      exact ⟨token, List.mem_cons_of_mem _ htoken, hmsg⟩
    · cases h

/-- `help` / `version` with extra tokens name the first extra one. -/
theorem stand_alone_error {command : String} {rest : List String} {label message : String}
    {result : CliCommand}
    (hlabel : ∀ first, unexpectedArgumentMessage first label ∈ cliErrorsNaming first)
    (h : (assertNoExtraTokens rest label >>= fun _ => pure result) = .error message) :
    ∃ token ∈ command :: rest, message ∈ cliErrorsNaming token := by
  rcases bind_eq_error h with h | ⟨_, _, h⟩
  · cases rest with
    | nil => cases h
    | cons first more =>
      simp only [assertNoExtraTokens, Except.error.injEq] at h
      subst h
      exact ⟨first, by simp, hlabel first⟩
  · cases h

/-- (i) args.ts:17-18: every `parseCli` error repeats at most one argv token. -/
theorem cliErrorNamesOneToken : CliErrorNamesOneToken := by
  intro argv message h
  rcases argv with _ | ⟨command, rest⟩
  · left
    have h' : missingCommandMessage = message := by
      simpa [parseCli] using h
    subst h'
    simp [cliErrorsNamingNothing]
  rw [parseCli_cons] at h
  split at h
  · exact Or.inr (stand_alone_error (fun _ => by simp [cliErrorsNaming]) h)
  split at h
  · exact Or.inr (stand_alone_error (fun _ => by simp [cliErrorsNaming]) h)
  split at h
  · exact Or.inr (plain_command_error (by simp [labeledGrammars]) h)
  split at h
  · exact Or.inr (plain_command_error (by simp [labeledGrammars]) h)
  split at h
  · exact Or.inr (plain_command_error (by simp [labeledGrammars]) h)
  split at h
  · refine action_command_error (grammar := fun _ => COMMAND_GRAMMAR.service)
      (fun _ _ => by simp [labeledGrammars])
      (by simp [cliErrorsNamingNothing]) (fun _ => by simp [cliErrorsNaming]) h
  split at h
  · refine action_command_error (grammar := fun _ => COMMAND_GRAMMAR.profile)
      (fun _ _ => by simp [labeledGrammars])
      (by simp [cliErrorsNamingNothing]) (fun _ => by simp [cliErrorsNaming]) h
  split at h
  · rcases bind_eq_error h with h' | ⟨action, ha, h'⟩
    · rcases readAction_error h' with rfl | ⟨first, hfirst, rfl⟩
      · exact Or.inl (by simp [cliErrorsNamingNothing])
      · exact Or.inr ⟨first, List.mem_cons_of_mem _ (mem_of_head? hfirst),
          by simp [cliErrorsNaming]⟩
    · obtain ⟨hmem, _⟩ := readAction_ok ha
      simp only [SESSIONS_ACTIONS, List.mem_cons, List.not_mem_nil, or_false] at hmem
      right
      rcases hmem with rfl | rfl
      · rw [show s!"sessions {"list"}" = "sessions list" by decide] at h'
        have := plain_command_error (command := command) (rest := rest.drop 1)
          (mk := fun profile parsed => CliCommand.sessions "list" profile
            (normalizeSessionsArgv parsed (sessionsHandlerFlags "list")))
          (by simp [labeledGrammars]) h'
        obtain ⟨token, htoken, hmsg⟩ := this
        refine ⟨token, ?_, hmsg⟩
        rcases List.mem_cons.mp htoken with rfl | htoken
        · exact List.mem_cons_self
        · exact List.mem_cons_of_mem _ (List.mem_of_mem_drop htoken)
      · rw [show s!"sessions {"show"}" = "sessions show" by decide] at h'
        have := plain_command_error (command := command) (rest := rest.drop 1)
          (mk := fun profile parsed => CliCommand.sessions "show" profile
            (normalizeSessionsArgv parsed (sessionsHandlerFlags "show")))
          (by simp [labeledGrammars]) h'
        obtain ⟨token, htoken, hmsg⟩ := this
        refine ⟨token, ?_, hmsg⟩
        rcases List.mem_cons.mp htoken with rfl | htoken
        · exact List.mem_cons_self
        · exact List.mem_cons_of_mem _ (List.mem_of_mem_drop htoken)
  · right
    rw [Except.error.injEq] at h
    subst h
    exact ⟨command, List.mem_cons_self, by simp [cliErrorsNaming]⟩

/-! ## (a) at the level of `parseCli` -/

theorem select_cons (flags : List (String × FlagValue)) (k : String) (ks : List String) :
    select flags (k :: ks) = select flags [k] ++ select flags ks := by
  simpa using select_append flags [k] ks

/-- The `--profile` entry of a parse is exactly what `readProfile` returned. -/
theorem flagTokens_select_profile {parsed : Parsed} {profile : Option String}
    (hnp : parsed.get PROFILE_FLAG ≠ some .present) (h : readProfile parsed = .ok profile) :
    flagTokens (select parsed.flags [PROFILE_FLAG]) = profileTokens profile := by
  unfold readProfile at h
  simp only [select, List.filterMap_cons, List.filterMap_nil]
  cases hv : parsed.flags.lookup PROFILE_FLAG with
  | none =>
    simp only [Parsed.get, hv, Except.ok.injEq] at h
    subst h
    simp [profileTokens]
  | some value =>
    cases value with
    | present => exact absurd hv hnp
    | str v =>
      simp only [Parsed.get, hv] at h
      split at h
      · cases h
      · rw [Except.ok.injEq] at h
        subst h
        simp [profileTokens]

/-- A boolean flag's entry is exactly what `has` reports. -/
theorem flagTokens_select_boolean {tokens : List String} {grammar : Grammar} {command : String}
    {parsed : Parsed} (hp : parseArguments tokens grammar command = .ok parsed) {flag : String}
    (hkind : grammar.flags.lookup flag = some .boolean) :
    flagTokens (select parsed.flags [flag]) = flagIf flag (parsed.has flag) := by
  simp only [select, List.filterMap_cons, List.filterMap_nil, Parsed.has]
  cases hv : parsed.flags.lookup flag with
  | none => simp [flagIf]
  | some value =>
    have hpresent := stored_present_of_boolean hp (mem_of_lookup_eq_some hv) hkind
    subst hpresent
    simp [flagIf]

/-- The flags a parse stored, taken in the grammar's key order, are a re-ordering of them. -/
theorem flagTokens_select_grammar {tokens : List String} {grammar : Grammar} {command : String}
    {parsed : Parsed} (hp : parseArguments tokens grammar command = .ok parsed)
    (hkeys : (grammar.flags.map (·.1)).Nodup) :
    (flagTokens (select parsed.flags (grammar.flags.map (·.1)))).Perm (flagTokens parsed.flags) :=
  flagTokens_perm (select_perm hkeys (noFlagTwice tokens grammar command parsed hp)
    (fun e he => mem_keys_of_lookup_eq_some (flagsDeclared tokens grammar command parsed hp e he)))

/-- With no positional allowed, the tail is exactly the stored flags' tokens, re-ordered. -/
theorem tail_perm_flags {tokens : List String} {grammar : Grammar} {command : String}
    {parsed : Parsed} (hp : parseArguments tokens grammar command = .ok parsed)
    (hmax : grammar.maxPositionals = 0) : (flagTokens parsed.flags).Perm tokens := by
  have hle := positionalsWithinMax tokens grammar command parsed hp
  rw [hmax] at hle
  have hnil : parsed.positionals = [] := List.length_eq_zero_iff.mp (by omega)
  simpa [hnil] using consumesEveryTokenOnce tokens grammar command parsed hp

theorem ok_pure_inj {a b : CliCommand} (h : (pure a : Except String CliCommand) = .ok b) :
    b = a := by
  simp only [pure, Except.pure, Except.ok.injEq] at h
  exact h.symm

/-- A command with `--profile` and one boolean flag: its fields account for the whole tail. -/
theorem profile_boolean_perm {tokens : List String} {grammar : Grammar} {command flag : String}
    {parsed : Parsed} {profile : Option String}
    (hp : parseArguments tokens grammar command = .ok parsed)
    (hrp : readProfile parsed = .ok profile)
    (hg : grammar.flags.lookup PROFILE_FLAG = some .value)
    (hkeys : grammar.flags.map (·.1) = [PROFILE_FLAG, flag])
    (hkind : grammar.flags.lookup flag = some .boolean) (hnd : [PROFILE_FLAG, flag].Nodup)
    (hmax : grammar.maxPositionals = 0) :
    (profileTokens profile ++ flagIf flag (parsed.has flag)).Perm tokens := by
  have hsel := flagTokens_select_grammar hp (hkeys ▸ hnd)
  rw [hkeys, select_cons, flagTokens_append,
    flagTokens_select_profile (get_profile_ne_present hg hp) hrp,
    flagTokens_select_boolean hp hkind] at hsel
  exact hsel.trans (tail_perm_flags hp hmax)

/-- (a) args.ts:4 at the level of `parseCli`: a successful result, written back out, is a
permutation of the argv. -/
theorem cliConsumesEveryTokenOnce : CliConsumesEveryTokenOnce := by
  intro argv result h
  rcases argv with _ | ⟨command, rest⟩
  · cases h
  rw [parseCli_cons] at h
  split at h
  · rename_i hhelp
    left
    obtain ⟨_, hu, hc⟩ := bind_eq_ok h
    cases rest with
    | nil => exact ⟨ok_pure_inj hc, command, by simpa using hhelp, rfl⟩
    | cons first more => simp [assertNoExtraTokens] at hu
  split at h
  · rename_i _ hversion
    right; left
    obtain ⟨_, hu, hc⟩ := bind_eq_ok h
    cases rest with
    | nil => exact ⟨ok_pure_inj hc, command, by simpa using hversion, rfl⟩
    | cons first more => simp [assertNoExtraTokens] at hu
  right; right
  split at h
  · rename_i hcmd
    subst hcmd
    obtain ⟨parsed, hp, h⟩ := bind_eq_ok h
    obtain ⟨profile, hrp, h⟩ := bind_eq_ok h
    have hresult := ok_pure_inj h
    subst hresult
    exact List.Perm.cons _
      (profile_boolean_perm hp hrp (by decide) (by decide) (by decide) (by decide) (by decide))
  split at h
  · rename_i hcmd
    subst hcmd
    obtain ⟨parsed, hp, h⟩ := bind_eq_ok h
    obtain ⟨profile, hrp, h⟩ := bind_eq_ok h
    have hresult := ok_pure_inj h
    subst hresult
    exact List.Perm.cons _
      (profile_boolean_perm hp hrp (by decide) (by decide) (by decide) (by decide) (by decide))
  split at h
  · rename_i hcmd
    subst hcmd
    obtain ⟨parsed, hp, h⟩ := bind_eq_ok h
    obtain ⟨profile, hrp, h⟩ := bind_eq_ok h
    have hresult := ok_pure_inj h
    subst hresult
    exact List.Perm.cons _
      (profile_boolean_perm hp hrp (by decide) (by decide) (by decide) (by decide) (by decide))
  split at h
  · rename_i hcmd
    subst hcmd
    obtain ⟨action, ha, h⟩ := bind_eq_ok h
    obtain ⟨_, hhead⟩ := readAction_ok ha
    cases rest with
    | nil => cases hhead
    | cons first tail =>
      simp only [List.head?_cons, Option.some.injEq] at hhead
      subst hhead
      obtain ⟨parsed, hp, h⟩ := bind_eq_ok h
      obtain ⟨profile, hrp, h⟩ := bind_eq_ok h
      have hresult := ok_pure_inj h
      subst hresult
      simp only [List.drop_succ_cons, List.drop_zero] at hp
      refine List.Perm.cons _ (List.Perm.cons _ ?_)
      have hsel := flagTokens_select_grammar hp (by decide)
      rw [show COMMAND_GRAMMAR.service.flags.map (·.1) = [PROFILE_FLAG] by decide,
        flagTokens_select_profile (get_profile_ne_present (by decide) hp) hrp] at hsel
      exact hsel.trans (tail_perm_flags hp (by decide))
  split at h
  · rename_i hcmd
    subst hcmd
    obtain ⟨action, ha, h⟩ := bind_eq_ok h
    obtain ⟨_, hhead⟩ := readAction_ok ha
    cases rest with
    | nil => cases hhead
    | cons first tail =>
      simp only [List.head?_cons, Option.some.injEq] at hhead
      subst hhead
      obtain ⟨parsed, hp, h⟩ := bind_eq_ok h
      obtain ⟨profile, hrp, h⟩ := bind_eq_ok h
      have hresult := ok_pure_inj h
      subst hresult
      simp only [List.drop_succ_cons, List.drop_zero] at hp
      exact List.Perm.cons _ (List.Perm.cons _
        (profile_boolean_perm hp hrp (by decide) (by decide) (by decide) (by decide) (by decide)))
  split at h
  · rename_i hcmd
    subst hcmd
    obtain ⟨action, ha, h⟩ := bind_eq_ok h
    obtain ⟨_, hhead⟩ := readAction_ok ha
    cases rest with
    | nil => cases hhead
    | cons first tail =>
      simp only [List.head?_cons, Option.some.injEq] at hhead
      subst hhead
      obtain ⟨parsed, hp, h⟩ := bind_eq_ok h
      obtain ⟨profile, hrp, h⟩ := bind_eq_ok h
      have hresult := ok_pure_inj h
      subst hresult
      simp only [List.drop_succ_cons, List.drop_zero] at hp
      refine List.Perm.cons _ (List.Perm.cons _ ?_)
      have hkeys : (sessionsGrammar first).flags.map (·.1) =
          (sessionsHandlerFlags first).map (·.1) ++ [PROFILE_FLAG] := by
        rw [sessionsGrammar_flags]
        simp [PROFILE_ONLY]
      have hnd : ((sessionsHandlerFlags first).map (·.1) ++ [PROFILE_FLAG]).Nodup := by
        rw [List.nodup_append]
        refine ⟨handlerKeys_nodup first, by simp, ?_⟩
        intro a ha b hb hab
        simp only [List.mem_singleton] at hb
        subst hb
        subst hab
        exact profile_not_handlerKey first ha
      have hsel := flagTokens_select_grammar hp (hkeys ▸ hnd)
      rw [hkeys, select_append, flagTokens_append,
        flagTokens_select_profile (get_profile_ne_present (sessionsGrammar_profile first) hp) hrp]
        at hsel
      have hall := consumesEveryTokenOnce tail _ _ parsed hp
      rw [normalize_eq]
      refine List.Perm.trans ?_ ((List.Perm.append_left _ hsel).trans hall)
      refine List.perm_append_comm.trans ?_
      simp only [List.append_assoc]
      exact List.Perm.refl _
  · cases h

end SomaVerify.CliArgs
