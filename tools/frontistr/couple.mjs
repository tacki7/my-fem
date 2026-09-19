// The pass with its rolls from FrontISTR, to the steady state (src/sim3d/coupling.ts):
//
//   node tools/build-esm.mjs sim3d
//   node tools/frontistr/couple.mjs [outdir] ['{"param":value}'] ['{"opt":value}']
//
// The roll model converges the pass; its load goes onto FrontISTR's solids (rollcase.mjs); the
// solids' work-roll surface against the model's becomes the correction δ(x) of the model's gap;
// the model converges again; … until δ and the load stop moving. A table of the rounds on stdout,
// and summary.json in outdir (each round's case in outdir/round-<k>/).
//
// Parameters: the 4Hi's defaults under the patch (the app's grid unless the patch says
// otherwise). Options: dxStrip, dxOff, mesh, substeps, solver ('CG' | 'DIRECT'), threads (4),
// maxRounds (8), relax (1), tolSurface [m], tolForce, fistr1.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRes } from './lib.mjs';
import { buildRollCase, readRollSurface } from './rollcase.mjs';

const B = new URL('../sim3d/build/', import.meta.url);

/** fistr1 in `dir` to its end; resolves with its output, rejects with the tail of it */
export function runFistr(dir, { fistr1 = process.env.FISTR1 ?? `${process.env.HOME}/.local/bin/fistr1`, threads = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(fistr1, [], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: String(threads), MallocPreScribble: '1' } });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      writeFileSync(`${dir}/fistr.log`, log);
      if (code === 0) resolve(log); else reject(Object.assign(new Error(`fistr1 exited ${code}`), { log: log.split('\n').slice(-20).join('\n') }));
    });
  });
}

/** the last result file of a case directory, parsed */
export function lastResult(dir) {
  const f = readdirSync(dir).filter((n) => /^roll\.res\.0\.\d+$/.test(n)).sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop())).pop();
  if (!f) throw new Error(`no result in ${dir}`);
  return parseRes(readFileSync(`${dir}/${f}`, 'utf8'));
}

/** the solver to convergence; the frames it took */
export function converge(sv, cap = 4000) {
  let f = 0;
  for (; f < cap; f++) { sv.advance(1e9, 6); if (sv.isConverged) break; }
  return f;
}

/** the numbers a round is judged by */
export function readings(sv) {
  const R = sv.result;
  return { force: R.force, screw: R.screw, h1Mean: R.h1Mean, h1Centre: R.h1Centre, crown: R.crown, edgeL: R.edgeDropL, latent: R.latentIU, manifest: R.manifestIU };
}

/**
 * The coupled solve: the rounds, each `onRound(row)` as it ends. Returns the rounds, the
 * uncoupled start and the steady end.
 */
export async function couple(sv, out, o = {}) {
  const { interpolateProfile, modelRollSurface, RollCoupling } = await import(new URL('coupling.js', B));
  const { radiusProfile } = await import(new URL('stack.js', B));
  const coupling = new RollCoupling(sv.ns, { relax: o.relax, tolSurface: o.tolSurface, tolForce: o.tolForce });
  const t0 = Date.now();
  converge(sv);
  const start = readings(sv);
  const rows = [];
  let converged = false;
  for (let k = 1; k <= (o.maxRounds ?? 8); k++) {
    const dir = `${out}/round-${k}`;
    const tr = Date.now();
    const ref = buildRollCase(sv, radiusProfile, dir, o);
    const log = await runFistr(dir, o);
    const surf = readRollSurface(ref, lastResult(dir));
    const fem = Float64Array.from(sv.x, (x, s) => (sv.result.q[s] > 0 ? interpolateProfile(surf.x, surf.v, x) : NaN));
    const model = modelRollSurface(sv);
    const r = coupling.step(model, fem, sv.result.force);
    const solveSec = Number(/solve \(sec\)\s*:\s*([\d.]+)/.exec(log)?.[1] ?? NaN);
    const row = { ...r, nodes: ref.nodes, fistrSec: solveSec, loadRatio: ref.loadSumY / ref.quarterForce, deltaCentre: coupling.delta[(sv.ns - 1) >> 1], deltaMax: Math.max(...Array.from(coupling.delta).map(Math.abs)) };
    if (!r.converged) {
      sv.setRollCorrection(coupling.delta);
      row.frames = converge(sv);
    }
    Object.assign(row, readings(sv), { seconds: (Date.now() - tr) / 1000 });
    rows.push(row);
    o.onRound?.(row);
    if (r.converged) { converged = true; break; }
  }
  const summary = { params: sv.p, opts: { ...o, onRound: undefined }, start, end: readings(sv), converged, rounds: rows, delta: Array.from(coupling.delta), x: Array.from(sv.x), seconds: (Date.now() - t0) / 1000 };
  writeFileSync(`${out}/summary.json`, JSON.stringify(summary));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? fileURLToPath(new URL('run/couple', import.meta.url));
  const patch = JSON.parse(process.argv[3] ?? '{}');
  const opts = JSON.parse(process.argv[4] ?? '{}');
  mkdirSync(out, { recursive: true });
  const { StackSolver } = await import(new URL('solver.js', B));
  const { defaultParams } = await import(new URL('stack.js', B));
  const sv = new StackSolver({ ...defaultParams('4hi'), ...patch });
  const um = (v) => (v * 1e6).toFixed(2);
  console.log('round  change µm  ΔF/F      F tonf    crown µm  edge µm  latent IU  δ centre µm  δ max µm  nodes   fistr s  round s');
  const s = await couple(sv, out, {
    ...opts,
    onRound: (r) => console.log(`${String(r.round).padStart(5)}  ${um(r.change).padStart(9)}  ${Number.isFinite(r.forceChange) ? r.forceChange.toExponential(2) : '   -    '}  ${(r.force / 9.80665e3).toFixed(1).padStart(8)}  ${um(r.crown).padStart(8)}  ${um(r.edgeL).padStart(7)}  ${r.latent.toFixed(0).padStart(9)}  ${um(r.deltaCentre).padStart(11)}  ${um(r.deltaMax).padStart(8)}  ${String(r.nodes).padStart(6)}  ${r.fistrSec.toFixed(0).padStart(7)}  ${r.seconds.toFixed(0).padStart(7)}${r.converged ? '  steady' : ''}`),
  });
  const a = s.start, b = s.end, pct = (x, y) => `${(((y - x) / Math.abs(x)) * 100).toFixed(2)} %`;
  console.log(`\n${s.converged ? 'steady' : 'NOT steady'} after ${s.rounds.length} rounds, ${s.seconds.toFixed(0)} s`);
  console.log(`uncoupled → coupled: F ${(a.force / 9.80665e3).toFixed(1)} → ${(b.force / 9.80665e3).toFixed(1)} tonf (${pct(a.force, b.force)}), crown ${um(a.crown)} → ${um(b.crown)} µm, edge drop ${um(a.edgeL)} → ${um(b.edgeL)} µm, latent ${a.latent.toFixed(0)} → ${b.latent.toFixed(0)} IU, screw ${(a.screw * 1e3).toFixed(4)} → ${(b.screw * 1e3).toFixed(4)} mm`);
  if (!s.converged) process.exit(1);
}
