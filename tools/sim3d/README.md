# 3D タブのヘッドレス検証

```bash
tools/sim3d/build.sh                 # src/sim3d → tools/sim3d/build（git 管理外）。中身は node tools/build-esm.mjs sim3d（Linux でも同じ）
node tools/sim3d/check.mjs           # 3D の quick 関門（npm run check に入る。約 2 s、FAIL で exit 1）— 下の「関門」
node tools/sim3d/check.mjs --measure # 各項目が許容のどこまで来ているか（合否なし）
node tools/sim3d/table.mjs           # 5 形式の既定ケース（docs/validation.md の表）
node tools/sim3d/table.mjs '{"flatModel":"ring"}' 4hi,20hi
node tools/sim3d/stress.mjs          # 202 ケースのストレステスト（上限 1500 反復で数分、npm run check には入れない）。例外・NaN・警告なしの未収束で exit 1
node tools/sim3d/stress.mjs foil     # タグに一致するものだけ
PATCH='{"postBucklingStiffness":0.05}' node tools/sim3d/stress.mjs   # 全ケースに同じパラメータを重ねる（ケース自身の設定が後）
node tools/sim3d/postbuckling.mjs    # 座屈した後の板の剛性: 剛性 0 のビット一致・構成則の読み戻し・1/(1+βG)（npm run check に入る。約 5〜10 s）
node tools/sim3d/audit.mjs 4hi       # 接触の釣り合い・幾何・板の検算を印字（検算の式は audit-lib.mjs、check.mjs と共通）
node tools/sim3d/bench.mjs [out.json] # 速度と結果のベンチマーク（数値解法を変えたら前後で比べる）
node tools/sim3d/sixhi.mjs           # 6Hi の IR シフト: 下半分の点対称（|v上(x) − v下(−x)|）と、鏡像モデルとの経路一致
node tools/sim3d/sixhi2.mjs          # 同じ検算を制御モード・板モデル・板幅・シフト量・分割数を振って
node tools/sim3d/irshift.mjs [build] # IR シフト掃引の表（docs/validation.md）。別ビルドのディレクトリを渡すと旧コードで測る
node tools/sim3d/eta.mjs [filter]    # 推定残り時間: 収束を記録して描画込みのフレーム刻みで再生し、推定と実際の残り時間を比べる（OVERHEAD=60 で描画を重く）
node tools/sim3d/widthsweep.mjs 4hi fem 990 1040 2.5  # 板幅の掃引: 板端が分割点のセル境界をまたぐ幅（4Hi は 1028.75 mm）で板端の結果が跳ばないか
```

スクリプトは `tools/sim3d/build/` の相対パスで読むので、`cd tools/sim3d` してから
`node table.mjs` でもよい。

## 関門（`check.mjs`）

11 ケース（5 形式の既定、4Hi のスラブ法とリング扁平、6Hi の IR シフト +100 / −50 mm、6Hi の対称胴でシフト 0 と
1 µm）を解き、次を確かめる。許容は `check.mjs` の `TOL` に根拠と一緒に書いてある。

- 収束し、結果とロールのたわみに非有限値が無い。警告が基準と同じ
- 釣り合い（`audit-lib.mjs`）
  - ロールごとの力の釣り合い: |残差| / 荷重 ≤ 1e-3。0 にならないのは剛体モード止めのばね（2×10⁴ N/m）のため。今の最大は 2.4e-4
  - 接触の食い込み量と荷重が接触則どおり（1e-12）
  - 板のスライスの出側板厚（1e-10 m）と荷重
    - 荷重は、スライスを解いたときの FEM 補正比 k を掛けた式で比べる。スラブ法では 1e-8
    - 材料 FEM では収束判定の補正比の変化 2e-3 以内。今の最大は 9.0e-4
- 接触則の往復 `approach(loadAt(δ)) = δ`（δ = 10⁻⁸〜10⁻³ m、相対 1e-8）
- 6Hi の IR シフト
  - 下半分が上半分を中心まわりに回したものになっている: |v上(x) − v下(−x)| ≤ 1e-9 m
  - シフト 1 µm（上下を解く）がシフト 0（鏡像の半分を解く）と、収束判定（荷重の残差 2e-6、更新量 5e-9 m）の範囲で一致する
- 主な出力（荷重・圧下位置・平均板厚・クラウン・ウェッジ・エッジドロップ・潜在 / 顕在形状）が `check-baseline.json` と
  相対 1e-6（長さは +1e-10 m、形状は +1e-3 I-unit）で一致
  - 基準を作り直すのは計算を変えたときだけ: `node tools/sim3d/check.mjs --write-baseline`。差分を PR で見せる

**わざと壊して FAIL することを確かめた**（スクラッチのビルドで、コミットしない）:

| 壊し方 | FAIL した項目 |
|---|---|
| 下半分のシフトの向きを反転（`stack.js` の `shift: -r.shift` → `r.shift`） | 6Hi の点対称（最大 7.1e-4 m）と 6Hi の基準比較 |
| 接触則の係数を 1 % 大きく（`contact.js` の `A1`） | 全形式の基準比較（2Hi の荷重 −0.07 % など） |
| スライスの荷重に FEM 補正比を掛けない（`solver.js`） | 全ケースの板のスライスの荷重（0.06〜1.27 > 2e-3） |

`audit.mjs` は以前、スライスの荷重を補正比 k なしのスラブ法と比べていた（4Hi で 1.9e-1 と出ていたのは |k − 1|）。
出側板厚の式もソルバと違っていた（2.5e-2 µm）。どちらも `audit-lib.mjs` でソルバの式に揃え、4Hi で 4.6e-4・2.8e-12 m になった。

## 座屈した後の板の剛性（`postbuckling.mjs`）

4Hi・20Hi の既定（stations 81 +「材料 幅方向 分割数」101）で、`postBucklingStiffness` 0 の明示が既定とビット一致すること、
β 0.05・有効幅 k 1 で収束すること、結果だけから読み戻した構成則を確かめる。
- 生きたスライスの λ がそろう
- 座屈域の σ = b(free)
- 顕在 = (σ − free)/E′
- 平均張力 = 設定値
- 座屈域の伸びの傾きが 1/(1 + βG) で下がる（±20 %）

壊し方と FAIL した項目は `docs/validation.md`「座屈した後の板の剛性」の表。
