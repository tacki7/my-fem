// 画面のパネルの中身を丸ごと取り、2 回分を比べる（使い方は README.md「パネルの比較」）。
//
//   CDP_PORT=<cdp> node tools/browser/panels.mjs capture <http://localhost:<dev>> <out.json> ['<クエリ>' …]
//   node tools/browser/panels.mjs compare <a.json> <b.json>
//
// capture: クエリごとに開き、`stopafter=N` の N 回解いて止まるのを待ってから
//   - #left・#right・#standgrid のテキストノードと入力欄の値（文書順、折りたたみ中のパネルも含む）
//   - Object.keys(__lab) と __lab.stands()（処理時間の `…Ms` を除く）
//   - 読み込み中の例外・console.error/warn
// を保存する。クエリの既定は 1 スタンドと 3 スタンドの `?debug&tab=2d&fixeddt&stopafter=300`。
// 終わったら about:blank に移る（一時停止したページでも描画で CPU を使い続けるため）。
//
// compare: 同じクエリ・同じ部分どうしを項目ごとに比べ、違う項目を出す。1 つでも違えば exit 1。
// 右パネルのリソース欄（処理時間の内訳・ヒープ）は同じ版を 2 回取っても揺れるので、差がそこだけかは読んで判断する。
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const DEFAULT_QUERIES = ['?debug&tab=2d&fixeddt&stopafter=300', '?debug&tab=2d&fixeddt&stopafter=300&stands=3'];

const DUMP = `(() => {
  const dump = (sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { const t = n.textContent.replace(/\\s+/g, ' ').trim(); if (t) out.push(t); return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'INPUT' || n.tagName === 'SELECT' || n.tagName === 'TEXTAREA') {
        out.push('[' + n.tagName + (n.type ? ':' + n.type : '') + '='
          + (n.type === 'checkbox' ? n.checked : n.value) + (n.disabled ? ' disabled' : '') + ']');
      }
      for (const ch of n.childNodes) walk(ch);
    };
    walk(root);
    return out;
  };
  return {
    left: dump('#left'), right: dump('#right'), standgrid: dump('#standgrid'),
    labKeys: Object.keys(window.__lab),
    stands: __lab.stands().map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !/Ms$/.test(k)))),
  };
})()`;

async function capture(base, out, queries) {
  const c = await connect(process.env.CDP_PORT);
  const res = {};
  try {
    for (const q of queries) {
      const n = Number(new URLSearchParams(q.replace(/^\?/, '')).get('stopafter'));
      if (!(n > 0)) throw new Error(`${q}: stopafter=N が要る（止まった状態を比べるため）`);
      c.errors.length = 0;
      await c.navigate(`${base.replace(/\/$/, '')}/${q}`);
      await c.waitFor(`window.__lab && __lab.solves >= ${n} && !__lab.running`, 300000);
      // 止まった後にも数フレーム描かせ、表示の更新（数フレームおき）を追いつかせる
      await c.evaluate('window.__panelsFrames = 0; (function f() { window.__panelsFrames++; requestAnimationFrame(f); })()');
      await c.waitFor('window.__panelsFrames > 12', 10000);
      res[q] = { ...(await c.evaluate(DUMP)), errors: [...c.errors] };
    }
  } finally {
    await c.navigate('about:blank').catch(() => {});
    c.close();
  }
  writeFileSync(out, JSON.stringify(res, null, 1));
  for (const [q, v] of Object.entries(res)) {
    console.log(`${q}  left ${v.left?.length} / right ${v.right?.length} / standgrid ${v.standgrid?.length} items, `
      + `__lab ${v.labKeys.length} keys, ${v.stands.length} stands, errors ${v.errors.length}`);
  }
}

function compare(fa, fb) {
  const a = JSON.parse(readFileSync(fa, 'utf8'));
  const b = JSON.parse(readFileSync(fb, 'utf8'));
  let differ = 0;
  for (const q of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[q] || !b[q]) { console.log(`${q}: 片方にしか無い`); differ++; continue; }
    for (const part of ['left', 'right', 'standgrid', 'labKeys']) {
      const x = a[q][part] ?? [], y = b[q][part] ?? [];
      const lines = [];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] !== y[i]) lines.push(`#${i}: ${JSON.stringify(x[i])} | ${JSON.stringify(y[i])}`);
      }
      if (lines.length) {
        differ += lines.length;
        console.log(`${q} ${part}: ${lines.length} 項目が違う（長さ ${x.length} / ${y.length}）`);
        for (const l of lines.slice(0, 20)) console.log(`    ${l.slice(0, 200)}`);
      }
    }
    if (JSON.stringify(a[q].stands) !== JSON.stringify(b[q].stands)) { console.log(`${q} stands: 違う`); differ++; }
    for (const [tag, v] of [[fa, a[q]], [fb, b[q]]]) {
      if (v.errors?.length) { console.log(`${q} errors (${tag}): ${v.errors.join(' / ')}`); differ++; }
    }
  }
  console.log(differ ? `違う項目 ${differ}` : '全部一致');
  process.exit(differ ? 1 : 0);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'capture' && args.length >= 2) await capture(args[0], args[1], args.length > 2 ? args.slice(2) : DEFAULT_QUERIES);
else if (cmd === 'compare' && args.length === 2) compare(args[0], args[1]);
else {
  console.error('usage: panels.mjs capture <base-url> <out.json> [query…] | compare <a.json> <b.json>');
  process.exit(64);
}
