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
