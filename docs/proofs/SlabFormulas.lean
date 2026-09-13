import Mathlib.Analysis.SpecialFunctions.Integrals.Basic
import Mathlib.Analysis.SpecialFunctions.Log.Basic
import Mathlib.Analysis.SpecialFunctions.Sqrt

/-!
# スラブ法の閉形式

my-fem `src/sim/muinv.ts`（扁平の式）、`src/sim/slab.ts`（Bland & Ford の中立点）、
`src/sim/solver.ts`（`meanPlaneStrainLmnRange`）にある手で導いた式の検算。

* Hitchcock の `R' = R(1 + C P/Δh)` は `L² = RΔh + 4b²`（`b² = C R P / 4`）と同じ
  （`hitchcock_arc_sq`）。圧下ゼロで Hitchcock・Roberts とも `L = 2b`。
  Roberts の弧 `b + √(b² + RΔh)` はどの圧下でも Hitchcock の弧以上（`hitchcock_arc_le_roberts`）
* Bland & Ford の出側枝と入側枝の比は kf にも h にもよらず `exp(μ(2H − H₀))` に比例するので、
  両枝が等しくなる H はただ 1 つで、それが `H_n = H₀/2 + ln[(h₁/h₀)(f_b/f_f)]/(2μ)`（`bf_neutral_iff`）
* ひずみ平均の kf の閉形式（`kf_mean`）

係数 C や b の定義そのもの（原著の読み）は、ここでは検証できない — 2 つの式が互いに、
また圧下ゼロの Hertz 接触と整合していることまで。
-/

open Real

namespace SlabFormulas

/-! ## ロール扁平 -/

/-- Hitchcock の半径から作った弧の 2 乗: `R' Δh = R Δh + 4 b²`、`b² = C R P / 4`。 -/
theorem hitchcock_arc_sq {R C P d : ℝ} (hd : d ≠ 0) :
    R * (1 + C * P / d) * d = R * d + 4 * (C * R * P / 4) := by
  field_simp

/-- 圧下ゼロで Hitchcock の弧は `2b`。 -/
theorem hitchcock_arc_zero_draft (b2 : ℝ) : √(0 + 4 * b2) = 2 * √b2 := by
  rw [zero_add, show (4 : ℝ) * b2 = 2 ^ 2 * b2 by norm_num, Real.sqrt_mul (by norm_num),
    Real.sqrt_sq (by norm_num)]

/-- 圧下ゼロで Roberts の弧も `2b`。 -/
theorem roberts_arc_zero_draft (b2 R : ℝ) : √b2 + √(b2 + R * 0) = 2 * √b2 := by
  simp only [mul_zero, add_zero]
  ring

/-- **どの圧下でも Roberts の弧は Hitchcock の弧以上。** `b > 0`・`RΔh > 0` なら真に長い。 -/
theorem hitchcock_arc_le_roberts {b x : ℝ} (hb : 0 ≤ b) (hx : 0 ≤ x) :
    √(x + 4 * b ^ 2) ≤ b + √(b ^ 2 + x) := by
  have hs := Real.sq_sqrt (show 0 ≤ b ^ 2 + x by positivity)
  have hsb : b ≤ √(b ^ 2 + x) :=
    calc b = √(b ^ 2) := (Real.sqrt_sq hb).symm
      _ ≤ √(b ^ 2 + x) := Real.sqrt_le_sqrt (by linarith)
  rw [show b + √(b ^ 2 + x) = √((b + √(b ^ 2 + x)) ^ 2) from
    (Real.sqrt_sq (by positivity)).symm]
  exact Real.sqrt_le_sqrt (by nlinarith)

theorem hitchcock_arc_lt_roberts {b x : ℝ} (hb : 0 < b) (hx : 0 < x) :
    √(x + 4 * b ^ 2) < b + √(b ^ 2 + x) := by
  have hs := Real.sq_sqrt (show 0 ≤ b ^ 2 + x by positivity)
  have hsb : b < √(b ^ 2 + x) :=
    calc b = √(b ^ 2) := (Real.sqrt_sq hb.le).symm
      _ < √(b ^ 2 + x) := Real.sqrt_lt_sqrt (by positivity) (by linarith)
  rw [show b + √(b ^ 2 + x) = √((b + √(b ^ 2 + x)) ^ 2) from
    (Real.sqrt_sq (by positivity)).symm]
  exact Real.sqrt_lt_sqrt (by positivity) (by nlinarith)

/-! ## Bland & Ford の中立点 -/

/-- 出側枝 `kf (h/h₁) f_f e^{μH}` と入側枝 `kf (h/h₀) f_b e^{μ(H₀−H)}` の比。kf と h は消える。 -/
theorem bf_ratio {kf h h0 h1 fb ff μ H H0 : ℝ} (hkf : kf ≠ 0) (hh : h ≠ 0) (h0ne : h0 ≠ 0)
    (h1ne : h1 ≠ 0) (hfb : fb ≠ 0) :
    (kf * (h / h1) * ff * exp (μ * H)) / (kf * (h / h0) * fb * exp (μ * (H0 - H)))
      = (h0 / h1) * (ff / fb) * exp (μ * (2 * H - H0)) := by
  rw [show μ * (2 * H - H0) = μ * H - μ * (H0 - H) by ring, exp_sub]
  field_simp

/-- **両枝が等しい ⇔ H は閉形式の中立点。** 比が H に狭義単調なので交点はただ 1 つ。 -/
theorem bf_neutral_iff {kf h h0 h1 fb ff μ H H0 : ℝ} (hkf : 0 < kf) (hh : 0 < h) (h0p : 0 < h0)
    (h1p : 0 < h1) (hfb : 0 < fb) (hff : 0 < ff) (hμ : 0 < μ) :
    kf * (h / h1) * ff * exp (μ * H) = kf * (h / h0) * fb * exp (μ * (H0 - H)) ↔
      H = H0 / 2 + log ((h1 / h0) * (fb / ff)) / (2 * μ) := by
  have hA : 0 < kf * (h / h1) * ff := by positivity
  have hB : 0 < kf * (h / h0) * fb := by positivity
  have hBA : (kf * (h / h0) * fb) / (kf * (h / h1) * ff) = (h1 / h0) * (fb / ff) := by
    field_simp
  rw [← hBA, log_div hB.ne' hA.ne']
  constructor
  · intro heq
    have hl := congrArg log heq
    rw [log_mul hA.ne' (exp_pos _).ne', log_mul hB.ne' (exp_pos _).ne', log_exp, log_exp] at hl
    generalize log (kf * (h / h1) * ff) = a at hl ⊢
    generalize log (kf * (h / h0) * fb) = b at hl ⊢
    field_simp
    linear_combination hl
  · intro hH
    have hl : log (kf * (h / h1) * ff) + μ * H = log (kf * (h / h0) * fb) + μ * (H0 - H) := by
      generalize log (kf * (h / h1) * ff) = a at hH ⊢
      generalize log (kf * (h / h0) * fb) = b at hH ⊢
      rw [hH]
      field_simp
      ring
    have := congrArg exp hl
    rwa [exp_add, exp_add, exp_log hA, exp_log hB] at this

/-! ## ひずみ平均の kf -/

/-- **`(1/(e₁−e₀)) ∫ L (e+M)^N de = L [(e₁+M)^{N+1} − (e₀+M)^{N+1}] / ((N+1)(e₁−e₀))`。** -/
theorem kf_mean {L M N e0 e1 : ℝ} (hN : -1 < N) (hlt : e0 < e1) :
    (∫ e in e0..e1, L * (e + M) ^ N) / (e1 - e0)
      = L * ((e1 + M) ^ (N + 1) - (e0 + M) ^ (N + 1)) / ((N + 1) * (e1 - e0)) := by
  rw [intervalIntegral.integral_const_mul,
    intervalIntegral.integral_comp_add_right (fun x => x ^ N), integral_rpow (Or.inl hN)]
  have h1 : N + 1 ≠ 0 := by linarith
  have h2 : e1 - e0 ≠ 0 := by linarith
  field_simp

end SlabFormulas
