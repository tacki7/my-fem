import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
import { loadAt, approach } from './build/contact.js';
import { sliceLoad, springback } from './build/strip.js';
const TONF = 9.80665e3;
const p = defaultParams(process.argv[2] ?? '4hi'); Object.assign(p, JSON.parse(process.argv[3] ?? '{}'));
const sv = new StackSolver(p);
for (let f = 0; f < 300; f++) { sv.advance(1e9, 6); if (sv.isConverged) break; }
const R = sv.result, st = sv.stack, u = sv.u, nr = sv.nr;
// the solver's own numbering and gap: vertical stacks number v and w as
// separate blocks, and a stack with a shifted roll solves its lower half
const idx = (s, r, d) => sv.idx(s, r, d);
console.log(p.mill, 'converged', R.converged, 'F', (R.force / TONF).toFixed(1), 'tonf');
// 1. equilibrium per roll - every solved roll, the lower half's too (R.rolls/R.contacts hold only the upper half)
const allRolls = sv.rolls, allContacts = sv.contacts;
for (let r = 0; r < nr; r++) {
  let fy = 0, fz = 0;
  for (const c of allContacts) {
    let F = 0; for (let s = 0; s < R.x.length; s++) F += c.q[s] * c.weight[s];
    if (c.a === r) { fy -= F * c.ny; fz -= F * c.nz; }
    if (c.b === r) { fy += F * c.ny; fz += F * c.nz; }
  }
  if (r === st.wr || r === sv.wrLower) fy += R.force;
  const roll = allRolls[r];
  let ry = 0;
  roll.reactions.forEach((v) => { ry += roll.def.support === 'chock' ? v : -v; });
  // reactions: stored as -ky(ty-u) = force the housing must supply downward; sum of contact + strip + support = 0
  console.log(`  ${roll.def.id.padEnd(6)} contacts+strip fy=${(fy / TONF).toFixed(2).padStart(8)} fz=${(fz / TONF).toFixed(2).padStart(8)}  support=${(ry / TONF).toFixed(2).padStart(8)}  net=${((fy + ry) / TONF).toFixed(3)} tonf`);
}
// 2. contact kinematics
for (const c of allContacts) {
  const A = allRolls[c.a], B = allRolls[c.b];
  let worst = 0, worstQ = 0, n = 0, open = 0;
  for (let s = 0; s < R.x.length; s++) {
    if (c.weight[s] <= 0) continue;
    const ia = idx(s, c.a, 0), ib = idx(s, c.b, 0);
    const gapChange = (u[ib] - u[ia]) * c.ny + (u[idx(s, c.b, 2)] - u[idx(s, c.a, 2)]) * c.nz;
    const delta = A.prof[s] + B.prof[s] - gapChange;
    const [q] = loadAt(c.law, delta, 0);
    worst = Math.max(worst, Math.abs(delta - c.delta[s]));
    worstQ = Math.max(worstQ, Math.abs(q - c.q[s]) / Math.max(c.q[s], 1));
    if (delta <= 0) open++;
    n++;
  }
  const s0 = Math.floor(R.x.length / 2);
  const [dchk] = approach(c.law, c.q[s0]);
  console.log(`  contact ${A.def.id}-${B.def.id}: stations=${n} open=${open} max|delta mismatch|=${(worst * 1e6).toExponential(1)} um  max rel q mismatch=${worstQ.toExponential(1)}  centre: delta=${(c.delta[s0] * 1e6).toFixed(1)} um q=${(c.q[s0] / 1e6).toFixed(2)} kN/mm approach(q)=${(dchk * 1e6).toFixed(1)} um  vA=${(A.v[s0] * 1e6).toFixed(1)} vB=${(B.v[s0] * 1e6).toFixed(1)} profA=${(A.prof[s0] * 1e6).toFixed(1)} profB=${(B.prof[s0] * 1e6).toFixed(1)} n=(${c.ny.toFixed(2)},${c.nz.toFixed(2)})`);
}
// 3. strip
const wr = R.rolls[st.wr];
let worstH = 0, worstQ = 0;
for (const sl of sv.slices) {
  const v = u[idx(sl.s, st.wr, 0)];
  const g = sv.gapAt(sl.s);
  const [flat] = approach({ ...sv.wsLaw, bFloor: sl.arc / 2 }, sl.q);
  const r = sliceLoad(sv.law, sl.h0, sl.h1, p.backTension, sv.sigmaF[sl.s]);
  const h1 = g + 2 * flat + springback(sv.law, g + 2 * flat, r.kfExit, sv.sigmaF[sl.s]);
  worstH = Math.max(worstH, Math.abs(h1 - sl.h1)); worstQ = Math.max(worstQ, Math.abs(r.q - sl.q) / Math.max(sl.q, 1));
}
const m = sv.slices[Math.floor(sv.slices.length / 2)];
console.log(`  strip: max|h1 mismatch|=${(worstH * 1e6).toExponential(1)} um, max rel q mismatch=${worstQ.toExponential(1)}; centre: v_WR=${(u[idx(m.s, st.wr, 0)] * 1e6).toFixed(1)} prof=${(wr.prof[m.s] * 1e6).toFixed(1)} g=${(m.g * 1e6).toFixed(1)} flat=${(m.flat * 1e6).toFixed(1)} h1=${(m.h1 * 1e6).toFixed(1)} q=${(m.q / 1e6).toFixed(2)} arc=${(m.arc * 1e3).toFixed(1)}mm`);
