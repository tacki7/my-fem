// 6Hi intermediate-shift checks: headline results per case, and - when the
// lower half is solved - how far the solution is from point symmetry.
//   node tools/sim3d/sixhi.mjs [filter]
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const TONF = 9.80665e3;
const CASES = [
  ['default', {}],
  ['shift +100', { irShift: 0.1 }],
  ['shift +50', { irShift: 0.05 }],
  ['shift -50', { irShift: -0.05 }],
  ['lev +100', { leveling: 100e-6 }],
  ['lev -100', { leveling: -100e-6 }],
  ['bender WR60', { wrBender: 60 * TONF }],
  ['bender IR100', { irBender: 100 * TONF }],
  ['slab', { stripModel: 'slab' }],
  ['slab lev +100', { stripModel: 'slab', leveling: 100e-6 }],
  ['sym barrel s=0', { irLb: 1.0 }],
  ['sym barrel s=1um', { irLb: 1.0 - 2e-6 }],
  ['sym s=0 lev+100', { irLb: 1.0, leveling: 100e-6 }],
  ['sym s=1um lev+100', { irLb: 1.0 - 2e-6, leveling: 100e-6 }],
];
const only = process.argv[2];
for (const [label, patch] of CASES) {
  if (only && !label.includes(only)) continue;
  const p = { ...defaultParams('6hi'), ...patch };
  const sv = new StackSolver(p);
  const t0 = performance.now();
  let it = 0;
  for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged || performance.now() - t0 > 60000) break; }
  const R = sv.result;
  const ns = R.x.length;
  // symmetry of the strip, and of the upper against the lower half when there is one
  let h1Asym = 0;
  for (let s = 0; s < ns; s++) {
    const a = R.h1[s], b = R.h1[ns - 1 - s];
    if (Number.isFinite(a) && Number.isFinite(b)) h1Asym = Math.max(h1Asym, Math.abs(a - b));
  }
  const all = sv.rolls, nU = R.rolls.length;
  let pt = '';
  if (all.length > nU) {
    let d = 0, vm = 0;
    for (let r = 0; r < nU; r++) {
      for (let s = 0; s < ns; s++) {
        const a = all[r].v[s], b = all[nU + r].v[ns - 1 - s];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        d = Math.max(d, Math.abs(a - b)); vm = Math.max(vm, Math.abs(a));
      }
    }
    pt = ` | point-sym |vU(x)-vL(-x)| ${(d * 1e6).toFixed(3)} µm of ${(vm * 1e6).toFixed(0)}`;
  }
  const wr = R.rolls[0];
  const vAt = (x) => { const s = Math.round((x - R.x[0]) / (R.x[1] - R.x[0])); return wr.v[s]; };
  const ir = R.rolls[1];
  const cIR = R.contacts.find((c) => c.a === 0 && c.b === 1);
  console.log(`${label.padEnd(18)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms ${String(it).padStart(4)} it | F ${(R.force / TONF).toFixed(1)} S ${(R.screw * 1e3).toFixed(3)} C25 ${(R.crown * 1e6).toFixed(1)} wedge ${(R.wedge * 1e6).toFixed(1)} edgeL ${(R.edgeDropL * 1e6).toFixed(1)} edgeR ${(R.edgeDropR * 1e6).toFixed(1)} lat ${R.latentIU.toFixed(0)} man ${R.manifestIU.toFixed(0)} | WR v(-0.5) ${(vAt(-0.5) * 1e6).toFixed(0)} v(0) ${(vAt(0) * 1e6).toFixed(0)} v(0.5) ${(vAt(0.5) * 1e6).toFixed(0)} µm | IR shift ${(ir.def.shift * 1e3).toFixed(0)} Lb ${(ir.def.Lb * 1e3).toFixed(0)} WR-IR ${(cIR.total / TONF).toFixed(0)} tonf | h1 asym ${(h1Asym * 1e6).toFixed(3)} µm${pt} | dof ${R.dof} hb ${R.bandwidth} ${R.converged ? '' : 'NOCONV '}[${R.warnings.join(',')}]`);
}
