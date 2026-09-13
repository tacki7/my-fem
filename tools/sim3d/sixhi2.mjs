// More 6Hi shift cases: leveling on a flat pass, control modes, strip models, extremes.
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const TONF = 9.80665e3;
const CASES = [
  ['shift-50 lev+100 fem', { irShift: -0.05, leveling: 100e-6 }],
  ['shift-50 lev+100 slab', { irShift: -0.05, leveling: 100e-6, stripModel: 'slab' }],
  ['shift-50 lev+100 noTFB', { irShift: -0.05, leveling: 100e-6, stripModel: 'slab', tensionFeedback: false }],
  ['s0 lev+100 noTFB', { irLb: 1.0, leveling: 100e-6, stripModel: 'slab', tensionFeedback: false }],
  ['s1um lev+100 noTFB', { irLb: 1.0 - 2e-6, leveling: 100e-6, stripModel: 'slab', tensionFeedback: false }],
  ['force 1500', { mode: 'force', targetForce: 1500 * TONF }],
  ['screw 2.5', { mode: 'screw', screw: 2.5e-3 }],
  ['fem3d', { stripModel: 'fem3d' }],
  ['ring', { flatModel: 'ring' }],
  ['W 300', { width: 0.3 }],
  ['W 1600', { width: 1.6 }],
  ['irShift +150', { irShift: 0.15 }],
  ['irShift -150', { irShift: -0.15 }],
  ['irLb 800 (s>0)', { irLb: 0.8 }],
  ['stations 21', { stations: 21 }],
  ['stations 241', { stations: 241 }],
  ['preset thin', { h0: 0.001, reduction: 0.2, irShift: 0 }],
  ['benders 200', { irBender: 200 * TONF, wrBender: 200 * TONF }],
  ['WR bender -60', { wrBender: -60 * TONF }],
];
const only = process.argv[2];
for (const [label, patch] of CASES) {
  if (only && !label.includes(only)) continue;
  const p = { ...defaultParams('6hi'), ...patch };
  const sv = new StackSolver(p);
  const t0 = performance.now();
  let it = 0, nan = false;
  for (let f = 0; f < 4000; f++) {
    sv.advance(1e9, 6); it += sv.result.iterations;
    if (!Number.isFinite(sv.result.force) || sv.u.some((v) => !Number.isFinite(v))) { nan = true; break; }
    if (sv.isConverged || performance.now() - t0 > 90000) break;
  }
  const R = sv.result;
  const ns = R.x.length, nU = R.rolls.length, all = sv.rolls;
  let dPt = 0, dMir = 0;
  if (all.length > nU) {
    for (let r = 0; r < nU; r++) for (let s = 0; s < ns; s++) {
      const a = all[r].v[s], b = all[nU + r].v[ns - 1 - s], c = all[nU + r].v[s];
      if (Number.isFinite(a) && Number.isFinite(b)) dPt = Math.max(dPt, Math.abs(a - b));
      if (Number.isFinite(a) && Number.isFinite(c)) dMir = Math.max(dMir, Math.abs(a - c));
    }
  }
  const slices = sv.slices.length;
  console.log(`${label.padEnd(24)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms ${String(it).padStart(4)} it | F ${(R.force / TONF).toFixed(1)} S ${(R.screw * 1e3).toFixed(3)} h1 ${(R.h1Mean * 1e3).toFixed(4)} C25 ${(R.crown * 1e6).toFixed(1)} wedge ${(R.wedge * 1e6).toFixed(1)} lat ${R.latentIU.toFixed(0)} man ${R.manifestIU.toFixed(0)} | slices ${slices} dx ${((R.x[1] - R.x[0]) * 1e3).toFixed(1)} mm | |vU(x)-vL(-x)| ${(dPt * 1e6).toFixed(2)} |vU-vL| ${(dMir * 1e6).toFixed(2)} µm | res ${R.residual.toExponential(1)} ${nan ? 'NaN ' : ''}${R.converged ? '' : 'NOCONV '}[${R.warnings.join(',')}] ${R.notes.join(' / ')}`);
}
