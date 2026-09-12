import { StackSolver } from './build/solver.js';
import { defaultParams } from './build/stack.js';
const patch = JSON.parse(process.argv[2] ?? '{}');
for (const m of (process.argv[3] ?? '2hi,4hi,6hi,12hi,20hi').split(',')) {
  const p = defaultParams(m); Object.assign(p, patch); const sv = new StackSolver(p);
  const t0 = performance.now(); let it = 0;
  for (let f = 0; f < 400; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged || performance.now() - t0 > 20000) break; }
  const ms = performance.now() - t0; const R = sv.result;
  console.log(`| ${m} | ${(p.h0*1e3).toFixed(2)} → ${(R.h1Mean*1e3).toFixed(3)} | ${(R.force/9806.65).toFixed(0)} | ${(R.screw*1e3).toFixed(3)} | ${(R.crown*1e6).toFixed(0)} | ${(R.edgeDropL*1e6).toFixed(0)} | ${R.latentIU.toFixed(0)} / ${R.manifestIU.toFixed(0)} | ${R.dof} / ${R.bandwidth} | ${it} | ${(ms/it).toFixed(1)} | ${R.converged ? 'conv' : 'NOCONV res=' + R.residual.toExponential(1)} ${R.warnings.join(',')}`);
}
