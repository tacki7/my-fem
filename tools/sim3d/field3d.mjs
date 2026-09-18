// The strip's field in three dimensions (`field3d` of the material FEMs' result, see
// src/sim3d/stripfield.ts), for the material's contour plot:
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/field3d.mjs     (exit 1 on FAIL; part of npm run check)
//
// On the 4Hi default (the gate's grid: 81 stations, the strip on the roll's nodes, 8 rows), for
// the 3D FEM and the plane one:
// 1. It is there (and not on the slab model, which has no field), every value finite.
// 2. The block's faces turn outwards: the volume the triangles enclose (divergence theorem) is
//    the block's, ∫∫ h/2 over the plan, to a part in 10⁴.
// 3. The velocity field carries the FEM's own mass balance: the flow through the exit face over
//    the flow through the entry face is `massRatio` to 0.1 %.
// 4. The strain: integrated along the node lines, it leaves the bite at the homogeneous
//    compression's (2/√3) ln(h₀/h₁) at the centre column to 1 % (the redundant shear of the 3D
//    FEM adds a few tenths of a percent).
// 5. The stresses on the faces carry the tensions: the mean σ_zz over the exit face is the mean
//    front tension to 15 %, over the entry face the back tension to 30 % (the faces' values are
//    extrapolated from the two element rows inside; without that the exit read 10 MPa of 75).
// 6. Pressure is compressive in the bite (the mean p over the nodes > 0).
// And the time to build it on the app's default grid (301 stations, 281 on the strip, 16 rows).
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
function solve(p) {
  const sv = new StackSolver(p);
  for (let f = 0; f < 4000; f++) { sv.advance(1e9, 6); if (sv.isConverged) break; }
  return sv;
}
const mpa = (v) => (v / 1e6).toFixed(1);

for (const model of ['fem3d', 'fem']) {
  const p = { ...defaultParams('4hi'), stations: 81, stripStations: 0, stripNz: 8, stripModel: model };
  const sv = solve(p);
  const R = sv.result, F = R.fem?.field3d;
  report(!!F && F.model === model, `${model}: the field is there`, F ? `${F.nx} × ${F.rows} × ${F.lay} nodes, ${F.tris.length / 3} triangles` : 'none');
  if (!F) continue;
  const { nx, rows, lay, coords: c, tris: t, fields: f } = F;
  const id = (i, j, k) => (i * rows + j) * lay + k;
  let bad = 0;
  for (const k of Object.keys(f)) for (const v of f[k]) if (!Number.isFinite(v)) bad++;
  for (const v of c) if (!Number.isFinite(v)) bad++;
  report(bad === 0, `${model}: every value finite`, `${bad} not`);

  // 2. outward faces
  let vol = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i], b = 3 * t[i + 1], d = 3 * t[i + 2];
    vol += (c[a] * (c[b + 1] * c[d + 2] - c[b + 2] * c[d + 1]) - c[a + 1] * (c[b] * c[d + 2] - c[b + 2] * c[d]) + c[a + 2] * (c[b] * c[d + 1] - c[b + 1] * c[d])) / 6;
  }
  let est = 0;
  for (let i = 0; i < nx - 1; i++) for (let j = 0; j < rows - 1; j++) {
    const top = [id(i, j, lay - 1), id(i + 1, j, lay - 1), id(i + 1, j + 1, lay - 1), id(i, j + 1, lay - 1)];
    const dx = c[3 * id(i + 1, j, 0)] - c[3 * id(i, j, 0)];
    const dz = 0.5 * ((c[3 * id(i, j + 1, 0) + 2] - c[3 * id(i, j, 0) + 2]) + (c[3 * id(i + 1, j + 1, 0) + 2] - c[3 * id(i + 1, j, 0) + 2]));
    est += dx * dz * 0.25 * top.reduce((s, n) => s + c[3 * n + 1], 0);
  }
  report(vol > 0 && Math.abs(vol / est - 1) < 1e-4, `${model}: faces turned out (enclosed volume = the block's)`, `${vol.toExponential(5)} m³ against ${est.toExponential(5)}`);

  // 3. mass balance through the entry and exit faces
  const flux = (j) => {
    let s = 0;
    for (let i = 0; i < nx - 1; i++) for (let k = 0; k < lay - 1; k++) {
      const q = [id(i, j, k), id(i + 1, j, k), id(i + 1, j, k + 1), id(i, j, k + 1)];
      const dx = c[3 * q[1]] - c[3 * q[0]], dy = 0.5 * ((c[3 * q[3] + 1] - c[3 * q[0] + 1]) + (c[3 * q[2] + 1] - c[3 * q[1] + 1]));
      s += dx * dy * 0.25 * q.reduce((a, n) => a + f.vz[n], 0);
    }
    return s;
  };
  const ratio = flux(rows - 1) / flux(0);
  report(Math.abs(ratio - R.fem.massRatio) < 1e-3, `${model}: exit / entry flow through the faces = the FEM's mass ratio`, `${ratio.toFixed(5)} against ${R.fem.massRatio.toFixed(5)}`);

  // 4. the strain at the exit, centre column, through-thickness mean
  const ic = Math.floor(nx / 2);
  let eqExit = 0;
  for (let k = 0; k < lay; k++) eqExit += f.eq[id(ic, rows - 1, k)] / lay;
  const h0 = 2 * c[3 * id(ic, 0, lay - 1) + 1], h1 = 2 * c[3 * id(ic, rows - 1, lay - 1) + 1];
  const homog = (2 / Math.sqrt(3)) * Math.log(h0 / h1);
  report(Math.abs(eqExit / homog - 1) < 0.01, `${model}: exit strain (centre) = (2/√3) ln(h₀/h₁)`, `${eqExit.toFixed(4)} against ${homog.toFixed(4)} (h₀ ${(h0 * 1e3).toFixed(4)} → h₁ ${(h1 * 1e3).toFixed(4)} mm)`);

  // 5. the tensions on the faces
  const faceMean = (j) => { let s = 0; for (let i = 0; i < nx; i++) for (let k = 0; k < lay; k++) s += f.s_zz[id(i, j, k)]; return s / (nx * lay); };
  const fin = (a) => Array.from(a).filter(Number.isFinite);
  const sf = fin(R.sigmaF), sfMean = sf.reduce((a, b) => a + b, 0) / sf.length;
  const sExit = faceMean(rows - 1), sEntry = faceMean(0);
  report(Math.abs(sExit / sfMean - 1) < 0.15, `${model}: σ_zz on the exit face ≈ the front tension`, `${mpa(sExit)} MPa against ${mpa(sfMean)}`);
  report(Math.abs(sEntry / p.backTension - 1) < 0.3, `${model}: σ_zz on the entry face ≈ the back tension`, `${mpa(sEntry)} MPa against ${mpa(p.backTension)}`);

  // 6. pressure in the bite
  let pm = 0;
  for (const v of f.p) pm += v / f.p.length;
  report(pm > 0, `${model}: pressure compressive in the bite`, `mean ${mpa(pm)} MPa`);
}

// 1b. the slab model has no field
{
  const sv = solve({ ...defaultParams('4hi'), stations: 81, stripStations: 0, stripNz: 8, stripModel: 'slab' });
  report(!sv.result.fem?.field3d, 'slab: no field', sv.result.fem ? 'a FEM result' : 'no FEM result');
}

// the time on the app's default grid: one solve of the 3D FEM with and without the field
{
  const { buildStripField } = await import('./build/stripfield.js');
  const sv = solve({ ...defaultParams('4hi'), stripModel: 'fem3d' });
  const F = sv.result.fem?.field3d;
  if (F) {
    const nn = F.nx * F.rows * F.lay, ne = (F.nx - 1) * (F.rows - 1) * (F.lay - 1);
    const nodes = new Int32Array(8 * ne), z = new Float64Array(ne);
    const t0 = performance.now();
    for (let r = 0; r < 5; r++) buildStripField('fem3d', F.nx, F.rows, F.lay, F.coords, F.coords, F.coords, { x: F.fields.vx, y: F.fields.vy, z: F.fields.vz }, { nodes, per: 8, eqRate: z, sm: z, szz: z, flow: z });
    const ms = (performance.now() - t0) / 5;
    console.log(`INFO  building the field on the default grid: ${F.nx} × ${F.rows} × ${F.lay} = ${nn} nodes, ${ne} elements: ${ms.toFixed(1)} ms (the 3D FEM's solve took ${sv.result.solveMs.toFixed(0)} ms/frame)`);
  }
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
