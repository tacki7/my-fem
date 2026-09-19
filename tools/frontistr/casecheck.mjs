// @check
// @check-build sim3d
// The case builder without FrontISTR: for each served mill the roll model converges on the
// gate's grid, the mesh has the node count the README's results were read on (the app's
// coarser QUICK mesh for the 4Hi and 6Hi), the strip load put on the modelled part of the
// work roll is the model's share of F, the contact groups are there, and a chock's bender is
// halved on its half section (T101). Guards lib.mjs (what
// the app's bridge and case.mjs share); solving needs fistr1 and is not a gate.
import { mkdtempSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCase, QUICK, MILLS, TONF } from './lib.mjs';

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
// The work roll's bender on the 4Hi: the chock section is the z ≥ 0 half of the chock's, so it carries
// half the chock's force (as the half arc carries half the strip load); the whole force there bent
// the solid with twice the model's bender (T101)
{
  const Fb = 60 * TONF;
  const out = mkdtempSync(join(tmpdir(), 'rollfem-fistr-4hi-bender-'));
  const { ref } = await buildCase('4hi', { wrBender: Fb }, out, QUICK['4hi']);
  expect(Math.abs(ref.benderSumY - Fb / 2) < 1e-6 * Fb, `4hi bender: ${(ref.benderSumY / TONF).toFixed(3)} tonf on the half chock section (expected ${(Fb / 2 / TONF).toFixed(3)}, half the chock's ${(Fb / TONF).toFixed(0)})`);
  const cnt = readFileSync(join(out, 'roll.cnt'), 'utf8'), msh = readFileSync(join(out, 'roll.msh'), 'utf8');
  // the CLOAD lines on the chock group's nodes add up to the same
  const chock = new Set(((/!NGROUP, NGRP=CHOCK[^\n]*\n([^!]*)/.exec(msh) ?? [])[1] ?? '').split(/[\s,]+/).filter(Boolean).map(Number));
  // (the !CLOAD block only: the !SPRING lines have the same form)
  let onChock = 0, block = '';
  for (const line of cnt.split('\n')) {
    if (line.startsWith('!')) { block = line.split(',')[0]; continue; }
    const m = /^ (\d+), 2, (\S+)$/.exec(line);
    if (block === '!CLOAD' && m && chock.has(Number(m[1]))) onChock += Number(m[2]);
  }
  expect(chock.size > 0 && Math.abs(onChock - Fb / 2) < 1e-6 * Fb, `4hi bender: the CLOADs on the ${chock.size} chock nodes add up to ${(onChock / TONF).toFixed(3)} tonf (expected ${(Fb / 2 / TONF).toFixed(3)})`);
  console.log(`4hi, WR bender 60 tonf/chock: ${(ref.benderSumY / TONF).toFixed(3)} tonf on the half chock section, CLOADs on its ${chock.size} nodes ${(onChock / TONF).toFixed(3)} tonf`);
}
if (fail.length) { console.log('FAIL\n  ' + fail.join('\n  ')); process.exit(1); }
console.log('PASS');
