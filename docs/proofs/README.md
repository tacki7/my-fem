# 数値解法の前提の証明（Lean 4 + Mathlib）

コードが黙って頼っている数学的性質を Lean で証明したもの。証明で必要になった仮定は、
コード側の分岐・区間・チェックに落としてある。

| ファイル | 対応するコード | 示したこと |
|---|---|---|
| `Orowan.lean` | `src/sim/slab.ts` `orowanPressure` | Prandtl の w(a) は [0, 1] で単調減少（1 → π/4）。圧力の方程式 `p = max(q + w(min(1, 2μp/kf))·kf, 0)` の解は μ ≥ 0・kf > 0 ならただ 1 つで、`[max(q + π/4·kf, 0), max(q + kf, 0)]` にある。残差 `p − T(p)` は狭義単調増加（区間での求根が正しい根に収束する根拠） |

## 検査のしかた

Mathlib 入りの Lean プロジェクトに置いて検査する。確認したのは Lean / Mathlib `v4.34.0-rc2`。

```bash
lake +leanprover-community/mathlib4:lean-toolchain new proofs math
cd proofs && lake exe cache get
cp <my-fem>/docs/proofs/Orowan.lean Proofs/Orowan.lean
lake env lean Proofs/Orowan.lean
```

エラーが出なければ証明は通っている。`sorry` がないことは次で確かめる
（`propext` / `Classical.choice` / `Quot.sound` だけなら完全）:

```lean
#print axioms Orowan.pressure_existsUnique
```

`import Mathlib`（全体）ではなく必要なモジュールだけを import しているので、メモリ 8 GB の
マシンでも 1 分半ほどで検査できる。

## 証明していないこと

- `pressureOf` の旧実装（単純反復）が μ ≥ 2/π で収束しないこと — 数値で確認しただけ
  （`docs/validation.md`「Orowan の圧力の解法」）
- Newton の傾き `w'(a) = (√(1 − a²) − w)/a` — 区間付きなので、誤っていても遅くなるだけで答えは変わらない
- 浮動小数点の丸め — 証明は実数上。実装との差は `tools/slab/orowan.mjs` が測る
