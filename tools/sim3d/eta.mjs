// Remaining-time estimate (src/sim3d/eta.ts) against solves whose end is known.
//   node tools/sim3d/eta.mjs [filter]      OVERHEAD=16 (ms of page work per frame)   VERBOSE=1
// Each case is solved once from scratch and once after a dial change on the
// same mesh, one iteration at a time with the progress recorded; the record
// is then replayed through the estimator in frames as the page takes them
// (up to 6 iterations or 14 ms of solving, plus the page's own work), and
// every estimate is compared with the time the solve actually still took.
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
import { RemainingTime } from './build/eta.js';
const TONF = 9.80665e3;
const CASES = [
  ['4hi', {}, (p) => ({ mu: p.mu * 1.08 })],
  ['6hi', {}, (p) => ({ wrBender: 30 * TONF })],
  ['20hi', {}, (p) => ({ mu: p.mu * 1.08 })],
  ['2hi', {}, (p) => ({ mu: p.mu * 1.08 })],
  ['12hi', {}, (p) => ({ asu: [0, 0, 150e-6, 300e-6, 150e-6, 0, 0] })],
  ['4hi', { stripModel: 'slab' }, (p) => ({ mu: p.mu * 1.08 })],
  ['20hi', { stripModel: 'slab' }, (p) => ({ mu: p.mu * 1.08 })],
  ['4hi', { stripModel: 'fem3d' }, (p) => ({ backTension: p.backTension * 1.5 })],
  ['20hi', { stripModel: 'fem3d' }, (p) => ({ mu: p.mu * 1.08 })],
  ['6hi', { stripModel: 'fem3d' }, (p) => ({ irBender: 50 * TONF })],
  ['12hi', { stripModel: 'fem3d' }, (p) => ({ reduction: p.reduction * 1.1 })],
  ['6hi', { irBender: 200 * TONF, wrBender: 200 * TONF }, (p) => ({ mu: p.mu * 1.08 })],
  ['20hi', { leveling: 300e-6 }, (p) => ({ mu: p.mu * 1.08 })],
  ['4hi', { mode: 'force', targetForce: 1500 * TONF }, (p) => ({ targetForce: 1600 * TONF })],
  ['20hi', { taperShift: -0.05 }, (p) => ({ taperShift: -0.08 })],
  ['4hi', { width: 1.6 }, (p) => ({ wrBender: 60 * TONF })],
  ['20hi', { stations: 121 }, (p) => ({ frontTension: p.frontTension * 1.2 })],
  ['6hi', { mu: 0.3 }, (p) => ({ mu: 0.28 })],
  ['4hi', { mu: 0.01 }, (p) => ({ mu: 0.011 })],
  // settled first, then friction dropped: the correction cycles instead of converging
  ['4hi', { stations: 81 }, (p) => ({ mu: 0.01 })],
];
const overhead = Number(process.env.OVERHEAD ?? 16);
const verbose = !!process.env.VERBOSE;
const only = process.argv[2];
const record = (sv, cap = 900) => {
  const rows = []; let t = 0;
  for (let i = 0; i < cap; i++) {
    const t0 = performance.now(); sv.advance(1e9, 1); t += performance.now() - t0;
    rows.push({ t, p: sv.progress() });
    if (sv.isConverged) break;
  }
  return rows;
};
const frames = (rows) => {
  const out = []; let k = 0, wall = 0, prevT = 0;
  while (k < rows.length) {
    let solve = 0, n = 0;
    while (k < rows.length && n < 6) { solve += rows[k].t - prevT; prevT = rows[k].t; n++; k++; if (solve > 14) break; }
    wall += solve + overhead;
    out.push({ wall, p: rows[k - 1].p });
  }
  return out;
};
const all = [];
let stalledRight = 0, stalledCases = 0;
for (const [mill, patch, change] of CASES) {
  const label = `${mill} ${JSON.stringify(patch).replace(/"/g, '')}`;
  if (only && !label.includes(only)) continue;
  const sv = new StackSolver({ ...defaultParams(mill), ...patch });
  const cold = record(sv);
  sv.setParams({ ...sv.p, asu: [...sv.p.asu], asu2: [...sv.p.asu2], ...change(sv.p) });
  const warm = record(sv);
  const eta = new RemainingTime();
  const key = `${mill}|${JSON.stringify(patch)}`;
  let clock = 0;
  for (const [phase, rows] of [['cold', cold], ['warm', warm]]) {
    const fr = frames(rows);
    const total = fr[fr.length - 1].wall;
    const converged = rows[rows.length - 1].p.converged;
    let prev = 0, covered = 0, lastKind = '';
    let firstStalled = null, firstStalledIt = 0;
    const errs = [];
    for (const f of fr) {
      const e = eta.update(clock + f.wall, f.p, key);
      const actual = total - f.wall, dt = f.wall - prev; prev = f.wall;
      lastKind = e.kind;
      if (e.kind === 'stalled' && firstStalled === null) { firstStalled = f.wall; firstStalledIt = f.p.iterations; }
      if (e.kind === 'remaining' && converged) {
        covered += dt;
        const rel = Math.abs(e.ms - actual) / Math.max(actual, 300);
        errs.push(rel); all.push(rel);
      }
      if (verbose) console.log(`   ${f.wall.toFixed(0).padStart(6)} ms it ${f.p.iterations} round ${f.p.rounds} change ${f.p.femChange.toExponential(1)} | ${e.kind === 'remaining' ? `estimate ${e.ms.toFixed(0)} ms` : e.kind} | actual ${converged ? actual.toFixed(0) + ' ms' : 'never'}`);
    }
    clock += total + 500;
    errs.sort((a, b) => a - b);
    const med = errs.length ? `${(100 * errs[errs.length >> 1]).toFixed(0)}%` : '—';
    if (!converged) {
      stalledCases++;
      if (lastKind === 'stalled') stalledRight++;
    }
    if (firstStalled !== null) console.log(`   first reported stalled at ${firstStalled.toFixed(0)} ms (iteration ${firstStalledIt})${converged ? ' - but this solve converged' : ''}`);
    console.log(`${(label + ' ' + phase).padEnd(46)} ${converged ? `solve ${total.toFixed(0).padStart(5)} ms` : 'not converged  '} | estimate shown ${converged ? (100 * covered / total).toFixed(0).padStart(3) + '%' : '  —'} of the time | median |error| ${med.padStart(4)} | last: ${lastKind}`);
  }
}
all.sort((a, b) => a - b);
const q = (f) => `${(100 * all[Math.min(all.length - 1, Math.floor(f * all.length))]).toFixed(0)}%`;
console.log(`\n|estimate − actual| / max(actual, 0.3 s) over every frame with an estimate: median ${q(0.5)}, 75th ${q(0.75)}, 90th ${q(0.9)} (page work ${overhead} ms/frame)`);
if (stalledCases) console.log(`solves that never converge reported as stalled at the end: ${stalledRight} / ${stalledCases}`);
