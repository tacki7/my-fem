/**
 * The strip in the bite as a field in three dimensions, for drawing: the material FEM's mesh
 * (the 3D one's bricks, or the plane one's quadrilaterals stood up through the half thickness)
 * with values at its nodes, and the block's outer faces as triangles.
 *
 * Read from a converged solve and nothing else: building it changes no number the solve hands
 * back. Coordinates are the FEMs' own - x across the width, y up from the strip's mid-plane
 * (the upper half, 0 … h/2), z along the rolling direction with the entry at −L and the exit
 * at 0 (under the roll axes).
 *
 * The values, per node (the mean of the elements around it, by their centroid values):
 * - `eqRate` equivalent strain rate ε̇_eq [1/s]
 * - `eq` equivalent strain this pass has added, 0 at the entry face: steady flow, so the
 *   strain is the rate integrated along the path, ε = ∫ ε̇_eq ds / |v|, taken along each line
 *   of nodes from the entry to the exit (the path the material takes, to the mesh's
 *   resolution). The incoming strip's own prestrain is not in it
 * - `p` hydrostatic pressure −σ_m [Pa] (the incompressibility penalty's mean stress)
 * - `s_zz` rolling-direction stress σ_zz = s_zz + σ_m [Pa] (tension +)
 *   (these two are extrapolated onto the entry and exit faces from the rows inside; see below)
 * - `flow` the flow stress σ̄ the element was solved with [Pa]
 * - `vx`, `vy`, `vz` the velocity [m/s]
 */

export interface StripField3D {
  model: 'fem' | 'fem3d';
  /** node columns across the width, rows along the arc, layers through the half thickness; node (i, j, k) is (i·rows + j)·lay + k */
  nx: number;
  rows: number;
  lay: number;
  /** x, y, z per node [m] */
  coords: Float32Array;
  /** the block's outer faces, two triangles a quadrilateral, counter-clockwise seen from outside */
  tris: Uint32Array;
  fields: {
    eq: Float32Array; eqRate: Float32Array; p: Float32Array; s_zz: Float32Array; flow: Float32Array;
    vx: Float32Array; vy: Float32Array; vz: Float32Array;
  };
}

/** per element, at its centroid, and its corner nodes */
export interface StripElementValues {
  /** corner nodes, `per` of them per element */
  nodes: Int32Array;
  per: number;
  eqRate: Float64Array;
  /** mean stress σ_m [Pa] */
  sm: Float64Array;
  /** deviatoric rolling-direction stress [Pa] */
  szz: Float64Array;
  flow: Float64Array;
}

/**
 * The outer faces of a structured block of nx × rows × lay nodes: top (k = lay − 1, the roll
 * face) and bottom (the mid-plane), entry (j = 0) and exit, the two side faces (the strip edges,
 * or one edge and the centre on a half strip). Each quadrilateral as two triangles turned out.
 */
export function blockTris(nx: number, rows: number, lay: number): Uint32Array {
  const id = (i: number, j: number, k: number) => (i * rows + j) * lay + k;
  const out: number[] = [];
  // a quad a-b-c-d counter-clockwise seen from outside
  const quad = (a: number, b: number, c: number, d: number) => { out.push(a, b, c, a, c, d); };
  // the index directions: i → +x, j → +z, k → +y
  for (let i = 0; i < nx - 1; i++) for (let j = 0; j < rows - 1; j++) {
    const t = lay - 1;
    // top, seen from +y: +z then +x is counter-clockwise
    quad(id(i, j, t), id(i, j + 1, t), id(i + 1, j + 1, t), id(i + 1, j, t));
    quad(id(i, j, 0), id(i + 1, j, 0), id(i + 1, j + 1, 0), id(i, j + 1, 0));
  }
  for (let i = 0; i < nx - 1; i++) for (let k = 0; k < lay - 1; k++) {
    const e = rows - 1;
    // entry face, seen from −z
    quad(id(i, 0, k), id(i, 0, k + 1), id(i + 1, 0, k + 1), id(i + 1, 0, k));
    quad(id(i, e, k), id(i + 1, e, k), id(i + 1, e, k + 1), id(i, e, k + 1));
  }
  for (let j = 0; j < rows - 1; j++) for (let k = 0; k < lay - 1; k++) {
    const s = nx - 1;
    // the −x side, seen from −x
    quad(id(0, j, k), id(0, j + 1, k), id(0, j + 1, k + 1), id(0, j, k + 1));
    quad(id(s, j, k), id(s, j, k + 1), id(s, j + 1, k + 1), id(s, j + 1, k));
  }
  return Uint32Array.from(out);
}

/**
 * The field from element centroid values and nodal velocities: nodal means of the element
 * values, then the strain integrated along each node line from the entry.
 */
export function buildStripField(
  model: 'fem' | 'fem3d', nx: number, rows: number, lay: number,
  X: ArrayLike<number>, Y: ArrayLike<number>, Z: ArrayLike<number>,
  vel: { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number> },
  el: StripElementValues,
): StripField3D {
  const nn = nx * rows * lay;
  const acc = { eqRate: new Float64Array(nn), sm: new Float64Array(nn), szz: new Float64Array(nn), flow: new Float64Array(nn) };
  const cnt = new Float64Array(nn);
  const ne = el.eqRate.length;
  for (let e = 0; e < ne; e++) {
    for (let q = 0; q < el.per; q++) {
      const n = el.nodes[el.per * e + q];
      acc.eqRate[n] += el.eqRate[e]; acc.sm[n] += el.sm[e]; acc.szz[n] += el.szz[e]; acc.flow[n] += el.flow[e];
      cnt[n] += 1;
    }
  }
  const f32 = () => new Float32Array(nn);
  const fields = { eq: f32(), eqRate: f32(), p: f32(), s_zz: f32(), flow: f32(), vx: f32(), vy: f32(), vz: f32() };
  const coords = new Float32Array(3 * nn);
  for (let n = 0; n < nn; n++) {
    const c = Math.max(cnt[n], 1);
    const sm = acc.sm[n] / c;
    fields.eqRate[n] = acc.eqRate[n] / c;
    fields.p[n] = -sm;
    fields.s_zz[n] = acc.szz[n] / c + sm;
    fields.flow[n] = acc.flow[n] / c;
    fields.vx[n] = vel.x[n]; fields.vy[n] = vel.y[n]; fields.vz[n] = vel.z[n];
    coords[3 * n] = X[n]; coords[3 * n + 1] = Y[n]; coords[3 * n + 2] = Z[n];
  }
  const id = (i: number, j: number, k: number) => (i * rows + j) * lay + k;
  // The stresses on the entry and exit faces, extrapolated from the two element rows inside. A
  // node there has only the last row of elements to average, whose centroids are half a row
  // into the bite, where σ_zz is still far from the applied tension: on the 4Hi default (8 rows)
  // the exit face read 10 MPa against a front tension of 75. Linear from the last two rows
  // (2 n₀ − n₁ at the nodes, which is 1.5 r₀ − 0.5 r₁ in element rows) reads 70.
  if (rows >= 3) {
    for (const f of [fields.p, fields.s_zz]) {
      for (let i = 0; i < nx; i++) for (let k = 0; k < lay; k++) {
        const e0 = id(i, 0, k), e1 = id(i, 1, k), x0 = id(i, rows - 1, k), x1 = id(i, rows - 2, k);
        const entry = 2 * f[e0] - f[e1], exit = 2 * f[x0] - f[x1];
        f[e0] = entry; f[x0] = exit;
      }
    }
  }
  // the strain along each line of nodes, entry to exit: dε = ε̇ dt, dt = ds / |v| (trapezoid)
  for (let i = 0; i < nx; i++) for (let k = 0; k < lay; k++) {
    let eps = 0;
    fields.eq[id(i, 0, k)] = 0;
    for (let j = 1; j < rows; j++) {
      const a = id(i, j - 1, k), b = id(i, j, k);
      const ds = Math.hypot(X[b] - X[a], Y[b] - Y[a], Z[b] - Z[a]);
      const va = Math.max(Math.hypot(vel.x[a], vel.y[a], vel.z[a]), 1e-12), vb = Math.max(Math.hypot(vel.x[b], vel.y[b], vel.z[b]), 1e-12);
      eps += 0.5 * (fields.eqRate[a] / va + fields.eqRate[b] / vb) * ds;
      fields.eq[b] = eps;
    }
  }
  return { model, nx, rows, lay, coords, tris: blockTris(nx, rows, lay), fields };
}
