# 数値解法の前提の証明（Lean 4 + Mathlib）

コードが黙って頼っている数学的性質を Lean で証明したもの。証明で必要になった仮定は、
コード側の分岐・区間・チェックに落としてある。

| ファイル | 対応するコード | 示したこと |
|---|---|---|
| `Orowan.lean` | `src/sim/slab.ts` `orowanPressure` | Prandtl の w(a) は [0, 1] で単調減少（1 → π/4）。圧力の方程式 `p = max(q + w(min(1, 2μp/kf))·kf, 0)` の解は μ ≥ 0・kf > 0 ならただ 1 つで、`[max(q + π/4·kf, 0), max(q + kf, 0)]` にある。残差 `p − T(p)` は狭義単調増加（区間での求根が正しい根に収束する根拠） |
| `SlabFormulas.lean` | `muinv.ts` `flatRadius`、`slab.ts` `blandFordSetup`、`solver.ts` `meanPlaneStrainLmnRange` | Hitchcock の R′ ⇔ `L² = RΔh + 4b²`、圧下ゼロで両式とも `L = 2b`、Roberts の弧はどの圧下でも Hitchcock 以上。Bland & Ford の両枝の比は kf・h によらず、中立点はただ 1 つで閉形式どおり。ひずみ平均 kf の閉形式（積分から） |
| `MuInverse.lean` | `src/sim/muinv.ts` `slabLoad` / `muFromLoad` | R から登る扁平の反復は最小の固定点に行き着く。荷重の式と扁平の式が単調性の仮定 `Hyp` を満たせば P(μ) は単調（μ に狭義なら狭義）で、発散する μ の集合は上に閉じている。Kármán × Hitchcock / Roberts は `Hyp` を満たし狭義単調（二分法の答えが一意である根拠） |

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
#print axioms MuInverse.karman_hitchcock_strictMono
#print axioms SlabFormulas.bf_neutral_iff
```

厳密値テストの生成器（証明ではなく ℚ での計算）は `tools/exact/ExactRef.lean`。

`import Mathlib`（全体）ではなく必要なモジュールだけを import しているので、メモリ 8 GB の
マシンでも 1 分半ほどで検査できる。

## 証明していないこと

- `pressureOf` の旧実装（単純反復）が μ ≥ 2/π で収束しないこと — 数値で確認しただけ
  （`docs/validation.md`「Orowan の圧力の解法」）
- Newton の傾き `w'(a) = (√(1 − a²) − w)/a` — 区間付きなので、誤っていても遅くなるだけで答えは変わらない
- 浮動小数点の丸め — 証明は実数上。実装との差は `tools/slab/orowan.mjs` が測る
- Bland & Ford と Orowan が `Hyp` を満たすこと — `tools/slab/muinv.mjs` の格子で数値確認のみ
- Roberts の `b` の係数や Hitchcock の `C = 16(1−ν²)/(πE)` が原著どおりであること — 式どうしの整合までで、
  出典との照合ではない
- `slabLoad` の反復の打ち切り（400 回・R′ 100R・刻みが 5 回伸びたら発散扱い）— 証明は打ち切りなしの
  反復についてのもの。打ち切りの影響は `docs/validation.md`「二分法の前提」
