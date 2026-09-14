// Where one frame of the 2D solve spends its time, per mesh preset - and, given an
// older build, whether a change moved the answer.
//
//   node tools/sim2d/bench.mjs                        timings of this build
//   node tools/sim2d/bench.mjs <older build dir>      the same for both, and the
//                                                     load / exit gauge / reactions
//                                                     after the run against each other
//   options: --only fast,balanced   --frames 900   --warm 300   --rounds 2
//
// Not a check: the timings are the machine's, so this prints a table and exits 0.
// Run it on an otherwise idle machine; two jobs sharing the CPU move every column.
//
// One stand, the app's defaults with the preset's mesh, controls off. The first
// `--warm` frames are not timed (JIT, and the start-up transient where the PCG
// works harder), the rest are averaged. The comparison is taken at the last frame.
// Each build runs `--rounds` times, alternating with the other, and the round with the
// shortest step is kept: whichever build ran second came out 6-8 % faster on a single
// round with two identical builds, which is the size of the effects being measured.
//
// Columns [ms per frame]:
//   assemble  viscosity update + element loop + interface terms (FlowSolver.lastAssembleMs)
//   factor    banded LDLᵀ of the strip matrix               (lastFactorMs)
//   pcg       the preconditioned CG solve                   (lastSolveMs)
//   flow+     the rest of the flow step: RHS lift, relaxation, stress recovery
//   strain    strain / temperature transport                (RollingSim.lastStrainMs)
//   roll      roll elastic solve, AGC, gap update           (lastRollMs)
//   step      the whole RollingSim.advance                  (lastStepMs)
//   factors/frame  band factorisations per frame (FlowSolver.factorCount; 1 on a build without it)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultParams } from './params.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const FRAMES = Number(opt('frames', 900));
const WARM = Number(opt('warm', 300));
const only = opt('only', null);
const ROUNDS = Number(opt('rounds', 2));
const older = args[0];

// The presets live in src/main.ts, which cannot be loaded in node; slice the literal out
// the way params.mjs does, so a changed preset is measured as it is.
const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const src = readFileSync(MAIN, 'utf8');
const start = src.indexOf('const MESH_LEVELS = {');
if (start < 0) throw new Error('src/main.ts: `const MESH_LEVELS = {` not found');
const LEVELS = new Function(`return (${src.slice(src.indexOf('{', start), src.indexOf('} as const;', start) + 1)});`)();

const load = async (dir) => {
  const solver = await import(`${dir}/sim/solver.js`);
  const muinv = await import(`${dir}/sim/muinv.js`);
  solver.setSlabHook(muinv.slabLoad);
  return solver.RollingSim;
};
const builds = [['this', await load(fileURLToPath(new URL('./build', import.meta.url)))]];
if (older) builds.unshift(['older', await load(older)]);

const TONF = 9.80665e3, WIDTH = 1.3;
function run(Sim, level) {
  const L = LEVELS[level];
  const p = defaultParams({ stripNx: L.nx, stripNy: L.ny, rollNt: L.nt, rollNr: L.nr });
  const sim = new Sim(p);
  const acc = { assemble: 0, factor: 0, pcg: 0, flow: 0, strain: 0, roll: 0, step: 0, cg: 0, cgMax: 0, factors: 0 };
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    const before = sim.flow.factorCount;
    sim.advance(1 / 60);
    if (f < WARM) continue;
    const fl = sim.flow;
    // an older build has no counter: it factors on every solve
    acc.factors += before === undefined ? Math.max(1, p.picardIters | 0) : fl.factorCount - before;
    acc.assemble += fl.lastAssembleMs;
    acc.factor += fl.lastFactorMs;
    acc.pcg += fl.lastSolveMs;
    acc.flow += sim.lastFlowMs - fl.lastAssembleMs - fl.lastFactorMs - fl.lastSolveMs;
    acc.strain += sim.lastStrainMs;
    acc.roll += sim.lastRollMs;
    acc.step += sim.lastStepMs;
    acc.cg += sim.diag.cgIterations;
    acc.cgMax = Math.max(acc.cgMax, sim.diag.cgIterations);
  }
  const n = FRAMES - WARM;
  for (const k of ['assemble', 'factor', 'pcg', 'flow', 'strain', 'roll', 'step', 'cg', 'factors']) acc[k] /= n;
  const d = sim.diag;
  return {
    ...acc, wall: performance.now() - t0,
    dof: 2 * (L.nx + 1) * (L.ny + 1),
    P: d.rollForce, h1: d.exitThickness, reaction: d.loadReaction, balanceX: d.balanceX,
  };
}

const f = (v, w = 7, dg = 2) => v.toFixed(dg).padStart(w);
console.log(`${FRAMES} frames, ${WARM} warm-up, 1 stand, controls off; ms per frame over the last ${FRAMES - WARM}\n`);
console.log('mesh      build  strip dof  assemble  factor     pcg   flow+  strain    roll    step   cg/frame (max)  factors/frame   load tonf');
for (const level of Object.keys(LEVELS)) {
  if (only && !only.split(',').includes(level)) continue;
  const res = {};
  for (let round = 0; round < ROUNDS; round++) {
    for (const [tag, Sim] of builds) {
      const r = run(Sim, level);
      if (!res[tag] || r.step < res[tag].step) res[tag] = r;
    }
  }
  for (const [tag] of builds) {
    const r = res[tag];
    console.log(`${level.padEnd(9)} ${tag.padEnd(6)} ${String(r.dof).padStart(9)} ${f(r.assemble, 9)} ${f(r.factor)} ${f(r.pcg)} ${f(r.flow)} ${f(r.strain)} ${f(r.roll)} ${f(r.step)}`
      + `   ${f(r.cg, 6, 1)} (${String(r.cgMax).padStart(3)})  ${f(r.factors, 13, 3)}   ${f((r.P * WIDTH) / TONF, 9, 3)}`);
  }
  if (res.older) {
    const a = res.older, b = res.this;
    const rel = (x, y) => Math.abs(y - x) / Math.max(Math.abs(x), 1e-300);
    console.log(`${''.padEnd(16)}after ${FRAMES} frames: |ΔP|/P ${rel(a.P, b.P).toExponential(2)}  |Δh1|/h1 ${rel(a.h1, b.h1).toExponential(2)}`
      + `  |Δreaction|/reaction ${rel(a.reaction, b.reaction).toExponential(2)}  balanceX ${a.balanceX.toExponential(2)} -> ${b.balanceX.toExponential(2)}`
      + `  step ×${(a.step / b.step).toFixed(2)}`);
  }
}
