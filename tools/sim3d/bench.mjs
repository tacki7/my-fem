// Speed and result benchmark for the 3D tab's solver.
//   node tools/sim3d/bench.mjs [out.json]
// Runs a fixed set of cases to convergence from cold, plus re-convergence
// after a small dial change, and prints time, iterations and the headline
// results so a change to the numerics can be checked for both speed and
// sameness of answer.
import { writeFileSync } from 'node:fs';
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const TONF = 9.80665e3;
const CASES = [
  ['4hi', { stripModel: 'slab' }, 'slab'],
  ['20hi', { stripModel: 'slab' }, 'slab'],
  ['2hi', {}, 'fem'],
  ['4hi', {}, 'fem'],
  ['6hi', {}, 'fem'],
  ['12hi', {}, 'fem'],
  ['20hi', {}, 'fem'],
  ['4hi', { mode: 'force', targetForce: 1500 * TONF }, 'fem force'],
  ['20hi', { mode: 'force', targetForce: 150 * TONF }, 'fem force'],
  ['4hi', { mode: 'screw', screw: 2e-3 }, 'fem screw'],
  ['20hi', { leveling: 300e-6 }, 'fem leveling'],
  ['20hi', { wrCrown: -400e-6 }, 'fem crown-400'],
  ['12hi', { stations: 21 }, 'fem st21'],
  ['6hi', { irBender: 200 * TONF, wrBender: 200 * TONF }, 'fem benders200'],
  ['4hi', { stripModel: 'fem3d' }, 'fem3d'],
  ['20hi', { stripModel: 'fem3d' }, 'fem3d'],
];
const only = process.argv[3];
const out = [];
const run = (mill, patch, label, change) => {
  const p = defaultParams(mill); Object.assign(p, patch);
  const sv = new StackSolver(p);
  let t0 = performance.now(), it = 0;
  const cap = 90000;
  for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged || performance.now() - t0 > cap) break; }
  const cold = { ms: performance.now() - t0, it };
  const R = sv.result;
  const res = { F: R.force / TONF, S: R.screw * 1e3, h1: R.h1Mean * 1e3, C25: R.crown * 1e6, edge: R.edgeDropL * 1e6, lat: R.latentIU, man: R.manifestIU, conv: R.converged, warn: R.warnings.join(',') };
  let warm = null;
  if (change) {
    const p2 = { ...sv.p, mu: sv.p.mu * 1.08, asu: [...sv.p.asu], asu2: [...sv.p.asu2] };
    sv.setParams(p2);
    t0 = performance.now(); it = 0;
    for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged || performance.now() - t0 > cap) break; }
    warm = { ms: performance.now() - t0, it, F: sv.result.force / TONF, conv: sv.result.converged };
  }
  return { mill, label, cold, res, warm };
};
for (const [mill, patch, label] of CASES) {
  if (only && !`${mill} ${label}`.includes(only)) continue;
  const r = run(mill, patch, label, !label.includes('screw'));
  out.push(r);
  const w = r.warm ? ` | μ+8%: ${r.warm.ms.toFixed(0)} ms ${r.warm.it} it F ${r.warm.F.toFixed(1)}${r.warm.conv ? '' : ' NOCONV'}` : '';
  console.log(`${(mill + ' ' + label).padEnd(22)} cold ${r.cold.ms.toFixed(0).padStart(6)} ms ${String(r.cold.it).padStart(5)} it | F ${r.res.F.toFixed(1).padStart(7)} S ${r.res.S.toFixed(3)} h1 ${r.res.h1.toFixed(4)} C25 ${r.res.C25.toFixed(1)} lat ${r.res.lat.toFixed(0)} ${r.res.conv ? '' : 'NOCONV '}[${r.res.warn}]${w}`);
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
