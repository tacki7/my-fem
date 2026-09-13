import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const TONF = 9.80665e3;
const cases = [];
const add = (mill, patch, tag) => cases.push({ mill, patch, tag });
for (const m of ['2hi', '4hi', '6hi', '12hi', '20hi']) {
  add(m, {}, 'default');
  add(m, { reduction: 0.02 }, 'r=2%');
  add(m, { reduction: 0.6 }, 'r=60%');
  add(m, { h0: 0.00005, reduction: 0.25 }, 'foil 50um');
  add(m, { h0: 0.006, reduction: 0.3 }, 'h0=6mm');
  add(m, { width: 0.3 }, 'W=300');
  add(m, { width: 1.6 }, 'W=1600');
  add(m, { mu: 0.01 }, 'mu=0.01');
  add(m, { mu: 0.3 }, 'mu=0.3');
  add(m, { backTension: 300e6, frontTension: 300e6 }, 'tension 300');
  add(m, { backTension: 0, frontTension: 0 }, 'tension 0');
  add(m, { lmnL: 3000e6 }, 'L=3000');
  add(m, { lmnL: 200e6 }, 'L=200');
  add(m, { lmnN: 0 }, 'N=0');
  add(m, { entryCrown: -100e-6 }, 'entryCrown -100');
  add(m, { entryCrown: 200e-6 }, 'entryCrown +200');
  add(m, { wrCrown: 400e-6 }, 'wrCrown +400');
  add(m, { wrCrown: -400e-6 }, 'wrCrown -400');
  add(m, { leveling: 300e-6 }, 'leveling 300');
  add(m, { housingK: 1e9 }, 'housing 1');
  add(m, { housingK: 30e9 }, 'housing 30');
  add(m, { mode: 'force', targetForce: 20 * TONF }, 'force 20t');
  add(m, { mode: 'force', targetForce: 4000 * TONF }, 'force 4000t');
  add(m, { mode: 'screw', screw: -2e-3 }, 'screw -2mm');
  add(m, { mode: 'screw', screw: 8e-3 }, 'screw 8mm');
  add(m, { stations: 21 }, 'st=21');
  add(m, { stations: 241 }, 'st=241');
  add(m, { lateralLen: 0 }, 'lat=0');
  add(m, { lateralLen: 0.1 }, 'lat=100');
  add(m, { sigmaCr: 0 }, 'sigcr=0');
  add(m, { sigmaCr: 20e6 }, 'sigcr=20');
  add(m, { Eroll: 100e9 }, 'Eroll 100');
  add(m, { wrD: 0.03 }, 'wrD=30mm');
  add(m, { wrD: 0.9 }, 'wrD=900mm');
  add(m, { wrLb: 0.5, wrLs: 0.6, width: 0.3 }, 'short WR');
}
add('4hi', { wrBender: -60 * TONF }, 'bender -60');
add('4hi', { wrBender: 200 * TONF }, 'bender 200');
add('4hi', { burCrown: -600e-6 }, 'bur -600');
add('4hi', { burCrown: 1000e-6 }, 'bur +1000');
add('4hi', { burD: 2, burLs: 3.2 }, 'bur 2m');
add('6hi', { irShift: -0.15 }, 'irShift -150');
add('6hi', { irShift: 0.15 }, 'irShift +150');
add('6hi', { irBender: 200 * TONF, wrBender: 200 * TONF }, 'benders 200');
add('6hi', { width: 1.6, irShift: -0.15 }, 'W1600 irShift -150');
add('20hi', { taperShift: -0.2 }, 'taper -200');
add('20hi', { taperShift: 0.2 }, 'taper +200');
add('20hi', { taperDepth: 1e-3, taperLen: 0.05 }, 'taper deep short');
add('20hi', { taperDepth: 0 }, 'taper 0');
add('20hi', { asu: [500e-6, -500e-6, 500e-6, -500e-6, 500e-6, -500e-6, 500e-6] }, 'asu zigzag');
add('20hi', { asu: new Array(7).fill(500e-6) }, 'asu +500 all');
add('20hi', { asu: new Array(7).fill(-500e-6) }, 'asu -500 all');
add('12hi', { asu: [0, 0, 0, 500e-6, 0, 0, 0] }, 'asu centre 500');
add('12hi', { angle1: 10 * Math.PI / 180 }, 'angle 10');
add('12hi', { angle1: 45 * Math.PI / 180 }, 'angle 45');
add('20hi', { angle1: 10 * Math.PI / 180 }, 'angle 10');
add('20hi', { angle1: 45 * Math.PI / 180 }, 'angle 45');
add('20hi', { bbD: 0.1, bbShaft: 0.05 }, 'bb tiny');
add('20hi', { bbD: 0.6, bbShaft: 0.4 }, 'bb big');
add('12hi', { irD: 0.9 }, 'ir huge');
add('20hi', { ir2D: 0.08 }, 'ir2 small');
add('20hi', { h0: 0.00005, reduction: 0.3, backTension: 200e6, frontTension: 200e6 }, 'foil hi tension');
add('2hi', { width: 1.6, wrD: 0.3 }, '2hi thin wide');

const only = process.argv[2];
const onlyList = process.argv[3] ? process.argv[3].split(';') : null;
let bad = 0;
const hasNaN = (a) => { for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) return true; return false; };
for (const c of cases) {
  if (only && !(c.mill + ' ' + c.tag).includes(only)) continue;
  if (onlyList && !onlyList.includes(c.mill + ' ' + c.tag)) continue;
  const p = defaultParams(c.mill); Object.assign(p, c.patch);
  let sv, err = null, it = 0, t0 = performance.now();
  try {
    sv = new StackSolver(p);
    for (let f = 0; f < (+process.env.FRAMES || 50); f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  } catch (e) { err = e.message; }
  const ms = performance.now() - t0;
  const R = sv?.result;
  const problems = [];
  if (err) problems.push('THROW ' + err);
  else {
    if (!R.converged) problems.push('noconv res=' + R.residual.toExponential(1) + ' step=' + (R.stepMax).toExponential(1));
    if (!Number.isFinite(R.force)) problems.push('force ' + R.force);
    for (const k of ['h1', 'q', 'flat', 'dEps', 'manifest', 'sigmaF']) { const a = R[k]; let n = 0; for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i]) && Number.isFinite(R.h0[i])) n++; if (n) problems.push(`NaN ${k}×${n}`); }
    // every solved roll, the lower half's too when the stack has one
    for (const r of sv.rolls) { let n = 0; for (let s = r.ia; s <= r.ib; s++) if (!Number.isFinite(r.v[s])) n++; if (n) problems.push(`NaN ${r.def.id}.v×${n}`); }
    for (const cc of R.contacts) if (hasNaN(cc.q)) problems.push('NaN contact q');
    if (![R.crown, R.wedge, R.edgeDropL, R.latentIU, R.manifestIU, R.screw].every(Number.isFinite)) problems.push('NaN stats');
    if (R.force < 0) problems.push('negative force');
    if (p.mode === 'gauge' && Math.abs(R.h1Mean / (p.h0 * (1 - p.reduction)) - 1) > 0.01) problems.push('gauge miss ' + (R.h1Mean * 1e6).toFixed(1));
  }
  const flag = problems.length ? 'FAIL' : 'ok  ';
  if (problems.length) bad++;
  console.log(`${flag} ${c.mill.padEnd(4)} ${c.tag.padEnd(20)} it=${String(it).padStart(4)} ${ms.toFixed(0).padStart(5)}ms` + (R ? ` F=${(R.force / TONF).toFixed(0).padStart(5)} S=${(R.screw * 1e3).toFixed(2).padStart(6)} cr=${(R.crown * 1e6).toFixed(0).padStart(5)} lat=${R.latentIU.toFixed(0).padStart(6)}` : '') + (problems.length ? '  ' + problems.join('; ') : '') + (R && R.warnings.length ? '  WARN[' + R.warnings.join(',') + ']' : ''));
}
console.log('FAILS', bad, '/', cases.length);
