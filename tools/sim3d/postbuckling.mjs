// The post-buckling stiffness of a buckled strip slice (Params3D.postBucklingStiffness, `stripSolve`).
//
//   node tools/sim3d/postbuckling.mjs              exit 1 on any FAIL
//   node tools/sim3d/postbuckling.mjs --measure    print every margin, hold nothing
//
// 1. Stiffness 0 is the clamp: an explicit 0, on either law, solves bit for bit as the defaults do.
// 2. With a stiffness the 4Hi and 20Hi defaults converge, without warnings, on both laws, and some
//    slices are buckled (so the checks below are not empty).
// 3. The solve holds the law it was given, read back from its result alone. On a live slice
//    σ = σ̄ + λ − E′D, so λ from every live slice must agree; with that λ each buckled slice's stress is
//    b(free) - the clamp's −σcr, lo + β(free − lo), or −√(σcr² + k·σcr·(lo − free)) - its manifest
//    elongation is (σ − free)/E′, and the mean of σ over the strip is the set front tension. The shown
//    profile (`Result3D.profile`, from which the chart and the manifest flatness come) puts the same wave
//    at the buckled slices' stations as the slices' own manifest elongation.
// 4. What the stiffness does to the feedback: over the buckled slices the elongation gradient against
//    the open loop's (every slice at the mean tension, same gap and FEM correction) falls as 1/(1 + βG),
//    G = E′|dh₁/dσ|/h₁ of the centre slice, within ±20 %. Normalised by the clamp's own ratio, which the
//    smoothing of D holds under 1 even with no stiffness.
//
// @check
// @check-build sim3d
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
import { TENSION_CAP, kfMean } from './build/strip.js';

const MEASURE = process.argv.includes('--measure');
// a coarse roll grid with the strip on a finer one of its own: the buckled zone is some 170 mm
const GRID = { stations: 81, stripStations: 101 };
const TOL = {
  // the tension Newton stops at a residual of 5e4 Pa (`stripSolve`); after it the slices and D are
  // evaluated once more at the final stresses, which moves the free stress by about as much again
  stress: 2e5,           // Pa
  // the profile smooths over every slice out to 8σ and the solve over ±3σ of stations: 0.94 I-unit
  // between the two on a 4Hi at 81 + 141 with no stiffness (docs/validation.md, 伸び率分布の表示)
  profileWave: 2e-5,     // [-]
  slopeRatio: 0.2,       // relative, against 1/(1 + βG)
};

let fails = 0;
function hold(name, value, limit, detail = '') {
  const ok = Number.isFinite(value) && value <= limit;
  if (MEASURE) { console.log(`${(value / limit).toExponential(2).padStart(9)} of limit  ${name}  ${detail}`); return; }
  if (!ok) { fails++; console.log(`FAIL  ${name}  ${value} > ${limit} ${detail}`); }
}
function truth(name, ok, detail = '') {
  if (MEASURE) { console.log(`${ok ? 'true ' : 'FALSE'}  ${name}  ${detail}`); return; }
  if (!ok) { fails++; console.log(`FAIL  ${name}  ${detail}`); }
}

function solve(mill, patch) {
  const p = { ...defaultParams(mill), ...GRID, ...patch };
  const sv = new StackSolver(p);
  let iterations = 0;
  for (let f = 0; f < 500; f++) { sv.advance(1e9, 6); iterations += sv.result.iterations; if (sv.isConverged) break; }
  return { sv, p, iterations };
}

/** every number of a result that the strip or the rolls produce, for a bit-for-bit comparison */
function fingerprint(sv, iterations) {
  const R = sv.result, parts = [];
  for (const k of ['dEps', 'manifest', 'sigmaF', 'h1', 'q', 'flat']) parts.push(...R[k]);
  parts.push(R.force, R.screw, R.crown, R.latentIU, R.manifestIU, R.residual, iterations);
  for (const r of sv.rolls) parts.push(...r.v);
  return Buffer.from(Float64Array.from(parts).buffer).toString('base64');
}

/** the post-buckling law b(free) the solve was given (stack.ts, stripSolve), down to the compression cap −hi */
function law(sv, p) {
  const lo = -p.sigmaCr, ew = p.postBucklingModel === 'effectiveWidth';
  const k = p.postBucklingStiffness > 0 ? Math.min(p.postBucklingStiffness, ew ? 2 : 1) : 0;
  const e0 = Math.max(p.entryStrain, 0);
  const hi = TENSION_CAP * kfMean(sv.law, e0, e0 + 1.1547 * Math.log(1 / (1 - p.reduction)));
  return (f) => Math.max(-hi, ew ? -Math.sqrt(lo * lo + k * p.sigmaCr * Math.max(0, lo - f)) : lo + k * (f - lo));
}

/** the live slices' λ, the buckled slices against the law, and the mean tension */
function readBack(label, sv, p) {
  const R = sv.result;
  const Eeff = p.Estrip / (1 - p.nuStrip * p.nuStrip);
  const lo = -p.sigmaCr, b = law(sv, p);
  const rows = sv.slices.map((sl) => ({ w: sl.weight, sigma: R.sigmaF[sl.s], D: R.dEps[sl.s], man: R.manifest[sl.s], clipped: sl.clipped }));
  const live = rows.filter((r) => !r.clipped);
  const lambdas = live.map((r) => r.sigma - p.frontTension + Eeff * r.D).sort((a, c) => a - c);
  const lambda = lambdas[lambdas.length >> 1];
  hold(`${label}: λ from the live slices, spread`, lambdas[lambdas.length - 1] - lambdas[0], 2 * TOL.stress, `${live.length} live, λ ${(lambda / 1e6).toFixed(2)} MPa`);
  const buckled = rows.filter((r) => r.clipped && r.sigma <= lo + TOL.stress);
  let dStress = 0, dMan = 0, above = 0;
  for (const r of buckled) {
    const free = p.frontTension + lambda - Eeff * r.D;
    dStress = Math.max(dStress, Math.abs(r.sigma - b(free)));
    dMan = Math.max(dMan, Math.abs(r.man - Math.max(0, (r.sigma - free) / Eeff)));
    above = Math.max(above, r.sigma - lo);
  }
  hold(`${label}: buckled slices' stress against the law, max |σ − b(free)|`, dStress, TOL.stress, `${buckled.length} buckled`);
  hold(`${label}: buckled slices' manifest elongation against (σ − free)/E′ [-]`, dMan, TOL.stress / Eeff);
  hold(`${label}: buckled slices at or below the buckling limit, max σ − lo`, Math.max(0, above), TOL.stress);
  let ws = 0, s = 0;
  for (const r of rows) { ws += r.w; s += r.w * r.sigma; }
  hold(`${label}: mean front tension over the strip, |mean − σ̄|`, Math.abs(s / ws - p.frontTension), TOL.stress, `${(s / ws / 1e6).toFixed(3)} MPa`);
  // the shown profile at the buckled slices' stations (on this grid every station on the strip is a point)
  const P = R.profile;
  let dWave = 0, matched = 0;
  sv.slices.forEach((sl) => {
    if (!sl.clipped || !(R.sigmaF[sl.s] <= lo + TOL.stress)) return;
    for (let k = 0; k < P.x.length; k++) {
      if (Math.abs(P.x[k] - sv.x[sl.s]) < 1e-9) { dWave = Math.max(dWave, Math.abs(P.wave[k] - R.manifest[sl.s])); matched++; break; }
    }
  });
  truth(`${label}: the profile has a point at every buckled slice`, matched === buckled.length, `${matched} / ${buckled.length}`);
  hold(`${label}: profile's wave against the buckled slices' manifest elongation [-]`, dWave, TOL.profileWave);
  return buckled.length;
}

/** mean dD/dx over the buckled zone [xb+23, xb+95] mm, of the solve and of its open loop, and G of the centre slice */
function heldGradient(sv, p) {
  const R = sv.result;
  const Eeff = p.Estrip / (1 - p.nuStrip * p.nuStrip);
  const n = sv.slices.length;
  const rows = sv.slices.map((sl, i) => ({ sl, i, x: sl.x, w: sl.weight, D: R.dEps[sl.s], clipped: sl.clipped, sigma: R.sigmaF[sl.s] }));
  const k = (i) => (sv.femRatio ? sv.femRatio[i] : 1), off = (i) => (sv.femEps ? sv.femEps[i] : 0);
  const eOpen = rows.map((r) => { const o = sv.sliceCore(r.sl, r.sl.g, p.frontTension, r.sl.q, k(r.i)); return o.q > 0 ? Math.log(r.sl.h0 / o.h1) + off(r.i) : 0; });
  let ws = 0, em = 0;
  for (const r of rows) { ws += r.w; em += r.w * eOpen[r.i]; }
  em /= ws;
  const sig = Math.max(p.lateralLen, sv.grid.dxStrip), rad = Math.ceil((3 * sig) / sv.grid.dxStrip);
  const Dopen = rows.map((ri) => { let a = 0, c = 0; for (let j = Math.max(0, ri.i - rad); j <= Math.min(n - 1, ri.i + rad); j++) { const z = (rows[j].x - ri.x) / sig; const g = Math.exp(-0.5 * z * z) * rows[j].w; a += g * (eOpen[j] - em); c += g; } return a / c; });
  const right = rows.filter((r) => r.x >= 0);
  const first = right.find((r) => r.clipped && r.sigma < 0);
  if (!first) return null;
  const band = right.filter((r) => r.x >= first.x + 0.023 && r.x <= first.x + 0.095);
  if (band.length < 2) return null;
  const a = band[0], z = band[band.length - 1];
  const centre = right[0];
  return {
    closed: (z.D - a.D) / (z.x - a.x), open: (Dopen[z.i] - Dopen[a.i]) / (z.x - a.x),
    G: (Eeff * Math.abs(centre.sl.dh1ds)) / centre.sl.h1, xb: first.x,
  };
}

const t0 = performance.now();
for (const mill of ['4hi', '20hi']) {
  const base = solve(mill, {});
  const baseFp = fingerprint(base.sv, base.iterations);
  for (const model of ['linear', 'effectiveWidth']) {
    const zero = solve(mill, { postBucklingModel: model, postBucklingStiffness: 0 });
    truth(`${mill}: stiffness 0 on the ${model} law solves bit for bit as the defaults`, fingerprint(zero.sv, zero.iterations) === baseFp);
  }
  readBack(`${mill} clamp`, base.sv, base.p);
  const clamp = heldGradient(base.sv, base.p);
  truth(`${mill} clamp: a buckled zone to measure`, clamp !== null);

  for (const [model, k] of [['linear', 0.05], ['effectiveWidth', 1]]) {
    const label = `${mill} ${model} ${k}`;
    const { sv, p } = solve(mill, { postBucklingModel: model, postBucklingStiffness: k });
    const R = sv.result;
    truth(`${label}: converged`, R.converged, `residual ${R.residual}`);
    truth(`${label}: no warnings`, R.warnings.length === 0, `[${R.warnings}]`);
    const nb = readBack(label, sv, p);
    truth(`${label}: some slices buckled`, nb > 0, `${nb}`);
    if (model === 'linear' && clamp) {
      const g = heldGradient(sv, p);
      truth(`${label}: a buckled zone to measure`, g !== null);
      if (g) {
        const measured = (g.closed / g.open) / (clamp.closed / clamp.open);
        const expected = 1 / (1 + k * g.G);
        hold(`${label}: buckled zone's gradient against the open loop, normalised, against 1/(1 + βG)`, Math.abs(measured / expected - 1), TOL.slopeRatio,
          `${measured.toFixed(3)} / ${expected.toFixed(3)} (G ${g.G.toFixed(1)}, clamp ratio ${(clamp.closed / clamp.open).toFixed(3)})`);
      }
    }
  }
}
console.log(`\n${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (MEASURE) process.exit(0);
if (fails) { console.log(`${fails} FAIL`); process.exit(1); }
console.log('all PASS');
