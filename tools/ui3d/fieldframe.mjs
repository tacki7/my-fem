// The contour view's data path without a browser: the fieldframe buffers the bridge writes, read
// back on the page's side (src/ui3d/fieldframe.ts), and the arithmetic the drawing colours by
// (src/ui3d/contourmath.ts), on the demo's synthetic mill (src/ui3d/fieldsynth.ts).
//
//   node tools/build-esm.mjs --out tools/ui3d/build src/ui3d/fieldframe.ts src/ui3d/contourmath.ts src/ui3d/fieldsynth.ts
//   node tools/ui3d/fieldframe.mjs      (exit 1 on FAIL; part of npm run check)
//
// 1. Round trip: the synthetic rolls and a loaded frame written by the bridge's writer
//    (tools/frontistr/fieldframe.mjs) decode to the same numbers, bit for bit; the page's own
//    writer (for the demo) makes the same bytes as the bridge's.
// 2. Broken buffers are refused with a reason, never read: short, a header running past the
//    end, bad JSON, the wrong format, non-zero padding, the arrays one byte late, parts that
//    overlap or leave nodes over, a triangle reaching into another part, a frame of another
//    mesh, a field named twice.
// 3. Colours: t at the ends of the range, just outside it, NaN and ±∞ (no value, not 0); the
//    bands the legend and the shader agree on; the automatic range (min … 99.5 % point, a
//    signed field symmetric, one value everywhere, nothing finite).
// 4. Surfaces: the synthetic bodies face outwards (the divergence theorem gives each body's
//    volume); sharp edges split (a cube's 8 corners drawn as 24 vertices, its normals the axes)
//    and a smooth surface not; the mesh lines leave out the quadrilaterals' diagonals.
// 5. The synthetic strip carries what it claims: the exit's strain the homogeneous
//    (2/√3) ln(h₀/h₁), σ_zz the back tension at the entry and the front tension at the exit.
//
// @check
// @check-build --out tools/ui3d/build src/ui3d/fieldframe.ts src/ui3d/contourmath.ts src/ui3d/fieldsynth.ts
import { encodeMesh as bridgeMesh, encodeFrame as bridgeFrame } from '../frontistr/fieldframe.mjs';
import { decodeMesh, decodeFrame, partValues, encodeMesh, encodeFrame, FieldFrameError, frameLabel } from './build/ui3d/fieldframe.js';
import { autoRange, rangeFor, quantile, normalizeInto, bandOf, splitCreases, vertexNormals, meshEdges, AUTO_TAIL } from './build/ui3d/contourmath.js';
import { synthRolls, synthRollValues, synthStrip, synthGrid, countNodes, MILL_4HI } from './build/ui3d/fieldsynth.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const sameBits = (a, b) => {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length), y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

// ── 1. round trip ──
const g = synthGrid(6000);
const rolls = synthRolls(MILL_4HI, g);
// the bridge's surface: nodes and triangles numbered through all parts
let nodes = 0, tcount = 0;
const heads = rolls.map((p) => { const h = { name: p.name, kind: p.kind, nodeStart: nodes, nodeCount: p.coords.length / 3, triStart: tcount, triCount: p.tris.length / 3 }; nodes += h.nodeCount; tcount += h.triCount; return h; });
const coords = new Float32Array(3 * nodes), tris = new Uint32Array(3 * tcount);
rolls.forEach((p, i) => { coords.set(p.coords, 3 * heads[i].nodeStart); p.tris.forEach((v, t) => { tris[3 * heads[i].triStart + t] = v + heads[i].nodeStart; }); });
const symmetry = { x: true, y: true, z: true };
const meshBuf = ab(bridgeMesh({ parts: heads, coords, tris }, { symmetry, source: { case: 'synthetic', mill: '4hi' } }));
// a decoder that cannot read the writer's own buffer fails here, and nothing after it can be judged
const attempt = (name, fn) => { try { return fn(); } catch (e) { check(name, false, `threw: ${e.message}`); console.log('\n1 FAIL (the rest depends on it)'); process.exit(1); } };
const mesh = attempt('mesh: decodes', () => decodeMesh(meshBuf));
check('mesh: parts, counts and symmetry', mesh.parts.length === 2 && mesh.header.nodeCount === nodes && mesh.header.triCount === tcount && mesh.parts[1].symmetry.z === true,
  `${nodes} nodes, ${tcount} triangles, parts ${mesh.parts.map((p) => `${p.name}/${p.kind}`).join(' ')}`);
check('mesh: coordinates and local triangles as written', rolls.every((p, i) => sameBits(mesh.parts[i].coords, p.coords) && p.tris.every((v, t) => mesh.parts[i].tris[t] === v)));
check('mesh: the page writes the bridge\'s bytes', Buffer.from(encodeMesh(rolls, symmetry, { case: 'synthetic', mill: '4hi' })).equals(Buffer.from(meshBuf)));

const vals = synthRollValues(rolls, 0.8);
const disp = new Float32Array(3 * nodes), mises = new Float32Array(nodes), cpress = new Float32Array(nodes);
rolls.forEach((p, i) => { disp.set(vals[p.name].disp, 3 * heads[i].nodeStart); mises.set(vals[p.name].fields.mises, heads[i].nodeStart); cpress.set(vals[p.name].fields.cpress, heads[i].nodeStart); });
mises[5] = NaN; // a node without a value stays one
const fhead = { k: 3, increment: 3, time: 0.75, travel: 0.0042, metrics: { steady: false, force: 1.2e7 } };
const frameBuf = ab(bridgeFrame(fhead, disp, { mises, cpress }));
const frame = attempt('frame: decodes', () => decodeFrame(frameBuf, nodes));
check('frame: header', frame.header.k === 3 && frame.header.fields.join() === 'mises,cpress' && frame.header.travel === 0.0042 && frame.header.metrics.force === 1.2e7);
check('frame: displacement and fields bit for bit', sameBits(frame.disp, disp) && sameBits(frame.fields.mises, mises) && sameBits(frame.fields.cpress, cpress) && Number.isNaN(frame.fields.mises[5]));
const bur = partValues(mesh, frame, 'BUR');
check('frame: one part\'s share', bur.fields.mises.length === heads[1].nodeCount && bur.fields.mises[0] === mises[heads[1].nodeStart] && bur.disp[2] === disp[3 * heads[1].nodeStart + 2]);
check('frame: the status line', frameLabel(frame.header).text === '増分 3　進んだ距離 4.2 mm' && frameLabel({ ...frame.header, k: 0 }).state === 'initial' && frameLabel({ ...frame.header, metrics: { steady: true } }).state === 'steady');
check('frame: the page writes the bridge\'s bytes', Buffer.from(encodeFrame(fhead, disp, { mises, cpress })).equals(Buffer.from(frameBuf)));

// ── 2. broken buffers ──
const refuses = (name, fn, want) => {
  try { fn(); check(`refused: ${name}`, false, 'read without complaint'); }
  catch (e) { check(`refused: ${name}`, e instanceof FieldFrameError && (!want || want.test(e.message)), e.message); }
};
const bytes = (buf) => new Uint8Array(buf.slice(0));
const withHeader = (obj, arrays) => ab(packRaw(obj, arrays));
function packRaw(header, arrays, shift = 0) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const head = 4 + json.length, pad = (4 - (head % 4)) % 4;
  const out = Buffer.alloc(head + pad + shift + arrays.reduce((s, a) => s + a.byteLength, 0));
  out.writeUInt32LE(json.length, 0); json.copy(out, 4);
  let o = head + pad + shift;
  for (const a of arrays) { Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(out, o); o += a.byteLength; }
  return out;
}
const hdr = JSON.parse(Buffer.from(meshBuf).subarray(4, 4 + new DataView(meshBuf).getUint32(0, true)).toString());
refuses('3 bytes', () => decodeMesh(new ArrayBuffer(3)), /4 バイト/);
refuses('header longer than the buffer', () => { const b = bytes(meshBuf); new DataView(b.buffer).setUint32(0, b.length, true); decodeMesh(b.buffer); }, /超える/);
refuses('bad JSON', () => { const b = bytes(meshBuf); b[4] = 0x7b; b[5] = 0x7b; decodeMesh(b.buffer); }, /JSON/);
refuses('wrong format', () => decodeMesh(withHeader({ ...hdr, format: 'fieldframe/1' }, [coords, tris])), /形式/);
refuses('truncated by 4 bytes', () => decodeMesh(meshBuf.slice(0, meshBuf.byteLength - 4)), /長さ/);
refuses('arrays one byte late (padding off by one)', () => decodeMesh(ab(packRaw(hdr, [coords, tris], 1))), /長さ|詰め物/);
refuses('non-zero padding', () => {
  // a header whose JSON leaves some padding (lengthened a character at a time until it does)
  let b = null;
  for (let extra = 0; extra < 4 && !b; extra++) {
    const cand = packRaw({ ...hdr, source: { ...hdr.source, pad: 'x'.repeat(extra) } }, [coords, tris]);
    if ((4 + cand.readUInt32LE(0)) % 4 !== 0) b = cand;
  }
  b[4 + b.readUInt32LE(0)] = 7;
  decodeMesh(ab(b));
}, /詰め物/);
refuses('parts overlap', () => decodeMesh(withHeader({ ...hdr, parts: [hdr.parts[0], { ...hdr.parts[1], nodeStart: hdr.parts[1].nodeStart - 1 }] }, [coords, tris])), /始まる/);
refuses('parts leave nodes over', () => decodeMesh(withHeader({ ...hdr, parts: [hdr.parts[0]] }, [coords, tris])), /覆わない/);
refuses('a triangle reaching into another part', () => { const t2 = tris.slice(); t2[0] = heads[1].nodeStart + 1; decodeMesh(withHeader(hdr, [coords, t2])); }, /部品の節点/);
refuses('two parts with one name', () => decodeMesh(withHeader({ ...hdr, parts: [hdr.parts[0], { ...hdr.parts[1], name: hdr.parts[0].name }] }, [coords, tris])), /名前/);
refuses('a kind that is neither', () => decodeMesh(withHeader({ ...hdr, parts: [{ ...hdr.parts[0], kind: 'die' }, hdr.parts[1]] }, [coords, tris])), /kind/);
refuses('a frame of another mesh', () => decodeFrame(frameBuf, nodes - 1), /別の mesh/);
refuses('a field named twice', () => decodeFrame(ab(packRaw({ format: 'fieldframe/1', k: 1, fields: ['mises', 'mises'] }, [disp, mises, mises])), nodes), /重なって/);
refuses('a frame read as a mesh', () => decodeMesh(frameBuf), /形式/);

// ── 3. colours ──
{
  const values = Float32Array.from([10, 20, 30, NaN, Infinity, 9.999, 30.001, -Infinity]);
  const t = new Float32Array(values.length), v = new Float32Array(values.length);
  const c = normalizeInto(t, v, values, 10, 30);
  check('t at the range\'s ends', t[0] === 0 && t[2] === 1 && Math.abs(t[1] - 0.5) < 1e-7, `${t[0]} ${t[1]} ${t[2]}`);
  check('no value is not 0: NaN and ±∞ flagged', v[3] === 0 && v[4] === 0 && v[7] === 0 && v[0] === 1 && c.missing === 3, `missing ${c.missing}`);
  check('outside the range counted and kept outside', t[5] < 0 && t[6] > 1 && c.below === 1 && c.above === 1, `${t[5]} ${t[6]}`);
  const B = 10;
  check('bands: the ends in the first and last, outside flagged', bandOf(0, B) === 0 && bandOf(1, B) === B - 1 && bandOf(0.1, B) === 1 && bandOf(0.0999, B) === 0 && bandOf(-1e-6, B) === -1 && bandOf(1 + 1e-6, B) === B,
    `${[0, 0.0999, 0.1, 1, -1e-6, 1 + 1e-6].map((x) => bandOf(x, B)).join(' ')}`);
  check('continuous: 256 texels', bandOf(1, 0) === 255 && bandOf(0, 0) === 0 && bandOf(0.5, 0) === 128);
  const r = autoRange([Float32Array.from([3, NaN, 7]), Float32Array.from([5])], false);
  check('range: min … max over the parts, NaN skipped', r.lo === 3 && r.hi === 7 && !r.uniform && r.count === 3);
  const s = autoRange([Float32Array.from([-2, 5])], true);
  check('range: signed is symmetric', s.lo === -5 && s.hi === 5);
  const u = autoRange([new Float32Array(5)], false), un = autoRange([Float32Array.from([NaN])], true);
  check('range: one value everywhere, and nothing at all', u.uniform && u.lo === 0 && u.hi === 1 && un.uniform && un.lo === -1 && un.hi === 1 && un.count === 0);
  // the automatic top: 1000 values 0…999 and one far out at 10⁶ - the bar keeps the thousand
  const tail = new Float32Array(1001);
  for (let i = 0; i < 1000; i++) tail[i] = i;
  tail[1000] = 1e6;
  const q = quantile([tail], 1 - AUTO_TAIL), ra = rangeFor([tail], false, 'auto'), rf = rangeFor([tail], false, 'full');
  check('auto range: the top at the 99.5 % point, not the one outlier', ra.hi > 990 && ra.hi < 1e6 * 0.01 && rf.hi === 1e6 && q === ra.hi, `auto top ${ra.hi.toFixed(0)}, full ${rf.hi}`);
  check('fixed range as given', rangeFor([tail], false, 'fixed', { lo: 100, hi: 200 }).hi === 200);
}

// ── 4. surfaces ──
const volume = (c, t) => {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i], b = 3 * t[i + 1], d = 3 * t[i + 2];
    v += (c[a] * (c[b + 1] * c[d + 2] - c[b + 2] * c[d + 1]) - c[a + 1] * (c[b] * c[d + 2] - c[b + 2] * c[d]) + c[a + 2] * (c[b] * c[d + 1] - c[b + 1] * c[d])) / 6;
  }
  return v;
};
for (const p of rolls) {
  const R = p.name === 'WR' ? MILL_4HI.wrR : MILL_4HI.burR, Rn = p.name === 'WR' ? MILL_4HI.wrRn : MILL_4HI.burRn;
  const Lb = MILL_4HI.wrLb, Ls = p.name === 'WR' ? MILL_4HI.wrLs : MILL_4HI.burLs;
  // a quarter of each cylinder (x ≥ 0, z ≥ 0), polygons for the circles
  const n = g.arc, poly = (r) => 0.5 * n * r * r * Math.sin(Math.PI / n);
  const want = (poly(R) * Lb) / 2 + (poly(Rn) * (Ls - Lb)) / 2;
  const got = volume(p.coords, p.tris);
  check(`${p.name} faces outwards (volume)`, Math.abs(got / want - 1) < 0.02, `${got.toExponential(4)} m³ vs half-cylinders ${want.toExponential(4)}`);
}
{
  const st = synthStrip(1, MILL_4HI, g);
  const got = volume(st.part.coords, st.part.tris);
  check('strip faces outwards (volume > 0)', got > 0, `${got.toExponential(3)} m³`);
}
{
  // a cube sharing its 8 corners over 12 triangles, outward
  const c = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const q = (a, b, cc, d) => [a, b, cc, a, cc, d];
  const t = Uint32Array.from([...q(0, 3, 2, 1), ...q(4, 5, 6, 7), ...q(0, 1, 5, 4), ...q(1, 2, 6, 5), ...q(2, 3, 7, 6), ...q(3, 0, 4, 7)]);
  check('cube outward', Math.abs(volume(c, t) - 1) < 1e-6);
  const sp = splitCreases(c, t);
  const pos = new Float32Array(3 * sp.src.length);
  sp.src.forEach((s, i) => { pos[3 * i] = c[3 * s]; pos[3 * i + 1] = c[3 * s + 1]; pos[3 * i + 2] = c[3 * s + 2]; });
  const nrm = new Float32Array(pos.length);
  vertexNormals(pos, sp.tris, nrm);
  let axis = true;
  for (let i = 0; i < nrm.length; i += 3) axis &&= Math.abs(Math.abs(nrm[i]) + Math.abs(nrm[i + 1]) + Math.abs(nrm[i + 2]) - 1) < 1e-6;
  check('creases: a cube\'s corners split three ways, normals the axes', sp.src.length === 24 && axis, `${sp.src.length} vertices`);
  const e = meshEdges(t);
  check('mesh lines: a cube\'s 12 edges, no diagonals', e.length / 2 === 12, `${e.length / 2} edges`);
}
{
  const WR = rolls[0];
  const sp = splitCreases(WR.coords, WR.tris);
  // the synthetic roll's pieces (mantles, shoulder, ends, cuts) have their own nodes, each piece smooth
  check('creases: a smooth surface is not split', sp.src.length === WR.coords.length / 3, `${WR.coords.length / 3} nodes → ${sp.src.length} vertices`);
  const st = synthStrip(1, MILL_4HI, g).part;
  const e = meshEdges(st.tris);
  // the block's outer faces: nx×rows top and bottom, nx×lay entry and exit, rows×lay sides - edges of each face grid
  const grid2 = (a, b) => a * (b - 1) + b * (a - 1);
  const { nx, rows, lay } = g;
  const want = 2 * grid2(nx, rows) + 2 * grid2(nx, lay) + 2 * grid2(rows, lay) - 4 * (nx - 1) - 4 * (rows - 1) - 4 * (lay - 1);
  check('mesh lines: the strip block\'s element edges, each once', e.length / 2 === want, `${e.length / 2} (grid ${want})`);
}

// ── 5. the synthetic strip ──
{
  const m = MILL_4HI, { nx, rows, lay } = g;
  const st = synthStrip(50, m, g);
  const id = (i, j, k) => (i * rows + j) * lay + k;
  const ic = (nx - 1) / 2;
  const hom = (2 / Math.sqrt(3)) * Math.log(m.h0 / m.h1);
  const eqExit = st.values.fields.eq[id(ic, rows - 1, 0)];
  check('strip: exit strain on the mid-plane = (2/√3) ln(h₀/h₁)', Math.abs(eqExit / hom - 1) < 1e-4, `${eqExit.toFixed(5)} vs ${hom.toFixed(5)}`);
  const sIn = st.values.fields.s_zz[id(ic, 0, 0)], sOut = st.values.fields.s_zz[id(ic, rows - 1, 0)];
  check('strip: σ_zz the back tension at the entry, the front tension at the exit', Math.abs(sIn - m.backTension) < 1e3 && Math.abs(sOut - m.frontTension) < 1e3, `${(sIn / 1e6).toFixed(2)} / ${(sOut / 1e6).toFixed(2)} MPa`);
  const init = synthStrip(-1, m, g);
  check('strip: the initial state has no strain and no stress', init.values.fields.eq.every((v) => v === 0) && init.values.fields.s_zz.every((v) => v === 0));
  const big = synthGrid(200000);
  check('synthetic grid sizes to order', Math.abs(countNodes(big) / 200000 - 1) < 0.05 && countNodes(synthGrid(6000)) >= 6000, `${countNodes(big)} nodes for 200000`);
}

console.log(failed ? `\n${failed} FAIL` : '\nall PASS');
process.exit(failed ? 1 : 0);
