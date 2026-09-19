// Giving up a solve that has stopped moving (`StackSolver.stall`, see `trackStall` in
// src/sim3d/solver.ts), judged by how it moves rather than by how long it has run:
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/giveup.mjs     (exit 1 on FAIL; part of npm run check)
//
// On the 4Hi and the gate's grid (81 stations, the strip on the roll's nodes, 8 rows):
// 1. A correction that circles - friction 0.01 on the plane FEM, where the strip cannot bite and
//    the load ratio swings round after round - is given up as `correction`, long before the 800
//    iterations that used to be the only rule, and says `stuck`; `advance` then does nothing more.
// 2. A target out of reach - 4000 tonf on a 300 mm strip, the slab model - is given up as
//    `target` (the screw steps and the load does not follow), and says `target`.
// 3. Solves that converge are not given up: the 4Hi default, the 4Hi at μ 0.215 with the housing
//    frame, which takes 14 correction rounds and 334 iterations to get there - the slowest of the
//    cases the rule was set on that still converges on this grid - and, on the app's own grid, a
//    WR crown of −400 µm: its first round runs on the untouched stack (a change of 0) and the
//    screw then steps, which once held the round count to that 0 and gave a solve up three
//    iterations before it converged (the counts now start over with the screw, and a round
//    that changes nothing is no measure) - and the screw opened 2 mm past the touching position
//    in the manual mode: the rolls creep shut at a residual of 1.2 for 170 iterations before they
//    meet, which a count of the merit alone gave up at 102 (a creep that gets somewhere on net
//    is not given up).
// 4. Given up is not for good: a changed setting clears it and the solve converges.
// 5. What the page says follows the reason: a stalled Newton or correction is "計算が収まらない",
//    never a target out of reach; only `target` says the target is not reached.
// 6. Before it gives up, the status line says the solve is slow (`slowText`, a third of the way
//    to the limit, in counts only): the circling correction shows it well before it is given up,
//    the 4Hi default never, and the creeping screw says it creeps rather than counting down.
// Calibrated: with the rule taken out (the solve never gives up), 1 and 2 run to the cap and FAIL.
//
// @check
// @check-build sim3d
import { StackSolver, stallText, slowText } from './build/solver.js';
import { defaultParams } from './build/stack.js';

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const GATE = { stations: 81, stripStations: 0, stripNz: 8 };
const TONF = 9.80665e3;
/** the status line's slow-solve warnings a run showed: the first (its iteration and text), and every distinct kind */
let slow = { first: null, texts: new Set() };
/** advance until converged, given up, or `cap` iterations; the iterations it took */
function run(sv, cap) {
  let n = 0;
  slow = { first: null, texts: new Set() };
  while (sv.progress().iterations < cap && !sv.isConverged && !sv.stall) {
    sv.advance(1e9, 6);
    const t = slowText(sv.progress());
    if (t) { slow.first ??= { it: sv.progress().iterations, text: t }; slow.texts.add(t.replace(/[0-9]+/g, 'N')); }
    if (++n > cap) break;
  }
  return sv.progress().iterations;
}
const said = (sv) => sv.result.warnings.join(',') || '-';

// 1. a correction that circles
{
  const p = { ...defaultParams('4hi'), ...GATE, mu: 0.01 };
  const sv = new StackSolver(p);
  const it = run(sv, 800);
  const st = sv.stall;
  report(st?.reason === 'correction' && it <= 300, 'circling correction (μ 0.01, plane FEM): given up as correction',
    `${st ? `${st.reason} at ${st.iterations} iterations, ${st.quietRounds} rounds without the change halving` : `not given up in ${it} iterations`} (the old rule: 800)`);
  report(sv.result.warnings.includes('stuck') && !sv.isConverged, '  it says stuck and is not converged', `warnings ${said(sv)}`);
  const before = sv.progress().iterations;
  const moved = sv.advance(1e9, 6);
  report(!moved && sv.progress().iterations === before, '  advance does nothing more once given up', `moved ${moved}, iterations ${before} → ${sv.progress().iterations}`);
  const text = st ? stallText(st, p) : null;
  report(!!text && text.why.includes('計算が収まらない') && !text.why.includes('届かない'), '  the page says it does not settle, not that the target is out of reach', text ? text.why : '-');
  report(!!slow.first && slow.first.it < it - 30 && slow.first.text.includes('補正') && slow.first.text.includes('見切りまで'),
    '  the status line said it was slow well before it gave up', slow.first ? `from ${slow.first.it} (given up at ${it}): ${slow.first.text}` : 'never');

  // 4. a changed setting clears it
  sv.setParams({ ...p, mu: 0.06 });
  report(sv.stall === null, 'a changed setting clears the stall', `stall ${JSON.stringify(sv.stall)}`);
  const it2 = run(sv, 800);
  report(sv.isConverged && sv.stall === null, '  and the solve converges', `converged ${sv.isConverged} in ${it2} iterations`);
}

// 2. a target out of reach
{
  const p = { ...defaultParams('4hi'), ...GATE, stations: 41, stripModel: 'slab', mode: 'force', targetForce: 4000 * TONF, width: 0.3 };
  const sv = new StackSolver(p);
  const it = run(sv, 600);
  const st = sv.stall;
  report(st?.reason === 'target' && it <= 200, '4000 tonf on a 300 mm strip (slab): given up as target',
    `${st ? `${st.reason} at ${st.iterations} iterations, ${st.quietSteps} screw steps without the miss halving, load ${(sv.result.force / TONF).toFixed(0)} tonf` : `not given up in ${it} iterations`}`);
  report(sv.result.warnings.includes('target'), '  it says target', `warnings ${said(sv)}`);
  const text = st ? stallText(st, p) : null;
  report(!!text && text.why.includes('荷重が目標に届かない'), '  the page says the load does not reach its target', text ? text.why : '-');
}

// 3. converging solves are left to converge
for (const [name, patch, cap] of [
  ['4Hi default', {}, 1500],
  ['4Hi μ 0.215 with the housing frame (14 rounds)', { mu: 0.215, housingMode: true }, 1500],
  ['4Hi WR crown −400 µm on the app\'s grid (a screw step after a round of nothing)', { wrCrown: -400e-6, stations: 301, stripStations: 281, stripNz: 16 }, 1500],
  ['4Hi screw −2 mm, manual (the rolls creep shut)', { mode: 'screw', screw: -2e-3 }, 1500],
]) {
  const sv = new StackSolver({ ...defaultParams('4hi'), ...GATE, ...patch });
  const it = run(sv, cap);
  report(sv.isConverged && sv.stall === null, `${name}: converges, not given up`,
    `converged ${sv.isConverged} in ${it} iterations${sv.stall ? `, given up as ${sv.stall.reason} at ${sv.stall.iterations}` : ''}`);
  if (name === '4Hi default') report(slow.first === null, '  and never said to be slow', slow.first ? `${slow.first.it}: ${slow.first.text}` : 'never');
  if (patch.screw !== undefined) {
    const kinds = [...slow.texts];
    report(kinds.length > 0 && kinds.every((t) => t.includes('一方向に動いている')), '  the creep is said to move on, not counted down', kinds.join(' | ') || 'nothing said');
  }
}

console.log(failed ? `${failed} FAIL` : 'all PASS');
process.exit(failed ? 1 : 0);
