// @check
// @check-build sim3d
// The 2Hi case builder without FrontISTR: the roll model converges on the gate's grid, the
// mesh has the node count the README's result was read on, and the strip load put on the
// quarter roll is the model's F/4. Guards lib.mjs (what the app's bridge and case.mjs share);
// solving it needs fistr1 and is not a gate.
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCase, TONF } from './lib.mjs';

const out = mkdtempSync(join(tmpdir(), 'rollfem-fistr-'));
const t0 = performance.now();
const { ref, nodes, loadedNodes } = await buildCase('2hi', {}, out);
const ms = performance.now() - t0;
const fail = [];
const expect = (ok, what) => { if (!ok) fail.push(what); };
expect(ref.iterations > 0 && ref.iterations < 600, `iterations ${ref.iterations}`);
expect(nodes === 34099, `nodes ${nodes} (README: 34099 = 43 × 12 × 65)`);
expect(loadedNodes > 100, `loaded nodes ${loadedNodes}`);
const quarter = ref.force / 4;
expect(Math.abs(ref.loadSumY - quarter) / quarter < 2e-3, `quarter load ${(ref.loadSumY / TONF).toFixed(2)} vs F/4 ${(quarter / TONF).toFixed(2)} tonf`);
for (const f of ['roll.msh', 'roll.cnt', 'hecmw_ctrl.dat', 'reference.json']) expect(existsSync(join(out, f)) && statSync(join(out, f)).size > 0, `${f} written`);
// the model's own answer at the centre is what the README's table starts from
const v0 = ref.WR.v[0], f0 = ref.WR.flat[0];
expect(v0 > 2.5e-3 && v0 < 3.5e-3, `centre deflection ${(v0 * 1e6).toFixed(0)} µm (README 2982.9)`);
expect(f0 > 20e-6 && f0 < 60e-6, `centre flattening ${(f0 * 1e6).toFixed(1)} µm (README 37.3)`);
console.log(`2hi case: ${ref.iterations} iterations, F ${(ref.force / TONF).toFixed(1)} tonf, ${nodes} nodes, ${loadedNodes} loaded, quarter load ${(ref.loadSumY / TONF).toFixed(2)} tonf, ${ms.toFixed(0)} ms → ${out}`);
if (fail.length) { console.log('FAIL\n  ' + fail.join('\n  ')); process.exit(1); }
console.log('PASS');
