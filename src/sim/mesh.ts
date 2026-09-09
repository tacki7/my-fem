/**
 * Structured meshes for the two bodies of a rolling stand.
 *
 * Both use a node numbering whose neighbours differ by at most (rows + 2), so
 * the assembled matrix stays banded and the LDL^T preconditioner in band.ts
 * works on either block.
 */

export interface Mesh {
  nn: number;
  ne: number;
  /** reference coordinates, xy interleaved */
  X: Float64Array;
  /** Q4 connectivity, CCW */
  quads: Int32Array;
  /** triangle index buffer for rendering, 6 per quad */
  tris: Uint32Array;
  /** line index buffer for the wireframe */
  edges: Uint32Array;
  /** rows of nodes through the thickness, used for the band width */
  rows: number;
}

/**
 * @param reverse emit each quad rows-first instead of columns-first. Needed
 *   whenever "column index increasing" and "row index increasing" form a
 *   left-handed pair - true for the roll, where columns run counter-clockwise
 *   around the barrel and rows run outward, so the naive order would wind
 *   clockwise and give negative element areas.
 */
function buildTopology(cols: number, rows: number, wrap: boolean, reverse: boolean): {
  quads: Int32Array; tris: Uint32Array; edges: Uint32Array; ne: number;
} {
  // node id = i * rows + j  (column major, so one column is contiguous)
  const nCells = wrap ? cols : cols - 1;
  const ne = nCells * (rows - 1);
  const quads = new Int32Array(4 * ne);
  let q = 0;
  for (let i = 0; i < nCells; i++) {
    const i1 = wrap ? (i + 1) % cols : i + 1;
    for (let j = 0; j < rows - 1; j++) {
      if (reverse) {
        quads[q++] = i * rows + j;
        quads[q++] = i * rows + j + 1;
        quads[q++] = i1 * rows + j + 1;
        quads[q++] = i1 * rows + j;
      } else {
        quads[q++] = i * rows + j;
        quads[q++] = i1 * rows + j;
        quads[q++] = i1 * rows + j + 1;
        quads[q++] = i * rows + j + 1;
      }
    }
  }
  const tris = new Uint32Array(6 * ne);
  for (let e = 0; e < ne; e++) {
    const a = quads[4 * e], b = quads[4 * e + 1], c = quads[4 * e + 2], d = quads[4 * e + 3];
    tris[6 * e] = a; tris[6 * e + 1] = b; tris[6 * e + 2] = c;
    tris[6 * e + 3] = a; tris[6 * e + 4] = c; tris[6 * e + 5] = d;
  }
  const edgeList: number[] = [];
  for (let i = 0; i < cols; i++) {
    const hasNext = wrap || i < cols - 1;
    const i1 = wrap ? (i + 1) % cols : i + 1;
    for (let j = 0; j < rows; j++) {
      if (hasNext) edgeList.push(i * rows + j, i1 * rows + j);
      if (j < rows - 1) edgeList.push(i * rows + j, i * rows + j + 1);
    }
  }
  return { quads, tris, edges: new Uint32Array(edgeList), ne };
}

/* ─────────────────────────────────────────────────────────── work roll ──── */

export interface RollMeshOptions {
  /** outer (barrel) radius [m] */
  R: number;
  /** rigid hub radius [m] */
  Rhub: number;
  /** circumferential divisions */
  nt: number;
  /** element rings between hub and barrel */
  nr: number;
  /** >1 concentrates elements at the barrel surface */
  radialGrade: number;
  /**
   * Thickness of a separately refined surface layer [m]. 0 falls back to the
   * single power-law grading.
   *
   * Contact stress under the bite decays over a depth of order the contact
   * length, so that is the only part of the barrel that needs fine elements;
   * the rest of the wall only has to carry the load back to the hub.
   */
  skinThickness: number;
  /** element rings inside the refined surface layer */
  skinRings: number;
  /**
   * 0 = uniform circumferential spacing, ->1 crowds nodes into the roll bite.
   * The contact arc is only a couple of percent of the circumference, so
   * without this the bite would be resolved by a handful of nodes.
   */
  biteGrade: number;
  /** roll centre in world coordinates */
  cx: number;
  cy: number;
}

export interface RollMesh extends Mesh {
  nt: number;
  nr: number;
  R: number;
  Rhub: number;
  cx: number;
  cy: number;
  /** node ids on the rigid hub */
  hubNodes: Int32Array;
  /** node ids on the barrel, ordered by increasing `theta` */
  surfNodes: Int32Array;
  /** polar angle of each barrel node, strictly increasing, spans 2*pi */
  theta: Float64Array;
  /** reference polar angle per node, for the surface marking shader */
  theta0: Float64Array;
  radius0: Float64Array;
  /** geometric growth ratio of the core rings towards the hub */
  coreGrowth: number;
}

/**
 * Radial node positions across the barrel wall.
 *
 * Without a skin layer this is a single power law refined towards the barrel
 * surface. Note the direction: `(j/nr)^g` with g > 1 makes the elements grow
 * outwards, which puts the coarsest element right where the contact is - the
 * opposite of what is wanted.
 *
 * With a skin layer the outer `skinRings` elements are uniform and `skinThickness`
 * deep, and the remaining wall is a geometric series whose outermost element
 * matches the skin element exactly, so the two zones meet without a jump.
 */
export function radialStations(
  Rhub: number, R: number, nr: number, grade: number,
  skinThickness: number, skinRings: number,
): { r: Float64Array; growth: number } {
  const r = new Float64Array(nr + 1);
  const wall = R - Rhub;
  const nSkin = Math.max(0, Math.min(nr - 1, Math.round(skinRings)));
  const tSkin = Math.min(Math.max(skinThickness, 0), wall * 0.9);

  if (nSkin < 1 || tSkin <= 0) {
    for (let j = 0; j <= nr; j++) {
      r[j] = Rhub + wall * (1 - Math.pow(1 - j / nr, grade));
    }
    r[0] = Rhub; r[nr] = R;
    return { r, growth: 1 };
  }

  const nCore = nr - nSkin;
  const rSkin = R - tSkin;
  const hSkin = tSkin / nSkin;
  let growth = 1;
  r[nr] = R;
  for (let k = 1; k <= nSkin; k++) r[nr - k] = R - k * hSkin;

  if (nCore > 0) {
    const L = rSkin - Rhub;
    const uniform = L / nCore;
    if (hSkin >= uniform) {
      for (let k = 1; k <= nCore; k++) r[nCore - k] = rSkin - k * uniform;
    } else {
      // solve hSkin * (q^nCore - 1) / (q - 1) = L for the growth ratio q > 1
      let lo = 1 + 1e-9, hi = 8;
      for (let it = 0; it < 60; it++) {
        const mid = 0.5 * (lo + hi);
        const sum = hSkin * (Math.pow(mid, nCore) - 1) / (mid - 1);
        if (sum < L) lo = mid; else hi = mid;
      }
      const q = 0.5 * (lo + hi);
      growth = q;
      // Element sizes are hSkin, hSkin*q, hSkin*q^2 ... going inward, matching
      // the series that was solved. Multiplying before the first use would put
      // the coarse end against the skin and leave the series short of the hub.
      let h = hSkin;
      for (let k = 1; k <= nCore; k++) {
        r[nCore - k] = r[nCore - k + 1] - h;
        h *= q;
      }
    }
  }
  r[0] = Rhub;
  return { r, growth };
}

export function buildRollMesh(o: RollMeshOptions): RollMesh {
  const { R, Rhub, nt, nr } = o;
  const rows = nr + 1;
  const nn = nt * rows;
  const X = new Float64Array(2 * nn);
  const theta0 = new Float64Array(nn);
  const radius0 = new Float64Array(nn);
  const theta = new Float64Array(nt);

  const w = Math.max(0, Math.min(0.995, o.biteGrade));
  // theta = -pi/2 + pi*((1-w)s + w s^3), s in [-1,1): monotone, periodic, and
  // densest at s = 0 which is the bottom of the roll, i.e. the bite.
  const NIP = -Math.PI / 2;

  const radial = radialStations(Rhub, R, nr, o.radialGrade, o.skinThickness, o.skinRings);
  const rStation = radial.r;

  for (let i = 0; i < nt; i++) {
    const s = -1 + (2 * i) / nt;
    const phi = Math.PI * ((1 - w) * s + w * s * s * s);
    const th = NIP + phi;
    theta[i] = th;
    const c = Math.cos(th), sn = Math.sin(th);
    for (let j = 0; j < rows; j++) {
      const r = rStation[j];
      const id = i * rows + j;
      X[2 * id] = o.cx + r * c;
      X[2 * id + 1] = o.cy + r * sn;
      theta0[id] = th;
      radius0[id] = r;
    }
  }

  const hubNodes = new Int32Array(nt);
  const surfNodes = new Int32Array(nt);
  for (let i = 0; i < nt; i++) {
    hubNodes[i] = i * rows;
    surfNodes[i] = i * rows + nr;
  }

  const topo = buildTopology(nt, rows, true, true);
  return {
    nn, ne: topo.ne, X, quads: topo.quads, tris: topo.tris, edges: topo.edges,
    rows, nt, nr, R, Rhub, cx: o.cx, cy: o.cy,
    hubNodes, surfNodes, theta, theta0, radius0,
    coreGrowth: radial.growth,
  };
}

/* ────────────────────────────────────────────────────────────── strip ───── */

export interface StripMeshOptions {
  /** element columns along the rolling direction */
  nx: number;
  /** element rows through the half thickness */
  ny: number;
  xIn: number;
  xOut: number;
  /** half of the entry thickness [m] (symmetry plane at y = 0) */
  halfThickness: number;
}

export interface StripMesh extends Mesh {
  nx: number;
  ny: number;
  /** nodes on the symmetry plane, v_y is constrained there */
  bottomNodes: Int32Array;
  /** nodes on the roll-facing surface, ordered from entry to exit */
  topNodes: Int32Array;
  /** node ids of the entry column (index 0) and the exit column */
  colStride: number;
}

export function buildStripMesh(o: StripMeshOptions): StripMesh {
  const cols = o.nx + 1;
  const rows = o.ny + 1;
  const nn = cols * rows;
  const X = new Float64Array(2 * nn);
  for (let i = 0; i < cols; i++) {
    const x = o.xIn + ((o.xOut - o.xIn) * i) / o.nx;
    for (let j = 0; j < rows; j++) {
      const id = i * rows + j;
      X[2 * id] = x;
      X[2 * id + 1] = (o.halfThickness * j) / o.ny;
    }
  }
  const bottomNodes = new Int32Array(cols);
  const topNodes = new Int32Array(cols);
  for (let i = 0; i < cols; i++) {
    bottomNodes[i] = i * rows;
    topNodes[i] = i * rows + o.ny;
  }
  const topo = buildTopology(cols, rows, false, false);
  return {
    nn, ne: topo.ne, X, quads: topo.quads, tris: topo.tris, edges: topo.edges,
    rows, nx: o.nx, ny: o.ny, bottomNodes, topNodes, colStride: rows,
  };
}
