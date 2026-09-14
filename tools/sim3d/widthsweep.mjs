// Strip width sweep across the station grid. A slice comes onto the strip
// where the strip edge crosses a cell boundary; the edge results should move
// through that width smoothly, the way the slab model's do.
//   node tools/sim3d/widthsweep.mjs <mill> <stripModel> <W0 mm> <W1 mm> <step mm> ['{"param":value}']
//   e.g. node tools/sim3d/widthsweep.mjs 4hi fem 990 1040 2.5 '{"stations":81}'   (a 4Hi slice comes on at 1028.75 mm)
//   with '{"stripStations":129}' the strip is tiled by its own cells at every width, and no slice comes on
// Per width: slices, the edge slice's width on the strip, force, C25, edge
// drop, latent / manifest flatness, and the integral of the elongation
// differences over the left half; then each quantity's range and its largest
// change between neighbouring widths.
import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const TONF = 9.80665e3;
const [mill = '4hi', model = 'fem', W0 = '990', W1 = '1040', dW = '2.5', patch = '{}'] = process.argv.slice(2);
const rows = [];
for (let Wmm = +W0; Wmm <= +W1 + 1e-9; Wmm += +dW) {
  const p = { ...defaultParams(mill), stripModel: model, ...JSON.parse(patch), width: Wmm / 1e3 };
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 400; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  const R = sv.result, sl = sv.slices, m = sl.length >> 1;
  let integral = 0;
  for (let i = 0; i < m; i++) integral += (R.dEps[sl[i].s] - R.dEps[sl[m].s]) * 1e5 * sl[i].weight * 1e3;
  const r = {
    W: Wmm, n: sl.length, w0: sl[0].weight * 1e3, F: R.force / TONF, C25: R.crown * 1e6, ED: R.edgeDropL * 1e6,
    lat: R.latentIU, man: R.manifestIU, integral, conv: R.converged, it,
  };
  rows.push(r);
  console.log(`W ${Wmm.toFixed(2).padStart(8)} slices ${r.n} edge ${r.w0.toFixed(1).padStart(4)} mm | F ${r.F.toFixed(1)} C25 ${r.C25.toFixed(1)} edge drop ${r.ED.toFixed(1)} µm | latent ${r.lat.toFixed(0)} manifest ${r.man.toFixed(0)} I | ∫Δε ${r.integral.toFixed(0)} I·mm | ${r.conv ? '' : 'NOCONV '}${it} it`);
}
const span = (k, d) => {
  const v = rows.map((r) => r[k]);
  let step = 0;
  for (let i = 1; i < v.length; i++) step = Math.max(step, Math.abs(v[i] - v[i - 1]));
  return `${k} ${Math.min(...v).toFixed(d)}–${Math.max(...v).toFixed(d)} (largest step ${step.toFixed(d)})`;
};
console.log([span('C25', 1), span('ED', 1), span('lat', 0), span('integral', 0)].join(' | '));
