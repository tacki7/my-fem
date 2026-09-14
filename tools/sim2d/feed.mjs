// When is a stand's feed "not established" - no free-running speed, the entry face
// pushing the strip in - while its load and exit gauge sit still anyway?
//
//   node tools/sim2d/feed.mjs      (exit 1 on FAIL; 55-90 s depending on load)
//
// `diag.feedNotEstablished` is a readout: the residual's floor above 30x the feed
// deadband and no longer coming down (under 5 % over the last 300 solves). One stand
// with the screws parked, and a tension-controlled line whose downstream feeds are
// prescribed:
//
//   2 mm default 25 %, 8 mm at 25 / 35 / 38 %,     the strip feeds itself
//   0.63 mm at 25 / 90 %, 0.05 mm at 50 % (R 30 mm)  (8 mm 38 %, 0.63 mm 90 % and the
//                                                     foil start up slowly: the floor
//                                                     is above 30x for hundreds of solves)
//   8 mm at 40 / 45 / 65 %                          no feed exists (40 % exits above the
//                                                     bite continuation limit all the same)
//   3 stands, 'dist' + control                      #2 and #3 are fed at the upstream exit speed
//
// Checked: the flag's verdict per case over a run that outlasts the start-up, that once
// raised it stays raised, and that it never rises on a stand whose feed is prescribed.
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';
import { RollingSim } from './build/sim/solver.js';
import { Mill } from './build/sim/mill.js';

const DT = 1 / 60;
const WINDOW = 300;
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

const CASES = [
  { tag: '2 mm default 25 %', patch: {}, frames: 900, flag: false },
  { tag: '8 mm 25 %', patch: { h0: 0.008, reduction: 0.25 }, frames: 900, flag: false },
  { tag: '8 mm 35 %', patch: { h0: 0.008, reduction: 0.35 }, frames: 900, flag: false },
  { tag: '8 mm 38 %', patch: { h0: 0.008, reduction: 0.38 }, frames: 1800, flag: false },
  { tag: '0.63 mm 25 %', patch: { h0: 0.00063, reduction: 0.25 }, frames: 900, flag: false },
  { tag: '0.63 mm 90 %', patch: { h0: 0.00063, reduction: 0.9 }, frames: 1800, flag: false },
  { tag: '0.05 mm 50 %, R 30 mm', patch: { h0: 0.00005, reduction: 0.5, R: 0.03 }, frames: 1200, flag: false },
  { tag: '8 mm 40 %', patch: { h0: 0.008, reduction: 0.4 }, frames: 3000, flag: true },
  { tag: '8 mm 45 %', patch: { h0: 0.008, reduction: 0.45 }, frames: 1800, flag: true },
  { tag: '8 mm 65 %', patch: { h0: 0.008, reduction: 0.65 }, frames: 1200, flag: true },
];

for (const c of CASES) {
  const p = defaultParams(c.patch);
  const sim = new RollingSim(p);
  let first = -1, dropped = 0, above = 0, mark = 0, leastFall = Infinity;
  for (let f = 0; f < c.frames; f++) {
    sim.advance(DT);
    const d = sim.diag;
    if (d.feedNotEstablished && first < 0) first = f;
    if (first >= 0 && !d.feedNotEstablished) dropped++;
    const high = d.feedFloor > 30 * p.feedDeadband;
    if (high) above++;
    // how far the floor fell over each window that ended above 30x: the margin to 5 %
    if ((f + 1) % WINDOW === 0) {
      if (mark > 0 && high) leastFall = Math.min(leastFall, 1 - d.feedFloor / mark);
      mark = d.feedFloor;
    }
  }
  const d = sim.diag;
  const ok = c.flag ? first >= 0 && dropped === 0 : first < 0;
  check(`${c.tag}: ${c.flag ? 'not established' : 'established'}`, ok,
    `${first >= 0 ? `raised at solve ${first + 1}, dropped ${dropped} times` : 'never raised'}; `
    + `floor above 30x on ${above}/${c.frames} solves, least fall over a ${WINDOW}-solve window ending there `
    + `${Number.isFinite(leastFall) ? `${(leastFall * 100).toFixed(1)} %` : '-'}; `
    + `at the end residual ${(d.feedResidual / p.feedDeadband).toFixed(1)}x, floor ${(d.feedFloor / p.feedDeadband).toFixed(1)}x the deadband, `
    + `vIn/omega R ${(d.entrySpeed / (p.omega * p.R)).toFixed(3)}, `
    + `h1 ${(d.exitThickness * 1e3).toFixed(3)} mm against the continuation limit ${(d.biteLimitH1Cont * 1e3).toFixed(2)} mm`);
}

// Prescribed feeds: the tension model feeds #2 and #3 at the upstream exit speed, and
// their residual is not updated - a stale value must not raise the flag.
{
  const p = defaultParams({ tensionModel: 'dist', tensionControl: true });
  const setups = Array.from({ length: 3 }, (_, k) => ({
    R: p.R, mu: p.mu, reduction: p.reduction, targetForce: p.agcTargetForce,
    targetGauge: p.h0 * Math.pow(1 - p.reduction, k + 1),
    backTension: p.backTension, frontTension: [30e6, 25e6, 0][k], agcMode: p.agcMode,
  }));
  const mill = new Mill(p, setups);
  let raised = 0, prescribed = 0;
  for (let f = 0; f < 900; f++) {
    mill.sync(p, setups);
    mill.advance(DT);
    for (const st of mill.stands) {
      if (st.diag.feedNotEstablished) raised++;
      if (st.params.feedSpeed > 0) prescribed++;
    }
  }
  check('3 stands, dist + control: never raised, #2 and #3 fed at a prescribed speed', raised === 0 && prescribed > 0,
    `raised ${raised} stand-solves, prescribed feed on ${prescribed} stand-solves`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
