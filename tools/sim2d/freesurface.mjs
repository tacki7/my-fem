// What the free-surface condition off the arc carries, column by column, and how much of
// it is the springback ramp laid downstream of the exit plane.
//
//   node tools/sim2d/freesurface.mjs                  both tables below
//   options: --only fast,balanced   --frames 900
//
// Not a check: it prints what docs/validation.md「力の釣り合い」reads and exits 0.
//
// 1. The default stand (balanced mesh) after `--frames`: for every top node off the arc
//    the slope of the surface the mesh was laid on, the velocity there, v·n, and the
//    vertical force −kN (v·n) n_y the penalty puts on the strip - the terms
//    `FlowSolver.constraintForces` sums into `diag.loadFreeSurface`, taken at the same
//    moment (before the mesh is re-laid) - with the stress of the top element under it.
// 2. Per mesh preset, the same stand with the ramp as laid and with the ramp held flat:
//    the springback estimate (`springbackFilt`) is zeroed after every frame's diagnostics,
//    so `updateGap` lays the run-out at the exit gap and nothing else changes. That is a
//    harness override of a private field, not a switch the app has.
import { defaultParams } from './params.mjs';
import { RollingSim, setSlabHook } from './build/sim/solver.js';
import { slabLoad } from './build/sim/muinv.js';

setSlabHook(slabLoad);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const FRAMES = Number(opt('frames', 900));
const { MESH_LEVELS } = await import('./build/app/defaults.js');
const ONLY = opt('only', 'fast,balanced,fine,ultra').split(',');
const MN = 1e6, MPA = 1e6;

function run(level, flatRamp, onReactions) {
  const L = MESH_LEVELS[level];
  const p = defaultParams({ stripNx: L.nx, stripNy: L.ny, rollNt: L.nt, rollNr: L.nr });
  const sim = new RollingSim(p);
  const fl = sim.flow;
  if (onReactions) {
    const forces = fl.constraintForces.bind(fl);
    fl.constraintForces = (inp) => { onReactions(fl, inp); return forces(inp); };
  }
  if (flatRamp) {
    const collect = sim.collectDiagnostics.bind(sim);
    sim.collectDiagnostics = (inp) => { const r = collect(inp); sim.springbackFilt = 0; return r; };
  }
  for (let f = 0; f < FRAMES; f++) sim.advance(1 / 60);
  return sim;
}

// ── 1. column by column ──────────────────────────────────────────────────────
let rows = null, arc = null;
const sim = run('balanced', false, (fl, inp) => {
  const m = fl.mesh, kN = inp.normalPenalty * inp.muRef;
  rows = [];
  arc = [inp.contactFrom, inp.contactTo];
  for (let i = 0; i <= m.nx; i++) {
    if (i >= inp.contactFrom && i <= inp.contactTo) continue;
    const nd = m.topNodes[i];
    const ip = Math.min(m.nx, i + 1), im = Math.max(0, i - 1);
    const dx = m.X[2 * m.topNodes[ip]] - m.X[2 * m.topNodes[im]];
    const sp = Math.abs(dx) > 1e-12 ? (m.X[2 * m.topNodes[ip] + 1] - m.X[2 * m.topNodes[im] + 1]) / dx : 0;
    const len = Math.hypot(sp, 1), nx = -sp / len, ny = 1 / len;
    const vx = fl.v[2 * nd], vy = fl.v[2 * nd + 1];
    const vn = vx * nx + vy * ny;
    const e = 4 * (Math.min(m.nx - 1, Math.max(0, i - 1)) * m.ny + (m.ny - 1));
    rows.push({ i, x: m.X[2 * nd], y: m.X[2 * nd + 1], sp, vx, vy, vn, fy: -kN * vn * ny,
      sxx: fl.elemStress[e], syy: fl.elemStress[e + 1], hyd: fl.elemStress[e + 3] });
  }
});
const d = sim.diag;
const yExit = sim.gapY[arc[1]]; // the exit gap the ramp starts from
console.log(`1. default stand, balanced mesh, frame ${FRAMES}: arc columns ${arc[0]}-${arc[1]}, springback ${(d.springback * 100).toFixed(3)} %`);
console.log(`   P ${(d.loadFem / MN).toFixed(4)}  R ${(d.loadReaction / MN).toFixed(4)}  free surface ${(d.loadFreeSurface / MN).toFixed(4)} MN/m`);
console.log('    i    x[mm]  y/y_exit-1[ppm]    slope     vx[m/s]    vy[m/s]   v·n[m/s]  fy[MN/m]   sum    sxx    syy    hyd [MPa]');
let sum = 0, up = 0;
for (const r of rows) {
  sum += r.fy;
  if (r.i < arc[0]) up += r.fy;
  if (Math.abs(r.fy) < 1e-3 * MN && r.i !== arc[0] - 1) continue;
  console.log(`  ${String(r.i).padStart(3)} ${(r.x * 1e3).toFixed(3).padStart(8)} ${r.i > arc[1] ? ((r.y / yExit - 1) * 1e6).toFixed(0).padStart(10) : '         -'} `
    + `${r.sp.toExponential(2).padStart(10)} ${r.vx.toFixed(5).padStart(10)} ${r.vy.toExponential(2).padStart(10)} ${r.vn.toExponential(1).padStart(9)} `
    + `${(r.fy / MN).toFixed(3).padStart(8)} ${(sum / MN).toFixed(3).padStart(6)} ${(r.sxx / MPA).toFixed(0).padStart(6)} ${(r.syy / MPA).toFixed(0).padStart(6)} ${(r.hyd / MPA).toFixed(0).padStart(6)}`);
}
console.log(`   (columns with |fy| under 1e-3 MN/m left out) upstream of the arc ${(up / MN).toFixed(3)}, downstream ${((sum - up) / MN).toFixed(3)} MN/m\n`);

// ── 2. ramp as laid / ramp held flat, per mesh ──────────────────────────────
console.log(`2. ramp as laid vs held flat, frame ${FRAMES} (loads per unit width, half model)`);
console.log('| メッシュ | 傾斜 | P [MN/m] | R [MN/m] | 自由表面の力 [MN/m] | 自由表面 / R | P / R | 出側板厚 [mm] |');
console.log('|---|---|---|---|---|---|---|---|');
for (const level of ONLY) {
  const L = MESH_LEVELS[level];
  for (const flat of [false, true]) {
    const s = run(level, flat).diag;
    console.log(`| ${L.nx}×${L.ny} | ${flat ? '平ら' : 'あり'} | ${(s.loadFem / MN).toFixed(4)} | ${(s.loadReaction / MN).toFixed(4)} | `
      + `${(s.loadFreeSurface / MN).toFixed(4)} | ${(s.loadFreeSurface / s.loadReaction).toFixed(4)} | ${(s.loadFem / s.loadReaction).toFixed(4)} | ${(s.exitThickness * 1e3).toFixed(4)} |`);
  }
}
