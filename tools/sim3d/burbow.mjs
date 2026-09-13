import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const TONF = 9.80665e3;
for (const [title, base] of [['出側板厚一定（既定）', {}], ['圧下位置固定 S=2.464 mm', { mode: 'screw', screw: 2.464e-3 }]]) {
  console.log('== ' + title);
  let first = null;
  for (const bend of [0, 60, 120]) {
    const p = defaultParams('4hi'); Object.assign(p, base, { wrBender: bend * TONF });
    const sv = new StackSolver(p);
    for (let f = 0; f < 3000; f++) { sv.advance(1e9, 6); if (sv.isConverged) break; }
    const R = sv.result, x = R.x, dx = x[1] - x[0];
    const [wr, bur] = R.rolls;
    const at = (roll, xx) => roll.v[Math.round((xx - x[0]) / dx)];
    const c = R.contacts[0];
    // contact force by bands across the barrel: centre |x|<0.4, middle 0.4-0.65, ends >0.65 (barrel half-length 0.8 m)
    let fc = 0, fm = 0, fe = 0, mom = 0;
    const halfSpan = bur.def.Ls / 2;
    for (let s = 0; s < x.length; s++) {
      const f = c.q[s] * c.weight[s], ax = Math.abs(x[s]);
      if (ax < 0.4) fc += f; else if (ax < 0.65) fm += f; else fe += f;
      // simply supported BUR: the centre moment from symmetric loads, sum over both halves of f (L/2 - |x|) / 2
      mom += 0.5 * f * Math.max(0, halfSpan - ax);
    }
    const r = {
      bend, F: R.force / TONF, contact: c.total / TONF,
      burBow: bur.bow * 1e6, burC: at(bur, 0) * 1e6, burEnd: at(bur, 0.8) * 1e6, burSup: bur.v[bur.supports[0]] * 1e6,
      wrBow: wr.bow * 1e6, fc: fc / TONF, fm: fm / TONF, fe: fe / TONF, mom: mom / 1e6,
    };
    if (!first) first = r;
    console.log(`  ベンダー ${String(bend).padStart(3)}: 板荷重 ${r.F.toFixed(0)} | WR-BUR 接触 ${r.contact.toFixed(0)} tonf（中央 |x|<0.4: ${r.fc.toFixed(0)}, 中間: ${r.fm.toFixed(0)}, 胴端 >0.65: ${r.fe.toFixed(0)}） | BUR 中央曲げモーメント ${r.mom.toFixed(2)} MN·m | BUR 曲がり ${r.burBow.toFixed(1)} µm（中央 ${r.burC.toFixed(0)}, 胴端 ${r.burEnd.toFixed(0)}, 支点 ${r.burSup.toFixed(0)}） | WR 曲がり ${r.wrBow.toFixed(1)} µm`);
  }
}
