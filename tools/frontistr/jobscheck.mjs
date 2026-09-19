// The FrontISTR jobs and their fieldframe output, without FrontISTR: a small made-up mesh and a
// stand-in for fistr1 (a node script that writes result files over time, the last one slowly).
//
//   node tools/frontistr/jobscheck.mjs      (exit 1 on FAIL)
//
// 1. Surface: a two-hexahedron block and a prism, each its own group - the faces two elements
//    share are dropped, every other one faces outwards (the divergence theorem over the surface
//    gives the body's volume, positive).
// 2. The binary format: the header, its padding to 4 bytes, the arrays read back as written.
// 3. Which result files may be read: none still growing, and the newest only once it is whole.
// 4. A job end to end through the bridge's HTTP routes: 409 for a second one, server-sent events
//    in order, a frame per result file with the values the stand-in wrote (none read while it was
//    half-written, or with its last number cut), the newest one's frame before the next file
//    starts (a load step on the coupled rolls takes minutes), a cancel that stops the stand-in.
//
// @check
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMsh, extractSurface, encodeMesh, encodeFrame, readHeader } from './fieldframe.mjs';
import { finishedResults, completeResult } from './jobs.mjs';
import { frontistrHandler } from './bridge.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// ── a mesh: body A two unit hexahedra along x, body B a prism beside them ──
const MSH = `!HEADER
 test
!NODE
 1, 0, 0, 0
 2, 1, 0, 0
 3, 2, 0, 0
 4, 0, 1, 0
 5, 1, 1, 0
 6, 2, 1, 0
 7, 0, 0, 1
 8, 1, 0, 1
 9, 2, 0, 1
 10, 0, 1, 1
 11, 1, 1, 1
 12, 2, 1, 1
 13, 5, 0, 0
 14, 6, 0, 0
 15, 5, 1, 0
 16, 5, 0, 2
 17, 6, 0, 2
 18, 5, 1, 2
!ELEMENT, TYPE=361, EGRP=A
 1, 1, 2, 5, 4, 7, 8, 11, 10
 2, 2, 3, 6, 5, 8, 9, 12, 11
!ELEMENT, TYPE=351, EGRP=B
 3, 13, 14, 15,
 16, 17, 18
!END
`;
const msh = parseMsh(MSH);
check('mesh read (an element over two lines)', msh.nodes.size === 18 && msh.elems.length === 3 && msh.elems[2].nodes.length === 6, `${msh.nodes.size} nodes, ${msh.elems.length} elements`);
const surf = extractSurface(msh, { order: ['B', 'A'], kinds: { A: 'strip' } });
const vol = (p) => {
  let v = 0;
  const c = surf.coords, t = surf.tris;
  for (let i = p.triStart * 3; i < (p.triStart + p.triCount) * 3; i += 3) {
    const a = 3 * t[i], b = 3 * t[i + 1], d = 3 * t[i + 2];
    v += (c[a] * (c[b + 1] * c[d + 2] - c[b + 2] * c[d + 1]) - c[a + 1] * (c[b] * c[d + 2] - c[b + 2] * c[d]) + c[a + 2] * (c[b] * c[d + 1] - c[b + 1] * c[d])) / 6;
  }
  return v;
};
const [pB, pA] = surf.parts;
check('parts in the asked order, with their kinds', pB.name === 'B' && pA.name === 'A' && pA.kind === 'strip' && pB.kind === 'roll', surf.parts.map((p) => `${p.name}:${p.kind}`).join(' '));
check('shared face dropped: 10 quads = 20 triangles on the block, 12 nodes', pA.triCount === 20 && pA.nodeCount === 12, `${pA.triCount} tris, ${pA.nodeCount} nodes`);
check('prism: 2 triangles + 3 quads = 8 triangles, 6 nodes', pB.triCount === 8 && pB.nodeCount === 6, `${pB.triCount} tris`);
check('outward: the surface encloses +2 (block) and +1 (prism)', Math.abs(vol(pA) - 2) < 1e-6 && Math.abs(vol(pB) - 1) < 1e-6, `${vol(pA).toFixed(6)}, ${vol(pB).toFixed(6)}`);
check('triangles index inside their own part', surf.parts.every((p) => { for (let i = p.triStart * 3; i < (p.triStart + p.triCount) * 3; i++) { const k = surf.tris[i]; if (k < p.nodeStart || k >= p.nodeStart + p.nodeCount) return false; } return true; }));

// ── the binary format ──
const meshBuf = encodeMesh(surf, { symmetry: { x: true, y: true, z: false }, source: { case: 'test' } });
const { header: mh, start: ms } = readHeader(meshBuf);
const coordsBack = new Float32Array(meshBuf.buffer.slice(meshBuf.byteOffset + ms, meshBuf.byteOffset + ms + 4 * surf.coords.length));
const trisBack = new Uint32Array(meshBuf.buffer.slice(meshBuf.byteOffset + ms + 4 * surf.coords.length, meshBuf.byteOffset + meshBuf.length));
check('mesh header and padding', ms % 4 === 0 && mh.format === 'fieldframe-mesh/1' && mh.nodeCount === 18 && mh.triCount === 28 && mh.symmetry.y === true, `arrays at ${ms}`);
check('mesh arrays read back', coordsBack.every((v, i) => v === surf.coords[i]) && trisBack.length === surf.tris.length && trisBack.every((v, i) => v === surf.tris[i]));
const n = 18, disp = Float32Array.from({ length: 3 * n }, (_, i) => i * 0.5), mises = Float32Array.from({ length: n }, (_, i) => i === 3 ? NaN : i * 1e6);
const frameBuf = encodeFrame({ k: 7, time: 0.5, metrics: { force: 1 } }, disp, { mises });
const { header: fh, start: fs } = readHeader(frameBuf);
const all = new Float32Array(frameBuf.buffer.slice(frameBuf.byteOffset + fs, frameBuf.byteOffset + frameBuf.length));
check('frame header, padding and arrays', fs % 4 === 0 && fh.k === 7 && fh.fields.join() === 'mises' && all.length === 4 * n && all[3 * n + 5] === 5e6 && Number.isNaN(all[3 * n + 3]) && all[10] === 5, `${frameBuf.length} bytes`);

// ── which result files may be read ──
const files = ['roll.res.0.0', 'roll.res.0.1', 'roll.res.0.10', 'roll.res.0.2', 'roll.msh', 'roll.res.0.x'];
check('running: all but the newest', finishedResults(files, 'roll.res.0.', false).join() === '0,1,2', finishedResults(files, 'roll.res.0.', false).join());
check('exited: all of them, in order', finishedResults(files, 'roll.res.0.', true).join() === '0,1,2,10');
const RES = ['*fstrresult 2.0', '*comment', 'static_result', '*global', '1', '1 ', 'TOTALTIME', '0.5', '*data', '2 1', '2 0', '3 1 ', 'DISPLACEMENT', 'NodalMISES',
  '1 ', '0.0 1.0E-04 0.0 2.5E+06', '2 ', '0.0 2.0E-04 0.0 3.5E+06'].join('\n') + '\n';
const whole = completeResult(RES);
check('a whole result file: read', whole?.node.size === 2 && whole.node.get(2).NodalMISES[0] === 3.5e6);
const cuts = [['cut in its last number', RES.length - 5], ['its last line not ended', RES.length - 1], ['cut after a node number', RES.indexOf('2 \n') + 3], ['cut at a line end amid the records', RES.indexOf('\n2 \n') + 1]];
const cutRead = cuts.filter(([, at]) => completeResult(RES.slice(0, at)) !== null).map(([name]) => name);
check('a result file not written in full: not read', cutRead.length === 0, cutRead.join(', ') || cuts.map(([n]) => n).join(', '));

// ── a job end to end, with a stand-in for fistr1 ──
const dir = mkdtempSync(join(tmpdir(), 'jobscheck-'));
const fake = join(dir, 'fake-fistr1.mjs');
// Writes res.0.0 … res.0.3 (displacement y = 1e-4·N at every node, NodalMISES = N·1e6), each after a
// pause, the file itself in three parts 150 ms apart: half of it, then all but the tail of its last
// number (NodalMISES N.00000 for N.000000e+6), then the rest - a reader that took the newest file
// while it grew would read half of it, or the last node's stress a million times too small. After
// res.0.1 it pauses 1.5 s, as fistr1 does for minutes between the coupled rolls' load steps; it says
// when it starts each file. With STALL set it hangs after res.0.1 (for the cancel).
writeFileSync(fake, `
import { writeFileSync, appendFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = JSON.parse(process.env.FAKE_IDS);
const res = (N) => {
  const L = ['*fstrresult 2.0', '*comment', 'static_result', '*global', '1', '1 ', 'TOTALTIME', String(N / 3), '*data', ids.length + ' 3', '2 0', '3 1 ', 'DISPLACEMENT', 'NodalMISES'];
  for (const id of ids) L.push(String(id), '0.0 ' + (1e-4 * N).toExponential(6) + ' 0.0 ' + (N * 1e6).toExponential(6));
  return L.join('\\n') + '\\n';
};
for (let N = 0; N <= 3; N++) {
  const t = res(N), h = Math.floor(t.length / 2), tail = t.length - 5;
  console.log('start ' + N + ' ' + Date.now());
  writeFileSync('roll.res.0.' + N, t.slice(0, h));
  await sleep(150);
  appendFileSync('roll.res.0.' + N, t.slice(h, tail));
  await sleep(150);
  appendFileSync('roll.res.0.' + N, t.slice(tail));
  if (process.env.STALL && N === 1) await sleep(60000);
  await sleep(N === 1 ? 1500 : 100);
}
console.log('FAKE done');
`);
const kinds = {
  test: async (body, d) => {
    writeFileSync(join(d, 'roll.msh'), MSH);
    return { mesh: 'roll.msh', resPrefix: 'roll.res.0.', order: ['A', 'B'], kinds: { A: 'strip' }, symmetry: { x: true, y: false, z: false }, source: { case: 'test' }, translate: [0, 10, 0], threads: 1, env: { FAKE_IDS: JSON.stringify([...msh.nodes.keys()]), STALL: body.stall ? '1' : '' } };
  },
};
const handler = frontistrHandler({ runDir: dir, kinds, jobFistr1: process.execPath, jobFistr1Args: [fake], pollMs: 20 });
const srv = createServer((req, res) => handler(req, res));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/__frontistr`;
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** the job's events until it ends (or the time runs out), as [type, data] */
async function events(id, until = ['done', 'failed', 'cancelled'], ms = 30000) {
  const out = [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${base}/jobs/${id}/events`, { signal: ctl.signal });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = /event: (.*)/.exec(block)?.[1], data = /data: (.*)/.exec(block)?.[1];
        if (!type) continue;
        const d = JSON.parse(data);
        out.push([type, d, Date.now()]);
        if (type === 'state' && until.includes(d.state)) { ctl.abort(); return out; }
      }
    }
  } catch { /* aborted */ } finally { clearTimeout(timer); }
  return out;
}

const r1 = await post('/jobs', { kind: 'test' });
const { job } = await r1.json();
const r2 = await post('/jobs', { kind: 'test' });
check('a second job while one runs: 409', r1.status === 200 && r2.status === 409, `${r1.status}, ${r2.status}`);
const evs = await events(job.id);
const states = evs.filter(([t]) => t === 'state').map(([, d]) => d.state);
const frames = evs.filter(([t]) => t === 'frame').map(([, d]) => d.k);
check('states in order', states.join() === 'queued,meshing,running,done', states.join());
check('a frame per result file, 0 (initial) … 3', frames.join() === '0,1,2,3', frames.join());
let valuesOk = true, detail = '';
for (const k of [1, 2, 3]) {
  const b = Buffer.from(await (await fetch(`${base}/jobs/${job.id}/frames/${k}.bin`)).arrayBuffer());
  const { header, start } = readHeader(b);
  const a = new Float32Array(b.buffer.slice(b.byteOffset + start, b.byteOffset + b.length));
  const m = a.subarray(3 * n + header.fields.indexOf('mises') * n, 3 * n + (header.fields.indexOf('mises') + 1) * n);
  const ok = header.fields.includes('mises') && Math.abs(a[1] - 1e-4 * k) < 1e-9 && m.every((v) => v === k * 1e6);
  if (!ok) { valuesOk = false; detail = `frame ${k}: dy ${a[1]}, mises ${m[0]}`; }
}
check('every frame holds the whole result it names (none read half-written)', valuesOk, detail);
const log1 = readFileSync(join(dir, (await (await fetch(`${base}/jobs/${job.id}`)).json()).dir, 'fistr.log'), 'utf8');
const start2 = Number(/start 2 (\d+)/.exec(log1)?.[1]), got1 = evs.find(([t, d]) => t === 'frame' && d.k === 1)?.[2];
check('the newest file read once whole, before the next one starts', got1 < start2, `frame 1 ${Math.abs(got1 - start2)} ms ${got1 < start2 ? 'before' : 'after'} res.0.2 started`);
const meshB = Buffer.from(await (await fetch(`${base}/jobs/${job.id}/mesh.bin`)).arrayBuffer());
const { header: mh2, start: ms2 } = readHeader(meshB);
const y0 = new Float32Array(meshB.buffer.slice(meshB.byteOffset + ms2, meshB.byteOffset + ms2 + 12))[1];
check('mesh served, moved into the app frame', mh2.nodeCount === 18 && mh2.parts[0].name === 'A' && y0 >= 10, `first node y ${y0}`);

const r3 = await post('/jobs', { kind: 'test', stall: true });
const { job: j3 } = await r3.json();
const partial = await events(j3.id, [], 2500);
const c = await post(`/jobs/${j3.id}/cancel`, {});
const after = await events(j3.id, ['done', 'failed', 'cancelled'], 10000);
const last = after.filter(([t]) => t === 'state').pop()?.[1]?.state;
check('cancel stops the run', c.status === 200 && last === 'cancelled' && partial.some(([t, d]) => t === 'state' && d.state === 'running'), `last state ${last}`);
const st = await (await fetch(`${base}/jobs/${j3.id}`)).json();
const log = readFileSync(join(dir, st.dir, 'fistr.log'), 'utf8');
check('the stand-in did not run on after the cancel', !log.includes('FAKE done'), JSON.stringify(log.slice(-60)));
const r4 = await post('/jobs', { kind: 'test', dryRun: true });
const ev4 = await events((await r4.json()).job.id);
check('dry run: mesh and frame 0 only', ev4.filter(([t]) => t === 'frame').map(([, d]) => d.k).join() === '0' && ev4.at(-1)[1].state === 'done');
srv.close();

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
process.exit(0);
