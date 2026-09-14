# アプリ側の純関数の検証

`src/app/` は DOM に触らない（import も無い）ので、node だけで検査できる。`npm run check` に入っている。

```bash
node tools/build-esm.mjs --out tools/app/build src/app/query.ts   # → tools/app/build（git 管理外）
node tools/app/query.mjs    # クエリ文字列の読み取り: 既知のケース・旧インライン実装との突き合わせ・タブ判定・?h1= の板厚スケジュール
```
