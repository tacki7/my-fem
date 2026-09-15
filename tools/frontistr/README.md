# FrontISTR との照合

3D タブのロールスタックモデル（ティモシェンコ梁 ＋ 線接触の扁平）を、同じロールを 3 次元ソリッド要素で解いた
FrontISTR（オープンソースの汎用 FEM）の解と突き合わせる道具。アプリの計算は変えない。

## 何を比べるか

板の荷重 q(x)（スラブ法のスライスが収束させた値）を**両方に同じだけ与える**。ロールモデルが扁平に使う Hertz の
半幅 b(x) の上に半楕円の圧力として掛け、軸受はロールモデルと同じ x = Ls/2 の断面を y に固定する（2 点支持の梁は
静定なので、たわみの形は軸受の剛性に依らない）。違いはロールの力学だけになる:

- **軸のたわみ** v(x) − v(軸受): ネックの段付きと点支持を持つ梁 vs ソリッド
- **扁平**（板の下の局所的な沈み込み）: 線接触の近似式 vs ソリッド表面の押し込み。ソリッドでは曲げのポアソン効果
  （−ν κ R²/2、上下の表面で同じ）が「表面 − 軸」に混ざるので、**下面 − 上面**で読む（2Hi は上面に荷重がない）

## 使い方

FrontISTR は Homebrew の gcc・open-mpi・metis・openblas で自前ビルドする（並列なし・OpenMP あり・MUMPS なしの最小構成で
`~/.local/bin/fistr1`。Xcode のライセンス同意が要る）。

```bash
brew install gcc open-mpi metis openblas cmake
git clone --depth 1 https://github.com/FrontISTR/FrontISTR.git ~/Software/FrontISTR && cd ~/Software/FrontISTR && mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=gcc-16 -DCMAKE_CXX_COMPILER=g++-16 -DCMAKE_Fortran_COMPILER=gfortran-16 \
  -DWITH_MPI=OFF -DWITH_OPENMP=ON -DWITH_METIS=ON -DMETIS_INCLUDE_PATH=/opt/homebrew/opt/metis/include -DMETIS_LIBRARIES=/opt/homebrew/opt/metis/lib/libmetis.dylib \
  -DWITH_MUMPS=OFF -DWITH_ML=OFF -DWITH_LAPACK=ON -DBLAS_LIBRARIES=/opt/homebrew/opt/openblas/lib/libopenblas.dylib -DLAPACK_LIBRARIES=/opt/homebrew/opt/openblas/lib/libopenblas.dylib \
  -DWITH_REFINER=OFF -DWITH_TOOLS=ON -DCMAKE_INSTALL_PREFIX=$HOME/.local
make -j4 && make install
```

```bash
node tools/build-esm.mjs sim3d
node tools/frontistr/case.mjs                     # 2Hi 既定（関門の格子 81/0/8）を解き、tools/frontistr/run/2hi/ に roll.msh・roll.cnt・hecmw_ctrl.dat・reference.json
tools/frontistr/run.sh tools/frontistr/run/2hi    # fistr1（節点 6.4 万、CG、約 20 s）
node tools/frontistr/compare.mjs                  # 駅ごとの表（run/2hi/compare.txt に写しがある）
```

`case.mjs [outdir] ['{"param":value}']` で条件を変えられる（`Params3D` のキー）。`run/` は git 管理外。

## 結果（2Hi 既定、2026-09-15、FrontISTR 5.9）

| 位置 x [mm] | q [kN/mm] | たわみ 梁 [µm] | たわみ FEM [µm] | 差 | 扁平 近似式 [µm] | 扁平 FEM [µm] | 差 |
|---|---|---|---|---|---|---|---|
| 0 | 2.8 | 2982.9 | 3039.2 | +56 (+1.9 %) | 37.3 | 44.7 | +7 |
| 262.5 | 13.5 | 2815.4 | 2872.5 | +57 | 170.5 | 174.9 | +4 |
| 367.5 | 23.1 | 2649.9 | 2707.8 | +58 | 307.1 | 283.4 | −24 |
| 446.3 | 40.4 | 2485.6 | 2545.7 | +60 | 419.5 | 407.7 | −12 |
| 472.5 | 60.9 | 2422.6 | 2484.7 | +62 | 460.7 | 502.0 | +41 |
| 498.8 | 67.3 | 2354.8 | 2420.6 | +66 | 334.5 | 330.5 | −4 |
| 787.5（胴端） | — | 1449.4 | 1519.8 | +70 | — | — | — |
| 945.0（ネック） | — | 633.6 | 674.2 | +41 | — | — | — |

- 軸のたわみ: ソリッドの方が全域で 2〜3 %（56〜70 µm）柔らかい。胴端 → ネックの勾配（787.5 → 840 mm で −244 µm）は両者同じ
- 扁平: 荷重の大きい所（q 13〜67 kN/mm、扁平 170〜500 µm）で ±10 µm 以内。例外は板端の手前 x = 472.5 mm（q が 40 → 61 → 67 kN/mm と急に立ち上がる所）で FEM が 41 µm（9 %）深い — 隣の駅の荷重が効く 3 次元の広がりで、近似式は駅ごとに局所
- 「下面 − 軸」で読むと曲げのポアソン効果が −60〜−75 µm 乗る（中央で −26 µm と負になる）ので、扁平の照合には使わない
