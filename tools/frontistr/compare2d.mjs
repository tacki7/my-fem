// The 2D tab's pass against FrontISTR's elastic-plastic rolling (strip2d.mjs):
//   node tools/build-esm.mjs sim2d && node tools/frontistr/compare2d.mjs [dir] [--json out.json]
// Reads reference.json and the last two roll.res.0.N, and prints what the pass came to in
// FrontISTR - rolling force and torque per width, the pressure and friction along the arc,
// the neutral point, the forward slip, the exit thickness - beside the app's strip FEM and
// its slab theories at the same entry and exit thickness (the app is run at the exit
// thickness FrontISTR produced, so both roll the same pass).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseRes, TONF } from './lib.mjs';
import { defaultParams } from '../sim2d/params.mjs';
import { RollingSim, setSlabHook } from '../sim2d/build/sim/solver.js';
import { slabLoad } from '../sim2d/build/sim/muinv.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) ?? new URL('run/strip2d', import.meta.url).pathname;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const ref = JSON.parse(readFileSync(`${dir}/reference.json`, 'utf8'));
const P = ref.params, tz = ref.tz, R = P.R, yc = ref.yc;

// ── FrontISTR's answer ──
const files = readdirSync(dir).filter((f) => /^roll\.res\.0\.\d+$/.test(f)).map((f) => Number(f.split('.').pop())).sort((a, b) => a - b);
if (files.length < 2) throw new Error(`${dir}: fewer than two result files`);
const stepOf = files[files.length - 1], prevOf = files[files.length - 2];
const res = parseRes(readFileSync(`${dir}/roll.res.0.${stepOf}`, 'utf8'));
const prev = parseRes(readFileSync(`${dir}/roll.res.0.${prevOf}`, 'utf8'));
/** the roll's angle after `n` substeps of the schedule */
const thetaAt = (n) => { let t = 0; for (const s of ref.steps) { if (n <= s.sub) return s.th0 + (s.dth * n) / s.sub; n -= s.sub; t = s.th0 + s.dth; } return t; };
const dTheta = thetaAt(stepOf) - thetaAt(prevOf);
const disp = (r, n) => r.node.get(n).DISPLACEMENT;
const vec = (r, n, label) => r.node.get(n)[label] ?? [0, 0, 0];
const contactOn = ref.opts.swap ? 'roll' : 'strip';
// The contact forces sit on the slave nodes: the roll's surface nodes (swap) or the strip's top nodes.
// Either way each is read at its current position, and the pressure is the force over the node's
// share of the surface (half the distance to each neighbour along x) and the slice thickness.
let stations;
if (contactOn === 'roll') {
  // the roll's surface nodes, by their current x; the sign of the friction on the strip is the opposite of the roll's
  const ids = [...res.node.keys()].filter((n) => n > ref.mesh.strip.nodes); // roll nodes follow the strip's
  stations = [];
  const rows = new Map();
  for (const n of ids) {
    const fn = vec(res, n, 'CONTACT_NFORCE'), ft = vec(res, n, 'CONTACT_FRICTION');
    if (Math.hypot(fn[0], fn[1]) === 0 && Math.hypot(ft[0], ft[1]) === 0) continue;
    const q = res.node.get(n), d = q.DISPLACEMENT;
    const x0 = q.__x ?? null;
    rows.set(n, { n, fn, ft, d });
  }
  // node coordinates are not in the result file: read them from the mesh
  const msh = readFileSync(`${dir}/roll.msh`, 'utf8').split('\n');
  let mode = '';
  const X = new Map();
  for (const l of msh) { if (l.startsWith('!')) { mode = l; continue; } if (mode.startsWith('!NODE')) { const a = l.split(',').map(Number); X.set(a[0], a.slice(1)); } }
  for (const [n, r] of rows) { const x0 = X.get(n); r.x = x0[0] + r.d[0]; r.y = x0[1] + r.d[1]; r.z = x0[2]; }
  // one station per x (the two z nodes share it): the forces added
  const byX = new Map();
  for (const r of rows.values()) { const key = r.x.toFixed(7); const s = byX.get(key) ?? { x: r.x, y: r.y, fn: [0, 0], ft: [0, 0] }; s.fn[0] += r.fn[0]; s.fn[1] += r.fn[1]; s.ft[0] += r.ft[0]; s.ft[1] += r.ft[1]; byX.set(key, s); }
  stations = [...byX.values()].sort((a, b) => a.x - b.x);
  // forces on the roll's nodes are what the strip exerts on the roll: turn them round to read the strip's side
  for (const s of stations) { s.fn = [-s.fn[0], -s.fn[1]]; s.ft = [-s.ft[0], -s.ft[1]]; }
} else {
  stations = ref.slave.map((s) => {
    const d = disp(res, s.nodes[0]);
    const fn = [0, 0], ft = [0, 0];
    for (const n of s.nodes) { const a = vec(res, n, 'CONTACT_NFORCE'), b = vec(res, n, 'CONTACT_FRICTION'); fn[0] += a[0]; fn[1] += a[1]; ft[0] += b[0]; ft[1] += b[1]; }
    return { x: s.x0 + d[0], y: P.h0 / 2 * 0 + (ref.x0 ? 0 : 0) + d[1], fn, ft };
  });
}
const loaded = stations.filter((s) => Math.hypot(s.fn[0], s.fn[1]) > 0);
if (!loaded.length) throw new Error('no contact force in the last result');
const xEntry = loaded[0].x, xExit = loaded[loaded.length - 1].x;
// the pressure and the shear per station: force over the node's share of the arc (x-projected) and the thickness
const arc = [];
for (let i = 0; i < loaded.length; i++) {
  const s = loaded[i];
  const left = i > 0 ? loaded[i - 1].x : s.x - (loaded[1].x - s.x);
  const right = i + 1 < loaded.length ? loaded[i + 1].x : s.x + (s.x - loaded[i - 1].x);
  const ds = 0.5 * (right - left);
  const p = Math.hypot(s.fn[0], s.fn[1]) / (ds * tz);
  // friction on the strip: + drives it forward (upstream of the neutral point)
  const tau = (Math.sign(s.ft[0]) || 1) * Math.hypot(s.ft[0], s.ft[1]) / (ds * tz);
  arc.push({ x: s.x, p, tau });
}
// the neutral point: where the friction on the strip turns from forward to backward
let neutralX = NaN;
for (let i = 1; i < arc.length; i++) if (arc[i - 1].tau > 0 && arc[i].tau <= 0) { const a = arc[i - 1], b = arc[i]; neutralX = a.x + ((b.x - a.x) * a.tau) / (a.tau - b.tau); break; }
// force and torque per width: the strip's side, all contact forces
let Fy = 0, Fx = 0, M = 0;
for (const s of loaded) { const fx = s.fn[0] + s.ft[0], fy = s.fn[1] + s.ft[1]; Fy += fy; Fx += fx; M += (s.x - 0) * (-fy) - (s.y - yc) * (-fx); }
const force = Fy / tz, torque = M / tz; // [N/m], [N·m/m] on the roll about its centre
// the exit thickness: the strip's top past the exit, clear of the head
const stripTop = ref.slave.map((s) => { const d = disp(res, s.nodes[0]); return { x: s.x0 + d[0], y: d[1] }; });
const mshLines = readFileSync(`${dir}/roll.msh`, 'utf8').split('\n');
{ let mode = ''; const X = new Map(); for (const l of mshLines) { if (l.startsWith('!')) { mode = l; continue; } if (mode.startsWith('!NODE')) { const a = l.split(',').map(Number); X.set(a[0], a.slice(1)); } } ref.slave.forEach((s, i) => { stripTop[i].y += X.get(s.nodes[0])[1]; }); }
const past = stripTop.filter((s, i) => s.x > xExit + 1.5e-3 && i < ref.slave.length - 3);
const h1 = past.length ? (2 * past.reduce((a, s) => a + s.y, 0)) / past.length : NaN;
// the forward slip: how far the exited strip moved against the roll's surface between the last two results
let slip = NaN;
{
  const moved = [];
  ref.slave.forEach((s, i) => { const x = stripTop[i].x; if (x > xExit + 2e-3 && i < ref.slave.length - 3) { const dNow = disp(res, s.nodes[0])[0], dPrev = disp(prev, s.nodes[0])[0]; moved.push(dNow - dPrev); } });
  if (moved.length && dTheta > 0) slip = moved.reduce((a, b) => a + b, 0) / moved.length / (R * dTheta) - 1;
}
// steadiness: the force in the previous result
let forcePrev = NaN;
{
  let F = 0;
  for (const n of res.node.keys()) { const a = vec(prev, n, 'CONTACT_NFORCE'), b = vec(prev, n, 'CONTACT_FRICTION'); if (contactOn === 'roll' ? n > ref.mesh.strip.nodes : n <= ref.mesh.strip.nodes) F += a[1] + b[1]; }
  forcePrev = (contactOn === 'roll' ? -F : F) / tz;
}
const fistr = {
  force, torque, h1, forwardSlip: slip, neutralX: neutralX - xExit, arcLength: xExit - xEntry, xEntry, xExit,
  peakPressure: Math.max(...arc.map((a) => a.p)), meanPressure: force / (xExit - xEntry),
  arc: arc.map((a) => ({ x: a.x - xExit, p: a.p, tau: a.tau })), forcePrev, theta: thetaAt(stepOf), dTheta, step: stepOf,
};

// ── the app's answer at the same pass: the strip FEM, then the slab theories ──
setSlabHook(slabLoad);
const reduction = 1 - h1 / P.h0;
const app = defaultParams({ ...ref.patch, agcMode: 'gauge', agcTargetGauge: h1, reduction });
const sim = new RollingSim(app);
let frames = 0;
for (; frames < 3000; frames++) { sim.advance(1 / 60); if (frames > 600 && sim.diag.agcSettled && Math.abs(sim.diag.exitThickness - h1) < 1e-7) break; }
const d = sim.diag;
const m = sim.flow.mesh;
const appArc = [];
for (let i = 0; i <= m.nx; i++) if (sim.flow.ifActive[i]) appArc.push({ x: m.X[2 * m.topNodes[i]], p: sim.flow.ifPressure[i], tau: sim.flow.ifShear[i] });
appArc.sort((a, b) => a.x - b.x);
const fem = { force: d.rollForce, torque: d.torque, h1: d.exitThickness, forwardSlip: d.forwardSlip, neutralX: d.neutralFound ? d.neutralX : NaN, arcLength: d.arcLength, peakPressure: d.peakPressure, meanPressure: d.meanPressure, rollFlattening: d.rollFlattening, frames, arc: appArc };
const c = { h0: P.h0, h1, R, backTension: P.backTension, frontTension: P.frontTension, entryStrain: P.entryStrain ?? 0 };
const slabs = {};
for (const theory of ['karman', 'blandford', 'orowan']) { const s = slabLoad({ ...app, slabTheory: theory }, c, P.mu); slabs[theory] = { force: s.load, torque: s.torque, forwardSlip: s.forwardSlip, neutralX: s.neutralX, arcLength: s.arc, Rflat: s.Rflat, meanPressure: s.meanPressure, kf: s.kf }; }

// ── the table ──
const kNmm = (v) => (Number.isFinite(v) ? (v / 1e6).toFixed(3) : '—');
const Nm = (v) => (Number.isFinite(v) ? (v / 1e3).toFixed(2) : '—');
const mm = (v) => (Number.isFinite(v) ? (v * 1e3).toFixed(3) : '—');
const mpa = (v) => (Number.isFinite(v) ? (v / 1e6).toFixed(0) : '—');
const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(2) + ' %' : '—');
console.log(`strip2d: R ${(R * 1e3).toFixed(0)} mm, h0 ${mm(P.h0)} mm, gap ${mm(P.h1)} mm, μ ${P.mu}; FrontISTR result ${stepOf} (θ ${fistr.theta.toFixed(4)} rad), force in the previous result ${kNmm(forcePrev)} kN/mm`);
console.log(`  app at the exit thickness FrontISTR gave (${mm(h1)} mm, reduction ${(reduction * 100).toFixed(2)} %), ${frames} frames`);
const rows = [
  ['rolling force [kN/mm]', kNmm(fistr.force), kNmm(fem.force), ...['karman', 'blandford', 'orowan'].map((t) => kNmm(slabs[t].force))],
  ['torque per roll [N·m/mm]', Nm(fistr.torque), Nm(fem.torque), ...['karman', 'blandford', 'orowan'].map((t) => Nm(slabs[t].torque))],
  ['exit thickness [mm]', mm(fistr.h1), mm(fem.h1), '—', '—', '—'],
  ['forward slip', pct(fistr.forwardSlip), pct(fem.forwardSlip), ...['karman', 'blandford', 'orowan'].map((t) => pct(slabs[t].forwardSlip))],
  ['neutral point from the exit [mm]', mm(fistr.neutralX), mm(fem.neutralX), ...['karman', 'blandford', 'orowan'].map((t) => mm(slabs[t].neutralX))],
  ['contact length [mm]', mm(fistr.arcLength), mm(fem.arcLength), ...['karman', 'blandford', 'orowan'].map((t) => mm(slabs[t].arcLength))],
  ['peak pressure [MPa]', mpa(fistr.peakPressure), mpa(fem.peakPressure), '—', '—', '—'],
  ['mean pressure [MPa]', mpa(fistr.meanPressure), mpa(fem.meanPressure), ...['karman', 'blandford', 'orowan'].map((t) => mpa(slabs[t].meanPressure))],
];
console.log(['', 'FrontISTR', 'app strip FEM', 'Kármán', 'Bland-Ford', 'Orowan'].map((h, i) => (i ? h.padStart(14) : h.padEnd(34))).join(''));
for (const r of rows) console.log(r.map((v, i) => (i ? String(v).padStart(14) : v.padEnd(34))).join(''));
console.log('\n  x from exit [mm] | p FrontISTR / app [MPa] | τ FrontISTR / app [MPa]');
const interp = (xs, key, x) => { for (let i = 1; i < xs.length; i++) if (xs[i - 1].x <= x && x <= xs[i].x) { const a = xs[i - 1], b = xs[i]; return a[key] + ((b[key] - a[key]) * (x - a.x)) / (b.x - a.x); } return NaN; };
for (const a of fistr.arc) console.log(`  ${(a.x * 1e3).toFixed(2).padStart(8)} | ${mpa(a.p).padStart(6)} / ${mpa(interp(appArc, 'p', a.x)).padStart(6)} | ${mpa(a.tau).padStart(6)} / ${mpa(interp(appArc, 'tau', a.x)).padStart(6)}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ params: P, fistr, fem, slabs }, null, 1));
