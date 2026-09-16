// The FrontISTR cross-check served to the app: a connect-style handler the Vite dev server
// mounts (vite.config.ts) and serve.mjs runs on its own.
//
//   GET  /__frontistr/ping             → { ok, fistr1, busy }   fistr1: the solver binary was found
//   POST /__frontistr/solve  { mill, params }
//        → the comparison (lib.mjs `compareStack`) as JSON, lengths in m, loads in N/m;
//          409 while another solve runs, 400 for a mill it cannot do (lib.mjs MILLS: 2Hi,
//          4Hi, 6Hi), 500 with the log's tail when fistr1 fails. Closing the request kills
//          the solve. The 2Hi is solved on the fine mesh (~10 s); the 4Hi and 6Hi, with their
//          contacts, on the coarser QUICK one (a few minutes).
//
// One solve at a time: fistr1 takes every core it can get. The case is written to
// tools/frontistr/run/app-<mill>/ (git-ignored) and left there, so it can be re-run by hand.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function frontistrHandler(opts = {}) {
  const fistr1 = opts.fistr1 ?? process.env.FISTR1 ?? `${process.env.HOME}/.local/bin/fistr1`;
  const runDir = opts.runDir ?? `${HERE}run`;
  let busy = false;

  const json = (res, code, body) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  /** run a command to its end; rejects with the last lines of its output */
  const run = (cmd, args, cwd, signal) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => reject(Object.assign(e, { log: out })));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(Object.assign(new Error(`${cmd} exited ${code}`), { log: out }))));
  });

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/__frontistr')) return next ? next() : json(res, 404, { error: 'not found' });
    const path = url.pathname.slice('/__frontistr'.length);
    if (req.method === 'GET' && path === '/ping') return json(res, 200, { ok: true, fistr1: existsSync(fistr1), busy });
    if (req.method !== 'POST' || path !== '/solve') return json(res, 404, { error: 'not found' });
    if (busy) return json(res, 409, { error: 'busy' });
    busy = true;
    const ctl = new AbortController();
    // the connection went before the answer: the app gave up (the request's own 'close' is
    // not that - it fires as soon as the body has been read)
    res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    const t0 = Date.now();
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const mill = body.mill ?? '2hi';
      if (!existsSync(fistr1)) return json(res, 500, { error: `fistr1 not found (${fistr1}); see tools/frontistr/README.md` });
      // the roll model as the app has it now: rebuilt from src/ each time (under a second)
      await run(process.execPath, ['tools/build-esm.mjs', 'sim3d'], ROOT, ctl.signal);
      const { buildCase, readResult, compareStack, MILLS, QUICK } = await import(new URL(`./lib.mjs?v=${Date.now()}`, import.meta.url));
      if (!MILLS[mill]) return json(res, 400, { error: `mill ${mill}: ${Object.keys(MILLS).join(', ')} are served` });
      const dir = `${runDir}/app-${mill}`;
      mkdirSync(dir, { recursive: true });
      // the app's settings on the gate's grid (81 stations, the strip on the roll's nodes, 8
      // elements along the arc): the app's 301 stations would make a 176k-node solid and a
      // minute's solve for the same answer. With contacts, the coarser mesh as well.
      const params = { ...(body.params && typeof body.params === 'object' ? body.params : {}), stations: 81, stripStations: 0, stripNz: 8 };
      const { ref, summary } = await buildCase(mill, params, dir, QUICK[mill] ?? {});
      const tCase = Date.now();
      const log = await run(fistr1, [], dir, ctl.signal);
      writeFileSync(`${dir}/fistr.log`, log);
      const { res: result, resFile } = readResult(dir);
      const cmp = compareStack(ref, result);
      const solve = /solve \(sec\)\s*:\s*([\d.]+)/.exec(log);
      json(res, 200, { ...cmp, summary, resFile, seconds: (Date.now() - t0) / 1000, caseSeconds: (tCase - t0) / 1000, solveSeconds: solve ? Number(solve[1]) : null });
    } catch (e) {
      if (ctl.signal.aborted) return; // the app gave up: nothing to answer
      const tail = typeof e.log === 'string' ? e.log.split('\n').slice(-20).join('\n') : '';
      json(res, 500, { error: e.message ?? String(e), log: tail });
    } finally {
      busy = false;
    }
  };
}

/** the case directory's reference, for a hand check after an app run */
export function readReference(dir) { return JSON.parse(readFileSync(`${dir}/reference.json`, 'utf8')); }
