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
  /**
   * The conditions each stand was last synced to - a copy, never the solver's
   * own `params`. What "the conditions changed" means for a stand that has
   * given up on divergence: the toast promises that editing 圧下量・摩擦係数・
   * 張力 restarts it, and the only way to keep that promise for every path an
   * edit can take (the table, the dials, the query, a preset) is to notice the
   * change here, where every path ends up.
   */
  private cond: RollingParams[] = [];

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
    this.h1Hist[k] = new Array(STEADY_WINDOW).fill(0);
    this.heldFor[k] = 0;
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
    this.h1Hist[k] = new Array(STEADY_WINDOW).fill(0);
    this.heldFor[k] = 0;
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
    for (let k = 1; k < n; k++) {
      const up = this.stands[k - 1].diag;
      const st = this.stands[k];
      const h = up.exitThickness;
      if (!(h > 0) || !Number.isFinite(h)) continue;
      const cur = st.params.h0;
      const lim = Math.max(cur, h) * H0_RATE;
      st.params.h0 = cur > 0 ? cur + Math.max(-lim, Math.min(lim, h - cur)) : h;
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
    if (this.autoSpeed && this.mode === 'tandem' && n > 1) {
      const lead = this.stands[0].diag;
      const q = lead.exitSpeed * lead.exitThickness;
      if (q > 0 && Number.isFinite(q)) {
        for (let k = 1; k < n; k++) {
          const st = this.stands[k];
          // On the gauge the stand is *aiming at*, not the one it is making
          // this frame. Pitched from the live exit gauge, the cone closed a
          // loop through the stand itself: h1 up -> ω down -> feed re-balances
          // -> load and gauge move -> ..., and the last stand of a line hunted
          // at +-0.25 um for as long as it ran, never inside its band. Under
          // load control there is no gauge target, so the live gauge is all
          // there is; there the loop is on the load and the coupling is weak.
          const mode = st.params.agcMode;
          const hOut = (mode === 'gauge' || mode === 'ratio') ? st.agcSetpoint
            : st.diag.exitThickness > 0 ? st.diag.exitThickness
              : st.params.h0 * (1 - st.params.reduction);
          if (hOut > 0) st.params.omega = q / hOut / Math.max(st.params.R, 1e-9);
        }
      }
    }

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
      if (drift > FEED_STEADY) upstreamSteady = false;
    }
    this.histAt++;

    for (const st of this.stands) {
      // A stand whose absolute-gauge target is at or above its entry gauge has
      // nothing to roll. Stepping it would open the screws until the bite
      // empties and then report the residue of a solve with no contact, so it
      // is parked instead: the strip passes through at entry gauge, which is
      // what a stand set to its own entry actually does.
      if (st.gaugeIdle) { st.passThrough(); continue; }
      st.advance(dt);
      // A stand that has gone to NaN restarts itself here, before the line
      // reads it: downstream stands take their entry gauge from this one,
      // and a NaN handed on is a line gone, not a stand.
      st.recoverIfDiverged(performance.now());
    }
    this.collect();
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
  }
}

function emptyMillDiag(): MillDiagnostics {
  return {
    h0: 0, h1: [], reduction: [], totalReduction: 0, force: [], forceError: [],
    exitSpeed: [], flow: [], flowError: 0, settled: false, windowStrain: [],
  };
}
