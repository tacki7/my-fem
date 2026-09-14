// The columns re-laid inside the window (`fitColumns`) must not throw the load.
//
//   node tools/sim2d/refit.mjs                      (exit 1 on FAIL; about half a minute)
//   node tools/sim2d/refit.mjs <older build dir>    the same runs on an older build, for comparison
//
// When the bite stretches past ARC_REFIT of the columns it was given, the columns are
// re-laid. The solved fields are stored per node index, so unless they are carried to the
// new stations the next solve starts from a field that belongs somewhere else: rolled up
// from 10 % to 40 % that put 6689 tonf on the frame after, against 1950 before.
//
// One stand, the app's defaults, open loop. The command changes at frame 900; checked:
//   - the re-lay actually happens (a run that never re-lays would pass for nothing)
//   - over the 60 frames after it the load stays within 1.5x of the frame before
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';

const dir = process.argv[2] ?? new URL('./build', import.meta.url).pathname;
const { RollingSim, setSlabHook } = await import(`${dir}/sim/solver.js`);
const { slabLoad } = await import(`${dir}/sim/muinv.js`);
setSlabHook(slabLoad);

const TONF = 9.80665e3, WIDTH = 1.3, CHANGE = 900, AFTER = 60;
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

for (const [tag, from, to, frames] of [['10 % -> 40 %', 0.10, 0.40, 1180], ['40 % -> 10 %', 0.40, 0.10, 1120]]) {
  const sim = new RollingSim(defaultParams({ reduction: from }));
  const events = [];
  let f = 0;
  const layOut = sim.fitColumns;
  sim.fitColumns = function () { events.push(f); return layOut.call(this); };
  const load = [];
  for (f = 1; f <= frames; f++) {
    if (f === CHANGE) { sim.params.reduction = to; sim.releaseGap(); }
    sim.advance(1 / 60);
    load[f] = (sim.diag.rollForce * WIDTH) / TONF;
  }
  const at = events.find((e) => e > CHANGE);
  if (at === undefined || at + AFTER > frames) {
    check(`${tag}: columns re-laid`, false, `re-lays at frames [${events.join(', ')}] (want one after ${CHANGE}, ${AFTER} frames before ${frames})`);
    continue;
  }
  const before = load[at - 1];
  let peak = before, peakAt = at;
  for (let g = at; g <= at + AFTER; g++) if (load[g] > peak) { peak = load[g]; peakAt = g; }
  check(`${tag}: columns re-laid, load held`, peak <= 1.5 * before,
    `re-laid at frame ${at}; load ${before.toFixed(0)} tonf before, peak ${peak.toFixed(0)} at frame ${peakAt} (${(peak / before).toFixed(2)}x)`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
