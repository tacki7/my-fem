import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const p = defaultParams(process.argv[2] ?? '4hi'); Object.assign(p, JSON.parse(process.argv[3] ?? '{}'));
const sv = new StackSolver(p);
const N = +(process.argv[4] ?? 60);
let lastRatio = null;
for (let f = 0; f < N; f++) {
  sv.advance(1e9, 1);
  const R = sv.result; const r = sv.femRatio; const e = sv.femEps;
  let rmin = 1, rmax = 1, emax = 0, dr = 0;
  if (r) { for (let i = 0; i < r.length; i++) { rmin = Math.min(rmin, r[i]); rmax = Math.max(rmax, r[i]); emax = Math.max(emax, Math.abs(e[i])); if (lastRatio) dr = Math.max(dr, Math.abs(r[i] - lastRatio[i])); } lastRatio = Float64Array.from(r); }
  const fr = sv.femResult;
  if (f < 20 || f % 5 === 0) console.log(f, 'S', (R.screw * 1e6).toFixed(0), 'res', R.residual.toExponential(1), 'step', R.stepMax.toExponential(1), 'F', (R.force / 9806.65).toFixed(1), 'h1c', (R.h1Centre * 1e6).toFixed(1), 'ratio', rmin.toFixed(3), rmax.toFixed(3), 'dratio', dr.toExponential(1), 'epsOff', emax.toExponential(1), 'femIts', fr?.iterations, fr?.converged, 'mass', fr?.massRatio.toFixed(4), 'a', sv.debug?.alpha.toExponential(1));
}
