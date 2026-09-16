// A FrontISTR case from the roll model's converged pass:
//   node tools/build-esm.mjs sim3d && node tools/frontistr/case.mjs [2hi|4hi|6hi] [outdir] ['{"param":value}'] ['{"mesh":{...},"substeps":2}']
// Writes roll.msh, roll.cnt, hecmw_ctrl.dat and reference.json into outdir (default
// tools/frontistr/run/<mill>). run.sh solves it, compare.mjs reads both. What the case is,
// and what it holds fixed, is in lib.mjs (`buildCase`); the fourth argument is its `opts`
// (QUICK in lib.mjs is the coarser mesh the app uses for the 4Hi and 6Hi).
import { buildCase, QUICK } from './lib.mjs';

const mill = process.argv[2] ?? '2hi';
const out = process.argv[3] ?? new URL(`run/${mill}`, import.meta.url).pathname;
const patch = JSON.parse(process.argv[4] ?? '{}');
const opts = process.argv[5] === 'quick' ? (QUICK[mill] ?? {}) : JSON.parse(process.argv[5] ?? '{}');
const { summary } = await buildCase(mill, patch, out, opts);
console.log(summary);
