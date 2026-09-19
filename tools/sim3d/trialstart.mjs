// The Newton's line search tries shorter steps from one starting state (see `iterate` in
// src/sim3d/solver.ts): every trial solves the strip - each slice's load fixed point and the
// tension - warm-started from the slices and the tension where the iteration started, not from
// the trial it just rejected. A slice can have two roots (a heavy pass's edge under a
// compressive front tension: the rolled one and a collapsed one), and a rejected full step that
// had jumped a slice onto the other root left it there for every shortened trial.
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/trialstart.mjs     (exit 1 on FAIL; part of npm run check)
//
// On the 4Hi with a WR crown of −400 µm on the gate's grid (81 stations, the strip on the
// roll's nodes, 8 rows), where the line search backtracks in a third of the iterations: the
// slices' loads and arcs and the strip's tension at the start of every trial of an iteration
// are the same, bit for bit.
// Calibrated: with each trial warm-started from the one before (the solver before the fix),
// 22 of the 24 iterations that backtrack start their trials from different states, and it FAILs.
//
// @check
// @check-build sim3d
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const GATE = { stations: 81, stripStations: 0, stripNz: 8 };

const sv = new StackSolver({ ...defaultParams('4hi'), ...GATE, wrCrown: -400e-6 });
// the line search's trials are the strip solves without the Jacobian (see `iterate`)
const solve = sv.stripSolve.bind(sv);
let starts = [];
sv.stripSolve = (withJacobian) => {
  if (!withJacobian) {
    starts.push([
      Float64Array.from(sv.slices, (sl) => sl.q),
      Float64Array.from(sv.slices, (sl) => sl.arc),
      Float64Array.from(sv.sigmaF),
    ]);
  }
  return solve(withJacobian);
};
const same = (a, b) => a.every((v, i) => Object.is(v, b[i]));
let backtracked = 0, apart = 0, iterations = 0;
while (!sv.isConverged && !sv.stall && iterations < 600) {
  starts = [];
  const before = sv.progress().iterations;
  sv.advance(1e9, 1);
  if (sv.progress().iterations === before) break;
  iterations = sv.progress().iterations;
  if (starts.length < 2) continue;
  backtracked++;
  if (starts.some((s) => s.some((v, k) => !same(v, starts[0][k])))) apart++;
}
report(sv.isConverged, '4Hi WR crown −400 µm (gate grid) converges', `converged ${sv.isConverged} in ${iterations} iterations`);
report(backtracked >= 5, '  the line search backtracks (the check has something to look at)', `${backtracked} of ${iterations} iterations tried more than one step`);
report(apart === 0, '  every trial of an iteration starts from the same slices and tension', `${apart} of ${backtracked} iterations started their trials from different states`);

console.log(failed ? `${failed} FAIL` : 'all PASS');
process.exit(failed ? 1 : 0);
