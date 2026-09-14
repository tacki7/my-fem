// The 3D quick gate: what has to stay true of the roll-stack solver, in about ten seconds.
//
//   node tools/sim3d/check.mjs                    exit 1 on any FAIL
//   node tools/sim3d/check.mjs --measure          print every margin, hold nothing
//   node tools/sim3d/check.mjs --write-baseline   rewrite check-baseline.json from this build
//
// 1. Each case converges, with nothing non-finite, and raises the same warnings as the baseline.
// 2. The solve's own invariants (audit-lib.mjs): force balance of every roll, each contact's
//    approach and load against its law, and the strip slices against the slice law with the
//    FEM load ratio they were solved with.
// 3. The contact law inverts: approach(loadAt(δ)) = δ over five decades of δ, for every law used.
// 4. 6Hi intermediate-roll shift: the lower half is the upper one turned about the centre
//    (|v_upper(x) − v_lower(−x)|), and a 1 µm shift - solved on both halves - lands where the
//    unshifted, mirrored model does.
// 5. The headline results (load, screw, gauge, crown, wedge, edge drops, flatness) against
//    check-baseline.json, to a relative tolerance that allows the last digits of V8's maths
//    functions to differ between macOS and Linux (see TOL below for the measured spread).
//
// @check
// @check-build sim3d
import { readFileSync, writeFileSync } from 'node:fs';
import { defaultParams } from './build/stack.js';
import { loadAt, approach } from './build/contact.js';
import { CONVERGENCE } from './build/solver.js';
import { solve, equilibrium, contactKinematics, stripConsistency } from './audit-lib.mjs';

const MEASURE = process.argv.includes('--measure');
const WRITE = process.argv.includes('--write-baseline');
const BASELINE = new URL('./check-baseline.json', import.meta.url);
const TONF = 9.80665e3;

const CASES = [
  ['2hi', {}], ['4hi', {}], ['6hi', {}], ['12hi', {}], ['20hi', {}],
  ['4hi slab', { stripModel: 'slab' }, '4hi'],
  ['4hi ring', { flatModel: 'ring' }, '4hi'],
  ['6hi shift +100', { irShift: 0.1 }, '6hi'],
  ['6hi shift -50', { irShift: -0.05 }, '6hi'],
  ['6hi sym barrel s=0', { irLb: 1.0 }, '6hi'],
  ['6hi sym barrel s=1um', { irLb: 1.0 - 2e-6 }, '6hi'],
];

const TOL = {
  // |net| / force per roll. Not zero by construction: the rigid-body stops are springs of
  // 2e4 N/m (docs/validation.md, ロール接触の検算), ~0.1-0.3 tonf here. Largest on these
  // cases 2.4e-4 (6hi shift -50, IR).
  balance: 1e-3,
  contactDelta: 1e-12,     // m
  contactQ: 1e-12,         // relative
  stripH1: 1e-10,          // m
  // a slice is solved with the ratio from before the last correction round, which moves it by under femTol once settled
  stripQFem: CONVERGENCE.femTol,
  stripQSlab: 1e-8,
  lawRoundTrip: 1e-8,      // relative, loadAt stops its Newton at a 1e-9 step
  pointSym: 1e-9,          // m
  // s = 0 against s = 1 µm: both are converged solves of all but the same problem, so they
  // agree to the solver's own settling rule - the force residual and the largest update
  pathForce: CONVERGENCE.residual,   // relative
  pathLen: CONVERGENCE.step,         // m
  baselineRel: 1e-6,
  baselineAbs: { len: 1e-10, iu: 1e-3 },
};

let fails = 0;
const margins = [];
function hold(name, value, limit, detail = '') {
  const ok = Number.isFinite(value) && value <= limit;
  margins.push({ name, value, limit });
  if (MEASURE) return;
  if (!ok) { fails++; console.log(`FAIL  ${name}  ${value} > ${limit} ${detail}`); }
}
function truth(name, ok, detail = '') {
  if (MEASURE) { console.log(`${ok ? 'true ' : 'FALSE'}  ${name}  ${detail}`); return; }
  if (!ok) { fails++; console.log(`FAIL  ${name}  ${detail}`); }
}

const results = {};
const t0 = performance.now();
for (const [label, patch, millArg] of CASES) {
  const mill = millArg ?? label;
  const p = { ...defaultParams(mill), ...patch };
  const tc = performance.now();
  const { sv, iterations } = solve(p, 400);
  const R = sv.result;
  const finite = [R.force, R.screw, R.h1Mean, R.crown, R.wedge, R.edgeDropL, R.edgeDropR, R.latentIU, R.manifestIU].every(Number.isFinite)
    && sv.rolls.every((r) => { for (let s = r.ia; s <= r.ib; s++) if (!Number.isFinite(r.v[s])) return false; return true; });
  truth(`${label}: converged`, R.converged, `residual ${R.residual}`);
  truth(`${label}: every result and roll deflection finite`, finite);

  // 2. invariants
  for (const e of equilibrium(sv)) hold(`${label}: force balance ${e.id} |net|/F`, Math.abs(e.net) / R.force, TOL.balance, `net ${(e.net / TONF).toFixed(3)} tonf`);
  for (const k of contactKinematics(sv)) {
    const name = `${label}: contact ${k.a.def.id}-${k.b.def.id}`;
    hold(`${name} approach`, k.deltaMismatch, TOL.contactDelta);
    hold(`${name} load`, k.qRelMismatch, TOL.contactQ);
  }
  const S = stripConsistency(sv, p);
  hold(`${label}: strip exit gauge`, S.h1Mismatch, TOL.stripH1);
  hold(`${label}: strip load (${p.stripModel})`, S.qRelMismatch, p.stripModel === 'slab' ? TOL.stripQSlab : TOL.stripQFem);

  // 3. the contact laws in use, and the work roll against the strip with and without the arc floor
  const laws = [...new Set(sv.contacts.map((c) => c.law))];
  const mid = sv.slices[Math.floor(sv.slices.length / 2)];
  laws.push(sv.wsLaw, { ...sv.wsLaw, bFloor: Math.max(0, mid.arc / 2) });
  let worstLaw = 0;
  for (const law of laws) {
    for (let e = -8; e <= -3; e += 0.5) {
      const d = 10 ** e;
      const [q] = loadAt(law, d, 0);
      const [back] = approach(law, q);
      worstLaw = Math.max(worstLaw, Math.abs(back / d - 1));
    }
  }
  hold(`${label}: contact law round trip over ${laws.length} laws`, worstLaw, TOL.lawRoundTrip);

  // 4. point symmetry of a solved lower half
  const nU = R.rolls.length, ns = R.x.length;
  if (sv.rolls.length > nU) {
    let d = 0;
    for (let r = 0; r < nU; r++) for (let s = 0; s < ns; s++) {
      const a = sv.rolls[r].v[s], b = sv.rolls[nU + r].v[ns - 1 - s];
      if (Number.isFinite(a) && Number.isFinite(b)) d = Math.max(d, Math.abs(a - b));
    }
    hold(`${label}: lower half is the upper one turned about the centre, max |vU(x) - vL(-x)|`, d, TOL.pointSym);
  }

  results[label] = {
    warnings: [...R.warnings],
    force: R.force, screw: R.screw, h1Mean: R.h1Mean, crown: R.crown, wedge: R.wedge,
    edgeDropL: R.edgeDropL, edgeDropR: R.edgeDropR, latentIU: R.latentIU, manifestIU: R.manifestIU,
    halves: sv.rolls.length > nU ? 2 : 1, iterations, ms: Math.round(performance.now() - tc),
  };
}

// 4b. the shifted-by-a-micron solve on both halves against the mirrored one
{
  const a = results['6hi sym barrel s=0'], b = results['6hi sym barrel s=1um'];
  truth('6hi sym barrel: s = 0 solves the mirrored half, s = 1 µm both halves', a.halves === 1 && b.halves === 2, `${a.halves} / ${b.halves}`);
  hold('6hi sym barrel: s = 1 µm against s = 0, force (relative)', Math.abs(a.force - b.force) / a.force, TOL.pathForce, `${a.force} / ${b.force}`);
  for (const k of ['screw', 'h1Mean', 'crown', 'edgeDropL', 'edgeDropR']) {
    hold(`6hi sym barrel: s = 1 µm against s = 0, ${k} [m]`, Math.abs(a[k] - b[k]), TOL.pathLen, `${a[k]} / ${b[k]}`);
  }
}

// 5. the baseline
const KEYS = { force: 'rel', screw: 'len', h1Mean: 'len', crown: 'len', wedge: 'len', edgeDropL: 'len', edgeDropR: 'len', latentIU: 'iu', manifestIU: 'iu' };
if (WRITE) {
  const out = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f === 'warnings' || f in KEYS))]));
  writeFileSync(BASELINE, `${JSON.stringify(out, null, 1)}\n`);
  console.log('wrote', BASELINE.pathname.split('/').slice(-3).join('/'));
} else {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  truth('baseline: the same cases', Object.keys(base).join('|') === Object.keys(results).join('|'), `${Object.keys(base)} / ${Object.keys(results)}`);
  for (const [label, b] of Object.entries(base)) {
    const r = results[label]; if (!r) continue;
    truth(`${label}: warnings as in the baseline`, JSON.stringify(r.warnings) === JSON.stringify(b.warnings), `[${r.warnings}] / [${b.warnings}]`);
    for (const [k, kind] of Object.entries(KEYS)) {
      const diff = Math.abs(r[k] - b[k]);
      const scale = Math.max(Math.abs(r[k]), Math.abs(b[k]));
      const limit = TOL.baselineRel * scale + (kind === 'rel' ? 0 : TOL.baselineAbs[kind]);
      hold(`${label}: ${k} against the baseline`, diff, limit, `${r[k]} / ${b[k]}`);
    }
  }
}

const ms = performance.now() - t0;
// how close the baseline comparison came, on this machine - the number the tolerance above is set against
{
  let worst = null;
  for (const m of margins) if (m.name.endsWith('against the baseline') && (!worst || m.value / m.limit > worst.value / worst.limit)) worst = m;
  if (worst) console.log(`baseline: closest ${(worst.value / worst.limit).toExponential(2)} of its limit (${worst.value.toExponential(2)} / ${worst.limit.toExponential(2)}, ${worst.name})`);
}
if (MEASURE) {
  // the tightest margin per kind of check: how close each held quantity came to its limit
  const byKind = new Map();
  for (const m of margins) {
    const kind = m.name.replace(/^[^:]+: /, '').replace(/ [A-Za-z0-9'-]+-[A-Za-z0-9'-]+ /, ' <pair> ').replace(/ over \d+ laws/, '').replace(/ balance \S+ /, ' balance <roll> ');
    const ratio = m.value / m.limit;
    const cur = byKind.get(kind);
    if (!cur || ratio > cur.ratio) byKind.set(kind, { ratio, value: m.value, limit: m.limit, name: m.name });
  }
  for (const [kind, v] of byKind) console.log(`${v.ratio.toExponential(2).padStart(9)} of limit  ${v.value.toExponential(2)} / ${v.limit.toExponential(1)}  ${v.name}`);
  for (const [label, r] of Object.entries(results)) console.log(`  ${label.padEnd(22)} ${r.ms} ms, ${r.iterations} it, F ${(r.force / TONF).toFixed(1)} tonf, [${r.warnings}]`);
}
console.log(`\n${margins.length} quantities held, ${Object.keys(results).length} cases, ${(ms / 1000).toFixed(1)} s`);
if (MEASURE || WRITE) process.exit(0);
if (fails) { console.log(`${fails} FAIL`); process.exit(1); }
console.log('all PASS');
