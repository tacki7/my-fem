// The analysis window against the bite it has to hold: when does `windowShortfall` flag,
// and does widening the window bring the loop back to its target?
//
//   node tools/sim2d/window.mjs                      (exit 1 on FAIL; a few minutes)
//   node tools/sim2d/window.mjs <older build dir>    also: the cases that never reach the
//                                                    limit land on the older build's numbers
//
// The window is sized at rebuild from the commanded draft, and the mesh entry is held at
// 0.8 of it. A load loop can roll far more than it was commanded; then the barrel meets
// the strip upstream of that limit, and after WINDOW_REFIT_FRAMES of that the window is
// widened to the real arc (`widenWindow`). One stand, the app's defaults, with:
//
//   open loop 25 %                              the default operating point
//   load = P(25 %), commanded 5 %               rolls ~21 %: the bite is 2x nominal, fits
//   load = P(40 %), commanded 25 %              rolls ~34 %: fits
//   load = P(40 %), commanded 5 %               rolls 35 % and more: past the limit
//   load = P(40 %), commanded 2 %               window sized for 2 %: past the limit
//   gauge 1.0 mm, commanded 5 %                 the gauge loop runs into the same wall
//
// P(r) is the open-loop load at commanded r, measured here first. Checked:
//   - cases that fit: the window is never widened and never flags
//   - cases past the limit: widened, no flag left at the end, the loop settled on its
//     target, and the load in the 30 frames after the widening at most 1.5x the load
//     just before it (the fields are carried to the new columns; left in place the
//     load peaked at 3.7x)
//   - every frame: a flag means the entry is held at the limit, and an entry off the
//     limit means no flag
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';

const older = process.argv[2];
const load = async (dir) => {
  const solver = await import(`${dir}/sim/solver.js`);
  const muinv = await import(`${dir}/sim/muinv.js`);
  solver.setSlabHook(muinv.slabLoad);
  return solver.RollingSim;
};
const RollingSim = await load(new URL('./build', import.meta.url).pathname);

const TONF = 9.80665e3, WIDTH = 1.3, DT = 1 / 60;
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

function run(Sim, patch, frames) {
  const p = defaultParams(patch);
  const sim = new Sim(p);
  let flagged = 0, disagree = 0, worst = 0;
  let refits = 0, refitAt = -1, before = NaN, jump = 0;
  for (let f = 0; f < frames; f++) {
    sim.advance(DT);
    const d = sim.diag;
    const s = d.windowShortfall ?? 0;
    const atLimit = sim.entryCross === 0.8 * sim.winIn;
    if (s > 0) flagged++;
    if ((s > 0) !== atLimit || s < 0) disagree++;
    worst = Math.max(worst, s);
    // the load this frame was solved before the widening at its end, on the old window
    if ((sim.windowRefits ?? 0) !== refits) { refits = sim.windowRefits; refitAt = f; before = d.rollForce; }
    else if (refitAt >= 0 && f - refitAt <= 30) jump = Math.max(jump, d.rollForce / before);
  }
  const d = sim.diag;
  return {
    sim, p, flagged, disagree, worst, refits, refitAt, jump,
    shortfall: d.windowShortfall ?? 0,
    load: (d.rollForce * WIDTH) / TONF,
    reduction: 1 - d.exitThickness / p.h0,
    h1: d.exitThickness,
    arc: -sim.entryCross,
    reach: -0.8 * sim.winIn,
    settled: d.agcSettled,
    loadError: p.agcMode === 'force' ? Math.abs(d.rollForce - p.agcTargetForce) / p.agcTargetForce : NaN,
    gaugeError: p.agcMode === 'gauge' ? Math.abs(d.exitThickness - p.agcTargetGauge) / p.agcTargetGauge : NaN,
  };
}

const P25 = run(RollingSim, {}, 900).sim.diag.rollForce;
const P40 = run(RollingSim, { reduction: 0.40 }, 900).sim.diag.rollForce;
// `refit`: the bite outgrows the window, which must then be widened. The gauge case is
// given longer: after the widening its feed loop takes until ~2300 frames to let the gap
// loop reach 1.0 mm.
const CASES = [
  { tag: 'open loop 25 %', patch: {}, frames: 900, refit: false },
  { tag: 'load P(25 %), cmd 5 %', patch: { agcMode: 'force', agcTargetForce: P25, reduction: 0.05 }, frames: 1800, refit: false },
  { tag: 'load P(40 %), cmd 25 %', patch: { agcMode: 'force', agcTargetForce: P40, reduction: 0.25 }, frames: 1800, refit: false },
  { tag: 'load P(40 %), cmd 5 %', patch: { agcMode: 'force', agcTargetForce: P40, reduction: 0.05 }, frames: 1800, refit: true },
  { tag: 'load P(40 %), cmd 2 %', patch: { agcMode: 'force', agcTargetForce: P40, reduction: 0.02 }, frames: 1800, refit: true },
  { tag: 'gauge 1.0 mm, cmd 5 %', patch: { agcMode: 'gauge', agcTargetGauge: 0.001, reduction: 0.05 }, frames: 3600, refit: true },
];
console.log(`P(25 %) ${((P25 * WIDTH) / TONF).toFixed(0)} tonf, P(40 %) ${((P40 * WIDTH) / TONF).toFixed(0)} tonf (open loop, ${900} frames)\n`);
console.log('case                      frames  load[tonf]  rolled   arc[mm]  limit[mm]  shortfall[mm]  flagged frames  settled  widened (frame)  jump');
const results = [];
for (const c of CASES) {
  const r = run(RollingSim, c.patch, c.frames);
  results.push({ c, r });
  console.log(`${c.tag.padEnd(26)}${String(c.frames).padStart(6)}  ${r.load.toFixed(0).padStart(10)}  ${(100 * r.reduction).toFixed(1).padStart(5)} %`
    + `  ${(r.arc * 1e3).toFixed(2).padStart(8)}  ${(r.reach * 1e3).toFixed(2).padStart(9)}  ${(r.shortfall * 1e3).toFixed(2).padStart(13)}`
    + `  ${String(r.flagged).padStart(14)}  ${String(r.settled).padStart(7)}  ${String(r.refits).padStart(7)} (${r.refitAt})  ${r.refits ? r.jump.toFixed(3) : '—'}`);
}
console.log('');
for (const { c, r } of results) {
  if (!c.refit) {
    check(`${c.tag}: fits, never widened`, r.refits === 0 && r.flagged === 0,
      `widened ${r.refits} times, ${r.flagged}/${c.frames} frames flagged`);
    continue;
  }
  const err = Number.isFinite(r.loadError) ? r.loadError : r.gaugeError;
  check(`${c.tag}: widened, no flag left, settled on target`,
    r.refits >= 1 && r.shortfall === 0 && r.settled && err < 0.01,
    `widened ${r.refits} (frame ${r.refitAt}), shortfall ${(r.shortfall * 1e3).toFixed(3)} mm, settled ${r.settled}, `
    + `${Number.isFinite(r.loadError) ? 'load' : 'gauge'} off target ${(100 * err).toFixed(2)} %`);
  check(`${c.tag}: the load over the 30 frames after widening stays within 1.5x`, r.refits >= 1 && r.jump <= 1.5,
    `peak / load before ${r.jump.toFixed(3)}`);
}
const disagree = results.reduce((s, { r }) => s + r.disagree, 0);
check('flag ⇔ entry held at the window limit, every frame', disagree === 0, `${disagree} frames disagree`);

if (older) {
  // Widening only ever happens past the limit: the cases that fit must land on the older
  // build's numbers, bit for bit.
  const Older = await load(older);
  let worst = 0, where = '';
  for (const { c, r } of results.filter(({ c }) => !c.refit)) {
    const o = run(Older, c.patch, c.frames);
    for (const k of ['load', 'h1', 'arc']) {
      const e = Math.abs(o[k] - r[k]) / Math.max(Math.abs(r[k]), 1e-30);
      if (e > worst) { worst = e; where = `${c.tag} ${k}: ${o[k]} vs ${r[k]}`; }
    }
  }
  check('the cases that fit land on the older build\'s numbers', worst === 0, worst === 0 ? 'identical' : `worst ${worst.toExponential(2)} (${where})`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
