// 6Hi intermediate-roll shift sweep for docs/validation.md: per shift and
// strip model the load, crown, edge drop and flatness; then leveling on a
// shifted stack (wedge) and the WR bender. Pass a build directory to run an
// older build: node tools/sim3d/irshift.mjs [buildDir]
const dir = process.argv[2] ?? './build';
// a build directory as build.sh lays it out (sim3d/ inside), or one holding the modules directly
const load = (f) => import(`${dir}/sim3d/${f}`).catch(() => import(`${dir}/${f}`));
const { StackSolver } = await load('solver.js');
const { defaultParams } = await load('stack.js');
const TONF = 9.80665e3;
const run = (patch) => {
  const sv = new StackSolver({ ...defaultParams('6hi'), ...patch });
  let it = 0;
  for (let f = 0; f < 400; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  return { R: sv.result, it };
};
const row = (label, patch) => {
  const { R, it } = run(patch);
  console.log(`| ${label} | ${(R.force / TONF).toFixed(0)} | ${(R.crown * 1e6).toFixed(1)} | ${(R.wedge * 1e6).toFixed(1)} | ${(R.edgeDropL * 1e6).toFixed(1)} / ${(R.edgeDropR * 1e6).toFixed(1)} | ${R.latentIU.toFixed(0)} / ${R.manifestIU.toFixed(0)} | ${it}${R.converged ? '' : ' 未収束'} |`);
};
console.log('| 条件 | 荷重 [tonf] | C25 [µm] | ウェッジ [µm] | エッジドロップ L / R [µm] | 潜在 / 顕在 [I-unit] | 反復 |');
console.log('|---|---|---|---|---|---|---|');
for (const model of ['fem', 'slab']) {
  for (const d of [100, 50, 0, -50, -100]) row(`${model} シフト ${d > 0 ? '+' : ''}${d} mm`, { stripModel: model, irShift: d * 1e-3 });
}
for (const d of [0, -50]) for (const lev of [100, -100]) row(`fem シフト ${d} mm・レベリング ${lev > 0 ? '+' : ''}${lev} µm`, { irShift: d * 1e-3, leveling: lev * 1e-6 });
row('fem シフト 0 mm・WR ベンダー 60 tonf', { wrBender: 60 * TONF });
row('fem シフト 0 mm・IR ベンダー 100 tonf', { irBender: 100 * TONF });
