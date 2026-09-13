// Radial grading of the roll mesh: the geometric core really is geometric, and the
// growth the mesh hint reports is the grading the mesh has.
//
//   node tools/sim2d/mesh.mjs [older build dir]     (exit 1 on FAIL)
//
// With an older build it also lists, per case, how far the radii moved.
import { defaultParams } from './params.mjs';
import { radialStations } from './build/sim/mesh.js';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};
const before = process.argv[2] ? await import(`${process.argv[2]}/sim/mesh.js`) : null;

// the same arguments solver.ts hands buildRollMesh, for the default roll
const p = defaultParams();
const Rhub = p.R * p.hubRatio;
// skin thicknesses around what the auto skin gives on the presets (it follows the arc)
const cases = [];
for (const nr of [4, 5, 6, 7, 8, 10]) for (const tSkin of [0.0024, 0.0061, 0.02]) cases.push({ nr, tSkin });

let seriesWorst = 0, seriesWhere = '', growthBad = [], monoBad = [];
for (const { nr, tSkin } of cases) {
  const { r, growth } = radialStations(Rhub, p.R, nr, p.rollRadialGrade, tSkin, p.rollSkinRings);
  const w = Array.from({ length: nr }, (_, j) => r[j + 1] - r[j]);
  if (!(r[0] === Rhub && r[nr] === p.R && w.every((x) => x > 0))) monoBad.push(`nr ${nr} tSkin ${tSkin}`);
  let g = 1;
  for (let j = 0; j + 1 < nr; j++) g = Math.max(g, w[j] / w[j + 1]);
  if (Math.abs(g / growth - 1) > 1e-12) growthBad.push(`nr ${nr} tSkin ${tSkin}: reported ${growth} actual ${g}`);
  // geometric core: every core ring (skin outwards excluded) keeps one ratio
  const nSkin = Math.max(0, Math.min(nr - 1, Math.round(p.rollSkinRings)));
  const nCore = nr - nSkin, hSkin = tSkin / nSkin;
  if (nCore >= 2 && hSkin < (p.R - tSkin - Rhub) / nCore) {
    const q = w[nCore - 2] / w[nCore - 1];
    for (let j = 0; j + 1 < nCore; j++) {
      const e = Math.abs(w[j] / w[j + 1] / q - 1);
      if (e > seriesWorst) { seriesWorst = e; seriesWhere = `nr ${nr} tSkin ${tSkin} ring ${j}`; }
    }
  }
  if (before) {
    const old = before.radialStations(Rhub, p.R, nr, p.rollRadialGrade, tSkin, p.rollSkinRings);
    let d = 0;
    for (let j = 0; j <= nr; j++) d = Math.max(d, Math.abs(old.r[j] - r[j]));
    console.log(`      nr ${String(nr).padStart(2)} skin ${(tSkin * 1e3).toFixed(1)} mm: growth before ${old.growth.toFixed(2)} now ${growth.toFixed(2)}, radii moved ${(d * 1e3).toFixed(3)} mm`);
  }
}
check('radii from hub to barrel, every ring positive', monoBad.length === 0, monoBad.join('; '));
check('reported growth = largest adjacent width ratio', growthBad.length === 0, growthBad.slice(0, 3).join('; '));
check('geometric core keeps one ratio down to the hub', seriesWorst <= 1e-9, `worst ${seriesWorst.toExponential(2)} ${seriesWorst > 1e-9 ? seriesWhere : ''}`);

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
