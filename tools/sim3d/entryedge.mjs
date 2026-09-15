// Entry edge drop sweep for docs/validation.md: per mill (its defaults, grid
// included) and entry edge drop D over a band b, the entry's C25 and edge drop
// as the exit's are read, the exit's, the load and the flatness.
//   node tools/sim3d/entryedge.mjs [mill ...]        (all five by default)
// Pass BUILD=<dir> to run another build.
const dir = process.env.BUILD ?? './build';
// a build directory as build.sh lays it out (sim3d/ inside), or one holding the modules directly
const load = (f) => import(`${dir}/sim3d/${f}`).catch(() => import(`${dir}/${f}`));
const { StackSolver } = await load('solver.js');
const { defaultParams } = await load('stack.js');
const TONF = 9.80665e3;
const NAME = { '2hi': '2Hi', '4hi': '4Hi', '6hi': '6Hi', '12hi': '12Hi', '20hi': '20Hi' };
const CASES = [
  ['なし', { entryEdgeDrop: 0 }],
  ['50 µm / 50 mm', { entryEdgeDrop: 50e-6, entryEdgeDropWidth: 50e-3 }],
  ['200 µm / 5 mm', { entryEdgeDrop: 200e-6, entryEdgeDropWidth: 5e-3 }],
  ['200 µm / 300 mm', { entryEdgeDrop: 200e-6, entryEdgeDropWidth: 300e-3 }],
  ['−100 µm / 50 mm', { entryEdgeDrop: -100e-6, entryEdgeDropWidth: 50e-3 }],
];
const mills = process.argv.slice(2).length ? process.argv.slice(2) : ['2hi', '4hi', '6hi', '12hi', '20hi'];
const um = (v) => (v * 1e6).toFixed(1).replace('-', '−');
console.log('| 形式 | D / b | 入側 C25 / エッジドロップ [µm] | 出側 C25 / エッジドロップ [µm] | 荷重 [tonf] | 潜在 / 顕在 [I-unit] | 反復 | 警告 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const mill of mills) {
  for (const [label, patch] of CASES) {
    const sv = new StackSolver({ ...defaultParams(mill), ...patch });
    let it = 0;
    for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
    const R = sv.result;
    console.log(`| ${NAME[mill]} | ${label} | ${um(R.crown0)} / ${um(R.edgeDrop0)} | ${um(R.crown)} / ${um(R.edgeDropL)} | ${(R.force / TONF).toFixed(0)} | ${R.latentIU.toFixed(0)} / ${R.manifestIU.toFixed(0)} | ${it}${R.converged ? '' : ' 未収束'} | ${R.warnings.join(', ') || '—'} |`);
  }
}
