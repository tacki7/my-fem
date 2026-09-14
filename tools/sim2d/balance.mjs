// The rolling load against the forces that hold the strip: the reported load
// integrates a pressure recovered from element stresses, the reactions on the
// symmetry plane and the entry face are the discrete system's own.
//
//   node tools/sim2d/balance.mjs      (exit 1 on FAIL; about 30 s)
//
// 1. Calibration: a flat strip with no roll, pulled at both ends. The entry
//    face has to supply exactly (σb − σf)·h/2, and nothing holds it vertically.
// 2. On every rolling case, the reactions have to equal what the interface
//    terms of the assembled system put on the strip, node by node - that is
//    what makes `loadReaction` the discrete roll load and not another estimate.
//    Only on frames whose Picard step has converged (CONVERGED): the field is
//    relaxed towards the solve, and until the step is ~0 the relaxed field does
//    not satisfy the system, the penalty terms amplifying the difference. A case
//    that never converges (ロール E 70 GPa, which keeps moving at 1e-5..4e-4)
//    is reported, not failed - its reactions are not the discrete load. The
//    default case must be checked, or the check has nothing to stand on.
// 3. The table: reported load / reaction load, the free-surface force that
//    separates them, and the horizontal residual, over the solves.mjs cases
//    and the mesh presets.
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';
import { RollingSim, setSlabHook } from './build/sim/solver.js';
import { FlowSolver } from './build/sim/flow.js';
import { slabLoad } from './build/sim/muinv.js';

setSlabHook(slabLoad);
const MPA = 1e6;
let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ── 1. flat strip, no contact ───────────────────────────────────────────────
for (const [sb, sf] of [[50 * MPA, 120 * MPA], [0, 0], [200 * MPA, 30 * MPA]]) {
  const nx = 60, ny = 6, half = 0.001, L = 0.02, vIn = 1;
  const fl = new FlowSolver(nx, ny);
  const m = fl.mesh;
  for (let i = 0; i <= nx; i++) {
    const x = -L + (L * i) / nx;
    m.xs[i] = x;
    for (let j = 0; j <= ny; j++) {
      m.X[2 * (i * m.rows + j)] = x;
      m.X[2 * (i * m.rows + j) + 1] = (half * j) / ny;
    }
  }
  const sigmaF = 700 * MPA, rate = 50;
  const muRef = sigmaF / (3 * rate);
  const inp = {
    sigmaF: new Float64Array(m.nn).fill(sigmaF), vIn, vRoll: vIn, rollCx: 0, rollCy: 1,
    contactFrom: 1, contactTo: 0, contactWeight: new Float64Array(nx + 1), entryBisector: false,
    mu: 0, vSlip0: 1e-6, kBulk: 2000 * muRef, normalPenalty: 1e5, eps0: 0.02 * rate,
    // A tolerance far below the app's: at 1e-12 the warm-started PCG takes
    // no step once the field is near, and the reaction stops at 1.7e-7 of
    // σ·h/2 - the solve's residual, not the check's.
    muCap: 150 * muRef, muRef, backTension: sb, frontTension: sf, maxIter: 2000, tol: 1e-15,
  };
  fl.seed(vIn, half);
  const it = 60;
  for (let k = 0; k < it; k++) fl.solve(inp, 0.6);
  const cf = fl.constraintForces(inp);
  const exact = (sb - sf) * half;
  const scale = sigmaF * half;   // the stress the problem works at, times the face
  const errX = Math.abs(cf.entryX - exact) / scale;
  const vertical = Math.abs(cf.symmetryY + cf.entryY + cf.freeSurfaceY) / scale;
  report(errX < 1e-8 && vertical < 1e-8,
    `(harness) flat strip σb ${sb / MPA} / σf ${sf / MPA} MPa: entry reaction = (σb − σf)·h/2`,
    `${(cf.entryX / 1e3).toFixed(6)} vs ${(exact / 1e3).toFixed(6)} kN/m (|err| ${errX.toExponential(1)} of σf·h/2), `
    + `vertical sum ${vertical.toExponential(1)}, ${it} Picard iterations`);
}

// ── 2./3. rolling cases ─────────────────────────────────────────────────────
const FRAMES = 900, TAIL = 300;
/**
 * A Picard step this small counts as converged. It was 1e-6, and that let through
 * frames still relaxing: on macOS arm64 every frame counted in the foil case had a
 * step of exactly 0 and checked to 6e-8, while on Linux x64 - where V8's Math
 * functions differ in the last digits - the same case kept moving just under 1e-6
 * and read 2.8e-2. At 1e-6 the E 70 GPa frames check to 1.4. The step is 0 where
 * the solve has truly settled, so a bound far below the relaxation's own scale.
 */
const CONVERGED = 1e-12;
/** frame counts of the Picard step by decade, for the report */
const STEP_BINS = [['0', 0], ['<1e-12', 1e-12], ['<1e-9', 1e-9], ['<1e-6', 1e-6], ['<1e-3', 1e-3], ['>=1e-3', Infinity]];
const cases = [
  ['冷間圧延 (既定)', {}],
  ['箔圧延', { R: 0.03, h0: 0.00005, reduction: 0.25, omega: 3, mu: 0.08 }],
  ['圧下率 45%', { reduction: 0.45 }],
  ['μ 0.2', { mu: 0.2 }],
  ['ロール E 70 GPa', { Eroll: 7e10 }],
  ['荷重一定 AGC', { agcMode: 'force' }],
  ['メッシュ 軽量 70×6', { stripNx: 70, stripNy: 6, rollNt: 140, rollNr: 4 }],
  ['メッシュ 高精度 140×10', { stripNx: 140, stripNy: 10, rollNt: 260, rollNr: 6 }],
  ['メッシュ 最高 200×14', { stripNx: 200, stripNy: 14, rollNt: 340, rollNr: 8 }],
];

/** What the interface terms of the assembled system put on the strip, rebuilt node by node. */
function interfaceForces(sim, inp) {
  const fl = sim.flow, m = fl.mesh;
  const kN = inp.normalPenalty * inp.muRef;
  let x = 0, y = 0;
  for (let i = inp.contactFrom; i <= inp.contactTo; i++) {
    const nd = m.topNodes[i];
    const ip = Math.min(m.nx, i + 1), im = Math.max(0, i - 1);
    const dx = m.X[2 * m.topNodes[ip]] - m.X[2 * m.topNodes[im]];
    const sp = Math.abs(dx) > 1e-12 ? (m.X[2 * m.topNodes[ip] + 1] - m.X[2 * m.topNodes[im] + 1]) / dx : 0;
    const L = Math.hypot(sp, 1), nx = sp / L, ny = -1 / L, tx = -ny, ty = nx;
    const vn = fl.v[2 * nd] * nx + fl.v[2 * nd + 1] * ny;
    const iPrev = Math.max(inp.contactFrom, i - 1), iNext = Math.min(inp.contactTo, i + 1);
    const seg = Math.max((m.X[2 * m.topNodes[iNext]] - m.X[2 * m.topNodes[iPrev]]) / (iNext - iPrev), 1e-9);
    const onRoll = Math.max(seg * Math.min(1, Math.max(inp.contactWeight[i], 0)), 1e-12);
    const ft = fl.ifShear[i] * onRoll;
    x += -kN * vn * nx + ft * tx;
    y += -kN * vn * ny + ft * ty;
  }
  return { x, y };
}

const rows = [];
let worstClosure = 0;
for (const [name, patch] of cases) {
  const p = defaultParams(patch);
  const sim = new RollingSim(p);
  // The barrel terms are rebuilt at the moment the solver reads its
  // reactions: after the step the mesh is re-laid into the new gap, and
  // slopes taken from that mesh are not the ones the system was assembled on.
  let barrel = null;
  const forces = sim.flow.constraintForces.bind(sim.flow);
  sim.flow.constraintForces = (inp) => { barrel = interfaceForces(sim, inp); return forces(inp); };
  const acc = { P: 0, R: 0, F: 0, B: 0, n: 0 };
  let closure = 0, nonFinite = 0, converged = 0;
  const steps = STEP_BINS.map(() => 0);
  for (let f = 0; f < FRAMES; f++) {
    sim.advance(1 / 60);
    const d = sim.diag;
    if (![d.rollForce, d.loadReaction, d.loadFreeSurface, d.balanceX].every(Number.isFinite)) nonFinite++;
    if (f < FRAMES - TAIL) continue;
    acc.P += d.loadFem; acc.R += d.loadReaction; acc.F += d.loadFreeSurface; acc.B += d.balanceX; acc.n++;
    // loadReaction + loadFreeSurface + (barrel terms) = 0 up to the free rows' residual
    steps[STEP_BINS.findIndex(([, hi]) => (hi === 0 ? d.picardDelta === 0 : d.picardDelta < hi))]++;
    if (d.picardDelta < CONVERGED) {
      converged++;
      closure = Math.max(closure, Math.abs(d.loadReaction + d.loadFreeSurface + barrel.y) / d.loadReaction);
    }
  }
  worstClosure = Math.max(worstClosure, closure);
  const P = acc.P / acc.n, R = acc.R / acc.n, F = acc.F / acc.n, B = acc.B / acc.n;
  rows.push({ name, P, R, F, B, mu: p.mu, closure, nonFinite, converged });
  const dist = STEP_BINS.map(([label], i) => `${label}: ${steps[i]}`).filter((x) => !x.endsWith(': 0')).join(', ');
  if (converged === 0 && nonFinite === 0) {
    console.log(`NOTE  ${name}: no frame with a Picard step below ${CONVERGED} in ${FRAMES - TAIL}-${FRAMES} (steps ${dist}); reactions not checked, table row is not the discrete load`);
    continue;
  }
  report(nonFinite === 0 && closure < 1e-4, `${name}: reactions = the interface terms of the solved system`,
    `worst |R + F_free + F_barrel| / R ${closure.toExponential(1)} on ${converged}/${TAIL} converged frames (steps ${dist}), non-finite ${nonFinite}`);
}
{
  const ran = rows.filter((r) => r.converged > 0).length;
  const base = rows.find((r) => r.name === '冷間圧延 (既定)');
  report(ran * 2 > cases.length && base && base.converged > 0, '(harness) the reaction check actually ran, the default case among them',
    `${ran} of ${cases.length} cases had converged frames; the default case ${base && base.converged > 0 ? 'checked' : 'NOT checked'}`);
}

console.log(`\nmean over frames ${FRAMES - TAIL}-${FRAMES} (loads per unit width, half model)`);
console.log('| 条件 | 面圧積分 P [MN/m] | 反力 R [MN/m] | P / R | 自由表面の力 / R | (R + 自由表面) / P | 水平残差 / μP | Picard 収束フレーム |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.name} | ${(r.P / MPA).toFixed(4)} | ${(r.R / MPA).toFixed(4)} | ${(r.P / r.R).toFixed(4)} | `
    + `${(r.F / r.R).toFixed(4)} | ${((r.R + r.F) / r.P).toFixed(4)} | ${(r.B / (r.mu * r.P)).toExponential(2)} | ${r.converged}/${TAIL} |`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
