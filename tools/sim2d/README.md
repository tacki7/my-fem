# 2D FEM のヘッドレス検証

ブラウザ無しで `RollingSim`（と 3 スタンドの `Mill`）を回す。既定パラメータは `src/main.ts` の `params` を
そのまま読み出す（`params.mjs`）ので、アプリと同じ条件になる。

```bash
tools/sim2d/build.sh            # src/sim → tools/sim2d/build（git 管理外）
node tools/sim2d/solves.mjs     # 板・ロールの PCG が反復上限に届かないこと（6 条件 × 900 フレーム、約 30 s）
node tools/sim2d/mesh.mjs [旧ビルド]  # ロール半径方向の格子: 等比のコア・表示する隣接比 = 実際の比（旧ビルドを渡すと半径の移動量も出す）
node tools/sim2d/tension.mjs    # スタンド間の速度感度 dΔv/dT が正にならないこと（432 組、Bland & Ford）
```

`sim.advance(1/60)` が 1 フレーム。表示・UI の処理（`main.ts`）は通らないので、画面上の
数字の確認はブラウザで行う。
