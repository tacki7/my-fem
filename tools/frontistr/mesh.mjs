// A roll as a solid-element mesh for FrontISTR: half of a stepped cylinder (z ≥ 0), the axis
// along x at height cy, in polar hexahedra (361) with a ring of prisms (351) on the axis. The
// stations along x are given (the roll model's, so the two solutions are read at the same x);
// the angle is graded fine at the bottom (φ = 0, the strip or the roll below) and, if asked, at
// the top (φ = π, the roll above), the radius graded fine at the surface. FrontISTR's local
// numbering: a hexahedron's nodes 1-2-3-4 are one face and 5-6-7-8 the opposite one in the same
// sense, the 1→2→3 normal pointing at 5-6-7-8 (a positive volume); a prism's 1-2-3 and 4-5-6
// likewise; its faces are 1: 1-2-3-4, 2: 5-6-7-8, 3: 1-2-6-5, 4: 2-3-7-6, 5: 3-4-8-7, 6: 4-1-5-8.
// Both orientations are checked on the first cell of each kind and the numbering turned round
// if it came out negative - which is why the outer face's number is asked of the mesh.
//
// Node and element ids are 1-based and global: a second body starts where the first ended.
// Units are SI throughout (m, N, Pa): FrontISTR has none of its own.

export function halfCylinderMesh(o) {
  const { xs, radiusAt, arcCell, arcFine, arcGrowth, arcMax, layer0, layerGrowth, R0 } = o;
  const cy = o.cy ?? 0, nodeStart = o.nodeStart ?? 1, elemStart = o.elemStart ?? 1, fineTop = o.fineTop ?? true;
  // ── angle: cell sizes in arc length at R0 from the bottom, fine there (and at the top) ──
  const full = Math.PI * R0;
  const grow = (from, to) => { // fine cells then geometric growth from arc position `from` to `to`
    const out = []; let s = from, h = arcCell;
    while (s < to - 1e-12) { if (s - from >= arcFine) h = Math.min(h * arcGrowth, arcMax); if (s + h > to) h = to - s; out.push(h); s += h; }
    return out;
  };
  let sizes;
  if (fineTop) { const a = grow(0, full / 2); sizes = [...a, ...a.slice().reverse()]; }
  else sizes = grow(0, full);
  const arc = [0];
  for (const h of sizes) arc.push(arc[arc.length - 1] + h);
  const phi = arc.map((a) => a / R0);
  phi[phi.length - 1] = Math.PI;
  const nk = phi.length;
  // ── radius: layer thicknesses from the surface inward at R0, the core to the axis ──
  const t = [];
  let sum = 0, tk = layer0;
  while (sum + tk < R0 * 0.999) { t.push(tk); sum += tk; tk *= layerGrowth; }
  t.push(R0 - sum);
  const xi = [1];
  let acc = 0;
  for (const th of t) { acc += th; xi.push(1 - acc / R0); }
  xi[xi.length - 1] = 0;
  xi.reverse(); // 0 (axis) … 1 (surface)
  const nr = xi.length - 1;
  const ni = xs.length;
  // ── nodes ──
  const nodes = [];
  const idOf = new Map();
  const key = (i, j, k) => i * 1e6 + j * 1e3 + k;
  const id = (i, j, k) => idOf.get(key(i, j === 0 ? 0 : j, j === 0 ? 0 : k));
  for (let i = 0; i < ni; i++) {
    const R = radiusAt(xs[i]);
    for (let j = 0; j <= nr; j++) {
      for (let k = 0; k < (j === 0 ? 1 : nk); k++) {
        const r = R * xi[j], p = phi[k];
        nodes.push([xs[i], cy - r * Math.cos(p), r * Math.sin(p)]);
        idOf.set(key(i, j, k), nodeStart + nodes.length - 1);
      }
    }
  }
  const P = (n) => nodes[n - nodeStart];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // ── elements: prisms (i, k) then hexahedra (i, k, j), ids in that order from elemStart ──
  const prism = [], hex = [];
  let hexFlip = null, prismFlip = null;
  for (let i = 0; i + 1 < ni; i++) {
    for (let k = 0; k + 1 < nk; k++) {
      let a = [id(i, 0, 0), id(i, 1, k), id(i, 1, k + 1)], b = [id(i + 1, 0, 0), id(i + 1, 1, k), id(i + 1, 1, k + 1)];
      if (prismFlip === null) prismFlip = dot(cross(sub(P(a[1]), P(a[0])), sub(P(a[2]), P(a[0]))), sub(P(b[0]), P(a[0]))) < 0;
      if (prismFlip) { a = [a[0], a[2], a[1]]; b = [b[0], b[2], b[1]]; }
      prism.push([...a, ...b]);
    }
  }
  const hexIndex = new Map();
  for (let i = 0; i + 1 < ni; i++) {
    for (let k = 0; k + 1 < nk; k++) {
      for (let j = 1; j < nr; j++) {
        let a = [id(i, j, k), id(i, j, k + 1), id(i, j + 1, k + 1), id(i, j + 1, k)];
        let b = [id(i + 1, j, k), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i + 1, j + 1, k)];
        if (hexFlip === null) hexFlip = dot(cross(sub(P(a[1]), P(a[0])), sub(P(a[2]), P(a[0]))), sub(P(b[0]), P(a[0]))) < 0;
        if (hexFlip) { a = [a[0], a[3], a[2], a[1]]; b = [b[0], b[3], b[2], b[1]]; }
        hexIndex.set(key(i, j, k), hex.length);
        hex.push([...a, ...b]);
      }
    }
  }
  const prismId = (i, k) => elemStart + i * (nk - 1) + k;
  const hexId = (i, j, k) => elemStart + prism.length + hexIndex.get(key(i, j, k));
  // the outer face of the surface cell (i, k): nodes 3-4-7-8 of the unflipped cell (face 5), 2-3-7-6 when flipped (face 4)
  const outerFace = (i, k) => [hexId(i, nr - 1, k), hexFlip ? 4 : 5];
  return { nodes, hex, prism, id, prismId, hexId, outerFace, phi, xi, nr, nk, ni, nodeStart, elemStart, elemEnd: elemStart + prism.length + hex.length - 1 };
}

/**
 * The mesh file: every body's nodes and elements (each body an element group with its own
 * section of one steel), then the node groups, surface groups and contact pairs given.
 */
export function meshText(bodies, o) {
  const L = [];
  L.push('!HEADER', ` ${o.header}`);
  L.push('!NODE');
  for (const b of bodies) b.mesh.nodes.forEach((p, i) => L.push(` ${b.mesh.nodeStart + i}, ${p[0].toPrecision(10)}, ${p[1].toPrecision(10)}, ${p[2].toPrecision(10)}`));
  for (const b of bodies) {
    let e = b.mesh.elemStart;
    L.push(`!ELEMENT, TYPE=351, EGRP=${b.name}`);
    for (const c of b.mesh.prism) L.push(` ${e++}, ${c.join(', ')}`);
    L.push(`!ELEMENT, TYPE=361, EGRP=${b.name}`);
    for (const c of b.mesh.hex) L.push(` ${e++}, ${c.join(', ')}`);
  }
  L.push('!MATERIAL, NAME=STEEL, ITEM=1', '!ITEM=1, SUBITEM=2', ` ${o.E}, ${o.nu}`);
  for (const b of bodies) L.push(`!SECTION, TYPE=SOLID, EGRP=${b.name}, MATERIAL=STEEL`);
  for (const [name, ids] of Object.entries(o.ngroups ?? {})) {
    L.push(`!NGROUP, NGRP=${name}`);
    for (let i = 0; i < ids.length; i += 10) L.push(' ' + ids.slice(i, i + 10).join(', '));
  }
  for (const [name, faces] of Object.entries(o.sgroups ?? {})) {
    L.push(`!SGROUP, SGRP=${name}`);
    for (let i = 0; i < faces.length; i += 5) L.push(' ' + faces.slice(i, i + 5).map(([e, f]) => `${e}, ${f}`).join(', '));
  }
  for (const [name, [slave, master]] of Object.entries(o.contactPairs ?? {})) L.push(`!CONTACT PAIR, NAME=${name}`, ` ${slave}, ${master}`);
  L.push('!END');
  return L.join('\n') + '\n';
}
