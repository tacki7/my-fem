// The strip and roll linear solves never run out of budget, across the presets and a
// few harder conditions. Both are PCG loops that return when they hit the iteration
// cap; the roll's result used to be discarded, so running out would not have shown.
//
// And that the strip's Picard iteration settles. Not having run out says nothing
// about that: with a roll E of 70 GPa every solve stopped well inside its cap while
// the mesh entry hunted between two positions and the update never fell below 1e-5
// (frames 600-900). Settled is an update under PICARD_SETTLED on at least half of
// those frames - not exactly 0: on Linux even the foil case keeps 37 of them
// between 1e-6 and 1e-3 (macOS: all 0).
//
//   node tools/sim2d/solves.mjs      (exit 1 on FAIL; 15 s of simulated time per case)
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';
import { RollingSim, setSlabHook } from './build/sim/solver.js';
import { slabLoad } from './build/sim/muinv.js';

setSlabHook(slabLoad);
const FRAMES = 900;
const TAIL = 300;
const PICARD_SETTLED = 1e-6;
const cases = {
  '冷間圧延 (既定)': {},
  '箔圧延': { R: 0.03, h0: 0.00005, reduction: 0.25, omega: 3, mu: 0.08 },
  '圧下率 45%': { reduction: 0.45 },
  'μ 0.2': { mu: 0.2 },
  'ロール E 70 GPa': { Eroll: 7e10 },
  '荷重一定 AGC': { agcMode: 'force' },
};

let failed = 0;
for (const [name, patch] of Object.entries(cases)) {
  const p = defaultParams(patch);
  const sim = new RollingSim(p);
  let stripMax = 0, rollMax = 0, rollRes = 0, stripAtCap = 0, rollAtCap = 0, nonFinite = 0, settled = 0, stepMax = 0;
  for (let f = 0; f < FRAMES; f++) {
    sim.advance(1 / 60);
    const d = sim.diag;
    stripMax = Math.max(stripMax, d.cgIterations);
    rollMax = Math.max(rollMax, d.rollCgIterations);
    rollRes = Math.max(rollRes, d.rollCgResidual);
    if (d.cgIterations >= p.cgIter) stripAtCap++;
    if (d.rollCgIterations >= 200) rollAtCap++;
    if (!Number.isFinite(d.rollForce)) nonFinite++;
    if (f >= FRAMES - TAIL) {
      if (d.picardDelta < PICARD_SETTLED) settled++;
      stepMax = Math.max(stepMax, d.picardDelta);
    }
  }
  const ok = stripAtCap === 0 && rollAtCap === 0 && nonFinite === 0 && settled * 2 >= TAIL;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  strip CG max ${stripMax}/${p.cgIter}, roll CG max ${rollMax}/200 `
    + `(residual max ${rollRes.toExponential(1)}), frames at a cap ${stripAtCap}/${rollAtCap}, non-finite load ${nonFinite}, `
    + `Picard update < ${PICARD_SETTLED.toExponential(0)} on ${settled}/${TAIL} (max ${stepMax.toExponential(1)})`);
}
if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
