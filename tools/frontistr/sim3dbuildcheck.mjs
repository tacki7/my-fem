// The bridge's build of the roll model (sim3dbuild.mjs):
//
//   node tools/frontistr/sim3dbuildcheck.mjs     (exit 1 on FAIL; part of npm run check)
//
// 1. The first case builds; the next, with nothing changed, uses that build as it is (no tsc).
// 2. The stamp covers what the build compiled: every src/sim3d module and what they import from
//    outside it (src/sim/element.ts, src/sim/mesh.ts).
// 3. A source that changed (its hash in the stamp made wrong - the check does not edit src/),
//    one that is gone, a file more in src/sim3d, another build-esm.mjs: each makes the build out
//    of date, and the next case builds again, into a new directory. The change undone, the
//    earlier build fits again and is taken.
// 4. Why it matters: node keeps a module it has imported. A process that imported one build
//    and rebuilt it in place (as the bridge did, tools/sim3d/build/ with `?v=` on the entry)
//    still runs the old modules; the new directory's are new ones.
//
// @check
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sim3dBuild, staleness } from './sim3dbuild.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const runDir = mkdtempSync(join(tmpdir(), 'sim3dbuild-'));
const stampOf = (b) => JSON.parse(readFileSync(join(b.dir, '.stamp.json'), 'utf8'));
const spoil = (b, f) => { const s = stampOf(b); f(s); writeFileSync(join(b.dir, '.stamp.json'), JSON.stringify(s)); };

// 1
let t = performance.now();
const a = await sim3dBuild({ runDir });
const tA = (performance.now() - t) / 1000;
check('the first case builds', a.built && a.why === 'no build yet', `${tA.toFixed(1)} s, ${a.dir.slice(runDir.length)}`);
t = performance.now();
const b = await sim3dBuild({ runDir });
const tB = (performance.now() - t) / 1000;
check('nothing changed: the same build, not built again', !b.built && b.dir === a.dir && b.why === '', `${tB.toFixed(2)} s against ${tA.toFixed(1)} s`);

// 2
const stamp = stampOf(a);
const srcs = Object.keys(stamp.sources);
check('the stamp has every src/sim3d entry', stamp.entries.every((e) => srcs.includes(e)), `${stamp.entries.length} entries, ${srcs.length} sources`);
check('the stamp has the modules imported from outside src/sim3d', ['src/sim/element.ts', 'src/sim/mesh.ts'].every((s) => srcs.includes(s)), srcs.filter((s) => !s.startsWith('src/sim3d/')).join(', '));

// 3
const cases = [
  ['a source changed', (s) => { s.sources['src/sim3d/stack.ts'] = '0'.repeat(40); }, /src\/sim3d\/stack\.ts changed/],
  ['a source outside src/sim3d changed', (s) => { s.sources['src/sim/element.ts'] = '0'.repeat(40); }, /src\/sim\/element\.ts changed/],
  ['a source is gone', (s) => { s.sources['src/sim3d/no-such-module.ts'] = '0'.repeat(40); }, /is gone/],
  ['src/sim3d has a file more', (s) => { s.entries = s.entries.slice(1); }, /gained or lost/],
  ['build-esm.mjs changed', (s) => { s.tool = '0'.repeat(40); }, /build-esm\.mjs changed/],
];
const kept = readFileSync(join(a.dir, '.stamp.json'), 'utf8');
for (const [name, f, why] of cases) {
  spoil(a, f);
  const w = staleness(a.dir);
  check(`${name}: the build is out of date`, why.test(w), w);
  writeFileSync(join(a.dir, '.stamp.json'), kept);
}
check('the stamp put back: up to date again', staleness(a.dir) === '');
// one of them for real: the next case builds again, into a new directory, and keeps that
spoil(a, cases[0][1]);
const c = await sim3dBuild({ runDir });
check('a source changed: the next case builds again, in a new directory', c.built && c.dir !== a.dir && staleness(c.dir) === '', c.why);
const e = await sim3dBuild({ runDir });
check('then nothing changed again: that build is kept', !e.built && e.dir === c.dir);
// the change undone: the first build fits again, and is taken rather than built a third time
writeFileSync(join(a.dir, '.stamp.json'), kept);
spoil(c, cases[0][1]);
const last = await sim3dBuild({ runDir });
check('a change undone: the earlier build of the same sources is taken, not built again', !last.built && last.dir === a.dir, last.why);

// 4
const home = mkdtempSync(join(tmpdir(), 'esmcache-'));
mkdirSync(join(home, 'in'));
writeFileSync(join(home, 'in', 'm.js'), 'export const v = 1;\n');
writeFileSync(join(home, 'm.js'), "export * from './in/m.js';\n");
const v1 = (await import(new URL('m.js?v=1', pathToFileURL(`${home}/`)))).v;
writeFileSync(join(home, 'in', 'm.js'), 'export const v = 2;\n');
const v2 = (await import(new URL('m.js?v=2', pathToFileURL(`${home}/`)))).v;
check('a build rebuilt in place does not reach a process that imported it (the old way)', v1 === 1 && v2 === 1, `v ${v1} → ${v2}`);
const s1 = (await import(new URL('solver.js', a.url))).StackSolver;
const s2 = (await import(new URL('solver.js', c.url))).StackSolver;
check('a new build\'s directory gives new modules', typeof s1 === 'function' && s1 !== s2);

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
