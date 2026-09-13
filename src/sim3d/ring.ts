/**
 * The roll cross-section as a plane-strain ring FEM, for the flattening.
 *
 * The Hertz/Johnson closed form (`contact.ts`) is the elastic half-space
 * answer with a log correction for the cylinder. This is the alternative
 * the 2D tab's roll model uses: the section between a rigid hub and the
 * barrel, meshed nt × nr with the same Q4 elements, loaded by the contact
 * pressure and read at the barrel. One solve per roll gives the surface
 * influence function g(Δθ) - the radial displacement everywhere on the
 * barrel due to a unit line load at one point - and the flattening under a
 * contact of half-width b is then the influence function integrated
 * against the Hertz pressure over the patch. A change of nt, nr, hub or
 * grading recomputes the function, nothing else in the solve changes.
 *
 * The solve is done on half the ring. The influence function is symmetric
 * about the loaded radius, so a half ring cut along that axis with the
 * tangential displacement held on the cut carries the same answer at half
 * the size, and without the wrap-around that would spoil the band. Node
 * (i, j) is circumferential i (θ from −π/2 to +π/2, the load at −π/2), ring
 * j from the hub outward; consecutive i are adjacent in the numbering, so
 * the half-bandwidth is 2 (nr + 2) + 1.
 */

import { BandMatrix } from './band';
import { precomputeElements } from '../sim/element';
import { radialStations } from '../sim/mesh';

export interface RingOptions {
  /** barrel radius [m] */
  R: number;
  /** rigid hub radius [m] */
  Rhub: number;
  /** circumferential divisions of the full ring (even) */
  nt: number;
  /** element rings between hub and barrel */
  nr: number;
  /** >1 concentrates rings at the barrel */
  grade: number;
  E: number;
  nu: number;
}

export interface RingInfluence extends RingOptions {
  /** barrel node pitch [m] */
  pitch: number;
  /** radial barrel displacement at node k (arc distance k·pitch from the load) per unit line load [m / (N/m)] */
  g: Float64Array;
  /** node coordinates of the half ring, xy interleaved (for drawing) */
  X: Float64Array;
  /** Q4 connectivity of the half ring */
  quads: Int32Array;
  /** displacement field of the half ring for a unit line load, xy interleaved [m / (N/m)] */
  u: Float64Array;
  /** rows of nodes through the wall */
  rows: number;
  /** nodes around the half ring */
  cols: number;
}

/** Build the half-ring mesh, solve for the unit-load influence function. */
export function ringInfluence(o: RingOptions): RingInfluence {
  const nt = Math.max(16, Math.round(o.nt / 2) * 2);
  const nr = Math.max(2, Math.round(o.nr));
  const cols = nt / 2 + 1;
  const rows = nr + 1;
  const nn = cols * rows;
  const X = new Float64Array(2 * nn);
  const { r } = radialStations(o.Rhub, o.R, nr, o.grade, 0, 0);
  for (let i = 0; i < cols; i++) {
    const th = -Math.PI / 2 + (Math.PI * i) / (cols - 1);
    const c = Math.cos(th), s = Math.sin(th);
    for (let j = 0; j < rows; j++) {
      const id = i * rows + j;
      X[2 * id] = r[j] * c;
      X[2 * id + 1] = r[j] * s;
    }
  }
  // quads, counter-clockwise: (i,j) (i,j+1) (i+1,j+1) (i+1,j)
  const ne = (cols - 1) * nr;
  const quads = new Int32Array(4 * ne);
  let e = 0;
  for (let i = 0; i < cols - 1; i++) {
    for (let j = 0; j < nr; j++) {
      quads[4 * e] = i * rows + j;
      quads[4 * e + 1] = i * rows + j + 1;
      quads[4 * e + 2] = (i + 1) * rows + j + 1;
      quads[4 * e + 3] = (i + 1) * rows + j;
      e++;
    }
  }
  const el = precomputeElements(X, quads, { E: o.E, nu: o.nu, rho: 7850 });

  // assemble into the band; the DOF of node n, direction d is 2n + d
  // node (i, j) couples to (i+1, j+1): a DOF difference of 2 (rows + 1) + 1
  const K = new BandMatrix(2 * nn, 2 * rows + 3);
  for (let q = 0; q < ne; q++) {
    const base = 64 * q;
    for (let a = 0; a < 4; a++) {
      const na = quads[4 * q + a];
      for (let b = 0; b < 4; b++) {
        const nb = quads[4 * q + b];
        for (let da = 0; da < 2; da++) {
          for (let db = 0; db < 2; db++) {
            const ia = 2 * na + da, ib = 2 * nb + db;
            if (ib > ia) continue;
            K.add(ia, ib, el.Ke[base + (2 * a + da) * 8 + (2 * b + db)]);
          }
        }
      }
    }
  }
  // boundary conditions by a stiff spring (keeps the band symmetric):
  // hub nodes fixed, cut-plane nodes (first and last column, x = 0) held
  // in x
  const BIG = 1e30;
  const rhs = new Float64Array(2 * nn);
  for (let i = 0; i < cols; i++) {
    const hub = i * rows;
    K.add(2 * hub, 2 * hub, BIG); K.add(2 * hub + 1, 2 * hub + 1, BIG);
  }
  for (const i of [0, cols - 1]) {
    for (let j = 1; j < rows; j++) { const n = i * rows + j; K.add(2 * n, 2 * n, BIG); }
  }
  // unit line load, radially inward at the barrel node on the load axis
  // (θ = −π/2, so inward is +y); the half model carries half of it
  const load = nr; // node (0, nr)
  rhs[2 * load + 1] = 0.5;
  const u = new Float64Array(2 * nn);
  if (!K.cholesky()) throw new Error('ring: singular stiffness');
  K.solve(rhs, u);

  // radial inward displacement at each barrel node, by arc distance
  const g = new Float64Array(cols);
  for (let i = 0; i < cols; i++) {
    const n = i * rows + nr;
    const th = -Math.PI / 2 + (Math.PI * i) / (cols - 1);
    g[i] = -(u[2 * n] * Math.cos(th) + u[2 * n + 1] * Math.sin(th));
  }
  return {
    ...o, nt, nr, pitch: (2 * Math.PI * o.R) / nt, g, X, quads, u, rows, cols,
  };
}

/**
 * Flattening under a contact of half-width b: the influence function
 * integrated against the Hertz pressure p(s) = (2q/πb)√(1 − (s/b)²), the
 * pressure lumped onto the barrel nodes by their tributary arcs. Returns
 * the compliance G(b) [m per N/m] so that δ = q · G(b).
 */
export function ringCompliance(inf: RingInfluence, b: number): number {
  const { g, pitch } = inf;
  const bb = Math.max(b, 1e-9);
  // ∫ (2/(π b)) √(1 − (s/b)²) ds from s0 to s1, in units of b
  const F = (u: number) => { const v = Math.max(-1, Math.min(1, u)); return (v * Math.sqrt(1 - v * v) + Math.asin(v)) / Math.PI; };
  let G = 0;
  const kmax = Math.min(g.length - 1, Math.ceil(bb / pitch) + 1);
  for (let k = 0; k <= kmax; k++) {
    const s0 = (k - 0.5) * pitch, s1 = (k + 0.5) * pitch;
    let w = F(s1 / bb) - F(s0 / bb);
    // the mirrored node on the other side carries the same weight
    if (k > 0) w += F(-s0 / bb) - F(-s1 / bb);
    G += w * g[k];
  }
  return G;
}

/**
 * dG/db of `ringCompliance`, analytically: each node's weight is a
 * difference of F(s/b) at its tributary edges, and F′(u) = (2/π)√(1 − u²)
 * inside the patch, zero outside. The contact law's tangent needs it; a
 * forward difference over 5 % of b was 2-3 % off, which is what the outer
 * Newton then saw of every ring-model contact.
 */
export function ringComplianceSlope(inf: RingInfluence, b: number): number {
  const { g, pitch } = inf;
  const bb = Math.max(b, 1e-9);
  const dF = (u: number) => (Math.abs(u) < 1 ? (2 / Math.PI) * Math.sqrt(1 - u * u) : 0);
  // d/db F(s/b) = −(s/b²) F′(s/b)
  const dFb = (s0: number) => (-s0 / (bb * bb)) * dF(s0 / bb);
  let dG = 0;
  const kmax = Math.min(g.length - 1, Math.ceil(bb / pitch) + 1);
  for (let k = 0; k <= kmax; k++) {
    const s0 = (k - 0.5) * pitch, s1 = (k + 0.5) * pitch;
    let dw = dFb(s1) - dFb(s0);
    if (k > 0) dw += dFb(-s0) - dFb(-s1);
    dG += dw * g[k];
  }
  return dG;
}
