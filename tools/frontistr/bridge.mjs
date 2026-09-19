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
//   Jobs (jobs.mjs): a FrontISTR run whose intermediate results reach the app as they are
//   written, in the fieldframe format (fieldframe.mjs):
//   POST /__frontistr/jobs  { kind, params, load?, substeps?, dryRun? }
//        → { job } (its status), or 409 { running } while another job or a solve runs
//   GET  /__frontistr/jobs/<id>              → the status: state queued|meshing|running|done|failed|cancelled, frames, message
//   GET  /__frontistr/jobs/<id>/events       → server-sent events: state, mesh, frame { k }, progress
//   GET  /__frontistr/jobs/<id>/mesh.bin     → the surface
//   GET  /__frontistr/jobs/<id>/frames/<k>.bin → a result on it (k = 0 the initial state)
//   GET  /__frontistr/jobs/<id>/result.json  → what the kind reads off the finished case (roll-coupled: the WR surface)
//   POST /__frontistr/jobs/<id>/cancel       → stops the job's fistr1
//   kind `roll-elastic`: the 4Hi's work and backup rolls as solids in contact under the strip
//   load, on the coarser QUICK mesh, the load ramped over `substeps` (4) result files.
//   kind `roll-coupled`: the rolls under the load the app posts ({ params, load: { q, arc, force } }),
//   for the coupling; result.json holds the work roll's surface (rollcase.mjs).
//
// One solve at a time: fistr1 takes every core it can get. The case is written to
// tools/frontistr/run/app-<mill>/ (git-ignored) and left there, so it can be re-run by hand;
// a job's under run/jobs/<id>/.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJobs } from './jobs.mjs';

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

  /** the kinds of job this bridge can build a case for */
  const kinds = opts.kinds ?? {
    'roll-elastic': async (body, dir) => {
      await run(process.execPath, ['tools/build-esm.mjs', 'sim3d'], ROOT);
      const { buildCase, QUICK } = await import(new URL(`./lib.mjs?v=${Date.now()}`, import.meta.url));
      const params = { ...(body.params && typeof body.params === 'object' ? body.params : {}), stations: 81, stripStations: 0, stripNz: 8 };
      const substeps = Math.max(1, Math.min(20, Math.round(Number(body.substeps) || 4)));
      // `load` (the app's strip load per station) is passed on for a buildCase that takes it; one
      // that does not solves its own pass from `params`, as the cross-check does
      const { ref } = await buildCase('4hi', params, dir, { ...(QUICK['4hi'] ?? {}), substeps, load: body.load });
      // the von Mises stress at the nodes, for the rolls' stress contours
      const cnt = readFileSync(`${dir}/roll.cnt`, 'utf8');
      // (the case lists `NMISES, OFF`; a later line of the block wins, so it is that line that is turned on)
      const withMises = /^\s*NMISES\s*,\s*OFF\s*$/im.test(cnt) ? cnt.replace(/^\s*NMISES\s*,\s*OFF\s*$/im, ' NMISES, ON')
        : /^\s*NMISES\s*,\s*ON/im.test(cnt) ? cnt : cnt.replace(/^!OUTPUT_RES\s*$/m, '!OUTPUT_RES\n NMISES, ON');
      if (withMises !== cnt) writeFileSync(`${dir}/roll.cnt`, withMises);
      const wr = ref.rolls?.find((r) => r.id === 'WR');
      const p = ref.params ?? {};
      const h1 = (p.h0 ?? 0) * (1 - (p.reduction ?? 0));
      return {
        mesh: 'roll.msh', resPrefix: 'roll.res.0.', order: ['WR', 'BUR'], kinds: { WR: 'roll', BUR: 'roll' },
        symmetry: { x: true, y: true, z: true }, translate: [0, (wr?.D ?? 0) / 2 + h1 / 2, 0],
        source: { case: 'roll-elastic', mill: '4hi', force: ref.force, quarterForce: ref.quarterForce },
        threads: 4,
      };
    },
  };
  /**
   * `roll-coupled`: the rolls under the app's own converged load, for the coupling
   * (src/sim3d/coupling.ts, rollcase.mjs). The body carries the 3D tab's whole parameters and
   * `load: { q, arc, force }` per station of the solver those parameters build; the solver is
   * built here for its geometry only (stations, rolls, the flattening law), not solved. The
   * work roll's surface where the strip leaves it comes back as result.json { x, v }.
   */
  kinds['roll-coupled'] ??= async (body, dir) => {
    await run(process.execPath, ['tools/build-esm.mjs', 'sim3d'], ROOT);
    const v = Date.now();
    const { StackSolver } = await import(new URL(`../sim3d/build/solver.js?v=${v}`, import.meta.url));
    const { radiusProfile } = await import(new URL(`../sim3d/build/stack.js?v=${v}`, import.meta.url));
    const { buildRollCase, readRollSurface } = await import(new URL(`./rollcase.mjs?v=${v}`, import.meta.url));
    const { parseRes } = await import(new URL(`./lib.mjs?v=${v}`, import.meta.url));
    const params = body.params && typeof body.params === 'object' ? body.params : null;
    const load = body.load;
    if (!params || !load || !Array.isArray(load.q) || !Array.isArray(load.arc)) throw new Error('roll-coupled: { params, load: { q, arc, force } } expected');
    const sv = new StackSolver(params);
    if (load.q.length !== sv.ns || load.arc.length !== sv.ns) throw new Error(`roll-coupled: ${load.q.length} loads for ${sv.ns} stations - the parameters are not the ones the load was solved on`);
    const pass = {
      p: sv.p, x: sv.x, ns: sv.ns, stack: sv.stack, upper: sv.upper, rolls: sv.rolls, wsLaw: sv.wsLaw,
      result: { q: Float64Array.from(load.q, (q) => (q === null ? NaN : q)), arc: Float64Array.from(load.arc, (a) => (a === null ? NaN : a)), converged: true, force: Number(load.force) },
    };
    const ref = buildRollCase(pass, radiusProfile, dir, { substeps: Math.max(1, Math.min(20, Math.round(Number(body.substeps) || 2))), ...(body.mesh && typeof body.mesh === 'object' ? body.mesh : {}) });
    const h1 = params.h0 * (1 - params.reduction);
    return {
      mesh: 'roll.msh', resPrefix: 'roll.res.0.', order: ['WR', 'BUR'], kinds: { WR: 'roll', BUR: 'roll' },
      symmetry: { x: true, y: true, z: true }, translate: [0, ref.wr.D / 2 + h1 / 2, 0],
      source: { case: 'roll-coupled', mill: sv.stack.type, force: ref.force, nodes: ref.nodes, loadRatio: ref.loadSumY / ref.quarterForce },
      threads: 4,
      finish: (d) => {
        const f = readdirSync(d).filter((n) => /^roll\.res\.0\.\d+$/.test(n)).sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop())).pop();
        const surf = readRollSurface(ref, parseRes(readFileSync(`${d}/${f}`, 'utf8')));
        return { x: surf.x, v: surf.v, force: ref.force, nodes: ref.nodes, loadRatio: ref.loadSumY / ref.quarterForce };
      },
    };
  };
  const jobs = createJobs({ fistr1: opts.jobFistr1 ?? fistr1, fistr1Args: opts.jobFistr1Args ?? [], runDir, kinds, pollMs: opts.pollMs });

  /** the jobs' routes; true when it answered */
  async function jobRoute(req, res, path) {
    const m = /^\/jobs(?:\/([\w-]+)(?:\/(events|mesh\.bin|result\.json|frames\/(\d+)\.bin|cancel))?)?$/.exec(path);
    if (!m) return false;
    const [, id, sub, k] = m;
    if (!id) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST a job' }), true;
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'body: JSON' }), true; }
      if (!body.dryRun && !existsSync(opts.jobFistr1 ?? fistr1)) return json(res, 500, { error: `fistr1 not found (${fistr1}); see tools/frontistr/README.md` }), true;
      if (busy) return json(res, 409, { error: 'busy', running: { kind: 'solve' } }), true;
      try {
        const r = jobs.start(String(body.kind ?? 'roll-elastic'), body);
        return r.job ? json(res, 200, { job: r.job }) : json(res, 409, { error: 'busy', running: r.running }), true;
      } catch (e) {
        return json(res, e.status ?? 500, { error: e.message }), true;
      }
    }
    if (!sub) {
      const st = jobs.status(id);
      return (st ? json(res, 200, st) : json(res, 404, { error: 'no such job' })), true;
    }
    if (sub === 'cancel') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST' }), true;
      const st = jobs.cancel(id);
      return (st ? json(res, 200, st) : json(res, 404, { error: 'no such job' })), true;
    }
    if (sub === 'events') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const off = jobs.listen(id, (ev) => { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`); });
      if (!off) { res.write(`event: error\ndata: ${JSON.stringify({ error: 'no such job' })}\n\n`); return res.end(), true; }
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); off(); });
      return true;
    }
    const file = jobs.file(id, sub === 'mesh.bin' ? 'mesh' : sub === 'result.json' ? 'result' : k);
    if (!file) return json(res, 404, { error: 'not yet' }), true;
    res.statusCode = 200;
    res.setHeader('Content-Type', sub === 'result.json' ? 'application/json; charset=utf-8' : 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(file).pipe(res);
    return true;
  }

  return async function handler(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/__frontistr')) return next ? next() : json(res, 404, { error: 'not found' });
    const path = url.pathname.slice('/__frontistr'.length);
    if (req.method === 'GET' && path === '/ping') return json(res, 200, { ok: true, fistr1: existsSync(fistr1), busy: busy || jobs.busy });
    if (path.startsWith('/jobs')) { if (await jobRoute(req, res, path)) return; }
    if (req.method !== 'POST' || path !== '/solve') return json(res, 404, { error: 'not found' });
    if (busy || jobs.busy) return json(res, 409, { error: 'busy' });
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
