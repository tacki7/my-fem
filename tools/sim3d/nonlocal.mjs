// The non-local flattening mode (`flatNonlocal`, see src/sim3d/flatnl.ts):
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/nonlocal.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. The kernel: cut off at L, a uniform line load gives the 2D law back
//    (2∫₀ᴸ K = 2 ln(4R/b) − 1) over the radii and half-widths of all five mills,
//    and the integral over an interval is odd in the way the geometry says.
// 2. The offsets on a uniform load across a 1000 mm strip: nothing in the middle,
//    about half the flattening taken away at the edge, rising monotonically inwards.
// 3. Off is off: `flatNonlocal: false` solves to the same bits as a stack that never
//    mentions it (4Hi, and a shifted 6Hi whose lower half is solved).
// 4. On: every mill converges; the unshifted 4Hi stays symmetric; its middle
//    (|x| ≤ 300 mm) is the local solve's to a few I-units while the edge drop grows;
//    and the latent flatness is settled in the strip grid (141 → 281 stations
//    within 2 %).
//
// @check
// @check-build sim3d
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
import { nlCutoff, nlKernelIntegral, nonlocalOffsets } from './build/flatnl.js';

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

// ── 1. the kernel ────────────────────────────────────────────────────────────
{
  let worst = 0, worstOdd = 0, n = 0;
  for (const R of [0.0325, 0.05, 0.09, 0.25, 0.3, 0.65]) {
    for (const b of [0.3e-3, 1e-3, 4e-3, 8e-3, 16e-3]) {
      const L = nlCutoff(R, b);
      const law = 2 * Math.log((4 * R) / b) - 1;
      worst = Math.max(worst, Math.abs(nlKernelIntegral(-L, L, b, L) - law) / law);
      // [s1, s2] and its mirror [−s2, −s1] hold the same load
      for (const [s1, s2] of [[-0.3 * L, 0.1 * L], [0.2 * L, 1.5 * L], [-2 * L, -0.4 * L]]) {
        worstOdd = Math.max(worstOdd, Math.abs(nlKernelIntegral(s1, s2, b, L) - nlKernelIntegral(-s2, -s1, b, L)));
      }
      n++;
    }
  }
  const L4 = nlCutoff(0.25, 8e-3);
  report(worst < 1e-9 && worstOdd < 1e-12 && Math.abs(L4 / (2 * 0.25 * Math.exp(-1.5)) - 1) < 0.01,
    'kernel: a uniform line load gives the 2D law back', `${n} (R, b) pairs, worst |2∫₀ᴸK − (2 ln(4R/b) − 1)| / law ${worst.toExponential(1)}, mirror ${worstOdd.toExponential(1)}; L(250 mm, 8 mm) = ${(L4 * 1e3).toFixed(1)} mm (2R·e^-1.5 = ${(2 * 0.25 * Math.exp(-1.5) * 1e3).toFixed(1)})`);
}

// ── 2. offsets on a uniform load ─────────────────────────────────────────────
{
  const W = 1.0, dx = 1e-3, n = Math.round(W / dx);
  const x = new Float64Array(n), c0 = new Float64Array(n), c1 = new Float64Array(n), q = new Float64Array(n).fill(1.2e7), b = new Float64Array(n).fill(8e-3);
  for (let i = 0; i < n; i++) { c0[i] = -W / 2 + i * dx; c1[i] = c0[i] + dx; x[i] = c0[i] + dx / 2; }
  const A = (1 - 0.3 * 0.3) / (Math.PI * 206e9), R = 0.25;
  const off = nonlocalOffsets(x, c0, c1, q, b, A, R);
  const local = A * q[0] * (2 * Math.log((4 * R) / b[0]) - 1);
  const mid = off[n / 2], edge = off[n - 1] / local;
  let monotone = true;
  for (let i = n / 2; i < n - 1; i++) if (off[i + 1] > off[i] + 1e-15) { monotone = false; break; }
  report(Math.abs(mid) < 1e-3 * local && edge < -0.45 && edge > -0.55 && monotone,
    'offsets: a uniform load across the strip', `local flattening ${(local * 1e6).toFixed(1)} µm; offset in the middle ${(mid * 1e6).toExponential(1)} µm, at the edge ${(edge * 100).toFixed(1)} % of the local value, 100 mm in ${(off[n - 100] / local * 100).toFixed(1)} %, monotone to the middle ${monotone}`);
}

// ── 3. off is off ────────────────────────────────────────────────────────────
for (const [label, mill, patch] of [['4Hi', '4hi', { stations: 81 }], ['6Hi shifted −50 mm', '6hi', { stations: 81, irShift: -0.05 }]]) {
  const base = { ...defaultParams(mill), ...patch };
  delete base.flatNonlocal;
  const a = solve(base), b = solve({ ...base, flatNonlocal: false });
  report(sameBits(a.sv.u, b.sv.u) && a.R.force === b.R.force,
    `${label}: flatNonlocal false = not given`, `${a.sv.u.length} unknowns bit-identical ${sameBits(a.sv.u, b.sv.u)}`);
}

// ── 4. on ────────────────────────────────────────────────────────────────────
{
  const rows = [];
  let allConv = true;
  for (const [mill, patch] of [['2hi', {}], ['4hi', {}], ['6hi', {}], ['6hi', { irShift: 0.1 }], ['12hi', {}], ['20hi', {}]]) {
    const p = { ...defaultParams(mill), stations: 81, ...patch, flatNonlocal: true };
    const { R, it } = solve(p);
    allConv &&= R.converged;
    rows.push(`${mill}${patch.irShift ? ' shift' : ''} ${R.converged ? 'conv' : 'NOT CONVERGED'} ${it} it, latent ${R.latentIU.toFixed(0)} IU`);
  }
  report(allConv, 'on: every mill converges (81 stations)', rows.join(' | '));

  const p = { ...defaultParams('4hi'), stations: 81 };
  const off = solve(p), on = solve({ ...p, flatNonlocal: true });
  const sl = on.sv.slices, n = sl.length;
  let asym = 0;
  for (let i = 0; i < n; i++) asym = Math.max(asym, Math.abs(on.R.dEps[sl[i].s] - on.R.dEps[sl[n - 1 - i].s]));
  const centre = (R, svx) => { const s = svx.slices.reduce((b, t) => (Math.abs(t.x) < Math.abs(b.x) ? t : b)); return R.dEps[s.s]; };
  let body = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(sl[i].x) > 0.3) continue;
    const dOn = on.R.dEps[sl[i].s] - centre(on.R, on.sv), dOff = off.R.dEps[off.sv.slices[i].s] - centre(off.R, off.sv);
    body = Math.max(body, Math.abs(dOn - dOff));
  }
  report(asym < 1e-9 && body * 1e5 < 5 && on.R.edgeDropR > 1.5 * off.R.edgeDropR && on.R.crown > off.R.crown,
    '4Hi on: symmetric, the middle unchanged, the edge thinner',
    `max |D(x) − D(−x)| ${asym.toExponential(1)}; |x| ≤ 300 mm latent differs from local by ${(body * 1e5).toFixed(2)} IU at most; edge drop ${(off.R.edgeDropR * 1e6).toFixed(1)} → ${(on.R.edgeDropR * 1e6).toFixed(1)} µm, C25 ${(off.R.crown * 1e6).toFixed(1)} → ${(on.R.crown * 1e6).toFixed(1)} µm, latent ${off.R.latentIU.toFixed(0)} → ${on.R.latentIU.toFixed(0)} IU`);

  const g1 = solve({ ...p, stripStations: 141, flatNonlocal: true }), g2 = solve({ ...p, stripStations: 281, flatNonlocal: true });
  const rel = Math.abs(g2.R.latentIU / g1.R.latentIU - 1);
  report(g1.R.converged && g2.R.converged && rel < 0.02,
    '4Hi on: settled in the strip grid', `latent ${g1.R.latentIU.toFixed(0)} (141 strip stations) → ${g2.R.latentIU.toFixed(0)} IU (281), ${(rel * 100).toFixed(2)} %; C25 ${(g1.R.crown * 1e6).toFixed(1)} → ${(g2.R.crown * 1e6).toFixed(1)} µm`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
