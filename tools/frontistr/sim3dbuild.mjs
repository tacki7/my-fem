// The 3D roll model for the bridge's cases (bridge.mjs): src/sim3d compiled to node's ESM, built
// again only when a source changed.
//
// Each build goes to a directory of its own, run/sim3d/<id>/ (git-ignored), and stays there:
//
//   - node keeps every module it has imported, by its URL. A rebuilt tools/sim3d/build/ under the
//     same path would not reach a running bridge past its first case (`?v=` on the entry busts
//     the entry alone, not the modules it imports), so the bridge solved with whatever src/sim3d
//     was when it started. A new directory is a new URL.
//   - a build is never written over one in use. The bridge used to rebuild tools/sim3d/build/
//     for every case, and a `npm run check` in the same tree could import a module between tsc
//     writing it and build-esm.mjs fixing its imports (`Cannot find module …/build/sim3d/ring`).
//     The bridge does not touch tools/sim3d/build/ now.
//
// Whether a build is current: its `.stamp.json` (build-esm.mjs) against the tree - the same
// entries (src/sim3d/*.ts), the same hash for every source it compiled, the same build-esm.mjs
// and TypeScript. run/sim3d/current.json names the build in use; when it is out of date, an
// earlier build that fits (a change undone, a branch switched back) is taken before building
// anew. Old builds are left, like the jobs under run/jobs/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha1 = (file) => createHash('sha1').update(readFileSync(file)).digest('hex');
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** why the build in `dir` is not the tree's now ('' when it is) */
export function staleness(dir, root = ROOT) {
  const stamp = readJson(join(dir, '.stamp.json'));
  if (!stamp) return 'no stamp';
  if (!existsSync(join(dir, 'solver.js'))) return 'no solver.js';
  if (stamp.tool !== sha1(join(root, 'tools', 'build-esm.mjs'))) return 'build-esm.mjs changed';
  const ts = readJson(join(root, 'node_modules', 'typescript', 'package.json'))?.version;
  if (stamp.typescript !== ts) return `TypeScript ${stamp.typescript} → ${ts}`;
  const entries = readdirSync(join(root, 'src', 'sim3d')).filter((f) => f.endsWith('.ts')).sort().map((f) => `src/sim3d/${f}`);
  if (JSON.stringify(stamp.entries) !== JSON.stringify(entries)) return 'src/sim3d gained or lost a file';
  for (const [src, hash] of Object.entries(stamp.sources ?? {})) {
    if (!existsSync(join(root, src))) return `${src} is gone`;
    if (sha1(join(root, src)) !== hash) return `${src} changed`;
  }
  return '';
}

/** run node on a script to its end; rejects with its output */
const node = (args, cwd, signal) => new Promise((ok, fail) => {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('error', (e) => fail(Object.assign(e, { log: out })));
  child.on('close', (code) => (code === 0 ? ok(out) : fail(Object.assign(new Error(`build-esm.mjs sim3d exited ${code}`), { log: out }))));
});

/**
 * The directory of a build of src/sim3d as it is now, built if there is none: `{ url, dir, built,
 * why }` - `url` the directory's file URL with a trailing slash (import `solver.js`, `stack.js`
 * from it), `built` whether this call built it, `why` the build in use was out of date ('' when
 * it was not).
 */
export async function sim3dBuild({ runDir, signal, root = ROOT } = {}) {
  const home = resolve(runDir ?? join(root, 'tools', 'frontistr', 'run'), 'sim3d');
  mkdirSync(home, { recursive: true });
  const current = readJson(join(home, 'current.json'));
  const was = current?.dir ? join(home, current.dir) : null;
  const why = was ? staleness(was, root) : 'no build yet';
  const found = (dir, built) => ({ url: pathToFileURL(dir + '/'), dir, built, why });
  if (!why) return found(was, false);
  // name the build in use: current.json, written whole and then renamed over the old one
  const name = (n) => {
    writeFileSync(join(home, `current.json.${process.pid}`), JSON.stringify({ dir: n }) + '\n');
    renameSync(join(home, `current.json.${process.pid}`), join(home, 'current.json'));
  };
  // an earlier build of these very sources (a change undone, a branch switched back)
  const earlier = readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory() && join(home, e.name) !== was)
    .map((e) => e.name).sort().reverse().find((n) => staleness(join(home, n), root) === '');
  if (earlier) { name(earlier); return found(join(home, earlier), false); }
  const n = `${Date.now().toString(36)}-${process.pid}`;
  await node([join(root, 'tools', 'build-esm.mjs'), 'sim3d', join(home, n)], root, signal);
  name(n);
  return found(join(home, n), true);
}
