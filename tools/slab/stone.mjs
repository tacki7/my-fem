// Stone's minimum rollable thickness (`stone.ts`) against the app's own slab method.
//
//   node tools/slab/stone.mjs      (exit 1 on FAIL)
//
// 1. STONE_Z_MAX is max_a a^2/(e^a - 1), found here by bisecting the stationary
//    condition a = 2 (1 - e^-a) and cross-checked on a dense grid.
// 2. slabLoad (Kármán + Hitchcock, kf constant: lmnN = 0) runs away below some
//    entry gauge. Bisected, that gauge
//      (a) is where the exact finite-draft condition a^2 = d + z (e^a - 1) stops
//          having a root, d = mu^2 R dh / h̄^2, z = C mu R k* / h̄ - the reference
//          is written out again here, not imported;
//      (b) sits within 2 % of stoneMinThickness in mean gauge h̄, and about 54 %
//          above C mu R k* - the limit the app used to report.
//
// The drafts are chosen so the runaway is Stone's and not slabLoad's R'/R <= 100
// cap: at the boundary R'/R = a^2/d, so a draft of 1e-4 (d ~ 1e-3) hits the cap
// long before the arc runs away and has no Stone boundary to find at all. The
// cases are set to d ~ 0.03-0.04 (R'/R ~ 60-80); the finite-draft term moves the
// limit by about d/((e^a - 1) z_max), so ~1.5 % above the zero-draft h_min.
import { slabLoad } from './build/sim/muinv.js';
import { STONE_Z_MAX, stoneMinThickness } from './build/sim/stone.js';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

// --- 1. the constant ------------------------------------------------------------
// d/da [a^2/(e^a - 1)] = 0  <=>  a = 2 (1 - e^-a); a - 2(1 - e^-a) is negative on
// (0, a*) and positive above it.
let lo = 1, hi = 2;
for (let i = 0; i < 200; i++) {
  const m = 0.5 * (lo + hi);
  if (m === lo || m === hi) break;
  if (m - 2 * (1 - Math.exp(-m)) < 0) lo = m; else hi = m;
}
const aStar = 0.5 * (lo + hi);
const zStar = (aStar * aStar) / Math.expm1(aStar);
let gridMax = 0;
for (let k = 1; k <= 200000; k++) { const a = (6 * k) / 200000; gridMax = Math.max(gridMax, (a * a) / Math.expm1(a)); }
check('STONE_Z_MAX = max a²/(eᵃ−1)', Math.abs(STONE_Z_MAX - zStar) < 1e-12 && Math.abs(gridMax - zStar) < 1e-9,
  `bisection ${zStar.toPrecision(15)} at a = ${aStar.toPrecision(6)}, grid ${gridMax.toPrecision(15)}, exported ${STONE_Z_MAX}`);
check('Stone\'s published 3.58 D = C·E·2R/z_max at ν = 0.3', Math.abs((16 * 0.91) / (Math.PI * STONE_Z_MAX) / 2 - 3.58) < 0.005,
  `C·E/z_max = ${((16 * 0.91) / (Math.PI * STONE_Z_MAX)).toFixed(4)} per R, ${((16 * 0.91) / (Math.PI * STONE_Z_MAX) / 2).toFixed(4)} per D`);

// --- 2. the runaway boundary ----------------------------------------------------
/** max_a (a^2 - d)/(e^a - 1), by the stationary condition 2a(e^a - 1) = (a^2 - d) e^a. */
function zMax(d) {
  let a0 = Math.sqrt(d), a1 = 8;
  const s = (a) => 2 * a * Math.expm1(a) - (a * a - d) * Math.exp(a);
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (a0 + a1);
    if (m === a0 || m === a1) break;
    if (s(m) > 0) a0 = m; else a1 = m;
  }
  const a = 0.5 * (a0 + a1);
  return (a * a - d) / Math.expm1(a);
}
/** Geometric bisection of a predicate that is false below the answer and true above it. */
function bisectUp(ok, h0lo, h0hi) {
  if (ok(h0lo) || !ok(h0hi)) return NaN;
  for (let i = 0; i < 80; i++) {
    const m = Math.sqrt(h0lo * h0hi);
    if (ok(m)) h0hi = m; else h0lo = m;
  }
  return h0hi;
}

const law = { lmnL: 0, lmnM: 0.01, lmnN: 0, heatOn: false, tempEntry: 20, tempMelt: 1500, softenExp: 1.0 };
const CASES = [
  // label, roll E / nu, R [m], mu, kf [Pa], back / front tension [Pa]
  { tag: 'steel roll R190 μ0.06 kf1200', E: 2.1e11, nu: 0.30, R: 0.19, mu: 0.06, kf: 1200e6, sb: 0, sf: 0 },
  { tag: 'steel roll R190 μ0.12 kf1200', E: 2.1e11, nu: 0.30, R: 0.19, mu: 0.12, kf: 1200e6, sb: 0, sf: 0 },
  { tag: 'steel roll R100 μ0.03 kf700', E: 2.1e11, nu: 0.30, R: 0.10, mu: 0.03, kf: 700e6, sb: 0, sf: 0 },
  { tag: 'carbide R25 μ0.08 kf900 σ100/200', E: 5.5e11, nu: 0.22, R: 0.025, mu: 0.08, kf: 900e6, sb: 100e6, sf: 200e6 },
];
const D_TARGET = 0.035;

let worstRef = 0, worstNew = 0, bestOld = Infinity, capHit = 0;
for (const cs of CASES) {
  const p = { ...law, Eroll: cs.E, nuRoll: cs.nu, rollCoupling: true, flattening: 'hitchcock', slabTheory: 'karman', lmnL: cs.kf };
  const kEff = cs.kf - (cs.sb + cs.sf) / 2;
  const C = (16 * (1 - cs.nu * cs.nu)) / (Math.PI * cs.E);
  const hOld = C * cs.mu * cs.R * kEff;
  // d at the boundary is about mu r z_max / (C k*); pick r for D_TARGET.
  const r = (D_TARGET * C * kEff) / (cs.mu * STONE_Z_MAX);
  const pass = (h0) => ({ h0, h1: h0 * (1 - r), R: cs.R, backTension: cs.sb, frontTension: cs.sf, entryStrain: 0 });

  const h0Slab = bisectUp((h0) => Number.isFinite(slabLoad(p, pass(h0), cs.mu).load), 0.1 * hOld, 50 * hOld);
  const at = slabLoad(p, pass(h0Slab), cs.mu);
  const RpR = at.Rflat / cs.R;
  if (!(RpR < 95)) capHit++;
  const kSlab = at.kEff;

  const h0Ref = bisectUp((h0) => {
    const hbar = h0 * (1 - r / 2);
    const d = (cs.mu * cs.mu * cs.R * r * h0) / (hbar * hbar);
    return C * cs.mu * cs.R * kEff / hbar <= zMax(d);
  }, 0.1 * hOld, 50 * hOld);

  const hbarSlab = h0Slab * (1 - r / 2), h1Slab = h0Slab * (1 - r);
  const hMin = stoneMinThickness(cs.E, cs.nu, cs.mu, cs.R, kEff);
  const eRef = Math.abs(h0Slab / h0Ref - 1);
  const eNew = Math.abs(hbarSlab / hMin - 1);
  const eOld = Math.abs(hbarSlab / hOld - 1);
  worstRef = Math.max(worstRef, eRef); worstNew = Math.max(worstNew, eNew); bestOld = Math.min(bestOld, eOld);
  console.log(`      ${cs.tag}: r ${r.toFixed(4)}, runaway below h₀ ${(h0Slab * 1e6).toFixed(2)} µm`
    + ` (h̄ ${(hbarSlab * 1e6).toFixed(2)}, h₁ ${(h1Slab * 1e6).toFixed(2)}); exact ${(h0Ref * 1e6).toFixed(2)};`
    + ` h_min ${(hMin * 1e6).toFixed(2)}, C·μ·R·k* ${(hOld * 1e6).toFixed(2)};`
    + ` h̄/h_min ${(hbarSlab / hMin).toFixed(4)}, h₁/h_min ${(h1Slab / hMin).toFixed(4)}, h̄/(CμRk*) ${(hbarSlab / hOld).toFixed(4)};`
    + ` R'/R ${RpR.toFixed(1)}, a ${at.a.toFixed(3)}, k* ${(kSlab / 1e6).toFixed(1)} MPa`);
}
check('the cases run away on the arc, not on slabLoad\'s R\'/R cap', capHit === 0, `${capHit} of ${CASES.length} at R'/R >= 95`);
check('slabLoad runaway = exact finite-draft condition', worstRef < 2e-3, `worst |Δh₀|/h₀ ${worstRef.toExponential(2)}`);
check('slabLoad runaway within 2 % of stoneMinThickness (h̄)', worstNew < 0.02, `worst ${(100 * worstNew).toFixed(2)} %`);
check('…and nowhere near C·μ·R·k* (the old limit)', bestOld > 0.4, `closest ${(100 * bestOld).toFixed(1)} % off`);

// The draft term only moves the limit up, and it vanishes with the draft - so the
// zero-draft h_min is the bound the finite-draft boundaries close in on.
const trail = [0.3, 0.1, 0.03, 0.01, 1e-3, 1e-4, 1e-6].map(zMax);
const rising = trail.every((z, i) => i === 0 || z > trail[i - 1]);
check('z_max(d) rises to STONE_Z_MAX as the draft vanishes',
  rising && Math.abs(trail[trail.length - 1] / STONE_Z_MAX - 1) < 1e-5 && trail.every((z) => z <= STONE_Z_MAX),
  `d 0.3 → 1e-6: ${trail.map((z) => (z / STONE_Z_MAX).toFixed(5)).join(', ')} × z_max`);

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
