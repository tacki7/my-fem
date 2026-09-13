/**
 * Plane-strain Q4 element kernels.
 *
 * Stiffness uses selective reduced integration (SRI): the shear/deviatoric term
 * is integrated with 2x2 Gauss, the volumetric (lambda) term with a single
 * centroid point. That kills the volumetric locking that otherwise makes a
 * fully integrated Q4 useless for rubber (nu -> 0.5) while keeping full rank,
 * so no hourglass stabilisation is needed.
 *
 * The material is linear, so the element stiffness in the *material* frame is
 * constant and precomputed once. The spinning roll needs no co-rotational
 * update - the ring is solved in the stand's frame, where a turned ring is the
 * same ring, and its spin only moves the surface markings (`solver.ts`). An
 * earlier version of this comment promised such an update; there is none.
 *
 * Checked against an exact rational stiffness on a parallelogram
 * (tools/exact): equal to 4e-16, rank 5 with the three rigid modes as the
 * kernel - no hourglass mode survives the full 2x2 deviatoric integration.
 */

/** 1/sqrt(3) Gauss stations for 2x2 quadrature. */
const G = 1 / Math.sqrt(3);
const GP: [number, number][] = [
  [-G, -G], [G, -G], [G, G], [-G, G],
];

/** dN/dxi, dN/deta for the 4 nodes at (xi, eta). */
function shapeDerivs(xi: number, eta: number, out: Float64Array): void {
  // node local coords: (-1,-1) (1,-1) (1,1) (-1,1)
  out[0] = -0.25 * (1 - eta); out[1] = -0.25 * (1 - xi);
  out[2] = 0.25 * (1 - eta);  out[3] = -0.25 * (1 + xi);
  out[4] = 0.25 * (1 + eta);  out[5] = 0.25 * (1 + xi);
  out[6] = -0.25 * (1 + eta); out[7] = 0.25 * (1 - xi);
}

/**
 * What the solver keeps for the life of a mesh.
 *
 * Deliberately small. Everything here is per element and the roll mesh can
 * carry ten thousand of them across eight stands, so an array that is written
 * once and never read again is not a rounding error - it is megabytes.
 */
export interface ElementGeometry {
  ne: number;
  /**
   * Cartesian shape derivatives dN/dx, dN/dy at the 4 Gauss points,
   * layout: [elem][gp][node][xy] -> 4*4*2 = 32 doubles per element.
   * Read every frame by the stress recovery.
   */
  dN: Float64Array;
  /** Element area [m^2]; the weight the stress average uses. */
  area: Float64Array;
}

export interface ElementData extends ElementGeometry {
  /**
   * Local (material frame) 8x8 stiffness per element, row-major, 64 per elem.
   *
   * **Transient.** It exists to be summed into the global matrix and has no
   * reader afterwards - a material change recomputes it from scratch rather
   * than re-reading it. At 512 bytes an element it is by far the largest thing
   * here, so the caller assembles from it and lets it go; see
   * `assembleStiffness`.
   */
  Ke: Float64Array;
}

export interface Material {
  /** Young's modulus [Pa] */
  E: number;
  /** Poisson ratio */
  nu: number;
  /** Density [kg/m^3] */
  rho: number;
}

/** Plane-strain Lame parameters. */
export function lame(m: Material): { lambda: number; mu: number } {
  const mu = m.E / (2 * (1 + m.nu));
  const lambda = (m.E * m.nu) / ((1 + m.nu) * (1 - 2 * m.nu));
  return { lambda, mu };
}

/**
 * Precompute per-element geometry and the SRI stiffness in the material frame.
 */
export function precomputeElements(
  X: Float64Array,
  quads: Int32Array,
  mat: Material,
): ElementData {
  const ne = quads.length / 4;
  const Ke = new Float64Array(64 * ne);
  const dNAll = new Float64Array(32 * ne);
  const area = new Float64Array(ne);

  const { lambda, mu } = lame(mat);

  const dNref = new Float64Array(8);
  const dNxy = new Float64Array(8);
  const xe = new Float64Array(8);
  // B is 3x8 for [exx, eyy, gxy]
  const B = new Float64Array(24);
  const Bv = new Float64Array(8); // volumetric row at centroid: [dNx, dNy] pairs

  for (let e = 0; e < ne; e++) {
    for (let k = 0; k < 4; k++) {
      const n = quads[4 * e + k];
      xe[2 * k] = X[2 * n];
      xe[2 * k + 1] = X[2 * n + 1];
    }

    const Kbase = 64 * e;
    let A = 0;

    // --- deviatoric / shear term, full 2x2 Gauss ---
    for (let g = 0; g < 4; g++) {
      shapeDerivs(GP[g][0], GP[g][1], dNref);
      let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
      for (let k = 0; k < 4; k++) {
        J00 += dNref[2 * k] * xe[2 * k];
        J01 += dNref[2 * k] * xe[2 * k + 1];
        J10 += dNref[2 * k + 1] * xe[2 * k];
        J11 += dNref[2 * k + 1] * xe[2 * k + 1];
      }
      const det = J00 * J11 - J01 * J10;
      const inv = 1 / det;
      A += det; // weight 1 per point for 2x2 Gauss on [-1,1]^2

      for (let k = 0; k < 4; k++) {
        const dx = inv * (J11 * dNref[2 * k] - J01 * dNref[2 * k + 1]);
        const dy = inv * (-J10 * dNref[2 * k] + J00 * dNref[2 * k + 1]);
        dNxy[2 * k] = dx;
        dNxy[2 * k + 1] = dy;
        dNAll[32 * e + 8 * g + 2 * k] = dx;
        dNAll[32 * e + 8 * g + 2 * k + 1] = dy;
        B[2 * k] = dx;          B[2 * k + 1] = 0;
        B[8 + 2 * k] = 0;       B[8 + 2 * k + 1] = dy;
        B[16 + 2 * k] = dy;     B[16 + 2 * k + 1] = dx;
      }

      // D_mu = 2*mu*diag(1, 1, 0.5) acting on [exx, eyy, gxy]
      // Ke += w*det * B^T D_mu B
      const w = det;
      const c1 = 2 * mu * w;
      const c2 = mu * w; // 2*mu*0.5
      for (let a = 0; a < 8; a++) {
        const b0 = B[a], b1 = B[8 + a], b2 = B[16 + a];
        for (let b = a; b < 8; b++) {
          const v = c1 * (b0 * B[b] + b1 * B[8 + b]) + c2 * (b2 * B[16 + b]);
          Ke[Kbase + a * 8 + b] += v;
          if (b !== a) Ke[Kbase + b * 8 + a] += v;
        }
      }
    }

    // --- volumetric (lambda) term, single centroid point: kills locking ---
    {
      shapeDerivs(0, 0, dNref);
      let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
      for (let k = 0; k < 4; k++) {
        J00 += dNref[2 * k] * xe[2 * k];
        J01 += dNref[2 * k] * xe[2 * k + 1];
        J10 += dNref[2 * k + 1] * xe[2 * k];
        J11 += dNref[2 * k + 1] * xe[2 * k + 1];
      }
      const det = J00 * J11 - J01 * J10;
      const inv = 1 / det;
      for (let k = 0; k < 4; k++) {
        const dx = inv * (J11 * dNref[2 * k] - J01 * dNref[2 * k + 1]);
        const dy = inv * (-J10 * dNref[2 * k] + J00 * dNref[2 * k + 1]);
        Bv[2 * k] = dx;
        Bv[2 * k + 1] = dy;
      }
      // D_lambda = lambda * m m^T with m = [1,1,0]; B^T m = [dNx, dNy]
      const w = 4 * det; // one point with weight 4 covers [-1,1]^2
      const cl = lambda * w;
      for (let a = 0; a < 8; a++) {
        for (let b = a; b < 8; b++) {
          const v = cl * Bv[a] * Bv[b];
          Ke[Kbase + a * 8 + b] += v;
          if (b !== a) Ke[Kbase + b * 8 + a] += v;
        }
      }
    }

    area[e] = A;
  }

  return { ne, Ke, dN: dNAll, area };
}

/**
 * Sum the local stiffnesses into the global CSR values, then hand back only
 * the geometry worth keeping.
 *
 * The stiffness is the whole reason `precomputeElements` allocates its largest
 * array, and once it is in the matrix nothing reads it again - so assembly and
 * the decision to drop it belong in one place, where they cannot drift apart.
 */
export function assembleStiffness(
  data: ElementData, scatter: Int32Array, vals: Float64Array,
): ElementGeometry {
  vals.fill(0);
  const { ne, Ke } = data;
  for (let e = 0; e < ne; e++) {
    const base = 64 * e;
    for (let i = 0; i < 64; i++) vals[scatter[base + i]] += Ke[base + i];
  }
  return { ne, dN: data.dN, area: data.area };
}

/** Lumped nodal mass [kg] for unit out-of-plane thickness. */
export function lumpedMass(
  nn: number,
  quads: Int32Array,
  area: Float64Array,
  rho: number,
): Float64Array {
  const m = new Float64Array(nn);
  const ne = area.length;
  for (let e = 0; e < ne; e++) {
    const share = (rho * area[e]) / 4;
    m[quads[4 * e]] += share;
    m[quads[4 * e + 1]] += share;
    m[quads[4 * e + 2]] += share;
    m[quads[4 * e + 3]] += share;
  }
  return m;
}
