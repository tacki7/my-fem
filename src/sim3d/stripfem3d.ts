/**
 * The strip in the bite as a three-dimensional rigid-plastic FEM.
 *
 * Where `stripfem.ts` takes the thickness direction as a uniform velocity
 * (a thin strip), this meshes it: eight-node bricks across the width, along
 * the rolling direction and through the upper half of the thickness (the
 * mid-plane is a plane of symmetry, v = 0 there), and solves the steady
 * velocity field u = (u, v, w) of the flow formulation - Markov's
 * functional with the flow stress σ̄ ε̇_eq, incompressibility by a penalty
 * at the element centre (selective reduced integration), and the roll
 * surface as a boundary condition rather than a contact search: the mesh
 * conforms to the roll gap h(x, z), and on that surface the normal velocity
 * is penalised to zero (the material stays on the roll), the penalty's
 * reaction being the contact pressure, with Coulomb friction against the
 * roll's surface speed built on the pressure of the previous iterate. So
 * the roll pressure, the friction hill, the forward slip, the lateral
 * spread and the through-thickness velocity profile (the inhomogeneity the
 * thin-strip model averages away) all come out of the one solve.
 *
 * What it hands back is the same as the plane FEM's - the load per column,
 * the exit velocity per column (elongation, lateral flow), the pressure
 * field on the roll face - so the coupling to the roll stack is the same
 * defect correction (see `femCorrection` in the solver).
 *
 * Cost: on the default 35 columns × 8 rows × 2 layers the system has ~2800
 * unknowns in a band of ~90, one Cholesky a few milliseconds and a warm
 * solve a few Picard rounds; several times the plane FEM, still live.
 */

import { BandMatrix } from './band';
import { FLOW, type StripFemInput, type StripFemResult } from './stripfem';

export interface StripFem3DInput extends StripFemInput {
  /** element layers through the upper half of the thickness */
  ny: number;
}

const G = 1 / Math.sqrt(3);
/** 2×2×2 Gauss points in (ξ, η, ζ) */
const GP3: [number, number, number][] = [];
for (const a of [-G, G]) for (const b of [-G, G]) for (const c of [-G, G]) GP3.push([a, b, c]);
/** conjugate-gradient limits for the Picard linear solves (see `linearSolve`) */
const PCG_MAX = 40;
const PCG_REFACTOR_AT = 12;
const PCG_TOL = 1e-9;
/** corner signs of the hex, in the node order used below */
const SX = [-1, 1, 1, -1, -1, 1, 1, -1];
const SY = [-1, -1, -1, -1, 1, 1, 1, 1];
const SZ = [-1, -1, 1, 1, -1, -1, 1, 1];

export class StripFem3D {
  private u: Float64Array | null = null;
  private pFace: Float64Array | null = null;
  private nx = 0;
  private nz = 0;
  private ny = 0;
  /** the last solve's stiffness was not positive definite (a diagnostic) */
  singular = false;
  /**
   * The linear solve of each Picard iteration reuses a Cholesky factor.
   * Assembling K is cheap; factorising it (n hb² ≈ 26 M flops on the
   * default mesh) is what the 3D FEM spent three quarters of its time on,
   * once per Picard iteration. Between iterations - and between calls, as
   * the rolls settle - K changes little: the penalty and constraint rows
   * are the same, only the frozen viscosities and friction slopes move. So
   * K x = f is solved by conjugate gradients preconditioned with the factor
   * of an earlier K (one back-substitution per iteration, a twenty-fifth of
   * a factorisation), from the previous iterate; the factor is refreshed
   * when that takes more than a dozen iterations.
   */
  private K: BandMatrix | null = null;
  private P: BandMatrix | null = null;
  private refactor = true;
  private pcg: { r: Float64Array; z: Float64Array; d: Float64Array; kd: Float64Array } | null = null;
  /** counts from the last solve, for diagnostics */
  stats = { picard: 0, factorizations: 0, pcgIterations: 0 };

  solve(inp: StripFem3DInput): StripFemResult {
    const nx = inp.x.length, nz = Math.max(2, Math.round(inp.nz)), ny = Math.max(1, Math.round(inp.ny));
    const rows = nz + 1, lay = ny + 1;
    const nn = nx * rows * lay;
    const ndof = 3 * nn;
    const node = (i: number, j: number, k: number) => (i * rows + j) * lay + k;
    const V = inp.vRoll;
    const ne = (nx - 1) * nz * ny;
    const nface = (nx - 1) * nz;
    if (!this.u || this.nx !== nx || this.nz !== nz || this.ny !== ny) {
      this.u = new Float64Array(ndof);
      for (let n = 0; n < nn; n++) this.u[3 * n + 2] = V;
      this.pFace = null;
      this.nx = nx; this.nz = nz; this.ny = ny;
    }
    const u = this.u;
    const seed = !this.pFace;
    if (!this.pFace) this.pFace = new Float64Array(nx * rows);
    const pFace = this.pFace;

    // node coordinates: x at the columns, z along the arc, y up through the
    // upper half of the gap
    const X = new Float64Array(nn), Y = new Float64Array(nn), Z = new Float64Array(nn);
    const hAt = (i: number, j: number) => { const t = 1 - j / nz; return inp.h1[i] + (inp.h0[i] - inp.h1[i]) * t * t; };
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < rows; j++) {
        const t = 1 - j / nz;
        const h = hAt(i, j);
        for (let k = 0; k < lay; k++) {
          const n = node(i, j, k);
          X[n] = inp.x[i];
          Z[n] = -t * inp.L[i];
          Y[n] = (0.5 * h * k) / ny;
        }
      }
    }
    // connectivity
    const conn = new Int32Array(8 * ne);
    const elCol = new Int32Array(ne), elRow = new Int32Array(ne), elLay = new Int32Array(ne);
    {
      let e = 0;
      for (let i = 0; i < nx - 1; i++) for (let j = 0; j < nz; j++) for (let k = 0; k < ny; k++) {
        const c = [node(i, j, k), node(i + 1, j, k), node(i + 1, j + 1, k), node(i, j + 1, k),
          node(i, j, k + 1), node(i + 1, j, k + 1), node(i + 1, j + 1, k + 1), node(i, j + 1, k + 1)];
        for (let q = 0; q < 8; q++) conn[8 * e + q] = c[q];
        elCol[e] = i; elRow[e] = j; elLay[e] = k;
        e++;
      }
    }
    // flow stress per element from the strain at its centre (thickness strain per column)
    const kfEl = new Float64Array(ne);
    for (let e = 0; e < ne; e++) {
      const i = elCol[e], j = elRow[e];
      const h = 0.5 * (hAt(i, j) + hAt(i, j + 1)), h0 = inp.h0[i];
      const eps = (2 / Math.sqrt(3)) * Math.log(h0 / Math.max(h, 1e-9));
      kfEl[e] = 0.5 * (inp.kf(i, eps) + inp.kf(Math.min(i + 1, nx - 1), eps));
    }
    // scales
    let Lm = 0, dhm = 0, hm = 0, kfm = 0;
    for (let i = 0; i < nx; i++) { Lm += inp.L[i]; dhm += inp.h0[i] - inp.h1[i]; hm += inp.h1[i]; }
    for (let e = 0; e < ne; e++) kfm += kfEl[e];
    Lm /= nx; dhm /= nx; hm /= nx; kfm /= Math.max(ne, 1);
    const epsRef = Math.max((V * dhm) / (hm * Math.max(Lm, 1e-6)), 1e-3);
    const epsReg = 0.02 * epsRef;
    const muRef = kfm / epsRef;
    const KPEN = 60 * muRef;
    const hEl = (0.5 * hm) / ny;
    const KN = (200 * muRef) / Math.max(hEl, 1e-6);
    const vReg = 0.03 * V;
    const KTIE = 1e3 * muRef * hm;
    const BIG = 1e12 * muRef * hm;

    // shape derivatives per element and Gauss point (8 × 24), the centroid
    // ones, and the weights
    const dN = new Float64Array(ne * 8 * 24), wgt = new Float64Array(ne * 8);
    const dNc = new Float64Array(ne * 24), wc = new Float64Array(ne);
    const Nn = new Float64Array(8 * 8);
    {
      const xe = new Float64Array(8), ye = new Float64Array(8), ze = new Float64Array(8);
      const dref = new Float64Array(24);
      const shape = (xi: number, et: number, ze_: number, outN: Float64Array | null, offN: number) => {
        for (let q = 0; q < 8; q++) {
          const a = 1 + SX[q] * xi, b = 1 + SY[q] * et, c = 1 + SZ[q] * ze_;
          if (outN) outN[offN + q] = 0.125 * a * b * c;
          dref[3 * q] = 0.125 * SX[q] * b * c;
          dref[3 * q + 1] = 0.125 * SY[q] * a * c;
          dref[3 * q + 2] = 0.125 * SZ[q] * a * b;
        }
      };
      const cart = (out: Float64Array, off: number): number => {
        const J = new Float64Array(9);
        for (let q = 0; q < 8; q++) {
          J[0] += dref[3 * q] * xe[q]; J[1] += dref[3 * q] * ye[q]; J[2] += dref[3 * q] * ze[q];
          J[3] += dref[3 * q + 1] * xe[q]; J[4] += dref[3 * q + 1] * ye[q]; J[5] += dref[3 * q + 1] * ze[q];
          J[6] += dref[3 * q + 2] * xe[q]; J[7] += dref[3 * q + 2] * ye[q]; J[8] += dref[3 * q + 2] * ze[q];
        }
        const det = J[0] * (J[4] * J[8] - J[5] * J[7]) - J[1] * (J[3] * J[8] - J[5] * J[6]) + J[2] * (J[3] * J[7] - J[4] * J[6]);
        const inv = 1 / det;
        const I = [
          (J[4] * J[8] - J[5] * J[7]) * inv, (J[2] * J[7] - J[1] * J[8]) * inv, (J[1] * J[5] - J[2] * J[4]) * inv,
          (J[5] * J[6] - J[3] * J[8]) * inv, (J[0] * J[8] - J[2] * J[6]) * inv, (J[2] * J[3] - J[0] * J[5]) * inv,
          (J[3] * J[7] - J[4] * J[6]) * inv, (J[1] * J[6] - J[0] * J[7]) * inv, (J[0] * J[4] - J[1] * J[3]) * inv,
        ];
        for (let q = 0; q < 8; q++) {
          const a = dref[3 * q], b = dref[3 * q + 1], c = dref[3 * q + 2];
          out[off + 3 * q] = I[0] * a + I[1] * b + I[2] * c;
          out[off + 3 * q + 1] = I[3] * a + I[4] * b + I[5] * c;
          out[off + 3 * q + 2] = I[6] * a + I[7] * b + I[8] * c;
        }
        return det;
      };
      for (let g = 0; g < 8; g++) shape(GP3[g][0], GP3[g][1], GP3[g][2], Nn, 8 * g);
      for (let e = 0; e < ne; e++) {
        for (let q = 0; q < 8; q++) { const n = conn[8 * e + q]; xe[q] = X[n]; ye[q] = Y[n]; ze[q] = Z[n]; }
        for (let g = 0; g < 8; g++) { shape(GP3[g][0], GP3[g][1], GP3[g][2], null, 0); wgt[8 * e + g] = cart(dN, (8 * e + g) * 24); }
        shape(0, 0, 0, null, 0);
        wc[e] = 8 * cart(dNc, e * 24);
      }
    }
    // The roll face is the top node layer (k = ny). The constraint - the
    // material stays on the roll, u·n = 0 - is imposed node by node with
    // the surface's own normal there (the parabola's, analytic along z,
    // by differences across x) and a lumped tributary area. One constraint
    // per node: imposing it per face Gauss point over-constrained the nodes
    // shared by two facets whose normals differ, and the reaction to that -
    // proportional to the penalty stiffness - showed up as a spurious
    // pressure that grew with every layer added. The roll's surface speed
    // at a node runs along the surface's z-tangent.
    const surf: number[] = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < rows; j++) surf.push(node(i, j, ny));
    const sN = new Float64Array(surf.length * 3), sVr = new Float64Array(surf.length * 3), sA = new Float64Array(surf.length);
    const sCol = new Int32Array(surf.length), sRow = new Int32Array(surf.length);
    surf.forEach((n, m) => {
      const i = Math.floor(m / rows), j = m % rows;
      sCol[m] = i; sRow[m] = j;
      const t = 1 - j / nz;
      const L = inp.L[i];
      // d(h/2)/dz on the parabola h = h1 + (h0 − h1) (z/L)², z = −tL
      const dhdz = L > 0 ? (0.5 * 2 * (inp.h0[i] - inp.h1[i]) * (-t * L)) / (L * L) : 0;
      const ia = Math.max(0, i - 1), ib = Math.min(nx - 1, i + 1);
      const dhdx = ib > ia ? (0.5 * (hAt(ib, j) - hAt(ia, j))) / (inp.x[ib] - inp.x[ia]) : 0;
      let nxv = -dhdx, nyv = 1, nzv = -dhdz;
      const nl = Math.hypot(nxv, nyv, nzv);
      nxv /= nl; nyv /= nl; nzv /= nl;
      sN[3 * m] = nxv; sN[3 * m + 1] = nyv; sN[3 * m + 2] = nzv;
      const tl = Math.hypot(dhdz, 1);
      sVr[3 * m] = 0; sVr[3 * m + 1] = (V * dhdz) / tl; sVr[3 * m + 2] = V / tl;
      // tributary area: half the column width (a full one inside) times half the row length on each side
      const wx = (i === 0 || i === nx - 1 ? 0.5 : 1) * inp.w[i];
      const dz = L / nz;
      const wz = (j === 0 || j === nz ? 0.5 : 1) * dz;
      sA[m] = wx * wz * tl;
    });
    const pNode = new Float64Array(surf.length);
    if (seed) pNode.fill(kfm); else {
      // carry the last solve's pressure over from the face store
      for (let m = 0; m < surf.length; m++) pNode[m] = pFace[Math.min(pFace.length - 1, m)];
    }

    // the farthest coupling in an element is (i, j, k) to (i+1, j+1, k+1):
    // a node-id difference of (rows + 1) lay + 1, three DOFs each, plus two
    const hb = 3 * ((rows + 1) * lay + 1) + 2;
    if (!this.K || this.K.n !== ndof || this.K.hb !== hb) {
      this.K = new BandMatrix(ndof, hb);
      this.P = new BandMatrix(ndof, hb);
      this.refactor = true;
      this.pcg = { r: new Float64Array(ndof), z: new Float64Array(ndof), d: new Float64Array(ndof), kd: new Float64Array(ndof) };
    }
    const K = this.K;
    const rhs = new Float64Array(ndof);
    const unew = new Float64Array(ndof);
    this.stats = { picard: 0, factorizations: 0, pcgIterations: 0 };
    const ue = new Float64Array(24);
    const ke = new Float64Array(576);
    const gvec = new Float64Array(24);
    let iterations = 0, converged = false;
    this.singular = false;
    for (let it = 0; it < 40; it++) {
      iterations = it + 1;
      K.clear(); rhs.fill(0);
      for (let e = 0; e < ne; e++) {
        for (let q = 0; q < 8; q++) { const n = conn[8 * e + q]; ue[3 * q] = u[3 * n]; ue[3 * q + 1] = u[3 * n + 1]; ue[3 * q + 2] = u[3 * n + 2]; }
        ke.fill(0);
        const kf = kfEl[e];
        for (let g = 0; g < 8; g++) {
          const off = (8 * e + g) * 24;
          // strain rates
          let exx = 0, eyy = 0, ezz = 0, gxy = 0, gyz = 0, gzx = 0;
          for (let q = 0; q < 8; q++) {
            const dx = dN[off + 3 * q], dy = dN[off + 3 * q + 1], dz = dN[off + 3 * q + 2];
            const ux = ue[3 * q], uy = ue[3 * q + 1], uz = ue[3 * q + 2];
            exx += dx * ux; eyy += dy * uy; ezz += dz * uz;
            gxy += dy * ux + dx * uy; gyz += dz * uy + dy * uz; gzx += dz * ux + dx * uz;
          }
          const eq = Math.sqrt((2 / 3) * (exx * exx + eyy * eyy + ezz * ezz) + (gxy * gxy + gyz * gyz + gzx * gzx) / 3 + epsReg * epsReg);
          // σ̄ ε̇_eq with σ̄ the uniaxial flow stress (see `FLOW`): kf is the plane-strain resistance
          const c = ((FLOW * kf) / eq) * wgt[8 * e + g];
          // K += c Bᵀ M B, M = diag(2/3 ×3, 1/3 ×3)
          for (let a = 0; a < 8; a++) {
            const ax = dN[off + 3 * a], ay = dN[off + 3 * a + 1], az = dN[off + 3 * a + 2];
            for (let b = 0; b < 8; b++) {
              const bx = dN[off + 3 * b], by = dN[off + 3 * b + 1], bz = dN[off + 3 * b + 2];
              const r = a * 3 * 24 + b * 3;
              ke[r] += c * ((2 / 3) * ax * bx + (1 / 3) * (ay * by + az * bz));
              ke[r + 1] += c * ((1 / 3) * ay * bx);
              ke[r + 2] += c * ((1 / 3) * az * bx);
              ke[r + 24] += c * ((1 / 3) * ax * by);
              ke[r + 25] += c * ((2 / 3) * ay * by + (1 / 3) * (ax * bx + az * bz));
              ke[r + 26] += c * ((1 / 3) * az * by);
              ke[r + 48] += c * ((1 / 3) * ax * bz);
              ke[r + 49] += c * ((1 / 3) * ay * bz);
              ke[r + 50] += c * ((2 / 3) * az * bz + (1 / 3) * (ax * bx + ay * by));
            }
          }
        }
        // volumetric penalty at the centroid
        {
          const off = e * 24;
          for (let q = 0; q < 24; q++) gvec[q] = dNc[off + q];
          const c = KPEN * wc[e];
          for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) ke[a * 24 + b] += c * gvec[a] * gvec[b];
        }
        for (let a = 0; a < 8; a++) {
          const na = conn[8 * e + a];
          for (let b = 0; b < 8; b++) {
            const nb = conn[8 * e + b];
            for (let da = 0; da < 3; da++) for (let db = 0; db < 3; db++) {
              const ia = 3 * na + da, ib = 3 * nb + db;
              if (ib > ia) continue;
              K.add(ia, ib, ke[(3 * a + da) * 24 + 3 * b + db]);
            }
          }
        }
      }
      // the roll face: nodal normal penalty and Coulomb friction
      for (let m = 0; m < surf.length; m++) {
        const n0 = surf[m];
        const n = [sN[3 * m], sN[3 * m + 1], sN[3 * m + 2]];
        const vr = [sVr[3 * m], sVr[3 * m + 1], sVr[3 * m + 2]];
        const A = sA[m];
        const cn = KN * A;
        for (let da = 0; da < 3; da++) for (let db = 0; db <= da; db++) K.add(3 * n0 + da, 3 * n0 + db, cn * n[da] * n[db]);
        const p = Math.max(pNode[m], 0);
        const rel = [u[3 * n0] - vr[0], u[3 * n0 + 1] - vr[1], u[3 * n0 + 2] - vr[2]];
        const rn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
        const rt0 = rel[0] - rn * n[0], rt1 = rel[1] - rn * n[1], rt2 = rel[2] - rn * n[2];
        const rmag = Math.sqrt(rt0 * rt0 + rt1 * rt1 + rt2 * rt2 + vReg * vReg);
        const cf = (inp.mu * p * A) / rmag;
        const vn = vr[0] * n[0] + vr[1] * n[1] + vr[2] * n[2];
        const vt = [vr[0] - vn * n[0], vr[1] - vn * n[1], vr[2] - vn * n[2]];
        for (let da = 0; da < 3; da++) {
          for (let db = 0; db <= da; db++) K.add(3 * n0 + da, 3 * n0 + db, cf * ((da === db ? 1 : 0) - n[da] * n[db]));
          rhs[3 * n0 + da] += cf * vt[da];
        }
      }
      // symmetry (v = 0 on the mid-plane), rigid entry (u = v = 0, w tied),
      // tensions as tractions on the entry and exit faces
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < rows; j++) {
          const n0 = node(i, j, 0);
          K.add(3 * n0 + 1, 3 * n0 + 1, BIG);
        }
        const hIn = inp.h0[i] / 2, hOut = inp.h1[i] / 2;
        for (let k = 0; k < lay; k++) {
          const nIn = node(i, 0, k), nOut = node(i, nz, k);
          const share = k === 0 || k === ny ? 0.5 / ny : 1 / ny;
          rhs[3 * nIn + 2] -= inp.sigmaB[i] * hIn * inp.w[i] * share;
          rhs[3 * nOut + 2] += inp.sigmaF[i] * hOut * inp.w[i] * share;
          // the incoming strip is rigid across and along (u = 0, w tied);
          // its thickness velocity is left free - pinning v on the entry
          // face fought the roll-face constraint at the top node, where the
          // material has to start moving inward
          K.add(3 * nIn, 3 * nIn, BIG);
          // tie w to the next entry node (along the column, then across)
          if (k < ny) { const m = node(i, 0, k + 1); K.add(3 * nIn + 2, 3 * nIn + 2, KTIE); K.add(3 * m + 2, 3 * m + 2, KTIE); K.add(3 * m + 2, 3 * nIn + 2, -KTIE); }
          if (k === 0 && i < nx - 1) { const m = node(i + 1, 0, 0); K.add(3 * nIn + 2, 3 * nIn + 2, KTIE); K.add(3 * m + 2, 3 * m + 2, KTIE); K.add(3 * m + 2, 3 * nIn + 2, -KTIE); }
        }
      }
      this.stats.picard++;
      if (!this.linearSolve(rhs, u, unew, V)) { this.singular = true; break; }
      let du = 0, un = 0;
      for (let d = 0; d < ndof; d++) { du = Math.max(du, Math.abs(unew[d] - u[d])); un = Math.max(un, Math.abs(unew[d])); }
      u.set(unew);
      // contact pressure from the nodal normal penalty, damped for the friction
      for (let m = 0; m < surf.length; m++) {
        const n0 = surf[m];
        const un_ = u[3 * n0] * sN[3 * m] + u[3 * n0 + 1] * sN[3 * m + 1] + u[3 * n0 + 2] * sN[3 * m + 2];
        const p = KN * un_;
        pNode[m] += 0.8 * (p - pNode[m]);
        if (!Number.isFinite(pNode[m])) pNode[m] = kfm;
      }
      if (du < 1e-5 * Math.max(un, V)) { converged = true; break; }
    }

    // outputs per column: the load from the nodal normal forces, the face
    // pressure map from the node means, exit and entry velocities
    for (let m = 0; m < surf.length; m++) pFace[Math.min(pFace.length - 1, m)] = pNode[m];
    const q = new Float64Array(nx), vExit = new Float64Array(nx), uExit = new Float64Array(nx), eps = new Float64Array(nx);
    const pOut = new Float64Array(nface), uxOut = new Float64Array(nface);
    // the load per unit width of a column: its nodes' vertical normal
    // forces over the width they stand for (half a column at the edges,
    // where the mesh ends at the column centre)
    for (let m = 0; m < surf.length; m++) {
      const i = sCol[m];
      const wx = (i === 0 || i === nx - 1 ? 0.5 : 1) * inp.w[i];
      q[i] += (Math.max(pNode[m], 0) * sA[m] * sN[3 * m + 1]) / wx;
    }
    const pAt = (i: number, j: number) => pNode[i * rows + j];
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < nz; j++) {
        pOut[i * nz + j] = 0.25 * (Math.max(pAt(i, j), 0) + Math.max(pAt(i + 1, j), 0) + Math.max(pAt(i, j + 1), 0) + Math.max(pAt(i + 1, j + 1), 0));
        let ux = 0;
        for (const [ii, jj] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) ux += 0.25 * u[3 * node(ii, jj, ny)];
        uxOut[i * nz + j] = ux;
      }
    }
    for (let i = 0; i < nx; i++) {
      // exit velocity: the mean of w through the thickness at the exit face (trapezoid)
      let s = 0, sx = 0, wsum = 0;
      for (let k = 0; k < lay; k++) {
        const m = node(i, nz, k);
        const wk = k === 0 || k === ny ? 0.5 : 1;
        s += wk * u[3 * m + 2]; sx += wk * u[3 * m]; wsum += wk;
      }
      vExit[i] = s / wsum; uExit[i] = sx / wsum;
    }
    const vIn = u[3 * node(0, 0, 0) + 2];
    let flowIn = 0, flowOut = 0;
    for (let i = 0; i < nx; i++) {
      eps[i] = Math.log(Math.max(vExit[i], 1e-9) / Math.max(vIn, 1e-9));
      flowIn += inp.h0[i] * vIn * inp.w[i];
      flowOut += inp.h1[i] * vExit[i] * inp.w[i];
    }
    return {
      q, vExit, uExit, vIn, eps, p: pOut, ux: uxOut, ncol: nx - 1, nrow: nz,
      massRatio: flowIn > 0 ? flowOut / flowIn : 1, iterations, converged,
      debug: { sy: new Float64Array(0), sz: new Float64Array(0), sm: new Float64Array(0), div: new Float64Array(0), eq: new Float64Array(0) },
    };
  }
  /**
   * K x = rhs for the assembled K: preconditioned conjugate gradients from
   * x0 with the kept factor, or a fresh factorisation when there is none,
   * when conjugate gradients stall, or when the last solve needed many
   * iterations. The stopping test is on the preconditioned residual, which
   * with a factor of a nearby K is close to the error itself; it is set far
   * under the Picard tolerance so the answer is the same as a direct solve.
   */
  private linearSolve(rhs: Float64Array, x0: Float64Array, x: Float64Array, V: number): boolean {
    const K = this.K!, P = this.P!, w = this.pcg!;
    const n = K.n;
    const direct = (): boolean => {
      P.a.set(K.a);
      this.stats.factorizations++;
      if (!P.cholesky()) { this.refactor = true; return false; }
      this.refactor = false;
      P.solve(rhs, x);
      return true;
    };
    if (this.refactor) return direct();
    const { r, z, d, kd } = w;
    x.set(x0);
    K.mulVec(x, kd);
    let xmax = 0;
    for (let i = 0; i < n; i++) { r[i] = rhs[i] - kd[i]; xmax = Math.max(xmax, Math.abs(x[i])); }
    const tol = PCG_TOL * Math.max(V, xmax);
    P.solve(r, z);
    let rz = 0;
    for (let i = 0; i < n; i++) { d[i] = z[i]; rz += r[i] * z[i]; }
    let it = 0;
    for (; it < PCG_MAX; it++) {
      let zmax = 0;
      for (let i = 0; i < n; i++) zmax = Math.max(zmax, Math.abs(z[i]));
      if (zmax <= tol) break;
      K.mulVec(d, kd);
      let dkd = 0;
      for (let i = 0; i < n; i++) dkd += d[i] * kd[i];
      if (!(dkd > 0) || !(rz > 0)) { it = PCG_MAX; break; }
      const alpha = rz / dkd;
      for (let i = 0; i < n; i++) { x[i] += alpha * d[i]; r[i] -= alpha * kd[i]; }
      P.solve(r, z);
      let rzNew = 0;
      for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) d[i] = z[i] + beta * d[i];
    }
    this.stats.pcgIterations += it;
    if (it >= PCG_MAX) return direct();
    if (it > PCG_REFACTOR_AT) this.refactor = true;
    return true;
  }

}
