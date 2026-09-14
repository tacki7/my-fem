// 起動確認: 2D が例外なく回り、3D タブのソルバが収束するところまで（exit 1 で FAIL）。
//
//   CDP_PORT=<cdp> node tools/browser/smoke.mjs http://localhost:<dev>
//
// 数値は見ない。2D は `?debug` のフレーム内訳でタブタイトルが毎フレーム書き換わるので、
// その書き換えを数えて「フレームが進んでいる」ことを確かめる（固定 sleep ではなく信号で待つ）。
// 3D は作業中で中身が変わるので、`window.__v3` があって `solver.advance` を回すと
// `isConverged` になることだけを見る（README「計測用クエリパラメータ」の手順）。
import { connect } from './cdp.mjs';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/smoke.mjs http://localhost:<dev>');
  process.exit(64);
}
const FRAMES = 30;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

let c;
try {
  c = await connect(process.env.CDP_PORT);
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exit(2);
}

try {
  // --- 2D ---------------------------------------------------------------------
  // tab=2d: 前回 3D を開いたことが localStorage に残っていても 2D で開く
  await c.navigate(`${base}/?debug&tab=2d`);
  await c.waitFor('window.__lab && document.title.length > 0', 60000);
  const frames = await c.evaluate(`new Promise((resolve) => {
    let n = 0;
    const title = document.querySelector('title');
    const obs = new MutationObserver(() => { if (++n >= ${FRAMES}) { obs.disconnect(); resolve(n); } });
    obs.observe(title, { childList: true, characterData: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(n); }, 120000);
  })`);
  check('2D: frames advance', frames >= FRAMES, `${frames} title updates (want ${FRAMES})`);
  const lab = await c.evaluate('({ running: __lab.running, stands: __lab.stands().length, finite: __lab.stands().every((s) => Number.isFinite(s.loadTonf)) })');
  check('2D: solve running with finite loads', lab.running && lab.stands > 0 && lab.finite, JSON.stringify(lab));
  check('2D: no exception or console error/warning', c.errors.length === 0, c.errors.slice(0, 3).join(' | '));

  // --- 3D ---------------------------------------------------------------------
  const before = c.errors.length;
  await c.navigate(`${base}/?tab=3d`);
  // a boolean, not the solver: returned by value the solver is 0.9 MB at 81 stations and 8.5 MB at
  // 301 (4Hi), and at 301 the DevTools socket closed (1006) before it arrived - the run then ended on
  // the unsettled await with no FAIL line
  await c.waitFor('!!(window.__v3 && window.__v3.solver)', 60000);
  const r3 = await c.evaluate(`(() => {
    const s = window.__v3.solver, t0 = performance.now();
    let calls = 0;
    while (!s.isConverged && performance.now() - t0 < 180000) { s.advance(1e9, 6); calls++; }
    return { converged: s.isConverged, calls, ms: Math.round(performance.now() - t0) };
  })()`);
  check('3D: __v3 solver converges', r3.converged, JSON.stringify(r3));
  check('3D: no exception or console error/warning', c.errors.length === before, c.errors.slice(before, before + 3).join(' | '));

  // 次に開く人が 3D から始まらないよう、覚えているタブを 2D に戻す
  await c.evaluate("(() => { try { localStorage.setItem('rollfem.mode', '2d'); } catch {} return true; })()");
} catch (e) {
  check('smoke run', false, String(e?.message ?? e));
} finally {
  c.close();
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
