# スラブ法のヘッドレス検証

下のチェックは `npm run check`（2D の回帰関門一式、FAIL で非 0）にも入っている（先頭の `// @check` の印で）。個別に回すときは:

```bash
tools/slab/build.sh                          # src/sim/slab.ts・muinv.ts → tools/slab/build（git 管理外）。中身は node tools/build-esm.mjs slab [出力先]
node tools/slab/orowan.mjs                   # Orowan の圧力の根・荷重の単調性・μ逆算の往復（FAIL で exit 1）
node tools/slab/muinv.mjs                    # 3 式 × 扁平 2 式: 単調性の仮定・P(μ) の単調性・発散の閉性・張力判定・往復（約 20〜65 s — 2026-09-14、Apple M2・Node 24 の `npm run check` の中で 22〜64 s。負荷平均 10〜17 の 1 回で 28.4 s、8→4 の 1 回で 22.3 s）
node tools/slab/consistency.mjs              # Orowan の中立点と両枝の整合、フック無しの RollingSim.slabMethod = slab.ts Kármán
node tools/slab/stone.mjs                    # Stone の最小板厚の定数 0.64761 と、slabLoad（Kármán＋Hitchcock）が発散する板厚との一致
tools/slab/build.sh /tmp/slab-before         # 修正前のコードを別の場所にビルドしておき…
node tools/slab/orowan.mjs /tmp/slab-before  # …荷重と計算時間を並べて比べる
```

`orowan.mjs` の参照解は検査対象のコードを import せず、w(a) と右辺を書き直した上で二分法で
最後のビットまで挟んでいる。二分法が使える根拠は `docs/proofs/Orowan.lean`。
