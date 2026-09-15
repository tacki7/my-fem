// The roll model against FrontISTR's solution of the same roll under the same strip load:
//   node tools/frontistr/compare.mjs [dir]
// Reads reference.json (case.mjs) and roll.res.0.1 (fistr1) and prints, per station, the
// deflection of the axis relative to the bearing and the surface indentation under the strip
// (the surface node's displacement toward the axis, less the axis's own), both models.
import { readFileSync } from 'node:fs';
const dir = process.argv[2] ?? new URL('run/2hi', import.meta.url).pathname;
const ref = JSON.parse(readFileSync(`${dir}/reference.json`, 'utf8'));
const res = parseRes(readFileSync(`${dir}/roll.res.0.1`, 'utf8'));
const um = (v) => (v * 1e6).toFixed(1).padStart(8);
const disp = (n) => res.node.get(n).DISPLACEMENT;
// the bearing's axis node: the reference for the beam's deflection
const iB = ref.x.findIndex((x) => Math.abs(x - ref.roll.Ls / 2) < 1e-9);
const vB = disp(ref.nodes.axis[iB])[1];
console.log(`${ref.mill}: F ${(ref.force / 9806.65).toFixed(1)} tonf, quarter load ${(ref.loadSumY / 9806.65).toFixed(2)} tonf; FEM ${ref.mesh.nodes} nodes`);
if (res.node.get(ref.nodes.bearing[0]).REACTION) {
  let ry = 0; for (const n of ref.nodes.bearing) ry += res.node.get(n).REACTION[1];
  console.log(`  bearing reaction (FEM) ${(ry / 9806.65).toFixed(2)} tonf against the quarter load ${(ref.loadSumY / 9806.65).toFixed(2)}`);
}
// The flattening the roll model reports is the local indentation under the strip. In the
// solid, the bottom surface also moves against the axis by the bending's transverse (Poisson)
// strain, −ν κ R²/2, the same for the top and the bottom surface; so the local indentation is
// read as the bottom surface's rise against the top surface's, which cancels that term (on a
// 2Hi the top carries nothing). Both readings are printed.
console.log('    x [mm]   q [kN/mm]   b [mm] | axis v − v(bearing) [µm]: model    FEM    diff | flattening [µm]: model  FEM bottom−top  diff  (bottom−axis)');
let worstV = 0, worstF = 0, worstVrel = 0;
for (let i = 0; i < ref.x.length; i++) {
  const a = disp(ref.nodes.axis[i]), s = disp(ref.nodes.bottom[i]), t = disp(ref.nodes.top[i]);
  const vF = a[1] - vB;                 // the axis, relative to the bearing
  const flatF = s[1] - t[1];            // the bottom surface's rise against the top's
  const flatA = s[1] - a[1];            // … and against the axis (bending's Poisson term included)
  const vM = ref.v[i], fM = ref.flat[i];
  const q = ref.q[i], b = ref.b[i];
  const line = `${(ref.x[i] * 1e3).toFixed(1).padStart(9)} ${q === null ? '        —' : (q / 1e6).toFixed(3).padStart(9)} ${b === null ? '      —' : (b * 1e3).toFixed(2).padStart(7)} | ${vM === null ? '       —' : um(vM)} ${um(vF)} ${vM === null ? '       —' : um(vF - vM)} | ${fM === null ? '       —' : um(fM)} ${um(flatF)} ${fM === null ? '       —' : um(flatF - fM)}  (${um(flatA)})`;
  console.log(line);
  if (vM !== null) { worstV = Math.max(worstV, Math.abs(vF - vM)); if (Math.abs(vM) > 1e-4) worstVrel = Math.max(worstVrel, Math.abs(vF - vM) / Math.abs(vM)); }
  if (fM !== null && q > 0) worstF = Math.max(worstF, Math.abs(flatF - fM));
}
console.log(`max |diff|: deflection ${(worstV * 1e6).toFixed(1)} µm (${(worstVrel * 100).toFixed(1)} % of the model's where |v| > 100 µm), flattening ${(worstF * 1e6).toFixed(1)} µm`);

/** the fstrresult 2.0 text: per node, the labelled vectors */
function parseRes(text) {
  const L = text.split('\n');
  let i = L.indexOf('*data') + 1;
  const [nn] = L[i++].split(/\s+/).filter(Boolean).map(Number);
  const [nNodeTypes] = L[i++].split(/\s+/).filter(Boolean).map(Number);
  const sizes = L[i++].split(/\s+/).filter(Boolean).map(Number);
  const labels = [];
  for (let k = 0; k < nNodeTypes; k++) labels.push(L[i++].trim());
  const per = sizes.reduce((a, b) => a + b, 0);
  const node = new Map();
  for (let n = 0; n < nn; n++) {
    const id = Number(L[i++].trim());
    const vals = [];
    while (vals.length < per) vals.push(...L[i++].split(/\s+/).filter(Boolean).map(Number));
    const rec = {};
    let o = 0;
    labels.forEach((lab, k) => { rec[lab] = vals.slice(o, o + sizes[k]); o += sizes[k]; });
    node.set(id, rec);
  }
  return { node, labels };
}
