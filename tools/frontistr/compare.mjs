// The roll model against FrontISTR's solution of the same rolls under the same strip load:
//   node tools/frontistr/compare.mjs [dir]
// Reads reference.json (case.mjs) and the last roll.res.0.N (fistr1) and prints, per station:
// 2Hi - the work roll's axis deflection against its bearing and the indentation under the
// strip; 4Hi - both rolls' axes against the backup roll's bearing, the work-roll/backup-roll
// contact line load, and the exit profile the strip would see (the work roll's bottom surface
// against its own at the centre).
//
// Indentation is read as the bottom surface's rise against the top surface's: in a solid the
// bending's transverse (Poisson) strain, −ν κ R²/2, moves both surfaces against the axis by the
// same amount, and that reading cancels it (the roll model's flattening is the local part only).
import { readFileSync } from 'node:fs';
import { readResult, compare2hi, TONF } from './lib.mjs';
const dir = process.argv[2] ?? new URL('run/2hi', import.meta.url).pathname;
const ref = JSON.parse(readFileSync(`${dir}/reference.json`, 'utf8'));
const { resFile, res } = readResult(dir);
const um = (v) => (v === null || v === undefined ? '       —' : (v * 1e6).toFixed(1).padStart(8));
const kn = (v) => (v === null || v === undefined ? '       —' : (v / 1e6).toFixed(2).padStart(8));
const mm = (v) => (v * 1e3).toFixed(1).padStart(8);
const disp = (n) => res.node.get(n).DISPLACEMENT;
const W = ref.WR;
console.log(`${ref.mill}: F ${(ref.force / TONF).toFixed(1)} tonf, quarter strip load ${(ref.loadSumY / TONF).toFixed(2)} tonf; FEM ${ref.mesh.map((m) => `${m.name} ${m.nodes}`).join(' + ')} nodes (${resFile})`);
const reaction = (nodes) => { let r = 0; for (const n of nodes) r += ((res.node.get(n).REACTION_FORCE ?? res.node.get(n).REACTION)?.[1] ?? 0); return r; };

if (ref.mill === '2hi') {
  const C = compare2hi(ref, res);
  console.log(`  bearing reaction (FEM) ${(C.bearingReaction / TONF).toFixed(2)} tonf against the quarter load ${(ref.loadSumY / TONF).toFixed(2)}`);
  console.log('    x [mm]   q [kN/mm]   b [mm] | axis v − v(bearing) [µm]: model    FEM    diff | flattening [µm]: model  FEM(bottom−top)  diff  (bottom−axis)');
  for (let i = 0; i < C.x.length; i++) {
    const vM = C.vModel[i], vF = C.vFem[i], fM = C.flatModel[i], fF = C.flatFem[i];
    console.log(`${mm(C.x[i])} ${kn(C.q[i])} ${C.b[i] === null ? '      —' : (C.b[i] * 1e3).toFixed(2).padStart(7)} | ${um(vM)} ${um(vF)} ${vM === null ? '       —' : um(vF - vM)} | ${um(fM)} ${um(fF)} ${fM === null ? '       —' : um(fF - fM)}  (${um(C.flatAxis[i])})`);
  }
  console.log(`max |diff|: deflection ${(C.worst.v * 1e6).toFixed(1)} µm (${(C.worst.vRel * 100).toFixed(1)} % of the model's where |v| > 100 µm), flattening ${(C.worst.flat * 1e6).toFixed(1)} µm`);
} else {
  const Bk = ref.BUR, C = ref.contact;
  const vBrg = disp(Bk.nodes.axis[Bk.iSupport])[1];
  console.log(`  backup-roll bearing reaction (FEM) ${(reaction(Bk.nodes.support) / TONF).toFixed(2)} tonf against the quarter strip load ${(ref.loadSumY / TONF).toFixed(2)}`);
  // the contact line load per work-roll station: the slave nodes' normal forces (the z ≥ 0 half of the patch) over the station's length, doubled
  const qF = W.x.map((_, i) => {
    const here = C.slaveByStation[i];
    if (!here) return null;
    let f = 0; for (const n of here) { const cf = res.node.get(n).CONTACT_NFORCE; if (cf) f += Math.abs(cf[1]); }
    return (2 * f) / W.dx[i];
  });
  // The exit profile the strip sees: half the exit gauge against its centre value, Δh₁/2. The
  // work roll's bottom surface is the axis less the barrel radius plus the indentation, so the
  // FEM's reading is its bottom node's displacement against the centre's, less the barrel's
  // radius deviation (geometry, which the displacement leaves out). The strip load sits on one
  // node ring per station here (cells 29 mm long, the contact patch 8 mm wide), so the FEM's
  // surface under a ring is a local dimple: read this column as a rough check only.
  const wb0 = disp(W.nodes.bottom[0])[1];
  console.log('    x [mm] | WR axis v − v(BUR bearing) [µm]: model    FEM    diff | BUR axis: model    FEM    diff | WR–BUR q [kN/mm]: model    FEM    diff | exit profile Δh₁/2 [µm]: model    FEM    diff');
  let worst = { wr: 0, bur: 0, q: 0, prof: 0 };
  for (let i = 0; i < Math.max(W.x.length, Bk.x.length); i++) {
    const cols = [mm(i < W.x.length ? W.x[i] : Bk.x[i])];
    if (i < W.x.length) {
      const a = disp(W.nodes.axis[i]), vF = a[1] - vBrg, vM = W.v[i];
      cols.push(`| ${um(vM)} ${um(vF)} ${vM === null ? '       —' : um(vF - vM)}`);
      if (vM !== null) worst.wr = Math.max(worst.wr, Math.abs(vF - vM));
    } else cols.push('|        —        —        —');
    if (i < Bk.x.length) {
      const a = disp(Bk.nodes.axis[i]), vF = a[1] - vBrg, vM = Bk.v[i];
      cols.push(`| ${um(vM)} ${um(vF)} ${vM === null ? '       —' : um(vF - vM)}`);
      if (vM !== null) worst.bur = Math.max(worst.bur, Math.abs(vF - vM));
    } else cols.push('|        —        —        —');
    if (i < W.x.length) {
      const qM = C.q[i], f = qF[i];
      cols.push(`| ${kn(qM)} ${kn(f)} ${qM === null || f === null ? '       —' : kn(f - qM)}`);
      if (qM !== null && f !== null && W.x[i] < ref.rolls.WR.Lb / 2) worst.q = Math.max(worst.q, Math.abs(f - qM));
      const h1 = W.h1[i], pM = h1 === null ? null : (h1 - W.h1[0]) / 2, pF = disp(W.nodes.bottom[i])[1] - wb0 - (W.prof[i] - W.prof[0]);
      cols.push(`| ${um(pM)} ${um(pF)} ${pM === null ? '       —' : um(pF - pM)}`);
      if (pM !== null) worst.prof = Math.max(worst.prof, Math.abs(pF - pM));
    }
    console.log(cols.join(' '));
  }
  console.log(`max |diff|: WR axis ${(worst.wr * 1e6).toFixed(1)} µm, BUR axis ${(worst.bur * 1e6).toFixed(1)} µm, contact load ${(worst.q / 1e6).toFixed(2)} kN/mm, exit profile ${(worst.prof * 1e6).toFixed(1)} µm`);
}
