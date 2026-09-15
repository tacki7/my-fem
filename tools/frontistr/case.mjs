// A FrontISTR case from the roll model's converged pass: the work roll of a 2Hi as a solid
// under the strip load the slab slices found, bearings held, symmetry on x = 0 and z = 0.
//
//   node tools/build-esm.mjs sim3d && node tools/frontistr/case.mjs [outdir] ['{"param":value}']
//
// Writes roll.msh, roll.cnt, hecmw_ctrl.dat and reference.json (the roll model's own answer at
// the same stations) into outdir (default tools/frontistr/run/2hi). Then run.sh solves it and
// compare.mjs reads both.
//
// What is compared and why it is a fair test: the strip load q(x) is prescribed to both
// (the slab slices' converged load, over the same Hertz half-width b(x) the roll model
// flattens with), so the difference between the two is the roll mechanics alone - the
// Timoshenko beam with its neck steps and point supports against a 3D solid, and the line-
// contact flattening formula against the solid's surface indentation. With two bearings the
// beam is statically determinate, so the shape of the deflection does not depend on the
// bearing stiffness: the bearings are simply held (u_y = 0 over a band of the neck) and the
// deflection is read relative to the bearing station.
import { mkdirSync, writeFileSync } from 'node:fs';
import { halfCylinderMesh, meshText } from './mesh.mjs';
const B = new URL('../sim3d/build/', import.meta.url);
const { StackSolver } = await import(new URL('solver.js', B));
const { defaultParams } = await import(new URL('stack.js', B));

const out = process.argv[2] ?? new URL('run/2hi', import.meta.url).pathname;
const patch = JSON.parse(process.argv[3] ?? '{}');
mkdirSync(out, { recursive: true });

// ── the roll model's pass ──
const p = { ...defaultParams('2hi'), stations: 81, stripStations: 0, stripNz: 8, ...patch };
const sv = new StackSolver(p);
let it = 0;
for (let f = 0; f < 400; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
const R = sv.result, st = sv.stack, def = st.rolls[st.wr], roll = sv.rolls[0];
if (!R.converged) throw new Error('the roll model did not converge');
const ns = R.x.length, c = (ns - 1) / 2;
// the half x ≥ 0: stations c … ns−1, then the neck out to the bearing's far edge
const xs = [];
for (let s = c; s < ns; s++) xs.push(R.x[s]);
const half = def.Ls / 2, bw = def.Dn / 2; // bearing band width along x
const xEnd = half + bw / 2 + 0.02;
{ // neck stations: keep the roll grid's spacing past the barrel, land on the bearing band's edges
  const dx = R.x[ns - 1] - R.x[ns - 2];
  const want = [half - bw / 2, half, half + bw / 2, xEnd];
  let x = xs[xs.length - 1];
  while (x + dx < xEnd - 1e-9) { x += dx; xs.push(x); }
  for (const w of want) if (!xs.some((v) => Math.abs(v - w) < 1e-9)) xs.push(w);
  xs.sort((a, b) => a - b);
  // a step in radius at the barrel end: a 5 mm transition cell instead of a coincident pair
  const eb = def.Lb / 2;
  if (!xs.some((v) => Math.abs(v - eb) < 1e-9)) xs.push(eb);
  if (!xs.some((v) => Math.abs(v - (eb + 0.005)) < 1e-9)) xs.push(eb + 0.005);
  xs.sort((a, b) => a - b);
}
const R0 = def.D / 2;
const radiusAt = (x) => (x <= def.Lb / 2 + 1e-9 ? R0 : def.Dn / 2);
const m = halfCylinderMesh({
  xs, radiusAt, R0,
  arcCell: 1.0e-3, arcFine: 0.030, arcGrowth: 1.25, arcMax: 0.040,
  layer0: 1.5e-3, layerGrowth: 1.5,
});
// ── the strip load: the slices' q over the Hertz half-width b the roll model uses ──
const law = sv.wsLaw;
const bAt = (q, arc) => Math.max(Math.sqrt(law.bCoef * Math.max(q, 0)), arc / 2, 1e-6);
const G = (u) => (u * Math.sqrt(Math.max(0, 1 - u * u)) + Math.asin(Math.max(-1, Math.min(1, u)))) / 2;
const loads = []; // [nodeId, Fy, Fz]
let Fsum = 0;
// the roll grid's station at each x (−1 for the neck stations added above)
const stationAt = xs.map((x) => { for (let s = c; s < ns; s++) if (Math.abs(R.x[s] - x) < 1e-9) return s; return -1; });
for (let i = 0; i < xs.length; i++) {
  const s = stationAt[i];
  if (s < 0 || !Number.isFinite(R.q[s]) || R.q[s] <= 0) continue;
  const q = R.q[s], b = bAt(q, R.arc[s]);
  // the station's share of the strip along x: its cell's overlap with the strip (the slice
  // weight the roll model sums the force with), halved at x = 0 where only x ≥ 0 is modelled
  const dx = sv.sliceW[s] * (i === 0 ? 0.5 : 1);
  const p0 = (2 * q) / (Math.PI * b);
  for (let k = 0; k < m.nk; k++) {
    const sk = m.phi[k] * R0;
    const sLo = k === 0 ? 0 : 0.5 * (m.phi[k - 1] + m.phi[k]) * R0;
    const sHi = k + 1 < m.nk ? 0.5 * (m.phi[k] + m.phi[k + 1]) * R0 : sk;
    if (sLo >= b) break;
    const a = Math.min(sHi, b) / b, lo = sLo / b;
    const F = p0 * b * (G(a) - G(lo)) * dx; // the force on this node's patch, into the roll
    if (F <= 0) continue;
    const ph = m.phi[k];
    loads.push([m.id(i, m.nr, k), F * Math.cos(ph), -F * Math.sin(ph)]);
    Fsum += F * Math.cos(ph);
  }
}
// ── groups: symmetry planes and the bearing ──
// The bearing is the beam's: the whole cross-section at x = Ls/2 held in y (a plane section
// pinned, as a beam node is), so the axis deflection is read against the same support the
// beam has. A sleeve over a band of the neck surface would shorten the span and add the
// neck's own crushing under the sleeve to the reading.
const XSYM = [], ZSYM = [], BRG = [], AXIS = [], BOTTOM = [], TOP = [];
const iBrg = xs.findIndex((x) => Math.abs(x - half) < 1e-9);
for (let i = 0; i < xs.length; i++) {
  AXIS.push(m.id(i, 0, 0));
  for (let j = 0; j <= m.nr; j++) {
    for (let k = 0; k < (j === 0 ? 1 : m.nk); k++) {
      const n = m.id(i, j, k);
      if (i === 0) XSYM.push(n);
      if (j === 0 || k === 0 || k === m.nk - 1) ZSYM.push(n);
      if (i === iBrg) BRG.push(n);
    }
  }
  BOTTOM.push(m.id(i, m.nr, 0)); TOP.push(m.id(i, m.nr, m.nk - 1));
}
writeFileSync(`${out}/roll.msh`, meshText(m, { header: 'ROLL FEM LAB 2HI WORK ROLL', E: def.E, nu: def.nu, ngroups: { XSYM, ZSYM, BRG } }));
const cnt = [
  '!VERSION', ' 3',
  '!SOLUTION, TYPE=STATIC',
  '!WRITE, RESULT',
  '!OUTPUT_RES', ' DISP, ON', ' REACTION, ON', ' NSTRESS, OFF', ' NMISES, OFF',
  '!BOUNDARY',
  ' XSYM, 1, 1, 0.0',
  ' ZSYM, 3, 3, 0.0',
  ' BRG, 2, 2, 0.0',
  '!CLOAD',
  ...loads.flatMap(([n, fy, fz]) => [` ${n}, 2, ${fy.toPrecision(9)}`, ` ${n}, 3, ${fz.toPrecision(9)}`]),
  '!SOLVER, METHOD=CG, PRECOND=1, ITERLOG=NO, TIMELOG=YES',
  ' 20000, 1',
  ' 1.0e-8, 1.0, 0.0',
  '!END',
].join('\n') + '\n';
writeFileSync(`${out}/roll.cnt`, cnt);
writeFileSync(`${out}/hecmw_ctrl.dat`, ['!MESH, NAME=fstrMSH, TYPE=HECMW-ENTIRE', ' roll.msh', '!CONTROL, NAME=fstrCNT', ' roll.cnt', '!RESULT, NAME=fstrRES, IO=OUT', ' roll.res'].join('\n') + '\n');
// ── the roll model's answer at the same stations, for compare.mjs ──
const support = ns - 1; // the bearing station, x = Ls/2 (the grid spans the support span)
const ref = {
  mill: p.mill, params: patch, iterations: it, force: R.force, screw: R.screw,
  roll: { D: def.D, Dn: def.Dn, Lb: def.Lb, Ls: def.Ls, E: def.E, nu: def.nu },
  x: xs, station: stationAt,
  v: stationAt.map((s) => (s >= 0 ? roll.v[s] - roll.v[support] : null)),
  vSupport: roll.v[support],
  flat: stationAt.map((s) => (s >= 0 && Number.isFinite(R.flat[s]) ? R.flat[s] : null)),
  q: stationAt.map((s) => (s >= 0 && Number.isFinite(R.q[s]) ? R.q[s] : null)),
  b: stationAt.map((s) => (s >= 0 && Number.isFinite(R.q[s]) && R.q[s] > 0 ? bAt(R.q[s], R.arc[s]) : null)),
  nodes: { axis: AXIS, bottom: BOTTOM, top: TOP, bearing: BRG },
  loadSumY: Fsum, quarterForce: R.force / 4,
  mesh: { nodes: m.nodes.length, hex: m.hex.length, prism: m.prism.length, nk: m.nk, nr: m.nr, ni: m.ni },
};
writeFileSync(`${out}/reference.json`, JSON.stringify(ref));
console.log(`${p.mill}: ${it} iterations, F ${(R.force / 9806.65).toFixed(1)} tonf; mesh ${m.nodes.length} nodes, ${m.hex.length} hex + ${m.prism.length} prism (${m.ni} stations × ${m.nr} layers × ${m.nk - 1} angles); load on the quarter ${(Fsum / 9806.65).toFixed(2)} tonf (F/4 = ${(R.force / 4 / 9806.65).toFixed(2)}); ${loads.length} loaded nodes → ${out}`);
