import Mathlib.Algebra.BigOperators.Fin
import Mathlib.Data.Real.Basic
import Mathlib.Tactic.Ring

/-!
# Q4 要素のヤコビアン

my-fem `src/sim/element.ts`（と同じ形の `flow.ts`）が、選択的低減積分で

* 偏差項を 2×2 Gauss（重み 1、点 ±g）で積分し、面積を `Σ det J` で取る
* 体積項を重心 1 点、重み `4 det J(0,0)` で積分する

ことの整合を、**任意の四辺形**（平行四辺形に限らない）について示す。

* `det J` は (ξ, η) の 1 次式 — ξη の項が消える（`detJ_affine`）
* だから 2×2 Gauss の和は、点の位置 g によらず `4 det J(0,0)`（`gauss_sum`）
* それは靴ひも公式の面積（`four_detJ_center`）
-/

open BigOperators

namespace Q4Jacobian

/-- ∂N/∂ξ（節点 (−1,−1) (1,−1) (1,1) (−1,1)）— `shapeDerivs` の偶数番目。 -/
noncomputable def dNxi (η : ℝ) : Fin 4 → ℝ :=
  ![-(1 - η) / 4, (1 - η) / 4, (1 + η) / 4, -(1 + η) / 4]

/-- ∂N/∂η — `shapeDerivs` の奇数番目。 -/
noncomputable def dNeta (ξ : ℝ) : Fin 4 → ℝ :=
  ![-(1 - ξ) / 4, -(1 + ξ) / 4, (1 + ξ) / 4, (1 - ξ) / 4]

/-- `J00 J11 − J01 J10`、`J00 = Σ ∂N/∂ξ x`、`J01 = Σ ∂N/∂ξ y`、`J10 = Σ ∂N/∂η x`、`J11 = Σ ∂N/∂η y`。 -/
noncomputable def detJ (x y : Fin 4 → ℝ) (ξ η : ℝ) : ℝ :=
  (∑ k, dNxi η k * x k) * (∑ k, dNeta ξ k * y k)
    - (∑ k, dNxi η k * y k) * (∑ k, dNeta ξ k * x k)

/-- **det J は ξ, η の 1 次式。** -/
theorem detJ_affine (x y : Fin 4 → ℝ) (ξ η : ℝ) :
    detJ x y ξ η = detJ x y 0 0 + ξ * (detJ x y 1 0 - detJ x y 0 0)
      + η * (detJ x y 0 1 - detJ x y 0 0) := by
  simp only [detJ, dNxi, dNeta, Fin.sum_univ_four, Matrix.cons_val_zero, Matrix.cons_val_one,
    Matrix.cons_val_two, Matrix.cons_val_three, Matrix.head_cons, Matrix.tail_cons]
  ring

/-- **2×2 Gauss（点 ±g、重み 1）の det J の和は 4 det J(0,0)** — g の値によらない。 -/
theorem gauss_sum (x y : Fin 4 → ℝ) (g : ℝ) :
    detJ x y (-g) (-g) + detJ x y g (-g) + detJ x y g g + detJ x y (-g) g = 4 * detJ x y 0 0 := by
  rw [detJ_affine x y (-g) (-g), detJ_affine x y g (-g), detJ_affine x y g g,
    detJ_affine x y (-g) g]
  ring

/-- **4 det J(0,0) は四辺形の（符号付き）面積。** 反時計回りなら正。 -/
theorem four_detJ_center (x y : Fin 4 → ℝ) :
    4 * detJ x y 0 0 =
      ((x 0 * y 1 - x 1 * y 0) + (x 1 * y 2 - x 2 * y 1)
        + (x 2 * y 3 - x 3 * y 2) + (x 3 * y 0 - x 0 * y 3)) / 2 := by
  simp only [detJ, dNxi, dNeta, Fin.sum_univ_four, Matrix.cons_val_zero, Matrix.cons_val_one,
    Matrix.cons_val_two, Matrix.cons_val_three, Matrix.head_cons, Matrix.tail_cons]
  ring

end Q4Jacobian
