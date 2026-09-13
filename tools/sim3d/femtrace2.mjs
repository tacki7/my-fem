import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const p = defaultParams(process.argv[2]); Object.assign(p, JSON.parse(process.argv[3] ?? '{}'));
const sv = new StackSolver(p);
let last = -1;
for (let f = 0; f < +(process.argv[4] ?? 600); f++) {
  sv.advance(1e9, 1);
  const c = sv.femLastChange;
  if (c !== last) { const R = sv.result; console.log(f, 'S', (R.screw*1e6).toFixed(0), 'res', R.residual.toExponential(1), 'change', c.toExponential(2), 'F', (R.force/9806.65).toFixed(1), 'h1', (R.h1Mean*1e6).toFixed(2), 'femIts', sv.femResult?.iterations, sv.femResult?.converged, 'conv', R.converged); last = c; }
  if (sv.isConverged) { console.log('CONVERGED at', f); break; }
}
