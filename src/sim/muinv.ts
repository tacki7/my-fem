/**
 * Friction back-calculation - the mu a measured rolling load implies.
 *
 * The forward direction here is a slab (Siebel / von Karman) estimate with
 * tension and roll flattening in it, and nothing else: hand it a pass
 * (h0, h1, R, sigma_b, sigma_f and the LMN resistance law) and a friction
 * coefficient, and it returns a load. `muFromLoad` runs that same function
 * backwards by bisection.
 *
 * Three things about it are deliberate, and all three are scars.
 *
 * **It is a closed model, not a correction on the running solution.** An
 * earlier attempt measured the ratio between the FEM's load and the slab
 * estimate at whatever operating point the mill happened to be sitting on, and
 * inverted the slab formula scaled by that ratio. Round-tripped at that same
 * operating point it looked perfect - it has to, the ratio is defined to make
 * it so - and it was out by up to 60 % anywhere else. A back-calculation is
 * only worth anything at inputs the mill is *not* currently at, which is the
 * whole use case: someone types in what the load cell read and asks what
 * friction would explain it.
 *
 * **It is bisected, not stepped to.** P(mu) is monotone increasing, so a
 * bracket cannot lose the answer. Secant and gradient steps are faster and
 * were tried: below mu ~ 0.005 the bite condition mu >= tan(alpha) fails, the
 * pass stops being physical and the monotonicity both of them assume is gone -
 * and one step into that region never came back. A secant version answered
 * 0.001 to a pass whose answer was 0.06.
 *
 * **Nothing in it reads the clock or the solver.** Every input is a number off
 * the stand table, so pressing the button twice on unchanged inputs gives the
 * same answer twice, and the answer is available immediately rather than after
 * the line has re-settled. The load it reproduces is this model's load, not the
 * FEM's - see `slabLoad` for what that does and does not include.
 */

import { meanPlaneStrainLmnRange, type RollingParams } from './solver';

/**
 * The friction the search will look between.
 *
 * The floor is not a numerical convenience. Under it the bite condition
 * mu >= tan(alpha) fails for any ordinary draft, so the model would be
 * describing a pass that cannot be threaded, and its own monotonicity goes
 * with it. The ceiling is well past where sticking friction has taken over.
 * An answer outside either is reported as out of range rather than clamped: a
 * clamped mu is a number that does not reproduce the load it came from, which
 * is the one property this whole file exists to have.
 */
export const MU_MIN = 0.005;
export const MU_MAX = 1.0;

/** One pass, as the back-calculation sees it. */
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

/** What the forward model says about a pass at one friction coefficient. */
export interface SlabPoint {
  /** rolling load per unit width [N/m]; Infinity if the flattening runs away */
  load: number;
  /** mean interface pressure [Pa] */
  meanPressure: number;
  /** contact arc, on the flattened radius [m] */
  arc: number;
  /** flattened radius R' [m] */
  Rflat: number;
  /** strain-averaged plane-strain resistance across this pass [Pa] */
  kf: number;
  /** what the friction hill is actually built on, kf - (sigma_b + sigma_f)/2 [Pa] */
  kEff: number;
  /** friction hill factor (e^a - 1)/a */
  Qp: number;
  /** a = mu L / h̄ */
  a: number;
}

/** 2/sqrt(3): the draft ln(h0/h1) as a plane-strain equivalent strain. */
const EQ = 2 / Math.sqrt(3);

/** Equivalent strain the strip leaves this pass with. */
export function exitStrain(c: SlabCase): number {
  return Math.max(c.entryStrain, 0) + EQ * Math.log(c.h0 / c.h1);
}

/**
 * Rolling load per unit width at one friction coefficient.
 *
 *     kf   strain-averaged over *this pass's* span, e0..e1, not from zero -
 *          every stand after the first is handed metal that has already been
 *          hardened (see `meanPlaneStrainLmnRange`)
 *     k*   kf - (sigma_b + sigma_f)/2; both pulls hold the strip apart, so
 *          they come off the resistance the hill is raised from, the same way
 *          they do in Stone's minimum thickness a few hundred lines away in
 *          `solver.ts`
 *     Qp   (e^a - 1)/a with a = mu L / h̄ - Siebel's friction hill
 *     P    kf* Qp L, on the flattened arc L = sqrt(R' dh)
 *
 * Deliberately *not* in here: the FEM's own contact solution, the elastic
 * entry and exit zones, work hardening across the arc as anything but an
 * average, and any heating. This is the textbook estimate the app already
 * plots as スラブ法 荷重, plus tension, and the mu it hands back is the mu that
 * makes *this* formula reproduce the load - which is what makes the round trip
 * exact and also what keeps it a few percent away from the FEM.
 */
export function slabLoad(p: RollingParams, c: SlabCase, mu: number): SlabPoint {
  const dh = c.h0 - c.h1;
  const hm = (c.h0 + c.h1) / 2;
  const e0 = Math.max(c.entryStrain, 0);
  const kf = meanPlaneStrainLmnRange(p, e0, exitStrain(c));
  const kEff = Math.max(kf - (c.backTension + c.frontTension) / 2, 0);
  const C = (16 * (1 - p.nuRoll * p.nuRoll)) / (Math.PI * p.Eroll);

  const at = (Rp: number): SlabPoint => {
    const arc = Math.sqrt(Rp * dh);
    const a = (mu * arc) / hm;
    // expm1, not exp - 1: a is 0.1-ish here and the subtraction throws away
    // the low bits of exactly the quantity the hill is made of.
    const Qp = a > 1e-12 ? Math.expm1(a) / a : 1;
    const meanPressure = kEff * Qp;
    return { load: meanPressure * arc, meanPressure, arc, Rflat: Rp, kf, kEff, Qp, a };
  };

  if (!p.rollCoupling) return at(c.R);

  // Hitchcock, approached from below. R' = R (1 + C P(R')/dh) is an increasing
  // map of R', and R' = R sits under its own image, so the iteration climbs
  // monotonically onto the *smallest* fixed point - the physical one. The map
  // also has a second, spurious crossing further out where the exponential has
  // taken over, and every method that does not start below and climb can land
  // on it.
  //
  // No fixed point at all is a real answer, not a failure: past Stone's
  // minimum rollable thickness the roll flattens faster than the gap closes
  // and the pass has no steady solution. Reported as an infinite load, which
  // is exactly what the bisection outside needs to hear - "mu is too high".
  const cap = c.R * 1e4;
  let Rp = c.R;
  for (let i = 0; i < 4000; i++) {
    const next = c.R * (1 + (C * at(Rp).load) / dh);
    if (!(next > 0) || next > cap) break;
    if (Math.abs(next - Rp) <= 1e-14 * next) return at(next);
    Rp = next;
  }
  return {
    load: Infinity, meanPressure: Infinity, arc: Infinity, Rflat: Infinity,
    kf, kEff, Qp: Infinity, a: Infinity,
  };
}

/**
 * Why a back-calculation has no answer, when it has none.
 *
 * All four are conditions on the *inputs*, not on the search - the bisection
 * itself cannot fail once a bracket exists. They are separate values rather
 * than one error because each one names a different field to go and fix.
 */
export type MuInverseStatus =
  /** solved */
  | 'ok'
  /** h1 >= h0, or a thickness / radius that is not a positive number */
  | 'geometry'
  /** the mean pull is at or above the deformation resistance: no pass at all */
  | 'tension'
  /** the flattening runs away even at MU_MIN - under Stone's minimum thickness */
  | 'runaway'
  /** the load asked for is below what this pass gives at MU_MIN */
  | 'low'
  /** the load asked for is above what this pass gives at MU_MAX */
  | 'high';

export interface MuInverseResult {
  status: MuInverseStatus;
  /** the answer; only meaningful when `status` is 'ok' */
  mu: number;
  /** the forward model evaluated at `mu` - i.e. what the answer reproduces */
  point: SlabPoint | null;
  /** load this pass gives at MU_MIN and at MU_MAX [N/m], for the range messages */
  loadAtMin: number;
  loadAtMax: number;
  /**
   * (P(mu) - P_asked) / P_asked.
   *
   * The point of the whole exercise, and the number to look at before
   * believing any of the rest: run forwards, the mu handed back has to
   * reproduce the load it was derived from. Bisection to the last bit of a
   * double leaves this at 1e-16, not at "close enough" - which matters,
   * because d ln P / d ln mu is only about 0.15 on this model, so a load
   * matched to 1 % would be a mu wrong by 7 %.
   */
  residual: number;
  /** bisection steps taken; 0 whenever the status is not 'ok' */
  iterations: number;
}

/**
 * The friction that makes `slabLoad` return `load` for this pass.
 *
 * Bisection on the bracket [MU_MIN, MU_MAX], run to the last representable
 * bit rather than to a tolerance: the cost is 50-odd evaluations of a closed
 * form, and stopping early would put the error straight into the answer at
 * seven times the size (see `residual`).
 */
export function muFromLoad(
  p: RollingParams, c: SlabCase, load: number,
): MuInverseResult {
  const fail = (status: MuInverseStatus, lo = 0, hi = 0): MuInverseResult => ({
    status, mu: 0, point: null, loadAtMin: lo, loadAtMax: hi,
    residual: NaN, iterations: 0,
  });

  if (!(c.h0 > 0) || !(c.h1 > 0) || !(c.R > 0) || c.h1 >= c.h0) return fail('geometry');
  if (!(load > 0) || !Number.isFinite(load)) return fail('geometry');

  const at0 = slabLoad(p, c, MU_MIN);
  if (!(at0.kEff > 0)) return fail('tension');
  if (!Number.isFinite(at0.load)) return fail('runaway', at0.load, at0.load);
  const at1 = slabLoad(p, c, MU_MAX);
  if (load <= at0.load) return fail('low', at0.load, at1.load);
  if (load >= at1.load) return fail('high', at0.load, at1.load);

  let lo = MU_MIN, hi = MU_MAX, it = 0;
  // Halving a bracket of 1 down to a double's last bit is 52 steps; the cap is
  // there so a pathological input cannot spin, not because it is ever reached.
  while (hi - lo > 1e-15 * hi && it < 200) {
    const mid = 0.5 * (lo + hi);
    if (slabLoad(p, c, mid).load < load) lo = mid; else hi = mid;
    it++;
  }
  const mu = 0.5 * (lo + hi);
  const point = slabLoad(p, c, mu);
  return {
    status: 'ok', mu, point,
    loadAtMin: at0.load, loadAtMax: at1.load,
    residual: (point.load - load) / load,
    iterations: it,
  };
}
