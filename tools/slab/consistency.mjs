// Two places the slab numbers could quietly disagree with themselves.
//
//   node tools/slab/consistency.mjs      (exit 1 on FAIL)
//
// 1. Orowan's neutral point against its own branches: at the exit plane when the
//    entry branch is under the exit one from the start, at the entry plane when the
//    two never cross, between the two samples that bracket the crossing otherwise.
// 2. RollingSim.slabMethod without the app's hook (a headless solver) against
//    slab.ts Kármán at the same radius.
//
// @check
// @check-build slab
import { orowanBranches } from './build/sim/slab.js';
import { slabLoad } from './build/sim/muinv.js';
import { RollingSim } from './build/sim/solver.js';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed++;
};

const base = {
  Eroll: 2.1e11, nuRoll: 0.30, rollCoupling: true, flattening: 'hitchcock',
  lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255, heatOn: true, tempEntry: 20, tempMelt: 1500, softenExp: 1.0,
};

// --- 1 -----------------------------------------------------------------------
const kinds = { exit: 0, entry: 0, crossing: 0 };
let bad = [];
for (const R of [0.1, 0.19])
  for (const red of [0.05, 0.15, 0.3])
    for (const [sb, sf] of [[0, 0], [0, 150e6], [0, 300e6], [0, 500e6], [150e6, 0], [300e6, 0], [100e6, 100e6]])
      for (const mu of [0.005, 0.02, 0.06, 0.15, 0.4]) {
        const c = { h0: 0.002, h1: 0.002 * (1 - red), R, backTension: sb, frontTension: sf, entryStrain: 0 };
        const { N, dphi, phi0, pE, pI, phin } = orowanBranches({ ...base, slabTheory: 'orowan' }, c, mu, 1.3 * R);
        let first = -1;
        for (let i = 0; i <= N; i++) if (pE[i] >= pI[i]) { first = i; break; }
        const tag = `R${R} r${red} σ${sb / 1e6}/${sf / 1e6} mu ${mu}`;
        if (first === 0) { kinds.exit++; if (phin !== 0) bad.push(`${tag}: exit plane expected, phin ${phin}`); }
        else if (first < 0) { kinds.entry++; if (phin !== phi0) bad.push(`${tag}: entry plane expected, phin/phi0 ${phin / phi0}`); }
        else {
          kinds.crossing++;
          if (!(phin >= (first - 1) * dphi && phin <= first * dphi)) bad.push(`${tag}: phin ${phin} outside [${(first - 1) * dphi}, ${first * dphi}]`);
        }
      }
check('Orowan neutral point matches its branches', bad.length === 0,
  `${kinds.exit} at the exit, ${kinds.entry} at the entry, ${kinds.crossing} crossing${bad.length ? '; ' + bad.slice(0, 3).join('; ') : ''}`);
check('the no-crossing case is exercised', kinds.entry > 0, `${kinds.entry} passes`);

// --- 2 -----------------------------------------------------------------------
let worst = 0, where = '';
for (const [sb, sf] of [[0, 0], [30e6, 60e6], [200e6, 100e6]])
  for (const mu of [0.02, 0.06, 0.2])
    for (const entryStrain of [0, 0.4]) {
      const params = { ...base, slabTheory: 'karman', R: 0.19, h0: 0.002, mu, backTension: sb, frontTension: sf };
      const stub = { params, entryStrain, h1Command: 0.0015, diag: { exitThickness: 0.00152, hitchcockR: 0.26 } };
      const got = RollingSim.prototype.slabMethod.call(stub);
      const want = slabLoad(params, { h0: 0.002, h1: 0.00152, R: 0.19, backTension: sb, frontTension: sf, entryStrain }, mu, 0.26);
      for (const k of ['load', 'meanPressure', 'arc', 'kf']) {
        const e = Math.abs(got[k] / want[k] - 1);
        if (e > worst) { worst = e; where = `${k} σ${sb / 1e6}/${sf / 1e6} mu ${mu} ε0 ${entryStrain}: ${got[k]} vs ${want[k]}`; }
      }
    }
check('slabMethod without the hook = slab.ts Kármán', worst <= 1e-12, `worst relative difference ${worst.toExponential(2)} ${worst > 1e-12 ? where : ''}`);

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
