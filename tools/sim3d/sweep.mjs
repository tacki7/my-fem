import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const mill = process.argv[2]; const key = process.argv[3]; const vals = JSON.parse(process.argv[4]); const extra = JSON.parse(process.argv[5] ?? '{}');
for (const v of vals) {
  const p = defaultParams(mill); Object.assign(p, extra); p[key] = v;
  const sv = new StackSolver(p);
  let it = 0; for (let f = 0; f < 300; f++) { sv.advance(1e9, 4); it += sv.result.iterations; if (sv.isConverged) break; }
  const R = sv.result;
  const prof = sv.slices.filter((_, i) => i % 3 === 0).map(sl => (sl.h1 * 1e6).toFixed(0)).join(' ');
  const sg = sv.slices.filter((_, i) => i % 3 === 0).map(sl => (sv.sigmaF[sl.s] / 1e6).toFixed(0)).join(' ');
  console.log(key, v, 'it', it, 'conv', R.converged, 'F', (R.force / 9806.65).toFixed(0), 'crown', (R.crown * 1e6).toFixed(0), 'edge', (R.edgeDropL * 1e6).toFixed(0), 'lat', R.latentIU.toFixed(0), 'man', R.manifestIU.toFixed(0), 'S', (R.screw*1e3).toFixed(2));
  console.log('   h1 ', prof); console.log('   sig', sg);
}
