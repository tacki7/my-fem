# ヘッドレス Chrome での確認（CDP）

画面の見た目・ブラウザでしか出ない例外・UI 操作の結果を、**人が使っている画面とブラウザに触らずに**
確かめるための道具。`screencapture` や普段の Chrome のタブは使わない。

| ファイル | 役割 |
|---|---|
| `browser.sh` | 自分専用のヘッドレス Chrome を起動・停止する（止めるのはそのポートのプロセスだけ） |
| `cdp.mjs` | 最小の CDP クライアント（Node 22+、依存なし）。**ポート必須**、待つのは式が真になるまで（固定 sleep ではない） |
| `cdp-cli.mjs` | `cdp.mjs` のコマンドライン版: `nav` / `eval` / `wait` / `shot` / `crop` |
| `smoke.mjs` | 起動確認: 2D が例外なくフレームを進める → 3D タブのソルバが収束する（FAIL で exit 1） |
| `panels.mjs` | 決定論モードの画面のパネルの中身を取り、2 回分を比べる（下の「パネルの比較」） |
| `qa3d.mjs` | 3D タブ（4Hi）を条件を変えて叩く: 全ダイヤル・乱数の条件のパス・計算中の状態の変化（下の「3D タブの QA」） |

## 使い方

ポートは作業ごとに決める（同じマシンで別の作業が dev サーバーや Chrome を立てていても衝突しないように）。
人が使う `npm run dev` の既定 5173 と、よく使われる 9222 は避ける。以下は dev 5182・CDP 9232 の例。

```bash
# 1) dev サーバー（--strictPort: ポートが埋まっていたら別のポートに逃げずに止まる）
npm run dev -- --port 5182 --strictPort &
# 2) Chrome（プロファイルは一時ディレクトリ。Chrome の場所は $CHROME で上書きできる）
tools/browser/browser.sh start 9232 "$(mktemp -d)"
# 3) 確認・操作
export CDP_PORT=9232
node tools/browser/smoke.mjs http://localhost:5182
node tools/browser/cdp-cli.mjs nav 'http://localhost:5182/?debug&stands=3'   # 読み込み中の例外・console.error/warn を表示（あれば exit 2）
node tools/browser/cdp-cli.mjs wait '__lab.stands().every(s => s.feedResidual < s.feedDeadband)' 180000
node tools/browser/cdp-cli.mjs eval '__lab.stands().map(s => ({ k: s.k, h1: s.h1, tonf: s.loadTonf }))'
node tools/browser/cdp-cli.mjs shot shot.png 1700 1050
node tools/browser/cdp-cli.mjs crop part.png 300 80 1400 240 2
# 4) 片付け（自分のポートだけ）
tools/browser/browser.sh stop 9232
lsof -ti tcp:5182 -sTCP:LISTEN | xargs kill
```

`eval` / `wait` の式は `await` を含んでよい。UI を操作するときは DOM を取って `value` を変え、
`dispatchEvent(new Event('change', { bubbles: true }))`。実キー・実クリックが要るときは
`cdp.mjs` の `send('Input.dispatchKeyEvent', …)` / `send('Input.dispatchMouseEvent', …)` を使う。

## パネルの比較（`panels.mjs`）

画面の表示を変えないはずの変更（`src/main.ts` の分割など）を、main とブランチで同じ条件の画面を取って比べる。

- `capture`: `?debug&fixeddt&stopafter=N` のページで `#left`・`#right`・`#standgrid` のテキストノードと入力欄の値を
  文書順にすべて取る（`innerText` と違い、折りたたみ中のパネルも入る）。あわせて `Object.keys(__lab)`、
  `__lab.stands()`（処理時間を除く）、読み込み中のエラーも保存する
- `compare`: 違う項目を位置つきで出し、1 つでもあれば exit 1

```bash
export CDP_PORT=9232
node tools/browser/panels.mjs capture http://localhost:5182 /path/to/main.json      # main の dev サーバーで
node tools/browser/panels.mjs capture http://localhost:5182 /path/to/branch.json    # ブランチの dev サーバーで
node tools/browser/panels.mjs compare /path/to/main.json /path/to/branch.json
```

クエリの既定は 1 スタンドと 3 スタンドの `?debug&tab=2d&fixeddt&stopafter=300`（引数で足せる。`stopafter` は必須）。
右パネルのリソース欄（処理時間の内訳と JS ヒープ、`right` の 200〜245 番付近）は同じ版を 2 回取っても揺れる。
差がそこだけなら一致とみなしてよい。先に main を 2 回取って、揺れる項目を確かめておく。

## 待ち方

- **時間ではなく信号で待つ**（CLAUDE.md「検証の基本」1・4）。ヘッドレスは rAF が間引かれることがあるので、
  フレーム数や収束フラグ（`feedResidual < feedDeadband`、制御中なら `agcSettled`）を `wait` で待つ
- `?debug` のときタブタイトルが毎フレーム書き換わる。`smoke.mjs` はこれを数えてフレームが進んでいることを見る
- 3D は `?tab=3d` の `window.__v3.solver.advance(1e9, 6)` を `isConverged` まで回せば rAF を待たない
- `?stands=1` の既定は制御モード「なし」なので `agcSettled` は真にならない。答えの分かっているケースで
  ハーネスを先に校正する

## `npm run check` に入れない理由

ブラウザ（Chrome）と dev サーバーが要るため。`npm run check` は node だけで回る関門にしてある
（CI や Linux でもそのまま回る）。画面に触る変更では、関門とは別にこの `smoke.mjs` とスクリーンショットで確かめる。

## 3D タブの QA（`qa3d.mjs`）

```bash
export CDP_PORT=9232
node tools/browser/qa3d.mjs http://localhost:5182 --quick                 # 数分: ダイヤル 1/5・パス 3 本
node tools/browser/qa3d.mjs http://localhost:5182 --solves=24 --out=qa.json   # 1 時間ほど: 全ダイヤル・パス 24 本（種は --seed）
```

1. **ダイヤル**: 左パネルの全ダイヤルを、新しいページで 1 つずつ — スライダーを両端と真ん中、読み取りに最小より小さい値・最大より大きい値・文字・空を打ち込む、▴▾ を 3 回ずつ。
   毎回、例外と console のエラー、値がダイヤルの範囲の中か、パラメータがすべて有限か、ダイヤル同士の上下限（ネック径 ≤ 直径、支持スパン ≥ 胴長）、文字や空で値が変わらないか、を見る
2. **パス**: 板幅・h₀・圧下率・張力・μ・ベンダー・クラウン・材料モデル・扁平モデル・ハウジング変形考慮モードを乱数で（種で再現）、打ち込みと選択で設定して解く。
   収束したら数値が有限・荷重が正・出側板厚が目標（板厚一定）。収束しないなら決めた時間（材料 FEM 3D は 600 s、ほかは 300 s）のうちに
   理由つきで断念（`stuck`）すること — 警告を出したまま反復を続け、画面が「反復中」のままなのは不具合として数える
3. **計算中の状態**: 計算中にダイヤル・R・Space・ハウジングモード・2D タブとの行き来・節の開閉・窓の幅を変え、例外が出ず、最後に収束して画面の状態（`running`・`stale`）がそれに付いてくるか

**収束はページの中で `__v3.solver.advance` を回して待つ**（smoke.mjs と同じ）。3D タブは `requestAnimationFrame` で解くが、ヘッドレス Chrome はページのタイマーと
rAF を間引くことがあり（1 回の setTimeout が数十秒になった）、rAF を待つと Chrome の都合を測ってしまう — 最初の版はそれで「状態を変えた後に収束しない」と誤って報告した。
画面の `running`・`stale` は、タブ自身のループ（`view3d.ts` の `tickBody`）が解いて収束させたときにしか下りない — 外で `advance` して収束させた解では上がったまま（仕様）。
なのでハーネスは収束をソルバで判定し、フラグは計算中の状態の遷移（ダイヤル・R・Space）でだけ見る。最初の全体の実行はこれを知らずに、収束したパスを全部「フラグが付いてこない」と報告した。

見つけたものは `FIND  [領域] 何をしたら・何が起きた` の行と `--out` の JSON。1 つでもあれば exit 1。`npm run check` には入れない（Chrome が要り、長い）。
一部だけ回すとき（校正・再現）は `--only=dials,passes,state`（節）、`--keys=mu,width`（ダイヤル）、`--pass=5,8`（種の並びのそのパスだけ。前のパスは引くだけで解かない）。

**校正**（2026-09-19、わざと壊したソースを dev サーバーに読ませて）:

| 壊したもの | ハーネスの報告 |
|---|---|
| μ のダイヤルが値を捨てる（`view3d.ts` の `num` の `onInput` で `mu` だけ何もしない） | ダイヤル: `mu: the slider does not move the parameter`。パス #1: `the dial mu did not take the typed 0.1316`（ほかのダイヤルの誤報なし） |
| 数字の無い文字・空を 0 と読む（`typed.ts` の `parseTyped`） | `width: typed text: text that is not a number changed the value`（`mu` も） |
| 計算中に条件を変えても止まらない（`view3d.ts` の `settingsChanged` から `running = false` を外す） | 状態: 5 件（ダイヤル・R・Space 2 回・ハウジング） |
| 打ち込みの上下限を外す（`typedValue` の clamp） | 報告なし — 手前の `valueFromShown` が範囲の中の値しか返さないので、振る舞いが変わらない（壊したことにならない） |

**最初の全体の実行**（2026-09-19、seed 20260919、24 パス、101 分（11:17〜12:59）、負荷平均 10〜60 の中）: ダイヤル 44 本 × 9 操作で報告 0。パス 24 本のうち 20 本が 66〜300 s で収束。
4 本（#5・#8・#9・#13）は 300〜600 s たっても収束も断念もせず、画面は「反復中」のまま — 警告（`stone`・`wrTouch`）は出ていた（T100）。
