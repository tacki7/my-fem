/**
 * The rolls' deformation from a finer model, fed back into this one: the coupling with
 * FrontISTR's solids (tools/frontistr/couple.mjs, and the 3D tab through the bridge).
 *
 * The roll model here - Timoshenko beams, line-contact flattening - is fast and close; the solids
 * are slow and closer. They are coupled by a correction of the work roll's surface: under the
 * load the strip puts on the rolls, the solids' surface where the strip leaves stands a little
 * higher or lower than the model's, and that difference δ(x) is added to the model's gap
 * (`StackSolver.setRollCorrection`). The model then solves the pass again - the strip, the
 * tensions, the screw - with its surface where the solids put it, which changes the load, which
 * changes the solids' answer... Each round is one FrontISTR solve and one re-convergence here.
 * The pair is steady when δ and the load stop moving: the pass then carries the load under which
 * the solids' rolls have exactly the surface the strip was rolled with.
 *
 * The model keeps its own tangent throughout, so the rounds converge the way a defect correction
 * does: the two models differ by a percent or two in stiffness, and each round takes that much
 * of the remaining difference.
 */
import type { StackSolver } from './solver';

/**
 * The model's own work-roll surface under the load it carries, per station [m]: the axis's
 * vertical displacement against the screw roll's bearings, plus the work roll's flattening by the
 * strip, + away from the strip. What the solids' surface is compared with (the solids hold the
 * bearings, and their surface displacement is the axis's and the indentation's together). NaN off
 * the strip. The correction in force is not in it: this is the model's answer, not the gap.
 */
export function modelRollSurface(sv: StackSolver): Float64Array {
  const st = sv.stack, R = sv.result, ns = sv.ns;
  const wr = sv.rolls[st.wr];
  const screw = sv.rolls[st.screwRolls[0]];
  let vb = 0;
  for (const s of screw.supports) vb += screw.v[s];
  vb /= Math.max(screw.supports.length, 1);
  const out = new Float64Array(ns).fill(NaN);
  for (let s = 0; s < ns; s++) {
    const q = R.q[s], flat = R.flat[s];
    if (!(q > 0) || !Number.isFinite(flat) || !Number.isFinite(wr.v[s])) continue;
    out[s] = wr.v[s] - vb + flat;
  }
  return out;
}

/** a profile given at points xs (x ≥ 0 on a half model, or both sides), read at x: linear, the ends held; |x| when `mirror` */
export function interpolateProfile(xs: ArrayLike<number>, v: ArrayLike<number>, x: number, mirror = true): number {
  const t = mirror ? Math.abs(x) : x;
  const n = xs.length;
  if (n === 0) return NaN;
  if (t <= xs[0]) return v[0];
  if (t >= xs[n - 1]) return v[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= t) lo = m; else hi = m; }
  const f = (t - xs[lo]) / (xs[hi] - xs[lo]);
  return v[lo] + f * (v[hi] - v[lo]);
}

export interface CouplingOptions {
  /** the share of each round's new difference taken (1: all of it) */
  relax?: number;
  /** steady once no station's correction moved by more than this in a round [m] */
  tolSurface?: number;
  /** and the load by less than this share of itself */
  tolForce?: number;
}

export interface CouplingRound {
  round: number;
  /** the largest move of the correction over the strip this round [m] */
  change: number;
  /** |F − F_previous| / F, NaN in the first round */
  forceChange: number;
  force: number;
  converged: boolean;
}

/**
 * The correction and its rounds. `step` takes the model's surface and the solids' surface (per
 * station, NaN where there is none) under the load the model had converged on, and returns the
 * correction for the next solve.
 */
export class RollCoupling {
  readonly delta: Float64Array;
  readonly rounds: CouplingRound[] = [];
  private readonly relax: number;
  private readonly tolSurface: number;
  private readonly tolForce: number;

  constructor(ns: number, o: CouplingOptions = {}) {
    this.delta = new Float64Array(ns);
    this.relax = o.relax ?? 1;
    // 0.25 µm on the surface is 0.5 µm on the gap (both rolls): a tenth of what the crown is read to
    this.tolSurface = o.tolSurface ?? 0.25e-6;
    // the load: its tenth of a percent - the model's sensitivity d ln P / d ln μ ≈ 0.15 makes a
    // tighter figure mean nothing next to the friction the pass is given
    this.tolForce = o.tolForce ?? 1e-3;
  }

  step(model: ArrayLike<number>, fem: ArrayLike<number>, force: number): CouplingRound {
    let change = 0;
    for (let s = 0; s < this.delta.length; s++) {
      if (!Number.isFinite(model[s]) || !Number.isFinite(fem[s])) continue;
      const target = fem[s] - model[s];
      const next = this.delta[s] + this.relax * (target - this.delta[s]);
      change = Math.max(change, Math.abs(next - this.delta[s]));
      this.delta[s] = next;
    }
    const prev = this.rounds.length ? this.rounds[this.rounds.length - 1].force : NaN;
    const forceChange = Number.isFinite(prev) ? Math.abs(force - prev) / Math.max(Math.abs(force), 1) : NaN;
    // steady: the correction has stopped moving, and so has the load it was made under
    const converged = this.rounds.length > 0 && change <= this.tolSurface && forceChange <= this.tolForce;
    const r = { round: this.rounds.length + 1, change, forceChange, force, converged };
    this.rounds.push(r);
    return r;
  }
}
