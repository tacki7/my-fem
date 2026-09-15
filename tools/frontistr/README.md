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
node tools/frontistr/case.mjs 2hi                 # 2Hi 既定（関門の格子 81/0/8）を解き、tools/frontistr/run/2hi/ に roll.msh・roll.cnt・hecmw_ctrl.dat・reference.json
tools/frontistr/run.sh tools/frontistr/run/2hi    # fistr1（節点 3.4 万、線形、CG、約 16 s）
node tools/frontistr/compare.mjs tools/frontistr/run/2hi
node tools/frontistr/case.mjs 4hi                 # 4Hi 既定: WR ＋ BUR、接触（拡張 Lagrange、摩擦 0）、荷重 4 分割
tools/frontistr/run.sh tools/frontistr/run/4hi    # 節点 9.2 万、非線形、26 分（Apple M2、OpenMP 4 スレッド、他の計算と重ねて）
node tools/frontistr/compare.mjs tools/frontistr/run/4hi
```

`case.mjs <mill> [outdir] ['{"param":value}']` で条件を変えられる（`Params3D` のキー）。`run/` は git 管理外。各 `run/<mill>/compare.txt` に表の写し。

## 結果 1: 2Hi 既定（ワークロール 1 本、2026-09-15、FrontISTR 5.9）

| 位置 x [mm] | q [kN/mm] | たわみ 梁 [µm] | たわみ FEM [µm] | 差 | 扁平 近似式 [µm] | 扁平 FEM [µm] | 差 |
|---|---|---|---|---|---|---|---|
| 0 | 2.8 | 2982.9 | 3047.5 | +65 (+2.2 %) | 37.3 | 44.9 | +8 |
| 262.5 | 13.5 | 2815.4 | 2880.6 | +65 | 170.5 | 175.0 | +5 |
| 472.5 | 60.9 | 2422.6 | 2492.3 | +70 | 460.7 | 502.1 | +41 |
| 498.8 | 67.3 | 2354.8 | 2428.1 | +73 | 334.5 | 330.6 | −4 |
| 787.5（胴端） | — | 1449.4 | 1526.1 | +77 | — | — | — |

- 軸のたわみ: ソリッドの方が全域で 2〜3 %（65〜77 µm）柔らかい。胴端 → ネックの勾配は両者同じ
- 扁平: 荷重の大きい所（q 13〜67 kN/mm、扁平 170〜500 µm）で ±10 µm 以内。例外は板端の手前 x = 472.5 mm（q が 40 → 61 → 67 kN/mm と急に立ち上がる所）で FEM が 41 µm（9 %）深い — 隣の駅の荷重が効く 3 次元の広がりで、近似式は駅ごとに局所
- 「下面 − 軸」で読むと曲げのポアソン効果が −60〜−75 µm 乗る（中央で −26 µm と負になる）ので、扁平の照合には使わない

## 結果 2: 4Hi 既定（WR ＋ BUR の接触、2026-09-15）

軸のたわみは BUR の軸受断面（圧下の支持）を基準に、接触線荷重は WR 上面のスレーブ節点の接触法線力を駅ごとに集めて読む。

| 位置 x [mm] | WR 軸 モデル / FEM [µm] | BUR 軸 モデル / FEM [µm] | WR–BUR 線荷重 モデル / FEM [kN/mm] | 出側プロファイル Δh₁/2 モデル / FEM [µm] |
|---|---|---|---|---|
| 0 | 584.5 / 581.1 | 255.1 / 252.4 | 11.35 / 11.39 | 0 / 0 |
| 235.0 | 561.2 / 557.4 | 246.1 / 244.1 | 10.79 / 10.72 | −2.8 / −5.0 |
| 352.5 | 530.4 / 525.9 | 235.1 / 234.1 | 10.03 / 9.88 | −6.6 / −12.3 |
| 440.6 | 497.5 / 492.7 | 224.1 / 224.0 | 9.19 / 9.06 | −18.2 / −37.8 |
| 470.0 | 484.5 / 480.0 | 220.0 / 220.1 | 8.86 / 8.75 | −18.6 / +10.3 |
| 499.4（板端） | 470.1 / 466.6 | 215.7 / 216.0 | 8.48 / 8.43 | −109.2 / −116.5 |
| 793.1（胴端の手前） | 332.9 / 329.3 | 161.8 / 152.2 | 5.35 / 4.12 | — |
| 800.0（胴端） | — / 326.3 | — / 149.8 | — / 16.9 | — |
| 1057.5（WR チョック） | 224.9 / 216.9 | 54.3 / 52.9 | — | — |

- **軸のたわみ**: WR は全域で 3〜8 µm（585 µm に対して 1 % 前後）、BUR は 10 µm 以内（胴端の手前で最大）。梁＋Hertz の接触の組み合わせが、ソリッドどうしの接触解析と同じ形を出している
- **WR–BUR の線荷重**: 胴の中で 0.15 kN/mm（1.5 %）以内。胴端（WR・BUR とも 1.6 m で端がそろう）ではソリッドに端部の集中（16.9 kN/mm）が出て、その手前 60 mm が 4.1 と軽くなる。モデルは駅のセルに均した 5.35 で、合計は同じ
- **出側プロファイル**: 板幅の内側 400 mm では数 µm 以内、板端の駅で −7 µm。板端手前の 2 駅（441・470 mm）は ±20〜30 µm ずれる — 板の荷重が駅ごとの 1 節点リング（セル長 29 mm、接触幅 8 mm）に載っているので、ソリッド表面はリングごとの局所的なくぼみになり、荷重が急に変わる所で読みが荒れる。板の下の軸方向を細かく切れば消えるはず（下の「残るもの」）
- 解析時間 26 分（接触反復 2〜3 回 × Newton 2〜3 回 × 4 増分、CG）。MUMPS を入れれば短くなる

## 残るもの

- 板の下の軸方向の分割（駅ごとの 1 リング）を細かくし、荷重を駅の間で補間して載せる。4Hi の出側プロファイルの照合を板端まで通すにはこれが要る（節点数は 2〜3 倍）
- 6Hi（IR シフト）・20Hi のクラスタ、ベンダー、ハウジングは未着手
- FrontISTR の REACTION 出力は固定節点で 0 と読めている（出力の仕様を確認していない）。荷重の総和の検算は case.mjs 側の合計（F/4 との一致）で済ませている
