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
 *
 * σ̄t is the mean of the back and front tension by default. With
 * `slabTension: 'split'` it is the equivalent tension of `splitDecrement`
 * instead, where the front tension acts only between the exit and the
 * neutral point and the back tension only between the neutral point and the
 * entry, each amplified by the friction hill on its side.
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
  /** whether the tensions act on the yield (see Params3D.tensionFeedback) */
  tensionFeedback: boolean;
  /** how the back and front tension enter the load (see Params3D.slabTension); absent is 'mean' */
  slabTension?: SlabTension;
  /** work roll radius [m] and elastic constants, for Hitchcock */
  R: number;
  Eroll: number;
  nuRoll: number;
}

/** the mean of the two tensions (Kármán, Siebel), or the two acting on their own sides of the neutral point */
export type SlabTension = 'mean' | 'split';

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

/** 4-point Gauss-Legendre on [-1, 1]: abscissae and weights */
const GL4_X = [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526];
const GL4_W = [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538];

/**
 * The load of a pass whose back and front tension act on their own sides of
 * the neutral point, as a decrement on the tensionless load.
 *
 * Kármán's equation at a constant resistance k on the parabolic arc, with
 * θ = atan(x/√(R' h₁)) and c = 2μ√(R'/h₁), is linear in the pressure, so a
 * tension at an end of the arc adds its own homogeneous solution to the
 * pressure on its side (Nádai's solution):
 *
 *     exit  (θ < θn)   p = k (h/h₁) e^{cθ}         − σf e^{cθ}
 *     entry (θ > θn)   p = k (h/h₀) e^{c(θ₀−θ)}    − σb e^{c(θ₀−θ)}
 *
 * The tension terms are exact: h dδp/dx = ∓2μ δp carries no h factor, which
 * is why Bland & Ford's (1 − σ/k)(h/h_end) form, scaling the tension with
 * the pressure, overstates the back tension on a hardening strip (its
 * 1.7 L against Orowan's 0.91 L on the 4Hi pass). The tensionless parts are
 * Bland & Ford's, and they only place the neutral point, where the two
 * branches meet. Because the pressure is continuous there, moving the
 * neutral point costs nothing to first order, and the load falls by
 *
 *     ∂P/∂σf = −∫₀^{xn} e^{cθ} dx,    ∂P/∂σb = −∫_{xn}^{L} e^{c(θ₀−θ)} dx
 *
 * - the friction hill over each tension's own side, not half the arc each.
 * On the 4Hi pass at a fixed R' that is 0.36 L and 0.90 L against the mean
 * tension's 0.56 L each (Orowan 0.34 and 0.91, the 2D FEM 0.27 and 0.92).
 *
 * Returned, per k L and for tensions tb = σb/k, tf = σf/k: the decrement
 * P(σb, σf)/(kL) − P(0, 0)/(kL), which `sliceLoad` puts onto Hill's load,
 * and its derivative in L at a fixed pass (the arc sets c, so the friction
 * hill and the neutral point move with the flattening). NaN where the
 * formula has nothing to say (no friction hill, or one so steep that the
 * exponentials overflow). The integrals are 4-point Gauss-Legendre in θ:
 * 1e-5 of the tension against 8 points over r 10-40 %, μ 0.03-0.12,
 * R'/h 50-1000.
 */
export function splitDecrement(h0: number, h1: number, L: number, mu: number, tb: number, tf: number): [number, number] {
  const dh = h0 - h1;
  if (!(dh > 0) || !(L > 0)) return [NaN, 0];
  const c = (2 * mu * L) / Math.sqrt(dh * h1); // 2μ √(R'/h₁) with R' = L²/Δh
  const tanT0 = Math.sqrt(dh / h1);
  const t0 = Math.atan(tanT0);
  if (!(c > 0) || c * t0 > 600) return [NaN, 0];
  if (tb === 0 && tf === 0) return [0, 0];
  const g = h1 / h0;
  const e0 = Math.exp(c * t0);
  // the tensionless neutral point in closed form: e^{2cθ − cθ₀} = h₁/h₀
  const tn0 = Math.min(t0, Math.max(0, 0.5 * t0 + Math.log(g) / (2 * c)));
  // D = exit minus entry pressure over k, which rises through the neutral
  // point; at the ends sec²θ is 1 and h₀/h₁
  let tn: number;
  if (1 - tf - e0 * (g - tb) >= 0) tn = 0;           // the exit branch is the lower one all along: no forward slip
  else if (e0 * (1 / g - tf) - (1 - tb) <= 0) tn = t0;
  else {
    // Newton from the tensionless point, kept in the bracket. Loose on
    // purpose: the load is stationary in θn (the branches meet there), so
    // an error of 1e-10 in θn is 1e-20 in the load.
    let lo = 0, hi = t0, t = tn0;
    // a start with the tensions in: the branches' ratio with sec²θ frozen at θn0
    {
      const cs = Math.cos(tn0), s2 = 1 / (cs * cs), num = g * s2 - tb, den = s2 - tf;
      if (num > 0 && den > 0) { const t1 = (c * t0 + Math.log(num / den)) / (2 * c); if (t1 > 0 && t1 < t0) t = t1; }
    }
    for (let i = 0; i < 40; i++) {
      const cs = Math.cos(t), s2 = 1 / (cs * cs), ds2 = 2 * s2 * Math.tan(t);
      const ep = Math.exp(c * t), em = e0 / ep;
      const d = ep * (s2 - tf) - em * (g * s2 - tb);
      if (d < 0) lo = t; else hi = t;
      const dd = ep * (c * (s2 - tf) + ds2) + em * (c * (g * s2 - tb) - g * ds2);
      let next = dd > 0 ? t - d / dd : 0.5 * (lo + hi);
      // the bracket's ends count as inside: at an exact root the step is
      // zero and lands on one, and a bisection from there would walk away
      if (!(next >= lo && next <= hi)) next = 0.5 * (lo + hi);
      const step = Math.abs(next - t);
      t = next;
      if (step <= 1e-10 * t0) break;
    }
    tn = t;
  }
  // the friction hill over each side times its tension, and the tensionless
  // pressure difference over the neutral point's move; each with its
  // derivative in c (the ends carry no terms: 0 and θ₀ are fixed, and at
  // θn and θn0 the branches they separate are equal)
  let tens = 0, dTens = 0, move = 0, dMove = 0;
  if (tn > 0 && tf !== 0) {
    const m = 0.5 * tn;
    for (let i = 0; i < 4; i++) {
      const t = m + m * GL4_X[i], cs = Math.cos(t), f = (GL4_W[i] * m * Math.exp(c * t)) / (cs * cs);
      tens += tf * f; dTens += tf * t * f;
    }
  }
  if (tn < t0 && tb !== 0) {
    const m = 0.5 * (t0 + tn), hw = 0.5 * (t0 - tn);
    for (let i = 0; i < 4; i++) {
      const t = m + hw * GL4_X[i], cs = Math.cos(t), f = (GL4_W[i] * hw * e0 * Math.exp(-c * t)) / (cs * cs);
      tens += tb * f; dTens += tb * (t0 - t) * f;
    }
  }
  if (tn !== tn0) {
    const m = 0.5 * (tn + tn0), hw = 0.5 * (tn - tn0); // signed: the move may be either way
    for (let i = 0; i < 4; i++) {
      const t = m + hw * GL4_X[i], cs = Math.cos(t), s2 = 1 / (cs * cs), ep = Math.exp(c * t), em = (g * e0) / ep;
      move += GL4_W[i] * hw * s2 * s2 * (ep - em); dMove += GL4_W[i] * hw * s2 * s2 * (t * ep - (t0 - t) * em);
    }
  }
  // per unit arc (R'/s over L is 1/tan θ₀), and dc/dL = c/L
  return [(move - tens) / tanT0, ((dMove - dTens) / tanT0) * (c / L)];
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
  const sigT = s.tensionFeedback ? Math.min(0.5 * (sigmaB + sigmaF), TENSION_CAP * kf) : 0;
  const tens = Math.max(1 - sigT / kf, 1 - TENSION_CAP);
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
  // With the tensions split, the relief depends on the arc (the friction
  // hill and the neutral point move with R'), so it is taken at every L.
  // The slope below leaves that dependence out: the Newton then converges
  // a little less than quadratically onto the same root.
  const split = s.tensionFeedback && s.slabTension === 'split';
  const tbSplit = Math.min(sigmaB, TENSION_CAP * kf) / kf, tfSplit = Math.min(sigmaF, TENSION_CAP * kf) / kf;
  const F = (q: number): [number, number] => {
    const b2 = (C * s.R * q) / 4;
    const b = Math.sqrt(b2);
    const root = Math.sqrt(b2 + s.R * dh);
    const L = b + root;
    const dL = q > 0 ? (C * s.R) / 8 * (1 / b + 1 / root) : Infinity;
    const Qp = Q0 + Q1 * L;
    if (split) {
      const Qe = Math.max(Qp, 0.2), dQe = Qp < 0.2 ? 0 : Q1;
      const [dec, dDec] = splitDecrement(h0, h1, L, s.mu, tbSplit, tfSplit);
      // the tension decrement onto Hill's load, with the mean's cap on
      // how much of the load it may take
      if (dec > -TENSION_CAP * Qe) return [kf * L * (Qe + dec), kf * dL * (Qe + dec + L * (dQe + dDec))];
      if (!Number.isFinite(dec)) return [A * L * Qe, A * dL * (Qe + L * dQe)];
      const a = kf * (1 - TENSION_CAP);
      return [a * L * Qe, a * dL * (Qe + L * dQe)];
    }
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
  // the strip yields once the roll pressure reaches kf − σt: under tension
  // the elastic compression it takes to get there is shorter, and plastic
  // deformation starts at a smaller draft
  if (split) {
    // the split tension only where the ramp can apply: it caps the relief
    // below 0.7 k̄f and a compressive tension raises it at most to σcr
    if (dh < (h0 * 1.3 * kf * (1 - s.nu * s.nu)) / s.E) {
      const sigTs = splitSigma(h0, h1, L, kf, s.mu, tbSplit, tfSplit, Q0 + Q1 * L, sigT);
      const dhElastic = (h0 * Math.max(kf - sigTs, 0.3 * kf) * (1 - s.nu * s.nu)) / s.E;
      if (dh < dhElastic) { const t = dh / dhElastic; q *= t * t * (3 - 2 * t); }
    }
    return { q, runaway, Rp: (L * L) / dh, arc: L, kf, kfExit };
  }
  const dhElastic = (h0 * Math.max(kf - sigT, 0.3 * kf) * (1 - s.nu * s.nu)) / s.E;
  if (dh < dhElastic) { const t = dh / dhElastic; q *= t * t * (3 - 2 * t); }
  return { q, runaway, Rp: (L * L) / dh, arc: L, kf, kfExit };
}

/** the equivalent mean tension of the split decrement, capped as the mean one is; `mean` where the decrement has none */
function splitSigma(h0: number, h1: number, L: number, kf: number, mu: number, tb: number, tf: number, Qp: number, mean: number): number {
  const Qe = Math.max(Qp, 0.2);
  const dec = splitDecrement(h0, h1, L, mu, tb, tf)[0];
  if (!Number.isFinite(dec)) return mean;
  return Math.min(-dec / Qe, TENSION_CAP) * kf;
}

/**
 * The σ̄t the load of a slice rolled h0 → h1 on an arc L takes off k̄f [Pa]:
 * the capped mean tension, or with `slabTension: 'split'` the equivalent
 * tension of `splitDecrement` on Hill's load. 0 with the tension feedback off.
 */
export function sliceTension(s: StripLaw, h0: number, h1: number, sigmaB: number, sigmaF: number, L: number): number {
  if (!s.tensionFeedback) return 0;
  h1 = Math.max(h1, 1e-3 * h0);
  const e0 = Math.max(s.entryStrain, 0);
  const kf = kfMean(s, e0, e0 + EQ * Math.log(h0 / h1));
  const mean = Math.min(0.5 * (sigmaB + sigmaF), TENSION_CAP * kf);
  if (s.slabTension !== 'split') return mean;
  const dh = h0 - h1;
  if (!(dh > 0)) return mean;
  const r = dh / h0;
  const Qp = 1.08 - 1.02 * r + ((1.79 * r * s.mu * Math.sqrt(1 - r)) / Math.sqrt(dh * h1)) * L;
  return splitSigma(h0, h1, L, kf, s.mu, Math.min(sigmaB, TENSION_CAP * kf) / kf, Math.min(sigmaF, TENSION_CAP * kf) / kf, Qp, mean);
}


/**
 * Elastic recovery of the exit thickness as the slice leaves the bite: the
 * plane-strain compression under the exit pressure springs back.
 */
export function springback(s: StripLaw, h1: number, kfExit: number, sigmaF: number): number {
  return (h1 * Math.max(kfExit - sigmaF, 0) * (1 - s.nu * s.nu)) / s.E;
}
