import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const p = defaultParams(process.argv[2]); Object.assign(p, JSON.parse(process.argv[3] ?? '{}'));
const sv = new StackSolver(p);
for (let f = 0; f < +(process.argv[4] ?? 300); f++) sv.advance(1e9, 1);
const snap = () => ({ ratio: Array.from(sv.femRatio), eps: Array.from(sv.femEps), femEps: Array.from(sv.femResult.eps), q: sv.slices.map(s => s.q), h1: sv.slices.map(s => s.h1), arc: sv.slices.map(s => s.arc), sig: sv.slices.map(s => sv.sigmaF[s.s]) });
const snaps = [];
let last = sv.femLastChange;
for (let f = 0; f < 60 && snaps.length < 3; f++) { sv.advance(1e9, 1); if (sv.femLastChange !== last || f % 3 === 0) { snaps.push(snap()); last = sv.femLastChange; } }
const fmt = (a, k = 1, d = 3) => a.map(v => (v * k).toFixed(d).padStart(8)).join('');
for (const [j, s] of snaps.entries()) {
  console.log('snap', j);
  console.log('  ratio ', fmt(s.ratio));
  console.log('  epsOff', fmt(s.eps));
  console.log('  femEps', fmt(s.femEps));
  console.log('  q kN/mm', fmt(s.q, 1e-6, 2));
  console.log('  h1 um ', fmt(s.h1, 1e6, 1));
  console.log('  arc mm', fmt(s.arc, 1e3, 2));
  console.log('  sig MPa', fmt(s.sig, 1e-6, 0));
}
