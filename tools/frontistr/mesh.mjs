// A roll as a solid-element mesh for FrontISTR: half of a stepped cylinder (z ≥ 0), the axis
// along x, in polar hexahedra (361) with a ring of prisms (351) on the axis. The stations along
// x are given (the roll model's, so the two solutions are read at the same x); the angle is
// graded fine at the bottom (the strip contact, φ = 0) and the top (the backup-roll contact,
// φ = π), the radius graded fine at the surface. FrontISTR's local numbering: a hexahedron's
// nodes 1-2-3-4 are one face and 5-6-7-8 the opposite one, in the same sense, with the
// 1→2→3 normal pointing at 5-6-7-8 (the volume comes out positive); a prism's 1-2-3 and 4-5-6
// likewise. Both are checked here on the first cell of each kind.
//
// Units are SI throughout (m, N, Pa): FrontISTR has none of its own.

/** node ids are 1-based, as FrontISTR's are */
export function halfCylinderMesh(o) {
  const { xs, radiusAt, arcCell, arcFine, arcGrowth, arcMax, layer0, layerGrowth, R0 } = o;
  // ── angle: cell sizes in arc length at R0, fine at both ends, mirrored about the middle ──
  const half = (Math.PI * R0) / 2;
  const sizes = [];
  let s = 0, h = arcCell;
  while (s < half) {
    if (s >= arcFine) h = Math.min(h * arcGrowth, arcMax);
    if (s + h > half) h = half - s;
    sizes.push(h); s += h;
    if (h < 1e-12) break;
  }
  const arc = [0];
  for (const h of sizes) arc.push(arc[arc.length - 1] + h);
  for (let i = sizes.length - 1; i >= 0; i--) arc.push(arc[arc.length - 1] + sizes[i]);
  const phi = arc.map((a) => a / R0);
  phi[phi.length - 1] = Math.PI;
  const nk = phi.length; // angular nodes, φ = 0 … π
  // ── radius: layer thicknesses from the surface inward at R0, the core to the axis ──
  const t = [];
  let sum = 0, tk = layer0;
  while (sum + tk < R0 * 0.999) { t.push(tk); sum += tk; tk *= layerGrowth; }
  t.push(R0 - sum);
  const xi = [1];
  let acc = 0;
  for (const th of t) { acc += th; xi.push(1 - acc / R0); }
  xi[xi.length - 1] = 0; // the axis
  xi.reverse(); // ascending: 0 (axis) … 1 (surface)
  const nr = xi.length - 1; // radial cells per station
  const ni = xs.length;
  // ── nodes ──
  // id(i, j, k): the axis (j = 0) has one node per station
  const nodes = [];
  const idOf = new Map();
  const key = (i, j, k) => i * 1e6 + j * 1e3 + k;
  const id = (i, j, k) => idOf.get(key(i, j === 0 ? 0 : j, j === 0 ? 0 : k));
  for (let i = 0; i < ni; i++) {
    const R = radiusAt(xs[i]);
    for (let j = 0; j <= nr; j++) {
      for (let k = 0; k < (j === 0 ? 1 : nk); k++) {
        const r = R * xi[j];
        const p = phi[k];
        nodes.push([xs[i], -r * Math.cos(p), r * Math.sin(p)]);
        idOf.set(key(i, j, k), nodes.length);
      }
    }
  }
  const P = (n) => nodes[n - 1];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // ── elements ──
  const hex = [], prism = [];
  let hexFlip = null, prismFlip = null;
  for (let i = 0; i + 1 < ni; i++) {
    for (let k = 0; k + 1 < nk; k++) {
      // the axis ring: a prism, triangle (axis, ring 1 at k, ring 1 at k+1) at x_i and at x_{i+1}
      {
        let a = [id(i, 0, 0), id(i, 1, k), id(i, 1, k + 1)], b = [id(i + 1, 0, 0), id(i + 1, 1, k), id(i + 1, 1, k + 1)];
        if (prismFlip === null) {
          const n = cross(sub(P(a[1]), P(a[0])), sub(P(a[2]), P(a[0])));
          prismFlip = dot(n, sub(P(b[0]), P(a[0]))) < 0;
        }
        if (prismFlip) { a = [a[0], a[2], a[1]]; b = [b[0], b[2], b[1]]; }
        prism.push([...a, ...b]);
      }
      for (let j = 1; j < nr; j++) {
        let a = [id(i, j, k), id(i, j, k + 1), id(i, j + 1, k + 1), id(i, j + 1, k)];
        let b = [id(i + 1, j, k), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i + 1, j + 1, k)];
        if (hexFlip === null) {
          const n = cross(sub(P(a[1]), P(a[0])), sub(P(a[2]), P(a[0])));
          hexFlip = dot(n, sub(P(b[0]), P(a[0]))) < 0;
        }
        if (hexFlip) { a = [a[0], a[3], a[2], a[1]]; b = [b[0], b[3], b[2], b[1]]; }
        hex.push([...a, ...b]);
      }
    }
  }
  return { nodes, hex, prism, id, phi, xi, nr, nk, ni };
}

/** the mesh file text: nodes, the two element blocks, one material and section, and the given groups */
export function meshText(m, o) {
  const L = [];
  L.push('!HEADER', ` ${o.header}`);
  L.push('!NODE');
  m.nodes.forEach((p, i) => L.push(` ${i + 1}, ${p[0].toPrecision(10)}, ${p[1].toPrecision(10)}, ${p[2].toPrecision(10)}`));
  let e = 0;
  L.push('!ELEMENT, TYPE=351, EGRP=ROLL');
  for (const c of m.prism) L.push(` ${++e}, ${c.join(', ')}`);
  L.push('!ELEMENT, TYPE=361, EGRP=ROLL');
  for (const c of m.hex) L.push(` ${++e}, ${c.join(', ')}`);
  L.push('!MATERIAL, NAME=STEEL, ITEM=1', '!ITEM=1, SUBITEM=2', ` ${o.E}, ${o.nu}`);
  L.push('!SECTION, TYPE=SOLID, EGRP=ROLL, MATERIAL=STEEL');
  for (const [name, ids] of Object.entries(o.ngroups)) {
    L.push(`!NGROUP, NGRP=${name}`);
    for (let i = 0; i < ids.length; i += 10) L.push(' ' + ids.slice(i, i + 10).join(', '));
  }
  L.push('!END');
  return L.join('\n') + '\n';
}
