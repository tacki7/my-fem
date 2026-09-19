// Long FrontISTR runs as jobs whose intermediate results reach the app as they are written.
//
// A job builds its case (a `kind`'s function writes the mesh and control files into the job's
// directory), writes the surface (mesh.bin) and the initial state (frames/0.bin), then runs
// fistr1 and watches the directory: every result file `<res>.<N>` fistr1 finishes becomes
// frames/<N>.bin, and every change of state or new frame is told to whoever listens (the
// bridge's server-sent events). One job at a time - fistr1 takes every core it can get.
//
// A result file is read only once it is finished: once the next one has appeared, once fistr1
// has exited, or - the newest one while fistr1 runs - once it has stopped growing between two
// scans and holds every node's record, its last line ended. fistr1 writes a file over several
// hundred milliseconds; reading one while it grows gives a truncated record. Waiting for the
// next file instead would show each load step only when the next one is done - on the coupled
// rolls a step takes minutes, and the last one would show only at the end.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { parseRes } from './lib.mjs';
import { parseMsh, extractSurface, encodeMesh, encodeFrame, nodalAreas, frameFromResult } from './fieldframe.mjs';

/**
 * The result files that can be read: every `<prefix><N>` with a later one present, all of them
 * once the solver has exited. Sorted by N. (Exported for the gate: it is what keeps a growing
 * file from being read.)
 */
export function finishedResults(files, prefix, exited) {
  const ns = files.filter((f) => f.startsWith(prefix) && /^\d+$/.test(f.slice(prefix.length)))
    .map((f) => Number(f.slice(prefix.length))).sort((a, b) => a - b);
  return exited ? ns : ns.slice(0, -1);
}

/**
 * A result file's content, parsed, if it is written in full: every node's record the header
 * counts, the last line ended. Else null - a file cut at a line end amid the records fails to
 * parse, one cut in the middle of its last number would read as a shorter number. (Exported
 * for the gate.)
 */
export function completeResult(text) {
  if (!text.endsWith('\n')) return null;
  try {
    const res = parseRes(text);
    const i = text.indexOf('\n*data\n');
    const nn = Number(text.slice(i + 7, text.indexOf('\n', i + 7)).trim().split(/\s+/)[0]);
    return i >= 0 && res.node.size === nn ? res : null;
  } catch { return null; }
}

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * kinds: { name: async (body, dir) => ({ mesh: 'roll.msh', resPrefix: 'roll.res.0.',
 *          order: ['WR', 'BUR'], kinds: { WR: 'roll' }, symmetry, source, translate, threads, env,
 *          finish?: (dir) => JSON-able }) } - `finish` reads the finished case into result.json
 * where body is what the app posted ({ params, load, substeps, dryRun, ... }).
 */
export function createJobs({ fistr1, fistr1Args = [], runDir, kinds, pollMs = 250 }) {
  const jobs = new Map();
  let current = null;

  const emit = (job, type, data) => {
    const ev = { type, data, at: Date.now() };
    job.events.push(ev);
    for (const f of job.listeners) f(ev);
  };
  const setState = (job, state, message = '') => {
    job.state = state; job.message = message;
    emit(job, 'state', { state, message, frames: job.frames });
  };
  const status = (job) => ({ id: job.id, kind: job.kind, state: job.state, message: job.message, frames: job.frames, dir: job.dirName, startedAt: job.startedAt, seconds: (Date.now() - job.startedAt) / 1000, log: job.state === 'failed' ? job.logTail : undefined });

  async function run(job, body) {
    const kindFn = kinds[job.kind];
    try {
      setState(job, 'meshing');
      const spec = await kindFn(body, job.dir);
      if (job.cancelled) return setState(job, 'cancelled');
      const msh = parseMsh(readFileSync(`${job.dir}/${spec.mesh}`, 'utf8'));
      const surface = extractSurface(msh, { order: spec.order, kinds: spec.kinds });
      // into the app's frame (the pass line at y = 0): the case's own origin is its own business
      if (spec.translate) for (let i = 0; i < surface.coords.length; i += 3) for (let d = 0; d < 3; d++) surface.coords[i + d] += spec.translate[d];
      job.surface = surface;
      job.areas = nodalAreas(surface);
      mkdirSync(`${job.dir}/frames`, { recursive: true });
      writeFileSync(`${job.dir}/mesh.bin`, encodeMesh(surface, { symmetry: spec.symmetry, source: spec.source }));
      // the initial state: no displacement, no stress, no contact
      const n = surface.nodeIds.length;
      writeFileSync(`${job.dir}/frames/0.bin`, encodeFrame({ k: 0, metrics: { initial: true } }, new Float32Array(3 * n), { mises: new Float32Array(n), cpress: new Float32Array(n) }));
      job.frames = 1;
      emit(job, 'mesh', { nodes: n, tris: surface.tris.length / 3, parts: surface.parts });
      emit(job, 'frame', { k: 0 });
      if (body.dryRun) return setState(job, 'done', 'dry run: mesh and the initial state only');

      setState(job, 'running');
      await new Promise((resolve) => {
        const child = spawn(fistr1, fistr1Args, {
          cwd: job.dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
          env: { ...process.env, OMP_NUM_THREADS: String(spec.threads ?? 4), MallocPreScribble: '1', ...(spec.env ?? {}) },
        });
        job.child = child;
        let log = '';
        const keep = (d) => { log += d; if (log.length > 200000) log = log.slice(-100000); };
        child.stdout.on('data', keep); child.stderr.on('data', keep);
        let exited = false, exitCode = null;
        const seen = new Set([0]);
        const frame = (N, text, res) => {
          const time = Number(/TOTALTIME\s*\n\s*(\S+)/.exec(text.slice(0, 400))?.[1] ?? NaN);
          const f = frameFromResult(surface, res, job.areas);
          writeFileSync(`${job.dir}/frames/${N}.bin`, encodeFrame({ k: N, increment: N, time, metrics: f.metrics }, f.disp, f.fields));
          job.frames = Math.max(job.frames, N + 1);
          seen.add(N);
          emit(job, 'frame', { k: N, time, metrics: f.metrics });
          if (f.metrics.nonFinite > 0) job.nonFinite = true;
        };
        // the newest file's size at the last scan, and the size it failed to read at (read again
        // only once it has changed: a file stuck half-written is not parsed every scan)
        const lastSize = new Map(), failedSize = new Map();
        const scan = () => {
          let files = [];
          try { files = readdirSync(job.dir); } catch { return; }
          for (const N of finishedResults(files, spec.resPrefix, exited)) {
            if (seen.has(N)) continue;
            try {
              const text = readFileSync(`${job.dir}/${spec.resPrefix}${N}`, 'utf8');
              frame(N, text, parseRes(text));
            } catch (e) {
              // read again on the next scan; once fistr1 has exited there is no next scan
              if (exited) { seen.add(N); emit(job, 'progress', { warning: `result ${N} unreadable: ${e.message}` }); }
            }
          }
          // the newest one while fistr1 runs: once it has stopped growing and is whole
          const N = exited ? undefined : finishedResults(files, spec.resPrefix, true).pop();
          if (N !== undefined && !seen.has(N)) {
            const path = `${job.dir}/${spec.resPrefix}${N}`;
            let size = 0;
            try { size = statSync(path).size; } catch { /* not there any more */ }
            const still = size > 0 && size === lastSize.get(N) && size !== failedSize.get(N);
            lastSize.set(N, size);
            if (still) {
              try {
                const text = readFileSync(path, 'utf8'), res = completeResult(text);
                if (!res) throw new Error('not written in full');
                frame(N, text, res);
              } catch { failedSize.set(N, size); /* again once it changes, or with the rest once fistr1 exits */ }
            }
          }
          // progress: the status table fistr1 keeps (FSTR.sta), its last line
          if (existsSync(`${job.dir}/FSTR.sta`)) {
            const sta = readFileSync(`${job.dir}/FSTR.sta`, 'utf8').trim().split('\n').filter((l) => /^\s+\d+\s+\d+\s+\|/.test(l)).pop();
            if (sta && sta !== job.lastSta) { job.lastSta = sta; emit(job, 'progress', { sta: sta.trim() }); }
          }
        };
        const timer = setInterval(scan, pollMs);
        child.on('close', (code) => {
          exited = true; exitCode = code;
          clearInterval(timer);
          scan();
          job.logTail = log.split('\n').slice(-25).join('\n');
          writeFileSync(`${job.dir}/fistr.log`, log);
          if (job.cancelled) setState(job, 'cancelled');
          else if (code !== 0) setState(job, 'failed', `fistr1 exited ${code}`);
          else if (job.nonFinite) setState(job, 'failed', 'a result holds NaN or infinite values');
          else {
            // what the kind reads off the finished case (the coupling's surface), as result.json
            if (spec.finish) {
              try {
                writeFileSync(`${job.dir}/result.json`, JSON.stringify(spec.finish(job.dir)));
                emit(job, 'result', { ready: true });
              } catch (e) {
                setState(job, 'failed', `reading the result: ${e.message}`);
                return resolve();
              }
            }
            setState(job, 'done');
          }
          resolve();
        });
        child.on('error', (e) => { job.logTail = String(e.message); });
      });
    } catch (e) {
      job.logTail = (e.log ? String(e.log).split('\n').slice(-25).join('\n') : '') || String(e.stack ?? e);
      setState(job, 'failed', e.message ?? String(e));
    } finally {
      job.child = null;
      if (current === job) current = null;
    }
  }

  return {
    get busy() { return !!current; },
    /** a new job, or null (and the running one) when one is running */
    start(kind, body = {}) {
      if (!kinds[kind]) throw Object.assign(new Error(`kind ${kind}: ${Object.keys(kinds).join(', ')}`), { status: 400 });
      if (current) return { job: null, running: status(current) };
      const id = newId();
      const dirName = `jobs/${id}`;
      const job = { id, kind, dirName, dir: `${runDir}/${dirName}`, state: 'queued', message: '', frames: 0, events: [], listeners: new Set(), startedAt: Date.now(), cancelled: false, child: null };
      mkdirSync(job.dir, { recursive: true });
      writeFileSync(`${job.dir}/request.json`, JSON.stringify({ kind, ...body }));
      jobs.set(id, job);
      current = job;
      emit(job, 'state', { state: 'queued', message: '', frames: 0 });
      run(job, body);
      return { job: status(job) };
    },
    status(id) { const j = jobs.get(id); return j ? status(j) : null; },
    /** every event so far, then the new ones as they come; returns the unsubscribe */
    listen(id, f) {
      const j = jobs.get(id);
      if (!j) return null;
      for (const ev of j.events) f(ev);
      j.listeners.add(f);
      return () => j.listeners.delete(f);
    },
    file(id, name) {
      const j = jobs.get(id);
      if (!j) return null;
      const p = name === 'mesh' ? `${j.dir}/mesh.bin` : name === 'result' ? `${j.dir}/result.json` : `${j.dir}/frames/${name}.bin`;
      return existsSync(p) ? p : null;
    },
    /** stop the job's own fistr1 (its process group) */
    cancel(id) {
      const j = jobs.get(id);
      if (!j) return null;
      j.cancelled = true;
      if (j.child && j.child.exitCode === null) {
        try { process.kill(-j.child.pid, 'SIGTERM'); } catch { try { j.child.kill('SIGTERM'); } catch { /* gone */ } }
      } else if (j.state === 'queued' || j.state === 'meshing') {
        // stopped before fistr1 started: run() sees `cancelled` when the case is written
      }
      return status(j);
    },
  };
}
