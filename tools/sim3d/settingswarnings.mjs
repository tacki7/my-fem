// The warnings the settings alone decide, and the entry readings, before a solve
// (`settingsWarnings`, `entryReadings` in src/sim3d/solver.ts):
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/settingswarnings.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. Before a solve: a strip wider than the WR barrel, a strip wider than the housing posts' clear
//    span, a floored entry profile and a tension near yield are each warned on a solver that has
//    not advanced (its result still has no warnings), with the numbers where the warning has some;
//    putting the setting right through `setParams` drops the warning at once.
//    After a solve, putting a setting right on the same mesh drops its warning from
//    `settingsWarnings` at once, while the result (not solved again) still carries it.
// 2. After a solve: the result's warnings are the solution's with exactly the settings' keys in
//    them, in the same order (two at once: a tension near yield ahead of the housing posts); the
//    numbers are in `warningDetails`, once - not repeated as a note (the strip past the barrel,
//    the work rolls touching beside the strip); the notes are the layout's own.
// 3. The entry readings before a solve are the result's `crown0` / `edgeDrop0` after it, to the bit.
// 4. Reading either before and during a solve leaves the solve's unknowns the same bits.
// 5. `tensionYield` says the share it is raised at (0.9 × the tension cap 0.7 of k̄f = 63 %).
//
// All on the gate's grid (81 stations, strip stations 0, nz 8).
//
// @check
// @check-build sim3d
import { StackSolver, SETTINGS_WARNINGS, WARNING_TEXT } from './build/solver.js';
import { defaultParams } from './build/stack.js';

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const GRID = { stations: 81, stripStations: 0, stripNz: 8 };
const base = (mill, patch = {}) => ({ ...defaultParams(mill), ...GRID, ...patch });
function solve(p, during) {
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 2000; f++) { sv.advance(1e9, 6); during?.(sv); it += sv.result.iterations; if (sv.isConverged) break; }
  return { sv, R: sv.result, it };
}
const sameBits = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

// ── 1. before a solve ────────────────────────────────────────────────────────
{
  const cases = [
    { name: 'WR barrel 900 mm under a 1000 mm strip', key: 'stripWide', mill: '4hi', on: { wrLb: 0.9 }, off: { wrLb: 1.6 }, numbers: ['1000 mm', '900 mm', '100 mm'] },
    { name: 'housing posts 1.4 m wide', key: 'housingStrip', mill: '4hi', on: { housingMode: true, housingPostWidth: 1.4 }, off: { housingMode: true, housingPostWidth: 0.7 } },
    { name: 'housing mode on a 20Hi', key: 'housingScope', mill: '20hi', on: { housingMode: true }, off: { housingMode: false } },
    { name: 'foil with a 100 µm edge drop', key: 'entryThin', mill: '20hi', on: { h0: 0.0001, reduction: 0.2, wrD: 0.04, wrDn: 0.034, entryEdgeDrop: 100e-6, entryEdgeDropWidth: 0.05 }, off: { h0: 0.0001, reduction: 0.2, wrD: 0.04, wrDn: 0.034, entryEdgeDrop: 0, entryEdgeDropWidth: 0.05 } },
    { name: 'front tension 600 MPa', key: 'tensionYield', mill: '4hi', on: { frontTension: 600e6 }, off: {} },
  ];
  for (const c of cases) {
    const sv = new StackSolver(base(c.mill, c.on));
    const w = sv.settingsWarnings();
    const shown = w.keys.includes(c.key) && sv.result.warnings.length === 0 && sv.result.iterations === 0;
    const text = w.details[c.key] ?? WARNING_TEXT[c.key];
    const numbers = (c.numbers ?? []).every((n) => text.includes(n));
    sv.setParams(base(c.mill, c.off));
    const after = sv.settingsWarnings();
    const gone = !after.keys.includes(c.key);
    report(shown && numbers && gone, `before a solve: ${c.name}`,
      `warned before advancing: ${shown} [${w.keys}]; text 「${text}」${c.numbers ? ` has ${c.numbers.join(', ')}: ${numbers}` : ''}; put right → [${after.keys}]`);
  }
}

{
  // solved with the posts in the way, then the posts narrowed on the same mesh (not solved again)
  const { sv, R } = solve(base('4hi', { housingMode: true, housingPostWidth: 1.4 }));
  const had = R.warnings.includes('housingStrip');
  sv.setParams(base('4hi', { housingMode: true, housingPostWidth: 0.7 }));
  const now = sv.settingsWarnings();
  report(had && !now.keys.includes('housingStrip') && sv.result.warnings.includes('housingStrip') && sv.result.iterations > 0,
    'after a solve: the setting put right on the same mesh', `solved [${R.warnings}]; posts 0.7 m → settings [${now.keys}], the unsolved result still [${sv.result.warnings}]`);
}

// ── 2. after a solve ─────────────────────────────────────────────────────────
{
  const cases = [
    ['4Hi, strip past the barrel', base('4hi', { wrLb: 0.9 })],
    ['2Hi default (the work rolls touch beside the strip)', base('2hi')],
    ['4Hi housing, posts 1.4 m', base('4hi', { housingMode: true, housingPostWidth: 1.4 })],
    ['20Hi foil, edge drop 100 µm', base('20hi', { h0: 0.0001, reduction: 0.2, wrD: 0.04, wrDn: 0.034, entryEdgeDrop: 100e-6, entryEdgeDropWidth: 0.05 })],
    ['4Hi housing, posts 1.4 m, back tension 600 MPa', base('4hi', { housingMode: true, housingPostWidth: 1.4, backTension: 600e6 })],
  ];
  for (const [name, p] of cases) {
    const { sv, R } = solve(p);
    const set = sv.settingsWarnings();
    const inResult = R.warnings.filter((k) => SETTINGS_WARNINGS.includes(k));
    const keysSame = JSON.stringify(inResult) === JSON.stringify(set.keys);
    // the settings' keys sit in one run, where `diagnose` always put them: after stone / gapClosed / bite
    const first = R.warnings.findIndex((k) => SETTINGS_WARNINGS.includes(k));
    const run = first < 0 || R.warnings.slice(first, first + set.keys.length).every((k) => SETTINGS_WARNINGS.includes(k));
    const before = first < 0 || R.warnings.slice(0, first).every((k) => ['stone', 'gapClosed', 'bite'].includes(k));
    const detailsSame = Object.entries(set.details).every(([k, t]) => R.warningDetails[k] === t);
    const notesSame = JSON.stringify(R.notes) === JSON.stringify(set.notes) && JSON.stringify(R.notes) === JSON.stringify(sv.stack.issues);
    const noRepeat = Object.values(R.warningDetails).every((t) => !R.notes.includes(t)) && !R.notes.some((n) => n.startsWith('板幅') || n.startsWith('WR 同士'));
    const touchDetail = !R.warnings.includes('wrTouch') || /x = -?\d+〜-?\d+ mm/.test(R.warningDetails.wrTouch ?? '');
    report(R.converged && keysSame && run && before && detailsSame && notesSame && noRepeat && touchDetail, `after a solve: ${name}`,
      `warnings [${R.warnings}] (settings' [${set.keys}] in place: ${keysSame && run && before}); details the same: ${detailsSame}; notes = layout issues: ${notesSame}; no number repeated as a note: ${noRepeat}${R.warnings.includes('wrTouch') ? `; 「${R.warningDetails.wrTouch}」` : ''}`);
  }
}

// ── 3. entry readings ────────────────────────────────────────────────────────
{
  const p = base('4hi', { entryEdgeDrop: 50e-6, entryEdgeDropWidth: 0.05 });
  const sv0 = new StackSolver(p);
  const pre = sv0.entryReadings();
  const { R } = solve(p);
  const same = Object.is(pre.crown0, R.crown0) && Object.is(pre.edgeDrop0, R.edgeDrop0);
  report(same && pre.crown0 > 0 && pre.edgeDrop0 > 0, 'entry readings before a solve',
    `C25 / edge drop ${(pre.crown0 * 1e6).toFixed(2)} / ${(pre.edgeDrop0 * 1e6).toFixed(2)} µm before; the result's after: to the bit ${same}`);
}

// ── 4. reading does not touch the solve ──────────────────────────────────────
{
  const p = base('6hi', { housingMode: true, housingPostWidth: 1.4 });
  const plain = solve(p);
  const read = (sv) => { sv.settingsWarnings(); sv.entryReadings(); };
  const sv = new StackSolver(p);
  read(sv);
  let it = 0;
  for (let f = 0; f < 2000; f++) { sv.advance(1e9, 6); read(sv); it += sv.result.iterations; if (sv.isConverged) break; }
  const same = sameBits(plain.sv.u, sv.u) && Object.is(plain.R.force, sv.result.force) && JSON.stringify(plain.R.warnings) === JSON.stringify(sv.result.warnings);
  report(same && plain.it === it, 'reading leaves the solve alone', `6Hi housing: unknowns, force and warnings bit-identical ${same}; iterations ${plain.it} / ${it}`);
}

// ── 5. the tension warning's share ───────────────────────────────────────────
report(WARNING_TEXT.tensionYield.includes('63 %'), 'tensionYield text', `「${WARNING_TEXT.tensionYield}」`);

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
