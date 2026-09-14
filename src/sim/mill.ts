/**
 * A mill line: a chain of `RollingSim`s, run as one of two machines.
 *
 * **Tandem** - every stand bites the same strip at the same time, so all three
 * of a real tandem line's couplings hold:
 *
 *   thickness  h_in(k) = h_out(k-1)
 *   mass flow  v_in(k) = v_out(k-1),  i.e. Q = v*h is the same everywhere
 *   tension    sigma_front(k) = sigma_back(k+1), the interstand pull
 *
 * **Reverse** - one stand, the strip driven back and forth between two coilers,
 * so each element of the chain is a *pass* rather than a stand. Only the
 * thickness coupling survives, because that is the pass schedule itself: pass k
 * starts from what pass k-1 delivered. The other two do not, and both would be
 * wrong to keep:
 *
 *   - Mass flow couples things that roll *at the same time*. Consecutive passes
 *     are separated in time, and the mill is re-threaded between them, so there
 *     is no speed cone to hold - each pass runs at whatever speed it is given.
 *   - Tension is set by the two coilers on either side of the stand, and they
 *     are re-tensioned for every pass. The pull leaving pass k has nothing to
 *     do with the pull entering pass k+1, so both ends of every pass are
 *     independent inputs.
 *
 * Nothing else is shared. Each stand keeps its own roll, its own gap loop and
 * its own convergence, which is what makes the pass-schedule search work: put
 * every stand in load control and the chain settles onto the schedule that
 * meets every target at once, because each stand's answer feeds the next one's
 * entry gauge and the loop closes on its own.
 *
 * Thickness is chained *live*, without rebuilding. That is deliberate: the
 * strip mesh is re-laid into the gap every frame from h0, so it follows a
 * moving entry gauge on its own, while `rebuild()` would throw away the
 * velocity field, the strain and the flattening state - i.e. exactly the
 * convergence the chain is trying to reach. The analysis window is the one
 * thing that does not follow, so `windowStrain` reports how far each stand has
 * drifted from the gauge its window was fitted for.
 */

import { RollingSim, type RollingParams, type AgcMode } from './solver';
import {
  newGapState, piStep, plantGain, speedSensitivity, type GapState, type TensionModel,
} from './tension';
import { slabPointAt } from './slab';

/** frames a gap must have been ready (see `updateTension`) before its reaction is first read */
const WARM_FRAMES = 30;
/** downstream mesh residual (columns) under which its bite is taken as placed */
const MESH_WARM = 0.5;

/** Hard cap on stands (tandem) or passes (reverse); the UI offers 1..MAX_STANDS. */
export const MAX_STANDS = 8;

/**
 * Which machine the chain is standing in for.
 *
 * It is not a display option: it decides which couplings between the elements
 * of the chain exist at all, so the same setups solve differently under each.
 */
export type LineMode = 'tandem' | 'reverse';

/**
 * A stand's feed counts as steady when the upstream exit gauge has drifted less
 * than this, in relative terms, over `STEADY_WINDOW` frames.
 *
 * Net drift over a window, not movement per frame: a load-controlled stand
 * nudges its screws every few frames forever, so its gauge always *moves* even
 * when it is going nowhere. Judged frame by frame that jitter reads as "still
 * settling" and the rest of the line stays frozen behind it permanently.
 */
const FEED_STEADY = 2e-4;
const STEADY_WINDOW = 90;
/**
 * Longest a stand may be held waiting for its feed, in frames.
 *
 * The hold is worth having while the line is far from its schedule and the
 * gauges are swinging. It is not worth having forever: a load loop settles to
 * a few times its own deadband and then nudges there indefinitely, so a stand
 * behind it can wait for a stillness that never comes. Past this it goes ahead
 * and controls against a feed that is merely nearly steady, which is what the
 * gap loop's own damping is for.
 */
const HOLD_MAX = 900;

/**
 * Largest relative step the chain may put on a stand's entry gauge in one
 * frame.
 *
 * The chain normally moves it by well under 1e-4 a frame, so this never binds
 * in ordinary running. It binds when something upstream changes discontinuously
 * - a stand reset, a roll swapped, a reduction retyped - and a stand cannot
 * absorb that: its mesh and gap are built around the gauge it had, and an entry
 * that suddenly arrives thinner than its own exit collapses the bite and takes
 * the solve to NaN. Ramped over a few frames it simply follows.
 */
const H0_RATE = 0.01;

/** What a stand owns individually. Everything else is shared by the line. */
export interface StandSetup {
  /** work roll radius [m] */
  R: number;
  /** friction coefficient */
  mu: number;
  /** commanded reduction, used when this stand is not under load control */
  reduction: number;
  /** load target for this stand, per unit width [N/m] */
  targetForce: number;
  /**
   * Pull applied on the entry side [Pa].
   *
   * In tandem this is an input only for the first stand - the line's entry
   * tension - because every other stand's entry pull is the stand in front of
   * it pulling, i.e. `frontTension` of k-1. In reverse it is an input for every
   * pass: the entry coiler is re-tensioned each time the strip is threaded.
   */
  backTension: number;
  /**
   * Pull applied on the exit side [Pa]. In tandem it is also the next stand's
   * back tension; in reverse it belongs to this pass alone.
   */
  frontTension: number;
  /**
   * What this stand's screws are holding. Per stand, not per line: a real
   * schedule mixes them - the first stands on load control to spread the work,
   * the last on gauge because that is what leaves the mill.
   */
  agcMode: AgcMode;
  /** exit thickness target [m]; only read when agcMode is 'gauge' */
  targetGauge: number;
}

export interface MillDiagnostics {
  /** entry gauge of the line [m] */
  h0: number;
  /** exit gauge of each stand [m] */
  h1: number[];
  /** reduction taken by each stand, relative to its own entry */
  reduction: number[];
  /** total reduction of the line */
  totalReduction: number;
  /** roll separating force per unit width at each stand [N/m] */
  force: number[];
  /** |P - P*| / P* at each stand; NaN where the stand is not load controlled */
  forceError: number[];
  /** strip speed leaving each stand [m/s] */
  exitSpeed: number[];
  /** mass flow v*h at each stand exit [m^2/s]; constant along a consistent line */
  flow: number[];
  /**
   * Worst relative departure of v*h from the line's entry value.
   *
   * NaN in reverse: the passes are consecutive in time, so there is no single
   * flow for them to depart from, and a number here would invite reading a
   * schedule as if the mill were threaded through all of it at once.
   */
  flowError: number;
  /** every stand's gap loop is settled */
  settled: boolean;
  /** how far each stand's entry gauge has drifted from the one its window was fitted for */
  windowStrain: number[];

  /* interstand tension, one entry per gap: index k is between stand k and k+1 */
  /** the model the line is running; 'off' means the arrays below are empty */
  tensionModel: TensionModel;
  /** front tension of stand k as actually carried [Pa] */
  tensionActual: number[];
  /** front tension of stand k as typed in the table [Pa] */
  tensionTarget: number[];
  /** the tension the entry-face reaction says would balance the speeds [Pa] */
  tensionRigid: number[];
  /** relative roll-speed trim the controller has put on stand k */
  tensionTrim: number[];
  /** model time constant of the elastic lag [s]; NaN under rigid */
  tensionTau: number[];
  /** (σ − σ*)/σ* per gap; 0 with the controller off */
  tensionError: number[];
  /** −1 slack, +1 at the yield ceiling, 0 free */
  tensionClamped: number[];
  /** strip length the gap is holding [m], for the transport readout */
  tensionQueueLen: number[];
  /** every gap's tension has stopped moving (and, with control on, is on target) */
  tensionSettled: boolean;
  /** roll speed of each stand this frame [rad/s], after the trim */
  omega: number[];
}

export class Mill {
  /** one solver per stand, index 0 upstream */
  stands: RollingSim[] = [];
  /** entry gauge of the line [m] */
  h0: number;
  /**
   * Hold the line's mass flow rather than each stand's roll speed: a tandem
   * line is set up as a speed cone, every stand turning just fast enough to
   * pass what the one before it delivers.
   */
  autoSpeed = true;
  /** tandem line or reverse mill; see the note at the top of the file */
  mode: LineMode = 'tandem';

  /** entry gauge each stand's analysis window was fitted for [m] */
  private fittedH0: number[] = [];
  /** ring of past exit gauges per stand, for the "is my feed still moving" test */
  private h1Hist: number[][] = [];
  private histAt = 0;
  /** consecutive frames each stand has been held, so a hold cannot be forever */
  private heldFor: number[] = [];
  /** speed the strip last arrived at each stand with [m/s], for a parked stand to pass on */
  private arriving: number[] = [];
  /**
   * The conditions each stand was last synced to - a copy, never the solver's
   * own `params`. What "the conditions changed" means for a stand that has
   * given up on divergence: the toast promises that editing 圧下量・摩擦係数・
   * 張力 restarts it, and the only way to keep that promise for every path an
   * edit can take (the table, the dials, the query, a preset) is to notice the
   * change here, where every path ends up.
   */
  private cond: RollingParams[] = [];
  /**
   * The gaps between the stands - `gaps[k]` is between stand k and k+1 - and
   * the tension settings they run under, copied from the line's params at
   * every sync. Empty while the model is off, so nothing below the model
   * switch costs a frame it is not used on.
   */
  private gaps: GapState[] = [];
  private tp = {
    model: 'off' as TensionModel, L: 4.5, E: 2.1e11, timeScale: 1, follow: 0.5,
    control: false, kp: 0, ki: 0, vLimit: 0.1,
  };
  private sensTick = 0;
  /** each stand's exit gauge has stopped moving over the steadiness window */
  private steady: boolean[] = [];
  /** the line's exit strip speed [m/s], from the dial; what the cone is pitched to */
  private lineSpeed = 0;

  diag: MillDiagnostics = emptyMillDiag();

  constructor(base: RollingParams, setups: StandSetup[]) {
    this.h0 = base.h0;
    this.build(base, setups);
  }

  get count(): number { return this.stands.length; }

  /**
   * Where element k's entry pull comes from.
   *
   * The whole difference between the two machines, in one expression: in a
   * tandem line only the first stand's entry pull is dialled and the rest is
   * the stand in front pulling, while in a reverse mill every pass is threaded
   * between two coilers of its own.
   */
  private backOf(setups: StandSetup[], k: number): number {
    return this.mode === 'reverse' || k === 0
      ? setups[k].backTension
      : setups[k - 1].frontTension;
  }

  /**
   * Rebuild the line. Expensive - it reallocates every mesh - so it is for
   * changes of shape (stand count, mesh resolution, roll radius), not for the
   * per-frame chaining.
   */
  build(base: RollingParams, setups: StandSetup[]): void {
    this.h0 = base.h0;
    this.stands = [];
    this.fittedH0 = [];
    this.h1Hist = [];
    this.heldFor = [];
    this.arriving = [];
    this.cond = [];
    this.histAt = 0;
    let hIn = base.h0;
    for (let k = 0; k < setups.length; k++) {
      const s = setups[k];
      const p: RollingParams = {
        ...base,
        h0: hIn,
        R: s.R,
        mu: s.mu,
        reduction: s.reduction,
        agcTargetForce: s.targetForce,
        agcTargetGauge: s.targetGauge,
        agcMode: s.agcMode,
        backTension: this.backOf(setups, k),
        frontTension: s.frontTension,
        // Only the first stand is free to choose its own entry speed. The rest
        // are fed by the stand in front of them, and prescribing that is what
        // makes the line conserve mass instead of each stand inventing its own
        // throughput.
        feedSpeed: 0,
      };
      this.stands.push(new RollingSim(p));
      this.cond.push({ ...p });
      this.fittedH0.push(hIn);
      this.h1Hist.push(new Array(STEADY_WINDOW).fill(0));
      this.heldFor.push(0);
      hIn *= 1 - s.reduction;
    }
    this.gaps = [];
    this.diag = emptyMillDiag();
  }

  /**
   * Rebuild a single stand in place.
   *
   * A stand's own geometry - its roll - is the only thing a rebuild is for, and
   * that is local: upstream stands do not depend on it at all, and downstream
   * ones take its exit gauge through the live chain, which needs no rebuild.
   * Rebuilding the whole line for it would throw away every other stand's
   * converged velocity field, strain and flattening, which on a five-stand line
   * is thousands of frames of work discarded to change one roll radius.
   *
   * It keeps the entry gauge the chain is currently feeding it, not the nominal
   * one, so the stand comes back where it actually sits in the line.
   */
  rebuildStand(k: number, base: RollingParams, setups: StandSetup[]): void {
    if (k < 0 || k >= this.stands.length) return;
    const s = setups[k];
    const hIn = this.stands[k].params.h0;
    const p: RollingParams = {
      ...base,
      h0: hIn,
      R: s.R,
      mu: s.mu,
      reduction: s.reduction,
      agcTargetForce: s.targetForce,
      agcTargetGauge: s.targetGauge,
      agcMode: s.agcMode,
      backTension: this.backOf(setups, k),
      frontTension: s.frontTension,
      feedSpeed: 0,
    };
    this.stands[k] = new RollingSim(p);
    this.cond[k] = { ...p };
    this.fittedH0[k] = hIn;
    this.rearm(k, true);
  }

  /**
   * Apply a new commanded reduction to one stand without rebuilding anything.
   *
   * The mesh does not depend on the command, so nothing is reallocated. What
   * the command *means*, though, depends on what is driving the screws, and
   * the three answers are different:
   *
   * - `off`   - the command is the screw position. Put them on it.
   * - `gauge` - the command is the loop's setpoint, and the screws are the
   *             actuator. They are moved by the gaugemeter feed-forward
   *             (`retarget`) rather than parked on the raw command, which
   *             would throw away the mill spring the loop had already found.
   *             Since this loop waits on the mill-spring and feed loops
   *             between moves - four fifths of a setpoint change is spent
   *             standing still - what saves time is making fewer moves, not
   *             larger ones.
   * - `force` - the command is not a target at all; the load is. It must not
   *             move the screws or disturb the loop. All it changes is the
   *             nominal figures derived from it, and the window the stand will
   *             be re-meshed into next time it is rebuilt.
   *
   * Returns whether the stand was actually disturbed, so a caller with state
   * of its own tied to the operating point knows if that state is now stale.
   */
  recommand(k: number, reduction: number): boolean {
    const st = this.stands[k];
    if (!st) return false;
    st.params.reduction = reduction;
    if (st.params.agcMode === 'force') return false;
    // Both gauge loops keep what they have learned about the stand; only the
    // parked screws of `off` are placed on the raw command.
    if (st.params.agcMode === 'ratio' || st.params.agcMode === 'gauge') st.retarget();
    else st.releaseGap();
    return true;
  }

  /** Push the shared settings and the per-stand setups into the solvers. */
  sync(base: RollingParams, setups: StandSetup[]): void {
    // The entry gauge is the line's, not a stand's, and it can move without a
    // rebuild - so it has to be picked up here too, not only in `build`.
    this.h0 = base.h0;
    for (let k = 0; k < this.stands.length; k++) {
      const s = setups[k];
      const p = this.stands[k].params;
      // `base.h0` is the gauge entering the *line*. Only the first stand sees
      // it; every other stand's entry belongs to the chain and must survive
      // this assignment. Letting it be overwritten and then repaired in
      // `advance` used to be harmless, until the entry gauge acquired a rate
      // limit - after which each stand could only crawl 1 % back towards its
      // real entry every frame and never arrived, leaving every reduction
      // reading cumulative from the line entry instead of its own.
      const chained = k === 0 ? this.h0 : p.h0;
      const next: RollingParams = {
        ...base,
        h0: chained,
        R: s.R,
        mu: s.mu,
        reduction: s.reduction,
        agcTargetForce: s.targetForce,
        agcTargetGauge: s.targetGauge,
        agcMode: s.agcMode,
        backTension: this.backOf(setups, k),
        frontTension: s.frontTension,
      };
      // A stand that has given up restarting was told it would try again once
      // the conditions changed. Compared against the last sync, not against
      // `p`: the table writes some of these straight into the solver (a
      // reduction through `recommand`, a gauge target through `retarget`), and
      // those would already agree by the time this ran. `h0` is left out of
      // the comparison: for stands 1..n-1 it is the chained entry gauge that
      // `advance` moves every frame, and forgiving on that would let a stand
      // downstream of a still-settling one restart forever. An edit to the
      // line's own h0 rebuilds the line, which forgives on its own.
      if (this.condChanged(k, next)) this.stands[k].forgiveDivergence();
      this.cond[k] = next;
      Object.assign(p, next);
    }
    this.lineSpeed = base.lineSpeed;
    this.syncTension(base, setups);
  }

  /**
   * Pick up the tension settings, and (re)build the gap state when the model
   * comes on, the line changes length, or the strip's bar length moves.
   *
   * Only a tandem line has gaps. Reverse passes are one stand re-threaded,
   * with a coiler at each end, so the model is forced off there whatever the
   * dial says - the dial stays as typed for when the line goes back.
   */
  private syncTension(base: RollingParams, setups: StandSetup[]): void {
    const n = this.stands.length;
    const model: TensionModel = this.mode === 'tandem' && n > 1 ? base.tensionModel : 'off';
    const tp = this.tp;
    const rebuild = model !== tp.model
      || (model !== 'off' && (this.gaps.length !== n - 1 || tp.L !== base.standDistance));
    tp.model = model;
    tp.L = base.standDistance;
    tp.E = base.Estrip;
    tp.timeScale = base.tensionTimeScale;
    tp.follow = base.tensionFollow;
    tp.control = base.tensionControl;
    tp.kp = base.tensionKp;
    tp.ki = base.tensionKi;
    tp.vLimit = base.tensionVLimit;
    if (rebuild) this.resetTension(setups);
    if (!tp.control) for (const g of this.gaps) { g.integ = 0; g.trim = 0; g.err = 0; }
  }

  /**
   * Start every gap at the table's tension, with the gap full of strip at the
   * upstream stand's exit gauge. What a line threaded at its schedule holds.
   */
  resetTension(setups: StandSetup[]): void {
    this.gaps = [];
    if (this.tp.model === 'off') return;
    for (let k = 0; k + 1 < this.stands.length; k++) {
      const st = this.stands[k];
      const h1 = st.diag.exitThickness > 0 ? st.diag.exitThickness
        : st.params.h0 * (1 - st.params.reduction);
      const sigma = setups[k]?.frontTension ?? 0;
      this.gaps.push(newGapState(sigma * h1, this.tp.L, h1));
    }
  }

  /** The gap state, for the readouts and the headless hook. Empty when off. */
  get gapStates(): readonly GapState[] { return this.gaps; }
  /** the cone's exit-speed correction factor, for the readouts */
  get exitCorrection(): number { return this.exitCorr; }

  private coneSlipCache: number[] = [];
  private coneTick = 0;
  /** the successive trim factor each stand ran with last frame, to divide out of its measured speed */
  private coneFactor: number[] = [];
  /**
   * Slow correction on the whole cone so the strip really leaves at the dial.
   * The cone is feed-forward through Bland–Ford slips the FEM does not quite
   * agree with, and chained through measured flows, so the exit came out a
   * couple of percent under the dial. Every stand scales together, so the
   * speed ratios - which are all the tensions answer to - do not move.
   */
  private exitCorr = 1;

  /**
   * Forward slip of stand k at the schedule's tensions, by Bland–Ford, for the
   * speed cone. Cached for eight frames - the theory integrates its pressure
   * hill numerically - and 0 where it has no neutral point to offer.
   */
  private coneSlip(k: number, hOut: number): number {
    if (k === 0) this.coneTick++;
    if (this.coneTick % 8 !== 1 && Number.isFinite(this.coneSlipCache[k])) return this.coneSlipCache[k];
    const st = this.stands[k];
    const p = st.params, c = this.cond[k];
    let f = 0;
    if (c && hOut > 0 && p.h0 > hOut) {
      const pt = slabPointAt({ ...p, slabTheory: 'blandford' }, {
        h0: p.h0, h1: hOut, R: p.R, backTension: c.backTension, frontTension: c.frontTension,
        entryStrain: st.entryStrain,
      }, p.mu, st.diag.hitchcockR > 0 ? st.diag.hitchcockR : p.R);
      if (Number.isFinite(pt.forwardSlip) && pt.forwardSlip > -0.5 && pt.forwardSlip < 0.5) f = pt.forwardSlip;
    }
    this.coneSlipCache[k] = f;
    return f;
  }

  /** Whether anything a stand solves against differs from the last sync. */
  private condChanged(k: number, next: RollingParams): boolean {
    const prev = this.cond[k];
    if (!prev) return false;
    for (const key of Object.keys(next) as (keyof RollingParams)[]) {
      if (key === 'h0') continue;
      if (prev[key] !== next[key]) return true;
    }
    return false;
  }

  /** Put every stand's screws back on its commanded reduction. */
  releaseAll(): void {
    for (const st of this.stands) st.releaseGap();
  }

  resetAll(): void {
    for (let k = 0; k < this.stands.length; k++) this.resetStand(k);
  }

  /**
   * Start one stand's solve again from scratch, without touching the others.
   *
   * Keeps the meshes - nothing about the geometry has changed - and throws away
   * the state that was converged against the old conditions: the velocity
   * field, the accumulated strain, the flattening, and the screw position.
   * The chain's own memory of this stand goes too, or the steadiness test would
   * compare a fresh exit gauge against the one it had before the reset and read
   * the jump as its upstream still moving.
   */
  resetStand(k: number): void {
    const st = this.stands[k];
    if (!st) return;
    // A manual restart is the operator saying "try again": a stand that had
    // stopped restarting itself gets its five attempts back, or the fresh
    // state would converge and the badge go on saying 発散.
    st.forgiveDivergence();
    st.resetState();
    this.rearm(k);
  }

  /**
   * The line's side of a stand starting over: whatever the chain remembers
   * about stand k was measured against the state that has just gone.
   *
   * Shared by every way a stand starts again - the operator's reset, the
   * automatic restart after a NaN, a rebuild for a new roll. The last two used
   * to skip it, so the gaps either side stayed armed and read the fresh seed's
   * feed reaction as a real tension on the very next frame: on the settled
   * three-stand line under 'dist' and control, #1→#2 sat at its zero clamp
   * for 29 frames after #2 restarted and #2→#3 jumped to 56 MPa.
   *
   * `keepControl` keeps what the gaps know that is not the stand's: the
   * controller's trims and integrals, which are the line's speed-ratio
   * correction, and the queues, which hold strip that has already been rolled.
   * Throwing those away as well put the cone back to where it was before the
   * line settled, and the first read after re-arming then jumped - 93 / 75 MPa
   * on the same restart, against 31 / 25 MPa keeping them. The operator's
   * reset still clears everything; that is what "start again" asks for.
   */
  private rearm(k: number, keepControl = false): void {
    this.h1Hist[k] = new Array(STEADY_WINDOW).fill(0);
    this.heldFor[k] = 0;
    // The gaps either side go back to the schedule with the stand: a tension
    // measured against the state that was just thrown away is not a state.
    for (const j of [k - 1, k]) {
      const g = this.gaps[j];
      if (!g) continue;
      const h1 = this.stands[j].params.h0 * (1 - this.stands[j].params.reduction);
      g.T = this.cond[j]?.frontTension !== undefined ? this.cond[j].frontTension * h1 : g.T;
      if (!keepControl) {
        g.queue.reset(this.tp.L, h1);
        g.integ = 0; g.trim = 0;
      }
      g.tau = NaN; g.warm = 0; g.warmed = false; g.fresh = false;
    }
  }

  advance(dt: number): void {
    const n = this.stands.length;
    if (n === 0) return;

    // What the line hands to each element: gauge, work hardening, heat.
    //
    // All three are carried by the strip itself, so all three chain the same
    // way - stand k receives what stand k-1 delivered. Only the first element
    // sees the line's own entry condition: virgin material at the entry
    // temperature. This holds on a reverse mill too, where the passes are
    // separated in time but work the same piece of metal.
    //
    // Applied before the solve so a stand never runs a frame against an entry
    // condition its upstream neighbour has already left.
    const head = this.stands[0];
    head.params.h0 = this.h0;
    head.entryStrain = 0;
    head.entryTemp = head.params.tempEntry;
    const tm = this.tp.model;
    for (let k = 1; k < n; k++) {
      const up = this.stands[k - 1].diag;
      const st = this.stands[k];
      // With a tension model on, the gauge arriving is the one that left the
      // stand upstream a transit time ago - the gap is a queue of strip and
      // this stand bites its front. Off, the chain is instantaneous as before.
      const front = tm !== 'off' ? this.gaps[k - 1]?.queue.frontThickness() : NaN;
      const h = front > 0 && Number.isFinite(front) ? front : up.exitThickness;
      if (!(h > 0) || !Number.isFinite(h)) continue;
      const cur = st.params.h0;
      const lim = Math.max(cur, h) * H0_RATE;
      st.params.h0 = cur > 0 ? cur + Math.max(-lim, Math.min(lim, h - cur)) : h;
      // A stand upstream that has just started over has no readouts yet - an
      // empty diag, exit gauge 0 - and its strain and heat are then unknown,
      // not zero. Handed on as they read, the stand here re-transported its
      // whole field from unworked material at the entry temperature for that
      // frame. What arrived last frame is the better guess.
      if (!(up.exitThickness > 0) || !Number.isFinite(up.exitThickness)) continue;
      if (up.exitSpeed > 0 && Number.isFinite(up.exitSpeed)) this.arriving[k] = up.exitSpeed;
      // Strain and temperature are not rate limited the way the gauge is. The
      // limit on h0 exists because the gauge feeds the mesh and the screw
      // rails, where a step would jolt the gap loop; these two only reach the
      // flow stress, which the Picard iteration relaxes on its own.
      st.entryStrain = Number.isFinite(up.exitStrain) ? Math.max(0, up.exitStrain) : 0;
      // Between stands the strip runs in open air for a metre or so and does
      // lose heat, but modelling that needs a transit time and a film
      // coefficient this app does not have. Carrying the temperature over
      // unchanged is the adiabatic reading of the whole line, consistent with
      // the bite model itself - and, like it, an upper bound.
      st.entryTemp = Number.isFinite(up.exitTemp) && up.exitTemp > 0
        ? up.exitTemp : st.params.tempEntry;
    }

    // Mass flow sets the speed cone: each barrel turns fast enough to pass what
    // the line is carrying through its own exit gauge.
    //
    // Only the barrel speed. Prescribing the entry speed *as well* over-
    // determines the stand - a real one is given a roll speed and lets the
    // interstand tension absorb whatever mismatch is left, and forcing both
    // here instead leaves a feed reaction 270x its own deadband, the load
    // ringing at 0.8 % and the gap loop's sensitivity pinned against its clamp.
    // Every stand free-runs its own feed; what is left over shows up honestly
    // as `flowError` rather than being driven into the solve.
    // Reverse passes do not roll at the same time, so there is no cone to
    // hold: each pass keeps whatever barrel speed it was given.
    //
    // The one speed the line is run at is the strip speed leaving it - the
    // dial - and the cone is pitched down from there: q = v_exit · h1(last)
    // is the mass flow every stand has to pass, and each barrel turns at
    // q / (h1 · R · (1+f)) on the gauge it is *aiming at* and the forward
    // slip Bland–Ford gives at the schedule's tension. Both feed-forward.
    // The gauge is the target, not the live one: pitched from the live exit
    // gauge the cone closed a loop through the stand itself (h1 up -> ω down
    // -> feed re-balances -> load and gauge move -> ...) and the last stand
    // hunted at ±0.25 µm for as long as it ran. Under load control there is
    // no gauge target, so the live gauge is all there is. The slip is the
    // theory's, not the FEM's, so the cone closes no loop through the
    // tension a model may be carrying; what the FEM disagrees with the
    // theory by is what that model then has to carry. The strip leaves a
    // stand faster than its rolls by that slip, and a barrel pitched on mass
    // flow alone ran slow by it - a gap then had to find the hundreds of MPa
    // that shift the slips to cover it.
    //
    // Only the first stand is pitched from the dial, though. Every stand
    // after it is pitched from the mass flow *actually arriving* - the
    // upstream exit speed times the gauge the chain is delivering - the way
    // the cone always was. Pitching them all from the dial was tried and
    // made the line oscillate on its own at 25-90 MPa with a 35 s period:
    // a tension rise unloads the stand upstream, its spring lets the gauge
    // down by a few percent, that thinner strip arrives a transit time later
    // at a barrel still turning for the schedule's gauge, the exit speed
    // there drops, the next gap tightens, and the neutral point shift hands
    // the rise back to the gap it came from. Following the arriving flow
    // closes that path on the spot. The trims on the measured speed are
    // divided out so the cone does not hand a gap's correction downstream.
    if (this.autoSpeed && this.mode === 'tandem' && this.lineSpeed > 0) {
      const gauge = (st: RollingSim): number => {
        const mode = st.params.agcMode;
        return (mode === 'gauge' || mode === 'ratio') ? st.agcSetpoint
          : st.diag.exitThickness > 0 ? st.diag.exitThickness
            : st.params.h0 * (1 - st.params.reduction);
      };
      const trimOn = tm !== 'off' && this.tp.control;
      let factor = 1;
      for (let k = n - 1; k >= 0; k--) {
        this.coneFactor[k] = factor;
        const g = this.gaps[k - 1];
        if (trimOn && g && Number.isFinite(g.trim)) factor *= 1 + g.trim;
      }
      // Stand 0: from the dial, through the schedule, times the slow
      // correction that closes the gap between the dial and what the last
      // stand's strip is measured to do. 0.2 /s: well under every loop in
      // the line, so it moves the line as a whole and disturbs nothing.
      const last = this.stands[n - 1].diag;
      if (last.exitSpeed > 0 && last.contactNodes > 0 && Number.isFinite(last.exitSpeed) && dt > 0) {
        const rel = (this.lineSpeed - last.exitSpeed) / this.lineSpeed;
        this.exitCorr *= 1 + Math.max(-0.05, Math.min(0.05, 0.2 * dt * rel));
        this.exitCorr = Math.max(0.7, Math.min(1.4, this.exitCorr));
      }
      let q = this.lineSpeed * this.exitCorr * gauge(this.stands[n - 1]);
      for (let k = 0; k < n; k++) {
        const st = this.stands[k];
        if (k > 0) {
          const up = this.stands[k - 1];
          const arriving = up.diag.exitSpeed / (this.coneFactor[k - 1] || 1) * st.params.h0;
          if (arriving > 0 && Number.isFinite(arriving)) q = arriving;
        }
        const hOut = gauge(st);
        const slip = this.coneSlip(k, hOut);
        if (q > 0 && hOut > 0) st.params.omega = q / hOut / Math.max(st.params.R, 1e-9) / (1 + slip);
      }
    }
    if (tm !== 'off') this.applyTension();

    // A stand only starts hunting once its feed has stopped moving. The test is
    // the entry gauge itself, not whether the stand upstream calls itself
    // settled: a load loop can sit a few times its own deadband indefinitely
    // without its exit gauge moving at all, and gating on `agcSettled` then
    // freezes the whole line behind it forever.
    const slot = this.histAt % STEADY_WINDOW;
    let upstreamSteady = true;
    for (let k = 0; k < n; k++) {
      const st = this.stands[k];
      const want = !upstreamSteady && st.params.lineHold;
      if (want && this.heldFor[k] < HOLD_MAX) {
        st.holdGap = true;
        this.heldFor[k]++;
      } else {
        st.holdGap = false;
        if (!want) this.heldFor[k] = 0;
      }
      const h1 = st.diag.exitThickness;
      const past = this.h1Hist[k][slot];
      this.h1Hist[k][slot] = h1;
      const drift = past > 0 && h1 > 0 ? Math.abs(h1 - past) / h1 : 1;
      this.steady[k] = drift <= FEED_STEADY;
      if (drift > FEED_STEADY) upstreamSteady = false;
    }
    this.histAt++;

    for (let k = 0; k < n; k++) {
      const st = this.stands[k];
      // A stand whose absolute-gauge target is at or above its entry gauge has
      // nothing to roll. Stepping it would open the screws until the bite
      // empties and then report the residue of a solve with no contact, so it
      // is parked instead: the strip passes through at entry gauge, which is
      // what a stand set to its own entry actually does.
      if (st.gaugeIdle) { st.passThrough(k > 0 ? this.arriving[k] : NaN); continue; }
      st.advance(dt);
      // A stand that has gone to NaN restarts itself here, before the line
      // reads it: downstream stands take their entry gauge from this one,
      // and a NaN handed on is a line gone, not a stand.
      if (st.recoverIfDiverged(performance.now())) this.rearm(k, true);
    }
    if (tm !== 'off') this.updateTension(dt);
    this.collect();
  }

  /**
   * What the gaps hand the stands this frame, applied before the solve.
   *
   * Three things per gap. The controller's trims go on the roll speeds -
   * successively: the trim for gap k scales every stand *up to and including*
   * k by the same factor, the way a tandem line is actually run. Scaling
   * only stand k moved its entry speed as well as its exit, so the gap
   * behind it saw the correction too, and two integral loops on a plant
   * coupled that tightly rang against each other for thirty seconds after
   * every disturbance. Scaling everything upstream together leaves every
   * other gap's speed ratio, and the line's exit speed, exactly where they
   * were. The downstream stand's entry face is prescribed at the upstream
   * exit speed - (5.52), and the reading that makes the reaction a tension.
   * And both stands are given the carried tension as the pull on the side
   * that faces the gap: one force per unit width, two stresses, by the two
   * gauges it acts on (5.45).
   */
  private applyTension(): void {
    const tp = this.tp;
    if (tp.control) {
      let factor = 1;
      for (let k = this.gaps.length - 1; k >= 0; k--) {
        const g = this.gaps[k];
        if (Number.isFinite(g.trim)) factor *= 1 + g.trim;
        this.stands[k].params.omega *= factor;
      }
    }
    for (let k = 0; k < this.gaps.length; k++) {
      const g = this.gaps[k];
      const up = this.stands[k], dn = this.stands[k + 1];
      const vOut = up.diag.exitSpeed;
      if (vOut > 0 && Number.isFinite(vOut)) dn.params.feedSpeed = vOut;
      const h1 = up.diag.exitThickness > 0 ? up.diag.exitThickness
        : up.params.h0 * (1 - up.params.reduction);
      up.params.frontTension = g.T / h1;
      dn.params.backTension = g.T / Math.max(dn.params.h0, 1e-9);
    }
  }

  /**
   * Move each gap's tension by what the solves just said, then the controller.
   *
   * The downstream stand ran with its feed face at the upstream exit speed and
   * the carried tension on it. Whatever longitudinal force that face had to
   * supply is the force the strip would have carried instead: the tension the
   * gap *would* hold if it were rigid is the carried one less the reaction
   * over the face height. Rigid takes a fraction of that step every frame -
   * a fraction, because the reaction is read off a Picard iteration that is
   * itself still moving. The elastic models take the step of a first-order
   * lag with the bar's own time constant, in model time.
   */
  /** wall time the last tension update took [ms], sensitivity included */
  lastTensionMs = 0;

  private updateTension(dt: number): void {
    const t0 = performance.now();
    this.updateTensionInner(dt);
    this.lastTensionMs = performance.now() - t0;
  }

  private updateTensionInner(dt: number): void {
    const tp = this.tp;
    const dtm = dt * tp.timeScale;
    const doSens = ++this.sensTick % 8 === 0;
    for (let k = 0; k < this.gaps.length; k++) {
      const g = this.gaps[k];
      const up = this.stands[k], dn = this.stands[k + 1];
      const ud = up.diag, dd = dn.diag;
      const h1 = ud.exitThickness > 0 ? ud.exitThickness : up.params.h0 * (1 - up.params.reduction);
      // Transport: what left the upstream stand goes in at the back, what the
      // downstream stand took comes off the front. The two are meant to be
      // equal - the feed is prescribed at the exit speed - but not in the same
      // frame: push reads this frame's exit speed, pop the feed the downstream
      // stand was given, and through the start-up transient they differ. On
      // the three-stand default (tools/sim2d, 40 s, 'simple') the gaps settle
      // 11 mm and 6 mm short of the 4.5 m stand distance, -0.25 % and -0.14 %.
      // Popping exactly what was pushed moves the settled tension by +0.06 %
      // and +0.09 % ('dist': -0.02 % / -0.10 %), so it is left, and recorded.
      if (ud.exitSpeed > 0 && dtm > 0) {
        g.queue.push(ud.exitSpeed * dtm, h1);
        g.queue.pop((dn.params.feedSpeed > 0 ? dn.params.feedSpeed : ud.exitSpeed) * dtm);
      }
      // The reaction means nothing until the gap is a gap: both stands biting,
      // the downstream mesh placed on its bite, both exit gauges steady, and
      // the strip at the front of the queue the strip the upstream stand is
      // actually making. That last one is the trap. The queue is filled at the
      // nominal gauge, the stand makes h0(1-r) plus its spring, and until the
      // real gauge has travelled the gap (L/v, a few seconds) the prescribed
      // feed carries a volume mismatch of several percent - which the reaction
      // reads as a huge compressive tension. The gap then clamps to zero and
      // the controller winds up to its limit chasing a target the line cannot
      // yet hold, and takes 25 s to unwind. So the gap is held (and the
      // controller with it) until it has been ready for WARM_FRAMES; after
      // that every transient is real and is read.
      const bitten = dn.params.feedSpeed > 0 && dd.feedFace > 0 && dd.contactNodes > 0
        && ud.contactNodes > 0 && ud.exitSpeed > 0
        && Number.isFinite(dd.feedReaction) && Number.isFinite(g.T);
      if (!g.warmed) {
        const front = g.queue.frontThickness();
        const ready = bitten && dd.meshResidual <= MESH_WARM
          && (this.steady[k] ?? false) && (this.steady[k + 1] ?? false)
          && Math.abs(front - h1) < 0.01 * h1;
        g.warm = ready ? g.warm + 1 : 0;
        if (g.warm >= WARM_FRAMES) { g.warmed = true; g.fresh = true; }
      }
      if (!bitten || !g.warmed) { g.Trigid = g.T; continue; }
      const sigmaRigidB = dn.params.backTension - dd.feedReaction / dd.feedFace;
      g.Trigid = sigmaRigidB * dn.params.h0;

      // The slip sensitivity: the elastic time constant and the controller's
      // plant gain both need it, rigid without control does not.
      if ((tp.model !== 'rigid' || tp.control) && (doSens || !Number.isFinite(g.sens))) {
        const s = speedSensitivity(
          up.params, h1, ud.hitchcockR, up.entryStrain,
          dn.params, dd.exitThickness, dd.hitchcockR, dn.entryStrain, g.T);
        if (Number.isFinite(s)) g.sens = s;
      }
      let beta: number;
      if (g.fresh) {
        // The first read after the hold: the carried tension is whatever the
        // gap was seeded with, not a state, and stepping toward the rigid
        // value a fraction at a time from there rang the two gaps against
        // each other for four cycles. Take it whole, once.
        beta = 1;
        g.fresh = false;
        g.tau = NaN;
      } else if (tp.model === 'rigid') {
        beta = tp.follow;
        g.tau = NaN;
      } else {
        // (5.44): K = E h1 / L for the uniform bar; (5.47): the series sum of
        // the slices for the distributed one. Both per unit width, in N/m per
        // m/s of mismatch.
        const K = tp.model === 'simple'
          ? (tp.E * h1) / Math.max(tp.L, 1e-6)
          : tp.E / Math.max(g.queue.sumLenOverH, 1e-12);
        const tau = Number.isFinite(g.sens) && g.sens > 0 ? 1 / (K * g.sens) : NaN;
        g.tau = tau;
        // No neutral point to differentiate (Bland–Ford failed on a side):
        // fall back to the rigid step rather than freeze the gap.
        beta = Number.isFinite(tau) && tau > 0 ? 1 - Math.exp(-dtm / tau) : tp.follow;
      }
      let T = g.T + beta * (g.Trigid - g.T);
      // The strip cannot push, and it cannot carry more than it yields at:
      // held at 90 % of the plane-strain flow stress it leaves upstream with.
      const kf = (2 / Math.sqrt(3)) * ud.exitFlowStress;
      const Tmax = kf > 0 ? 0.9 * kf * h1 : Infinity;
      g.clamped = 0;
      if (T < 0) { T = 0; g.clamped = -1; }
      else if (T > Tmax) { T = Tmax; g.clamped = 1; }
      g.T = T;

      if (tp.control) {
        const target = this.cond[k]?.frontTension ?? 0;
        piStep(g, g.T / h1, target, plantGain(g, ud.exitSpeed, h1), dtm, tp.kp, tp.ki, tp.vLimit);
      }
    }
  }

  private collect(): void {
    const n = this.stands.length;
    const d = this.diag;
    d.h0 = this.h0;
    d.h1.length = n; d.reduction.length = n; d.force.length = n;
    d.forceError.length = n; d.exitSpeed.length = n; d.flow.length = n;
    d.windowStrain.length = n;
    let settled = true;
    const lead = this.stands[0].diag;
    const q0 = lead.entrySpeed * this.h0;
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const st = this.stands[k];
      const sd = st.diag;
      const hIn = st.params.h0;
      d.h1[k] = sd.exitThickness;
      d.reduction[k] = hIn > 0 ? 1 - sd.exitThickness / hIn : 0;
      d.force[k] = sd.rollForce;
      d.forceError[k] = st.params.agcMode === 'force' && st.params.agcTargetForce > 0
        ? (sd.rollForce - st.params.agcTargetForce) / st.params.agcTargetForce
        : NaN;
      d.exitSpeed[k] = sd.exitSpeed;
      d.flow[k] = sd.exitSpeed * sd.exitThickness;
      d.windowStrain[k] = this.fittedH0[k] > 0
        ? Math.abs(hIn - this.fittedH0[k]) / this.fittedH0[k] : 0;
      if (st.params.agcMode !== 'off' && !sd.agcSettled) settled = false;
      if (q0 > 0 && Number.isFinite(d.flow[k])) {
        worst = Math.max(worst, Math.abs(d.flow[k] - q0) / q0);
      }
    }
    d.totalReduction = this.h0 > 0 && n > 0 ? 1 - d.h1[n - 1] / this.h0 : 0;
    d.flowError = this.mode === 'tandem' ? worst : NaN;
    d.settled = settled;
    d.omega.length = n;
    for (let k = 0; k < n; k++) d.omega[k] = this.stands[k].params.omega;

    const tp = this.tp;
    const m = this.gaps.length;
    d.tensionModel = tp.model;
    d.tensionActual.length = m; d.tensionTarget.length = m; d.tensionRigid.length = m;
    d.tensionTrim.length = m; d.tensionTau.length = m; d.tensionError.length = m;
    d.tensionClamped.length = m; d.tensionQueueLen.length = m;
    let tSettled = true;
    for (let k = 0; k < m; k++) {
      const g = this.gaps[k];
      const up = this.stands[k];
      const h1 = up.diag.exitThickness > 0 ? up.diag.exitThickness
        : up.params.h0 * (1 - up.params.reduction);
      const target = this.cond[k]?.frontTension ?? 0;
      d.tensionActual[k] = g.T / h1;
      d.tensionTarget[k] = target;
      d.tensionRigid[k] = g.Trigid / h1;
      d.tensionTrim[k] = g.trim;
      d.tensionTau[k] = g.tau;
      d.tensionError[k] = tp.control ? g.err : 0;
      d.tensionClamped[k] = g.clamped;
      d.tensionQueueLen[k] = g.queue.length;
      // Settled: the reaction agrees with the carried tension to a percent of
      // it (or of 5 MPa on a slack gap) - the reaction is read off a solve
      // that jitters at that level - and the controller, if it is on, has the
      // error inside the same band.
      const ref = Math.max(g.T, 5e6 * h1);
      if (Math.abs(g.Trigid - g.T) > 1e-2 * ref) tSettled = false;
      if (tp.control && Math.abs(g.err) > 1e-2) tSettled = false;
    }
    d.tensionSettled = tSettled;
  }
}

function emptyMillDiag(): MillDiagnostics {
  return {
    h0: 0, h1: [], reduction: [], totalReduction: 0, force: [], forceError: [],
    exitSpeed: [], flow: [], flowError: 0, settled: false, windowStrain: [],
    tensionModel: 'off', tensionActual: [], tensionTarget: [], tensionRigid: [],
    tensionTrim: [], tensionTau: [], tensionError: [], tensionClamped: [],
    tensionQueueLen: [], tensionSettled: true, omega: [],
  };
}
