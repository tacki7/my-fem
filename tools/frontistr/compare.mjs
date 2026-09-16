// The roll model against FrontISTR's solution of the same rolls under the same strip load:
//   node tools/frontistr/compare.mjs [dir]
// Reads reference.json (case.mjs) and the last roll.res.0.N (fistr1) and prints, per station
// of the work roll: every roll's axis deflection against the held bearing, every contact's
// line load, and the indentation under the strip (2Hi) or the exit profile the strip would
// see (with contacts). What each column is, and how it is read, is in lib.mjs
// (`compareStack`).
import { readFileSync } from 'node:fs';
import { readResult, compareStack, TONF } from './lib.mjs';
const dir = process.argv[2] ?? new URL('run/2hi', import.meta.url).pathname;
const ref = JSON.parse(readFileSync(`${dir}/reference.json`, 'utf8'));
const { resFile, res } = readResult(dir);
const C = compareStack(ref, res);
const um = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '       —' : (v * 1e6).toFixed(1).padStart(8));
const kn = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '       —' : (v / 1e6).toFixed(2).padStart(8));
const mm = (v) => (v * 1e3).toFixed(1).padStart(8);
const trio = (m, f, fmt) => `${fmt(m)} ${fmt(f)} ${m === null || f === null ? '       —' : fmt(f - m)}`;
const share = ref.full ? 'half' : 'quarter';
console.log(`${ref.mill}: F ${(ref.force / TONF).toFixed(1)} tonf, ${share} strip load ${(ref.loadSumY / TONF).toFixed(2)} tonf; FEM ${C.mesh.map((m) => `${m.name} ${m.nodes}`).join(' + ')} nodes (${resFile})`);
console.log(`  bearing reaction (FEM) ${(C.bearingReaction / TONF).toFixed(2)} tonf against the ${share} load ${(ref.loadSumY / TONF).toFixed(2)}`);
// one row per work-roll station; the other rolls' values looked up by x
const atX = (xs, arr, x) => { const i = xs.findIndex((v) => Math.abs(v - x) < 1e-9); return i < 0 ? null : arr[i]; };
const head = ['    x [mm]', ...C.rolls.map((r) => `| ${r.id} axis [µm]: model    FEM    diff`), ...C.contacts.map((k) => `| ${k.label} q [kN/mm]: model    FEM    diff`),
  ...(C.flat ? ['| flattening [µm]: model  FEM(bottom−top)  diff'] : []), ...(C.exit ? ['| exit profile Δh₁/2 [µm]: model    FEM    diff'] : [])];
console.log(head.join(' '));
for (let i = 0; i < C.x.length; i++) {
  const x = C.x[i];
  const cols = [mm(x)];
  for (const r of C.rolls) cols.push(`| ${trio(atX(r.x, r.vModel, x), atX(r.x, r.vFem, x), um)}`);
  for (const k of C.contacts) cols.push(`| ${trio(atX(k.x, k.qModel, x), atX(k.x, k.qFem, x), kn)}`);
  if (C.flat) cols.push(`| ${trio(C.flat.model[i], C.flat.fem[i], um)}`);
  if (C.exit) cols.push(`| ${trio(C.exit.model[i], C.exit.fem[i], um)}`);
  console.log(cols.join(' '));
}
const pct = (w) => `${(w.rel * 100).toFixed(1)} %`;
console.log(`max |diff| (and against the model's largest): ${C.rolls.map((r) => `${r.id} axis ${(r.worst.abs * 1e6).toFixed(1)} µm (${pct(r.worst)})`).join(', ')}`
  + C.contacts.map((k) => `, ${k.label} load ${(k.worst.abs / 1e6).toFixed(2)} kN/mm (${pct(k.worst)}, whole cells on both barrels)`).join('')
  + (C.flat ? `, flattening ${(C.flat.worst.abs * 1e6).toFixed(1)} µm (under the strip)` : '')
  + (C.exit ? `, exit profile ${(C.exit.worst.abs * 1e6).toFixed(1)} µm` : ''));
