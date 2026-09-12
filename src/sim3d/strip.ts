/**
 * The strip, one width slice at a time.
 *
 * Across the width the strip is cut into slices, one per station of the roll
 * grid, and each slice is rolled as its own plane-strain pass: the local roll
 * gap gives the local exit thickness, and a rolling-load formula gives the
 * load per unit width the slice pushes back on the work roll with. The
 * slices talk to each other through the tension the strip carries: a slice
 * that is rolled longer than its neighbours goes slack, one rolled shorter
 * is stretched, and that difference in front tension feeds back into the
 * local load. That is the whole of the strip's "3D" behaviour in this model
 * - a set of coupled slab passes - which is what a mill setup model uses,
 * and what makes it fast enough to run every frame.
 *
 * The load formula is Bland & Ford in Hill's closed form,
 *
 *     q = k̄f (1 - σ̄t/k̄f) √(R' Δh) · Qp,
 *     Qp = 1.08 + 1.79 r μ √(1-r) √(R'/h1) - 1.02 r,
 *
 * with the roll flattened by Hitchcock, R' = R (1 + 16(1-ν²) q / (π E Δh)),
 * and k̄f the plane-strain resistance averaged over the strain of the pass
 * on the same L(ε+M)^N law the 2D tab uses. Closed form because it is
 * evaluated a few thousand times a frame (every slice, every Newton
 * iteration, plus a finite difference for the tangent).
 */

export interface StripLaw {
  /** L, M, N of kf = L (ε + M)^N [Pa, -, -], plane-strain kf */
  lmnL: number;
  lmnM: number;
  lmnN: number;
  /** strip elastic constants */
  E: number;
  nu: number;
  /** equivalent strain the strip arrives with */
  entryStrain: number;
  /** friction coefficient in the bite */
  mu: number;
  /** work roll radius [m] and elastic constants, for Hitchcock */
  R: number;
  Eroll: number;
  nuRoll: number;
}

const EQ = 2 / Math.sqrt(3);
/** the largest share of the resistance the mean tension is allowed to cancel */
export const TENSION_CAP = 0.7;

/** plane-strain kf at equivalent strain e */
export function kfAt(s: StripLaw, e: number): number {
  return s.lmnL * Math.pow(Math.max(e, 0) + Math.max(s.lmnM, 0), s.lmnN);
}

/** mean of kf over [e0, e1] */
export function kfMean(s: StripLaw, e0: number, e1: number): number {
  const M = Math.max(s.lmnM, 0);
  const a = Math.max(e0, 0);
  const b = Math.max(e1, a);
  const n1 = s.lmnN + 1;
  if (b - a <= 1e-12) return kfAt(s, a);
  return (s.lmnL * (Math.pow(b + M, n1) - Math.pow(a + M, n1))) / (n1 * (b - a));
}

export interface SliceLoad {
  /** load per unit width [N/m] */
  q: number;
  /** flattened radius [m] */
  Rp: number;
  /** projected arc of contact [m] */
  arc: number;
  /** mean plane-strain resistance over the pass [Pa] */
  kf: number;
  /** kf at the exit strain [Pa] */
  kfExit: number;
}

/**
 * Bland-Ford-Hill load of one slice. `qGuess` seeds the Hitchcock fixed
 * point, which is climbed from below so it lands on the physical (smaller)
 * radius; a pass past Stone's limit is capped at R'/R = 50 rather than
 * reported as infinite, so a slice at the edge that is barely rolled still
 * hands back a finite number the Newton can work with.
 */
export function sliceLoad(
  s: StripLaw, h0: number, h1: number, sigmaB: number, sigmaF: number,
): SliceLoad {
  const dh = h0 - h1;
  const e0 = Math.max(s.entryStrain, 0);
  const e1 = e0 + EQ * Math.log(h0 / Math.max(h1, 1e-9));
  const kf = kfMean(s, e0, e1);
  const kfExit = kfAt(s, e1);
  if (dh <= 0) return { q: 0, Rp: s.R, arc: 0, kf, kfExit };
  const r = dh / h0;
  // A tension near the resistance would stretch the strip rather than roll
  // it; the formula is not asked about that regime.
  const tens = Math.max(1 - Math.min(0.5 * (sigmaB + sigmaF), TENSION_CAP * kf) / kf, 1 - TENSION_CAP);
  const C = (16 * (1 - s.nuRoll * s.nuRoll)) / (Math.PI * s.Eroll);
  const cap = s.R * 50;
  // q(R') = A √R' (Q0 + Q1 √R'), Q0 = 1.08 - 1.02 r, Q1 = 1.79 r μ √(1-r) / √h1
  const A = kf * tens * Math.sqrt(dh);
  const Q0 = 1.08 - 1.02 * r, Q1 = (1.79 * r * s.mu * Math.sqrt(1 - r)) / Math.sqrt(h1);
  const at = (Rp: number) => {
    const sr = Math.sqrt(Rp);
    return A * sr * Math.max(Q0 + Q1 * sr, 0.2);
  };
  const dAt = (Rp: number) => {
    const sr = Math.sqrt(Rp);
    if (Q0 + Q1 * sr < 0.2) return (A * 0.2) / (2 * sr);
    return A * (Q0 / (2 * sr) + Q1);
  };
  // The Hitchcock fixed point R' = R (1 + C q(R')/dh). The map has a
  // spurious second crossing further out, and a warm start from above finds
  // that one (see muinv.ts in the 2D tab, where the same thing was learnt),
  // so the climb starts at R'=R every time. Newton on f(R') = R' - map(R')
  // gets there in three or four steps instead of the fixed point's dozens;
  // f is convex below the physical root, so the steps land short of it and
  // never cross to the other side.
  let Rp = s.R;
  let q = at(Rp);
  const k = (s.R * C) / dh;
  for (let i = 0; i < 12; i++) {
    const f = Rp - s.R - k * q;
    const df = 1 - k * dAt(Rp);
    if (!(df > 1e-6)) { Rp = cap; q = at(Rp); break; }
    let next = Rp - f / df;
    if (next > cap) { Rp = cap; q = at(Rp); break; }
    if (next < s.R) next = s.R;
    const step = Math.abs(next - Rp);
    Rp = next;
    q = at(Rp);
    if (step < 1e-6 * Rp) break;
  }
  return { q, Rp, arc: Math.sqrt(Rp * dh), kf, kfExit };
}

/**
 * Elastic recovery of the exit thickness as the slice leaves the bite: the
 * plane-strain compression under the exit pressure springs back.
 */
export function springback(s: StripLaw, h1: number, kfExit: number, sigmaF: number): number {
  return (h1 * Math.max(kfExit - sigmaF, 0) * (1 - s.nu * s.nu)) / s.E;
}
