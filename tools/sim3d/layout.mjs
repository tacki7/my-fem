// The layout checks on the cluster mills (`layoutIssues` in src/sim3d/stack.ts, the bearing-ring
// check in `refreshProfiles`, src/sim3d/solver.ts):
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/layout.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. The five mills' defaults (and the 20Hi foil preset's 40 mm work roll) have no issue.
// 2. A 12Hi with a 900 mm work roll: the overlap and the contacts pulled apart are reported (as before, 3 issues).
// 3. A 12Hi with a 40 mm work roll: the minimum wrap angle keeps the first intermediates apart
//    but brings them 8.9 mm below the pass line (the work roll's underside) - both reported,
//    with the depth, which is the geometry's (R₁ − R_w − (R_w + R₁)cos α). A 50 mm work roll
//    stays above it.
// 4. A 12Hi and a 20Hi with a 700 mm backing shaft and a 120 mm saddle width: the gaps at the
//    saddles (pitch 107 mm) leave no bearing ring - every backing contact has no width anywhere -
//    and each backing shaft is reported. 95 mm (under the pitch) leaves rings and no report;
//    unsegmented, the 120 mm is not a gap at all.
// 5. The issues are settings: `settingsWarnings` has `layout` and the issues as notes on a
//    solver that has not advanced.
//
// All on the gate's grid (81 stations, strip stations 0, nz 8).
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
const GRID = { stations: 81, stripStations: 0, stripNz: 8 };
const make = (mill, patch = {}) => new StackSolver({ ...defaultParams(mill), ...GRID, ...patch });
const issues = (sv) => sv.stack.issues;

// ── 1. defaults ──────────────────────────────────────────────────────────────
{
  const rows = ['2hi', '4hi', '6hi', '12hi', '20hi'].map((m) => [m, issues(make(m))]);
  rows.push(['20hi foil (WR 40 mm)', issues(make('20hi', { h0: 0.0001, reduction: 0.2, wrD: 0.04, wrDn: 0.034 }))]);
  report(rows.every(([, i]) => i.length === 0), 'defaults: no issue', rows.map(([m, i]) => `${m} ${i.length}`).join(', '));
}

// ── 2. a large work roll ─────────────────────────────────────────────────────
{
  const i = issues(make('12hi', { wrD: 0.9 }));
  report(i.length === 3 && i.some((s) => s.includes('接触なしのはずが干渉')), '12Hi WR 900 mm: the broken layout reported', i.join(' / '));
}

// ── 3. the pass line ─────────────────────────────────────────────────────────
{
  const sv = make('12hi', { wrD: 0.04, wrDn: 0.034 });
  const i = issues(sv);
  const wr = sv.stack.rolls[0], ir = sv.stack.rolls.find((r) => r.id === 'IR-L');
  const depth = (wr.cy - wr.D / 2) - (ir.cy - ir.D / 2);
  const both = ['IR-L', 'IR-R'].every((id) => i.some((s) => s.startsWith(`${id}: パスライン`) && s.includes(`${(depth * 1e3).toFixed(1)} mm`)));
  const ok50 = issues(make('12hi', { wrD: 0.05, wrDn: 0.034 })).length === 0;
  report(both && Math.abs(depth - 0.0089) < 0.0001 && ok50, '12Hi WR 40 mm: the intermediates below the pass line',
    `${i.join(' / ')}; geometry depth ${(depth * 1e3).toFixed(2)} mm (wrap ${(sv.stack.angle1 * 180 / Math.PI).toFixed(1)}°); WR 50 mm: no issue ${ok50}`);
}

// ── 4. the bearing rings ─────────────────────────────────────────────────────
for (const [mill, shafts] of [['12hi', 3], ['20hi', 4]]) {
  const shaft = { bbLb: 0.7 };
  const sv = make(mill, { ...shaft, bbGap: 0.12 });
  const bb = sv.stack.rolls.map((r, k) => [r, k]).filter(([r]) => r.bearingGap > 0);
  const empty = bb.every(([, k]) => sv.contacts.filter((c) => c.a === k || c.b === k).every((c) => c.weight.every((w) => w === 0)));
  const reported = bb.every(([r]) => sv.stack.issues.some((s) => s.startsWith(`${r.id}: 軸受リングが 1 つも残らない`)));
  const narrow = make(mill, { ...shaft, bbGap: 0.095 });
  const rings = narrow.stack.rolls.map((r, k) => [r, k]).filter(([r]) => r.bearingGap > 0)
    .every(([, k]) => narrow.contacts.filter((c) => c.a === k || c.b === k).some((c) => c.weight.some((w) => w > 0)));
  const whole = make(mill, { ...shaft, bbGap: 0.12, bbSegmented: false });
  report(bb.length === shafts && empty && reported && rings && narrow.stack.issues.length === 0 && whole.stack.issues.length === 0,
    `${mill} shaft 700 mm, saddle width 120 mm: no ring left, reported`,
    `${bb.length} segmented shafts, every contact width 0: ${empty}; ${sv.stack.issues.filter((s) => s.includes('軸受リング')).join(' / ')}; 95 mm leaves rings: ${rings} (issues ${narrow.stack.issues.length}); unsegmented: issues ${whole.stack.issues.length}`);
}

// ── 5. settings ──────────────────────────────────────────────────────────────
{
  const cases = [['12hi', { wrD: 0.04, wrDn: 0.034 }], ['12hi', { bbLb: 0.7, bbGap: 0.12 }]];
  const ok = cases.every(([m, patch]) => {
    const sv = make(m, patch);
    const w = sv.settingsWarnings();
    return sv.result.iterations === 0 && w.keys.includes('layout') && JSON.stringify(w.notes) === JSON.stringify(sv.stack.issues) && w.notes.length > 0;
  });
  report(ok, 'the issues are settings warnings', 'before a solve: `layout` with the issues as notes, for the pass line and the bearing rings');
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
