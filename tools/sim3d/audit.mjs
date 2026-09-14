// Contact equilibrium and geometry of a converged 3D solve, printed roll by roll.
//   node tools/sim3d/audit.mjs [mill] ['{"param":value}']
// The invariants themselves are in audit-lib.mjs; check.mjs holds them to a tolerance.
import { defaultParams } from './build/stack.js';
import { approach } from './build/contact.js';
import { solve, equilibrium, contactKinematics, stripConsistency } from './audit-lib.mjs';
const TONF = 9.80665e3;
const p = defaultParams(process.argv[2] ?? '4hi'); Object.assign(p, JSON.parse(process.argv[3] ?? '{}'));
const { sv } = solve(p, 300);
const R = sv.result;
console.log(p.mill, 'converged', R.converged, 'F', (R.force / TONF).toFixed(1), 'tonf');
// 1. equilibrium per roll - every solved roll, the lower half's too (R.rolls/R.contacts hold only the upper half)
// reactions: stored as -ky(ty-u) = force the housing must supply downward; sum of contact + strip + support = 0
for (const e of equilibrium(sv)) {
  console.log(`  ${e.id.padEnd(6)} contacts+strip fy=${(e.fy / TONF).toFixed(2).padStart(8)} fz=${(e.fz / TONF).toFixed(2).padStart(8)}  support=${(e.support / TONF).toFixed(2).padStart(8)}  net=${(e.net / TONF).toFixed(3)} tonf`);
}
// 2. contact kinematics
const s0 = Math.floor(R.x.length / 2);
for (const k of contactKinematics(sv)) {
  const { a: A, b: B, c } = k;
  const [dchk] = approach(c.law, c.q[s0]);
  console.log(`  contact ${A.def.id}-${B.def.id}: stations=${k.stations} open=${k.open} max|delta mismatch|=${(k.deltaMismatch * 1e6).toExponential(1)} um  max rel q mismatch=${k.qRelMismatch.toExponential(1)}  centre: delta=${(c.delta[s0] * 1e6).toFixed(1)} um q=${(c.q[s0] / 1e6).toFixed(2)} kN/mm approach(q)=${(dchk * 1e6).toFixed(1)} um  vA=${(A.v[s0] * 1e6).toFixed(1)} vB=${(B.v[s0] * 1e6).toFixed(1)} profA=${(A.prof[s0] * 1e6).toFixed(1)} profB=${(B.prof[s0] * 1e6).toFixed(1)} n=(${c.ny.toFixed(2)},${c.nz.toFixed(2)})`);
}
// 3. strip - the slab load times the FEM load ratio the slice was solved with, and the solver's exit-gauge formula
const S = stripConsistency(sv, p), m = S.centre;
console.log(`  strip: max|h1 mismatch|=${(S.h1Mismatch * 1e6).toExponential(1)} um, max rel q mismatch=${S.qRelMismatch.toExponential(1)}; centre: v_WR=${(S.vWR * 1e6).toFixed(1)} prof=${(S.prof * 1e6).toFixed(1)} g=${(m.g * 1e6).toFixed(1)} flat=${(m.flat * 1e6).toFixed(1)} h1=${(m.h1 * 1e6).toFixed(1)} q=${(m.q / 1e6).toFixed(2)} k=${S.k.toFixed(3)} arc=${(m.arc * 1e3).toFixed(1)}mm`);
