// @check
// @check-build sim3d
// @check-build sim2d
// The case builder without FrontISTR: for each served mill the roll model converges on the
// gate's grid, the mesh has the node count the README's results were read on (the app's
// coarser QUICK mesh for the 4Hi and 6Hi), the strip load put on the modelled part of the
// work roll is the model's share of F, and the contact groups are there. Guards lib.mjs (what
// the app's bridge and case.mjs share); solving needs fistr1 and is not a gate.
import { mkdtempSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCase, QUICK, MILLS, TONF } from './lib.mjs';
import { buildStrip2d } from './strip2d.mjs';

const fail = [];
const expect = (ok, what) => { if (!ok) fail.push(what); };
const CASES = [
  // mill, opts, nodes, contacts
  ['2hi', QUICK['2hi'], 34099, 0],
  ['4hi', QUICK['4hi'], 34870, 1],
  ['6hi', QUICK['6hi'], 50286, 2],
];
for (const [mill, opts, wantNodes, wantContacts] of CASES) {
  const out = mkdtempSync(join(tmpdir(), `rollfem-fistr-${mill}-`));
  const t0 = performance.now();
  const { ref, nodes, loadedNodes } = await buildCase(mill, {}, out, opts);
  const ms = performance.now() - t0;
  const tag = `${mill}:`;
  expect(ref.iterations > 0 && ref.iterations < 600, `${tag} iterations ${ref.iterations}`);
  expect(nodes === wantNodes, `${tag} nodes ${nodes} (expected ${wantNodes})`);
  expect(loadedNodes > 50, `${tag} loaded nodes ${loadedNodes}`);
  expect(ref.full === MILLS[mill].full, `${tag} full ${ref.full}`);
  const share = ref.force / (ref.full ? 2 : 4);
  expect(Math.abs(ref.loadSumY - share) / share < 2e-3, `${tag} strip load ${(ref.loadSumY / TONF).toFixed(2)} vs F/${ref.full ? 2 : 4} ${(share / TONF).toFixed(2)} tonf`);
  expect(ref.contacts.length === wantContacts, `${tag} contacts ${ref.contacts.length} (expected ${wantContacts})`);
  for (const f of ['roll.msh', 'roll.cnt', 'hecmw_ctrl.dat', 'reference.json']) expect(existsSync(join(out, f)) && statSync(join(out, f)).size > 0, `${tag} ${f} written`);
  const msh = readFileSync(join(out, 'roll.msh'), 'utf8');
  const cnt = readFileSync(join(out, 'roll.cnt'), 'utf8');
  expect(msh.includes('!NGROUP, NGRP=BRG') && msh.includes('!NGROUP, NGRP=ZSYM'), `${tag} BRG / ZSYM groups`);
  expect(ref.full ? !msh.includes('NGRP=XSYM') && msh.includes('NGRP=XHOLD') : msh.includes('NGRP=XSYM') && !msh.includes('NGRP=XHOLD'), `${tag} XSYM on a half case, XHOLD on a whole one`);
  expect(cnt.includes(wantContacts ? 'TYPE=NLSTATIC' : 'TYPE=STATIC'), `${tag} solution type`);
  expect((msh.match(/!CONTACT PAIR/g) ?? []).length === wantContacts, `${tag} contact pairs in the mesh`);
  const wr = ref.rolls[0];
  const i0 = wr.x.findIndex((x) => Math.abs(x) < 1e-9);
  expect(i0 >= 0, `${tag} the centre station is on the mesh`);
  const v0 = wr.v[i0];
  if (mill === '2hi') {
    expect(v0 > 2.5e-3 && v0 < 3.5e-3, `${tag} centre deflection ${(v0 * 1e6).toFixed(0)} µm (README 2982.9)`);
    expect(ref.WR.flat[i0] > 20e-6 && ref.WR.flat[i0] < 60e-6, `${tag} centre flattening ${(ref.WR.flat[i0] * 1e6).toFixed(1)} µm (README 37.3)`);
  } else {
    expect(v0 > 0 && v0 < 2e-3, `${tag} centre deflection ${(v0 * 1e6).toFixed(0)} µm`);
    // the model's contact load at the centre is of the strip load's size
    const c0 = ref.contacts[0], q0 = c0.q[ref.rolls[c0.a].x.findIndex((x) => Math.abs(x) < 1e-9)];
    expect(q0 > 1e6 && q0 < 5e7, `${tag} centre contact load ${(q0 / 1e6).toFixed(2)} kN/mm`);
  }
  console.log(`${mill}: ${ref.iterations} iterations, F ${(ref.force / TONF).toFixed(1)} tonf, ${nodes} nodes (${ref.mesh.map((m) => `${m.name} ${m.stations}×${m.layers}×${m.angles}`).join(', ')}), ${loadedNodes} loaded, ${ref.contacts.length} contacts, ${ms.toFixed(0)} ms`);
}
// the 2D rolling case (strip2d.mjs): the strip starts in the gap, a hair under the roll, and
// runs on at the exit thickness; the roll ring closes; the groups the control file names exist
{
  const out = mkdtempSync(join(tmpdir(), 'rollfem-fistr-strip2d-'));
  const t0 = performance.now();
  const { ref, nodes } = await buildStrip2d({}, out, { dx: 0.5e-3, ny: 3, len: 0.03, surf: 1e-3, coarse: 30e-3 });
  const ms = performance.now() - t0;
  const tag = 'strip2d:';
  const msh = readFileSync(join(out, 'roll.msh'), 'utf8'), cnt = readFileSync(join(out, 'roll.cnt'), 'utf8');
  const X = new Map(); { let mode = ''; for (const l of msh.split('\n')) { if (l.startsWith('!')) { mode = l; continue; } if (mode.startsWith('!NODE')) { const a = l.split(',').map(Number); X.set(a[0], a.slice(1)); } } }
  expect(X.size === nodes && nodes === ref.mesh.strip.nodes + ref.mesh.roll.nodes, `${tag} nodes ${X.size} vs ${nodes}`);
  // every strip top node sits under the roll surface (never inside it), and the head is at the exit thickness
  let inside = 0, atExit = 0;
  for (const s of ref.slave) { const [x, y] = X.get(s.nodes[0]); const gap = Math.hypot(x, y - ref.yc) - ref.params.R; if (gap < -1e-9) inside++; if (x > 1e-3 && Math.abs(2 * y - (ref.params.h1 - 2 * ref.opts.gap0)) < 1e-9) atExit++; }
  expect(inside === 0, `${tag} ${inside} strip top nodes inside the roll`);
  expect(atExit > 3, `${tag} head at the exit thickness (${atExit} nodes)`);
  for (const g of ['STRIP_SYM', 'TAIL', 'HEAD', 'ZALL', 'BORE', 'SLAVE']) expect(msh.includes(`NGRP=${g}`), `${tag} group ${g}`);
  expect(msh.includes('SGRP=MASTER') && msh.includes('!CONTACT PAIR, NAME=CP1'), `${tag} contact pair`);
  expect((cnt.match(/^!STEP/gm) ?? []).length === 1 && cnt.includes('!PLASTIC, YIELD=MISES, HARDEN=MULTILINEAR') && cnt.includes(`CP1, ${ref.params.mu}`), `${tag} one step, plasticity, friction`);
  expect((cnt.match(/^!AMPLITUDE/gm) ?? []).length === ref.bore.length * 2, `${tag} an amplitude per bore station and component`);
  console.log(`strip2d: ${nodes} nodes (strip ${ref.mesh.strip.nodes}, roll ${ref.mesh.roll.nodes}), contact ${(ref.Lc * 1e3).toFixed(1)} mm, ${ref.bore.length} bore stations, ${ms.toFixed(0)} ms`);
}
if (fail.length) { console.log('FAIL\n  ' + fail.join('\n  ')); process.exit(1); }
console.log('PASS');
