# 3D タブのヘッドレス検証

```bash
tools/sim3d/build.sh                 # src/sim3d → tools/sim3d/build（git 管理外）
node tools/sim3d/table.mjs           # 5 形式の既定ケース（docs/validation.md の表）
node tools/sim3d/table.mjs '{"flatModel":"ring"}' 4hi,20hi
node tools/sim3d/stress.mjs          # 202 ケースのストレステスト（数分）
node tools/sim3d/stress.mjs foil     # タグに一致するものだけ
node tools/sim3d/audit.mjs 4hi       # 接触の釣り合い・幾何の検算
node tools/sim3d/bench.mjs [out.json] # 速度と結果のベンチマーク（数値解法を変えたら前後で比べる）
```

スクリプトは `tools/sim3d/build/` の相対パスで読むので、`cd tools/sim3d` してから
`node table.mjs` でもよい。
