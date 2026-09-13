# 2D 要素・組立・求解の厳密値テスト

```bash
tools/sim2d/build.sh && node tools/exact/check.mjs     # 参照値との照合（FAIL で exit 1）
```

`npm run check`（2D の回帰関門一式）にも入っている。

`reference.json` は `ExactRef.lean`（Lean 4、演算はすべて有理数 ℚ）が出力したもの。丸め誤差が
ゼロの答えと突き合わせるので、ずれはそのまま実装側の誤差か誤りになる。

| 照合 | 対象 | 何が厳密か |
|---|---|---|
| 要素剛性 8×8 | `element.ts` `precomputeElements` | 平行四辺形要素はヤコビアンが一定で、SRI の偏差項は各変数に 2 次の多項式。コードの 2×2 Gauss も ExactRef の 3×3 Simpson も厳密に積分する。体積項は同じ重心 1 点。ExactRef 側で対称・剛体 3 モードが核・ランク 5 を `#guard` 済み |
| 面積（任意の四辺形） | `element.ts` の `area`（2×2 Gauss の Σ det J） | 厳密値ではなく靴ひも公式と比べる（ジッタした凸四辺形 2000 個）。一致する理由は `docs/proofs/Q4Jacobian.lean` |
| 全体剛性 | `sparse.ts` `buildCsrPattern` + `assembleStiffness` | 4×2 要素（せん断した帯）を ℚ で密に組み立てた K。パターン外に非零が無いことも見る |
| 変位 | `band.ts` LDLᵀ、`pcgFiltered`（帯前処理・Jacobi） | 左端固定・右端荷重の K u = f を ℚ でガウス消去。ExactRef 側で K u = f を `#guard` 済み |

`check.mjs` はハーネス自身が誤りを検出できることも確かめる（ν を 1% ずらした剛性が不一致になる）。

## 参照値を作り直すとき

Mathlib 入りの Lean プロジェクト（`docs/proofs/README.md` と同じもの）で:

```bash
lake env lean ExactRef.lean > <my-fem>/tools/exact/reference.json
```

`#guard` のどれかが崩れるとエラーで止まり、JSON は出ない。
