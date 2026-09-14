// The strip between two stands keeps its length and its compliance.
//
//   node tools/sim2d/queue.mjs                   (exit 1 on FAIL; about 30 s)
//   node tools/sim2d/queue.mjs <older build dir> the same on an older build (expect FAIL there)
//
// Two sums are carried by the transport queue (StripQueue, src/sim/tension.ts) and read
// by the line every frame: the strip length in the gap, which is the stand distance L,
// and Σ ℓ/h, whose inverse times E is the 'dist' model's spring. Both are kept as running
// sums, so both are compared here with the same sums rebuilt from the slices.
//
// 1. A queue on its own: 20 000 steps of strip at a wandering speed and gauge, with
//    gauge steps that open new slices and small moves that merge into the last one.
//    Strip in at the back, the same length out at the front.
// 2. The three-stand default with the 'dist' model, 40 s: the gaps' length against L
//    and their Σ ℓ/h against the slices, every frame. Before the fix these ended at
//    4.4887 / 4.4937 m and parted by up to 4.8e-4.
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';

const dir = process.argv[2] ?? new URL('./build', import.meta.url).pathname;
const { StripQueue } = await import(`${dir}/sim/tension.js`);
const { Mill } = await import(`${dir}/sim/mill.js`);
const { setSlabHook } = await import(`${dir}/sim/solver.js`);
const { slabLoad } = await import(`${dir}/sim/muinv.js`);
setSlabHook(slabLoad);

const TOL = 1e-12;
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

/** Σ ℓ and Σ ℓ/h rebuilt from the slices (a private field of the class; read, not written). */
function rebuilt(q) {
  let len = 0, loh = 0;
  for (const s of q.slices) { len += s.len; loh += s.len / s.h; }
  return { len, loh };
}

// ── 1. a queue on its own ───────────────────────────────────────────────────
{
  const L = 4.5;
  let h = 1.5e-3;
  const q = new StripQueue(L, h);
  let seed = 20260914;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let worstLen = 0, worstLoh = 0, worstRun = 0, maxSlices = 0, merges = 0, steps = 0;
  for (let i = 0; i < 20000; i++) {
    const v = 0.8 + 0.6 * rnd();
    if (rnd() < 0.02) h *= 0.9 + 0.2 * rnd();          // a gauge step: a new slice
    else h *= 1 + 2e-5 * (rnd() - 0.5);               // inside the merge band
    const before = q.count;
    // the step the line takes: the new API where there is one, else push and pop
    if (typeof q.advance === 'function') q.advance(v / 60, h);
    else { q.push(v / 60, h); q.pop(q.length - L); }
    if (q.count === before) merges++; else steps++;
    maxSlices = Math.max(maxSlices, q.count);
    const r = rebuilt(q);
    worstLen = Math.max(worstLen, Math.abs(r.len - L) / L);
    worstRun = Math.max(worstRun, Math.abs(q.length - L) / L);
    worstLoh = Math.max(worstLoh, Math.abs(q.sumLenOverH - r.loh) / r.loh);
  }
  check('queue alone: slices add up to L', worstLen < TOL && worstRun < TOL,
    `worst |Σℓ − L| / L ${worstLen.toExponential(2)}, running length ${worstRun.toExponential(2)}`);
  check('queue alone: Σ ℓ/h agrees with the slices', worstLoh < TOL,
    `worst ${worstLoh.toExponential(2)} over 20000 steps (${merges} merged, ${steps} opened or popped a slice, up to ${maxSlices} slices)`);
}

// ── 2. the three-stand default, 'dist' ─────────────────────────────────────
{
  const FRAMES = 2400;
  const p = defaultParams({ tensionModel: 'dist' });
  const setups = Array.from({ length: 3 }, (_, k) => ({
    R: p.R, mu: p.mu, reduction: p.reduction, targetForce: p.agcTargetForce,
    targetGauge: p.h0 * Math.pow(1 - p.reduction, k + 1),
    backTension: p.backTension, frontTension: 0, agcMode: p.agcMode,
  }));
  const mill = new Mill(p, setups);
  const L = p.standDistance;
  const worstLen = [0, 0], worstLoh = [0, 0], maxSlices = [0, 0];
  let nonFinite = 0;
  for (let f = 0; f < FRAMES; f++) {
    mill.sync(p, setups);
    mill.advance(1 / 60);
    mill.gapStates.forEach((g, k) => {
      const q = g.queue, r = rebuilt(q);
      worstLen[k] = Math.max(worstLen[k], Math.abs(q.length - L) / L, Math.abs(r.len - L) / L);
      worstLoh[k] = Math.max(worstLoh[k], Math.abs(q.sumLenOverH - r.loh) / r.loh);
      maxSlices[k] = Math.max(maxSlices[k], q.count);
      if (!Number.isFinite(g.T)) nonFinite++;
    });
  }
  const md = mill.diag;
  const gaps = mill.gapStates;
  check(`3 stands, 'dist', ${FRAMES / 60} s: every gap is L = ${L} m long`, worstLen.every((x) => x < TOL) && gaps.length === 2,
    `worst |ℓ − L| / L ${worstLen.map((x) => x.toExponential(2)).join(' / ')}, final ${gaps.map((g) => g.queue.length.toFixed(6)).join(' / ')} m`);
  check(`3 stands, 'dist', ${FRAMES / 60} s: Σ ℓ/h agrees with the slices`, worstLoh.every((x) => x < TOL) && nonFinite === 0,
    `worst ${worstLoh.map((x) => x.toExponential(2)).join(' / ')}, up to ${maxSlices.join(' / ')} slices; `
    + `tension ${gaps.map((g, k) => (md.tensionActual[k] / 1e6).toFixed(3)).join(' / ')} MPa, non-finite ${nonFinite}`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
