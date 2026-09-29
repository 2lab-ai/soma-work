import SomaVerify.WebhookSsrf.Model
import SomaVerify.WebhookSsrf.Spec

/-!
# Theorems about the webhook SSRF model

`ts:N` is `src/webhook-url-validator.ts:N`. The address theorems quantify over every natural
number; none of them enumerates an address range. `decide` settles only facts about finite,
concrete objects: the tables (alignment, agreement of same-length rows), the sixteen hex digits,
the addresses 0 and 1, and the named probe addresses of `probe_addresses`.
-/

namespace SomaVerify.WebhookSsrf.Proofs

open SomaVerify.WebhookSsrf Spec

/-! ## Bit operations -/

/-- TS `inBlock` (ts:182) compares `address >> k` with `base >> k`: integer division by 2^k. -/
theorem shiftRight_eq_div (a k : Nat) : a >>> k = a / 2 ^ k :=
  Nat.shiftRight_eq_div_pow a k

/-- ts:226: the IPv4 address a NAT64 address carries, `address & 0xffffffffn`, is its low 32
bits. -/
theorem nat64_low32_eq (a : Nat) : a &&& 0xffffffff = a % 2 ^ 32 := by
  rw [show (0xffffffff : Nat) = 2 ^ 32 - 1 from rfl, Nat.and_two_pow_sub_one_eq_mod]

/-- ts:161: `parseIpv6` accumulates `(value << 16n) | BigInt(group)`; for a 16-bit group that is
`value * 65536 + group`. -/
theorem shiftLeft_or_eq (v g : Nat) (hg : g < 2 ^ 16) : (v <<< 16) ||| g = v * 65536 + g := by
  rw [← Nat.shiftLeft_add_eq_or_of_lt hg, Nat.shiftLeft_eq]

/-- ts:140: a dotted-quad tail becomes the groups `ipv4 >> 16n` and `ipv4 & 0xffffn`, its high
and low 16 bits, which `shiftLeft_or_eq` puts back together. -/
theorem dotted_tail_split (v : Nat) :
    v >>> 16 = v / 65536 ∧ v &&& 0xffff = v % 65536 ∧ (v >>> 16) * 65536 + (v &&& 0xffff) = v := by
  have h1 : v >>> 16 = v / 65536 := Nat.shiftRight_eq_div_pow v 16
  have h2 : v &&& 0xffff = v % 65536 := by
    rw [show (0xffff : Nat) = 2 ^ 16 - 1 from rfl, Nat.and_two_pow_sub_one_eq_mod]
  refine ⟨h1, h2, ?_⟩
  rw [h1, h2]
  omega

/-- The replaced code split the hex form `::ffff:hi:lo` with `a = (hi >> 8) & 0xff` and
`b = hi & 0xff` (lines 51-53 at 60d74c71). For a 16-bit `hi` these are `hi / 256` and
`hi % 256`, the first two octets of the mapped IPv4 address. -/
theorem mapped_hex_decomposition (hi : Nat) (h : hi < 65536) :
    (hi >>> 8) &&& 0xff = hi / 256 ∧ hi &&& 0xff = hi % 256 := by
  rw [show (0xff : Nat) = 2 ^ 8 - 1 from rfl, Nat.and_two_pow_sub_one_eq_mod,
    Nat.and_two_pow_sub_one_eq_mod, Nat.shiftRight_eq_div_pow]
  omega

/-! ## Blocks -/

/-- For an aligned block, TS `inBlock` (ts:180-183) holds exactly between the block's first and
last address. -/
theorem contains_iff_mem {bits : Nat} {b : Block} {a : Nat} (h : b.base % 2 ^ (bits - b.len) = 0) :
    b.contains bits a = true ↔ Mem bits b a := by
  unfold Block.contains Mem
  rw [beq_iff_eq, Nat.shiftRight_eq_div_pow, Nat.shiftRight_eq_div_pow]
  have hp : 0 < 2 ^ (bits - b.len) := Nat.two_pow_pos _
  generalize 2 ^ (bits - b.len) = p at hp h ⊢
  have hb : b.base = b.base / p * p := by
    have := Nat.div_add_mod b.base p
    rw [h, Nat.add_zero, Nat.mul_comm] at this
    exact this.symm
  constructor
  · intro hq
    constructor
    · rw [hb, ← hq]
      exact Nat.div_mul_le_self a p
    · rw [hb, ← hq]
      exact Nat.lt_div_mul_add hp
  · rintro ⟨h1, h2⟩
    apply Nat.le_antisymm
    · have : a / p < b.base / p + 1 := by
        apply (Nat.div_lt_iff_lt_mul hp).2
        rw [Nat.add_mul, Nat.one_mul, ← hb]
        exact h2
      omega
    · exact Nat.div_le_div_right h1

/-! ## The registry loop -/

/-- Rows that contain `address` and have the same prefix length agree on reachability. -/
def SameLengthSameReach (bits address : Nat) (rows : List RegistryBlock) : Prop :=
  ∀ r1 ∈ rows, ∀ r2 ∈ rows, r1.toBlock.contains bits address = true →
    r2.toBlock.contains bits address = true → r1.len = r2.len → r1.reach = r2.reach

/-- The loop of TS `registryBlocks` (ts:205-215), from any state `(bestLength, blocked)`: it ends
with `true` iff no row beats `bestLength` and `blocked` already holds, or a row of maximal length
among those containing the address beats `bestLength` and is not `True`. -/
theorem registryLoop_iff (bits address : Nat) : ∀ (rows : List RegistryBlock) (best : Int)
    (blocked : Bool), SameLengthSameReach bits address rows →
    (registryLoop address bits rows best blocked = true ↔
      ((blocked = true ∧ ∀ r ∈ rows, r.toBlock.contains bits address = true → (r.len : Int) ≤ best) ∨
        ∃ r ∈ rows, r.toBlock.contains bits address = true ∧ best < r.len ∧ r.reach ≠ .yes ∧
          ∀ r' ∈ rows, r'.toBlock.contains bits address = true → r'.len ≤ r.len))
  | [], best, blocked, _ => by simp [registryLoop]
  | r :: rest, best, blocked, hwf => by
    have hwf' : SameLengthSameReach bits address rest := fun r1 h1 r2 h2 =>
      hwf r1 (List.mem_cons_of_mem _ h1) r2 (List.mem_cons_of_mem _ h2)
    unfold registryLoop
    by_cases hc : (r.len : Int) > best ∧ r.toBlock.contains bits address = true
    · have hcond : (decide ((r.len : Int) > best) && r.toBlock.contains bits address) = true := by
        simp [hc.1, hc.2]
      rw [ite_eq_left hcond, registryLoop_iff bits address rest r.len (r.reach != .yes) hwf']
      constructor
      · rintro (⟨hb, hmax⟩ | ⟨s, hs, hsc, hlt, hsr, hsmax⟩)
        · refine Or.inr ⟨r, List.mem_cons_self .., hc.2, hc.1, by simpa using hb, ?_⟩
          intro r' hr' hc'
          rcases List.mem_cons.1 hr' with rfl | hr'
          · exact Nat.le_refl _
          · have := hmax r' hr' hc'
            omega
        · refine Or.inr ⟨s, List.mem_cons_of_mem _ hs, hsc, by omega, hsr, ?_⟩
          intro r' hr' hc'
          rcases List.mem_cons.1 hr' with rfl | hr'
          · omega
          · exact hsmax r' hr' hc'
      · rintro (⟨_, hle⟩ | ⟨s, hs, hsc, _, hsr, hsmax⟩)
        · have := hle r (List.mem_cons_self ..) hc.2
          omega
        · rcases List.mem_cons.1 hs with rfl | hs
          · refine Or.inl ⟨by simpa using hsr, ?_⟩
            intro r' hr' hc'
            have := hsmax r' (List.mem_cons_of_mem _ hr') hc'
            omega
          · have hge : r.len ≤ s.len := hsmax r (List.mem_cons_self ..) hc.2
            rcases Nat.lt_or_ge r.len s.len with hlt' | hge'
            · exact Or.inr ⟨s, hs, hsc, by omega, hsr,
                fun r' hr' hc' => hsmax r' (List.mem_cons_of_mem _ hr') hc'⟩
            · have heq : r.len = s.len := Nat.le_antisymm hge hge'
              refine Or.inl ⟨?_, ?_⟩
              · have := hwf r (List.mem_cons_self ..) s (List.mem_cons_of_mem _ hs) hc.2 hsc heq
                rw [this]
                simpa using hsr
              · intro r' hr' hc'
                have := hsmax r' (List.mem_cons_of_mem _ hr') hc'
                omega
    · have hcond : ¬ (decide ((r.len : Int) > best) && r.toBlock.contains bits address) = true := by
        simpa [Bool.and_eq_true, decide_eq_true_eq] using hc
      rw [ite_eq_right hcond, registryLoop_iff bits address rest best blocked hwf']
      constructor
      · rintro (⟨hb, hle⟩ | ⟨s, hs, hsc, hlt, hsr, hsmax⟩)
        · refine Or.inl ⟨hb, ?_⟩
          intro r' hr' hc'
          rcases List.mem_cons.1 hr' with rfl | hr'
          · have : ¬ ((r'.len : Int) > best) := fun h => hc ⟨h, hc'⟩
            omega
          · exact hle r' hr' hc'
        · refine Or.inr ⟨s, List.mem_cons_of_mem _ hs, hsc, hlt, hsr, ?_⟩
          intro r' hr' hc'
          rcases List.mem_cons.1 hr' with rfl | hr'
          · have : ¬ ((r'.len : Int) > best) := fun h => hc ⟨h, hc'⟩
            omega
          · exact hsmax r' hr' hc'
      · rintro (⟨hb, hle⟩ | ⟨s, hs, hsc, hlt, hsr, hsmax⟩)
        · exact Or.inl ⟨hb, fun r' hr' hc' => hle r' (List.mem_cons_of_mem _ hr') hc'⟩
        · rcases List.mem_cons.1 hs with rfl | hs
          · exact absurd ⟨hlt, hsc⟩ hc
          · exact Or.inr ⟨s, hs, hsc, hlt, hsr,
              fun r' hr' hc' => hsmax r' (List.mem_cons_of_mem _ hr') hc'⟩

/-- Among the rows satisfying `P`, if any, one has maximal prefix length. -/
theorem exists_max_len (P : RegistryBlock → Prop) :
    ∀ rows : List RegistryBlock, (∃ r ∈ rows, P r) → ∃ m ∈ rows, P m ∧ ∀ r ∈ rows, P r → r.len ≤ m.len
  | [], ⟨_, h, _⟩ => absurd h (List.not_mem_nil)
  | x :: xs, ⟨r, hr, hp⟩ => by
    by_cases hxs : ∃ r ∈ xs, P r
    · obtain ⟨m, hm, hpm, hmax⟩ := exists_max_len P xs hxs
      by_cases hx : P x ∧ m.len < x.len
      · refine ⟨x, List.mem_cons_self .., hx.1, ?_⟩
        intro r' hr' hp'
        rcases List.mem_cons.1 hr' with rfl | hr'
        · exact Nat.le_refl _
        · have := hmax r' hr' hp'
          omega
      · refine ⟨m, List.mem_cons_of_mem _ hm, hpm, ?_⟩
        intro r' hr' hp'
        rcases List.mem_cons.1 hr' with rfl | hr'
        · exact Nat.le_of_not_lt fun h => hx ⟨hp', h⟩
        · exact hmax r' hr' hp'
    · have hpx : P x := by
        rcases List.mem_cons.1 hr with rfl | hr
        · exact hp
        · exact absurd ⟨r, hr, hp⟩ hxs
      refine ⟨x, List.mem_cons_self .., hpx, ?_⟩
      intro r' hr' hp'
      rcases List.mem_cons.1 hr' with rfl | hr'
      · exact Nat.le_refl _
      · exact absurd ⟨r', hr', hp'⟩ hxs

/-- TS `registryBlocks` meets rule (i) for every address, on any table whose blocks are aligned
and whose same-length blocks with the same prefix agree on reachability. -/
theorem registryBlocks_iff (address bits : Nat) (rows : List RegistryBlock)
    (hal : ∀ r ∈ rows, r.base % 2 ^ (bits - r.len) = 0)
    (hwf : ∀ r1 ∈ rows, ∀ r2 ∈ rows, r1.len = r2.len →
      r1.base >>> (bits - r1.len) = r2.base >>> (bits - r2.len) → r1.reach = r2.reach) :
    registryBlocks address rows bits = true ↔ RegistryBlocked bits rows address := by
  have hsame : SameLengthSameReach bits address rows := by
    intro r1 h1 r2 h2 hc1 hc2 hlen
    apply hwf r1 h1 r2 h2 hlen
    unfold Block.contains at hc1 hc2
    rw [beq_iff_eq] at hc1 hc2
    exact hc1.symm.trans (hlen ▸ hc2)
  have hmem : ∀ r ∈ rows, r.toBlock.contains bits address = true ↔ Mem bits r.toBlock address :=
    fun r hr => contains_iff_mem (hal r hr)
  unfold registryBlocks
  rw [registryLoop_iff bits address rows (-1) false hsame]
  constructor
  · rintro (⟨h, _⟩ | ⟨r, hr, hc, _, hre, hmax⟩)
    · exact absurd h (by decide)
    · refine ⟨r, hr, (hmem r hr).1 hc, hre, ?_⟩
      intro r' hr' hm' hlt
      have := hmax r' hr' ((hmem r' hr').2 hm')
      omega
  · rintro ⟨r, hr, hm, hre, hmore⟩
    obtain ⟨m, hmr, hmc, hmax⟩ :=
      exists_max_len (fun r => r.toBlock.contains bits address = true) rows ⟨r, hr, (hmem r hr).2 hm⟩
    refine Or.inr ⟨m, hmr, hmc, by omega, ?_, hmax⟩
    have hle : r.len ≤ m.len := hmax r hr ((hmem r hr).2 hm)
    rcases Nat.lt_or_ge r.len m.len with hlt | hge
    · exact hmore m hmr ((hmem m hmr).1 hmc) hlt
    · have := hsame m hmr r hr hmc ((hmem r hr).2 hm) (Nat.le_antisymm hge hle)
      rw [this]
      exact hre

/-! ## Table facts, decided by computation on the finite tables -/

/-- Every IPv4 registry block starts on a multiple of its size. -/
theorem ipv4Special_aligned : ∀ r ∈ ipv4Special, r.base % 2 ^ (32 - r.len) = 0 := by decide

/-- IPv4 registry blocks with the same prefix and length agree on reachability. -/
theorem ipv4Special_consistent : ∀ r1 ∈ ipv4Special, ∀ r2 ∈ ipv4Special, r1.len = r2.len →
    r1.base >>> (32 - r1.len) = r2.base >>> (32 - r2.len) → r1.reach = r2.reach := by decide

/-- Every IPv6 registry block starts on a multiple of its size. -/
theorem ipv6Special_aligned : ∀ r ∈ ipv6Special, r.base % 2 ^ (128 - r.len) = 0 := by decide

/-- IPv6 registry blocks with the same prefix and length agree on reachability. -/
theorem ipv6Special_consistent : ∀ r1 ∈ ipv6Special, ∀ r2 ∈ ipv6Special, r1.len = r2.len →
    r1.base >>> (128 - r1.len) = r2.base >>> (128 - r2.len) → r1.reach = r2.reach := by decide

/-! ## Specified blocks, and the TS constants that hold them -/

/-- TS `IPV4_EXTRA` (ts:96, ts:197) is the multicast block of the spec. -/
theorem ipv4Extra_eq : ipv4Extra = [ipv4Multicast] := rfl

/-- TS `IPV6_GLOBAL_UNICAST` (ts:104, ts:198) is the spec's 2000::/3. -/
theorem ipv6GlobalUnicast_eq : ipv6GlobalUnicast = globalUnicast := rfl

/-- TS `NAT64_WELL_KNOWN` (ts:110, ts:199) is the spec's 64:ff9b::/96. -/
theorem nat64WellKnown_eq : nat64WellKnown = nat64 := rfl

/-- The spec's own blocks are aligned, so `inBlock` on them is range membership. -/
theorem spec_blocks_aligned :
    ipv4Multicast.base % 2 ^ (32 - ipv4Multicast.len) = 0 ∧
    globalUnicast.base % 2 ^ (128 - globalUnicast.len) = 0 ∧
    nat64.base % 2 ^ (128 - nat64.len) = 0 := by decide

/-- 64:ff9b::/96 lies outside 2000::/3. -/
theorem nat64_outside_globalUnicast (a : Nat) (h : Mem 128 nat64 a) : ¬ Mem 128 globalUnicast a := by
  simp only [Mem, nat64, globalUnicast] at h ⊢
  omega

/-! ## (a) and (b): the classifier meets the spec at every address -/

/-- (a) ts:217-219 meets ts:6-7, ts:95 and ts:202-203 at every IPv4 address: `isBlockedIpv4`
blocks exactly the addresses whose most specific IPv4 registry block is not `True`, plus
multicast. -/
theorem isBlockedIpv4_iff (a : Nat) : isBlockedIpv4 a = true ↔ Blocked4 a := by
  unfold isBlockedIpv4 Blocked4
  rw [ipv4Extra_eq, Bool.or_eq_true,
    registryBlocks_iff a 32 ipv4Special ipv4Special_aligned ipv4Special_consistent]
  simp only [List.any_cons, List.any_nil, Bool.or_false, contains_iff_mem spec_blocks_aligned.1]

/-- (b) ts:225-228 meets ts:99-102 and ts:107-108 at every IPv6 address: `isBlockedIpv6` allows
exactly the addresses of 2000::/3 that the IPv6 registry does not block, and the NAT64 addresses
whose low 32 bits are an allowed IPv4 address. -/
theorem isBlockedIpv6_iff (a : Nat) : isBlockedIpv6 a = true ↔ Blocked6 a := by
  obtain ⟨_, hgu, hnat⟩ := spec_blocks_aligned
  have hreg := registryBlocks_iff a 128 ipv6Special ipv6Special_aligned ipv6Special_consistent
  unfold isBlockedIpv6 Blocked6 Allowed6
  rw [nat64WellKnown_eq, ipv6GlobalUnicast_eq]
  by_cases hn : nat64.contains 128 a = true
  · have hm : Mem 128 nat64 a := (contains_iff_mem hnat).1 hn
    have hg : ¬ Mem 128 globalUnicast a := nat64_outside_globalUnicast a hm
    simp only [hn, ↓reduceIte, nat64_low32_eq, isBlockedIpv4_iff]
    by_cases hb : Blocked4 (a % 2 ^ 32) <;> simp [hm, hg, hb]
  · have hm : ¬ Mem 128 nat64 a := fun h => hn ((contains_iff_mem hnat).2 h)
    have hg := contains_iff_mem (a := a) hgu
    simp only [hn, Bool.false_eq_true, ↓reduceIte, Bool.or_eq_true, Bool.not_eq_true', hreg]
    by_cases hc : globalUnicast.contains 128 a = true
    · have hm' := hg.1 hc
      by_cases hr : RegistryBlocked 128 ipv6Special a <;> simp [hc, hm', hr, hm]
    · have hm' : ¬ Mem 128 globalUnicast a := fun h => hc (hg.2 h)
      simp only [Bool.not_eq_true] at hc
      simp [hc, hm', hm]

/-- TS `ipVerdict` (ts:240-248) says `some false` exactly for the answers the spec calls safe:
addresses it does not block. Unreadable text gets `some true` (with a `:`) or `none`. -/
theorem ipVerdict_eq_some_false_iff (ip : String) : ipVerdict ip = some false ↔ AnswerSafe ip := by
  unfold ipVerdict AnswerSafe
  dsimp only
  cases h4 : parseIpv4 (stripBrackets ip) with
  | some v =>
    simp only [Option.some.injEq]
    rw [← isBlockedIpv4_iff]
    simp
  | none =>
    cases h6 : parseIpv6 (stripBrackets ip) with
    | some v =>
      simp only [Option.some.injEq]
      rw [← isBlockedIpv6_iff]
      simp
    | none => simp

/-- `isBlockedIp` (ts:255-257) meets ts:251-253: a hostname is blocked iff it is an IPv4 or IPv6
address, brackets allowed, that the spec blocks, or text with a `:` that is neither. -/
theorem isBlockedIp_iff (hostname : String) : isBlockedIp hostname = true ↔ HostnameBlocked hostname := by
  unfold isBlockedIp ipVerdict HostnameBlocked
  dsimp only
  cases h4 : parseIpv4 (stripBrackets hostname) with
  | some v => simp [isBlockedIpv4_iff]
  | none =>
    cases h6 : parseIpv6 (stripBrackets hostname) with
    | some v => simp [isBlockedIpv6_iff]
    | none => simp

/-! ## URLs -/

/-- ts:5 and ts:287: a URL that is not https is rejected with the HTTPS message. -/
theorem httpsOnly : HttpsOnly := by
  intro url h
  simp [validateWebhookUrl, h]

/-- ts:292 and ts:260: `localhost`, `metadata.google.internal`, in any case and with any number of
trailing dots, are rejected. -/
theorem blockedNamesRejected : BlockedNamesRejected := by
  intro url hp hn
  have hne : checkedHostname url.hostname ≠ "" := by
    intro he
    rw [he] at hn
    simp [blockedHostnames] at hn
  simp [validateWebhookUrl, hp, hn, hne]

/-- ts:294-297: an https URL whose host is only dots has nothing left to check and is rejected as
malformed. -/
theorem emptyHostRejected : EmptyHostRejected := by
  intro url hp he
  simp [validateWebhookUrl, hp, he]

/-- ts:263-268: the checked hostname never ends in a dot, however many the URL had. -/
theorem noTrailingDot : NoTrailingDot := by
  intro hostname
  unfold checkedHostname
  rw [String.toList_ofList, List.getLast?_reverse]
  have hd := List.head?_dropWhile_not (· == '.') (hostname.map Char.toLower).toList.reverse
  cases hh : (List.dropWhile (· == '.') (hostname.map Char.toLower).toList.reverse).head? with
  | none => simp
  | some c =>
    rw [hh] at hd
    intro hc
    simp only [Option.some.injEq] at hc
    subst hc
    simp at hd

/-- The empty hostname is not a blocked address. -/
theorem isBlockedIp_empty : isBlockedIp "" = false := by decide

/-- ts:303: an https URL whose hostname is a blocked address is rejected. The empty hostname is
never a blocked address (`isBlockedIp_empty`), so the ts:295 branch does not intercept. -/
theorem blockedAddressesRejected : BlockedAddressesRejected := by
  intro url hp hb
  have hne : checkedHostname url.hostname ≠ "" := by
    intro he
    have hblocked := (isBlockedIp_iff (checkedHostname url.hostname)).2 hb
    rw [he, isBlockedIp_empty] at hblocked
    exact Bool.false_ne_true hblocked
  have := (isBlockedIp_iff _).2 hb
  unfold validateWebhookUrl
  dsimp only
  rw [ite_eq_right (by simp [hp]), ite_eq_right (by simpa using hne)]
  split <;> rfl

/-- ts:332-339: an IP-literal URL, brackets included (the BUG A case), gets exactly the first
pass's verdict and the resolvers are not called. Before the fix the brackets reached `net.isIP`,
so every IPv6 literal went to DNS and failed. -/
theorem ipLiteralsSkipDns : IpLiteralsSkipDns := by
  intro url a4 a6 h
  unfold validateWebhookUrlWithDns
  cases hv : validateWebhookUrl (some url) with
  | invalid e => rfl
  | valid => simp [h]

/-- ts:8, ts:314 and ts:358: once the resolvers are called, the URL is accepted iff they answered
and every answer is an address the spec allows; an unreadable answer blocks (fail closed). -/
theorem resolvedIpsChecked : ResolvedIpsChecked := by
  intro url a4 a6 hq
  unfold validateWebhookUrlWithDns at hq ⊢
  cases hv : validateWebhookUrl url with
  | invalid e => rw [hv] at hq; simp at hq
  | valid =>
    rw [hv] at hq
    cases url with
    | none => simp at hq
    | some u =>
      simp only at hq ⊢
      by_cases hl : isIpLiteral (stripBrackets (checkedHostname u.hostname)) = true
      · simp [hl] at hq
      · simp only [hl, Bool.false_eq_true, ↓reduceIte]
        by_cases he : a4 ++ a6 = []
        · simp [he]
        · have hne : (a4 ++ a6).isEmpty = false := by
            cases h : a4 ++ a6 with
            | nil => exact absurd h he
            | cons _ _ => rfl
          simp only [hne, Bool.false_eq_true, ↓reduceIte]
          by_cases ha : (a4 ++ a6).any (fun ip => ipVerdict ip != some false) = true
          · obtain ⟨ip, hip, hbad⟩ := List.any_eq_true.1 ha
            simp only [bne_iff_ne, ne_eq] at hbad
            simp only [ha, ↓reduceIte, reduceCtorEq, false_iff, not_and]
            intro _ hall
            exact hbad ((ipVerdict_eq_some_false_iff ip).2 (hall ip hip))
          · simp only [ha, Bool.false_eq_true, ↓reduceIte, true_iff]
            refine ⟨he, fun ip hip => (ipVerdict_eq_some_false_iff ip).1 ?_⟩
            apply Classical.byContradiction
            intro hbad
            exact ha (List.any_eq_true.2 ⟨ip, hip, by simpa [bne_iff_ne] using hbad⟩)

/-- ts:332-334: the resolvers are called with the checked hostname, brackets stripped. -/
theorem resolversGetCheckedHostname : ResolversGetCheckedHostname := by
  intro url a4 a6 q hq
  unfold validateWebhookUrlWithDns at hq
  cases hv : validateWebhookUrl (some url) with
  | invalid e => simp [hv] at hq
  | valid =>
    simp only [hv] at hq
    by_cases hl : isIpLiteral (stripBrackets (checkedHostname url.hostname)) = true
    · simp [hl] at hq
    · simp only [hl, Bool.false_eq_true, ↓reduceIte] at hq
      split at hq <;> (try split at hq) <;> simp_all

/-! ## (d) No regression against the replaced code -/

/-- A registry row that contains the address and is not `True` blocks it, if no `True` row
contains the address. -/
theorem registryBlocked_of_row {bits n : Nat} {rows : List RegistryBlock} (r : RegistryBlock)
    (hr : r ∈ rows) (hm : Mem bits r.toBlock n) (hre : r.reach ≠ .yes)
    (hyes : ∀ r' ∈ rows, r'.reach = .yes → ¬ Mem bits r'.toBlock n) :
    RegistryBlocked bits rows n :=
  ⟨r, hr, hm, hre, fun r' hr' hm' _ hy => hyes r' hr' hy hm'⟩

/-- The `True` rows of the IPv4 registry are 192.0.0.9, 192.0.0.10 and three /24s. -/
theorem ipv4_true_rows (n : Nat)
    (h : n ≠ 0xc0000009 ∧ n ≠ 0xc000000a ∧ ¬ (0xc01fc400 ≤ n ∧ n ≤ 0xc01fc4ff) ∧
      ¬ (0xc034c100 ≤ n ∧ n ≤ 0xc034c1ff) ∧ ¬ (0xc0af3000 ≤ n ∧ n ≤ 0xc0af30ff)) :
    ∀ r ∈ ipv4Special, r.reach = .yes → ¬ Mem 32 r.toBlock n := by
  simp [ipv4Special, Mem]
  omega

/-- The `True` rows of the IPv6 registry: NAT64 64:ff9b::/96, 2620:4f:8000::/48, and seven
blocks inside 2001::/23. -/
theorem ipv6_true_rows (n : Nat)
    (h : ¬ (0x0064ff9b000000000000000000000000 ≤ n ∧ n ≤ 0x0064ff9b0000000000000000ffffffff) ∧
      ¬ (0x20010000000000000000000000000000 ≤ n ∧ n ≤ 0x2001ffffffffffffffffffffffffffff) ∧
      ¬ (0x2620004f800000000000000000000000 ≤ n ∧ n ≤ 0x2620004f8000ffffffffffffffffffff)) :
    ∀ r ∈ ipv6Special, r.reach = .yes → ¬ Mem 128 r.toBlock n := by
  simp [ipv6Special, Mem]
  omega

/-- `isPrivateIpv4` of the replaced code (lines 21-29 at 60d74c71), as a disjunction. -/
theorem original_isPrivateIpv4_iff (a b : Nat) : Original.isPrivateIpv4 a b = true ↔
    (a = 127 ∨ a = 10 ∨ a = 0) ∨ (a = 172 ∧ 16 ≤ b ∧ b ≤ 31) ∨ (a = 192 ∧ b = 168) ∨
      (a = 169 ∧ b = 254) ∨ (a = 100 ∧ 64 ≤ b ∧ b ≤ 127) ∨ (a = 198 ∧ (b = 18 ∨ b = 19)) := by
  unfold Original.isPrivateIpv4
  simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq]
  repeat' split
  all_goals first
    | (simp only [true_iff]; omega)
    | (simp only [Bool.false_eq_true, false_iff]; omega)

/-- (d), IPv4: every address the replaced code blocked is still blocked. Each of its eight
ranges (0/8, 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 198.18/15) is an IPv4
registry row that is not `True`, and no `True` row meets it. -/
theorem original_blocked4_still_blocked (n : Nat) (hn : n < 2 ^ 32)
    (h : Original.blocked4 n = true) : isBlockedIpv4 n = true := by
  rw [isBlockedIpv4_iff]
  left
  unfold Original.blocked4 at h
  rw [original_isPrivateIpv4_iff] at h
  have hyes := ipv4_true_rows n (by omega)
  rcases h with (h | h | h) | h | h | h | h | h
  · exact registryBlocked_of_row ⟨⟨"127.0.0.0/8", 0x7f000000, 8⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes
  · exact registryBlocked_of_row ⟨⟨"10.0.0.0/8", 0x0a000000, 8⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes
  · exact registryBlocked_of_row ⟨⟨"0.0.0.0/8", 0x00000000, 8⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes
  · exact registryBlocked_of_row ⟨⟨"172.16.0.0/12", 0xac100000, 12⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes
  · exact registryBlocked_of_row ⟨⟨"192.168.0.0/16", 0xc0a80000, 16⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes
  · exact registryBlocked_of_row ⟨⟨"169.254.0.0/16", 0xa9fe0000, 16⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes
  · exact registryBlocked_of_row ⟨⟨"100.64.0.0/10", 0x64400000, 10⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes
  · exact registryBlocked_of_row ⟨⟨"198.18.0.0/15", 0xc6120000, 15⟩, .no⟩
      (by simp [ipv4Special]) (by simp only [Mem]; omega) (by decide) hyes

/-- The hex digits `render6` writes, and the values they stand for. -/
theorem hexDigit_values : ∀ x < 16,
    ('f' = Json.hexDigit x ↔ x = 15) ∧ ('e' = Json.hexDigit x ↔ x = 14) ∧
    ('d' = Json.hexDigit x ↔ x = 13) ∧ ('c' = Json.hexDigit x ↔ x = 12) ∧
    ('b' = Json.hexDigit x ↔ x = 11) ∧ ('a' = Json.hexDigit x ↔ x = 10) ∧
    ('9' = Json.hexDigit x ↔ x = 9) ∧ ('8' = Json.hexDigit x ↔ x = 8) := by decide

/-- The replaced code's `startsWith('fc' | 'fd' | 'fe8' | 'fe9' | 'fea' | 'feb')` on a nonzero
first piece written without leading zeros: fc00::/7 and fe80::/10 as intended, and also the
pieces 0xfc, 0xfd, 0xfc0-0xfdf and 0xfe8-0xfeb, whose short spellings begin the same way. -/
theorem original_prefixHit_iff (g : Nat) (hg : g < 0x10000) :
    Original.prefixHit (hexText g ++ [':']) = true ↔
      g = 0xfc ∨ g = 0xfd ∨ (0xfc0 ≤ g ∧ g ≤ 0xfdf) ∨ (0xfe8 ≤ g ∧ g ≤ 0xfeb) ∨
        (0xfc00 ≤ g ∧ g ≤ 0xfdff) ∨ (0xfe80 ≤ g ∧ g ≤ 0xfebf) := by
  unfold hexText
  by_cases h1 : g < 0x10
  · have d0 := hexDigit_values g (by omega)
    simp [h1, Original.prefixHit, List.isPrefixOf]
    omega
  · by_cases h2 : g < 0x100
    · have d1 := hexDigit_values (g / 0x10) (by omega)
      have d0 := hexDigit_values (g % 0x10) (by omega)
      simp [h1, h2, Original.prefixHit, List.isPrefixOf, d1, d0]
      omega
    · by_cases h3 : g < 0x1000
      · have d2 := hexDigit_values (g / 0x100) (by omega)
        have d1 := hexDigit_values (g / 0x10 % 0x10) (by omega)
        have d0 := hexDigit_values (g % 0x10) (by omega)
        simp [h1, h2, h3, Original.prefixHit, List.isPrefixOf, d2, d1, d0]
        omega
      · have d3 := hexDigit_values (g / 0x1000 % 0x10) (by omega)
        have d2 := hexDigit_values (g / 0x100 % 0x10) (by omega)
        have d1 := hexDigit_values (g / 0x10 % 0x10) (by omega)
        simp [h1, h2, h3, Original.prefixHit, List.isPrefixOf, d3, d2, d1]
        omega

/-- In the replaced code's mapped branch (lines 49-55 at 60d74c71), `a` and `b` are the first two
octets of the mapped IPv4 address: `mapped_hex_decomposition` applied to its `hi` piece. -/
theorem original_mapped_octets (n : Nat) (hm : n / 2 ^ 32 = 0xffff) :
    Original.blocked6 n = Original.isPrivateIpv4 (n / 2 ^ 24 % 256) (n / 2 ^ 16 % 256) := by
  have hhi := mapped_hex_decomposition (n / 2 ^ 16 % 0x10000) (Nat.mod_lt _ (by decide))
  have ha : n / 2 ^ 16 % 0x10000 / 256 = n / 2 ^ 24 % 256 := by omega
  have hb : n / 2 ^ 16 % 0x10000 % 256 = n / 2 ^ 16 % 256 := by omega
  unfold Original.blocked6
  have hc1 : (n == 0 || n == 1) = false := by
    simp only [Bool.or_eq_false_iff, beq_eq_false_iff_ne, ne_eq]
    omega
  have hc2 : (n / 2 ^ 32 == 0xffff) = true := by simpa using hm
  simp only [hc1, hc2, Bool.false_eq_true, ↓reduceIte, hhi.1, hhi.2, ha, hb]

/-- An IPv6 address outside 2000::/3 and outside 64:ff9b::/96 is blocked, whatever the registry
says. -/
theorem blocked_outside (n : Nat) (hg : ¬ Mem 128 globalUnicast n) (hn : ¬ Mem 128 nat64 n) :
    isBlockedIpv6 n = true := by
  rw [isBlockedIpv6_iff]
  unfold Blocked6 Allowed6
  simp [hg, hn]

/-- (d), IPv6, with no exception: every address the replaced code blocked is still blocked. All of
them (`::`, `::1`, ::ffff:0:0/96, and every first piece its text prefixes matched: fc00::/7,
fe80::/10, and the short spellings 0xfc, 0xfd, 0xfc0-0xfdf, 0xfe8-0xfeb) lie outside 2000::/3 and
outside 64:ff9b::/96. -/
theorem original_blocked6_still_blocked (n : Nat) (hn : n < 2 ^ 128)
    (h : Original.blocked6 n = true) : isBlockedIpv6 n = true := by
  unfold Original.blocked6 at h
  split at h
  · rename_i h01
    simp only [Bool.or_eq_true, beq_iff_eq] at h01
    rcases h01 with rfl | rfl <;> decide
  · split at h
    · rename_i _ hm
      simp only [beq_iff_eq] at hm
      apply blocked_outside <;> simp only [Mem, globalUnicast, nat64] <;> omega
    · simp only [Bool.and_eq_true, bne_iff_ne, ne_eq] at h
      obtain ⟨_, hp⟩ := h
      rw [original_prefixHit_iff _ (Nat.mod_lt _ (by decide))] at hp
      apply blocked_outside <;> simp only [Mem, globalUnicast, nat64] <;> omega

/-! ## What the rule covers without entries of its own -/

/-- ts:101-102: every block of `coveredOutsideGlobalUnicast` (::/96, ::ffff:0:0/96, fc00::/7,
fe80::/10, fec0::/10, ff00::/8) lies outside 2000::/3 and 64:ff9b::/96, so every address in it is
blocked; none needs a table entry. -/
theorem covered_blocked : ∀ b ∈ coveredOutsideGlobalUnicast, ∀ n, Mem 128 b n →
    isBlockedIpv6 n = true := by
  intro b hb n hm
  simp only [coveredOutsideGlobalUnicast, List.mem_cons, List.mem_nil_iff, or_false] at hb
  apply blocked_outside <;>
    rcases hb with rfl | rfl | rfl | rfl | rfl | rfl <;>
      simp only [Mem, globalUnicast, nat64] at hm ⊢ <;> omega

/-- 6to4 (2002::/16) is inside 2000::/3 and stays blocked through its registry row (`N/A`): no
`True` row meets it. -/
theorem sixToFour_blocked (n : Nat) (h : Mem 128 sixToFour n) : isBlockedIpv6 n = true := by
  simp only [Mem, sixToFour] at h
  have hrb : RegistryBlocked 128 ipv6Special n :=
    registryBlocked_of_row ⟨⟨"2002::/16", 0x20020000000000000000000000000000, 16⟩, .na⟩
      (by simp [ipv6Special]) (by simp only [Mem]; omega) (by decide) (ipv6_true_rows n (by omega))
  have hnat : ¬ Mem 128 nat64 n := by
    simp only [Mem, nat64]
    omega
  rw [isBlockedIpv6_iff]
  unfold Blocked6 Allowed6
  simp [hrb, hnat]

/-- The addresses behind the probe URLs of the issue are blocked: 255.255.255.255, 224.0.0.1,
192.0.0.1, ::7f00:1, 64:ff9b::7f00:1, 2002:7f00:1::, ff02::1, fec0::1, and the short spellings
fc::1 and fe8::1. The public IPv6 addresses 2606:4700:4700::1111 (the BUG A probe) and
2001:4860:4860::8888 are not, nor is 64:ff9b::808:808 (NAT64 of 8.8.8.8). -/
theorem probe_addresses :
    isBlockedIpv4 0xffffffff = true ∧ isBlockedIpv4 0xe0000001 = true ∧
    isBlockedIpv4 0xc0000001 = true ∧ isBlockedIpv6 0x7f000001 = true ∧
    isBlockedIpv6 0x0064ff9b00000000000000007f000001 = true ∧
    isBlockedIpv6 0x20027f00000100000000000000000000 = true ∧
    isBlockedIpv6 0xff020000000000000000000000000001 = true ∧
    isBlockedIpv6 0xfec00000000000000000000000000001 = true ∧
    isBlockedIpv6 0x00fc0000000000000000000000000001 = true ∧
    isBlockedIpv6 0x0fe80000000000000000000000000001 = true ∧
    isBlockedIpv6 0x26064700470000000000000000001111 = false ∧
    isBlockedIpv6 0x20014860486000000000000000008888 = false ∧
    isBlockedIpv6 0x0064ff9b000000000000000008080808 = false := by decide

/-- The text rules on concrete hostnames, evaluated by the kernel: a zone ID (which Node's
`net.isIP` calls an IP address) and other unreadable text with a `:` are blocked; a name, the
empty string and a non-address like `127.0.0.256` are not addresses and not blocked; bracketed and
dotted-tail spellings of blocked addresses are blocked. -/
theorem probe_hostnames :
    isBlockedIp "fe80::1%eth0" = true ∧ isBlockedIp "1:2:3:4:5:6:7:8:9" = true ∧
    isBlockedIp ":::" = true ∧ isBlockedIp "example.com" = false ∧ isBlockedIp "" = false ∧
    isBlockedIp "127.0.0.256" = false ∧ isBlockedIp "[::1]" = true ∧
    isBlockedIp "::ffff:127.0.0.1" = true ∧ isBlockedIp "::127.0.0.1" = true ∧
    isBlockedIp "[2606:4700:4700::1111]" = false := by decide

end SomaVerify.WebhookSsrf.Proofs
