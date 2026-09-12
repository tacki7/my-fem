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
/** the load cap, as a multiple of kf √(R h₀) - far past any pass that has a solution */
const QCAP_FACTOR = 40;

/** kf at the exit of a pass h0 → h1 [Pa] */
export function kfExitOf(s: StripLaw, h0: number, h1: number): number {
  return kfAt(s, Math.max(s.entryStrain, 0) + EQ * Math.log(h0 / Math.max(h1, 1e-3 * h0)));
}

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
  /** the pass has no steady solution (below Stone's minimum thickness) and q is the cap */
  runaway: boolean;
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
  s: StripLaw, h0: number, h1: number, sigmaB: number, sigmaF: number, qGuess = 0,
): SliceLoad {
  // a non-positive exit thickness is not a pass; the formula is evaluated
  // at a sliver instead and hands back an enormous load
  h1 = Math.max(h1, 1e-3 * h0);
  const dh = h0 - h1;
  const e0 = Math.max(s.entryStrain, 0);
  const e1 = e0 + EQ * Math.log(h0 / h1);
  const kf = kfMean(s, e0, e1);
  const kfExit = kfAt(s, e1);
  if (dh <= 0) return { q: 0, runaway: false, Rp: s.R, arc: 0, kf, kfExit };
  const r = dh / h0;
  // A tension near the resistance would stretch the strip rather than roll
  // it; the formula is not asked about that regime.
  const tens = Math.max(1 - Math.min(0.5 * (sigmaB + sigmaF), TENSION_CAP * kf) / kf, 1 - TENSION_CAP);
  const C = (16 * (1 - s.nuRoll * s.nuRoll)) / (Math.PI * s.Eroll);
  // The arc of contact in Roberts' form: the plastic parabola plus one Hertz
  // half-width, L = b + √(b² + R Δh), b² = C R q / 4. Unlike Hitchcock's
  // R' = R (1 + C q/Δh) it has no runaway: at a vanishing draft it tends to
  // the elastic contact width 2b rather than to infinity, so a lightly
  // rolled edge slice gets a bounded load instead of a capped one (with the
  // cap, a 6 µm draft on a 1200 MPa strip asked for 11 kN/mm). The load is
  //     q = k̄f (1 − σ̄t/k̄f) L · Qp(L),  Qp = 1.08 + 1.79 r μ √(1−r) L/√(Δh h₁) − 1.02 r,
  // i.e. Bland & Ford-Hill on the equivalent radius R' = L²/Δh. q(L) grows
  // like √q through b, so the fixed point q = F(q) is unique and a Newton
  // from below reaches it in a few steps.
  const A = kf * tens;
  const Q0 = 1.08 - 1.02 * r, Q1 = (1.79 * r * s.mu * Math.sqrt(1 - r)) / Math.sqrt(dh * h1);
  const F = (q: number): [number, number] => {
    const b2 = (C * s.R * q) / 4;
    const b = Math.sqrt(b2);
    const root = Math.sqrt(b2 + s.R * dh);
    const L = b + root;
    const dL = q > 0 ? (C * s.R) / 8 * (1 / b + 1 / root) : Infinity;
    const Qp = Q0 + Q1 * L;
    if (Qp < 0.2) return [A * L * 0.2, A * 0.2 * dL];
    return [A * L * Qp, A * dL * (Qp + Q1 * L)];
  };
  // Past Stone's minimum thickness the friction hill grows faster with the
  // arc than the arc shortens with the load, and q = F(q) has no solution:
  // the roll flattens faster than the gap closes. That is a real answer
  // ("this pass cannot be rolled here"), reported as a capped load and a
  // flag rather than as a number that keeps growing.
  const qCap = QCAP_FACTOR * kf * Math.sqrt(s.R * h0);
  // g(q) = q − F(q) is convex (F grows like √q), so Newton converges from
  // either side and a warm start is safe; with no root at all it runs off
  // to the cap.
  let q = qGuess > 0 && qGuess < qCap ? qGuess : F(0)[0];
  let runaway = false;
  for (let i = 0; i < 20; i++) {
    const [f, df] = F(q);
    const g = q - f;
    const dg = 1 - df;
    let next = dg > 1e-6 ? q - g / dg : 2 * q;
    if (next <= 0) next = 0.5 * q;
    if (next >= qCap) { q = qCap; runaway = true; break; }
    const step = Math.abs(next - q);
    q = next;
    // tight, because the slice solve outside differentiates this numerically
    if (step < 1e-11 * q) break;
  }
  const b = Math.sqrt((C * s.R * q) / 4);
  const L = b + Math.sqrt(b * b + s.R * dh);
  // Below an elastic draft the strip is only squeezed, not rolled: the
  // load rises smoothly from zero over that draft rather than jumping to
  // the plastic value.
  const dhElastic = (h0 * kf * (1 - s.nu * s.nu)) / s.E;
  if (dh < dhElastic) { const t = dh / dhElastic; q *= t * t * (3 - 2 * t); }
  return { q, runaway, Rp: (L * L) / dh, arc: L, kf, kfExit };
}


/**
 * Elastic recovery of the exit thickness as the slice leaves the bite: the
 * plane-strain compression under the exit pressure springs back.
 */
export function springback(s: StripLaw, h1: number, kfExit: number, sigmaF: number): number {
  return (h1 * Math.max(kfExit - sigmaF, 0) * (1 - s.nu * s.nu)) / s.E;
}
