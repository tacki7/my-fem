// The strip's own station spacing (`stripStations`, see src/sim3d/grid.ts):
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/stripgrid.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. The grid by itself, over ordinary and awkward inputs (a strip reaching past the grid's
//    half-width, a handful of strip stations, even and out-of-range counts): ascending, mirror
//    symmetric to the bit, cells contiguous with each station inside its own, a cell boundary
//    exactly on each strip edge, N whole cells of width w/N on the strip and nothing partial,
//    the spacing off the strip near the even grid's. The even grid (stripStations 0) is the
//    formula the solver always used, bit for bit. The station lookups against brute force.
// 2. Solves on a refined grid - a 4Hi, and a shifted 6Hi whose lower half is solved: converged,
//    one slice per strip station with the weights adding to the width, and the solve's own
//    invariants (audit-lib.mjs) to the same limits as check.mjs, the 6Hi's lower half still the
//    upper one turned about the centre.
// 3. The refinement against the even grid where the two are the same grid: at a width of N
//    even-grid cells (N odd) the refined grid puts its stations where the even one has them, so
//    the solves agree to rounding.
// 4. (not held) how the headline results move as the strip is refined, 4Hi at 81 stations.
//
// @check
// @check-build sim3d
import { stationGrid, evenCount, stripCount, nearestStation, stationBelow, stationAbove, MIN_STATIONS, MAX_STRIP_STATIONS } from './build/grid.js';
import { defaultParams } from './build/stack.js';
import { CONVERGENCE } from './build/solver.js';
import { solve, equilibrium, contactKinematics, stripConsistency } from './audit-lib.mjs';

const TONF = 9.80665e3;
let failed = 0;
function report(ok, name, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ── 1. the grid ─────────────────────────────────────────────────────────────
{
  // [half, stations, width, stripStations]
  const CASES = [
    [1.175, 81, 1.0, 35], [1.175, 301, 1.0, 129], [1.175, 81, 1.6, 601], [1.35, 21, 0.3, 5],
    [0.84, 81, 1.6, 3],     // the first station off the strip lies past the half-width: the grid ends there
    [0.84, 81, 1.6, 21],    // less than half an even spacing left beside the strip: the grid ends short of it
    [0.525, 11, 1.0, 3], [1.175, 81, 1.0, 36], [1.175, 81, 1.0, 1], [1.175, 81, 1.0, 5000],
    [1.175, 81, 0.3, 29], [1.175, 81, 0.31, 29],   // the midpoint of the stations either side of the edge misses it by a rounding step, one way and the other
  ];
  const bad = [];
  let refined = 0;
  for (const [half, stations, width, n] of CASES) {
    const g = stationGrid(half, stations, width, n);
    const { x, cellL, cellR, cellW, elemL } = g;
    const ns = x.length, N = stripCount(n), w2 = width / 2, ds = width / N;
    const tag = `[${half}, ${stations}, ${width}, ${n}]`;
    const fail = (what) => bad.push(`${tag} ${what}`);
    if (g.uniform || g.onStrip !== N || N % 2 !== 1 || N < 3 || N > MAX_STRIP_STATIONS) { fail(`strip count ${g.onStrip} (${N})`); continue; }
    refined++;
    for (let s = 0; s < ns; s++) {
      if (s > 0 && !(x[s] > x[s - 1])) fail(`not ascending at ${s}`);
      if (x[ns - 1 - s] !== -x[s] || cellL[ns - 1 - s] !== -cellR[s] || cellW[ns - 1 - s] !== cellW[s]) fail(`not mirror symmetric at ${s}`);
      if (s < ns - 1 && cellR[s] !== cellL[s + 1]) fail(`cells ${s}, ${s + 1} not contiguous`);
      if (!(cellL[s] < x[s] && x[s] < cellR[s])) fail(`station ${s} outside its cell`);
      if (cellW[s] !== cellR[s] - cellL[s] || (s < ns - 1 && elemL[s] !== x[s + 1] - x[s])) fail(`widths at ${s}`);
    }
    if (!(cellR.includes(w2) && cellL.includes(-w2))) fail('no cell boundary exactly on a strip edge');
    let on = 0, sum = 0, partial = 0, dsWorst = 0;
    for (let s = 0; s < ns; s++) {
      const o = Math.max(0, Math.min(cellR[s], w2) - Math.max(cellL[s], -w2));
      if (o <= 0) continue;
      on++; sum += o;
      if (o !== cellW[s]) partial++;
      dsWorst = Math.max(dsWorst, Math.abs(cellW[s] / ds - 1));
    }
    if (on !== N || partial || dsWorst > 1e-12 || Math.abs(sum / width - 1) > 1e-12) fail(`strip cells: ${on} of ${N}, ${partial} partial, width off by ${dsWorst.toExponential(1)}, sum ${sum}`);
    const first = w2 + ds / 2, end = x[ns - 1];
    if (!(Math.abs(end - Math.max(half, first)) <= 1e-12 || (half > first && half - first < 0.5 * (2 * half) / (evenCount(stations) - 1) && end === first))) fail(`grid ends at ${end} (half ${half}, first off the strip ${first})`);
    const dxEven = (2 * half) / (evenCount(stations) - 1);
    for (let s = 0; s < ns - 1; s++) {
      if (x[s] < first - 1e-12) continue;
      if (elemL[s] < 0.5 * dxEven || elemL[s] > 2 * dxEven) fail(`spacing off the strip ${elemL[s]} against ${dxEven}`);
    }
  }
  // the even grid: the solver's formula, bit for bit
  for (const [half, stations] of [[1.175, 81], [0.775, 301], [1.36, 20]]) {
    const g = stationGrid(half, stations, 1.0, 0);
    const ns = Math.max(MIN_STATIONS, Math.round(stations) | 1), dx = (2 * half) / (ns - 1);
    let same = g.uniform && g.x.length === ns && g.dx === dx && g.dxStrip === dx && g.onStrip === 0;
    for (let s = 0; s < ns; s++) {
      const x = -half + s * dx;
      same &&= g.x[s] === x && g.cellL[s] === x - dx / 2 && g.cellR[s] === x + dx / 2 && g.cellW[s] === dx && (s === ns - 1 || g.elemL[s] === dx);
    }
    if (!same) bad.push(`even grid [${half}, ${stations}] is not the formula`);
  }
  report(bad.length === 0 && refined === CASES.length, 'refined grids: symmetric, contiguous, the strip tiled by whole cells; the even grid unchanged',
    `${CASES.length} refined and 3 even grids${bad.length ? `; ${bad.length} problems, first: ${bad.slice(0, 3).join(' | ')}` : ''}`);
  report(stripCount(0) === 0 && stripCount(NaN) === 0 && stripCount(-3) === 0 && stripCount(0.4) === 0 && stripCount(1) === 3 && stripCount(36) === 37 && stripCount(37) === 37 && stripCount(1e6) === MAX_STRIP_STATIONS,
    'strip counts: 0 / NaN / negative even grid, rounded up to odd, 3 to ' + MAX_STRIP_STATIONS, [0, NaN, -3, 0.4, 1, 36, 37, 1e6].map((v) => `${v}→${stripCount(v)}`).join(' '));

  // the lookups against brute force, and the nearest station mirrored with the position
  const g = stationGrid(1.175, 81, 1.0, 35);
  const x = g.x, ns = x.length;
  const probes = [-2, x[0], 2];
  for (let s = 0; s < ns; s++) { probes.push(x[s]); if (s < ns - 1) probes.push(0.5 * (x[s] + x[s + 1]), x[s] + 0.1 * g.elemL[s], x[s] + 0.9 * g.elemL[s]); }
  const lookBad = [];
  for (const v of probes) {
    let near = 0;
    for (let s = 1; s < ns; s++) {
      const d = Math.abs(x[s] - v), dn = Math.abs(x[near] - v);
      if (d < dn || (d === dn && Math.abs(x[s]) > Math.abs(x[near]))) near = s;
    }
    let below = 0; for (let s = 0; s < ns; s++) if (x[s] <= v) below = s;
    let above = ns - 1; for (let s = ns - 1; s >= 0; s--) if (x[s] >= v) above = s;
    if (nearestStation(x, v) !== near || stationBelow(x, v) !== below || stationAbove(x, v) !== above) lookBad.push(`${v}: ${nearestStation(x, v)}/${near} ${stationBelow(x, v)}/${below} ${stationAbove(x, v)}/${above}`);
    if (nearestStation(x, -v) !== ns - 1 - nearestStation(x, v)) lookBad.push(`${v}: not mirrored`);
  }
  report(lookBad.length === 0, 'station lookups: nearest (ties outward, mirrored), at-or-below, at-or-above = brute force', `${probes.length} positions${lookBad.length ? `; ${lookBad.slice(0, 3).join(' | ')}` : ''}`);
}

// ── 2. solves on a refined grid ─────────────────────────────────────────────
for (const [label, mill, patch] of [['4Hi N 71', '4hi', { stripStations: 71 }], ['6Hi shift +100, N 61', '6hi', { irShift: 0.1, stripStations: 61 }]]) {
  // the strip's rows as the check was written with (the defaults have 16)
  const p = { ...defaultParams(mill), stations: 81, stripNz: 8, ...patch };
  const { sv } = solve(p, 400);
  const R = sv.result;
  let wsum = 0; for (const sl of sv.slices) wsum += sl.weight;
  const finite = [R.force, R.screw, R.h1Mean, R.crown, R.wedge, R.edgeDropL, R.edgeDropR, R.latentIU, R.manifestIU].every(Number.isFinite);
  report(R.converged && finite && sv.slices.length === p.stripStations && Math.abs(wsum / p.width - 1) < 1e-12,
    `${label}: converged, finite, one slice per strip station, weights add to the width`,
    `${sv.ns} stations, ${sv.slices.length} slices, Σw − w ${(wsum - p.width).toExponential(1)} m, F ${(R.force / TONF).toFixed(1)} tonf, C25 ${(R.crown * 1e6).toFixed(1)} µm`);
  const bal = Math.max(...equilibrium(sv).map((e) => Math.abs(e.net) / R.force));
  const kin = contactKinematics(sv);
  const dMis = Math.max(...kin.map((k) => k.deltaMismatch)), qMis = Math.max(...kin.map((k) => k.qRelMismatch));
  const S = stripConsistency(sv, p);
  report(bal <= 1e-3 && dMis <= 1e-12 && qMis <= 1e-12 && S.h1Mismatch <= 1e-10 && S.qRelMismatch <= CONVERGENCE.femTol,
    `${label}: force balance, contact kinematics and the strip slices hold (check.mjs limits)`,
    `balance ${bal.toExponential(1)}, contact δ ${dMis.toExponential(1)} m / q ${qMis.toExponential(1)}, strip h1 ${S.h1Mismatch.toExponential(1)} m / q ${S.qRelMismatch.toExponential(1)}`);
  const nU = R.rolls.length, ns = sv.ns;
  if (sv.rolls.length > nU) {
    let d = 0;
    for (let r = 0; r < nU; r++) for (let s = 0; s < ns; s++) {
      const a = sv.rolls[r].v[s], b = sv.rolls[nU + r].v[ns - 1 - s];
      if (Number.isFinite(a) && Number.isFinite(b)) d = Math.max(d, Math.abs(a - b));
    }
    report(d <= 1e-9, `${label}: the lower half is the upper one turned about the centre`, `max |vU(x) − vL(−x)| ${d.toExponential(1)} m`);
  }
}

// ── 3. the same grid both ways ──────────────────────────────────────────────
for (const [label, mill, patch] of [['4Hi', '4hi', {}], ['4Hi slab', '4hi', { stripModel: 'slab' }], ['12Hi', '12hi', {}]]) {
  // the even grid (stripStations 0) against the strip's own: the defaults tile the strip with 281 cells
  const base = { ...defaultParams(mill), stations: 81, stripStations: 0, stripNz: 8, ...patch };
  const dx = solve({ ...base }, 0).sv.dx;
  const N = 2 * Math.round((base.width / dx - 1) / 2) + 1;
  const width = N * dx;
  const a = solve({ ...base, width }, 400).sv, b = solve({ ...base, width, stripStations: N }, 400).sv;
  let xd = a.ns === b.ns ? 0 : Infinity;
  for (let s = 0; s < a.ns && xd < Infinity; s++) xd = Math.max(xd, Math.abs(a.x[s] - b.x[s]));
  const Ra = a.result, Rb = b.result;
  const len = ['screw', 'h1Mean', 'crown', 'wedge', 'edgeDropL', 'edgeDropR'].map((k) => Math.abs(Ra[k] - Rb[k]));
  const worstLen = Math.max(...len), dF = Math.abs(Ra.force - Rb.force) / Ra.force, dIU = Math.max(Math.abs(Ra.latentIU - Rb.latentIU), Math.abs(Ra.manifestIU - Rb.manifestIU));
  report(Ra.converged && Rb.converged && xd <= 1e-12 && a.slices.length === N && b.slices.length === N && dF <= 1e-6 && worstLen <= 1e-10 && dIU <= 1e-3,
    `${label}: at a width of ${N} even cells, stripStations ${N} is the even grid`,
    `width ${(width * 1e3).toFixed(3)} mm, stations ${a.ns}/${b.ns} (max |Δx| ${xd.toExponential(1)} m), slices ${a.slices.length}/${b.slices.length}, ΔF/F ${dF.toExponential(1)}, worst Δ(gauge, crown, wedge, edge) ${worstLen.toExponential(1)} m, ΔIU ${dIU.toExponential(1)}`);
}

// ── 4. refinement, not held ─────────────────────────────────────────────────
console.log('\nnote  4Hi, 81 stations: the headline results as the strip is refined (not held)');
console.log('note    grid          stations slices  ds[mm]  F[tonf]  C25[µm]  edge L[µm]  latent[IU]   ms');
for (const [label, patch] of [['even 81', {}], ['even 161', { stations: 161 }], ['N 35', { stripStations: 35 }], ['N 71', { stripStations: 71 }], ['N 141', { stripStations: 141 }]]) {
  const t0 = performance.now();
  const { sv } = solve({ ...defaultParams('4hi'), stations: 81, stripStations: 0, stripNz: 8, ...patch }, 400);
  const R = sv.result;
  console.log(`note    ${label.padEnd(12)} ${String(sv.ns).padStart(8)} ${String(sv.slices.length).padStart(6)} ${(sv.grid.dxStrip * 1e3).toFixed(2).padStart(7)} ${(R.force / TONF).toFixed(1).padStart(8)} ${(R.crown * 1e6).toFixed(1).padStart(8)} ${(R.edgeDropL * 1e6).toFixed(1).padStart(11)} ${R.latentIU.toFixed(0).padStart(11)} ${(performance.now() - t0).toFixed(0).padStart(5)}`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
