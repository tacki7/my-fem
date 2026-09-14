// Compile part of src/ to plain ESM so the node checks under tools/ can import
// it without the browser or a bundler. Node only (no zsh, no BSD sed), so it
// runs the same on macOS and Linux.
//
//   node tools/build-esm.mjs sim2d [outdir]              -> tools/sim2d/build（既定）
//   node tools/build-esm.mjs slab  [outdir]              -> tools/slab/build（既定）
//   node tools/build-esm.mjs sim3d [outdir]              -> tools/sim3d/build（既定。src/sim3d の全部）
//   node tools/build-esm.mjs --out <outdir> <entry.ts>…  -> 任意の入口
//
// tsc is taken from this repository's node_modules. `npx tsc` without
// node_modules fetches an unrelated npm package called "tsc" instead.
//
// tsc keeps the extensionless relative imports the sources use ('./slab'),
// which a bundler resolves but node does not. Every emitted file gets them
// rewritten to the file that was actually emitted ('./slab.js', or
// './dir/index.js' for a directory import).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PRESETS = {
  sim2d: { out: 'tools/sim2d/build', entries: ['src/sim/solver.ts', 'src/sim/muinv.ts', 'src/sim/mill.ts', 'src/app/defaults.ts'] },
  slab: { out: 'tools/slab/build', entries: ['src/sim/slab.ts', 'src/sim/muinv.ts'] },
  // Every module of the 3D core. The harnesses in tools/sim3d import them as
  // `./build/<name>.js`, which `flatten` provides next to the `sim3d/` tree.
  sim3d: {
    out: 'tools/sim3d/build',
    entries: readdirSync(join(ROOT, 'src/sim3d')).filter((f) => f.endsWith('.ts')).sort().map((f) => `src/sim3d/${f}`),
    flatten: 'sim3d',
  },
};

function usage(msg) {
  if (msg) console.error(`build-esm: ${msg}`);
  console.error(`usage: node tools/build-esm.mjs <${Object.keys(PRESETS).join('|')}> [outdir]
       node tools/build-esm.mjs --out <outdir> <entry.ts>...`);
  process.exit(2);
}

const args = process.argv.slice(2);
let out, entries, flatten;
if (args[0] === '--out') {
  if (args.length < 3) usage('--out needs an outdir and at least one entry');
  out = resolve(args[1]);
  entries = args.slice(2).map((e) => resolve(e));
} else {
  const preset = PRESETS[args[0]];
  if (!preset || args.length > 2) usage(args[0] ? `unknown preset '${args[0]}'` : '');
  // An explicit outdir is relative to where the command was run, as build.sh did.
  out = args[1] ? resolve(args[1]) : join(ROOT, preset.out);
  entries = preset.entries.map((e) => join(ROOT, e));
  flatten = preset.flatten;
}

const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error(`build-esm: ${tsc} not found — run \`npm ci\` first`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const run = spawnSync(process.execPath, [
  tsc, '--outDir', out, '--rootDir', join(ROOT, 'src'),
  '--module', 'es2022', '--moduleResolution', 'bundler', '--target', 'es2022',
  '--noEmit', 'false', '--skipLibCheck', '--listEmittedFiles', ...entries,
], { cwd: ROOT, encoding: 'utf8' });

const emitted = [];
for (const line of run.stdout.split('\n')) {
  if (line.startsWith('TSFILE: ')) emitted.push(line.slice('TSFILE: '.length).trim());
  else if (line.trim()) console.log(line);
}
process.stderr.write(run.stderr);
if (run.status !== 0) {
  console.error(`build-esm: tsc exited with ${run.status ?? run.signal}`);
  process.exit(1);
}

// Static `import … from` / `export … from`, side-effect `import '…'` and
// dynamic `import('…')`, relative specifiers without an extension only.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"\n]*?)\2/g;
const isFile = (p) => existsSync(p) && statSync(p).isFile();
let unresolved = 0;

for (const file of emitted.filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(file, 'utf8');
  const fixed = src.replace(SPECIFIER, (whole, head, quote, spec) => {
    if (/\.[cm]?js$|\.json$/.test(spec)) return whole;
    const target = resolve(dirname(file), spec);
    if (isFile(`${target}.js`)) return `${head}${quote}${spec}.js${quote}`;
    if (isFile(join(target, 'index.js'))) return `${head}${quote}${spec}/index.js${quote}`;
    console.error(`build-esm: ${file}: no emitted file for '${spec}'`);
    unresolved++;
    return whole;
  });
  if (fixed !== src) writeFileSync(file, fixed);
}
if (unresolved) process.exit(1);

// `<out>/<name>.js` re-exporting `<out>/<dir>/<name>.js`, for scripts that import the
// modules of one directory by their bare names. An existing symlink there (the old
// zsh build made them) already points at the same module and is left as it is:
// writing through it would overwrite the module itself.
if (flatten) {
  for (const file of emitted.filter((f) => f.endsWith('.js') && dirname(f) === join(out, flatten))) {
    const name = file.slice(dirname(file).length + 1);
    const shim = join(out, name);
    if (existsSync(shim) && lstatSync(shim).isSymbolicLink()) continue;
    writeFileSync(shim, `export * from './${flatten}/${name}';\n`);
  }
}
