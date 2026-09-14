// The interstand speed sensitivity keeps its stabilising sign.
//
//   node tools/sim2d/tension.mjs      (exit 1 on FAIL)
//
// dΔv/dT is rebuilt here from slab.ts (same construction as speedSensitivity) with its
// sign, over a grid of pairs of passes, and compared with what the library returns:
// the library's value must be −dΔv/dT where that is positive, NaN where it is not.
//
// @check
// @check-build sim2d
import { defaultParams } from './params.mjs';
import { slabPointAt } from './build/sim/slab.js';
import { speedSensitivity } from './build/sim/tension.js';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

const base = defaultParams();
let n = 0, nan = 0, zero = 0, positive = 0, mismatch = 0;
const ex = [];
for (const mu of [0.02, 0.04, 0.06, 0.1, 0.2, 0.3])
  for (const [h0u, h1u, h1d] of [[0.002, 0.0015, 0.00115], [0.002, 0.0018, 0.0016], [0.0006, 0.00045, 0.00035], [0.005, 0.0035, 0.0025]])
    for (const Rd of [0.15, 0.19, 0.3])
      for (const Tfrac of [0, 0.05, 0.2, 0.4, 0.6, 0.8]) {
        const up = { ...base, mu, h0: h0u, R: 0.19, backTension: 0 };
        const dn = { ...base, mu, h0: h1u, R: Rd, frontTension: 0 };
        const T = Tfrac * 900e6 * h1u; // tension force per width [N/m]
        const upRp = 1.4 * up.R, dnRp = 1.4 * dn.R;
        const dv = (t) => {
          const cu = { h0: up.h0, h1: h1u, R: up.R, backTension: 0, frontTension: t / h1u, entryStrain: 0 };
          const cd = { h0: dn.h0, h1: h1d, R: dn.R, backTension: t / dn.h0, frontTension: 0, entryStrain: 0.33 };
          const fu = slabPointAt({ ...up, slabTheory: 'blandford' }, cu, up.mu, upRp).forwardSlip;
          const fd = slabPointAt({ ...dn, slabTheory: 'blandford' }, cd, dn.mu, dnRp).forwardSlip;
          if (!Number.isFinite(fu) || !Number.isFinite(fd)) return NaN;
          return dn.omega * dn.R * ((1 + fd) * h1d / dn.h0) - up.omega * up.R * (1 + fu);
        };
        const dT = Math.max(0.05 * Math.abs(T), 1e5 * Math.min(h1u, dn.h0));
        const a = dv(T + dT), b = dv(Math.max(0, T - dT));
        const lib = speedSensitivity(up, h1u, upRp, 0, dn, h1d, dnRp, 0.33, T);
        n++;
        if (!Number.isFinite(a) || !Number.isFinite(b)) { nan++; if (!Number.isNaN(lib)) mismatch++; continue; }
        const slope = (a - b) / (T + dT - Math.max(0, T - dT));
        if (slope === 0) zero++;
        if (slope > 0) { positive++; if (ex.length < 3) ex.push(`mu ${mu} h ${h0u}->${h1u}->${h1d} Rd ${Rd} T/kfh ${Tfrac}: +${slope.toExponential(2)}`); }
        const want = slope < 0 ? -slope : NaN;
        if (!(Number.isNaN(want) ? Number.isNaN(lib) : Math.abs(lib / want - 1) <= 1e-12)) mismatch++;
      }
check('dΔv/dT never positive', positive === 0, `${n} pairs: ${n - nan - zero - positive} negative, ${zero} zero (neutral point pinned), ${nan} without a neutral point${ex.length ? '; ' + ex.join('; ') : ''}`);
check('speedSensitivity = −dΔv/dT where positive, NaN otherwise', mismatch === 0, `${mismatch} mismatches`);

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
