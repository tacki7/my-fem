#!/usr/bin/env node
// A stand-in for fistr1, for trying the 3D tab's coupling with FrontISTR in seconds instead of
// minutes (tools/browser/qa3d.mjs --only=coupled). It solves nothing: in a `roll-coupled` case
// directory (tools/frontistr/rollcase.mjs) it writes result files the bridge reads as it reads
// FrontISTR's, with
//
//   - the work roll's bottom line displaced by the page's own model surface for the round (the
//     `record` the page sends with the job, kept in request.json) plus a small bump, so the
//     coupling steadies in two rounds: the first takes the bump as δ, the second finds nothing new
//   - every node moved with that line, and a made-up NodalMISES peaked under the contact lines
//     (for the contours)
//
// Run the dev server with it in fistr1's place (an absolute path: the bridge starts it in the
// job's directory):
//
//   FISTR1="$PWD/tools/frontistr/fake-fistr1.mjs" npm run dev -- --port <dev> --strictPort
//
// What it does is set, per job, by a JSON file named in FAKE_FISTR1_CONTROL (read when the job
// starts, so a harness can switch between jobs without restarting the server), or by the
// environment when there is no file:
//
//   mode     'ok' (default) | 'fail' (exit 3 after `at` result files) | 'nan' (NaN displacement
//            in result `at`) | 'hang' (stop after `at` files until killed)       FAKE_FISTR1_MODE
//   at       the result file the mode acts at (default 1)                          FAKE_FISTR1_AT
//   stepMs   pause after each result file [ms] (default 1500)                      FAKE_FISTR1_STEP_MS
//   bump     the bump's size [m] (default 3e-6)                                    FAKE_FISTR1_BUMP
//
// Each run appends a line to fake-fistr1.log in the case directory (what it did), and prints
// fistr1's " solve (sec) :" line at the end as couple.mjs reads it.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = process.env;
let ctl = {};
if (env.FAKE_FISTR1_CONTROL && existsSync(env.FAKE_FISTR1_CONTROL)) {
  try { ctl = JSON.parse(readFileSync(env.FAKE_FISTR1_CONTROL, 'utf8')); } catch { ctl = {}; }
}
const mode = String(ctl.mode ?? env.FAKE_FISTR1_MODE ?? 'ok');
const at = Number(ctl.at ?? env.FAKE_FISTR1_AT ?? 1);
const stepMs = Number(ctl.stepMs ?? env.FAKE_FISTR1_STEP_MS ?? 1500);
const bump = Number(ctl.bump ?? env.FAKE_FISTR1_BUMP ?? 3e-6);
const note = (m) => appendFileSync('fake-fistr1.log', `${new Date().toISOString()} ${m}\n`);
note(`start mode=${mode} at=${at} stepMs=${stepMs} bump=${bump} pid=${process.pid}`);
process.on('SIGTERM', () => { note('SIGTERM'); process.exit(143); });

const ref = JSON.parse(readFileSync('case.json', 'utf8'));
const req = existsSync('request.json') ? JSON.parse(readFileSync('request.json', 'utf8')) : {};
const halfW = ref.halfW;
// the page's model surface for this round, at its stations (x ≥ 0 read by |x|); none: a flat 0
const mx = req.record?.x ?? [], mv = req.record?.model ?? [];
const modelAt = (x) => {
  let best = NaN, bd = Infinity;
  for (let i = 0; i < mx.length; i++) {
    if (mv[i] === null || mv[i] === undefined) continue;
    const d = Math.abs(mx[i] - Math.abs(x));
    if (d < bd) { bd = d; best = mv[i]; }
  }
  return Number.isFinite(best) ? best : 0;
};
// the solids stack with their crowns at x = 0, the model with its nominal radii: the bridge
// takes `stackOffset` off what it reads (rollcase.mjs readRollSurface), so the stand-in puts it on
const surface = (x) => modelAt(x) + bump * ((Math.min(Math.abs(x), halfW) / halfW) ** 2 - 0.3) + (ref.stackOffset ?? 0);

// nodes: id, x, y, z (the case's own coordinates: the work roll's axis at y = 0)
const nodes = [];
let inNodes = false;
for (const raw of readFileSync('roll.msh', 'utf8').split('\n')) {
  const line = raw.trim();
  if (line.startsWith('!')) { inNodes = line.toUpperCase().startsWith('!NODE'); continue; }
  if (inNodes && line) { const [id, x, y, z] = line.split(',').map(Number); nodes.push([id, x, y, z]); }
}
const Rw = ref.wr.D / 2;
const N = Number(/SUBSTEPS=(\d+)/.exec(readFileSync('roll.cnt', 'utf8'))?.[1] ?? 2);

const write = async (k, lam, nan) => {
  const L = ['*fstrresult 2.0', '*comment', 'static_result', '*global', '1', '1 ', 'TOTALTIME', String(lam), '*data', `${nodes.length} 2`, '2 0', '3 1 ', 'DISPLACEMENT', 'NodalMISES'];
  for (const [id, x, y, z] of nodes) {
    const dy = nan ? NaN : lam * surface(x);
    const dB = Math.hypot(y + Rw, z), dT = Math.hypot(y - Rw, z);
    const onStrip = Math.abs(x) <= halfW ? 1 : 0.2;
    const m = lam * (420e6 * onStrip * Math.exp(-((dB / 0.009) ** 2)) + 650e6 * Math.exp(-((dT / 0.007) ** 2)) + 40e6);
    L.push(String(id), `0.0 ${nan ? 'NaN' : dy.toExponential(6)} 0.0 ${m.toExponential(6)}`);
  }
  // written in two halves, as a file that is still being written looks to the bridge
  const t = L.join('\n') + '\n', h = Math.floor(t.length / 2);
  writeFileSync(`roll.res.0.${k}`, t.slice(0, h));
  await sleep(150);
  appendFileSync(`roll.res.0.${k}`, t.slice(h));
  note(`wrote res.0.${k}${nan ? ' (NaN)' : ''}`);
};

const t0 = Date.now();
// FrontISTR writes the unloaded state first, then one file per load step
await write(0, 0, false);
await sleep(stepMs);
for (let k = 1; k <= N; k++) {
  await write(k, k / N, mode === 'nan' && k === at);
  if (mode === 'fail' && k === at) { note('exit 3'); console.log('FAKE fail'); process.exit(3); }
  // (a promise that never settles is not enough: with nothing else pending node ends the
  // program - exit 13, "unsettled top-level await" - and the job fails instead of hanging)
  if (mode === 'hang' && k === at) { note('hang'); setInterval(() => {}, 60000); await new Promise(() => {}); }
  await sleep(stepMs);
}
console.log(` solve (sec) : ${((Date.now() - t0) / 1000).toFixed(1)}`);
note('done');
