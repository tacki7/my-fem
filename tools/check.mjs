// `npm run check`: the regression gate (2D, and the 3D quick check), assembled from the scripts themselves.
//
//   node tools/check.mjs          run everything (exit 1 if anything FAILs)
//   node tools/check.mjs --list   show what would run, and in which order
//
// A script under tools/ joins the gate by carrying a line of its own (by convention
// just above its imports)
//
//   // @check
//
// and one `// @check-build <args>` line per build it needs, the arguments being
// those of tools/build-esm.mjs (`sim2d`, `slab`, `--out <dir> <entry.ts>…`).
// Nothing else lists the checks, so two changes that each add one do not touch
// the same file.
//
// Serial - the machine this runs on has 8 GB. The type check first, then each
// distinct build once (in the order the checks first ask for them), then the
// checks in path order. A failure does not stop the run: everything is tried,
// the table at the end says what passed, and the exit code says whether all did.
// A check whose build failed is not run and counts as a FAIL.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Straight to fd 1, never through console: on macOS a piped process.stdout is
// asynchronous, and with spawnSync blocking the loop the headings would come
// out after the output of the checks they introduce.
const say = (text) => writeSync(1, `${text}\n`);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const SELF = fileURLToPath(import.meta.url);

function scripts(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'build' || e.name === 'node_modules') continue;
      out.push(...scripts(join(dir, e.name)));
    } else if (e.name.endsWith('.mjs')) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const posix = (p) => relative(ROOT, p).split(sep).join('/');
const checks = [];
for (const file of scripts(TOOLS).filter((f) => f !== SELF).map(posix).sort()) {
  const head = readFileSync(join(ROOT, file), 'utf8').split('\n');
  if (!head.some((l) => /^\/\/\s*@check\s*$/.test(l))) continue;
  const builds = head
    .map((l) => l.match(/^\/\/\s*@check-build\s+(\S.*?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1].split(/\s+/));
  checks.push({ file, builds: builds.map((b) => b.join(' ')) });
}
const builds = [...new Set(checks.flatMap((c) => c.builds))];

if (process.argv.includes('--list')) {
  say('tsc --noEmit');
  for (const b of builds) say(`node tools/build-esm.mjs ${b}`);
  for (const c of checks) say(`node ${c.file}`);
  process.exit(0);
}

const results = [];
function step(label, cmd, args) {
  say(`\n── ${label}`);
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  const ok = r.status === 0;
  results.push({ label, status: ok ? 'PASS' : 'FAIL', secs: (performance.now() - t0) / 1000 });
  return ok;
}

// The TypeScript in this repository, not whatever `npx tsc` would fetch.
step('tsc --noEmit', process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
const built = new Map();
for (const b of builds) {
  built.set(b, step(`build-esm ${b}`, process.execPath, [join(TOOLS, 'build-esm.mjs'), ...b.split(' ')]));
}
for (const c of checks) {
  const missing = c.builds.filter((b) => !built.get(b));
  if (missing.length) {
    say(`\n── ${c.file}\nnot run: build failed (${missing.join('; ')})`);
    results.push({ label: c.file, status: 'FAIL', secs: 0, note: 'build failed, not run' });
    continue;
  }
  step(c.file, process.execPath, [join(ROOT, c.file)]);
}

const w = Math.max(...results.map((r) => r.label.length));
say('\n── check summary');
for (const r of results) {
  say(`${r.status}  ${r.label.padEnd(w)}  ${r.secs.toFixed(1).padStart(6)} s${r.note ? `  (${r.note})` : ''}`);
}
const failed = results.filter((r) => r.status !== 'PASS').length;
const total = results.reduce((s, r) => s + r.secs, 0);
say(failed ? `\n${failed} FAIL (${total.toFixed(0)} s)` : `\nall PASS (${total.toFixed(0)} s)`);
process.exit(failed ? 1 : 0);
