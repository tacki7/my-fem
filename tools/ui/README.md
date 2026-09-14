# 数値入力のヘッドレス検証

パネルのスライダーの数値欄に打った数を、そのダイヤルの値に戻す処理（`src/ui/typed.ts`）の検査。

```bash
node tools/build-esm.mjs --out tools/ui/build src/ui/typed.ts   # → tools/ui/build（git 管理外）
node tools/ui/typed.mjs          # FAIL で exit 1。`npm run check` にも入っている
```

ダイヤルの定義は `src/main.ts` の `slider({...})` と `src/ui3d/view3d.ts` の `slider({...})`・`num(...)` から
TypeScript の構文木で読み出す。一覧をここに持たないので、ダイヤルを足してもそのまま検査に入る。
各ダイヤルの範囲から 400 点ほど取り、表示 → 打ち返し → 表示 が同じ文字列になり、表示より 9 桁細かく
見たときに打った数との差が丸め幅の半分以下であることを見る。置き換える前の逆変換（二分法で丸めの段差の
下端に収束する）がこの検査で落ちることも確かめる。
