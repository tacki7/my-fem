// The path to a setting does not change the answer: a solver moved to an input by `setParams`
// converges where a solver built on that input from the start does.
//
//   node tools/sim3d/paramspath.mjs              exit 1 on any FAIL
//   node tools/sim3d/paramspath.mjs --measure    print every margin, hold nothing
//   node tools/sim3d/paramspath.mjs width        only the cases whose 'mill label' contains the text
//
// `setParams` rebuilds the mesh only when `geometryKey` changes; everything else is refreshed in
// place (`refreshProfiles`). An input read only by the rebuild - the contacts' normals and their
// elastic law - but left out of the key used to be ignored until some other change rebuilt the
// mesh, so the result depended on the order the dials were touched in (a 4Hi with the roll
// modulus at 150 GPa came out at C25 67.1 or 71.4 µm).
//
// Per mill one solver walks through the cases below, each an input changed from the mill's
// defaults: it is moved back to the defaults and settled, then moved to the case by `setParams`
// and settled, and a fresh solver is built on the case and settled. Going back first keeps a
// case from hiding behind its neighbour - returning a geometry input rebuilds the mesh, which
// would take in a missed input on the way. Load, screw, crown, edge drops and latent flatness are
// compared. On the gate's grid (81 stations, the strip on the same grid, 8 rows along the
// rolling direction) and the defaults' model.
//
// @check
// @check-build sim3d
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';

const MEASURE = process.argv.includes('--measure');
const ONLY = process.argv.slice(2).find((a) => !a.startsWith('--'));
const GRID = { stations: 81, stripStations: 0, stripNz: 8 };
const TONF = 9.80665e3;
const DEG = Math.PI / 180;

/**
 * The inputs that shape the stack, its contacts and its supports, and a few of the profile and
 * actuator ones that were always refreshed (they have to keep passing). [mill, label, patch],
 * patches on the mill's defaults and the grid; `base` is laid under every case of that mill.
 */
const MILLS = [
  {
    mill: '4hi', base: {},
    cases: [
      ['Eroll 150 GPa', { Eroll: 150e9 }],
      ['nuRoll 0.25', { nuRoll: 0.25 }],
      ['wrD 450 mm', { wrD: 0.45 }],
      ['wrDn 250 mm', { wrDn: 0.25 }],
      ['wrLb 1500 mm', { wrLb: 1.5 }],
      ['wrLs 2000 mm', { wrLs: 2.0 }],
      ['burD 1200 mm', { burD: 1.2 }],
      ['burDn 700 mm', { burDn: 0.7 }],
      ['burLb 1500 mm', { burLb: 1.5 }],
      ['burLs 2200 mm', { burLs: 2.2 }],
      ['width 1050 mm', { width: 1.05 }],
      ['wrCrown 100 µm', { wrCrown: 100e-6 }],
      ['burCrown 200 µm', { burCrown: 200e-6 }],
      ['wrThermal 60 µm', { wrThermal: 60e-6 }],
      ['wrBender 50 tonf', { wrBender: 50 * TONF }],
      ['housingK 3 GN/m', { housingK: 3e9 }],
      ['flatModel ring', { flatModel: 'ring', ringNt: 200, ringNr: 6 }],
      ['ring hub 0.4', { flatModel: 'ring', ringNt: 200, ringNr: 6, ringHub: 0.4 }],
    ],
  },
  {
    // the strip on its own cells: the grid then follows the width (on the even grid above it does not)
    mill: '4hi strip cells', millType: '4hi', base: { stripStations: 71 },
    cases: [
      ['width 1050 mm', { width: 1.05 }],
    ],
  },
  {
    // a bender on the work roll's chocks: its force sits at the supports the span places
    mill: '4hi bender', millType: '4hi', base: { wrBender: 50 * TONF },
    cases: [
      ['wrLs 2000 mm', { wrLs: 2.0 }],
    ],
  },
  {
    mill: '4hi housing', millType: '4hi', base: { housingMode: true },
    cases: [
      ['housingPostArea 0.25 m²', { housingPostArea: 0.25 }],
      ['housingCrossI 3e-3 m⁴', { housingCrossI: 3e-3 }],
      ['housingE 150 GPa', { housingE: 150e9 }],
    ],
  },
  {
    mill: '6hi', base: {},
    cases: [
      ['irShift +50 mm', { irShift: 0.05 }],
      ['irShift -50 mm', { irShift: -0.05 }],
      ['width 1050 mm', { width: 1.05 }],
      ['irD 450 mm', { irD: 0.45 }],
      ['irDn 250 mm', { irDn: 0.25 }],
      ['irLb 1600 mm', { irLb: 1.6 }],
      ['irLs 2100 mm', { irLs: 2.1 }],
      ['irBender 50 tonf', { irBender: 50 * TONF }],
      ['Eroll 150 GPa', { Eroll: 150e9 }],
      ['housing, IR seat 1 GN/m', { housingMode: true, irSeatK: 1e9 }],
    ],
  },
  {
    mill: '12hi', base: {},
    cases: [
      ['clearance 20 mm', { clearance: 20e-3 }],
      ['angle1 45°', { angle1: 45 * DEG }],
      ['Eroll 150 GPa', { Eroll: 150e9 }],
      ['nuRoll 0.25', { nuRoll: 0.25 }],
      ['irD 200 mm', { irD: 0.2 }],
      ['bbD 280 mm', { bbD: 0.28 }],
      ['bbShaft 150 mm', { bbShaft: 0.15 }],
      ['bbLb 1400 mm', { bbLb: 1.4 }],
      ['bbGap 60 mm', { bbGap: 0.06 }],
      ['bbSegmented off', { bbSegmented: false }],
      ['asu B centre 200 µm', { asu: [0, 0, 0, 200e-6, 0, 0, 0] }],
    ],
  },
];

const TOL = {
  // Both solves stop on the solver's settling rule (CONVERGENCE in solver.ts: a force residual of
  // 2e-6, an update under 5 nm, the strip FEM's ratio to 2e-3 a round), from different starts -
  // the moved one keeps its last solution and FEM correction - so they agree to that rule, not
  // bit for bit. Largest on these cases (macOS, Node 24): load 1.6e-5, screw 6.2e-9 m, crown
  // 5.3e-9 m, edge drop 1.1e-8 m, latent 0.8 I-unit. A missed input moves them by far more: on
  // the build before the key held Eroll, nuRoll and clearance, the 4Hi at 150 GPa was off by
  // 4.7e-4 in load, 4.2 µm in crown and 253 I-unit, the 12Hi at a 20 mm clearance by 910 I-unit.
  force: 1e-4,      // relative
  len: 1e-7,        // m: screw, crown, edge drops
  latent: 3,        // I-unit
};

let fails = 0;
function hold(name, value, limit, detail = '') {
  const ok = Number.isFinite(value) && value <= limit;
  if (MEASURE) { console.log(`${(value / limit).toExponential(2).padStart(9)} of limit  ${name}  ${detail}`); return; }
  if (!ok) { fails++; console.log(`FAIL  ${name}  ${value} > ${limit} ${detail}`); }
}

function settleOnce(sv) {
  let it = 0;
  for (let f = 0; f < 400; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  return it;
}
/**
 * Solve to convergence, then wake the solver and let it settle again. A cold start can stop
 * with the strip FEM's correction not yet where a warm one takes it (12Hi with an AS-U set:
 * 274.10 tonf cold, 274.18 once woken - where every moved solver lands too), which is the
 * settling rule's spread and not the path. Waking rebuilds nothing, so an input the moved solver
 * never took in is still missed.
 */
function settle(sv) {
  const it = settleOnce(sv);
  sv.wake();
  return it + settleOnce(sv);
}

const t0 = performance.now();
let count = 0;
for (const m of MILLS) {
  const type = m.millType ?? m.mill;
  const params = (patch) => ({ ...defaultParams(type), ...GRID, ...m.base, ...patch });
  const cases = m.cases.filter(([label]) => !ONLY || `${m.mill} ${label}`.includes(ONLY));
  if (!cases.length) continue;
  let walker = new StackSolver(params({}));
  settle(walker);
  for (const [label, patch] of cases) {
    walker.setParams(params({}));
    settle(walker);
    const p = params(patch);
    walker.setParams(p);
    const itMoved = settle(walker);
    const fresh = new StackSolver(p);
    const itFresh = settle(fresh);
    const a = walker.result, b = fresh.result;
    const name = `${m.mill} ${label}`;
    if (!a.converged || !b.converged) {
      fails++;
      console.log(`FAIL  ${name}: did not converge (moved ${a.converged}, fresh ${b.converged})`);
      // a walker that lost its way would fail every case after it: start the next one afresh
      walker = new StackSolver(params({}));
      settle(walker);
      continue;
    }
    const detail = `moved ${itMoved} / fresh ${itFresh} it; C25 ${(a.crown * 1e6).toFixed(3)} / ${(b.crown * 1e6).toFixed(3)} µm, latent ${a.latentIU.toFixed(1)} / ${b.latentIU.toFixed(1)}`;
    hold(`${name}: load`, Math.abs(a.force / b.force - 1), TOL.force, detail);
    hold(`${name}: screw`, Math.abs(a.screw - b.screw), TOL.len, detail);
    hold(`${name}: crown`, Math.abs(a.crown - b.crown), TOL.len, detail);
    hold(`${name}: edge drop`, Math.max(Math.abs(a.edgeDropL - b.edgeDropL), Math.abs(a.edgeDropR - b.edgeDropR)), TOL.len, detail);
    hold(`${name}: latent flatness`, Math.abs(a.latentIU - b.latentIU), TOL.latent, detail);
    count++;
  }
}
const sec = (performance.now() - t0) / 1000;
if (fails) { console.log(`\n${fails} FAIL (${count} cases, ${sec.toFixed(1)} s)`); process.exit(1); }
console.log(`\n${count} cases, ${sec.toFixed(1)} s\nall PASS`);
