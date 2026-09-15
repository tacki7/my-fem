// A FrontISTR case from the roll model's converged pass:
//   node tools/build-esm.mjs sim3d && node tools/frontistr/case.mjs [2hi|4hi] [outdir] ['{"param":value}']
// Writes roll.msh, roll.cnt, hecmw_ctrl.dat and reference.json into outdir (default
// tools/frontistr/run/<mill>). run.sh solves it, compare.mjs reads both. What the case is,
// and what it holds fixed, is in lib.mjs (`buildCase`).
import { buildCase } from './lib.mjs';

const mill = process.argv[2] ?? '2hi';
const out = process.argv[3] ?? new URL(`run/${mill}`, import.meta.url).pathname;
const patch = JSON.parse(process.argv[4] ?? '{}');
const { summary } = await buildCase(mill, patch, out);
console.log(summary);
