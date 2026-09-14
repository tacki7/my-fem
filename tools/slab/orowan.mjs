// Orowan's pressure solve (`orowanPressure`) against an independent root, and the
// load it gives across the whole mu range the UI and muFromLoad reach.
//
//   node tools/slab/orowan.mjs                 checks only (exit 1 on FAIL)
//   node tools/slab/orowan.mjs <before-build>  also the load table against an older build
//
// @check
// @check-build slab
import { orowanPressure } from './build/sim/slab.js';
import { slabLoad, muFromLoad, MU_MIN, MU_MAX } from './build/sim/muinv.js';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

// --- 1. the root itself -------------------------------------------------------
// w and T written out again here rather than imported, so the reference does not
// share the code under test. The root is bisected to the last bit: g(p) = p - T(p)
// rises strictly (docs/proofs/Orowan.lean, residual_strictMonoOn).
const w = (a) => (a < 1e-6 ? 1 : 0.5 * (Math.sqrt(Math.max(0, 1 - a * a)) + Math.asin(a) / a));
const T = (q, kf, mu, p) => Math.max(q + w(Math.min(1, (2 * mu * p) / kf)) * kf, 0);
function rootByBisection(q, kf, mu) {
  let lo = Math.max(q + (Math.PI / 4) * kf, 0), hi = Math.max(q + kf, 0);
  if (lo - T(q, kf, mu, lo) >= 0) return lo;
  for (let i = 0; i < 200 && hi > lo; i++) {
    const m = 0.5 * (lo + hi);
    if (m === lo || m === hi) break;
    if (m - T(q, kf, mu, m) > 0) hi = m; else lo = m;
  }
  return 0.5 * (lo + hi);
}

const MUS = [0.005, 0.05, 0.1, 0.2, 0.3, 0.5, 0.6, 0.63, 0.64, 0.65, 0.7, 0.8, 0.9, 1.0];
for (const kf of [1, 700e6]) {
  let worstRoot = 0, worstResidual = 0, where = '';
  for (const mu of MUS) {
    for (let k = 0; k <= 4000; k++) {
      const q = kf * (-1.2 + (1.8 * k) / 4000);
      const p = orowanPressure(q, kf, mu);
      const eRoot = Math.abs(p - rootByBisection(q, kf, mu)) / kf;
      const eRes = Math.abs(p - T(q, kf, mu, p)) / kf;
      if (eRoot > worstRoot) { worstRoot = eRoot; where = `mu ${mu} q/kf ${(q / kf).toFixed(4)}`; }
      worstResidual = Math.max(worstResidual, eRes);
    }
  }
  check(`root, kf=${kf}`, worstRoot <= 1e-9, `max |p - root|/kf = ${worstRoot.toExponential(2)} (${where})`);
  check(`fixed point, kf=${kf}`, worstResidual <= 1e-9, `max |p - T(p)|/kf = ${worstResidual.toExponential(2)}`);
}
check('kf = 0', orowanPressure(-1, 0, 0.3) === 0 && orowanPressure(2, 0, 0.3) === 2, 'p = max(q, 0)');

// --- 2. the load, and mu back from it ------------------------------------------
// The default pass (src/main.ts params): R 190 mm, 2.0 -> 1.5 mm, LMN 1200/0.010/0.255,
// Hitchcock flattening, isothermal factor at 20 C.
const params = {
  R: 0.19, Eroll: 2.1e11, nuRoll: 0.30, rollCoupling: true, flattening: 'hitchcock',
  lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255,
  heatOn: true, tempEntry: 20, tempMelt: 1500, softenExp: 1.0,
  slabTheory: 'orowan',
};
const PASSES = {
  'no tension': { h0: 0.002, h1: 0.0015, R: 0.19, backTension: 0, frontTension: 0, entryStrain: 0 },
  // both pulls at 300 MPa, about 0.4 kf: q starts well below zero at both ends,
  // so the slipping root sits near a = 1 at high mu - where the old iteration broke
  'tension 300 MPa': { h0: 0.002, h1: 0.0015, R: 0.19, backTension: 300e6, frontTension: 300e6, entryStrain: 0 },
};

for (const [label, pass] of Object.entries(PASSES)) {
  // Past some mu the whole arc sticks and the load stops depending on mu; no
  // inverse can recover mu there, and muFromLoad says so ('high'). Round trips
  // are taken below that plateau only.
  const top = slabLoad(params, pass, MU_MAX).load;
  let worstInv = 0, whereInv = '', n = 0;
  for (const mu of [0.02, 0.06, 0.15, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    const P = slabLoad(params, pass, mu).load;
    if (!(P < top * (1 - 1e-6))) continue;
    n++;
    const r = muFromLoad(params, pass, P);
    const e = Math.abs(r.mu - mu) / mu;
    if (e > worstInv) { worstInv = e; whereInv = `(mu ${mu} -> ${r.mu}, ${r.status})`; }
  }
  check(`${label}: muFromLoad round trip below the sticking plateau (${n} mu)`, worstInv <= 1e-9,
    `max |dmu|/mu = ${worstInv.toExponential(2)} ${whereInv}`);

  let mono = true, prev = -Infinity, prevMu = 0, plateau = NaN;
  for (let i = 0; i <= 400; i++) {
    const mu = MU_MIN * Math.pow(MU_MAX / MU_MIN, i / 400);
    const P = slabLoad(params, pass, mu).load;
    if (!(P >= prev)) { mono = false; console.log(`  not increasing: mu ${prevMu.toFixed(5)} -> ${mu.toFixed(5)}: ${prev} -> ${P}`); }
    if (Number.isNaN(plateau) && P >= top * (1 - 1e-9)) plateau = mu;
    prev = P; prevMu = mu;
  }
  check(`${label}: load non-decreasing in mu over [MU_MIN, MU_MAX]`, mono,
    `401 points, log-spaced; load reaches its sticking value at mu ${plateau.toFixed(3)}`);
}

// --- 3. against an older build -------------------------------------------------
if (process.argv[2]) {
  const before = await import(new URL(`file://${process.argv[2]}/sim/muinv.js`).href);
  for (const [label, pass] of Object.entries(PASSES)) {
    console.log(`\n${label}\n   mu    load before [kN/m]   load after [kN/m]   after/before - 1`);
    for (const mu of [0.05, 0.1, 0.2, 0.3, 0.5, 0.6, 0.64, 0.7, 0.8, 0.9, 1.0]) {
      const a = before.slabLoad(params, pass, mu).load, b = slabLoad(params, pass, mu).load;
      console.log(`${mu.toFixed(2).padStart(5)}  ${(a / 1e3).toFixed(6).padStart(18)}  ${(b / 1e3).toFixed(6).padStart(18)}   ${(b / a - 1).toExponential(2)}`);
    }
  }
  const pass = PASSES['tension 300 MPa'];
  const time = (m) => {
    const t0 = performance.now();
    for (let r = 0; r < 3; r++) for (const mu of MUS) m.slabLoad(params, pass, mu);
    return (performance.now() - t0) / (3 * MUS.length);
  };
  time(before); time({ slabLoad });
  console.log(`\nslabLoad (orowan, with the flattening fixed point): before ${time(before).toFixed(2)} ms, after ${time({ slabLoad }).toFixed(2)} ms per call`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
