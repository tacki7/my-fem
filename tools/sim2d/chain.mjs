// What a stand hands down the line when it is not rolling normally: parked
// (target at or above its entry gauge), restarted after a NaN, or rebuilt.
//
//   node tools/sim2d/chain.mjs      (exit 1 on FAIL; about 60 s)
//
// The chain reads each stand's diagnostics from the previous frame, so a value
// needs one frame per stand to travel: stand #3's entry after frame f is what
// stand #1 delivered after frame f-2, whether #2 rolled or passed it through.
// The pass-through checks compare exactly that, bit for bit.
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';
import { Mill } from './build/sim/mill.js';

const DT = 1 / 60;
const MPA = 1e6;

/** The per-stand setups the app seeds (src/main.ts `standSetups`), with overrides. */
function setupsFor(p, n, patch = []) {
  return Array.from({ length: n }, (_, k) => ({
    R: p.R, mu: p.mu, reduction: p.reduction, targetForce: p.agcTargetForce,
    targetGauge: p.h0 * Math.pow(1 - p.reduction, k + 1),
    backTension: p.backTension, frontTension: 0, agcMode: p.agcMode,
    ...patch[k],
  }));
}

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ── 1. #2 parked from the start ────────────────────────────────────────────
{
  const FRAMES = 300;
  const p = defaultParams();
  const setups = setupsFor(p, 3, [{}, { agcMode: 'gauge', targetGauge: 1.25 * p.h0 }]);
  const mill = new Mill(p, setups);
  const [s1, s2, s3] = mill.stands;
  const up = { strain: [], temp: [], kf: [], speed: [] };
  let idle = 0, worked = 0;
  const bad = { strain: 0, temp: 0, kf: 0, speed: 0 };
  let first = '';
  for (let f = 0; f < FRAMES; f++) {
    mill.sync(p, setups);
    mill.advance(DT);
    const d1 = s1.diag;
    up.strain.push(d1.exitStrain); up.temp.push(d1.exitTemp);
    up.kf.push(d1.exitFlowStress); up.speed.push(d1.exitSpeed);
    if (s2.gaugeIdle) idle++;
    if (f < 2) continue;
    if (up.strain[f - 2] > 0) worked++;
    const miss = (key, got, want) => {
      if (got === want) return;
      bad[key]++;
      if (!first) first = `first at frame ${f}: ${key} ${got} vs ${want}`;
    };
    miss('strain', s3.entryStrain, up.strain[f - 2]);
    miss('temp', s3.entryTemp, up.temp[f - 2]);
    miss('kf', s2.diag.exitFlowStress, up.kf[f - 1]);
    miss('speed', s2.diag.exitSpeed, up.speed[f - 1]);
  }
  // The harness first: the stand really was parked, and #1 really was working.
  report(idle === FRAMES && worked === FRAMES - 2, '(harness) #2 parked every frame, #1 strains the strip',
    `parked ${idle}/${FRAMES}, #1 exit strain > 0 on ${worked}/${FRAMES - 2}`);
  report(bad.strain === 0, 'parked #2 passes strain: #3 entry = #1 exit two frames back',
    `mismatches ${bad.strain}/${FRAMES - 2}, #3 entry ${s3.entryStrain.toFixed(5)} vs #1 exit ${up.strain[FRAMES - 3].toFixed(5)}`);
  report(bad.temp === 0, 'parked #2 passes temperature',
    `mismatches ${bad.temp}/${FRAMES - 2}, #3 entry ${s3.entryTemp.toFixed(2)} vs #1 exit ${up.temp[FRAMES - 3].toFixed(2)} °C`);
  report(bad.kf === 0, 'parked #2 exit flow stress = #1 exit flow stress one frame back',
    `mismatches ${bad.kf}/${FRAMES - 2}, ${(s2.diag.exitFlowStress / MPA).toFixed(1)} vs ${(up.kf[FRAMES - 2] / MPA).toFixed(1)} MPa`);
  report(bad.speed === 0, 'parked #2 exit speed = #1 exit speed one frame back (not ωR)',
    `mismatches ${bad.speed}/${FRAMES - 2}, ${s2.diag.exitSpeed.toFixed(5)} vs ${up.speed[FRAMES - 2].toFixed(5)} m/s ` + (first ? `(${first})` : ''));
}

// ── 2./3. #2 restarted, then rebuilt for a new roll, in a tension-controlled line
//
// Both events are applied to a line that has settled: both gaps armed and the
// tensions on target for SETTLE_RUN frames in a row. Read off the line, not
// counted in frames. The first version of this check fired at frame 600, and
// under 'dist' and control the #2→#3 gap is not armed until about frame 810:
// "the gaps go back to unsettled" then passed for a gap that had never been
// settled, and the trims had nothing to be disturbed from. After each event
// the line has to settle again the same way before the next one.
{
  const SETTLE_RUN = 60, CAP = 3600;
  const p = defaultParams({ tensionModel: 'dist', tensionControl: true });
  const setups = setupsFor(p, 3, [{ frontTension: 30 * MPA }, { frontTension: 25 * MPA }, {}]);
  const mill = new Mill(p, setups);
  const vLimit = p.tensionVLimit;
  const step = () => { mill.sync(p, setups); mill.advance(DT); };
  const settled = () => mill.gapStates.length === 2 && mill.gapStates.every((g) => g.warmed) && mill.diag.tensionSettled;
  /** frames until the line has been settled SETTLE_RUN frames in a row, or -1 past CAP */
  const settle = (watch) => {
    let run = 0;
    for (let f = 0; f < CAP; f++) {
      if (settled()) { if (++run >= SETTLE_RUN) return f; } else run = 0;
      step();
      watch?.();
    }
    return -1;
  };

  const first = settle();
  report(first >= 0, '(harness) the line settles before anything is done to it',
    `both gaps armed and on target after ${first} frames`);

  for (const how of ['restart after NaN', 'rebuildStand']) {
    const old = mill.stands[1];
    const restartsBefore = old.restarts;
    const entryBefore = mill.stands[2].entryStrain;
    // what the app does for a roll radius typed into the table: 190 -> 200 mm, one stand rebuilt
    if (how === 'rebuildStand') { setups[1].R = 0.2; mill.rebuildStand(1, p, setups); }
    else old.flow.v.fill(NaN);
    step();
    const happened = how === 'rebuildStand' ? mill.stands[1] !== old : old.restarts === restartsBefore + 1;
    const warmedAfter = mill.gapStates.map((g) => g.warmed);
    let frames = 0, trimPeak = 0, trimAtLimit = 0, zeroEntry = 0, minEntry = Infinity;
    const watch = () => {
      frames++;
      for (const g of mill.gapStates) {
        trimPeak = Math.max(trimPeak, Math.abs(g.trim));
        if (Math.abs(g.trim) >= vLimit) trimAtLimit++;
      }
      const e = mill.stands[2].entryStrain;
      minEntry = Math.min(minEntry, e);
      if (!(e > 0)) zeroEntry++;
    };
    watch();
    const again = settle(watch);
    report(happened, `(harness) ${how}: it really happened to #2`,
      how === 'rebuildStand' ? `new solver ${mill.stands[1] !== old}` : `restarts ${restartsBefore} -> ${old.restarts}`);
    report(warmedAfter.length === 2 && warmedAfter.every((w) => !w), `${how}: both gaps of #2 go back to unsettled`,
      `armed right after [${warmedAfter}]`);
    report(again >= 0, `${how}: the line settles again`, again >= 0 ? `after ${again} frames` : `not within ${CAP} frames`);
    report(trimAtLimit === 0, `${how}: no trim pinned at its limit`,
      `peak |trim| ${trimPeak.toFixed(4)} (limit ${vLimit}), frames×gaps at the limit ${trimAtLimit}`);
    report(zeroEntry === 0, `${how}: #3 entry strain never drops to 0`,
      `frames at 0 ${zeroEntry}/${frames}, min ${minEntry.toFixed(5)} (before ${entryBefore.toFixed(5)})`);
  }
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
