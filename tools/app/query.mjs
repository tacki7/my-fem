// The query-string reader (`src/app/query.ts`), table-driven.
//
//   node tools/build-esm.mjs --out tools/app/build src/app/query.ts
//   node tools/app/query.mjs      (exit 1 on FAIL)
//
// 1. Cases with a known answer, including the prototype keys `?mesh=constructor`
//    used to let through.
// 2. Against the inline parser main.ts had before, re-typed below: over every
//    combination of a set of values per key, the two agree except where the old
//    one was wrong (a prototype key accepted as a mesh preset).
// 3. The tab rule and the gauge schedule `?h1=` seeds.
//
// @check
// @check-build --out tools/app/build src/app/query.ts
import { parseQuery, startIn3d, gaugeSchedule } from './build/app/query.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const VOCAB = {
  fields: ['strain', 'strainRate', 'flowStress', 'temperature', 'pressure'],
  colormaps: ['plasma', 'viridis', 'turbo'],
  meshes: ['fast', 'balanced', 'fine', 'ultra', 'extreme', 'insane'],
};
const MAX = 8;
const q = (s) => parseQuery(s, VOCAB, MAX);
const FLAGS = { debug: false, nowire: false, notrace: false, nomirror: false, nosolve: false, nogrid: false, fixeddt: false, tab: null };

// --- 1 -----------------------------------------------------------------------
const CASES = [
  ['', {}],
  ['?debug', { debug: true }],
  ['?debug=0&nowire&notrace&nomirror&nosolve&nogrid', { debug: true, nowire: true, notrace: true, nomirror: true, nosolve: true, nogrid: true }],
  ['?field=temperature&cmap=viridis', { field: 'temperature', cmap: 'viridis' }],
  ['?field=nope&cmap=constructor', {}],
  ['?mesh=insane', { mesh: 'insane' }],
  ['?mesh=constructor', {}],
  ['?mesh=toString', {}],
  ['?mesh=__proto__', {}],
  ['?mesh=hasOwnProperty', {}],
  ['?mesh=', {}],
  ['?agc=gauge', { agc: 'gauge' }],
  ['?agc=GAUGE', {}],
  ['?tension=dist&tctl=1&tscale=0.05', { tension: 'dist', tctl: true, tscale: 0.05 }],
  ['?tctl=0&tscale=1', { tctl: false, tscale: 1 }],
  ['?tctl=true&tscale=0', {}],
  ['?tscale=1.5', {}],
  ['?h1=1.2', { h1: 0.0012 }],
  ['?h1=1e0', { h1: 0.001 }],
  ['?h1=0', {}],
  ['?h1=-1', {}],
  ['?h1=', {}],
  ['?h1=Infinity', {}],
  ['?h1=abc', {}],
  ['?mode=reverse', { mode: 'reverse' }],
  ['?loadmodel=slab&slab=orowan&flat=roberts', { loadmodel: 'slab', slab: 'orowan', flat: 'roberts' }],
  ['?stands=3', { stands: 3 }],
  ['?stands=2.6', { stands: 3 }],
  ['?stands=1.4', { stands: 1 }],
  ['?stands=0.6', {}],
  ['?stands=99', { stands: MAX }],
  ['?load=800', { load: 800 }],
  ['?load=-5', {}],
  ['?fixeddt&stopafter=600', { fixeddt: true, stopafter: 600 }],
  ['?fixeddt=0', { fixeddt: true }],
  ['?stopafter=2.6', { stopafter: 3 }],
  ['?stopafter=1.4', { stopafter: 1 }],
  ['?stopafter=0.6', {}],
  ['?stopafter=0', {}],
  ['?stopafter=', {}],
  ['?stopafter=-5', {}],
  ['?stopafter=Infinity', {}],
  ['?stopafter=abc', {}],
  ['?mill=4hi', {}],
  ['?tab=3d', { tab: '3d' }],
  ['?tab=2d', { tab: '2d' }],
  ['?stands=3&agc=ratio&load=700&h1=1.2&field=temperature&mesh=insane&tension=rigid&tctl=1&tscale=0.05',
    { field: 'temperature', mesh: 'insane', agc: 'ratio', tension: 'rigid', tctl: true, tscale: 0.05, h1: 0.0012, stands: 3, load: 700 }],
];
let bad = [];
for (const [s, want] of CASES) {
  const got = q(s);
  const exp = { ...FLAGS, ...want };
  const keys = new Set([...Object.keys(got), ...Object.keys(exp)]);
  const diff = [...keys].filter((k) => !same(got[k], exp[k]));
  if (diff.length) bad.push(`${s || '(empty)'}: ${diff.map((k) => `${k} ${JSON.stringify(got[k])} ≠ ${JSON.stringify(exp[k])}`).join(', ')}`);
}
check('known cases', bad.length === 0, `${CASES.length} cases${bad.length ? '; ' + bad.join('; ') : ''}`);
check('a URLSearchParams reads the same as its string', same(q(new URLSearchParams('?stands=2&h1=0.5&tab=3d')), q('?stands=2&h1=0.5&tab=3d')));

// --- 2 -----------------------------------------------------------------------
// The parser main.ts had inline, re-typed with the same tests in the same order -
// less its `?mill=`, which went when the 3D tab was cut to the 2Hi (2026-09-19);
// the `mill` values below now check that both ignore it.
function legacy(search) {
  const QS = new URLSearchParams(search);
  const o = { ...FLAGS, debug: QS.has('debug') };
  if (QS.has('nowire')) o.nowire = true;
  if (QS.has('notrace')) o.notrace = true;
  if (QS.has('nomirror')) o.nomirror = true;
  if (QS.has('nosolve')) o.nosolve = true;
  if (QS.has('nogrid')) o.nogrid = true;
  const qf = QS.get('field');
  if (qf && new Map(VOCAB.fields.map((f) => [f, f])).has(qf)) o.field = qf;
  const qc = QS.get('cmap');
  if (qc && VOCAB.colormaps.includes(qc)) o.cmap = qc;
  const meshObj = Object.fromEntries(VOCAB.meshes.map((m) => [m, {}]));
  const qmesh = QS.get('mesh');
  if (qmesh && qmesh in meshObj) o.mesh = qmesh;
  const qa = QS.get('agc');
  if (qa === 'off' || qa === 'ratio' || qa === 'gauge' || qa === 'force') o.agc = qa;
  const qt = QS.get('tension');
  if (qt === 'off' || qt === 'rigid' || qt === 'simple' || qt === 'dist') o.tension = qt;
  const qtc = QS.get('tctl');
  if (qtc === '1' || qtc === '0') o.tctl = qtc === '1';
  const qts = Number(QS.get('tscale'));
  if (Number.isFinite(qts) && qts > 0 && qts <= 1) o.tscale = qts;
  const qg = Number(QS.get('h1'));
  if (Number.isFinite(qg) && qg > 0) o.h1 = qg / 1000;
  const qm = QS.get('mode');
  if (qm === 'tandem' || qm === 'reverse') o.mode = qm;
  const qlm = QS.get('loadmodel');
  if (qlm === 'fem' || qlm === 'slab') o.loadmodel = qlm;
  const qst = QS.get('slab');
  if (qst === 'karman' || qst === 'orowan' || qst === 'blandford') o.slab = qst;
  const qfl = QS.get('flat');
  if (qfl === 'hitchcock' || qfl === 'roberts') o.flat = qfl;
  const qs = Number(QS.get('stands'));
  if (Number.isFinite(qs) && qs >= 1) o.stands = Math.min(MAX, Math.round(qs));
  const ql = Number(QS.get('load'));
  if (Number.isFinite(ql) && ql > 0) o.load = ql;
  o.tab = QS.get('tab');
  return o;
}
const VALUES = {
  field: [null, 'strain', 'pressure', 'bogus', '', 'constructor'],
  mesh: [null, 'fast', 'insane', '', 'constructor', '__proto__', 'toString'],
  agc: [null, 'off', 'force', 'x'],
  tctl: [null, '1', '0', 'yes'],
  tscale: [null, '0.5', '0', '2', 'x'],
  h1: [null, '1.2', '0', '-3', 'x', ''],
  stands: [null, '1', '3.5', '0', '12', 'x'],
  load: [null, '700', '0', 'x'],
  mill: [null, '2HI', '12hi', 'x'],
  tab: [null, '3d', '2d', ''],
  debug: [null, ''],
};
const keys = Object.keys(VALUES);
let n = 0, differ = 0, explained = 0, other = [];
// every value of each key against the default of the others, and a pseudo-random
// sample of full combinations
const combos = [];
for (const k of keys) for (const v of VALUES[k]) combos.push({ [k]: v });
let seed = 12345;
const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
for (let i = 0; i < 3000; i++) combos.push(Object.fromEntries(keys.map((k) => [k, VALUES[k][rnd(VALUES[k].length)]])));
for (const c of combos) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(c)) if (v !== null) sp.set(k, v);
  const s = '?' + sp.toString();
  const a = q(s), b = legacy(s);
  n++;
  if (same({ ...a }, { ...b })) continue;
  differ++;
  const d = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));
  if (d.length === 1 && d[0] === 'mesh' && a.mesh === undefined && !VOCAB.meshes.includes(b.mesh)) explained++;
  else other.push(`${s}: ${d.join(',')}`);
}
check('same as the old inline parser, except prototype keys as a mesh', other.length === 0,
  `${n} query strings, ${differ} differ, ${explained} of them a prototype key the old one took as a mesh${other.length ? '; ' + other.slice(0, 3).join('; ') : ''}`);
check('…and that exception is exercised', explained > 0, `${explained}`);

// --- 3 -----------------------------------------------------------------------
const TAB = [[null, null, false], [null, '3d', true], [null, '2d', false], ['3d', null, true], ['3d', '2d', true],
  ['2d', '3d', false], ['', '3d', false], ['x', '3d', false]];
check('startIn3d', TAB.every(([t, r, w]) => startIn3d(t, r) === w),
  TAB.filter(([t, r, w]) => startIn3d(t, r) !== w).map(([t, r]) => `tab ${t} remembered ${r}`).join('; '));

const g = gaugeSchedule(1.2e-3, [0.25, 0.25, 0.25]);
check('gaugeSchedule from h1 = 1.2 mm, 25 % each', g.length === 3 && Math.abs(g[0] - 1.2e-3) < 1e-15 && Math.abs(g[1] - 0.9e-3) < 1e-15 && Math.abs(g[2] - 0.675e-3) < 1e-15,
  g.map((x) => (x * 1000).toFixed(4)).join(' / '));
let worst = 0;
for (const h0 of [0.002, 0.008, 5e-5]) for (const r of [0.05, 0.25, 0.4]) {
  const s = gaugeSchedule(h0 * (1 - r), Array(8).fill(r));
  s.forEach((x, k) => { worst = Math.max(worst, Math.abs(x / (h0 * Math.pow(1 - r, k + 1)) - 1)); });
}
check('gaugeSchedule(h0(1−r), r…) = the default seed h0(1−r)^(k+1)', worst < 1e-14, `worst ${worst.toExponential(1)}`);
const mixed = gaugeSchedule(1e-3, [0.3, 0.1, 0.2]);
check('per-stand reductions, and no target thicker than the one before', Math.abs(mixed[1] - 0.9e-3) < 1e-15 && Math.abs(mixed[2] - 0.72e-3) < 1e-15
  && mixed.every((x, k) => k === 0 || x <= mixed[k - 1]), mixed.map((x) => (x * 1000).toFixed(4)).join(' / '));

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
