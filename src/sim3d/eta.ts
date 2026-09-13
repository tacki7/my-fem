/**
 * How long a solve still has to run, from how it has gone so far.
 *
 * A solve has two stretches (see `StackSolver.advance`). First the Newton
 * settles the stack and walks the screw to its target: the residual falls,
 * a decade or two an iteration once the rolls have stopped moving at the
 * step clip. Then, with a strip FEM, correction rounds follow - each one a
 * FEM solve and a short Newton to settle again - until the correction's
 * change is under its tolerance (or loosely under it for several rounds).
 *
 * Rounds still needed come from how the change has fallen. The first
 * round-to-round ratio is left out: the correction's first update is the
 * plain damped step (×0.7 by construction) before the Anderson history
 * exists, and extrapolating from it asked for twice the rounds a solve
 * takes. The later ratios are shrunk towards a typical 0.3.
 *
 * What a round costs comes from the time between rounds, which holds the
 * FEM solve, the Newton and whatever the page does between frames. Rounds
 * get quicker as the correction settles (the strip FEMs start from their
 * last solution, and the Newton needs fewer steps), so the next rounds are
 * taken to shrink at the rate the last few did. Before a second round there
 * is no interval to go by: the last solve's typical round is used, or,
 * failing that, a share of the first round's FEM solve - which runs from
 * scratch and costs several later ones.
 *
 * Everything is wall-clock time from the samples the caller takes, and the
 * shown end time follows the estimates with a time constant, so a solve
 * sampled rarely (long frames) is not smoothed into lagging. What cannot be
 * told yet - no round cost known, or the screw still walking at the clip
 * with nothing to go by - is reported as such, and a solve whose residual
 * has stopped falling with no round in sight as stalled.
 *
 * Checked by replaying recorded solves (`tools/sim3d/eta.mjs`), sampled as
 * the page's frames would sample them.
 */

import { CONVERGENCE as C, type SolveProgress } from './solver';

/** rounds a solve from scratch and one from a kept correction take, before any change is seen (medians over the bench cases) */
const ROUNDS_COLD = 8;
const ROUNDS_WARM = 4;
/** per-round reduction of the change assumed before one is observed, its weight in rounds, and the bounds on the estimate */
const RHO_PRIOR = 0.3;
const RHO_PRIOR_WEIGHT = 2;
const RHO_MIN = 0.1;
const RHO_MAX = 0.9;
/** round-to-round change of a round's duration assumed before one is observed, the rounds it is taken over, and its bounds */
const SHRINK_PRIOR = 0.9;
const SHRINK_WINDOW = 3;
const SHRINK_MIN = 0.6;
const SHRINK_MAX = 1;
/** before a second round: the share of the first round's FEM solve a later round's takes, and the iterations a round settles in */
const FIRST_FEM_SHARE = 0.15;
const ITERS_PER_ROUND = 3;
/** decades of residual one Newton iteration removes once the rolls have stopped moving at the clip */
const DECADES_PER_ITER = 1.5;
/**
 * Time constant of the shown end time [ms]. Longer holds the number steadier
 * and lags a real change: replayed, 200 ms moved the predicted end by 0.75 s
 * per second shown against 0.57 s at 400 ms, for a median error of 23 % against
 * 25 % (light page work; with heavy page work 400 ms was the more accurate).
 */
const FOLLOW_MS = 400;
/** iterations without the residual halving, and without a round, after which the solve is called stalled */
const STALL_ITERS = 80;
/**
 * Rounds without the smallest change so far halving, after which the solve
 * is called stalled: the correction has fallen into a cycle (a change of
 * 23 to 810 over and over, eight rounds a lap, after friction was dropped to
 * 0.01 on a settled 4Hi). The slowest solve that converges, friction 0.3,
 * went seven rounds at most.
 */
const STALL_ROUNDS = 10;
/** intervals a finished solve's typical round is taken from, for the next solve */
const PRIOR_WINDOW = 4;

export type Eta =
  | { kind: 'remaining'; ms: number }
  /** not enough seen yet to say */
  | { kind: 'estimating' }
  /** the residual has stopped falling and nothing is left that would move the solve on */
  | { kind: 'stalled' }
  | { kind: 'done' };

interface Round { index: number; now: number; change: number }

export class RemainingTime {
  private last: { now: number; p: SolveProgress } | null = null;
  private key = '';
  /** wall-clock ms per Newton iteration, from samples without a round in them */
  private iterMs = NaN;
  private rounds: Round[] = [];
  /** the smallest change so far, and the round it came in (halvings only) */
  private bestChange = Infinity;
  private bestChangeRound = 0;
  /** the first round's FEM solve, as the sample it came in took beyond its iterations [ms] */
  private firstFem = NaN;
  private firstStretch = NaN;
  private bestResidual = Infinity;
  private bestAt = 0;
  /** the shown end time, following the estimates */
  private end = NaN;
  private endAt = NaN;
  /** from the last solve with the same key: its typical round [ms] and the iterations its first stretch took */
  private roundPrior = NaN;
  private firstStretchPrior = NaN;

  /**
   * Feed one sample. `now` is a wall-clock time that runs while the solve
   * does (the caller leaves out pauses); `key` names what a round's cost
   * depends on - strip model and mesh - so a solve borrows the last one's
   * timings only when they apply.
   */
  update(now: number, p: SolveProgress, key: string): Eta {
    if (key !== this.key) {
      this.key = key;
      this.roundPrior = NaN;
      this.firstStretchPrior = NaN;
      this.iterMs = NaN;
      this.begin();
    } else if (this.last && p.solve !== this.last.p.solve) {
      this.keepForNext();
      this.begin();
    }
    this.measure(now, p);
    this.last = { now, p };

    if (p.converged) return this.show(now, { kind: 'done' });
    const moving = p.stepMax >= 0.9 * C.stepClip;
    const noRoundComing = !p.usesFem || p.residual >= C.nearSettled || p.sinceRound > 2 * C.escapeIters;
    if (!moving && p.iterations - this.bestAt > STALL_ITERS && noRoundComing) return this.show(now, { kind: 'stalled' });
    if (this.rounds.length > 0 && this.rounds[this.rounds.length - 1].index - this.bestChangeRound >= STALL_ROUNDS) {
      return this.show(now, { kind: 'stalled' });
    }
    const raw = this.estimate(now, p, moving);
    return this.show(now, raw === null ? { kind: 'estimating' } : { kind: 'remaining', ms: raw });
  }

  private begin(): void {
    this.last = null;
    this.rounds = [];
    this.bestChange = Infinity;
    this.bestChangeRound = 0;
    this.firstFem = NaN;
    this.firstStretch = NaN;
    this.bestResidual = Infinity;
    this.bestAt = 0;
    this.end = NaN;
  }

  /** what the finished solve says about the next one on the same mesh */
  private keepForNext(): void {
    const iv = this.intervals();
    if (iv.length) {
      const recent = iv.slice(-PRIOR_WINDOW).sort((a, b) => a - b);
      const mid = recent.length >> 1;
      this.roundPrior = recent.length % 2 ? recent[mid] : 0.5 * (recent[mid - 1] + recent[mid]);
    }
    if (Number.isFinite(this.firstStretch)) this.firstStretchPrior = this.firstStretch;
  }

  private measure(now: number, p: SolveProgress): void {
    const last = this.last;
    if (last) {
      const dIt = p.iterations - last.p.iterations;
      const dt = now - last.now;
      if (p.rounds > last.p.rounds) {
        if (this.rounds.length === 0) {
          this.firstStretch = last.p.iterations + 1;
          this.firstFem = Math.max(0, dt - dIt * (Number.isFinite(this.iterMs) ? this.iterMs : 0));
        }
        this.rounds.push({ index: p.rounds, now, change: p.femChange });
        if (p.femChange < 0.5 * this.bestChange) { this.bestChange = p.femChange; this.bestChangeRound = p.rounds; }
        this.bestResidual = Infinity;
        this.bestAt = p.iterations;
      } else if (p.rounds < last.p.rounds) {
        // the screw stepped and the rounds start over
        this.rounds = [];
        this.bestChange = Infinity;
        this.bestChangeRound = 0;
      } else if (dIt > 0 && dt > 0) {
        const perIter = dt / dIt;
        this.iterMs = Number.isFinite(this.iterMs) ? this.iterMs + 0.3 * (perIter - this.iterMs) : perIter;
      }
    }
    if (p.residual < 0.5 * this.bestResidual) { this.bestResidual = p.residual; this.bestAt = p.iterations; }
  }

  /** the shown value: the end time follows the estimate with a time constant */
  private show(now: number, e: Eta): Eta {
    if (e.kind !== 'remaining') { this.end = NaN; return e; }
    const target = now + e.ms;
    if (!Number.isFinite(this.end)) this.end = target;
    else this.end += (1 - Math.exp(-Math.max(0, now - this.endAt) / FOLLOW_MS)) * (target - this.end);
    this.endAt = now;
    return { kind: 'remaining', ms: Math.max(0, this.end - now) };
  }

  /** wall-clock duration of each round so far, per round */
  private intervals(): number[] {
    const r = this.rounds, out: number[] = [];
    for (let k = 1; k < r.length; k++) out.push((r[k].now - r[k - 1].now) / Math.max(1, r[k].index - r[k - 1].index));
    return out;
  }

  /** rounds still to run, the next one included */
  private roundsLeft(p: SolveProgress): number {
    const r = this.rounds;
    if (r.length === 0) return p.warm ? ROUNDS_WARM : ROUNDS_COLD;
    const change = r[r.length - 1].change;
    let sum = Math.log(RHO_PRIOR) * RHO_PRIOR_WEIGHT, weight = RHO_PRIOR_WEIGHT;
    for (let k = 1; k < r.length; k++) {
      // the first round's update is the damped step, not the rate
      if (r[k - 1].index <= 1 || !(r[k - 1].change > 0 && r[k].change > 0)) continue;
      sum += Math.log(r[k].change / r[k - 1].change);
      weight += r[k].index - r[k - 1].index;
    }
    const rho = Math.min(RHO_MAX, Math.max(RHO_MIN, Math.exp(sum / weight)));
    let n = change <= C.femTol ? 1 : Math.max(1, Math.ceil(Math.log(C.femTol / change) / Math.log(rho)));
    if (change <= C.femLooseTol) n = Math.min(n, Math.max(1, C.femLooseRuns - p.looseRuns));
    return n;
  }

  /** the Newton iterations the first stretch still needs, or null while the rolls walk at the clip with nothing to go by */
  private firstStretchLeft(p: SolveProgress, moving: boolean): number | null {
    if (moving) return Number.isFinite(this.firstStretchPrior) ? Math.max(3, this.firstStretchPrior - p.iterations) : null;
    const decades = Math.log10(Math.max(p.residual, C.residual) / C.residual);
    return Math.ceil(decades / DECADES_PER_ITER) + 1;
  }

  private estimate(now: number, p: SolveProgress, moving: boolean): number | null {
    if (!Number.isFinite(this.iterMs)) return null;
    if (!p.usesFem || this.rounds.length === 0) {
      const n = this.firstStretchLeft(p, moving);
      if (n === null) return null;
      if (!p.usesFem) return n * this.iterMs;
      if (!Number.isFinite(this.roundPrior)) return null;
      return n * this.iterMs + this.roundsLeft(p) * this.roundPrior;
    }
    // the next round's duration, and how the ones after it shrink
    const iv = this.intervals();
    let next: number, shrink = 1;
    if (iv.length === 0) {
      next = Number.isFinite(this.roundPrior) ? this.roundPrior : FIRST_FEM_SHARE * this.firstFem + ITERS_PER_ROUND * this.iterMs;
    } else {
      let sum = Math.log(SHRINK_PRIOR), weight = 1;
      for (let k = Math.max(1, iv.length - SHRINK_WINDOW); k < iv.length; k++) {
        if (iv[k] > 0 && iv[k - 1] > 0) { sum += Math.log(iv[k] / iv[k - 1]); weight++; }
      }
      shrink = Math.min(SHRINK_MAX, Math.max(SHRINK_MIN, Math.exp(sum / weight)));
      next = iv[iv.length - 1] * shrink;
    }
    if (!Number.isFinite(next)) return null;
    const last = this.rounds[this.rounds.length - 1];
    let total = Math.max(this.iterMs, last.now + next - now);
    for (let k = 1, d = next; k < this.roundsLeft(p); k++) { d *= shrink; total += d; }
    return total;
  }
}
