// FrontISTR's mesh and results as the app draws them (the "fieldframe" format): the outer
// surface of every body, renumbered over the surface's own nodes, written once (mesh.bin),
// and per result file the displacement and the nodal fields on those nodes (frames/<k>.bin).
//
//   mesh.bin:  u32 headerBytes, header JSON, 0-3 zero bytes to a 4-byte boundary,
//              f32 coords[3·nodeCount], u32 tris[3·triCount]
//   frame:     u32 headerBytes, header JSON, padding, f32 disp[3·nodeCount], then one
//              f32[nodeCount] per name in header.fields
//
// Little-endian throughout; SI units (m, Pa, N). Coordinates as FrontISTR has them: x along the
// roll axis (the width), y vertical (away from the strip +), z along the rolling direction.
// Only the surface is sent: the symmetry planes are surfaces too, so the cut through a body
// shows as a face.

/** FrontISTR's local face numbering (mesh.mjs): hexahedron 361 and prism 351 */
const FACES = {
  361: [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
  351: [[0, 1, 2], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]],
};
const NODES_OF = { 361: 8, 351: 6 };

/**
 * The mesh file (!NODE, !ELEMENT with TYPE and EGRP) as nodes and element groups. Only what the
 * surface needs: node coordinates by id, and each element's type, node ids and group.
 */
export function parseMsh(text) {
  const nodes = new Map();
  const elems = [];
  let mode = '', type = 0, egrp = '';
  let pending = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('!')) {
      const head = line.toUpperCase();
      mode = head.startsWith('!NODE') ? 'node' : head.startsWith('!ELEMENT') ? 'elem' : '';
      if (mode === 'elem') {
        type = Number(/TYPE\s*=\s*(\d+)/i.exec(line)?.[1] ?? 0);
        egrp = /EGRP\s*=\s*([^,\s]+)/i.exec(line)?.[1] ?? '';
      }
      pending = null;
      continue;
    }
    if (mode === 'node') {
      const [id, x, y, z] = line.split(',').map((s) => Number(s));
      nodes.set(id, [x, y, z]);
    } else if (mode === 'elem') {
      const vals = line.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      // an element's node list may run over more than one line
      if (pending) { pending.push(...vals); } else { pending = vals; }
      if (pending.length >= 1 + NODES_OF[type]) {
        elems.push({ id: pending[0], type, egrp, nodes: pending.slice(1, 1 + NODES_OF[type]) });
        pending = null;
      }
    }
  }
  return { nodes, elems };
}

/**
 * The outer surface of each element group: every element face that no other element of the same
 * group shares, turned to face outwards (its normal away from its element's centre), split into
 * triangles, the nodes renumbered part by part. Parts come in the order `order` gives (groups not
 * named there follow in file order).
 */
export function extractSurface(msh, { order = [], kinds = {} } = {}) {
  const groups = [];
  for (const e of msh.elems) if (!groups.includes(e.egrp)) groups.push(e.egrp);
  groups.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  const P = (id) => msh.nodes.get(id);
  const parts = [], coords = [], tris = [], nodeIds = [];
  for (const g of groups) {
    const faces = new Map();
    for (const e of msh.elems) {
      if (e.egrp !== g) continue;
      const c = [0, 0, 0];
      for (const n of e.nodes) { const p = P(n); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
      c[0] /= e.nodes.length; c[1] /= e.nodes.length; c[2] /= e.nodes.length;
      for (const f of FACES[e.type]) {
        const ids = f.map((k) => e.nodes[k]);
        const key = [...ids].sort((a, b) => a - b).join(',');
        if (faces.has(key)) faces.get(key).shared = true;
        else faces.set(key, { ids, c, shared: false });
      }
    }
    const local = new Map();
    const nodeStart = coords.length / 3, triStart = tris.length / 3;
    const at = (id) => {
      let k = local.get(id);
      if (k === undefined) { k = nodeStart + local.size; local.set(id, k); const p = P(id); coords.push(p[0], p[1], p[2]); nodeIds.push(id); }
      return k;
    };
    for (const f of faces.values()) {
      if (f.shared) continue;
      let ids = f.ids;
      // outward: the face's normal (Newell) against the direction from the element's centre
      const n = [0, 0, 0], m = [0, 0, 0];
      for (let i = 0; i < ids.length; i++) {
        const a = P(ids[i]), b = P(ids[(i + 1) % ids.length]);
        n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
        m[0] += a[0] / ids.length; m[1] += a[1] / ids.length; m[2] += a[2] / ids.length;
      }
      if (n[0] * (m[0] - f.c[0]) + n[1] * (m[1] - f.c[1]) + n[2] * (m[2] - f.c[2]) < 0) ids = [...ids].reverse();
      const k = ids.map(at);
      tris.push(k[0], k[1], k[2]);
      if (k.length === 4) tris.push(k[0], k[2], k[3]);
    }
    parts.push({ name: g, kind: kinds[g] ?? 'roll', nodeStart, nodeCount: local.size, triStart, triCount: tris.length / 3 - triStart });
  }
  return { parts, coords: Float32Array.from(coords), tris: Uint32Array.from(tris), nodeIds: Int32Array.from(nodeIds) };
}

/** header JSON, padding, then the arrays, as one buffer */
function pack(header, arrays) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const head = 4 + json.length;
  const pad = (4 - (head % 4)) % 4;
  const size = head + pad + arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = Buffer.alloc(size);
  out.writeUInt32LE(json.length, 0);
  json.copy(out, 4);
  let o = head + pad;
  for (const a of arrays) {
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(out, o);
    o += a.byteLength;
  }
  return out;
}

/** the surface as mesh.bin */
export function encodeMesh(surface, { symmetry = { x: true, y: false }, source = {} } = {}) {
  const header = {
    format: 'fieldframe-mesh/1', nodeCount: surface.coords.length / 3, triCount: surface.tris.length / 3,
    parts: surface.parts, symmetry, source,
  };
  return pack(header, [surface.coords, surface.tris]);
}

/** one frame: the surface nodes' displacement and fields (each f32[nodeCount], NaN where a part has none) */
export function encodeFrame({ k, increment = k, time = 0, travel = 0, metrics = {} }, disp, fields) {
  const names = Object.keys(fields);
  const header = { format: 'fieldframe/1', k, increment, time, travel, fields: names, metrics };
  return pack(header, [disp, ...names.map((n) => fields[n])]);
}

/** the header of a mesh or frame buffer, and where its arrays start (for tests and tools) */
export function readHeader(buf) {
  const len = buf.readUInt32LE(0);
  const header = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  const start = 4 + len + ((4 - ((4 + len) % 4)) % 4);
  return { header, start };
}

/**
 * The per-node area of the surface, a third of each triangle's area to each of its corners,
 * for turning a nodal contact force into a pressure.
 */
export function nodalAreas(surface) {
  const n = surface.coords.length / 3, A = new Float64Array(n), c = surface.coords, t = surface.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i], b = 3 * t[i + 1], d = 3 * t[i + 2];
    const u = [c[b] - c[a], c[b + 1] - c[a + 1], c[b + 2] - c[a + 2]], v = [c[d] - c[a], c[d + 1] - c[a + 1], c[d + 2] - c[a + 2]];
    const area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    A[t[i]] += area / 3; A[t[i + 1]] += area / 3; A[t[i + 2]] += area / 3;
  }
  return A;
}

/**
 * A parsed result (lib.mjs parseRes) on the surface nodes: displacement, and the fields the app
 * draws - `mises` from NodalMISES / NMISES when the case wrote it, `cpress` the contact normal
 * force over the node's surface area. Sums for the headline numbers go in `metrics`.
 */
export function frameFromResult(surface, res, areas = nodalAreas(surface)) {
  const n = surface.nodeIds.length;
  const disp = new Float32Array(3 * n);
  const fields = {};
  const lab = (want) => res.labels.find((l) => want.some((w) => l.toUpperCase() === w));
  const LD = lab(['DISPLACEMENT']), LM = lab(['NODALMISES', 'NMISES', 'MISES']), LC = lab(['CONTACT_NFORCE']), LR = lab(['REACTION_FORCE']);
  if (LM) fields.mises = new Float32Array(n);
  if (LC) fields.cpress = new Float32Array(n);
  let contact = 0, reaction = 0, misesMax = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    const rec = res.node.get(surface.nodeIds[i]);
    if (!rec) { disp[3 * i] = disp[3 * i + 1] = disp[3 * i + 2] = NaN; if (LM) fields.mises[i] = NaN; if (LC) fields.cpress[i] = NaN; continue; }
    if (LD) { const d = rec[LD]; disp[3 * i] = d[0]; disp[3 * i + 1] = d[1]; disp[3 * i + 2] = d[2]; if (!d.every(Number.isFinite)) bad++; }
    if (LM) { const m = rec[LM][0]; fields.mises[i] = m; if (m > misesMax) misesMax = m; }
    if (LC) { const f = rec[LC]; const fn = Math.hypot(f[0], f[1], f[2]); fields.cpress[i] = areas[i] > 0 ? fn / areas[i] : 0; }
  }
  // the sums run over every node of the result, not only the surface's
  for (const rec of res.node.values()) {
    if (LC) contact += Math.abs(rec[LC][1]);
    if (LR) reaction += rec[LR][1];
  }
  return { disp, fields, metrics: { contactForceY: contact, reactionY: reaction, misesMax: LM ? misesMax : null, nonFinite: bad } };
}
