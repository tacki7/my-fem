import Mathlib.Analysis.Convex.Slope
import Mathlib.Analysis.Convex.SpecificFunctions.Basic
import Mathlib.Analysis.SpecialFunctions.Sqrt
import Mathlib.Topology.Order.MonotoneConvergence

/-!
# μ 逆算の単調性

my-fem `src/sim/muinv.ts` の数学的な裏付け。

`slabLoad` はロール扁平の不動点 `R' = flat(P(μ, R'))` を `R' = R` から登る反復で求め、
`muFromLoad` はその荷重 `P(μ) = P(μ, R'(μ))` を μ について二分法で逆に解く。
二分法が正しいには P(μ) が単調でなければならない。ここでは

* 登る反復は単調に増え、有界なら極限は **最小の** 固定点（`flatLimit_le`、`flatLimit_isFixed`）
* 荷重モデルが仮定 `Hyp`（R' を固定して μ に単調・R' に単調、扁平の式が単調で R 以上）を
  満たせば、扁平が発散しない範囲で **P(μ) は単調**（`load_mono`）、μ に狭義なら
  **狭義単調**（`load_strictMono`）
* 発散する μ の集合は上に閉じている（`runaway_up`）— `slabLoad` が発散を荷重 ∞ と
  報告し、二分法が「μ が高すぎる」と扱ってよい根拠
* Kármán の荷重と Hitchcock / Roberts の扁平は `Hyp` を満たし、狭義単調
  （`karman_hitchcock_strictMono`、`karman_roberts_strictMono`）

を示す。Bland & Ford と Orowan の `Hyp` は数値で確認するにとどまる（Orowan は固着で
μ に平坦な区間があり、狭義ではない）。
-/

open Set Filter Topology

namespace MuInverse

/-! ## 下から登る反復 -/

/-- `slabLoad` の扁平の反復 `R, φ R, φ (φ R), …`。 -/
def climb (φ : ℝ → ℝ) (R : ℝ) : ℕ → ℝ
  | 0 => R
  | n + 1 => φ (climb φ R n)

variable {φ ψ : ℝ → ℝ} {R x : ℝ}

theorem climb_monotone (hφ : Monotone φ) (h0 : R ≤ φ R) : Monotone (climb φ R) := by
  refine monotone_nat_of_le_succ fun n => ?_
  induction n with
  | zero => exact h0
  | succ n ih => exact hφ ih

/-- 固定点（より一般に `φ x ≤ x`）の下からは抜けない。 -/
theorem climb_le (hφ : Monotone φ) (hR : R ≤ x) (hx : φ x ≤ x) : ∀ n, climb φ R n ≤ x
  | 0 => hR
  | n + 1 => (hφ (climb_le hφ hR hx n)).trans hx

/-- 写像が小さければ反復も小さい。 -/
theorem climb_le_climb (hφ : Monotone φ) (hle : ∀ y, φ y ≤ ψ y) :
    ∀ n, climb φ R n ≤ climb ψ R n
  | 0 => le_rfl
  | n + 1 => (hφ (climb_le_climb hφ hle n)).trans (hle _)

/-- 反復が有界 — 扁平が発散しない。 -/
def Settles (φ : ℝ → ℝ) (R : ℝ) : Prop := BddAbove (range (climb φ R))

/-- 反復の行き着く先（上限）。 -/
noncomputable def flatLimit (φ : ℝ → ℝ) (R : ℝ) : ℝ := ⨆ n, climb φ R n

theorem le_flatLimit (hs : Settles φ R) (n : ℕ) : climb φ R n ≤ flatLimit φ R :=
  le_ciSup hs n

theorem tendsto_flatLimit (hφ : Monotone φ) (h0 : R ≤ φ R) (hs : Settles φ R) :
    Tendsto (climb φ R) atTop (𝓝 (flatLimit φ R)) :=
  tendsto_atTop_ciSup (climb_monotone hφ h0) hs

/-- 連続なら行き着く先は固定点。 -/
theorem flatLimit_isFixed (hφ : Monotone φ) (h0 : R ≤ φ R) (hs : Settles φ R)
    (hc : ContinuousOn φ (Ici R)) : φ (flatLimit φ R) = flatLimit φ R := by
  have ht := tendsto_flatLimit hφ h0 hs
  have hmem : ∀ n, climb φ R n ∈ Ici R := fun n => climb_monotone hφ h0 (Nat.zero_le n)
  have hL : flatLimit φ R ∈ Ici R := le_flatLimit hs 0
  have h1 : Tendsto (fun n => φ (climb φ R n)) atTop (𝓝 (φ (flatLimit φ R))) :=
    (hc _ hL).tendsto.comp (tendsto_nhdsWithin_iff.2 ⟨ht, Eventually.of_forall hmem⟩)
  exact tendsto_nhds_unique h1 (ht.comp (tendsto_add_atTop_nat 1))

/-- **行き着く先は R 以上のどの固定点よりも小さい** — 物理的な（最小の）解に乗り、
外側の偽の交点には行かない。 -/
theorem flatLimit_le (hφ : Monotone φ) (hR : R ≤ x) (hx : φ x ≤ x) : flatLimit φ R ≤ x :=
  ciSup_le (climb_le hφ hR hx)

theorem settles_of_le (hφ : Monotone φ) (hle : ∀ y, φ y ≤ ψ y) (hψ : Settles ψ R) :
    Settles φ R := by
  obtain ⟨b, hb⟩ := hψ
  exact ⟨b, by rintro _ ⟨n, rfl⟩; exact (climb_le_climb hφ hle n).trans (hb ⟨n, rfl⟩)⟩

theorem flatLimit_mono (hφ : Monotone φ) (hle : ∀ y, φ y ≤ ψ y) (hψ : Settles ψ R) :
    flatLimit φ R ≤ flatLimit ψ R :=
  ciSup_le fun n => (climb_le_climb hφ hle n).trans (le_flatLimit hψ n)

/-! ## 荷重モデルへの仮定と、P(μ) の単調性 -/

/-- `slabLoad` が荷重の式 `P μ R'` と扁平の式 `flat` に要求する性質。 -/
structure Hyp (P : ℝ → ℝ → ℝ) (flat : ℝ → ℝ) (R : ℝ) : Prop where
  mono_mu : ∀ r, MonotoneOn (fun μ => P μ r) (Ioi 0)
  mono_radius : ∀ μ, 0 < μ → Monotone (P μ)
  nonneg : ∀ μ r, 0 < μ → 0 ≤ P μ r
  flat_mono : Monotone flat
  flat_ge : ∀ q, 0 ≤ q → R ≤ flat q

variable {P : ℝ → ℝ → ℝ} {flat : ℝ → ℝ}

namespace Hyp

variable (h : Hyp P flat R)
include h

theorem map_mono {μ : ℝ} (hμ : 0 < μ) : Monotone (fun r => flat (P μ r)) :=
  h.flat_mono.comp (h.mono_radius μ hμ)

theorem start {μ : ℝ} (hμ : 0 < μ) : R ≤ flat (P μ R) :=
  h.flat_ge _ (h.nonneg μ R hμ)

theorem map_le {μ₁ μ₂ : ℝ} (h₁ : 0 < μ₁) (hle : μ₁ ≤ μ₂) :
    ∀ r, flat (P μ₁ r) ≤ flat (P μ₂ r) :=
  fun r => h.flat_mono (h.mono_mu r h₁ (h₁.trans_le hle) hle)

end Hyp

/-- μ での荷重 `P(μ, R'(μ))`。 -/
noncomputable def load (P : ℝ → ℝ → ℝ) (flat : ℝ → ℝ) (R μ : ℝ) : ℝ :=
  P μ (flatLimit (fun r => flat (P μ r)) R)

/-- **発散する μ の集合は上に閉じている。** -/
theorem runaway_up (h : Hyp P flat R) {μ₁ μ₂ : ℝ} (h₁ : 0 < μ₁) (hle : μ₁ ≤ μ₂)
    (hrun : ¬ Settles (fun r => flat (P μ₁ r)) R) : ¬ Settles (fun r => flat (P μ₂ r)) R :=
  fun hs => hrun (settles_of_le (h.map_mono h₁) (h.map_le h₁ hle) hs)

/-- **扁平が発散しない範囲で P(μ) は単調。** -/
theorem load_mono (h : Hyp P flat R) {μ₁ μ₂ : ℝ} (h₁ : 0 < μ₁) (hle : μ₁ ≤ μ₂)
    (hs : Settles (fun r => flat (P μ₂ r)) R) : load P flat R μ₁ ≤ load P flat R μ₂ := by
  have h₂ := h₁.trans_le hle
  have hR := flatLimit_mono (h.map_mono h₁) (h.map_le h₁ hle) hs
  exact (h.mono_mu _ h₁ h₂ hle).trans (h.mono_radius μ₂ h₂ hR)

/-- **R' を固定して μ に狭義なら、P(μ) も狭義単調** — 二分法の答えはただ 1 つ。 -/
theorem load_strictMono (h : Hyp P flat R)
    (hstrict : ∀ r, R ≤ r → StrictMonoOn (fun μ => P μ r) (Ioi 0))
    {μ₁ μ₂ : ℝ} (h₁ : 0 < μ₁) (hlt : μ₁ < μ₂) (hs : Settles (fun r => flat (P μ₂ r)) R) :
    load P flat R μ₁ < load P flat R μ₂ := by
  have h₂ := h₁.trans hlt
  have hs₁ := settles_of_le (h.map_mono h₁) (h.map_le h₁ hlt.le) hs
  have hR := flatLimit_mono (h.map_mono h₁) (h.map_le h₁ hlt.le) hs
  have hge : R ≤ flatLimit (fun r => flat (P μ₁ r)) R := le_flatLimit hs₁ 0
  exact (hstrict _ hge h₁ h₂ hlt).trans_le (h.mono_radius μ₂ h₂ hR)

/-! ## Kármán の荷重 -/

/-- Siebel の摩擦丘係数 `(e^a - 1)/a`、`Qp 0 = 1`。 -/
noncomputable def Qp (a : ℝ) : ℝ := if a = 0 then 1 else (Real.exp a - 1) / a

theorem Qp_of_ne {a : ℝ} (ha : a ≠ 0) : Qp a = (Real.exp a - 1) / a := by simp [Qp, ha]

theorem one_le_Qp {a : ℝ} (ha : 0 ≤ a) : 1 ≤ Qp a := by
  rcases ha.eq_or_lt with rfl | ha
  · simp [Qp]
  · rw [Qp_of_ne ha.ne', le_div_iff₀ ha]
    linarith [Real.add_one_le_exp a]

/-- exp の凸性から: 原点からの割線の傾きは増える。 -/
theorem Qp_strictMonoOn : StrictMonoOn Qp (Ioi 0) := by
  intro x hx y hy hxy
  have := strictConvexOn_exp.secant_strict_mono (a := 0) (mem_univ _) (mem_univ x)
    (mem_univ y) (ne_of_gt hx) (ne_of_gt hy) hxy
  simpa [Qp_of_ne (ne_of_gt hx), Qp_of_ne (ne_of_gt hy)] using this

theorem Qp_monotoneOn : MonotoneOn Qp (Ici 0) := by
  intro x hx y hy hxy
  rcases (show (0 : ℝ) ≤ x from hx).eq_or_lt with rfl | hx'
  · rw [show Qp 0 = 1 by simp [Qp]]
    exact one_le_Qp hy
  · exact Qp_strictMonoOn.monotoneOn hx' (hx'.trans_le hxy) hxy

/-- Kármán の荷重（単位幅）`k · Qp(μ L / h̄) · L`、`L = √(R' Δh)`。
`k` = kf − (σb + σf)/2、`d` = Δh、`hm` = h̄。 -/
noncomputable def karman (k d hm μ r : ℝ) : ℝ :=
  k * Qp (μ * √(r * d) / hm) * √(r * d)

variable {k d hm C : ℝ}

theorem karman_nonneg (hk : 0 ≤ k) (hhm : 0 < hm) {μ r : ℝ} (hμ : 0 < μ) :
    0 ≤ karman k d hm μ r := by
  have ha0 : 0 ≤ μ * √(r * d) / hm := by positivity
  have := one_le_Qp ha0
  exact mul_nonneg (mul_nonneg hk (by linarith)) (Real.sqrt_nonneg _)

theorem karman_mono_mu (hk : 0 ≤ k) (hhm : 0 < hm) (r : ℝ) :
    MonotoneOn (fun μ => karman k d hm μ r) (Ioi 0) := by
  intro μ hμ μ' _ hle
  have hμ0 : (0 : ℝ) < μ := hμ
  have ha0 : 0 ≤ μ * √(r * d) / hm := by positivity
  have ha : μ * √(r * d) / hm ≤ μ' * √(r * d) / hm := by gcongr
  have hq := Qp_monotoneOn ha0 (ha0.trans ha) ha
  exact mul_le_mul_of_nonneg_right (mul_le_mul_of_nonneg_left hq hk) (Real.sqrt_nonneg _)

theorem karman_mono_radius (hk : 0 ≤ k) (hd : 0 < d) (hhm : 0 < hm) {μ : ℝ} (hμ : 0 < μ) :
    Monotone (karman k d hm μ) := by
  intro r r' hrr
  have hs : √(r * d) ≤ √(r' * d) := Real.sqrt_le_sqrt (mul_le_mul_of_nonneg_right hrr hd.le)
  have ha0 : 0 ≤ μ * √(r * d) / hm := by positivity
  have ha : μ * √(r * d) / hm ≤ μ * √(r' * d) / hm := by gcongr
  have hq := Qp_monotoneOn ha0 (ha0.trans ha) ha
  have hq1 := one_le_Qp (ha0.trans ha)
  exact mul_le_mul (mul_le_mul_of_nonneg_left hq hk) hs (Real.sqrt_nonneg _)
    (mul_nonneg hk (by linarith))

theorem karman_strictMono_mu (hk : 0 < k) (hd : 0 < d) (hhm : 0 < hm) {r : ℝ} (hr : 0 < r) :
    StrictMonoOn (fun μ => karman k d hm μ r) (Ioi 0) := by
  intro μ hμ μ' _ hlt
  have hμ0 : (0 : ℝ) < μ := hμ
  have hs : 0 < √(r * d) := Real.sqrt_pos.2 (mul_pos hr hd)
  have ha : 0 < μ * √(r * d) / hm := by positivity
  have hlt' : μ * √(r * d) / hm < μ' * √(r * d) / hm := by gcongr
  have hq := Qp_strictMonoOn ha (ha.trans hlt') hlt'
  exact mul_lt_mul_of_pos_right (mul_lt_mul_of_pos_left hq hk) hs

/-! ## ロール扁平の式 -/

/-- Hitchcock: `R' = R (1 + C P / Δh)`。 -/
noncomputable def hitchcock (R C d q : ℝ) : ℝ := R * (1 + C * q / d)

/-- Roberts: `L = b + √(b² + R Δh)`、`b² = C R P / 4`、`R' = L² / Δh`。 -/
noncomputable def roberts (R C d q : ℝ) : ℝ :=
  (√(C * R * q / 4) + √(C * R * q / 4 + R * d)) ^ 2 / d

theorem hitchcock_mono (hR : 0 ≤ R) (hC : 0 ≤ C) (hd : 0 < d) : Monotone (hitchcock R C d) := by
  intro q q' h
  unfold hitchcock
  gcongr

theorem hitchcock_ge (hR : 0 ≤ R) (hC : 0 ≤ C) (hd : 0 < d) {q : ℝ} (hq : 0 ≤ q) :
    R ≤ hitchcock R C d q := by
  unfold hitchcock
  have : 0 ≤ C * q / d := by positivity
  nlinarith

theorem roberts_mono (hR : 0 ≤ R) (hC : 0 ≤ C) (hd : 0 < d) : Monotone (roberts R C d) := by
  intro q q' h
  unfold roberts
  gcongr

theorem roberts_ge (hR : 0 ≤ R) (hC : 0 ≤ C) (hd : 0 < d) {q : ℝ} (hq : 0 ≤ q) :
    R ≤ roberts R C d q := by
  unfold roberts
  rw [le_div_iff₀ hd]
  have hb : 0 ≤ C * R * q / 4 := by positivity
  have h1 : √(R * d) ≤ √(C * R * q / 4) + √(C * R * q / 4 + R * d) := by
    have := Real.sqrt_le_sqrt (show R * d ≤ C * R * q / 4 + R * d by linarith)
    linarith [Real.sqrt_nonneg (C * R * q / 4)]
  calc R * d = √(R * d) ^ 2 := (Real.sq_sqrt (by positivity)).symm
    _ ≤ _ := by gcongr

/-! ## Kármán + Hitchcock / Roberts -/

theorem karman_hitchcock_hyp (hk : 0 ≤ k) (hd : 0 < d) (hhm : 0 < hm) (hR : 0 < R) (hC : 0 ≤ C) :
    Hyp (karman k d hm) (hitchcock R C d) R where
  mono_mu := karman_mono_mu hk hhm
  mono_radius := fun _ hμ => karman_mono_radius hk hd hhm hμ
  nonneg := fun _ _ hμ => karman_nonneg hk hhm hμ
  flat_mono := hitchcock_mono hR.le hC hd
  flat_ge := fun _ hq => hitchcock_ge hR.le hC hd hq

theorem karman_roberts_hyp (hk : 0 ≤ k) (hd : 0 < d) (hhm : 0 < hm) (hR : 0 < R) (hC : 0 ≤ C) :
    Hyp (karman k d hm) (roberts R C d) R where
  mono_mu := karman_mono_mu hk hhm
  mono_radius := fun _ hμ => karman_mono_radius hk hd hhm hμ
  nonneg := fun _ _ hμ => karman_nonneg hk hhm hμ
  flat_mono := roberts_mono hR.le hC hd
  flat_ge := fun _ hq => roberts_ge hR.le hC hd hq

/-- **Kármán + Hitchcock: 扁平が発散しない範囲で P(μ) は狭義単調増加。** -/
theorem karman_hitchcock_strictMono (hk : 0 < k) (hd : 0 < d) (hhm : 0 < hm) (hR : 0 < R)
    (hC : 0 ≤ C) {μ₁ μ₂ : ℝ} (h₁ : 0 < μ₁) (hlt : μ₁ < μ₂)
    (hs : Settles (fun r => hitchcock R C d (karman k d hm μ₂ r)) R) :
    load (karman k d hm) (hitchcock R C d) R μ₁ < load (karman k d hm) (hitchcock R C d) R μ₂ :=
  load_strictMono (karman_hitchcock_hyp hk.le hd hhm hR hC)
    (fun _ hr => karman_strictMono_mu hk hd hhm (hR.trans_le hr)) h₁ hlt hs

/-- **Kármán + Roberts: 同じく狭義単調増加。** -/
theorem karman_roberts_strictMono (hk : 0 < k) (hd : 0 < d) (hhm : 0 < hm) (hR : 0 < R)
    (hC : 0 ≤ C) {μ₁ μ₂ : ℝ} (h₁ : 0 < μ₁) (hlt : μ₁ < μ₂)
    (hs : Settles (fun r => roberts R C d (karman k d hm μ₂ r)) R) :
    load (karman k d hm) (roberts R C d) R μ₁ < load (karman k d hm) (roberts R C d) R μ₂ :=
  load_strictMono (karman_roberts_hyp hk.le hd hhm hR hC)
    (fun _ hr => karman_strictMono_mu hk hd hhm (hR.trans_le hr)) h₁ hlt hs

end MuInverse
