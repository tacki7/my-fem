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
 * FEM's - see `slabLoad` for what that does and does not include, and
 * `slab.ts` for the three theories it can be.
 */

import type { RollingParams } from './solver';
import { slabPointAt, type SlabCase, type SlabPoint } from './slab';

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

export { exitStrain, slabKfProfile, slabPressureProfile, SLAB_THEORY_LABEL, FLATTENING_LABEL } from './slab';
export type { SlabCase, SlabPoint } from './slab';

/**
 * The flattened radius a load P [N/m] gives a roll of radius R on a draft dh,
 * by the selected model. Both are increasing in P, which is what the fixed
 * point below relies on.
 *
 *   hitchcock  R' = R (1 + C P/dh), C = 16 (1 - nu^2)/(pi E). The classical
 *              form: an elliptical pressure over the arc, the deformed arc
 *              still circular. Its contact length is L = sqrt(R' dh), so
 *              L^2 = R dh + C R P, and at zero draft L = sqrt(C R P) - twice
 *              the Hertz half-width b, b^2 = C R P / 4.
 *   roberts    the arc of contact written as the plastic parabola plus one
 *              Hertz half-width, L = b + sqrt(b^2 + R dh) - the form Roberts
 *              (Cold Rolling of Steel, 1978) gave against Hitchcock's for
 *              thin strip, where the elastic contact is a large share of the
 *              arc. Same L = 2b at zero draft; a longer arc, i.e. more
 *              flattening, at any real draft (on the default pass 12.1 mm
 *              against Hitchcock's 10.5). The equivalent radius the slab
 *              theories then roll with is R' = L^2/dh.
 *
 * The constant in Roberts' x0 follows this reading of the form, with the
 * Hertz half-width as the added length; a reference that quotes a different
 * coefficient changes one line here.
 */
export function flatRadius(p: RollingParams, c: SlabCase, load: number): number {
  const dh = c.h0 - c.h1;
  const C = (16 * (1 - p.nuRoll * p.nuRoll)) / (Math.PI * p.Eroll);
  if (p.flattening === 'roberts') {
    const b2 = (C * c.R * load) / 4;
    const L = Math.sqrt(b2) + Math.sqrt(b2 + c.R * dh);
    return (L * L) / dh;
  }
  return c.R * (1 + (C * load) / dh);
}

/**
 * Rolling load per unit width at one friction coefficient, on the selected
 * slab theory (`p.slabTheory` - see `slab.ts` for the three), with the roll
 * flattened by the selected model (`p.flattening` - see `flatRadius`) unless
 * a radius `Rp` is handed in.
 *
 * Deliberately *not* in any of them: the FEM's own contact solution, the
 * elastic entry and exit zones, and any heating. This is the textbook
 * estimate the app plots as スラブ法 荷重, plus tension, and the mu that
 * `muFromLoad` hands back is the mu that makes *this* formula reproduce the
 * load - which is what makes the round trip exact and also what keeps it a
 * few percent away from the FEM.
 */
export function slabLoad(p: RollingParams, c: SlabCase, mu: number, Rp?: number): SlabPoint {
  const at = (R: number): SlabPoint => slabPointAt(p, c, mu, R);
  if (Rp !== undefined) return at(Rp);
  if (!p.rollCoupling) return at(c.R);

  // The flattening fixed point, approached from below. R' = flat(P(R')) is
  // an increasing map of R' for either model, and R' = R sits under its own
  // image, so the iteration climbs monotonically onto the *smallest* fixed
  // point - the physical one. The map also has a second, spurious crossing
  // further out where the exponential has taken over, and every method that
  // does not start below and climb can land on it.
  //
  // No fixed point at all is a real answer, not a failure: past Stone's
  // minimum rollable thickness the roll flattens faster than the gap closes
  // and the pass has no steady solution. Reported as an infinite load, which
  // is exactly what the bisection outside needs to hear - "mu is too high".
  //
  // Bounded, because two of the theories integrate numerically and cost a
  // few thousand evaluations of the yield law each: a climb that is not
  // going to arrive must be given up early. R'/R of a hundred is far past
  // anything a pass survives (Stone's limit is reached long before), and a
  // sequence whose steps have been growing for five rounds is diverging,
  // not converging. A climb still shrinking its steps at the iteration cap
  // is accepted where it is - within the tolerance of the integrators.
  const cap = c.R * 100;
  let R = c.R;
  let lastStep = Infinity, growing = 0;
  for (let i = 0; i < 400; i++) {
    const next = flatRadius(p, c, at(R).load);
    if (!(next > 0) || next > cap) break;
    const step = next - R;
    if (step <= 1e-12 * next) return at(next);
    growing = step > lastStep ? growing + 1 : 0;
    if (growing >= 5) break;
    lastStep = step;
    R = next;
    if (i === 399) return at(R);
  }
  const last = at(R);
  return {
    ...last,
    load: Infinity, meanPressure: Infinity, arc: Infinity, Rflat: Infinity,
    Qp: Infinity, a: Infinity, torque: Infinity, neutralX: NaN, forwardSlip: NaN,
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
