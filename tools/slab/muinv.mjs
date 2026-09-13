// What muFromLoad's bisection stands on, checked on a grid of passes for every theory and
// both flattenings: the hypotheses of docs/proofs/MuInverse.lean at a fixed R', the load
// P(mu) monotone with the flattening fixed point in it, runaway closed upwards, and the
// status a pass with no load at any mu is given.
//
//   node tools/slab/muinv.mjs            (exit 1 on FAIL; about half a minute)
import { slabLoad, muFromLoad, MU_MIN, MU_MAX } from './build/sim/muinv.js';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

const base = {
  Eroll: 2.1e11, nuRoll: 0.30, rollCoupling: true,
  lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255, heatOn: true, tempEntry: 20, tempMelt: 1500, softenExp: 1.0,
};
// R, h0, reduction, (sigma_b, sigma_f). 600/600 MPa is past kf on a fresh strip; 300/0 and
// 0/300 put one end near its own yield, which is where Bland & Ford's two sides part.
const grid = (heavy) => {
  const out = [];
  for (const R of heavy ? [0.1, 0.19] : [0.03, 0.19, 0.3])
    for (const h0 of heavy ? [0.002] : [0.0002, 0.002, 0.005])
      for (const red of heavy ? [0.1, 0.3] : [0.05, 0.25, 0.45])
        for (const [sb, sf] of [[0, 0], [100e6, 100e6], [300e6, 0], [0, 300e6], [600e6, 600e6], [0, 600e6]])
          out.push({ h0, h1: h0 * (1 - red), R, backTension: sb, frontTension: sf, entryStrain: 0 });
  return out;
};
const tag = (c) => `R${c.R} h0 ${c.h0} h1 ${c.h1.toPrecision(3)} σ${c.backTension / 1e6}/${c.frontTension / 1e6}`;

for (const theory of ['karman', 'blandford', 'orowan']) {
  const heavy = theory === 'orowan';
  const strict = theory !== 'orowan'; // Orowan's load stops moving once the whole arc sticks
  for (const flattening of ['hitchcock', 'roberts']) {
    const p = { ...base, slabTheory: theory, flattening };
    const NMU = heavy ? 24 : 60;
    const mus = Array.from({ length: NMU + 1 }, (_, k) => MU_MIN * Math.pow(MU_MAX / MU_MIN, k / NMU));
    let hypWorst = 0, hypWhere = '', monoWorst = 0, monoWhere = '', flatSteps = 0;
    let finiteAfterRunaway = 0, tensionBad = [], tensionCount = 0, trWorst = 0, trWhere = '', trCount = 0;
    for (const c of grid(heavy)) {
      // (1) hypotheses at a fixed radius: non-decreasing in mu and in R'
      const radii = [1, 1.5, 3, 8].map((f) => f * c.R);
      const P = radii.map((Rp) => mus.map((mu) => slabLoad(p, c, mu, Rp).load));
      for (let i = 0; i < radii.length; i++) for (let k = 1; k <= NMU; k++) {
        const dMu = P[i][k - 1] > 0 ? 1 - P[i][k] / P[i][k - 1] : 0;
        const dR = i > 0 && P[i - 1][k] > 0 ? 1 - P[i][k] / P[i - 1][k] : 0;
        const d = Math.max(dMu, dR);
        if (d > hypWorst) { hypWorst = d; hypWhere = `${tag(c)} R'/R ${radii[i] / c.R} mu ${mus[k].toFixed(4)}`; }
      }
      // (2) the load muFromLoad actually bisects, flattening fixed point included
      const L = mus.map((mu) => slabLoad(p, c, mu).load);
      let ran = false;
      for (let k = 0; k <= NMU; k++) {
        if (L[k] === Infinity) ran = true;
        else if (ran) finiteAfterRunaway++;
        if (k === 0 || !Number.isFinite(L[k]) || !Number.isFinite(L[k - 1]) || !(L[k - 1] > 0)) continue;
        const d = 1 - L[k] / L[k - 1];
        if (d > monoWorst) { monoWorst = d; monoWhere = `${tag(c)} mu ${mus[k - 1].toFixed(4)}->${mus[k].toFixed(4)}`; }
        if (L[k] === L[k - 1]) flatSteps++;
      }
      // (3) no load at any mu is a tension problem, whatever the mean pull says
      if (L[NMU] === 0) {
        tensionCount++;
        const r = muFromLoad(p, c, 1e7);
        if (r.status !== 'tension') tensionBad.push(`${tag(c)} -> ${r.status}`);
      }
      // (4) round trip from a mu where the load is still rising - on passes muFromLoad
      // accepts at all: every theory is refused once the mean pull reaches kf (the same
      // gate the slab mode applies), even where Orowan's integration would still return
      // a positive number
      if (!(slabLoad(p, c, MU_MIN).kEff > 0)) continue;
      for (const k of [Math.floor(NMU / 4), Math.floor(NMU / 2)]) {
        if (!(L[k] > 0) || !Number.isFinite(L[k]) || !(L[k] < L[k + 1])) continue;
        const r = muFromLoad(p, c, L[k]);
        const e = Math.abs(r.mu / mus[k] - 1);
        trCount++;
        if (!(e <= trWorst) ) { trWorst = e; trWhere = `${tag(c)} mu ${mus[k].toFixed(4)} -> ${r.mu} (${r.status})`; }
      }
    }
    const name = `${theory}/${flattening}`;
    check(`${name}: load non-decreasing in mu and R' at fixed R'`, hypWorst <= 1e-9,
      `worst relative decrease ${hypWorst.toExponential(2)} ${hypWorst > 0 ? hypWhere : ''}`);
    check(`${name}: P(mu) non-decreasing with the flattening`, monoWorst <= 1e-9,
      `worst relative decrease ${monoWorst.toExponential(2)} ${monoWorst > 0 ? monoWhere : ''}`);
    if (strict) check(`${name}: P(mu) strictly increasing where finite`, flatSteps === 0, `${flatSteps} flat steps`);
    else console.log(`info  ${name}: ${flatSteps} flat steps in P(mu) (sticking plateau)`);
    check(`${name}: runaway closed upwards`, finiteAfterRunaway === 0, `${finiteAfterRunaway} finite loads above a runaway mu`);
    check(`${name}: zero load at MU_MAX -> 'tension'`, tensionBad.length === 0,
      `${tensionCount} passes${tensionBad.length ? '; ' + tensionBad.slice(0, 3).join('; ') : ''}`);
    check(`${name}: muFromLoad round trip`, trWorst <= 1e-9, `${trCount} trips, worst |dmu|/mu ${trWorst.toExponential(2)} ${trWorst > 1e-9 ? trWhere : ''}`);
  }
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
