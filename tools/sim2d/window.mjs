// The analysis window against the bite it has to hold: when does `windowShortfall` flag?
//
//   node tools/sim2d/window.mjs                      (exit 1 on FAIL; a few minutes)
//   node tools/sim2d/window.mjs <older build dir>    also: the same runs on an older build
//                                                    move nothing (the flag only reports)
//
// The window is sized at rebuild from the commanded draft, and the mesh entry is held at
// 0.8 of it. A load loop can roll far more than it was commanded; then the barrel meets
// the strip upstream of that limit. One stand, the app's defaults, with:
//
//   open loop 25 %                              the default operating point
//   load = P(25 %), commanded 5 %               rolls ~21 %: the bite is 2x nominal, fits
//   load = P(40 %), commanded 25 %              rolls ~34 %: fits
//   load = P(40 %), commanded 5 %               rolls 35 % and more: past the limit
//   load = P(40 %), commanded 2 %               window sized for 2 %: past the limit
//   gauge 1.0 mm, commanded 5 %                 the gauge loop runs into the same wall
//
// P(r) is the open-loop load at commanded r, measured here first. Checked:
//   - the flag's verdict per case, at the end of the run
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
  for (let f = 0; f < frames; f++) {
    sim.advance(DT);
    const d = sim.diag;
    const s = d.windowShortfall ?? 0;
    const atLimit = sim.entryCross === 0.8 * sim.winIn;
    if (s > 0) flagged++;
    if ((s > 0) !== atLimit || s < 0) disagree++;
    worst = Math.max(worst, s);
  }
  const d = sim.diag;
  return {
    sim, p, flagged, disagree, worst,
    shortfall: d.windowShortfall ?? 0,
    load: (d.rollForce * WIDTH) / TONF,
    reduction: 1 - d.exitThickness / p.h0,
    h1: d.exitThickness,
    arc: -sim.entryCross,
    reach: -0.8 * sim.winIn,
    settled: d.agcSettled,
  };
}

const P25 = run(RollingSim, {}, 900).sim.diag.rollForce;
const P40 = run(RollingSim, { reduction: 0.40 }, 900).sim.diag.rollForce;
const CASES = [
  { tag: 'open loop 25 %', patch: {}, frames: 900, flag: false },
  { tag: 'load P(25 %), cmd 5 %', patch: { agcMode: 'force', agcTargetForce: P25, reduction: 0.05 }, frames: 1800, flag: false },
  { tag: 'load P(40 %), cmd 25 %', patch: { agcMode: 'force', agcTargetForce: P40, reduction: 0.25 }, frames: 1800, flag: false },
  { tag: 'load P(40 %), cmd 5 %', patch: { agcMode: 'force', agcTargetForce: P40, reduction: 0.05 }, frames: 1800, flag: true },
  { tag: 'load P(40 %), cmd 2 %', patch: { agcMode: 'force', agcTargetForce: P40, reduction: 0.02 }, frames: 1800, flag: true },
  { tag: 'gauge 1.0 mm, cmd 5 %', patch: { agcMode: 'gauge', agcTargetGauge: 0.001, reduction: 0.05 }, frames: 1800, flag: true },
];
console.log(`P(25 %) ${((P25 * WIDTH) / TONF).toFixed(0)} tonf, P(40 %) ${((P40 * WIDTH) / TONF).toFixed(0)} tonf (open loop, ${900} frames)\n`);
console.log('case                      frames  load[tonf]  rolled   arc[mm]  limit[mm]  shortfall[mm]  flagged frames  settled');
const results = [];
for (const c of CASES) {
  const r = run(RollingSim, c.patch, c.frames);
  results.push({ c, r });
  console.log(`${c.tag.padEnd(26)}${String(c.frames).padStart(6)}  ${r.load.toFixed(0).padStart(10)}  ${(100 * r.reduction).toFixed(1).padStart(5)} %`
    + `  ${(r.arc * 1e3).toFixed(2).padStart(8)}  ${(r.reach * 1e3).toFixed(2).padStart(9)}  ${(r.shortfall * 1e3).toFixed(2).padStart(13)}`
    + `  ${String(r.flagged).padStart(14)}  ${r.settled}`);
}
console.log('');
for (const { c, r } of results) {
  check(`${c.tag}: ${c.flag ? 'flagged' : 'not flagged'}`, (r.shortfall > 0) === c.flag,
    `shortfall ${(r.shortfall * 1e3).toFixed(3)} mm at the end, ${r.flagged}/${c.frames} frames flagged`);
}
const disagree = results.reduce((s, { r }) => s + r.disagree, 0);
check('flag ⇔ entry held at the window limit, every frame', disagree === 0, `${disagree} frames disagree`);

if (older) {
  // The flag reads the barrel and writes only the diagnostic: the same runs on a build
  // without it must land on the same numbers, bit for bit.
  const Older = await load(older);
  let worst = 0, where = '';
  for (const { c, r } of results) {
    const o = run(Older, c.patch, c.frames);
    for (const k of ['load', 'h1', 'arc']) {
      const e = Math.abs(o[k] - r[k]) / Math.max(Math.abs(r[k]), 1e-30);
      if (e > worst) { worst = e; where = `${c.tag} ${k}: ${o[k]} vs ${r[k]}`; }
    }
  }
  check('the same runs on the older build land on the same numbers', worst === 0, worst === 0 ? 'identical' : `worst ${worst.toExponential(2)} (${where})`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
