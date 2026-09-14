// The shown elongation profile (`Result3D.profile`, from which `latentIU` and `manifestIU` are
// taken) is continuous as the strip widens:
//
//   node tools/build-esm.mjs sim3d && node tools/sim3d/edgeprofile.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. Across the width at which a slice comes onto the strip (an even grid, the strip edge passing a
//    cell boundary), the latent and manifest flatness and the profile's edge value move by steps like
//    their neighbours': no step over four times the median step (and 20 I-units). Read at the slices,
//    a 2Hi at 81 stations jumped 433 I-units there against a median step of 6, a 20Hi 321 against 20.
//    The sweep has to cross the birth for this to say anything, so the slice count is held to change.
// 2. The profile is the slices' own smoothing: at the stations of a grid whose cells tile the strip it
//    matches `dEps` and `manifest` to the smoothing's tails (under 1 % of the latent flatness), and its
//    peak-to-peak and largest wave are `latentIU` and `manifestIU`.
//
// @check
// @check-build sim3d
import { defaultParams } from './build/stack.js';
import { solve } from './audit-lib.mjs';

let failed = 0;
function report(ok, name, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ── 1. continuity across a slice's birth ────────────────────────────────────
for (const [label, mill, patch, w0, step, count] of [
  ['2Hi, 81 stations', '2hi', { stations: 81 }, 1.0235, 0.00005, 13],
  ['20Hi, 81 stations', '20hi', { stations: 81 }, 1.0265, 0.00025, 11],
]) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const width = +(w0 + i * step).toFixed(7);
    const { sv } = solve({ ...defaultParams(mill), ...patch, width }, 3000);
    const R = sv.result;
    const edge = R.profile ? R.profile.latent[R.profile.latent.length - 1] : R.dEps[sv.slices[sv.slices.length - 1].s];
    rows.push({ width, n: sv.slices.length, lat: R.latentIU, man: R.manifestIU, edge: edge * 1e5, conv: R.converged });
  }
  const born = rows[0].n !== rows[rows.length - 1].n;
  report(born && rows.every((r) => r.conv), `${label}: the sweep crosses a slice's birth, every width converged`, `slices ${rows[0].n} → ${rows[rows.length - 1].n} over ${(rows[0].width * 1e3).toFixed(2)}–${(rows[rows.length - 1].width * 1e3).toFixed(2)} mm`);
  for (const [key, name] of [['lat', 'latent flatness'], ['man', 'manifest flatness'], ['edge', 'profile edge value']]) {
    const steps = rows.slice(1).map((r, i) => Math.abs(r[key] - rows[i][key]));
    const sorted = [...steps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const worst = Math.max(...steps), at = rows[steps.indexOf(worst) + 1].width;
    const limit = Math.max(4 * median, 20);
    report(worst <= limit, `${label}: ${name} has no step`, `largest step ${worst.toFixed(1)} IU at ${(at * 1e3).toFixed(2)} mm, median ${median.toFixed(1)}, limit ${limit.toFixed(1)}`);
  }
}

// ── 2. the profile is the slices' smoothing ────────────────────────────────
{
  const p = { ...defaultParams('4hi'), stations: 81, stripStations: 141 };
  const { sv } = solve(p, 3000);
  const R = sv.result, P = R.profile;
  let dLat = 0, dWave = 0, matched = 0;
  for (const s of sv.slices) {
    const k = P.x.indexOf(sv.x[s.s]);
    if (k < 0) continue;
    matched++;
    dLat = Math.max(dLat, Math.abs(P.latent[k] - R.dEps[s.s]) * 1e5);
    dWave = Math.max(dWave, Math.abs(P.wave[k] - R.manifest[s.s]) * 1e5);
  }
  let lo = Infinity, hi = -Infinity, wmax = 0;
  for (let k = 0; k < P.x.length; k++) { lo = Math.min(lo, P.latent[k]); hi = Math.max(hi, P.latent[k]); wmax = Math.max(wmax, P.wave[k]); }
  const tol = 0.01 * R.latentIU;
  report(matched === sv.slices.length && P.x.length === matched + 2 && dLat <= tol && dWave <= tol,
    '4Hi, 141 strip stations: the profile at the stations is dEps and manifest to the smoothing tails',
    `${matched} stations + 2 edges, max |latent − dEps| ${dLat.toFixed(2)} IU, max |wave − manifest| ${dWave.toFixed(2)} IU, limit ${tol.toFixed(1)}`);
  report(Math.abs((hi - lo) * 1e5 - R.latentIU) < 1e-9 && Math.abs(wmax * 1e5 - R.manifestIU) < 1e-9 && P.x[0] === -p.width / 2 && P.x[P.x.length - 1] === p.width / 2,
    '4Hi, 141 strip stations: latentIU and manifestIU are the profile\'s, which ends on the strip edges',
    `p-p ${((hi - lo) * 1e5).toFixed(1)} / ${R.latentIU.toFixed(1)}, wave ${(wmax * 1e5).toFixed(1)} / ${R.manifestIU.toFixed(1)} IU`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
