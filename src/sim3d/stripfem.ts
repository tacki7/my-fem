/**
 * The strip in the bite as a thin-strip rigid-plastic FEM in plan view.
 *
 * The material between the rolls is meshed across the width (one column per
 * strip station of the roll model) and along the rolling direction (nz rows
 * from entry to exit), and solved for the steady velocity field u = (u_x,
 * u_z) - the classical flow formulation the 2D tab uses, in the plane of
 * the strip rather than in its section. Through the thickness the velocity
 * is taken uniform (the strip is thin), and the thickness itself is not an
 * unknown: it is the roll gap h(x, z), which the roll stack's deflection,
 * flattening and crown set. Incompressibility then reads div(h u) = 0 - the
 * mass flow through the gap - and is enforced by a penalty at the element
 * centre, whose multiplier is the hydrostatic pressure.
 *
 * Markov's functional, per unit area of the plan view:
 *
 *     Π(u) = ∫ σ̄ ε̇_eq h dA + (K/2) ∫ (div(h u))²/h dA + friction work − tension work
 *
 * with ε̇_eq from the in-plane strain rates and ε̇_y = −(ε̇_x + ε̇_z). ε̇_eq is
 * the von Mises equivalent rate, so σ̄ is the uniaxial flow stress,
 * σ̄ = (√3/2) kf: plane-strain compression then yields at 2σ̄/√3 = kf. (σ̄
 * used to be kf itself, which made the strip 15 % harder than the slab
 * slices and the 2D tab - the 2D solve converts the same way.)
 * Friction is Coulomb on both faces against the roll surface speed,
 * regularised (Picard-frozen), with the contact pressure recovered from the
 * previous iterate: p = −σ_y = −(s_y + σ_m), s_y the deviatoric stress
 * through the thickness and σ_m the penalty pressure. So the friction hill
 * is a result here, not an input: friction drags the material, the drag
 * builds longitudinal compression, and the yield condition turns that into
 * pressure - the von Kármán balance, integrated by the FEM rather than
 * assumed per slice. Lateral flow (a slice spreading towards the edge
 * instead of elongating) is the other thing the slab slices cannot do.
 *
 * Boundary conditions: the incoming strip is a rigid body, so the entry
 * nodes share one longitudinal velocity (tied) and have no lateral one;
 * the exit and the edges are free, with the front and back tensions as
 * tractions. The roll speed is the velocity scale (rate-independent
 * material), the entry speed comes out of the friction balance.
 *
 * What comes out per column: the load q(x) = ∫ p dz, and the exit velocity,
 * whose distribution across the width is the elongation distribution the
 * tension model wants (mass flow: a column that ends up thinner - or that
 * loses material sideways - leaves faster).
 */

import { BandMatrix } from './band';

/** uniaxial flow stress over plane-strain resistance, σ̄ = FLOW · kf (von Mises) */
export const FLOW = Math.sqrt(3) / 2;

/**
 * The width each column of nodes stands for on the mesh [m]: half the gap
 * to each neighbour, half the gap to the only one at an edge. Tractions and
 * flows per unit width turn into nodal forces and fluxes through this. The
 * slice widths used to be taken instead, and at an edge they differ - the
 * edge slice covers its whole cell's overlap with the strip, while the mesh
 * stops at the slice's centre - so the edge column was pulled by up to half
 * a cell's worth of tension it has no material for. Its elongation then
 * swung from −1143 to +2265 to −8516 I-units as the strip width went from
 * 1000 to 1015 to 1030 mm across one station.
 */
export function tributary(x: Float64Array): Float64Array {
  const n = x.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * (x[Math.min(n - 1, i + 1)] - x[Math.max(0, i - 1)]);
  return out;
}

export interface StripFemInput {
  /**
   * column positions [m]. The mesh runs from the first to the last; what
   * width a column stands for is what the mesh gives it (see `tributary`),
   * not the width of the slice it came from.
   */
  x: Float64Array;
  /** entry and exit thickness per column [m] */
  h0: Float64Array;
  h1: Float64Array;
  /** arc of contact per column [m] */
  L: Float64Array;
  /** plane-strain flow stress per column at the strain the column reaches [Pa] (used with the local strain below) */
  kf: (column: number, strain: number) => number;
  /** friction coefficient */
  mu: number;
  /** back and front tension per column [Pa] */
  sigmaB: Float64Array;
  sigmaF: Float64Array;
  /** rows along the rolling direction */
  nz: number;
  /** roll surface speed [m/s] - the velocity scale */
  vRoll: number;
}

export interface StripFemResult {
  /** load per unit width per column [N/m] */
  q: Float64Array;
  /** exit longitudinal velocity per column [m/s] */
  vExit: Float64Array;
  /** exit lateral velocity per column [m/s] (+ towards +x) */
  uExit: Float64Array;
  /** entry velocity [m/s] */
  vIn: number;
  /** elongation per column, ln(vExit / vIn) */
  eps: Float64Array;
  /** contact pressure at the element centres, row-major [column-1][row] [Pa] */
  p: Float64Array;
  /** lateral velocity at the element centres [m/s] */
  ux: Float64Array;
  /** element grid size */
  ncol: number;
  nrow: number;
  /** mass-flow closure: exit / entry */
  massRatio: number;
  iterations: number;
  converged: boolean;
  /** per element: s_y, s_z, σ_m, div(hu)/h, ε̇_eq - for checking the recovery */
  debug: { sy: Float64Array; sz: Float64Array; sm: Float64Array; div: Float64Array; eq: Float64Array };
}

const G = 1 / Math.sqrt(3);
const GP: [number, number][] = [[-G, -G], [G, -G], [G, G], [-G, G]];

/** the persistent state: the mesh size and the last velocity field, for the warm start */
export class StripFem {
  private u: Float64Array | null = null;
  private pEl: Float64Array | null = null;
  private dbg = { sy: new Float64Array(0), sz: new Float64Array(0), sm: new Float64Array(0), div: new Float64Array(0), eq: new Float64Array(0) };
  private nx = 0;
  private nz = 0;

  solve(inp: StripFemInput): StripFemResult {
    const nx = inp.x.length, nz = Math.max(2, Math.round(inp.nz));
    const trib = tributary(inp.x);
    const rows = nz + 1;
    const nn = nx * rows;
    const ndof = 2 * nn;
    const node = (i: number, j: number) => i * rows + j;
    const V = inp.vRoll;
    if (!this.u || this.nx !== nx || this.nz !== nz) {
      this.u = new Float64Array(ndof);
      for (let n = 0; n < nn; n++) this.u[2 * n + 1] = V;
      this.pEl = null;
      this.nx = nx; this.nz = nz;
    }
    const u = this.u;
    const ne = (nx - 1) * nz;
    const seedPressure = !this.pEl;
    if (!this.pEl) this.pEl = new Float64Array(ne);
    const pEl = this.pEl;

    // node coordinates and thickness field
    const X = new Float64Array(nn), Z = new Float64Array(nn), H = new Float64Array(nn);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < rows; j++) {
        const t = 1 - j / nz; // 1 at entry, 0 at exit
        const n = node(i, j);
        X[n] = inp.x[i];
        Z[n] = -t * inp.L[i];
        H[n] = inp.h1[i] + (inp.h0[i] - inp.h1[i]) * t * t;
      }
    }
    // element connectivity, counter-clockwise in (x, z)
    const conn = new Int32Array(4 * ne);
    let e = 0;
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < nz; j++) {
        conn[4 * e] = node(i, j); conn[4 * e + 1] = node(i + 1, j);
        conn[4 * e + 2] = node(i + 1, j + 1); conn[4 * e + 3] = node(i, j + 1);
        e++;
      }
    }
    // the strain each element has accumulated (for its flow stress): the
    // logarithmic thickness strain at its centre, per column
    const eps0 = new Float64Array(ne);
    const kfEl = new Float64Array(ne);
    for (let el = 0; el < ne; el++) {
      const i = Math.floor(el / nz);
      let h = 0, h0 = 0;
      for (let k = 0; k < 4; k++) { const n = conn[4 * el + k]; h += H[n] / 4; h0 += inp.h0[Math.floor(n / rows)] / 4; }
      eps0[el] = (2 / Math.sqrt(3)) * Math.log(h0 / Math.max(h, 1e-9));
      kfEl[el] = 0.5 * (inp.kf(i, eps0[el]) + inp.kf(Math.min(i + 1, nx - 1), eps0[el]));
    }
    // the first iterate's friction needs a pressure to act on: the flow
    // stress is the right order, and a cold start from zero never moves
    if (seedPressure) for (let el = 0; el < ne; el++) pEl[el] = kfEl[el];

    // scales: a nominal strain rate and the viscosity it implies, off which
    // the regularisers and the penalty are set
    let Lm = 0, dhm = 0, hm = 0, kfm = 0;
    for (let i = 0; i < nx; i++) { Lm += inp.L[i]; dhm += inp.h0[i] - inp.h1[i]; hm += inp.h1[i]; }
    for (let el = 0; el < ne; el++) kfm += kfEl[el];
    Lm /= nx; dhm /= nx; hm /= nx; kfm /= Math.max(ne, 1);
    const epsRef = Math.max((V * dhm) / (hm * Math.max(Lm, 1e-6)), 1e-3);
    const epsReg = 0.02 * epsRef;
    const muRef = kfm / Math.max(epsRef, 1e-9);
    const KPEN = 60 * muRef;
    const vReg = 0.03 * V;
    // The incoming strip is rigid: its entry nodes share one longitudinal
    // speed. The tie that says so was 1e3 times the reference stiffness and
    // let the entry speed spread across the width by 50-190 I-units in the
    // plane FEM and by up to 2 % in the 3D one, which went straight into the
    // elongation profile (185 I and 1250 I). At 1e6 the spread is gone and
    // the profile matches a tie a hundred times stiffer; the Picard count
    // does not change.
    const KTIE = 1e6 * muRef * hm;

    const hb = 2 * rows + 3;
    const K = new BandMatrix(ndof, hb);
    const rhs = new Float64Array(ndof);
    const unew = new Float64Array(ndof);
    // per element, per gp: dN/dx, dN/dz and the Jacobian weight
    const dN = new Float64Array(ne * 4 * 8), wgt = new Float64Array(ne * 4);
    const Nn = new Float64Array(4 * 4);
    const dNc = new Float64Array(ne * 8), wc = new Float64Array(ne); // centroid
    {
      const xe = new Float64Array(4), ze = new Float64Array(4);
      const shape = (xi: number, et: number, out: Float64Array, off: number, dref: Float64Array) => {
        const s = [-1, 1, 1, -1], t = [-1, -1, 1, 1];
        for (let k = 0; k < 4; k++) {
          out[off + k] = 0.25 * (1 + s[k] * xi) * (1 + t[k] * et);
          dref[2 * k] = 0.25 * s[k] * (1 + t[k] * et);
          dref[2 * k + 1] = 0.25 * t[k] * (1 + s[k] * xi);
        }
      };
      const dref = new Float64Array(8);
      const cart = (dref: Float64Array, out: Float64Array, off: number): number => {
        let j00 = 0, j01 = 0, j10 = 0, j11 = 0;
        for (let k = 0; k < 4; k++) {
          j00 += dref[2 * k] * xe[k]; j01 += dref[2 * k] * ze[k];
          j10 += dref[2 * k + 1] * xe[k]; j11 += dref[2 * k + 1] * ze[k];
        }
        const det = j00 * j11 - j01 * j10;
        const inv = 1 / det;
        for (let k = 0; k < 4; k++) {
          out[off + 2 * k] = inv * (j11 * dref[2 * k] - j01 * dref[2 * k + 1]);
          out[off + 2 * k + 1] = inv * (-j10 * dref[2 * k] + j00 * dref[2 * k + 1]);
        }
        return det;
      };
      for (let g = 0; g < 4; g++) shape(GP[g][0], GP[g][1], Nn, 4 * g, dref);
      for (let el = 0; el < ne; el++) {
        for (let k = 0; k < 4; k++) { const n = conn[4 * el + k]; xe[k] = X[n]; ze[k] = Z[n]; }
        for (let g = 0; g < 4; g++) {
          shape(GP[g][0], GP[g][1], Nn, 4 * g, dref);
          wgt[4 * el + g] = cart(dref, dN, (4 * el + g) * 8);
        }
        const tmp = new Float64Array(4);
        shape(0, 0, tmp, 0, dref);
        wc[el] = 4 * cart(dref, dNc, el * 8);
      }
    }

    const ue = new Float64Array(8);
    const ke = new Float64Array(64);
    let iterations = 0, converged = false;
    for (let it = 0; it < 40; it++) {
      iterations = it + 1;
      K.clear(); rhs.fill(0);
      for (let el = 0; el < ne; el++) {
        for (let k = 0; k < 4; k++) { const n = conn[4 * el + k]; ue[2 * k] = u[2 * n]; ue[2 * k + 1] = u[2 * n + 1]; }
        ke.fill(0);
        const kf = kfEl[el];
        // Viscoplastic part at the 4 Gauss points. The thickness strain
        // rate is kinematic - the material follows the gap, ε̇_y = (u·∇h)/h -
        // not −(ε̇_x + ε̇_z): the two agree once the mass-flow constraint
        // holds, but their variations do not, and the difference is the
        // longitudinal push of the roll pressure on the inclined faces
        // (the p ∂h/∂z of von Kármán's balance). Substituting the
        // constraint lost that term and put the whole bite under a spurious
        // uniform compression.
        for (let g = 0; g < 4; g++) {
          const off = (4 * el + g) * 8;
          let ex = 0, ez = 0, gxz = 0, h = 0, hx = 0, hz = 0, ux = 0, uz = 0;
          for (let k = 0; k < 4; k++) {
            const dx = dN[off + 2 * k], dz = dN[off + 2 * k + 1], Nk = Nn[4 * g + k], Hk = H[conn[4 * el + k]];
            ex += dx * ue[2 * k]; ez += dz * ue[2 * k + 1];
            gxz += dz * ue[2 * k] + dx * ue[2 * k + 1];
            h += Nk * Hk; hx += dx * Hk; hz += dz * Hk;
            ux += Nk * ue[2 * k]; uz += Nk * ue[2 * k + 1];
          }
          const ey = (ux * hx + uz * hz) / h;
          const eq = Math.sqrt((2 / 3) * (ex * ex + ez * ez + ey * ey) + gxz * gxz / 3 + epsReg * epsReg);
          const mu = (FLOW * kf) / eq;
          // K = mu Bᵀ M B h w with M = diag(2/3, 2/3, 2/3, 1/3) on (ε̇_x, ε̇_z, ε̇_y, γ̇)
          const c = mu * h * wgt[4 * el + g];
          const yx = hx / h, yz = hz / h;
          for (let a = 0; a < 4; a++) {
            const dxa = dN[off + 2 * a], dza = dN[off + 2 * a + 1], Na = Nn[4 * g + a];
            for (let bb = 0; bb < 4; bb++) {
              const dxb = dN[off + 2 * bb], dzb = dN[off + 2 * bb + 1], Nb = Nn[4 * g + bb];
              const m11 = (2 / 3) * dxa * dxb + (1 / 3) * dza * dzb + (2 / 3) * (Na * yx) * (Nb * yx);
              const m12 = (1 / 3) * dza * dxb + (2 / 3) * (Na * yx) * (Nb * yz);
              const m21 = (1 / 3) * dxa * dzb + (2 / 3) * (Na * yz) * (Nb * yx);
              const m22 = (2 / 3) * dza * dzb + (1 / 3) * dxa * dxb + (2 / 3) * (Na * yz) * (Nb * yz);
              ke[(2 * a) * 8 + 2 * bb] += c * m11;
              ke[(2 * a) * 8 + 2 * bb + 1] += c * m12;
              ke[(2 * a + 1) * 8 + 2 * bb] += c * m21;
              ke[(2 * a + 1) * 8 + 2 * bb + 1] += c * m22;
            }
          }
        }
        // penalty on div(h u) at the centroid, and the pressure of the last iterate
        {
          const off = el * 8;
          let h = 0, hx = 0, hz = 0;
          for (let k = 0; k < 4; k++) {
            const n = conn[4 * el + k];
            h += 0.25 * H[n]; hx += dNc[off + 2 * k] * H[n]; hz += dNc[off + 2 * k + 1] * H[n];
          }
          const gvec = new Float64Array(8);
          for (let k = 0; k < 4; k++) {
            gvec[2 * k] = h * dNc[off + 2 * k] + 0.25 * hx;
            gvec[2 * k + 1] = h * dNc[off + 2 * k + 1] + 0.25 * hz;
          }
          const c = (KPEN * wc[el]) / h;
          for (let a = 0; a < 8; a++) for (let bb = 0; bb < 8; bb++) ke[a * 8 + bb] += c * gvec[a] * gvec[bb];
        }
        // friction on both faces, frozen from the last iterate: c = 2 μ p / |u − v_r|_reg
        {
          const p = Math.max(pEl[el], 0);
          for (let g = 0; g < 4; g++) {
            let ux = 0, uz = 0;
            for (let k = 0; k < 4; k++) { ux += Nn[4 * g + k] * ue[2 * k]; uz += Nn[4 * g + k] * ue[2 * k + 1]; }
            const rel = Math.sqrt(ux * ux + (uz - V) * (uz - V) + vReg * vReg);
            const c = (2 * inp.mu * p * wgt[4 * el + g]) / rel;
            for (let a = 0; a < 4; a++) {
              for (let bb = 0; bb < 4; bb++) {
                const v = c * Nn[4 * g + a] * Nn[4 * g + bb];
                ke[(2 * a) * 8 + 2 * bb] += v;
                ke[(2 * a + 1) * 8 + 2 * bb + 1] += v;
              }
              const n = conn[4 * el + a];
              rhs[2 * n + 1] += c * Nn[4 * g + a] * V;
            }
          }
        }
        // scatter
        for (let a = 0; a < 4; a++) {
          const na = conn[4 * el + a];
          for (let bb = 0; bb < 4; bb++) {
            const nb = conn[4 * el + bb];
            for (let da = 0; da < 2; da++) for (let db = 0; db < 2; db++) {
              const ia = 2 * na + da, ib = 2 * nb + db;
              if (ib > ia) continue;
              K.add(ia, ib, ke[(2 * a + da) * 8 + 2 * bb + db]);
            }
          }
        }
      }
      // tensions as tractions on the entry and exit rows; the incoming strip
      // rigid (u_x pinned, u_z tied between neighbours)
      const BIG = 1e12 * muRef * hm;
      for (let i = 0; i < nx; i++) {
        const n0 = node(i, 0), n1 = node(i, nz);
        rhs[2 * n0 + 1] -= inp.sigmaB[i] * inp.h0[i] * trib[i];
        rhs[2 * n1 + 1] += inp.sigmaF[i] * inp.h1[i] * trib[i];
        K.add(2 * n0, 2 * n0, BIG);
        if (i < nx - 1) {
          const m0 = node(i + 1, 0);
          K.add(2 * n0 + 1, 2 * n0 + 1, KTIE); K.add(2 * m0 + 1, 2 * m0 + 1, KTIE); K.add(2 * m0 + 1, 2 * n0 + 1, -KTIE);
        }
      }
      if (!K.cholesky()) break;
      K.solve(rhs, unew);
      // pressure from this iterate, for the next friction and for the load
      let du = 0, un = 0;
      for (let d = 0; d < ndof; d++) { du = Math.max(du, Math.abs(unew[d] - u[d])); un = Math.max(un, Math.abs(unew[d])); }
      u.set(unew);
      this.recoverPressure(u, conn, H, dN, dNc, Nn, wgt, kfEl, epsReg, KPEN, ne, pEl);
      if (du < 1e-5 * Math.max(un, V)) { converged = true; break; }
    }

    // outputs per column: load from the pressure, exit and entry velocities
    const q = new Float64Array(nx), vExit = new Float64Array(nx), uExit = new Float64Array(nx), eps = new Float64Array(nx);
    const pOut = new Float64Array(ne), uxOut = new Float64Array(ne);
    for (let el = 0; el < ne; el++) {
      pOut[el] = pEl[el];
      let ux = 0;
      for (let k = 0; k < 4; k++) ux += 0.25 * u[2 * conn[4 * el + k]];
      uxOut[el] = ux;
    }
    for (let i = 0; i < nx; i++) {
      // a column's load: the mean of the pressures of the elements on each
      // side of it, over the rows, times the row length
      let acc = 0;
      for (let j = 0; j < nz; j++) {
        let p = 0, cnt = 0;
        if (i > 0) { p += pEl[(i - 1) * nz + j]; cnt++; }
        if (i < nx - 1) { p += pEl[i * nz + j]; cnt++; }
        acc += (cnt ? p / cnt : 0) * (inp.L[i] / nz);
      }
      q[i] = Math.max(acc, 0);
      vExit[i] = u[2 * node(i, nz) + 1];
      uExit[i] = u[2 * node(i, nz)];
    }
    const vIn = u[2 * node(0, 0) + 1];
    let flowIn = 0, flowOut = 0;
    for (let i = 0; i < nx; i++) {
      eps[i] = Math.log(Math.max(vExit[i], 1e-9) / Math.max(vIn, 1e-9));
      flowIn += inp.h0[i] * vIn * trib[i];
      flowOut += inp.h1[i] * vExit[i] * trib[i];
    }
    return {
      q, vExit, uExit, vIn, eps, p: pOut, ux: uxOut, ncol: nx - 1, nrow: nz,
      massRatio: flowIn > 0 ? flowOut / flowIn : 1, iterations, converged, debug: this.dbg,
    };
  }

  /** p = −σ_y at each element centre: the deviatoric part through the thickness plus the penalty pressure */
  private recoverPressure(
    u: Float64Array, conn: Int32Array, H: Float64Array, dN: Float64Array, dNc: Float64Array, Nn: Float64Array,
    wgt: Float64Array, kfEl: Float64Array, epsReg: number, KPEN: number, ne: number, out: Float64Array,
  ): void {
    void dN; void Nn; void wgt;
    if (this.dbg.sy.length !== ne) this.dbg = { sy: new Float64Array(ne), sz: new Float64Array(ne), sm: new Float64Array(ne), div: new Float64Array(ne), eq: new Float64Array(ne) };
    for (let el = 0; el < ne; el++) {
      const off = el * 8;
      let ex = 0, ez = 0, gxz = 0, h = 0, hx = 0, hz = 0, ux = 0, uz = 0;
      for (let k = 0; k < 4; k++) {
        const n = conn[4 * el + k];
        const dx = dNc[off + 2 * k], dz = dNc[off + 2 * k + 1];
        ex += dx * u[2 * n]; ez += dz * u[2 * n + 1];
        gxz += dz * u[2 * n] + dx * u[2 * n + 1];
        h += 0.25 * H[n]; hx += dx * H[n]; hz += dz * H[n];
        ux += 0.25 * u[2 * n]; uz += 0.25 * u[2 * n + 1];
      }
      const ey = (ux * hx + uz * hz) / h;
      const eq = Math.sqrt((2 / 3) * (ex * ex + ez * ez + ey * ey) + gxz * gxz / 3 + epsReg * epsReg);
      const sy = ((2 * FLOW * kfEl[el]) / (3 * eq)) * ey;
      const divhu = h * (ex + ez) + ux * hx + uz * hz;
      const sm = (KPEN * divhu) / h;
      const p = -(sy + sm);
      this.dbg.sy[el] = sy; this.dbg.sz[el] = ((2 * FLOW * kfEl[el]) / (3 * eq)) * ez; this.dbg.sm[el] = sm; this.dbg.div[el] = divhu / h; this.dbg.eq[el] = eq;
      // damped: the friction of the next iterate is built on it
      out[el] += 0.8 * (p - out[el]);
      if (!Number.isFinite(out[el])) out[el] = kfEl[el];
    }
  }
}
