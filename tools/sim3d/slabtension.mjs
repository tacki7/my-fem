// The slab load's tension, mean or split (`slabTension`, see `splitDecrement` in src/sim3d/strip.ts):
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/slabtension.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. 'mean' is the load it always was: a stack with `slabTension: 'mean'` solves to the same
//    bits as one that never mentions it (4Hi with the plane FEM, 4Hi slab), and `sliceLoad`
//    with the field agrees bit for bit with a law that has none, over tensions from a
//    compression to past the cap, an elastic draft and a runaway pass.
// 2. 'split' with no tension is 'mean', bit for bit, on the same passes.
// 3. The sensitivities against Orowan (the 2D tab's slab method, integrated numerically):
//    Hill's load with the split decrement at a fixed R', −∂q/∂σf and −∂q/∂σb per unit arc,
//    within ±20 % of Orowan's on a grid of r 10/25/40 %, μ 0.03/0.06/0.12, R'/h₁ 50/200/1000
//    at the 4Hi default tensions (σb 0.07 k̄f, σf 0.11 k̄f), and on 80 % of a front-heavy and a
//    back-heavy grid. Passes outside what the solution assumes are left out and counted:
//    Orowan's friction sticking somewhere (μp ≥ k), or its neutral point at an end of the arc
//    (a sensitivity under 0.05 L). The mean tension on the same default grid has to miss the
//    band on more than half of the passes - so the comparison can fail.
// 4. `splitDecrement`'s derivative in the arc against a central difference.
// 5. The slice tangent the solve takes (a one-sided difference over max(1 MPa, 2 % σf)) against
//    a central difference of `sliceLoad` over 0.1 MPa, split and mean: the load is smooth in
//    σf, the Newton inside it included.
// 6. Every mill converges with 'split' (plane FEM at 81 stations, and the 4Hi slab), and the strip
//    consistency of tools/sim3d/audit-lib.mjs holds. On the 4Hi slab the tangent the solve takes is
//    the new formula's: at each loaded slice's state, the split/mean ratio of the slice solve's
//    dq/dσf is the load formula's ratio (which runs from well under 1 where the front tension is
//    low to nearly 1 at the centre, where it is 0.3 k̄f and the neutral point sits near the entry).
//
// @check
// @check-build sim3d
// @check-build slab
// @check-build sim2d
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
import { sliceLoad, splitDecrement, kfMean } from './build/strip.js';
import { stripConsistency } from './audit-lib.mjs';
import { slabPointAt, orowanBranches } from '../slab/build/sim/slab.js';
import { defaultParams as params2D } from '../sim2d/params.mjs';

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const defaults81 = (mill) => ({ ...defaultParams(mill), stations: 81 });
function solve(p) {
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  return { sv, R: sv.result, it };
}
const sameBits = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

// ── 1. mean is mean ─────────────────────────────────────────────────────────
for (const [label, mill, patch] of [['4Hi plane FEM', '4hi', {}], ['4Hi slab', '4hi', { stripModel: 'slab' }]]) {
  const base = { ...defaults81(mill), ...patch };
  delete base.slabTension;
  const a = solve(base), b = solve({ ...base, slabTension: 'mean' });
  report(sameBits(a.sv.u, b.sv.u) && Object.is(a.R.force, b.R.force) && Object.is(a.R.latentIU, b.R.latentIU) && Object.is(a.R.yieldRelief, b.R.yieldRelief),
    `${label}: slabTension 'mean' = not given`, `${a.sv.u.length} unknowns, force, latent flatness and yield relief bit-identical (${a.it} / ${b.it} iterations)`);
}
const LAW = { lmnL: 1200e6, lmnM: 0.01, lmnN: 0.255, E: 206e9, nu: 0.3, entryStrain: 0, mu: 0.06, tensionFeedback: true, R: 0.25, Eroll: 206e9, nuRoll: 0.3 };
// passes: [h0, h1, σb, σf, μ, entry strain] - a 4Hi pass, a light one, a heavy one, an elastic draft,
// tensions from a compression to past the cap, and a thin strip on a high friction that runs away
const PASSES = [
  [2e-3, 1.5158e-3, 50e6, 80e6, 0.06, 0], [2e-3, 1.8e-3, 50e6, 80e6, 0.06, 0], [2e-3, 1.2e-3, 150e6, 60e6, 0.1, 0.3],
  [2e-3, 2e-3 - 3e-6, 50e6, 80e6, 0.06, 0], [2e-3, 1.5e-3, -2e6, 600e6, 0.06, 0], [2e-3, 1.5e-3, 600e6, -2e6, 0.06, 0],
  [5e-5, 3e-5, 100e6, 120e6, 0.3, 0.8],
];
{
  let same = 0, sameZero = 0, runaway = 0;
  const lawNone = { ...LAW }, lawMean = { ...LAW, slabTension: 'mean' }, lawSplit = { ...LAW, slabTension: 'split' };
  for (const [h0, h1, sb, sf, mu, e0] of PASSES) {
    const a = sliceLoad({ ...lawNone, mu, entryStrain: e0 }, h0, h1, sb, sf), b = sliceLoad({ ...lawMean, mu, entryStrain: e0 }, h0, h1, sb, sf);
    if (Object.is(a.q, b.q) && Object.is(a.arc, b.arc)) same++;
    if (a.runaway) runaway++;
    const z0 = sliceLoad({ ...lawMean, mu, entryStrain: e0 }, h0, h1, 0, 0), z1 = sliceLoad({ ...lawSplit, mu, entryStrain: e0 }, h0, h1, 0, 0);
    if (Object.is(z0.q, z1.q) && Object.is(z0.arc, z1.arc)) sameZero++;
  }
  report(same === PASSES.length && runaway > 0, `sliceLoad: 'mean' = no field`, `${same}/${PASSES.length} passes bit-identical (a runaway pass among them: ${runaway > 0})`);
  // ── 2. no tension, no difference ──────────────────────────────────────────
  report(sameZero === PASSES.length, `sliceLoad: 'split' with no tension = 'mean'`, `${sameZero}/${PASSES.length} passes bit-identical`);
}

// ── 3. against Orowan ───────────────────────────────────────────────────────
{
  const P2 = { ...params2D({ lmnL: LAW.lmnL, lmnM: LAW.lmnM, lmnN: LAW.lmnN }), slabTheory: 'orowan' };
  const EQ = 2 / Math.sqrt(3);
  const grid = (tb, tf) => {
    const rows = [];
    for (const r of [0.1, 0.25, 0.4]) for (const mu of [0.03, 0.06, 0.12]) for (const RpH of [50, 200, 1000]) {
      const h0 = 0.002, h1 = h0 * (1 - r), dh = h0 - h1, Rp = RpH * h1, L = Math.sqrt(Rp * dh);
      const kf = kfMean(LAW, 0, EQ * Math.log(h0 / h1));
      const Qp = 1.08 + (1.79 * r * mu * Math.sqrt(1 - r) * L) / Math.sqrt(dh * h1) - 1.02 * r;
      const split = (sb, sf) => kf * L * (Qp + splitDecrement(h0, h1, L, mu, sb / kf, sf / kf)[0]);
      const mean = (sb, sf) => kf * L * Qp * (1 - (0.5 * (sb + sf)) / kf);
      const c = (sb, sf) => ({ h0, h1, R: 0.25, backTension: sb, frontTension: sf, entryStrain: 0 });
      const orowan = (sb, sf) => slabPointAt(P2, c(sb, sf), mu, Rp).load;
      const sb = tb * kf, sf = tf * kf, d = 0.02 * kf;
      const sens = (fn) => [-(fn(sb, sf + d) - fn(sb, sf - d)) / (2 * d * L), -(fn(sb + d, sf) - fn(sb - d, sf)) / (2 * d * L)];
      const br = orowanBranches(P2, c(sb, sf), mu, Rp);
      let stick = false;
      for (let i = 0; i <= br.N; i++) if (2 * mu * Math.min(br.pE[i], br.pI[i]) >= br.kfG[2 * i]) stick = true;
      const [of, ob] = sens(orowan), [sf_, sb_] = sens(split), [mf, mb] = sens(mean);
      rows.push({ r, mu, RpH, stick, atEnd: !(br.phin > 0 && br.phin < br.phi0) || of < 0.05 || ob < 0.05, of, ob, sf: sf_ / of, sb: sb_ / ob, mf: mf / of, mb: mb / ob });
    }
    return rows;
  };
  const inBand = (x) => x >= 0.8 && x <= 1.2;
  const fmt = (x) => `r ${x.r} μ ${x.mu} R'/h ${x.RpH}`;
  for (const [label, tb, tf, need] of [['4Hi default tensions σb 0.07 / σf 0.11 k̄f', 0.07, 0.11, 1], ['front-heavy σb 0.05 / σf 0.30 k̄f', 0.05, 0.3, 0.8], ['back-heavy σb 0.20 / σf 0.10 k̄f', 0.2, 0.1, 0.8]]) {
    const all = grid(tb, tf);
    const kept = all.filter((x) => !x.stick && !x.atEnd);
    const both = kept.filter((x) => inBand(x.sf) && inBand(x.sb));
    const worst = kept.reduce((w, x) => (Math.max(Math.abs(x.sf - 1), Math.abs(x.sb - 1)) > Math.max(Math.abs(w.sf - 1), Math.abs(w.sb - 1)) ? x : w), kept[0]);
    report(kept.length >= 15 && both.length >= need * kept.length,
      `split vs Orowan, ${label}: −∂q/∂σf and −∂q/∂σb within ±20 %`,
      `${both.length}/${kept.length} passes (need ${Math.round(need * 100)} %; left out: ${all.filter((x) => x.stick).length} sticking, ${all.filter((x) => !x.stick && x.atEnd).length} neutral point at an end); widest ${fmt(worst)} σf ×${worst.sf.toFixed(2)} σb ×${worst.sb.toFixed(2)}`);
    if (need === 1) {
      const meanMiss = kept.filter((x) => !(inBand(x.mf) && inBand(x.mb))).length;
      report(meanMiss > kept.length / 2, `the mean tension on the same passes misses the band (the comparison can fail)`,
        `${meanMiss}/${kept.length} passes out; e.g. ${fmt(kept[0])}: mean σf ×${kept[0].mf.toFixed(2)} σb ×${kept[0].mb.toFixed(2)}, split σf ×${kept[0].sf.toFixed(2)} σb ×${kept[0].sb.toFixed(2)}`);
    }
  }
}

// ── 4. the decrement's derivative in the arc ────────────────────────────────
{
  let worst = 0, n = 0;
  for (const r of [0.1, 0.25, 0.4]) for (const mu of [0.03, 0.12]) for (const RpH of [50, 1000]) for (const [tb, tf] of [[0.07, 0.11], [0.3, -0.003], [-0.003, 0.4]]) {
    const h0 = 0.002, h1 = h0 * (1 - r), dh = h0 - h1, L = Math.sqrt(RpH * h1 * dh), e = 1e-6 * L;
    const [dec, dDec] = splitDecrement(h0, h1, L, mu, tb, tf);
    const fd = (splitDecrement(h0, h1, L + e, mu, tb, tf)[0] - splitDecrement(h0, h1, L - e, mu, tb, tf)[0]) / (2 * e);
    worst = Math.max(worst, Math.abs(dDec - fd) / Math.max(Math.abs(fd), Math.abs(dec) / L)); n++;
  }
  report(worst < 1e-3, `splitDecrement: d/dL against a central difference`, `${n} passes, worst relative ${worst.toExponential(1)}`);
}

// ── 5. the slice tangent in σf ──────────────────────────────────────────────
{
  const out = [];
  let worst = 0;
  for (const slabTension of ['mean', 'split']) {
    for (const [h0, h1, sb, sf, mu] of [[2e-3, 1.5158e-3, 50e6, 80e6, 0.06], [2e-3, 1.8e-3, 50e6, -2e6, 0.06], [1e-3, 0.8e-3, 100e6, 120e6, 0.1]]) {
      const law = { ...LAW, mu, slabTension };
      const q = (s) => sliceLoad(law, h0, h1, sb, s).q;
      const ds = Math.max(1e6, 0.02 * Math.abs(sf));
      const oneSided = (q(sf + ds) - q(sf)) / ds, central = (q(sf + 0.05e6) - q(sf - 0.05e6)) / 0.1e6;
      const rel = Math.abs(oneSided - central) / Math.abs(central);
      worst = Math.max(worst, rel);
      if (h1 === 1.5158e-3) out.push(`${slabTension} −∂q/∂σf ${(-central * 1e3).toFixed(3)} mm`);
    }
  }
  report(worst < 0.01, `sliceLoad: the solve's one-sided σf tangent = a central difference`, `worst relative ${worst.toExponential(1)} over 3 passes each; 4Hi pass with the Roberts arc: ${out.join(', ')}`);
}

// ── 6. the mills with the tensions split ────────────────────────────────────
{
  for (const mill of ['2hi', '4hi', '6hi', '12hi', '20hi']) {
    const p = defaults81(mill);
    const mean = solve(p), split = solve({ ...p, slabTension: 'split' });
    const cons = stripConsistency(split.sv, split.sv.p);
    report(split.R.converged && cons.qRelMismatch < 2e-3 && split.it <= 1.5 * mean.it + 10,
      `${mill}: split converges`,
      `${split.it} iterations (mean ${mean.it}), force ${(split.R.force / 9.80665e3).toFixed(1)} tonf (mean ${(mean.R.force / 9.80665e3).toFixed(1)}), latent ${split.R.latentIU.toFixed(0)} I (mean ${mean.R.latentIU.toFixed(0)}), strip load consistency ${cons.qRelMismatch.toExponential(1)}`);
  }
  const p = { ...defaults81('4hi'), stripModel: 'slab', slabTension: 'split' };
  const split = solve(p);
  const cons = stripConsistency(split.sv, split.sv.p);
  // the tangent the solve takes, against the law's: at each loaded slice's own state, the
  // slice solve's dq/dσf with the split law over the same with the mean law, and the
  // load formula's ∂q/∂σf at the slice's h1 with each - the two ratios agree when the
  // slice tangents go through the new formula
  const sv = split.sv, law = sv.law;
  let worst = 0, lo = Infinity, hi = -Infinity, n = 0;
  for (const sl of sv.slices) {
    if (!(sl.q > 0)) continue;
    const sigma = sv.sigmaF[sl.s], g = sv.gapAt(sl.s);
    sv.law = { ...law, slabTension: 'split' };
    const tSplit = sv.solveSlice(sl, g, sigma).dqds;
    sv.law = { ...law, slabTension: 'mean' };
    const tMean = sv.solveSlice(sl, g, sigma).dqds;
    sv.law = law;
    const dq = (lw) => (sliceLoad(lw, sl.h0, sl.h1, p.backTension, sigma + 0.05e6, sl.q).q - sliceLoad(lw, sl.h0, sl.h1, p.backTension, sigma - 0.05e6, sl.q).q) / 0.1e6;
    const lawRatio = dq({ ...law, slabTension: 'split' }) / dq({ ...law, slabTension: 'mean' });
    worst = Math.max(worst, Math.abs(tSplit / tMean / lawRatio - 1));
    lo = Math.min(lo, lawRatio); hi = Math.max(hi, lawRatio); n++;
  }
  report(split.R.converged && cons.qRelMismatch < 1e-8 && worst < 0.05 && lo < 0.9,
    `4Hi slab: split converges, and the slice tangents carry the split formula`,
    `${split.it} iterations, strip load consistency ${cons.qRelMismatch.toExponential(1)}; over ${n} loaded slices the split/mean ratio of the slice solve's dq/dσf matches the load formula's within ${(worst * 100).toFixed(1)} % (formula ratio ${lo.toFixed(2)}-${hi.toFixed(2)} across the width: the front tension weighs less where it is low)`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
