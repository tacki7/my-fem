// The 2D element, assembly and linear solves against exact rational references.
//
//   tools/sim2d/build.sh && node tools/exact/check.mjs      (exit 1 on FAIL)
//
// reference.json is written by ExactRef.lean (Lean 4, all arithmetic in ℚ):
//   cd <lean project> && lake env lean ExactRef.lean > <my-fem>/tools/exact/reference.json
// See README.md for what it computes and why the numbers are exact.
//
// @check
// @check-build sim2d
import { readFileSync } from 'node:fs';
import { precomputeElements, assembleStiffness } from '../sim2d/build/sim/element.js';
import { buildCsrPattern, pcgFiltered, makePcgWorkspace } from '../sim2d/build/sim/sparse.js';
import { BandPreconditioner, bandwidthFor } from '../sim2d/build/sim/band.js';

const ref = JSON.parse(readFileSync(new URL('./reference.json', import.meta.url), 'utf8'));
const num = (s) => { const [p, q = '1'] = s.split('/'); return Number(BigInt(p)) / Number(BigInt(q)); };
const vec = (a) => Float64Array.from(a, num);

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};
const relMax = (a, b) => {
  let d = 0, s = 0;
  for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); s = Math.max(s, Math.abs(b[i])); }
  return d / s;
};

const E = num(ref.E), nu = num(ref.nu);
const mat = { E, nu, rho: 1 };

// --- 1. one parallelogram element --------------------------------------------------
{
  const xe = vec(ref.element.xe);
  const Kexact = Float64Array.from(ref.element.K.flat(), num);
  const { Ke } = precomputeElements(xe, Int32Array.from([0, 1, 2, 3]), mat);
  const e = relMax(Ke, Kexact);
  check('element.ts Q4 SRI stiffness = exact', e <= 1e-13, `max |ΔK|/max|K| ${e.toExponential(2)} (exact rank ${ref.element.rank})`);

  // the harness has to be able to fail: a Poisson ratio one percent off must show
  const { Ke: Koff } = precomputeElements(xe, Int32Array.from([0, 1, 2, 3]), { E, nu: nu * 1.01, rho: 1 });
  const eOff = relMax(Koff, Kexact);
  check('  (harness) nu off by 1 % is detected', eOff > 1e-3, `max |ΔK|/max|K| ${eOff.toExponential(2)}`);
}

// --- 1b. general quadrilaterals: area --------------------------------------------------
// Not a parallelogram, so no exact stiffness here - but docs/proofs/Q4Jacobian.lean shows
// det J is affine for any quad, so the 2x2 Gauss sum element.ts keeps as `area` is the
// shoelace area exactly, and equals the 4 det J(0,0) the volumetric term is weighted by.
{
  let worst = 0, n = 0;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 2000; t++) {
    // a convex, counter-clockwise quad: jitter the corners of a unit square
    const xe = Float64Array.from([0, 0, 1, 0, 1, 1, 0, 1].map((v) => v + 0.3 * (rnd() - 0.5)));
    const shoelace = 0.5 * ((xe[0] * xe[3] - xe[2] * xe[1]) + (xe[2] * xe[5] - xe[4] * xe[3])
      + (xe[4] * xe[7] - xe[6] * xe[5]) + (xe[6] * xe[1] - xe[0] * xe[7]));
    const { area } = precomputeElements(xe, Int32Array.from([0, 1, 2, 3]), mat);
    worst = Math.max(worst, Math.abs(area[0] / shoelace - 1));
    n++;
  }
  check('element.ts area (2x2 Gauss Σ det J) = shoelace, any quad', worst <= 1e-14, `${n} jittered quads, worst ${worst.toExponential(2)}`);
}

// --- 2. assembly into CSR ---------------------------------------------------------------
const m = ref.mesh;
const X = vec(m.X);
const quads = Int32Array.from(m.quads.flat());
const nn = X.length / 2, n = 2 * nn;
const Kd = ref.mesh.K.map((row) => row.map(num));
const pat = buildCsrPattern(nn, quads);
const vals = new Float64Array(pat.nnz);
assembleStiffness(precomputeElements(X, quads, mat), pat.scatter, vals);
{
  let worst = 0, outside = 0, scale = 0;
  const seen = new Set();
  for (let r = 0; r < n; r++) {
    for (let k = pat.rowPtr[r]; k < pat.rowPtr[r + 1]; k++) {
      const c = pat.colIdx[k];
      seen.add(r * n + c);
      worst = Math.max(worst, Math.abs(vals[k] - Kd[r][c]));
    }
    for (let c = 0; c < n; c++) {
      scale = Math.max(scale, Math.abs(Kd[r][c]));
      if (!seen.has(r * n + c) && Kd[r][c] !== 0) outside++;
    }
  }
  check('sparse.ts CSR assembly = exact global K', worst / scale <= 1e-13 && outside === 0,
    `max |ΔK|/max|K| ${(worst / scale).toExponential(2)}, exact nonzeros outside the pattern ${outside}`);
}

// --- 3. solves ----------------------------------------------------------------------------
const free = Uint8Array.from(m.free);
const f = vec(m.f);
const uExact = vec(m.u);
{
  const band = new BandPreconditioner(n, bandwidthFor(m.ny));
  band.factor(pat, vals, free);
  const u = new Float64Array(n);
  band.apply(f, u, free);
  const e = relMax(u, uExact);
  check('band.ts LDLᵀ solve = exact (strip-like mesh, no seam)', e <= 1e-12, `max |Δu|/max|u| ${e.toExponential(2)}`);

  // at the app's order of tolerance (cgTol 1e-8): one step does it. At 1e-14 the
  // rounding left by that step is itself over the bar and a second one runs.
  const z = new Float64Array(n);
  const res = pcgFiltered(pat, vals, f, free, z, makePcgWorkspace(n), 50, 1e-10, false, band);
  const e2 = relMax(z, uExact);
  check('PCG with the band factor: one step, exact', res.iterations <= 1 && e2 <= 1e-12,
    `${res.iterations} iterations, max |Δu|/max|u| ${e2.toExponential(2)}`);

  const zj = new Float64Array(n);
  const rj = pcgFiltered(pat, vals, f, free, zj, makePcgWorkspace(n), 1000, 1e-14, false, null);
  const e3 = relMax(zj, uExact);
  check('PCG with Jacobi = exact', e3 <= 1e-9, `${rj.iterations} iterations, residual ${rj.residual.toExponential(1)}, max |Δu|/max|u| ${e3.toExponential(2)}`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
