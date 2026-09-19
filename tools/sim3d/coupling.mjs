// The roll correction and the coupling's rounds (src/sim3d/coupling.ts, `setRollCorrection` in
// src/sim3d/solver.ts), without FrontISTR:
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/coupling.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. No correction is no change: a solver told `setRollCorrection(null)` solves to the same bits
//    as one never told anything (4Hi on the gate's grid).
// 2. A correction is a gap: +10 µm on the surface everywhere, with the exit gauge held, moves the
//    screw in by 10 µm and leaves the gauge where it was; in the manual screw mode it opens the
//    exit gauge, but by much less than the 20 µm the two rolls' surfaces moved: the lighter load
//    lets the stack spring back (Δh = Δgap · M/(M + Q), the stack's modulus against the strip's
//    plastic one - 2.4 µm of 20 on the 4Hi default, a stack about 7 times softer than the strip).
// 3. The model's surface is what it says: v_WR − v̄_bearing + the flattening on the strip, NaN off it.
// 4. The rounds settle: against a stand-in for the solids - the model's own surface made 3 % softer,
//    plus a 20 µm crown - the rounds reach the steady state (δ moves < 0.25 µm, the load < 0.1 %) in
//    a handful, and there δ is the stand-in's surface less the model's to that tolerance.
// 5. The profile read between points: linear, ends held, mirrored for x < 0.
//
// @check
// @check-build sim3d
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
import { modelRollSurface, RollCoupling, interpolateProfile } from './build/coupling.js';

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const GATE = { stations: 81, stripStations: 0, stripNz: 8 };
function converge(sv) { for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); if (sv.isConverged) break; } return sv; }
const sameBits = (a, b) => a.length === b.length && Array.from(a).every((x, i) => Object.is(x, b[i]));
const um = (v) => (v * 1e6).toFixed(3);

// ── 1. null is nothing ────────────────────────────────────────────────────────
{
  const p = { ...defaultParams('4hi'), ...GATE };
  const a = converge(new StackSolver(p));
  const sb = new StackSolver(p);
  sb.setRollCorrection(null);
  const b = converge(sb);
  const same = sameBits(a.result.h1, b.result.h1) && sameBits(a.result.q, b.result.q) && Object.is(a.result.force, b.result.force) && Object.is(a.result.screw, b.result.screw);
  report(same && b.rollCorrection === null, 'no correction: the same bits as never told', `F ${a.result.force} / ${b.result.force}`);
}

// ── 2. a correction is a gap ──────────────────────────────────────────────────
{
  const p = { ...defaultParams('4hi'), ...GATE };
  const a = converge(new StackSolver(p));
  const b = new StackSolver(p);
  converge(b);
  b.setRollCorrection(new Float64Array(b.ns).fill(10e-6));
  converge(b);
  const dS = b.result.screw - a.result.screw, dh = b.result.h1Mean - a.result.h1Mean;
  report(Math.abs(dS - 10e-6) < 0.5e-6 && Math.abs(dh) < 0.05e-6, 'gauge held: +10 µm on the surface moves the screw in by 10 µm', `ΔS ${um(dS)} µm, Δh₁ ${um(dh)} µm`);
  const ps = { ...p, mode: 'screw', screw: a.result.screw };
  const c = converge(new StackSolver(ps));
  const d = new StackSolver(ps);
  converge(d);
  d.setRollCorrection(new Float64Array(d.ns).fill(10e-6));
  converge(d);
  const dh2 = d.result.h1Centre - c.result.h1Centre;
  report(dh2 > 0.5e-6 && dh2 < 20e-6 && d.result.force < c.result.force, 'screw held: the exit gauge opens, by less than the 20 µm of gap (the stack springs back), the load falls', `Δh₁ centre ${um(dh2)} µm, F ${(c.result.force / 9.80665e3).toFixed(1)} → ${(d.result.force / 9.80665e3).toFixed(1)} tonf`);
}

// ── 3. the model's surface ────────────────────────────────────────────────────
{
  const sv = converge(new StackSolver({ ...defaultParams('4hi'), ...GATE }));
  const m = modelRollSurface(sv);
  const wr = sv.rolls[sv.stack.wr], screw = sv.rolls[sv.stack.screwRolls[0]];
  const vb = screw.supports.reduce((a, s) => a + screw.v[s], 0) / screw.supports.length;
  let worst = 0, onStrip = 0, offOk = true;
  for (let s = 0; s < sv.ns; s++) {
    if (sv.result.q[s] > 0) { onStrip++; worst = Math.max(worst, Math.abs(m[s] - (wr.v[s] - vb + sv.result.flat[s]))); }
    else if (!Number.isNaN(m[s])) offOk = false;
  }
  report(worst < 1e-15 && offOk && onStrip > 0, 'the model surface: v − v̄_bearing + flattening on the strip, NaN off it', `${onStrip} stations, worst ${worst.toExponential(1)} m`);
}

// ── 4. the rounds settle against a stand-in ───────────────────────────────────
{
  const sv = converge(new StackSolver({ ...defaultParams('4hi'), ...GATE }));
  const W = sv.p.width;
  const crown = (x) => 20e-6 * (1 - (2 * x / W) ** 2);
  const fem = () => { const m = modelRollSurface(sv); return Float64Array.from(m, (v, s) => (Number.isFinite(v) ? 1.03 * v + crown(sv.x[s]) : NaN)); };
  const cp = new RollCoupling(sv.ns);
  let r;
  const log = [];
  for (let k = 0; k < 10; k++) {
    const model = modelRollSurface(sv);
    r = cp.step(model, fem(), sv.result.force);
    log.push(`${um(r.change)}`);
    if (r.converged) break;
    sv.setRollCorrection(cp.delta);
    converge(sv);
  }
  const model = modelRollSurface(sv), f = fem();
  let resid = 0;
  for (let s = 0; s < sv.ns; s++) if (Number.isFinite(model[s])) resid = Math.max(resid, Math.abs(f[s] - model[s] - cp.delta[s]));
  report(r.converged && r.round <= 6, 'the rounds reach the steady state', `${r.round} rounds, δ moved ${log.join(' → ')} µm`);
  report(resid < 0.5e-6, 'steady: δ is the stand-in\'s surface less the model\'s', `worst ${um(resid)} µm`);
}

// ── 5. the profile between points ─────────────────────────────────────────────
{
  const xs = [0, 0.1, 0.3], v = [1, 3, 7];
  const got = [interpolateProfile(xs, v, 0.05), interpolateProfile(xs, v, -0.2), interpolateProfile(xs, v, 0.5), interpolateProfile(xs, v, 0)];
  report(sameBits(got, [2, 5, 7, 1]), 'profile: linear, mirrored, ends held', got.join(', '));
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
