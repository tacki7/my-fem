# スラブ法のヘッドレス検証

```bash
tools/slab/build.sh                          # src/sim/slab.ts・muinv.ts → tools/slab/build（git 管理外）
node tools/slab/orowan.mjs                   # Orowan の圧力の根・荷重の単調性・μ逆算の往復（FAIL で exit 1）
node tools/slab/muinv.mjs                    # 3 式 × 扁平 2 式: 単調性の仮定・P(μ) の単調性・発散の閉性・張力判定・往復（30〜40 s）
tools/slab/build.sh /tmp/slab-before         # 修正前のコードを別の場所にビルドしておき…
node tools/slab/orowan.mjs /tmp/slab-before  # …荷重と計算時間を並べて比べる
```

`orowan.mjs` の参照解は検査対象のコードを import せず、w(a) と右辺を書き直した上で二分法で
最後のビットまで挟んでいる。二分法が使える根拠は `docs/proofs/Orowan.lean`。
