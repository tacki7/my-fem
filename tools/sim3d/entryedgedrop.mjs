// The entry strip's edge drop (`entryEdgeDrop` over `entryEdgeDropWidth`, see
// `entryThickness` in src/sim3d/solver.ts):
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/entryedgedrop.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. The profile: `entryThickness` against the formula written out here - the crown's
//    parabola less D·(1 − d/b)² within the band b of the nearer edge - across a strip,
//    for a drop, a build-up and a band past half the width (which counts as half the
//    width); a zero drop is the parabola to the bit.
// 2. Off is off: a zero drop solves to the same bits as parameters that never mention
//    it (4Hi on the gate's 81-station grid).
// 3. The pass (4Hi, 141 stations on the strip, the rest the defaults), 50 µm over 50 mm
//    against none: every slice takes the formula at its station; the entry's edge drop
//    and C25, read as the exit's are, grow by what the formula says, within the linear
//    interpolation's error between stations; the exit's edge drop grows, but by less than
//    the entry's scaled by h₁/h₀ - the pass does not carry the drop over in proportion, so
//    the edge is rolled less than the centre and its latent elongation against the
//    centre falls; the body (|x| ≤ 300 mm, against the centre) keeps its profile.
// 4. The floor: a foil (the 20Hi foil preset, h₀ 0.1 mm, crown 30 µm) with a 100 µm drop over 50 mm
//    takes the formula below zero at the edges, where it used to solve to NaNs. The profile is
//    max(formula, a quarter of h₀) - the floor itself to the bit where it holds - and flags where
//    it is held; the pass (the gate's grid) converges with every reading finite and warns
//    `entryThin`, and every slice takes the floored formula at its station.
//
// @check
// @check-build sim3d
import { StackSolver, entryThickness, entryFloored } from './build/solver.js';
import { defaultParams } from './build/stack.js';

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
function solve(p) {
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  return { sv, R: sv.result, it };
}
const sameBits = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const um = (v) => (v * 1e6).toFixed(2);

/** the entry thickness as the model defines it, written out independently of the solver */
function expected(p, x) {
  const W = p.width, band = Math.min(p.entryEdgeDropWidth, W / 2);
  const parabola = p.h0 - p.entryCrown * ((2 * x) / W) ** 2;
  const d = W / 2 - Math.abs(x);
  return p.entryEdgeDrop !== 0 && band > 0 && d < band ? parabola - p.entryEdgeDrop * (1 - d / band) ** 2 : parabola;
}

// ── 1. the profile ───────────────────────────────────────────────────────────
{
  const base = defaultParams('4hi');
  let worst = 0, n = 0;
  const cases = [
    { entryEdgeDrop: 50e-6, entryEdgeDropWidth: 50e-3 },
    { entryEdgeDrop: -30e-6, entryEdgeDropWidth: 20e-3 },
    { entryEdgeDrop: 80e-6, entryEdgeDropWidth: 0.8 },
  ];
  for (const c of cases) {
    const p = { ...base, ...c };
    for (let k = 0; k <= 1000; k++) {
      const x = -p.width / 2 + (k * p.width) / 1000;
      worst = Math.max(worst, Math.abs(entryThickness(p, x) - expected(p, x)));
      n++;
    }
  }
  const wide = { ...base, entryEdgeDrop: 80e-6, entryEdgeDropWidth: 0.8 }, half = { ...wide, entryEdgeDropWidth: base.width / 2 };
  let clampSame = true, zeroSame = true;
  for (let k = 0; k <= 1000; k++) {
    const x = -base.width / 2 + (k * base.width) / 1000;
    clampSame &&= Object.is(entryThickness(wide, x), entryThickness(half, x));
    const t = (2 * x) / base.width;
    zeroSame &&= Object.is(entryThickness({ ...base, entryEdgeDrop: 0, entryEdgeDropWidth: 0.05 }, x), base.h0 - base.entryCrown * t * t);
  }
  report(worst < 1e-12, 'profile: the formula', `max |entryThickness − formula| ${worst.toExponential(1)} m over ${n} points (drop 50 µm / 50 mm, build-up 30 µm / 20 mm, 80 µm over a band past half the width)`);
  report(clampSame && zeroSame, 'profile: band clamp, zero drop', `band 800 mm = band 500 mm on a 1000 mm strip to the bit: ${clampSame}; zero drop = the parabola to the bit: ${zeroSame}`);
}

// ── 2. off is off ────────────────────────────────────────────────────────────
{
  const grid = { stations: 81, stripStations: 0, stripNz: 8 };
  const never = { ...defaultParams('4hi'), ...grid };
  delete never.entryEdgeDrop; delete never.entryEdgeDropWidth;
  const zero = { ...defaultParams('4hi'), ...grid, entryEdgeDrop: 0, entryEdgeDropWidth: 0.12 };
  const a = solve(never).R, b = solve(zero).R;
  const same = Object.is(a.force, b.force) && Object.is(a.screw, b.screw) && sameBits(a.h1, b.h1) && sameBits(a.q, b.q) && sameBits(a.profile.latent, b.profile.latent);
  report(a.converged && b.converged && same, 'off: zero drop solves to the same bits', `converged ${a.converged}/${b.converged}; force, screw, h₁, q and the latent profile bit-identical: ${same}`);
}

// ── 3. the pass ──────────────────────────────────────────────────────────────
{
  const D = 50e-6, band = 50e-3;
  const p0 = { ...defaultParams('4hi'), stripStations: 141 };
  const p1 = { ...p0, entryEdgeDrop: D, entryEdgeDropWidth: band };
  const A = solve(p0), B = solve(p1);
  const RA = A.R, RB = B.R;
  report(RA.converged && RB.converged && [RB.crown0, RB.edgeDrop0, RB.edgeDropL, RB.latentIU].every(Number.isFinite),
    'pass: converges', `iterations ${A.it} / ${B.it}`);

  let sliceErr = 0;
  for (const sl of B.sv.slices) sliceErr = Math.max(sliceErr, Math.abs(sl.h0 - expected(p1, sl.x)));
  report(sliceErr < 1e-12, 'pass: slices take the formula', `max |h₀ − formula| ${sliceErr.toExponential(1)} m over ${B.sv.slices.length} slices`);

  // the readings: E = h(100 mm) − h(15 mm) and C25 = h(0) − h(25 mm) from the edge, linearly
  // interpolated between slices, which misses a parabola of curvature 2D/b² by at most
  // (2D/b²)·ds²/8 at each point; the parabola's own share is the same in both solves
  const drop = (d) => D * Math.max(0, 1 - d / band) ** 2;
  const ds = B.sv.grid.dxStrip, interp = ((2 * D) / band ** 2) * ds ** 2 / 8;
  const dE0 = RB.edgeDrop0 - RA.edgeDrop0, dC0 = RB.crown0 - RA.crown0;
  const wantE0 = drop(0.015) - drop(0.1), wantC0 = drop(0.025);
  report(Math.abs(dE0 - wantE0) <= interp + 1e-9 && Math.abs(dC0 - wantC0) <= interp + 1e-9, 'pass: the entry reads the drop',
    `edge drop +${um(dE0)} µm (formula ${um(wantE0)}), C25 +${um(dC0)} µm (formula ${um(wantC0)}); interpolation bound ${um(interp)} µm at ${(ds * 1e3).toFixed(2)} mm`);

  const dE1 = RB.edgeDropL - RA.edgeDropL, ratio = 1 - p0.reduction;
  report(dE1 > 0 && dE1 < ratio * dE0 && Math.abs(RB.edgeDropL - RB.edgeDropR) < 1e-9, 'pass: the exit keeps part of it',
    `exit edge drop ${um(RA.edgeDropL)} → ${um(RB.edgeDropL)} µm (+${um(dE1)}, under h₁/h₀ × entry = ${um(ratio * dE0)}); L − R ${(RB.edgeDropL - RB.edgeDropR).toExponential(1)} m`);

  // the latent profile against the centre: at the strip edges, and over the body
  const centre = (R) => { let k = 0; for (let i = 0; i < R.profile.x.length; i++) if (Math.abs(R.profile.x[i]) < Math.abs(R.profile.x[k])) k = i; return R.profile.latent[k]; };
  const cA = centre(RA), cB = centre(RB), last = RA.profile.x.length - 1;
  const edgeA = 0.5 * (RA.profile.latent[0] + RA.profile.latent[last]) - cA, edgeB = 0.5 * (RB.profile.latent[0] + RB.profile.latent[last]) - cB;
  let body = 0;
  for (let i = 0; i <= last; i++) if (Math.abs(RA.profile.x[i]) <= 0.3) body = Math.max(body, Math.abs((RB.profile.latent[i] - cB) - (RA.profile.latent[i] - cA)));
  report(edgeB < edgeA - 20e-5 && body < 5e-5, 'pass: the edge elongates less, the body as it was',
    `edge − centre latent ${(edgeA * 1e5).toFixed(0)} → ${(edgeB * 1e5).toFixed(0)} I-units; |x| ≤ 300 mm moves by ${(body * 1e5).toFixed(2)} I-units at most against the centre; flatness ${RA.latentIU.toFixed(0)} → ${RB.latentIU.toFixed(0)} I-units`);
}

// ── 4. the floor ─────────────────────────────────────────────────────────────
{
  const FLOOR = 0.25;
  const p = {
    ...defaultParams('20hi'), stations: 81, stripStations: 0, stripNz: 8,
    h0: 0.0001, reduction: 0.2, wrD: 0.04, wrDn: 0.034, entryEdgeDrop: 100e-6, entryEdgeDropWidth: 0.05,
  };
  const floor = FLOOR * p.h0;
  // the floored formula: the floor to the bit where the formula is under it, the formula elsewhere
  const floored = (h, x) => (expected(p, x) < floor ? Object.is(h, floor) : Math.abs(h - expected(p, x)) < 1e-12);
  let profileSame = true, flagSame = true, below = 0;
  for (let k = 0; k <= 1000; k++) {
    const x = -p.width / 2 + (k * p.width) / 1000;
    profileSame &&= floored(entryThickness(p, x), x);
    flagSame &&= entryFloored(p, x) === (expected(p, x) < floor);
    if (expected(p, x) < floor) below++;
  }
  report(below > 0 && profileSame && flagSame, 'floor: the profile',
    `max(formula, ${FLOOR}·h₀): ${profileSame}; flagged exactly where the formula is under it: ${flagSame}; ${below} of 1001 points under (edge formula ${um(expected(p, p.width / 2))} µm)`);

  // capped: before the floor this case never settled (NaN residual)
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 300; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  const R = sv.result;
  const finite = [R.force, R.h1Mean, R.crown, R.crown0, R.edgeDropL, R.edgeDropR, R.edgeDrop0, R.latentIU, R.manifestIU, R.residual].every(Number.isFinite)
    && sv.slices.every((sl) => Number.isFinite(sl.h1) && Number.isFinite(sl.q));
  report(R.converged && finite && R.warnings.includes('entryThin'), 'floor: the pass converges and warns',
    `converged ${R.converged} in ${it} iterations; readings finite: ${finite} (h₁ mean ${um(R.h1Mean)} µm, C25 ${um(R.crown)} µm); warnings [${R.warnings}]`);
  let sliceSame = true, held = 0;
  for (const sl of sv.slices) { sliceSame &&= floored(sl.h0, sl.x) && sl.entryFloored === (expected(p, sl.x) < floor); if (sl.entryFloored) held++; }
  report(sliceSame && held > 0, 'floor: slices take the floored formula', `${held} of ${sv.slices.length} slices held at ${um(floor)} µm; every slice max(formula, floor) and flagged where held: ${sliceSame}`);
}

if (failed) { console.log(`${failed} FAIL`); process.exit(1); }
console.log('all PASS');
