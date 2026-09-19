// The coupling's roll case without FrontISTR (rollcase.mjs, see tools/frontistr/README.md「連成」):
//
//   node tools/build-esm.mjs sim3d && node tools/frontistr/rollcasecheck.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. The strip load put on the work roll's rings adds up to the model's share, F/4, on the
//    gate's grid and on the app's (301 stations, the strip's own 281) - the rings take the load
//    from whatever grid the solver used.
// 2. The rings are 5 mm apart within 60 mm of the strip edge and 12.5 mm over the rest of it.
// 3. The stacking offset: the solids touch at their crowned centres, the model stacks the nominal
//    radii; the offset is the crowns' radius at x = 0 up the stack to the held roll (the WR's
//    thermal crown alone on the default, 10 µm; with a 300 µm BUR crown 160 µm; a negative WR
//    crown takes off), and the surface read back is the solids' displacement less it - so that a
//    BUR crown does not shift the whole correction by its own size.
//
// @check
// @check-build sim3d
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRollCase, readRollSurface } from './rollcase.mjs';
import { StackSolver } from '../sim3d/build/solver.js';
import { defaultParams, radiusProfile } from '../sim3d/build/stack.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const GATE = { stations: 81, stripStations: 0, stripNz: 8 };
const converge = (p) => { const sv = new StackSolver(p); for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); if (sv.isConverged) break; } return sv; };
const dir = mkdtempSync(join(tmpdir(), 'rollcase-'));
const um = (v) => (v * 1e6).toFixed(2);

// 1. the load, on two grids
for (const [name, grid] of [["the gate's grid", GATE], ["the app's grid", {}]]) {
  const sv = converge({ ...defaultParams('4hi'), ...grid });
  const ref = buildRollCase(sv, radiusProfile, join(dir, name.replace(/\W+/g, '-')), {});
  check(`${name}: the rings carry F/4`, Math.abs(ref.loadSumY / ref.quarterForce - 1) < 1e-3, `${(ref.loadSumY / ref.quarterForce).toFixed(5)} of F/4, ${ref.loadedNodes} loaded nodes, ${ref.nodes} nodes, the solver on ${sv.ns} stations`);
  if (name === "the gate's grid") {
    // 2. the ring spacing
    const x = ref.wr.x, halfW = sv.p.width / 2;
    let edgeMax = 0, bodyMax = 0;
    for (let i = 1; i < x.length; i++) {
      const h = x[i] - x[i - 1], m = 0.5 * (x[i] + x[i - 1]);
      if (Math.abs(m - halfW) < 0.060) edgeMax = Math.max(edgeMax, h);
      else if (m < halfW) bodyMax = Math.max(bodyMax, h);
    }
    check('rings: ≤ 5 mm within 60 mm of the strip edge, ≤ 12.5 mm over the rest of the strip', edgeMax <= 5e-3 + 1e-9 && bodyMax <= 12.5e-3 + 1e-9, `${(edgeMax * 1e3).toFixed(2)} mm, ${(bodyMax * 1e3).toFixed(2)} mm`);
  }
}

// 3. the stacking offset, and the surface read against it
for (const [patch, want] of [[{}, 10e-6], [{ burCrown: 300e-6 }, 160e-6], [{ wrCrown: -100e-6, burCrown: 200e-6 }, 60e-6]]) {
  const sv = converge({ ...defaultParams('4hi'), ...GATE, ...patch });
  const ref = buildRollCase(sv, radiusProfile, join(dir, 'offset'), {});
  check(`stack offset ${JSON.stringify(patch)}: the crowns at x = 0 up to the held roll`, Math.abs(ref.stackOffset - want) < 1e-12, `${um(ref.stackOffset)} µm (want ${um(want)})`);
  // a made-up result: every node up by 0.5 mm; the surface read is that less the offset
  const lab = 'DISPLACEMENT', node = new Map();
  for (const n of ref.wr.bottom) node.set(n, { [lab]: [0, 5e-4, 0] });
  const surf = readRollSurface(ref, { labels: [lab], node });
  check(`the surface read less the offset ${JSON.stringify(patch)}`, surf.v.every((v) => Math.abs(v - (5e-4 - want)) < 1e-12), `${um(surf.v[0])} µm (want ${um(5e-4 - want)})`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
