/**
 * The slab-method rolling load, three ways.
 *
 * All three integrate the same von Kármán force balance on a slab of the
 * strip between the rolls - the horizontal force changes along the arc by
 * what the roll pressure pushes back and what the friction drags in - and
 * differ in what they are willing to assume to get an answer:
 *
 *   karman     Siebel's closed form: the arc replaced by its mean thickness,
 *              the pressure by an exponential in the friction, the friction
 *              hill collapsed into one factor Qp = (e^a - 1)/a with
 *              a = mu L / h̄. One line, and what the textbook quotes.
 *   blandford  Bland & Ford (1948): Coulomb friction, small angles, the arc
 *              a parabola h = h1 + R' phi^2, the yield stress taken as slowly
 *              varying - and then the equation integrates in closed form on
 *              either side of the neutral point, with front and back tension
 *              entering as the boundary values. The cold-rolling standard.
 *   orowan     Orowan (1943): no approximation the others make. The exact
 *              circular arc, the yield relation corrected for the stress not
 *              being uniform through the thickness (Prandtl's inhomogeneity
 *              factor w(a)), friction Coulomb where it slips and capped at
 *              the shear yield k = kf/2 where it sticks, both branches
 *              integrated numerically and the neutral point found where they
 *              meet. What the others approximate; also what the FEM should
 *              approach as the mesh is refined.
 *
 * Every theory is evaluated at a *given* flattened radius R'. The Hitchcock
 * fixed point that decides R' lives in `muinv.ts` and wraps whichever one is
 * selected, so all three flatten the roll the same way.
 */

import {
  planeStrain, meanPlaneStrainLmnRange, type RollingParams, type SlabTheory, type FlatteningModel,
} from './solver';

/** One pass, as the slab methods see it. */
export interface SlabCase {
  /** entry thickness [m] */
  h0: number;
  /** exit thickness [m] */
  h1: number;
  /** ground work-roll radius [m] */
  R: number;
  /** pull on the entry side [Pa] */
  backTension: number;
  /** pull on the exit side [Pa] */
  frontTension: number;
  /** equivalent plastic strain the strip arrives with */
  entryStrain: number;
}

/** What a slab theory says about a pass at one friction coefficient and radius. */
export interface SlabPoint {
  /** rolling load per unit width [N/m]; Infinity if the flattening runs away */
  load: number;
  /** mean interface pressure [Pa] */
  meanPressure: number;
  /** contact length, projected on the strip, on the flattened radius [m] */
  arc: number;
  /** flattened radius R' [m] */
  Rflat: number;
  /** strain-averaged plane-strain resistance across this pass [Pa] */
  kf: number;
  /** what the friction hill is built on, kf - (sigma_b + sigma_f)/2 [Pa] */
  kEff: number;
  /** friction hill factor: Siebel's (e^a - 1)/a, or p̄ / kEff for the others */
  Qp: number;
  /** a = mu L / h̄ */
  a: number;
  /**
   * driving torque per roll per unit width [N·m/m], from the friction
   * distribution; NaN where the theory has no distribution (karman)
   */
  torque: number;
  /** neutral point, x from the exit plane, negative upstream [m]; NaN when the theory has none */
  neutralX: number;
  /**
   * The forward slip the neutral point implies, (v1 - vR)/vR, by volume
   * constancy between the neutral section and the exit: h_n cos(phi_n)/h1 - 1.
   * NaN when the theory has no neutral point.
   */
  forwardSlip: number;
  theory: SlabTheory;
}

export const SLAB_THEORY_LABEL: Record<SlabTheory, string> = {
  karman: 'Kármán',
  orowan: 'Orowan',
  blandford: 'Bland & Ford',
};

export const FLATTENING_LABEL: Record<FlatteningModel, string> = {
  hitchcock: 'Hitchcock',
  roberts: 'Roberts',
};

/** 2/sqrt(3): the draft ln(h0/h1) as a plane-strain equivalent strain. */
const EQ = 2 / Math.sqrt(3);

/** Equivalent strain the strip leaves this pass with. */
export function exitStrain(c: SlabCase): number {
  return Math.max(c.entryStrain, 0) + EQ * Math.log(c.h0 / c.h1);
}

/** Equivalent strain at a point in the arc where the thickness is h. */
function strainAt(c: SlabCase, h: number): number {
  return Math.max(c.entryStrain, 0) + EQ * Math.log(c.h0 / Math.max(h, 1e-12));
}

/**
 * The deformation resistance the selected theory sees along its own arc:
 * x from the exit plane (negative upstream) [m] and the plane-strain kf
 * there [Pa]. Bland & Ford and Orowan read kf at the local strain, each on
 * its own arc geometry; the Siebel form has one number for the whole arc,
 * so its profile is that number from entry to exit.
 */
export function slabKfProfile(
  p: RollingParams, c: SlabCase, Rp: number, n = 48,
): { x: number; kf: number }[] {
  const dh = c.h0 - c.h1;
  if (!(dh > 0) || !(Rp > 0)) return [];
  const out: { x: number; kf: number }[] = [];
  if (p.slabTheory === 'orowan') {
    const phi0 = Math.acos(Math.max(-1, Math.min(1, 1 - dh / (2 * Rp))));
    for (let i = 0; i <= n; i++) {
      const phi = (phi0 * i) / n;
      const h = c.h1 + 2 * Rp * (1 - Math.cos(phi));
      out.push({ x: -Rp * Math.sin(phi), kf: planeStrain(p, strainAt(c, h)) });
    }
  } else if (p.slabTheory === 'blandford') {
    const phi0 = Math.sqrt(dh / Rp);
    for (let i = 0; i <= n; i++) {
      const phi = (phi0 * i) / n;
      out.push({ x: -Rp * phi, kf: planeStrain(p, strainAt(c, c.h1 + Rp * phi * phi)) });
    }
  } else {
    const kf = meanPlaneStrainLmnRange(p, Math.max(c.entryStrain, 0), exitStrain(c));
    out.push({ x: -Math.sqrt(Rp * dh), kf }, { x: 0, kf });
  }
  return out;
}

/**
 * The friction hill the selected theory draws: interface pressure and
 * friction along its own arc, entry to exit, plus its neutral point. x from
 * the exit plane, negative upstream [m]; p and tau [Pa]; tau positive on the
 * entry side, where the roll drags the strip in, and negative past the
 * neutral point - the FEM's sign.
 *
 * Bland & Ford and Orowan are the distributions their loads are integrals
 * of. Siebel's form has no distribution as such; the one that averages to
 * its (e^a - 1)/a is the symmetric exponential von Kármán gives on an arc
 * of constant thickness h̄ - p = k* e^{2 mu s/h̄} up from either end - with
 * the neutral point at mid-arc, and that is what is drawn for it.
 */
export function slabPressureProfile(
  p: RollingParams, c: SlabCase, mu: number, Rp: number, n = 64,
): { samples: { x: number; p: number; tau: number }[]; neutralX: number } {
  const dh = c.h0 - c.h1;
  const out: { x: number; p: number; tau: number }[] = [];
  if (!(dh > 0) || !(Rp > 0)) return { samples: out, neutralX: NaN };
  if (p.slabTheory === 'orowan') {
    const { N, dphi, pE, pI, phin, kfG } = orowanBranches(p, c, mu, Rp);
    for (let i = N; i >= 0; i--) {
      const phi = i * dphi;
      const pp = Math.min(pE[i], pI[i]);
      const tau = Math.min(mu * pp, 0.5 * kfG[2 * i]) * (phi > phin ? 1 : -1);
      out.push({ x: -Rp * Math.sin(phi), p: pp, tau });
    }
    return { samples: out, neutralX: -Rp * Math.sin(phin) };
  }
  if (p.slabTheory === 'blandford') {
    const bf = blandFordSetup(p, c, mu, Rp);
    if (!bf) return { samples: out, neutralX: NaN };
    const { phi0, phin, pExit, pEntry } = bf;
    for (let i = n; i >= 0; i--) {
      const phi = (phi0 * i) / n;
      const pp = phi > phin ? pEntry(phi) : pExit(phi);
      out.push({ x: -Rp * phi, p: pp, tau: mu * pp * (phi > phin ? 1 : -1) });
    }
    return { samples: out, neutralX: -Rp * phin };
  }
  const { hm, kEff, arc } = common(p, c, mu, Rp);
  for (let i = n; i >= 0; i--) {
    const sx = (arc * i) / n;                       // distance from the exit
    const pp = kEff * Math.exp((2 * mu * Math.min(sx, arc - sx)) / hm);
    out.push({ x: -sx, p: pp, tau: mu * pp * (sx > arc / 2 ? 1 : -1) });
  }
  return { samples: out, neutralX: -arc / 2 };
}

/** The pass at the selected theory and a given flattened radius. */
export function slabPointAt(p: RollingParams, c: SlabCase, mu: number, Rp: number): SlabPoint {
  switch (p.slabTheory) {
    case 'orowan': return orowan(p, c, mu, Rp);
    case 'blandford': return blandFord(p, c, mu, Rp);
    default: return karman(p, c, mu, Rp);
  }
}

/** The numbers every theory reports the same way. */
function common(p: RollingParams, c: SlabCase, mu: number, Rp: number) {
  const dh = c.h0 - c.h1;
  const hm = (c.h0 + c.h1) / 2;
  const e0 = Math.max(c.entryStrain, 0);
  const kf = meanPlaneStrainLmnRange(p, e0, exitStrain(c));
  const kEff = Math.max(kf - (c.backTension + c.frontTension) / 2, 0);
  const arc = Math.sqrt(Rp * dh);
  const a = (mu * arc) / hm;
  return { dh, hm, kf, kEff, arc, a };
}

/**
 * Siebel / von Kármán.
 *
 *     kf   strain-averaged over *this pass's* span, e0..e1, not from zero -
 *          every stand after the first is handed metal that has already been
 *          hardened (see `meanPlaneStrainLmnRange`)
 *     k*   kf - (sigma_b + sigma_f)/2; both pulls hold the strip apart, so
 *          they come off the resistance the hill is raised from, the same way
 *          they do in Stone's minimum thickness
 *     Qp   (e^a - 1)/a with a = mu L / h̄ - Siebel's friction hill
 *     P    k* Qp L, on the flattened arc L = sqrt(R' dh)
 */
function karman(p: RollingParams, c: SlabCase, mu: number, Rp: number): SlabPoint {
  const { kf, kEff, arc, a } = common(p, c, mu, Rp);
  // expm1, not exp - 1: a is 0.1-ish here and the subtraction throws away
  // the low bits of exactly the quantity the hill is made of.
  const Qp = a > 1e-12 ? Math.expm1(a) / a : 1;
  const meanPressure = kEff * Qp;
  // The neutral point of the distribution drawn for it (see
  // `slabPressureProfile`): mid-arc, on the parabolic arc.
  const phin = arc / (2 * Rp);
  const hn = c.h1 + Rp * phin * phin;
  return {
    load: meanPressure * arc, meanPressure, arc, Rflat: Rp, kf, kEff, Qp, a,
    torque: NaN, neutralX: -arc / 2, forwardSlip: (hn * Math.cos(phin)) / c.h1 - 1,
    theory: 'karman',
  };
}

/** Composite Simpson on [a, b], n even. */
function simpson(f: (x: number) => number, a: number, b: number, n: number): number {
  if (!(b > a)) return 0;
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
}

/**
 * Bland & Ford.
 *
 * With phi the angle from the exit plane, h = h1 + R' phi^2 and the
 * substitution H(phi) = 2 sqrt(R'/h1) atan(sqrt(R'/h1) phi), von Kármán's
 * equation with Coulomb friction and a slowly varying kf integrates to
 *
 *     exit side    p = kf(phi) (h/h1) (1 - sigma_f/kf1) e^{mu H}
 *     entry side   p = kf(phi) (h/h0) (1 - sigma_b/kf0) e^{mu (H0 - H)}
 *
 * and the two meet at the neutral point,
 *
 *     H_n = H0/2 + (1/2mu) ln[ (h1/h0) (1 - sigma_b/kf0) / (1 - sigma_f/kf1) ]
 *
 * The load is R' INT p dphi over the arc, the torque per roll
 * mu R R' [ INT_entry p dphi - INT_exit p dphi ]. kf(phi) is the local
 * plane-strain resistance at the strain the strip has reached at h(phi).
 */
/** Everything Bland & Ford needs on a given radius, or null when the pass has no hill. */
function blandFordSetup(p: RollingParams, c: SlabCase, mu: number, Rp: number) {
  const dh = c.h0 - c.h1;
  const h0 = c.h0, h1 = c.h1;
  const phi0 = Math.sqrt(dh / Rp);
  const s = Math.sqrt(Rp / h1);
  const H = (phi: number) => 2 * s * Math.atan(s * phi);
  const H0 = H(phi0);
  const kf0 = planeStrain(p, strainAt(c, h0));
  const kf1 = planeStrain(p, strainAt(c, h1));
  const fb = 1 - c.backTension / kf0;
  const ff = 1 - c.frontTension / kf1;
  // A pull at or above the yield at either end: nothing to roll against.
  if (!(fb > 0) || !(ff > 0) || !(mu > 0)) return null;
  const Hn = Math.max(0, Math.min(H0,
    0.5 * H0 + Math.log((h1 / h0) * (fb / ff)) / (2 * mu)));
  const phin = Math.tan(Hn / (2 * s)) / s;
  const hAt = (phi: number) => h1 + Rp * phi * phi;
  const kfAt = (phi: number) => planeStrain(p, strainAt(c, hAt(phi)));
  const pExit = (phi: number) => kfAt(phi) * (hAt(phi) / h1) * ff * Math.exp(mu * H(phi));
  const pEntry = (phi: number) => kfAt(phi) * (hAt(phi) / h0) * fb * Math.exp(mu * (H0 - H(phi)));
  return { phi0, phin, pExit, pEntry };
}

function blandFord(p: RollingParams, c: SlabCase, mu: number, Rp: number): SlabPoint {
  const { kf, kEff, arc, a } = common(p, c, mu, Rp);
  const bf = blandFordSetup(p, c, mu, Rp);
  if (!bf) {
    return {
      load: 0, meanPressure: 0, arc, Rflat: Rp, kf, kEff, Qp: 0, a,
      torque: 0, neutralX: NaN, forwardSlip: NaN, theory: 'blandford',
    };
  }
  const { phi0, phin, pExit, pEntry } = bf;
  const hn = c.h1 + Rp * phin * phin;
  const Ie = simpson(pExit, 0, phin, 64);
  const Ii = simpson(pEntry, phin, phi0, 64);
  const load = Rp * (Ie + Ii);
  const meanPressure = load / arc;
  return {
    load, meanPressure, arc, Rflat: Rp, kf, kEff,
    Qp: kEff > 0 ? meanPressure / kEff : 0, a,
    torque: mu * p.R * Rp * (Ii - Ie),
    neutralX: -Rp * phin,
    forwardSlip: (hn * Math.cos(phin)) / c.h1 - 1,
    theory: 'blandford',
  };
}

/**
 * Prandtl's inhomogeneity factor: the mean horizontal stress through a slab
 * sheared at its faces by a = tau/k is p - kf w(a), not p - kf.
 *
 *     w(a) = [ sqrt(1 - a^2) + asin(a)/a ] / 2,   w(0) = 1,  w(1) = pi/4
 */
function inhomogeneity(a: number): number {
  if (a < 1e-6) return 1;
  const aa = Math.min(1, a);
  return 0.5 * (Math.sqrt(Math.max(0, 1 - aa * aa)) + Math.asin(aa) / aa);
}

/** w(1) = pi/4: the factor once the friction has reached the shear yield. */
const W_STICK = inhomogeneity(1);

/**
 * The pressure p from Orowan's yield relation, held at zero or above:
 *
 *     p = max(q + w(a) kf, 0),    a = min(2 mu p / kf, 1)
 *
 * Sticking first: with a = 1 the relation is explicit, p = q + w(1) kf, and it
 * is the answer whenever the friction that pressure would ask for reaches the
 * shear yield.
 *
 * Otherwise the slipping root is bracketed and solved for, not iterated onto.
 * w falls from 1 to pi/4 across [0, 1], so g(p) = p - max(q + w(a(p)) kf, 0)
 * rises strictly, and it has exactly one root, between the sticking pressure
 * and max(q + kf, 0) - for every mu >= 0 and kf > 0. That is proved, not
 * sampled: `docs/proofs/Orowan.lean`, `pressure_existsUnique` and
 * `residual_strictMonoOn`.
 *
 * This used to be the plain iteration p <- max(q + w(a(p)) kf, 0), started at
 * the top of that bracket, 30 rounds, no flag. Its contraction factor is
 * 2 mu |w'(a)|, and |w'| climbs to pi/4 as a -> 1 - so it contracts only for
 * mu < 2/pi. The sticking test was said to exclude the corner where it fails;
 * it excludes a = 1 at the sticking pressure, not a near 1 at the slipping
 * root. Measured over q in [-kf, kf/2]: at mu 0.9 it fell into a two-cycle
 * (0.535 / 0.558 kf against a root of 0.546), pressure off by up to 1.2e-2 kf
 * at mu 0.8 and 3.6e-2 kf at mu 1.0, while under mu 0.5 it stayed within
 * 1.4e-7 kf. The UI and `muFromLoad` both go up to MU_MAX = 1.
 *
 * The step is Newton's, since g' = 1 - 2 mu w'(a) sits in [1, 1 + mu pi/2]
 * wherever the relation is live, with a bisection whenever it would leave the
 * bracket. The slope only sets the speed: the bracket alone is what makes
 * this converge, so an error in it could cost rounds but not the answer.
 */
export function orowanPressure(q: number, kf: number, mu: number): number {
  // with no resistance the relation is p = q; the bracket below would be empty
  if (!(kf > 0)) return Math.max(q, 0);
  const stick = Math.max(q + W_STICK * kf, 0);
  if (2 * mu * stick >= kf) return stick;
  let lo = stick, hi = Math.max(q + kf, 0);
  let p = hi;
  for (let i = 0; i < 100 && hi - lo > 1e-12 * kf; i++) {
    const a = Math.min(1, (2 * mu * p) / kf);
    const w = inhomogeneity(a);
    const t = q + w * kf;
    const g = p - Math.max(t, 0);
    if (g === 0) return p;
    if (g > 0) hi = p; else lo = p;
    // w' = (sqrt(1 - a^2) - w) / a, from (a w)' = sqrt(1 - a^2); 1 where the
    // relation is clamped (t <= 0) or saturated (a = 1) and T does not move
    const live = t > 0 && a < 1 && a >= 1e-6;
    const dg = live ? 1 - (2 * mu * (Math.sqrt(1 - a * a) - w)) / a : 1;
    let next = p - g / dg;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - p) <= 1e-12 * kf) return next;
    p = next;
  }
  return 0.5 * (lo + hi);
}

/**
 * Orowan.
 *
 * The slab between the rolls at angle phi from the exit carries a horizontal
 * force F = q h (q the mean horizontal compressive stress). Its balance,
 * exactly, on the circular arc:
 *
 *     dF/dphi = 2 R' ( p sin phi + s tau cos phi )
 *
 * with s = +1 on the exit side, where the strip outruns the roll and the
 * friction on it points back at the entry, and s = -1 on the entry side.
 * The yield relation with the stress inhomogeneous through the thickness:
 *
 *     q = p - w(a) kf(phi),    a = tau / k,   k = kf / 2
 *
 * and the friction Coulomb until it would exceed the shear yield, sticking
 * after: tau = min(mu p, k). Because w depends on p through a, p is
 * recovered from F by a short fixed-point iteration at every step.
 *
 * Both branches are marched with RK4 - the exit branch from F(0) =
 * -sigma_f h1 outward, the entry branch from F(phi0) = -sigma_b h0 inward -
 * and the pressure is the lower of the two everywhere, which puts the
 * neutral point where they cross. Load and torque are then quadratures of
 * the resulting distribution: the separating force takes the pressure's
 * vertical component and the friction's, the torque the friction's moment
 * about the roll axis, entry side driving and exit side resisting.
 */
/**
 * Orowan's two pressure branches on the sample grid, and where they meet.
 * Exported for the headless checks in tools/slab; the app goes through `orowan`.
 */
export function orowanBranches(p: RollingParams, c: SlabCase, mu: number, Rp: number) {
  const { dh } = common(p, c, mu, Rp);
  const h0 = c.h0, h1 = c.h1;
  const cos0 = 1 - dh / (2 * Rp);
  const phi0 = Math.acos(Math.max(-1, Math.min(1, cos0)));
  const arc = Rp * Math.sin(phi0);
  const N = 120;
  const dphi = phi0 / N;
  const hAt = (phi: number) => h1 + 2 * Rp * (1 - Math.cos(phi));
  // kf and h on the half-step grid the RK4 stages land on, once: the yield
  // law is a pow() and the stages would call it thousands of times over.
  const kfG = new Float64Array(2 * N + 1);
  const hG = new Float64Array(2 * N + 1);
  for (let j = 0; j <= 2 * N; j++) {
    hG[j] = hAt((j * dphi) / 2);
    kfG[j] = planeStrain(p, strainAt(c, hG[j]));
  }
  const pressureOf = (q: number, kfHere: number): number => orowanPressure(q, kfHere, mu);
  // j indexes the half-step grid: phi = j dphi / 2
  const slope = (j: number, F: number, s: number): number => {
    const kfHere = kfG[j];
    const pp = pressureOf(F / hG[j], kfHere);
    const tau = Math.min(mu * pp, 0.5 * kfHere);
    const phi = (j * dphi) / 2;
    return 2 * Rp * (pp * Math.sin(phi) + s * tau * Math.cos(phi));
  };
  // one RK4 step from sample i to i + dir (dir = +1 forward, -1 backward)
  const rk4 = (i: number, F: number, dir: number, s: number): number => {
    const step = dir * dphi;
    const j0 = 2 * i, jm = 2 * i + dir, j1 = 2 * i + 2 * dir;
    const k1 = slope(j0, F, s);
    const k2 = slope(jm, F + (step / 2) * k1, s);
    const k3 = slope(jm, F + (step / 2) * k2, s);
    const k4 = slope(j1, F + step * k3, s);
    return F + (step / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
  };

  const pE = new Float64Array(N + 1);
  const pI = new Float64Array(N + 1);
  let F = -c.frontTension * h1;
  pE[0] = pressureOf(F / h1, kfG[0]);
  for (let i = 0; i < N; i++) {
    F = rk4(i, F, +1, +1);
    pE[i + 1] = pressureOf(F / hG[2 * (i + 1)], kfG[2 * (i + 1)]);
  }
  F = -c.backTension * h0;
  pI[N] = pressureOf(F / hG[2 * N], kfG[2 * N]);
  for (let i = N; i > 0; i--) {
    F = rk4(i, F, -1, -1);
    pI[i - 1] = pressureOf(F / hG[2 * (i - 1)], kfG[2 * (i - 1)]);
  }

  // The neutral point: where the exit branch, rising from the exit, meets
  // the entry branch rising from the entry. Interpolated between samples;
  // at the exit plane if the entry branch is under the exit one everywhere
  // (all backward slip), at the entry plane in the opposite case.
  //
  // `cross` starts past the last sample, so "no crossing" is its own case. It
  // used to start at N, which left the entry-plane branch unreachable and the
  // case to the interpolation on the last interval, with both differences
  // negative. That still landed on the entry plane - the exit branch rises and
  // the entry branch falls towards the entry, so the gap closes there and the
  // fraction clamps to 1 (37 such passes in tools/slab/consistency.mjs, all
  // identical before and after) - but only by that accident.
  let cross = N + 1;
  for (let i = 0; i <= N; i++) if (pE[i] >= pI[i]) { cross = i; break; }
  let phin: number;
  if (cross === 0) phin = 0;
  else if (cross > N) phin = phi0;
  else {
    const d0 = pE[cross - 1] - pI[cross - 1], d1 = pE[cross] - pI[cross];
    const f = d1 !== d0 ? Math.max(0, Math.min(1, -d0 / (d1 - d0))) : 0;
    phin = (cross - 1 + f) * dphi;
  }
  return { N, dphi, phi0, arc, pE, pI, phin, kfG };
}

function orowan(p: RollingParams, c: SlabCase, mu: number, Rp: number): SlabPoint {
  const { kf, kEff, a } = common(p, c, mu, Rp);
  const { N, dphi, arc, pE, pI, phin, kfG } = orowanBranches(p, c, mu, Rp);

  // Quadratures, trapezoid on the sample grid, of the distribution that is
  // actually there: the lower branch, with the friction on whichever side
  // of the neutral point the sample sits.
  let load = 0, drive = 0, resist = 0;
  for (let i = 0; i <= N; i++) {
    const phi = i * dphi;
    const w = i === 0 || i === N ? 0.5 : 1;
    const pp = Math.min(pE[i], pI[i]);
    const kfHere = kfG[2 * i];
    const tau = Math.min(mu * pp, 0.5 * kfHere);
    const s = phi < phin ? 1 : -1;
    load += w * (pp * Math.cos(phi) - s * tau * Math.sin(phi));
    if (s < 0) drive += w * tau; else resist += w * tau;
  }
  load *= Rp * dphi;
  const meanPressure = arc > 0 ? load / arc : 0;
  return {
    load, meanPressure, arc, Rflat: Rp, kf, kEff,
    Qp: kEff > 0 ? meanPressure / kEff : 0, a,
    torque: p.R * Rp * dphi * (drive - resist),
    neutralX: -Rp * Math.sin(phin),
    forwardSlip: ((c.h1 + 2 * Rp * (1 - Math.cos(phin))) * Math.cos(phin)) / c.h1 - 1,
    theory: 'orowan',
  };
}
