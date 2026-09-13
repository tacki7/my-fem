import Mathlib.Analysis.Calculus.Deriv.MeanValue
import Mathlib.Analysis.SpecialFunctions.Sqrt
import Mathlib.Analysis.SpecialFunctions.Trigonometric.Bounds
import Mathlib.Analysis.SpecialFunctions.Trigonometric.InverseDeriv
import Mathlib.Analysis.SpecialFunctions.Trigonometric.Sinc
import Mathlib.Topology.Order.IntermediateValue

/-!
# Orowan の圧力の固定点

my-fem `src/sim/slab.ts` の `inhomogeneity` と `pressureOf` の数学的な裏付け。

降伏条件 `q = p - w(a) kf`、`a = min(1, 2 μ p / kf)` の不均質係数

    w(a) = ½ (√(1 - a²) + arcsin a / a),   w(0) = 1

について、次を示す。

* `w` は `[0, 1]` で単調減少し、`π/4 ≤ w ≤ 1`
* 圧力の方程式 `p = max(q + w(a(p)) kf, 0)` の解は、どんな `μ ≥ 0` でもただ 1 つ存在し、
  区間 `[max(q + π/4·kf, 0), max(q + kf, 0)]` に入る
* `g(p) = p - T(p)` は狭義単調増加なので、この区間での二分法は正しい根に収束する

`pressureOf` の単純反復がこの根に収束するかは別問題で、収縮率は `2 μ |w'(a)|`、
`|w'|` は `a → 1` で `π/4` に達する。`μ ≥ 2/π` では収縮しない（数値で周期 2 の振動を確認）。
-/

open Real Set Filter Topology

namespace Orowan

/-- 不均質係数。`1 / sinc (arcsin a)` は `a ≠ 0` で `arcsin a / a`、`a = 0` で `1`。 -/
noncomputable def w (a : ℝ) : ℝ := (√(1 - a ^ 2) + 1 / sinc (arcsin a)) / 2

/-- `θ = arcsin a` で書いた `w`。 -/
noncomputable def F (θ : ℝ) : ℝ := (cos θ + 1 / sinc θ) / 2

theorem w_eq_F (a : ℝ) : w a = F (arcsin a) := by
  rw [w, F, cos_arcsin]

/-- TS の `inhomogeneity` と同じ式（`a ≠ 0`）。 -/
theorem w_of_ne_zero {a : ℝ} (ha : a ≠ 0) (h1 : -1 ≤ a) (h2 : a ≤ 1) :
    w a = (√(1 - a ^ 2) + arcsin a / a) / 2 := by
  have hs : arcsin a ≠ 0 := fun h => ha (by simpa [sin_arcsin h1 h2] using congrArg sin h)
  rw [w, sinc_of_ne_zero hs, sin_arcsin h1 h2, one_div_div]

theorem w_zero : w 0 = 1 := by
  norm_num [w]

theorem w_one : w 1 = π / 4 := by
  rw [w_of_ne_zero one_ne_zero (by norm_num) le_rfl]
  norm_num [arcsin_one]
  ring

theorem sinc_pos_of_mem {θ : ℝ} (h : θ ∈ Icc 0 (π / 2)) : 0 < sinc θ := by
  rcases eq_or_lt_of_le h.1 with h0 | h0
  · simp [← h0]
  · rw [sinc_of_ne_zero h0.ne']
    exact div_pos (sin_pos_of_pos_of_lt_pi h0 (by linarith [h.2, pi_pos])) h0

theorem F_continuousOn : ContinuousOn F (Icc 0 (π / 2)) := by
  refine (continuous_cos.continuousOn.add ?_).div_const 2
  exact continuousOn_const.div continuous_sinc.continuousOn fun θ h => (sinc_pos_of_mem h).ne'

/-- 内部での `F` の導関数（`θ / sin θ` の形で微分）。 -/
theorem F_hasDerivAt {θ : ℝ} (h : θ ∈ Ioo 0 (π / 2)) :
    HasDerivAt F ((-sin θ + (1 * sin θ - θ * cos θ) / sin θ ^ 2) / 2) θ := by
  have hsin : sin θ ≠ 0 := (sin_pos_of_pos_of_lt_pi h.1 (by linarith [h.2, pi_pos])).ne'
  have hG := ((hasDerivAt_cos θ).add ((hasDerivAt_id θ).div (hasDerivAt_sin θ) hsin)).div_const 2
  refine hG.congr_of_eventuallyEq ?_
  filter_upwards [isOpen_ne.mem_nhds h.1.ne'] with x hx
  simp [F, sinc_of_ne_zero hx]

theorem F_deriv_nonpos {θ : ℝ} (h : θ ∈ Ioo 0 (π / 2)) :
    (-sin θ + (1 * sin θ - θ * cos θ) / sin θ ^ 2) / 2 ≤ 0 := by
  have hs : 0 < sin θ := sin_pos_of_pos_of_lt_pi h.1 (by linarith [h.2, pi_pos])
  have hc : 0 < cos θ := cos_pos_of_mem_Ioo ⟨by linarith [h.1, pi_pos], h.2⟩
  have hsx : sin θ ≤ θ := sin_le h.1.le
  have hc1 : cos θ ≤ 1 := cos_le_one θ
  have hpy := sin_sq_add_cos_sq θ
  have key : (1 * sin θ - θ * cos θ) / sin θ ^ 2 ≤ sin θ := by
    rw [div_le_iff₀ (by positivity)]
    nlinarith [mul_nonneg (mul_nonneg hc.le hs.le) (sub_nonneg.2 hc1),
      mul_nonneg hc.le (sub_nonneg.2 hsx)]
  linarith

theorem F_antitoneOn : AntitoneOn F (Icc 0 (π / 2)) := by
  apply antitoneOn_of_deriv_nonpos (convex_Icc _ _) F_continuousOn
  · rw [interior_Icc]
    exact fun θ h => (F_hasDerivAt h).differentiableAt.differentiableWithinAt
  · rw [interior_Icc]
    intro θ h
    rw [(F_hasDerivAt h).deriv]
    exact F_deriv_nonpos h

theorem arcsin_mem {a : ℝ} (h : a ∈ Icc (0 : ℝ) 1) : arcsin a ∈ Icc 0 (π / 2) :=
  ⟨arcsin_nonneg.2 h.1, arcsin_le_pi_div_two a⟩

/-- **`w` は `[0, 1]` で単調減少。** -/
theorem w_antitoneOn : AntitoneOn w (Icc 0 1) := by
  intro a ha b hb hab
  rw [w_eq_F, w_eq_F]
  exact F_antitoneOn (arcsin_mem ha) (arcsin_mem hb) (monotone_arcsin hab)

theorem w_continuousOn : ContinuousOn w (Icc 0 1) := by
  have : w = F ∘ arcsin := funext w_eq_F
  rw [this]
  exact F_continuousOn.comp continuous_arcsin.continuousOn fun a h => arcsin_mem h

theorem w_bounds {a : ℝ} (h : a ∈ Icc (0 : ℝ) 1) : π / 4 ≤ w a ∧ w a ≤ 1 := by
  constructor
  · rw [← w_one]; exact w_antitoneOn h ⟨zero_le_one, le_rfl⟩ h.2
  · rw [← w_zero]; exact w_antitoneOn ⟨le_rfl, zero_le_one⟩ h h.1

/-! ## 圧力の方程式 -/

/-- `pressureOf` が解く方程式の右辺 `T(p) = max(q + w(min(1, 2μp/kf)) kf, 0)`。 -/
noncomputable def T (μ kf q p : ℝ) : ℝ := max (q + w (min 1 (2 * μ * p / kf)) * kf) 0

/-- 探索区間の下端（sticking の圧力）と上端。 -/
noncomputable def lo (kf q : ℝ) : ℝ := max (q + π / 4 * kf) 0
noncomputable def hi (kf q : ℝ) : ℝ := max (q + kf) 0

variable {μ kf q : ℝ}

theorem ratio_mem (hμ : 0 ≤ μ) (hkf : 0 < kf) {p : ℝ} (hp : 0 ≤ p) :
    min 1 (2 * μ * p / kf) ∈ Icc (0 : ℝ) 1 :=
  ⟨le_min zero_le_one (by positivity), min_le_left _ _⟩

theorem T_mem (hμ : 0 ≤ μ) (hkf : 0 < kf) {p : ℝ} (hp : 0 ≤ p) :
    T μ kf q p ∈ Icc (lo kf q) (hi kf q) := by
  obtain ⟨h1, h2⟩ := w_bounds (ratio_mem hμ hkf hp)
  constructor <;> apply max_le_max _ le_rfl <;> nlinarith

theorem lo_le_hi (hkf : 0 < kf) : lo kf q ≤ hi kf q :=
  max_le_max (by nlinarith [pi_le_four]) le_rfl

theorem T_antitoneOn (hμ : 0 ≤ μ) (hkf : 0 < kf) : AntitoneOn (T μ kf q) (Ici 0) := by
  intro p hp p' hp' hpp'
  have hw := w_antitoneOn (ratio_mem hμ hkf hp) (ratio_mem hμ hkf hp')
    (min_le_min_left _ (by gcongr))
  exact max_le_max (by nlinarith) le_rfl

theorem T_continuousOn (hμ : 0 ≤ μ) (hkf : 0 < kf) : ContinuousOn (T μ kf q) (Ici 0) := by
  have hr : ContinuousOn (fun p => min 1 (2 * μ * p / kf)) (Ici 0) := by fun_prop
  have hw := w_continuousOn.comp hr fun p hp => ratio_mem hμ hkf hp
  have hin : ContinuousOn (fun p => q + w (min 1 (2 * μ * p / kf)) * kf) (Ici 0) :=
    continuousOn_const.add (hw.mul continuousOn_const)
  exact hin.sup continuousOn_const  -- ℝ では `⊔` が `max`

/-- **`g(p) = p - T(p)` は狭義単調増加** — 二分法が使える根拠。 -/
theorem residual_strictMonoOn (hμ : 0 ≤ μ) (hkf : 0 < kf) :
    StrictMonoOn (fun p => p - T μ kf q p) (Ici 0) := by
  intro p hp p' hp' h
  have := T_antitoneOn (q := q) hμ hkf hp hp' h.le
  simp only
  linarith

/-- **解はどんな `μ ≥ 0` でもただ 1 つで、`[lo, hi]` に入る。** -/
theorem pressure_existsUnique (hμ : 0 ≤ μ) (hkf : 0 < kf) :
    ∃! p, T μ kf q p = p ∧ p ∈ Icc (lo kf q) (hi kf q) := by
  have lo0 : 0 ≤ lo kf q := le_max_right _ _
  have hsub : Icc (lo kf q) (hi kf q) ⊆ Ici 0 := fun p h => lo0.trans h.1
  have hg : ContinuousOn (fun p => p - T μ kf q p) (Icc (lo kf q) (hi kf q)) :=
    (continuousOn_id.sub (T_continuousOn hμ hkf)).mono hsub
  have hle : (lo kf q - T μ kf q (lo kf q)) ≤ 0 := by
    linarith [(T_mem (q := q) hμ hkf lo0).1]
  have hge : 0 ≤ (hi kf q - T μ kf q (hi kf q)) := by
    linarith [(T_mem (q := q) hμ hkf (lo0.trans (lo_le_hi hkf))).2]
  obtain ⟨p, hp, hp0⟩ := intermediate_value_Icc (lo_le_hi hkf) hg ⟨hle, hge⟩
  refine ⟨p, ⟨by simp only at hp0; linarith, hp⟩, fun p' ⟨hp', hmem⟩ => ?_⟩
  by_contra hne
  have hfix : ∀ x, T μ kf q x = x → x - T μ kf q x = 0 := fun x hx => by rw [hx]; ring
  exact hne ((residual_strictMonoOn hμ hkf).injOn (hsub hmem) (hsub hp)
    (by simp only at hp0 ⊢; rw [hfix p' hp', hp0]))

/-- sticking の分岐: `2 μ lo ≥ kf` なら `lo` そのものが解（`pressureOf` の早期 return）。 -/
theorem stick_isFixed (hkf : 0 < kf) (h : kf ≤ 2 * μ * lo kf q) :
    T μ kf q (lo kf q) = lo kf q := by
  rw [T, min_eq_left ((one_le_div hkf).2 h), w_one, lo]

end Orowan
