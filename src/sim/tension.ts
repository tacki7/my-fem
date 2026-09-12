/**
 * Interstand tension: what a tandem line carries between two stands, and the
 * three ways it can be made to move.
 *
 * The three are the textbook's (5.4, "冷間圧延の動的連続圧延理論"), the same
 * three the tension-lab app implements against a slab-formula plant:
 *
 *   rigid   (5.50)–(5.52)  the strip between the stands is inextensible, so the
 *                          tension is whatever makes the speeds match: entry
 *                          speed of stand k+1 = exit speed of stand k, always.
 *   simple  (5.44)–(5.45)  the strip is one uniform elastic bar of length L:
 *                          dT/dt = (E h / L) (v_in,k+1 − v_out,k).
 *   dist    (5.46)–(5.49)  the strip is the bar it actually is, a series of
 *                          slices of whatever thickness each left stand k with,
 *                          so the spring is Σ 1/(E h_i / ℓ_i) and a thickness
 *                          change travels the gap at strip speed.
 *
 * Ported to a plant that is a FEM solve rather than a formula, one thing
 * changes. The tension-lab solves the rigid case as a Newton system on the
 * tensions and thicknesses every step, and integrates the elastic ones from the
 * measured speed mismatch. Here every evaluation is a whole rolling solve, so
 * neither is affordable as written - and the FEM already offers something
 * better: with the entry face *prescribed* at the upstream exit speed, the
 * longitudinal reaction that face has to supply is exactly the tension the
 * strip is short of, per unit width, divided by the face height. That is a
 * direct, linear reading of the rigid tension every frame. The elastic models
 * then relax the carried tension toward it with the bar's own time constant,
 * τ = 1/(K·|dΔv/dT|) - the mismatch the bar would see at the carried tension
 * is the rigid deficit times the slip sensitivity, and (5.44) turns that into
 * a first-order lag.
 *
 * Physically τ is of order ten milliseconds, well under one frame: at real
 * speed all three models are the rigid one, and the line only shows the
 * elastic transient when time is slowed (`tensionTimeScale`). That is a fact
 * about cold rolling, not a limitation of the port.
 */
import type { RollingParams } from './solver';
import { slabPointAt, type SlabCase } from './slab';

export type TensionModel = 'off' | 'rigid' | 'simple' | 'dist';

export const TENSION_MODEL_LABEL: Record<TensionModel, string> = {
  off: 'なし（張力は入力値のまま）',
  rigid: '剛体 (5.50–5.52)',
  simple: '単純弾性 (5.44)',
  dist: '分布弾性 (5.46–5.49)',
};

/**
 * The strip between two stands, as a queue of slices of (length, thickness).
 *
 * `slices[0]` is the downstream end, the material about to enter the next
 * stand; new material from the upstream stand is appended at the back. Lengths
 * are in model metres, so a queue advanced with the model time step transports
 * a thickness change across the gap in the model's own transit time.
 */
export class StripQueue {
  private slices: { len: number; h: number }[] = [];
  private sumLoH = 0;
  private total = 0;
  private ops = 0;

  constructor(L: number, h: number) { this.reset(L, h); }

  reset(L: number, h: number): void {
    this.slices = [{ len: Math.max(L, 1e-6), h: Math.max(h, 1e-9) }];
    this.recount();
  }

  /** strip length in the gap [m] */
  get length(): number { return this.total; }
  /** Σ ℓ_i / h_i [dimensionless]; the series compliance of the gap is this over E, per unit width */
  get sumLenOverH(): number { return this.sumLoH; }
  /** thickness at the downstream end - what the next stand is about to bite */
  frontThickness(): number { return this.slices[0]?.h ?? NaN; }
  /** how many slices the gap is holding, for the readout */
  get count(): number { return this.slices.length; }

  /** Material leaves the upstream stand: appended at the back. */
  push(len: number, h: number): void {
    if (!(len > 0) || !(h > 0)) return;
    const last = this.slices[this.slices.length - 1];
    // Merge with the slice behind when the gauge has not moved: a steady
    // stand would otherwise add one slice per frame for as long as it runs.
    if (last && Math.abs(last.h - h) <= 1e-4 * h) last.len += len;
    else this.slices.push({ len, h });
    this.sumLoH += len / h;
    this.total += len;
    if (++this.ops % 4096 === 0) this.recount();
  }

  /** Material enters the downstream stand: taken from the front. */
  pop(len: number): void {
    let left = len;
    while (left > 0 && this.slices.length > 1) {
      const s = this.slices[0];
      if (s.len <= left) {
        left -= s.len;
        this.sumLoH -= s.len / s.h;
        this.total -= s.len;
        this.slices.shift();
      } else {
        s.len -= left;
        this.sumLoH -= left / s.h;
        this.total -= left;
        left = 0;
      }
    }
    // The last slice is never emptied: a gap with nothing in it has no
    // thickness to hand on and no spring to speak of.
    if (left > 0 && this.slices.length === 1) {
      const s = this.slices[0];
      const take = Math.min(left, s.len * 0.5);
      s.len -= take;
      this.sumLoH -= take / s.h;
      this.total -= take;
    }
  }

  /** The two running sums, rebuilt from the slices so rounding cannot drift them. */
  private recount(): void {
    let t = 0, s = 0;
    for (const q of this.slices) { t += q.len; s += q.len / q.h; }
    this.total = t;
    this.sumLoH = s;
  }
}

/** The state one interstand gap carries between frames. */
export interface GapState {
  /** tension force per unit width [N/m]; the one quantity both stands share */
  T: number;
  queue: StripQueue;
  /** PI integrator on the relative error, in model seconds */
  integ: number;
  /** relative roll-speed trim the controller is asking of the upstream stand */
  trim: number;
  /** model time constant used at the last update [s]; NaN under rigid */
  tau: number;
  /** |dΔv/dT| [(m/s)/(N/m)], from Bland–Ford at the operating point */
  sens: number;
  /** the tension the entry-face reaction says would balance the speeds [N/m] */
  Trigid: number;
  /** (σ − σ*)/σ*, with the target floored so an unloaded gap has a scale */
  err: number;
  /** −1 slack (clamped at zero), +1 held below the strip's yield, 0 free */
  clamped: -1 | 0 | 1;
  /** consecutive frames the gap has been ready to read (see Mill.updateTension) */
  warm: number;
  /** the first read has happened; from here every transient is real */
  warmed: boolean;
}

export function newGapState(T: number, L: number, h: number): GapState {
  return {
    T, queue: new StripQueue(L, h), integ: 0, trim: 0, tau: NaN, sens: NaN,
    Trigid: T, err: 0, clamped: 0, warm: 0, warmed: false,
  };
}

/**
 * |dΔv/dT| at the operating point, by Bland–Ford on both sides of the gap.
 *
 * Δv = v_in,k+1 − v_out,k with v_out = ωR(1+f) and v_in = ωR(1+ε), ε the
 * backward slip that volume constancy pins to the forward one:
 * (1+ε) h0 = (1+f) h1. Both slips move with the pull on their side of the
 * neutral point, which is the whole mechanism by which tension re-balances a
 * line. Central difference in T; NaN when the theory has no neutral point on
 * either side (it then has no forward slip to differentiate), which the
 * caller treats as "use the rigid step".
 */
export function speedSensitivity(
  up: RollingParams, upH1: number, upRp: number, upStrain: number,
  dn: RollingParams, dnH1: number, dnRp: number, dnStrain: number,
  T: number,
): number {
  if (!(upH1 > 0) || !(dnH1 > 0) || !(dn.h0 > 0) || !(up.omega > 0) || !(dn.omega > 0)) return NaN;
  const pu: RollingParams = { ...up, slabTheory: 'blandford' };
  const pd: RollingParams = { ...dn, slabTheory: 'blandford' };
  const dv = (t: number): number => {
    const cu: SlabCase = {
      h0: up.h0, h1: upH1, R: up.R, backTension: up.backTension, frontTension: t / upH1,
      entryStrain: upStrain,
    };
    const cd: SlabCase = {
      h0: dn.h0, h1: dnH1, R: dn.R, backTension: t / dn.h0, frontTension: dn.frontTension,
      entryStrain: dnStrain,
    };
    const fu = slabPointAt(pu, cu, up.mu, upRp > 0 ? upRp : up.R).forwardSlip;
    const fd = slabPointAt(pd, cd, dn.mu, dnRp > 0 ? dnRp : dn.R).forwardSlip;
    if (!Number.isFinite(fu) || !Number.isFinite(fd)) return NaN;
    const eps = ((1 + fd) * dnH1) / dn.h0 - 1;
    return dn.omega * dn.R * (1 + eps) - up.omega * up.R * (1 + fu);
  };
  // A step of 5 % of the tension, but never under 0.1 MPa on the thinner
  // gauge: at zero tension a relative step is no step at all.
  const dT = Math.max(0.05 * Math.abs(T), 1e5 * Math.min(upH1, dn.h0));
  const a = dv(T + dT), b = dv(Math.max(0, T - dT));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  const s = Math.abs((a - b) / (T + dT - Math.max(0, T - dT)));
  return s > 0 ? s : NaN;
}

/**
 * The tension a unit of speed trim on the upstream stand buys [Pa].
 *
 * A trim u moves the speed mismatch by u·v_out; the rigid tension moves by
 * that over the slip sensitivity, and the stress by that over the gauge. The
 * plant gain, so the controller can be given a closed-loop rate rather than a
 * gain that would have to be re-tuned for every schedule - measured on the
 * three-stand default it is about 50 MPa per percent of trim, which a PI on a
 * relative error found out the hard way. With no sensitivity to hand (the
 * theory has no neutral point) a fixed 4 GPa per unit trim stands in.
 */
export function plantGain(g: GapState, vOut: number, h1: number): number {
  const ok = Number.isFinite(g.sens) && g.sens > 0 && vOut > 0 && h1 > 0;
  return ok ? vOut / (g.sens * h1) : 4e9;
}

/**
 * One PI step on a gap. The error is the tension deficit in units of the
 * speed trim that would cancel it, so `ki` is the closed-loop rate [1/s of
 * model time] and `kp` the fraction of the deficit taken at once, on any
 * schedule. `err` is kept relative to the target (floored at 5 MPa) for the
 * readouts and the settle test. Anti-windup by back-calculation: a step that
 * hits the trim limit is not integrated.
 */
export function piStep(
  g: GapState, sigma: number, target: number, gain: number, dtm: number,
  kp: number, ki: number, vLimit: number,
): void {
  g.err = (sigma - target) / Math.max(target, 5e6);
  const e = (sigma - target) / gain;
  g.integ += e * dtm;
  let u = kp * e + ki * g.integ;
  if (Math.abs(u) > vLimit) {
    u = Math.sign(u) * vLimit;
    g.integ -= e * dtm;
  }
  g.trim = u;
}
