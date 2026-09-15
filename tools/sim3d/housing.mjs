// The housing deformation mode (`housingMode`, see src/sim3d/housing.ts):
//
//   tools/sim3d/build.sh && node tools/sim3d/housing.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. Off is off: a stack with `housingMode: false` solves to the same bits as one
//    that never mentions it (4Hi, and a shifted 6Hi whose lower half is solved).
// 2. The frame against a hand calculation: on a symmetric 4Hi and a 2Hi, each side's
//    window opening is its chock load times (2 c_crosshead + c_posts), with the
//    compliances worked out here from the dimensions, not taken from the module - and
//    twice the distance the solved chock sits off the screw's position (a mirror's half).
// 3. The seat on a shifted 6Hi: converged, every seat force a compression, at least
//    one seat carrying load, the upper intermediate roll tilting less than with the
//    seat off, and the solved lower half still the upper one turned over
//    (|v_upper(x) − v_lower(−x)| as small as with the mode off).
// 4. Out of scope: a 12Hi and a 20Hi with the mode on warn `housingScope` and solve
//    to the same bits as with it off.
// 5. The strip clearance: each side's posts stand on the screw roll's chock, so the
//    span between their inner faces is the chock span less a post width. On a 4Hi and
//    a 2Hi, a post just too narrow to reach the strip edge leaves no warning, one just
//    wide enough warns `housingStrip`, and the warning is all it does (same bits).
//
// @check
// @check-build sim3d
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
/** a mill's defaults at 81 stations, the strip on the same even grid with 8 rows: what these checks hold does not depend on the grid, and the defaults' 301 stations with 281 strip cells × 16 rows take a hundred times as long */
const defaults81 = (mill) => ({ ...defaultParams(mill), stations: 81, stripStations: 0, stripNz: 8 });
function solve(p) {
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  return { sv, R: sv.result, it };
}
const sameBits = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const um = (v) => (v * 1e6).toFixed(1);
const TONF = 9.80665e3;

// ── 1. off is off ────────────────────────────────────────────────────────────
for (const [label, mill, patch] of [['4Hi', '4hi', {}], ['6Hi shifted −50 mm', '6hi', { irShift: -0.05 }]]) {
  const base = { ...defaults81(mill), ...patch };
  delete base.housingMode;
  const a = solve(base), b = solve({ ...base, housingMode: false });
  report(sameBits(a.sv.u, b.sv.u) && a.R.housing === null && b.R.housing === null,
    `${label}: housingMode false = not given`, `${a.sv.u.length} unknowns bit-identical, housing ${a.R.housing} / ${b.R.housing}`);
}

// ── 2. the frame against a hand calculation ─────────────────────────────────
for (const mill of ['4hi', '2hi']) {
  const p = { ...defaults81(mill), housingMode: true };
  const { R, sv } = solve(p);
  const E = p.housingE, G = E / 2.6;
  const cPost = p.housingPostLength / (p.housingPostCount * E * p.housingPostArea);
  const S = p.housingCrossSpan;
  const cCross = S ** 3 / (48 * E * p.housingCrossI) + S / (4 * G * p.housingCrossShearArea);
  const r = sv.stack.screwRolls[0], screwRoll = sv.rolls[r];
  let worst = 0;
  const sides = R.housing.sides.map((sd, k) => {
    const F = screwRoll.reactions[k];
    const hand = (2 * cCross + cPost) * F;
    // what the solve itself did: the chock moved off the screw's position by half the opening
    const moved = screwRoll.v[screwRoll.supports[k]] + sv.screw;
    worst = Math.max(worst, Math.abs(sd.stretch - hand) / hand, Math.abs(2 * moved - hand) / hand);
    return `${k ? 'drive' : 'operator'} ${(F / TONF).toFixed(1)} tonf → ${um(sd.stretch)} µm (hand ${um(hand)}, chock moved ${um(moved)} µm × 2)`;
  });
  report(R.converged && worst < 1e-9, `${mill}: window opening = chock load × (2 c_crosshead + c_posts) = twice the chock's travel`,
    `${sides.join(', ')}; worst ${worst.toExponential(1)}; c_posts ${cPost.toExponential(3)}, c_crosshead ${cCross.toExponential(3)} m/N, mill modulus ${(R.housing.millModulus / 1e9).toFixed(2)} GN/m`);
}

// ── 3. the seat on a shifted 6Hi ───────────────────────────────────────────
{
  const tilt = (sv, r) => sv.rolls[r].v[sv.rolls[r].supports[1]] - sv.rolls[r].v[sv.rolls[r].supports[0]];
  const pointSym = (sv) => {
    const nU = sv.upper, ns = sv.x.length;
    let d = 0;
    for (let r = 0; r < nU; r++) {
      for (let s = 0; s < ns; s++) {
        const a = sv.rolls[r].v[s], b = sv.rolls[nU + r].v[ns - 1 - s];
        if (Number.isFinite(a) && Number.isFinite(b)) d = Math.max(d, Math.abs(a - b));
      }
    }
    return d;
  };
  const base = { ...defaults81('6hi'), irShift: 0 };
  const off = solve(base);
  const seatOff = solve({ ...base, housingMode: true, irSeat: false });
  const on = solve({ ...base, housingMode: true });
  const seats = on.R.housing.seatForces;
  report(on.R.converged && seats.every((f) => f >= 0) && seats.some((f) => f > 0),
    '6Hi shift 0, seat on: converged, seats in compression only', `seat forces ${seats.map((f) => (f / TONF).toFixed(1)).join(' / ')} tonf, ${on.it} iterations (off ${off.it})`);
  report(tilt(on.sv, 1) < tilt(seatOff.sv, 1) && tilt(on.sv, 1) < tilt(off.sv, 1),
    '6Hi shift 0: the seat lowers the intermediate roll\'s tilt', `IR ${um(tilt(off.sv, 1))} (off) / ${um(tilt(seatOff.sv, 1))} (frame only) / ${um(tilt(on.sv, 1))} µm (frame and seat)`);
  const dOff = pointSym(off.sv), dOn = pointSym(on.sv);
  report(dOn <= Math.max(10 * dOff, 1e-9), '6Hi shift 0: the lower half stays the upper one turned over', `|v_upper(x) − v_lower(−x)| ${um(dOn)} µm (mode off ${um(dOff)} µm)`);
}

// ── 4. out of scope ─────────────────────────────────────────────────────────
for (const mill of ['12hi', '20hi']) {
  const p = defaults81(mill);
  const off = solve(p), on = solve({ ...p, housingMode: true });
  report(on.R.warnings.includes('housingScope') && sameBits(off.sv.u, on.sv.u) && on.R.housing === null,
    `${mill}: the mode warns and leaves the solve alone`, `warnings [${on.R.warnings.join(',')}], unknowns bit-identical ${sameBits(off.sv.u, on.sv.u)}`);
}

// ── 5. the strip clearance ───────────────────────────────────────────────────
for (const [mill, Ls] of [['4hi', 'burLs'], ['2hi', 'wrLs']]) {
  const p = { ...defaults81(mill), housingMode: true };
  // the post width at which the inner faces reach the strip edges
  const reach = p[Ls] - p.width;
  const clear = solve({ ...p, housingPostWidth: reach - 0.01 }), hit = solve({ ...p, housingPostWidth: reach + 0.01 });
  const dflt = solve(p);
  report(!clear.R.warnings.includes('housingStrip') && hit.R.warnings.includes('housingStrip') && !dflt.R.warnings.includes('housingStrip')
    && sameBits(clear.sv.u, hit.sv.u) && sameBits(dflt.sv.u, hit.sv.u),
    `${mill}: a strip wider than the posts' clear span warns, and only warns`,
    `clear span ${((p[Ls] - p.housingPostWidth) * 1e3).toFixed(0)} mm at the default ${p.housingPostWidth} m posts; posts ${(reach - 0.01).toFixed(2)} m [${clear.R.warnings.join(',')}] / ${(reach + 0.01).toFixed(2)} m [${hit.R.warnings.join(',')}], unknowns bit-identical ${sameBits(clear.sv.u, hit.sv.u) && sameBits(dflt.sv.u, hit.sv.u)}`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
