import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const TONF = 9.80665e3;
const run = (mill, patch) => {
  const p = defaultParams(mill); Object.assign(p, patch);
  const sv = new StackSolver(p);
  for (let f = 0; f < 3000; f++) { sv.advance(1e9, 6); if (sv.isConverged) break; }
  const R = sv.result, sl = sv.slices, m = Math.floor(sl.length / 2);
  const W = sl.reduce((a, s) => a + s.weight, 0);
  const wr = R.rolls[sv.stack.wr];
  const bur = R.contacts[0];
  // load carried by the centre half of the strip vs the outer quarters
  let qIn = 0, qOut = 0;
  for (const s of sl) { if (Math.abs(s.x) <= p.width / 4) qIn += s.q * s.weight; else qOut += s.q * s.weight; }
  return {
    F: R.force / TONF, S: R.screw * 1e3, h1: R.h1Mean * 1e3, C25: R.crown * 1e6,
    qc: sl[m].q / 1e6, qe: sl[0].q / 1e6, h1c: sl[m].h1 * 1e6, h1e: sl[0].h1 * 1e6,
    sigc: sv.sigmaF[sl[m].s] / 1e6, sige: sv.sigmaF[sl[0].s] / 1e6,
    inner: qIn / TONF, outer: qOut / TONF, burContact: bur ? bur.total / TONF : NaN,
    bow: wr.bow * 1e6, conv: R.converged,
  };
};
const show = (label, r, base) => console.log(
  `${label.padEnd(26)} F ${r.F.toFixed(0).padStart(5)} (${(r.F - base.F >= 0 ? '+' : '') + (r.F - base.F).toFixed(0)})  S ${r.S.toFixed(3)}  h1̄ ${r.h1.toFixed(4)}  C25 ${r.C25.toFixed(0).padStart(4)}  ` +
  `中央 q ${r.qc.toFixed(2)} h1 ${r.h1c.toFixed(0)} σ ${r.sigc.toFixed(0).padStart(4)} | 板端 q ${r.qe.toFixed(2)} h1 ${r.h1e.toFixed(0)} σ ${r.sige.toFixed(0).padStart(4)} | 中央半幅 ${r.inner.toFixed(0)} 外側 ${r.outer.toFixed(0)} tonf | WR-BUR ${r.burContact.toFixed(0)}${r.conv ? '' : ' NOCONV'}`);
for (const [title, base] of [
  ['4Hi 板厚一定（既定、平面 FEM）', {}],
  ['4Hi 板厚一定 スラブ法', { stripModel: 'slab' }],
  ['4Hi 板厚一定 張力FB OFF', { tensionFeedback: false }],
  ['4Hi 圧下位置固定 S=2.464', { mode: 'screw', screw: 2.464e-3 }],
]) {
  console.log('== ' + title);
  let b0 = null;
  for (const bend of [0, 30, 60, 120]) {
    const r = run('4hi', { ...base, wrBender: bend * TONF });
    if (!b0) b0 = r;
    show(`  bender ${bend} tonf/chock`, r, b0);
  }
}
