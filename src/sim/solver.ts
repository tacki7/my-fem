/**
 * Coupled model of a two-high rolling stand.
 *
 *   strip : steady rigid-viscoplastic flow through the roll gap (flow.ts)
 *   roll  : linear elastic annulus on a rigid hub, loaded by the interface
 *           tractions, whose flattened barrel profile defines the gap
 *
 * The two are coupled once per frame: the flow solve produces an interface
 * pressure distribution, the roll solve turns it into a flattened barrel
 * profile, and the next flow solve runs in that gap. That loop is roll
 * flattening - the reason a cold mill quotes a deformed radius R' rather than
 * the ground radius R, and the reason thin strip gets progressively harder to
 * reduce.
 *
 * Only the upper half is modelled; y = 0 is the strip centre line.
 */

import { buildRollMesh, type RollMesh } from './mesh';
import type { TensionModel } from './tension';
import { precomputeElements, assembleStiffness, type ElementGeometry } from './element';
import {
  buildCsrPattern, makePcgWorkspace, pcgFiltered, patternBytes, workspaceBytes,
  type CsrPattern, type PcgWorkspace,
} from './sparse';
import { BandPreconditioner } from './band';
import { FlowSolver, type FlowInput } from './flow';
import type { SlabCase, SlabPoint } from './muinv';

/**
 * The closed slab model, handed in by the app.
 *
 * `muinv.ts` imports the flow-stress helpers from this file, so importing it
 * back would be a cycle; the app owns both and wires them at boot. Null means
 * the FEM load is the only one there is.
 */
type SlabHook = (p: RollingParams, c: SlabCase, mu: number, Rp?: number) => SlabPoint;
let slabHook: SlabHook | null = null;
export function setSlabHook(fn: SlabHook): void { slabHook = fn; }

/** Which model the reported rolling load comes from. */
export type LoadModel = 'fem' | 'slab';
/** Which slab theory the slab load - and the mu back-calculation - use; see `slab.ts`. */
export type SlabTheory = 'karman' | 'orowan' | 'blandford';
/**
 * Why the slab load could not be computed this frame, if it could not. The
 * load model stays what was selected either way: a stand that cannot be
 * solved by the theory says so, rather than quietly reporting the FEM.
 */
export type SlabStatus =
  /** solved */
  | 'ok'
  /** the theory's own flattening has no fixed point; evaluated at the FEM's radius instead */
  | 'runaway'
  /** the mean pull is at or above the deformation resistance: no hill to build */
  | 'tension'
  /** exit gauge at or above the entry gauge: no draft, no formula */
  | 'geometry'
  /** the strip is not in the bite */
  | 'nobite';
/** How the slab theories flatten the roll; see `flatRadius` in `muinv.ts`. The FEM solves it. */
export type FlatteningModel = 'hitchcock' | 'roberts';

/** the stand counts as settled below this residual, relative to h0 */
const MILL_SETTLED = 1e-3;
/** restarts after a NaN solve allowed inside the window before the stand is left alone [count, ms] */
const DIVERGE_LIMIT = 5;
const DIVERGE_WINDOW = 30000;

/**
 * Re-fit the column layout once the bite has stretched or shrunk its share
 * of the mesh by this factor either way - see `fitColumns`.
 */
const ARC_REFIT = 1.6;
/**
 * When the mesh entry moves onto the barrel crossing.
 *
 * As an outer iteration, and only then: on a frame where the stand is
 * quiet - the free-running speed loop inside its band, and the gap loop
 * settled, or off - the entry goes onto the crossing, and then nothing
 * moves it for ENTRY_HOLDOFF frames, so the loops can settle on the new arc
 * before the next correction. A correction moves the load by up to 5 % of
 * a column's worth (a quarter of a percent at ENTRY_CATCH_BAND), the
 * crossing moves back by 0.13 of that (measured, see below), so a few
 * rounds finish it. Residuals under ENTRY_MIN of a column are not worth a
 * round. From further than ENTRY_CATCH_BAND away - a layout just laid, a
 * bite reshaped by a large setpoint change - the entry closes in at
 * ENTRY_CATCH_UP a frame regardless; whatever did that has disturbed the
 * loops anyway.
 *
 * Between corrections the arc stays put, whatever the screws do. That was
 * reached the long way. Every way of following the crossing on its own
 * schedule was measured, and every one made the speed loop ring on the
 * third stand of a line: frame by frame, h1 +-0.3 um and P +-1 % at a 6 s
 * period; a slow relaxation only lowered the amplitude; steps taken while
 * the speed loop was quiet kicked it back out of its gate whether they
 * were 9 um or 1 um; no gain or cadence given to the speed loop (0.05-0.15,
 * every 6-20 frames) cured any of it. Not the mesh loop itself, whose
 * static gain is -0.13 with the rest of the stand settled: the speed loop,
 * tuned for a plant whose contact arc stays put, sees a steeper and lagged
 * one when the arc moves under it. With the entry held still the same
 * stand settles in 61 s and stays to the last digit.
 *
 * Feeding the screws' share forward - moving the entry with each screw
 * move by the geometry, open loop - was measured three ways and lost each
 * time. Over the barrel's local slope: at a flattened entry the barrel is
 * nearly flat, a 0.1 um trim moved the entry 15-20 um, and the gap loop
 * under load control identified the mesh rather than the stand (164 moves
 * in 70 s, +-1 %). Over the nominal slope R'/|x_entry|, every move: the
 * gap loop then saw the arc's share of dP/dS and FEM load control settled
 * on the first stand in 11 s, but on a thin, hard pass a 1 um trim is
 * 0.05 of a column of arc, one kick to the speed loop per trim every four
 * frames, and stands 2 and 3 never settled in either load model. Moves of
 * 1 um and over only: the same, one stand later. So the arc does not
 * answer the screws at all, and the gap loop under FEM load control
 * converges to the arc's own resolution instead - see MESH_QUANTUM.
 */
const ENTRY_CATCH_UP = 0.1;
const ENTRY_CATCH_BAND = 0.05;
const ENTRY_MIN = 0.005;
const ENTRY_HOLDOFF = 60;

/**
 * What FEM load control can resolve, relative to the target.
 *
 * The FEM load reads the contact arc at about 5 % a column, and the arc is
 * corrected in steps of up to ENTRY_CATCH_BAND columns between the loops'
 * settled states. Below that the load is not a function of the screws the
 * loop can identify - with the arc frozen through its trims it sees a gain
 * without the arc term, and every correction lands as a jump it did not
 * make - and asking it for 1e-6 there had it hunting at +-0.5 % for as long
 * as it was left. So under load control on the FEM model the deadband is
 * at least this: converged to what the mesh resolves, which is also
 * inside what the mesh resolution itself leaves open (100x8 against 200x14
 * differ by 0.8 %). The slab load is a function of the exit gauge alone
 * and keeps the configured deadband.
 */
const MESH_QUANTUM = 2.5e-3;
/** the gap loop holds while the mesh entry is further than this from the crossing, in columns */
const MESH_SETTLED = 0.1;
/** screws within this of their command count as arrived [m] */
const SCREW_ARRIVED = 0.2e-6;
/** frames after a reset during which the screws still teleport: threading, not rolling */
const SCREW_WARM = 120;

/**
 * How far the error may wander before a settled loop is unsettled again,
 * relative to the same scale as the deadband.
 *
 * The deadband is the precision the loop works *to*; this is the precision
 * it holds *at*, and the two cannot be the same number. At a fixed screw the
 * plant still moves: the feed loop trims its speed whenever its own residual
 * crosses its deadband, and each trim shifts the exit gauge by about 0.1 um.
 * Under load control that is 2e-5 of the load once the slab formula has
 * amplified it - twenty times the deadband. Measured on the three-stand line
 * at 1040 tonf in slab mode, stands 2 and 3 reached 1040.0 and then flipped
 * between 収束 and 調整中 for as long as the run lasted, the loop moving the
 * screws by tens of nanometres each time and achieving nothing. Once inside
 * the deadband the loop now stays settled until the error clears this band
 * - a real disturbance (the stand upstream re-aiming, a target change) walks
 * straight through it; jitter does not.
 */
const AGC_RELEASE = 1e-4;

/**
 * How far past its own deadband the free-running speed loop may be before the
 * gap loop refuses to act on what it is measuring.
 *
 * A screw move is only as good as the state it was computed from, and the feed
 * loop is the slowest and loosest of the inner loops. Left ungated it can be
 * two orders of magnitude outside its deadband - which happens for real, after
 * a path through a target above the load ceiling, where the bite condition
 * fails and a free-running speed does not exist - and the gap loop will then
 * confidently optimise against a velocity field that means nothing.
 */
const FEED_SETTLED = 3;

export interface RollingParams {
  /* work roll */
  R: number;
  hubRatio: number;
  rollNt: number;
  rollNr: number;
  rollRadialGrade: number;
  biteGrade: number;
  /** element rings inside the refined barrel surface layer; 0 disables it */
  rollSkinRings: number;
  /** refined layer thickness [m], used when rollSkinAuto is off */
  rollSkinThickness: number;
  /**
   * Size the refined layer from the contact arc instead.
   *
   * The contact stress in the barrel decays over a depth of order the contact
   * length, so a few arc lengths of fine elements resolve everything that
   * matters and the rest of the wall can be coarse.
   */
  rollSkinAuto: boolean;
  /** auto mode: refined element size = contact arc / rollSkinFactor */
  rollSkinFactor: number;
  Eroll: number;
  nuRoll: number;
  omega: number;

  /* strip */
  h0: number;
  reduction: number;
  stripNx: number;
  stripNy: number;
  windowIn: number;
  windowOut: number;
  /**
   * Size the analysis window and the circumferential grading from the contact
   * arc instead of using the fixed values above.
   *
   * The bite scales as sqrt(R*dh) while a fixed window does not, so thin gauge
   * on a small roll ends up with a contact arc shorter than one element column
   * and element aspect ratios in the hundreds. That is what makes thin-strip
   * runs oscillate: the pressure is being sampled off a bite nothing resolves.
   */
  autoFit: boolean;
  /**
   * LMN hardening law, in the plane-strain deformation resistance a mill is
   * quoted in:
   *
   *     kf = L * (eps + M)^N        [Pa]
   *
   * `M` is the pre-strain offset, so kf is finite at eps = 0 rather than zero,
   * and `N` the hardening exponent. The solve itself carries the uniaxial flow
   * stress, so everything below converts with sigma_f = kf * sqrt(3)/2.
   */
  lmnL: number;
  lmnM: number;
  lmnN: number;
  /**
   * Deformation heating.
   *
   * Nearly all the work of rolling ends up as heat in the strip, and the strip
   * has no time to give it away: a 2 mm gauge crosses an 8 mm bite in about a
   * millisecond, over which heat diffuses some 0.1 mm. So the bite is treated
   * as adiabatic - each particle keeps the heat it makes - and the temperature
   * rides the same streamlines the strain does, with the plastic power
   * `beta * sigma_f * eps_dot` as its source. Cold rolling steel at 25 % comes
   * out 40-50 K hotter this way, which is what a mill measures.
   *
   * The heat then feeds back: the flow stress is softened by the Johnson-Cook
   * thermal term over the homologous temperature, so `heatOn` couples strength
   * to the work already done rather than only to the strain.
   *
   * Off by default. Every figure in docs/validation.md was measured isothermal
   * and the switch is a clean A/B against them.
   */
  heatOn: boolean;
  /** strip temperature entering the line [degC]; the datum softening is 1 at */
  tempEntry: number;
  /** Taylor-Quinney coefficient: the fraction of plastic work that is heat */
  taylorQuinney: number;
  /** strip density [kg/m3] */
  rhoStrip: number;
  /** strip specific heat capacity [J/(kg K)] */
  cpStrip: number;
  /** melting point [degC] - the top of the homologous temperature scale */
  tempMelt: number;
  /** thermal softening exponent m in (1 - T*^m) */
  softenExp: number;
  /** strip elastic constants, used for the entry/exit elastic zones */
  Estrip: number;
  nuStrip: number;
  /**
   * Model the elastic entry and exit zones.
   *
   * A rigid-plastic body has no elastic strain, so the strip would enter and
   * leave the bite perfectly rigid. Real cold rolling does neither: ahead of
   * the plastic zone the strip is elastically compressed (typically the first
   * 7-10 % of the contact arc), and on leaving it springs back by roughly
   * kf / E', a tenth of a percent of the thickness. On thin gauge both matter.
   *
   * With this on, the viscosity ceiling becomes the material's own elastic
   * response over the bite transit time, G*t, and the volumetric term becomes
   * the true bulk modulus times the same time - so the non-plastic regions
   * deform elastically instead of being arbitrarily rigid.
   */
  elasticZones: boolean;

  /* interface */
  mu: number;
  /** friction regularisation velocity as a fraction of the roll speed */
  slipFrac: number;

  /* process */
  backTension: number;
  frontTension: number;
  /** 0 = solve for the free-running feed speed, otherwise prescribe it [m/s] */
  feedSpeed: number;

  /* numerics */
  incompPenalty: number;
  normalPenalty: number;
  /** strain rate regulariser as a fraction of the nominal bite strain rate */
  eps0Frac: number;
  picardIters: number;
  relax: number;
  cgIter: number;
  cgTol: number;
  rollCoupling: boolean;
  rollRelax: number;
  /** frames between revisions of the free-running feed speed */
  feedEvery: number;
  /** proportional gain of the feed speed loop, as a relative step */
  feedGain: number;
  /** stop adjusting once |R| / (mu*P) is below this */
  feedDeadband: number;
  /** run the roll elastic solve every N frames; it changes slowly */
  rollEvery: number;

  /*
   * Interstand tension (src/sim/tension.ts). Line-level: read by `Mill`,
   * ignored by the stand solve, and carried here so the settings file, the
   * query string and the change detection see them like everything else.
   */
  /**
   * Strip speed leaving the line [m/s]. In tandem with the speed cone on this
   * is the one speed the line is run at: every barrel speed is derived from
   * it by mass flow and forward slip (see `Mill.advance`). `omega` is then an
   * outcome per stand, not an input.
   */
  lineSpeed: number;
  /** how the tension between stands is made to move; 'off' keeps the inputs */
  tensionModel: TensionModel;
  /** distance between stands [m]; the length of the elastic bar */
  standDistance: number;
  /** model seconds per real second for the tension dynamics and the controller */
  tensionTimeScale: number;
  /** rigid: fraction of the reaction-implied correction applied per frame */
  tensionFollow: number;
  /** PI on the upstream stand's roll speed, holding each gap at its σf target */
  tensionControl: boolean;
  /** proportional gain: speed trim per unit relative tension error */
  tensionKp: number;
  /** integral gain [1/s of model time] */
  tensionKi: number;
  /** trim limit as a fraction of the base roll speed */
  tensionVLimit: number;

  /* automatic gap control */
  /**
   * What the screws are asked to hold.
   *
   *  'off'   - the screw position stays where the commanded reduction put it.
   *            What leaves the mill is that gap plus the mill spring, so the
   *            stand always under-reduces; the shortfall is `reductionRatio`.
   *  'ratio' - drive the *measured* exit thickness onto h0*(1-r). What is held
   *            is the ratio: the setpoint is tied to this stand's own entry
   *            gauge, so on a tandem line it follows the stand upstream and a
   *            disturbance is passed along the line rather than absorbed.
   *  'gauge' - drive it onto `agcTargetGauge`, an absolute thickness that owes
   *            nothing to the entry. The stand then absorbs whatever its
   *            upstream sends it, which is what the last stand of a line is
   *            for: the coil is sold on its gauge, not on its reduction.
   *  'force' - hold the roll separating force on `agcTargetForce` and let the
   *            reduction come out wherever that puts it.
   *
   * The two gauge loops are the same controller pointed at different
   * setpoints; only `agcSetpoint` differs.
   */
  agcMode: AgcMode;
  /** load target per unit width [N/m], used by agcMode = 'force' */
  agcTargetForce: number;
  /** exit thickness target [m], used by agcMode = 'gauge' */
  agcTargetGauge: number;
  /**
   * How the gap loop searches for the screw position that hits its target.
   *
   * The loop is a one-dimensional root find on a monotone plant - the exit
   * gauge rises with the gap, the load falls with it - so every classical
   * root-finder applies, and they trade the same way here as anywhere: speed
   * against the guarantee of not running away. What makes the choice
   * interesting on a mill rather than academic is that an evaluation is not
   * free. Every trial screw position has to wait for the flattening and feed
   * loops to relax before the measurement means anything, so a method is
   * judged on *evaluations*, not on arithmetic.
   *
   * See `AGC_METHODS` for what each one does and where it wins.
   */
  agcMethod: AgcMethod;
  /** damping on the Newton step; 1 takes the full identified step */
  agcGain: number;
  /** frames between screw revisions - the gap needs time to relax in between */
  agcEvery: number;
  /** stop once the relative error is inside this */
  agcDeadband: number;
  /** largest single screw move, as a fraction of h0 */
  agcMaxStep: number;
  /**
   * Screwdown actuator dynamics. Off, the screws are wherever the loop last
   * put them, the same frame. On, the loop's move is a *command* and the
   * screws follow it with a speed limit and a first-order lag - the way a
   * screwdown actually moves - and the loop waits for them to arrive before
   * it reads the plant again.
   */
  screwDyn: boolean;
  /** screw speed limit [m/s] */
  screwRate: number;
  /** first-order lag of the screw position behind its command [s] */
  screwTau: number;
  /**
   * Whether a stand waits for the stands ahead of it to settle before its gap
   * loop moves. Off by default; see `Mill.advance` for what it was for and
   * the note on `lineHold` in the app for why it lost.
   */
  lineHold: boolean;
  /**
   * Where the rolling load comes from.
   *
   * `fem` integrates the interface pressure the flow solve produced. `slab`
   * replaces that one number - and the torque, power, mean pressure and
   * flattened radius that go with it - by the Siebel / von Karman estimate
   * with tension and Hitchcock flattening (the model μ逆算 inverts), evaluated
   * on the gauge the FEM is actually making. Everything downstream of the
   * load then reads the slab value: load control, the housing stretch, the
   * stand table, the mill line. The flow solve itself keeps running, because
   * the slab formula has no way to produce a gauge, a neutral point or a
   * pressure profile of its own; those stay the FEM's.
   */
  loadModel: LoadModel;
  /** which slab theory that is - Siebel's closed form, Bland & Ford, or Orowan (see `slab.ts`) */
  slabTheory: SlabTheory;
  /** and how it flattens the roll - Hitchcock's radius or Roberts' arc (see `muinv.ts`) */
  flattening: FlatteningModel;
  /**
   * Whether the gauge loops pay for the mill spring.
   *
   * On (the default), 圧下率一定 and 出側板厚一定 drive the *measured* exit
   * gauge to the target: the screws close past h0(1-r) by however much the
   * roll flattens, the housing stretches and the strip springs back, and
   * that takes the loop several seconds of trimming against the inner loops.
   *
   * Off, the reduction is taken literally as a screw position: S = h0(1-r)
   * (or S = the gauge target), set once, and the strip leaves at S plus the
   * spring. One solve, no loop - the answer a rigid-mill calculation gives -
   * and the panel reports the spring as the deviation rather than removing
   * it. Load control is unaffected; a load loop has no gauge to compensate.
   */
  agcSpringComp: boolean;

  /* mill spring */
  /**
   * Let the stand outside the barrel give under load.
   *
   * With this off the screws, the housing and the hub are rigid, and the only
   * spring in the mill is the roll surface flattening plus the strip's own
   * recovery - tens of microns. A real stand gives far more than that.
   */
  millSpringOn: boolean;
  /**
   * Mill modulus per unit width [N/m of separation per m of width, i.e. Pa].
   *
   * The stand is quoted as a total stiffness, typically 4-10 MN/mm for a cold
   * mill; divide by the strip width to get this. The barrels separate by P/M
   * under load, on top of the flattening.
   */
  millModulus: number;

  /**
   * Closed end of the screw travel, as a fraction of h0.
   *
   * Not a numerical limit - nothing breaks below it - but a validity one. The
   * volume the solve conserves degrades as the reduction climbs: at 0.30 the
   * mass balance is 0.988, at 0.20 it is 0.925 and at 0.10 it is 0.683. Below
   * the default the numbers still come out, they are just no longer the answer
   * to the question that was asked, so the UI says so.
   */
  sepFloorFrac: number;
}

export type AgcMode = 'off' | 'ratio' | 'gauge' | 'force';

export type AgcMethod =
  | 'secant' | 'newton' | 'gaugemeter' | 'fixed'
  | 'bisect' | 'falsi' | 'illinois' | 'ridders' | 'brent';

/**
 * The search methods, in the order they belong in a menu: open methods first,
 * then the bracketed family from plainest to cleverest.
 *
 * "Bracketed" is the property that matters most here. Once a gap that is too
 * small and a gap that is too large are both in hand, the answer is trapped
 * between them and no iterate can leave - which is worth a great deal on this
 * plant, because the load is a *staircase* in the gap (the contact set gains
 * and loses whole element columns as the barrel moves) and any method that
 * extrapolates from a local slope can be thrown a long way by one bad step.
 */
export const AGC_METHODS: { value: AgcMethod; label: string; note: string }[] = [
  {
    value: 'secant', label: '割線法（同定ゲイン）',
    note: '直前の 1 手から実際の感度 d(測定値)/d(ギャップ) を同定し、その逆数を'
      + '掛けて動かす。プラントの素性を測りながら進むので手数が少ない。'
      + '区間で挟まないので、階段状の応答で感度を読み違えると行き過ぎる。既定。',
  },
  {
    value: 'newton', label: 'ニュートン法（差分近似）',
    note: '毎回わざと小さく揺さぶって、その場で傾き Δ(測定値)/Δ(ギャップ) を測り直し、'
      + 'ニュートン歩幅で動く。割線法が「前回動いたついでの傾き」を使い回すのに対し、'
      + 'こちらは常に新鮮な傾きを使うので、収束間際に前回の移動量が小さくなって'
      + '傾きが荒れる問題がない。ただし 1 反復に評価が 2 回要る。'
      + '揺さぶり幅が接触列 1 本ぶんより小さいと段差の中に収まって傾きが 0 に見え、'
      + '歩幅が発散するので、幅は「1 回の最大移動量」に合わせてある。',
  },
  {
    value: 'gaugemeter', label: 'ニュートン法（ゲージメータ解析式）',
    note: '傾きを測らずミルの式から出す。板厚制御は dh₁/dS = 圧下量/(圧下量+スプリング)、'
      + '荷重制御は dP/dS = −P/(圧下量+スプリング)。どちらもこの場で測れている量だけで'
      + '書けるので材料定数が要らない。評価は 1 回だけで揺さぶりも不要だが、'
      + '式が実機とずれているぶんは残る。',
  },
  {
    value: 'fixed', label: '固定ゲイン（同定なし）',
    note: '感度を同定せず、初手の推定値のまま比例制御する。最も単純で、'
      + '同定が悪さをする条件でも壊れない代わりに、推定が外れているぶん遅い。'
      + '他手法の基準線として置いてある。',
  },
  {
    value: 'bisect', label: '二分法',
    note: '解を挟む区間を作り、毎回その中点へ動く。1 手で区間が必ず半分になるので'
      + '発散しようがない。収束は線形（1 手 = 1 ビット）なので手数は多い。'
      + '応答が階段状で他手法が暴れるときの保険。',
  },
  {
    value: 'falsi', label: 'はさみうち法（regula falsi）',
    note: '区間の両端を直線で結び、その零点へ動く。素直な条件では二分法より'
      + 'ずっと速い。一方の端が更新されないまま片側から寄り続けて失速することがある。',
  },
  {
    value: 'illinois', label: 'Illinois 法',
    note: 'はさみうち法の失速を潰した版。同じ端が 2 回連続で残ったら、その端の'
      + '値を半分にして直線を傾ける。区間法の安全さを保ったまま超線形。'
      + '実装が軽い割に速く、実務での既定に向く。',
  },
  {
    value: 'ridders', label: 'Ridders 法',
    note: '区間の中点を測り、指数関数を当てはめて零点を推定する。'
      + '1 反復に 2 回の評価が要るが 1 反復あたりの次数が高い。'
      + 'このアプリでは 1 回の評価が数秒なので、その 2 回分が効くかは条件による。',
  },
  {
    value: 'brent', label: 'Brent 法',
    note: '逆 2 次補間・割線法・二分法を状況で切り替える定番。'
      + '補間が信用できない場面では自動的に二分法へ落ちるので、'
      + '「速いのに絶対に外れない」を 1 つで満たす。',
  },
];

export interface RollingDiagnostics {
  rollForce: number;
  /** the FEM's own load [N/m], kept whichever model is reporting */
  loadFem: number;
  /** which model `rollForce` came from this frame - the selected one, always */
  loadModel: LoadModel;
  /** under the slab load: whether the theory solved, and why not if it did not */
  slabStatus: SlabStatus;
  /** under the slab load: the theory's own forward slip, neutral point, arc [m] and strain-averaged kf [Pa]; NaN otherwise */
  forwardSlipSlab: number;
  neutralXSlab: number;
  arcLengthSlab: number;
  kfSlab: number;
  /** roll torque per unit width [N*m/m] */
  torque: number;
  /** mill power per unit width [W/m] */
  power: number;
  peakPressure: number;
  meanPressure: number;
  /** measured contact arc length [m] */
  arcLength: number;
  arcIn: number;
  arcOut: number;
  contactNodes: number;
  /** x of the neutral point [m] */
  neutralX: number;
  neutralFound: boolean;
  entrySpeed: number;
  exitSpeed: number;
  /** forward slip (v1 - vR)/vR, the mill's 先進率 */
  forwardSlip: number;
  /** backward slip (vR - v0)/vR, its entry-side counterpart */
  backwardSlip: number;
  /** neutral angle measured from the exit plane [rad] */
  neutralAngle: number;
  /**
   * Forward slip the neutral point implies under the slab assumption,
   * f = x_n^2 / (R' h1). It comes from equating the strip's *mean* speed to the
   * barrel speed; the FEM equates the strip's *surface* speed, which friction
   * drags behind the mean, so the two need not agree.
   */
  forwardSlipTheory: number;
  /** neutral point the measured forward slip implies, sqrt(f R' h1) [m] */
  neutralTheory: number;
  /** v1*h1 / (v0*h0); volume constancy, 1 in an exactly incompressible solution */
  massBalance: number;
  /** thicknesses actually achieved [m] */
  entryThickness: number;
  exitThickness: number;
  /** equivalent plastic strain leaving the bite (thickness mean) */
  exitStrain: number;
  peakStrain: number;
  exitFlowStress: number;
  /**
   * Mean deformation resistance through the bite [Pa], volume weighted.
   *
   * This, not the exit value, is what a rolling load formula wants: the
   * material enters at the virgin yield stress and only reaches the exit value
   * at the very end, so using the exit value overstates the load.
   */
  meanFlowStress: number;
  /** the same in plane strain, 1.155 * mean flow stress [Pa] */
  meanPlaneStrainStress: number;
  /**
   * Strain-averaged Ludwik value, sigma_Y0 + K*eps1^n/(n+1) [Pa]. The textbook
   * mean deformation resistance, for comparison with the volume weighted one.
   */
  meanFlowStressTheory: number;
  peakStrainRate: number;
  /** length of the elastic compression zone at the bite entry [m] */
  elasticEntryLen: number;
  /** length of the elastic recovery zone at the exit [m] */
  elasticExitLen: number;
  /** plastic part of the contact arc [m] */
  plasticArcLen: number;
  /** geometric estimate of the elastic entry length, dh_e * R / |x_entry| [m] */
  elasticEntryTheory: number;
  /** textbook isolated-contact estimate sqrt(R' * dh_e) [m] */
  elasticEntryHertz: number;
  /** thickness strain recovered on leaving the roll */
  springback: number;
  /** elastic compression taken up ahead of yielding [m], h0 * kf / E' */
  elasticEntryCompression: number;
  /** exit thickness before the elastic recovery is applied [m] */
  exitThicknessGap: number;
  /** elastic flattening of the barrel at the bite [m] */
  rollFlattening: number;
  /** Hitchcock deformed radius [m] */
  hitchcockR: number;
  /**
   * Stone's minimum rollable thickness [m], C*mu*R*(kf - sigma_mean) with the
   * same roll compliance C the Hitchcock radius uses.
   *
   * Below it the barrel flattens faster than the gap closes and the strip
   * stops thinning however hard the screws are driven - which also puts a
   * ceiling on the load, because load needs reduction. `exitThickness/hMin` is
   * the useful number: far above 1 the stand has room, near 1 it does not.
   */
  stoneHMin: number;
  /**
   * Thinnest exit gauge the bite condition still allows [m].
   *
   * Friction can only drag the strip in while mu >= tan(alpha), so the bite
   * angle is capped at atan(mu) and with it the draft:
   *
   *     dh_max = 2 R' (1 - cos(atan mu)),   h1_bite = h0 - dh_max
   *
   * That is the criterion for *catching* the strip. Once rolling is going the
   * resultant acts around the middle of the arc and the condition relaxes to
   * mu >= tan(alpha/2), i.e. twice the angle and a much thinner reachable
   * gauge - `biteLimitH1Cont`. Between the two the bite is marginal, and that
   * is exactly where this model is equivocal: at mu = 0.10 and 0.12 (r = 25%,
   * h0 = 8 mm) the strict criterion says no and the solve still finds a
   * neutral point, while at 0.05 neither does. Report the band, not a verdict.
   *
   * Not clamped at zero: on thin gauge the bite-angle-limited draft
   * 2 R' (1 - cos alpha) is larger than the whole strip, so the limit comes out
   * negative and the honest reading is "does not constrain anything here" - a
   * clamped 0.0000 mm just looks like a broken readout.
   */
  biteLimitH1: number;
  /** the same for the continuation condition mu >= tan(alpha/2) [m] */
  biteLimitH1Cont: number;
  rollPeakVm: number;
  /** net longitudinal reaction at the feed face [N/m]; zero when free running */
  feedReaction: number;
  /** height of the prescribed feed face [m]; `feedReaction` over this is a stress */
  feedFace: number;
  picardDelta: number;
  cgIterations: number;
  cgResidual: number;
  /** |dh1| / h1 per frame; how settled the roll flattening loop is */
  couplingResidual: number;
  /** current adaptive damping factor on rollRelax, 1 = undamped */
  relaxScale: number;
  /**
   * The bite-entry column has been switching in and out - see the note in
   * the bite detection. A discretisation limit cycle, not a control one.
   */
  /** |feed reaction| / (mu * rolling load); the free-running convergence measure */
  feedResidual: number;
  /**
   * How far the mesh entry column is from where the barrel actually crosses
   * h0/2, in columns. The gap loop holds while this is above MESH_SETTLED:
   * the load it would read is the load of an arc that is still moving.
   */
  meshResidual: number;
  /**
   * The best that residual has managed lately - the noise floor the plant
   * imposes, not a target. The gap loop waits for the feed to reach *this*,
   * not an arbitrary deadband it may be unable to get under.
   */
  feedFloor: number;
  /**
   * Fraction of the *commanded* reduction actually achieved, h0*r being the
   * command. Well below 1 with the screws fixed means the barrel is flattening
   * faster than the gap closes - Stone's minimum rollable thickness, not a
   * numerical failure. Gauge control exists to drive it back to 1.
   */
  reductionRatio: number;
  /** unloaded roll gap the screws are holding [m]; the AGC's actuator */
  gapCommand: number;
  /** where the gap loop has asked the screws to go [m]; equals `gapCommand` once they arrive */
  screwCommand: number;
  /** mill spring: how much thicker the strip leaves than the screws are set [m] */
  millSpring: number;
  /** the housing/screw part of that spring, P/M [m]; 0 with a rigid stand */
  millStretch: number;
  /** |stretch - P/M| / h0; how far the stand is from its own equilibrium */
  millResidual: number;
  /** screw travel the loop is allowed, given the stretch it currently has [m] */
  gapLimitLo: number;
  gapLimitHi: number;
  /**
   * The low-passed measurement the gap loop is acting on - exit thickness [m]
   * under gauge control, roll force [N/m] under load control, 0 when off.
   *
   * Not the same as the instantaneous `exitThickness` / `rollForce`: the loop
   * deliberately works on a filtered value, and during a transient the two can
   * be tens of percent apart. Report this one next to `agcError`, or the error
   * shown will not be the error the numbers next to it imply.
   */
  agcMeasured: number;
  /** signed relative error the gap loop is working on; 0 when it is off */
  agcError: number;
  /** the loop is inside its deadband */
  agcSettled: boolean;
  /** the loop is asking for screw travel the model will not give it */
  agcSaturated: boolean;
  /**
   * Absolute-gauge target at or above the entry gauge, so this stand has
   * nothing to roll and has been parked. Not an error - a pass schedule can
   * legitimately arrive at size before its last stand.
   */
  agcIdle: boolean;
  /**
   * The gap loop is holding station because an inner loop has not converged,
   * so what it would be measuring is not a steady state. Not the same as
   * settled: nothing is being achieved, the screws are simply not moving on
   * information that would be wrong.
   */
  agcStalled: boolean;
  /** identified loop gain d(measurement)/d(gap), both non-dimensionalised */
  agcSensitivity: number;
  /**
   * The slope of the plastic curve the loop is walking, dP/dh1 [N/m per m]:
   * how much the load per unit width moves per metre of exit gauge, read
   * off consecutive screw revisions (both the load and the gauge are
   * measured at each). Negative - thinner is heavier. The Q of the
   * gaugemeter relation dh1/dS = M/(M+Q), identified rather than assumed,
   * and the same quantity under gauge and load control alike. 0 until two
   * revisions have moved the gauge far enough apart to read it.
   */
  agcPlasticSlope: number;
  /**
   * Screw revisions the loop has made since this convergence began: from the
   * last target or mode change, or from the moment a settled loop was pushed
   * back out of its release band, up to the move that brought it inside the
   * deadband. Frozen while settled, so it reads as "how many iterations that
   * took" - the number to compare FEM against スラブ法 on. 0 with the loop off.
   */
  agcIterations: number;
  /** equivalent strain the strip arrived with; 0 unless fed by another stand */
  entryStrain: number;
  /** temperature it arrived at [degC] */
  entryTemp: number;
  /** thickness-averaged strip temperature at the exit plane [degC] */
  exitTemp: number;
  /** what the plastic work added to it [K]; 0 with the heating model off */
  tempRise: number;
  /** hottest node anywhere in the strip [degC] - the surface, under the bite */
  peakTemp: number;
  /** flow stress lost to that heat at the exit, 1 - kf(T)/kf(T_entry) */
  thermalSoftening: number;
}

export type FieldKind =
  | 'strain' | 'strainRate' | 'flowStress' | 'temperature'
  | 'pressure' | 'speed' | 'shear' | 'vonMises'
  | 'rollDisp' | 'rollRadial';

const FIELD_UNITS: Record<FieldKind, { unit: string; scale: number }> = {
  strain:     { unit: '—',   scale: 1 },
  strainRate: { unit: '1/s', scale: 1 },
  flowStress: { unit: 'MPa', scale: 1e-6 },
  temperature: { unit: '°C', scale: 1 },
  pressure:   { unit: 'MPa', scale: 1e-6 },
  speed:      { unit: 'm/s', scale: 1 },
  shear:      { unit: 'MPa', scale: 1e-6 },
  vonMises:   { unit: 'MPa', scale: 1e-6 },
  rollDisp:   { unit: 'µm',  scale: 1e6 },
  rollRadial: { unit: 'µm',  scale: 1e6 },
};
export function fieldUnit(k: FieldKind) { return FIELD_UNITS[k]; }

export class RollingSim {
  params: RollingParams;
  roll!: RollMesh;
  flow!: FlowSolver;

  /* roll elastic problem (constant stiffness, hub clamped) */
  /**
   * Only the geometry, never the stiffness: the 64-double element matrices are
   * consumed by assembly and dropped there, so on a fine mesh across eight
   * stands they are not carried for the life of the run.
   */
  private rollElem!: ElementGeometry;
  private rollPat!: CsrPattern;
  private rollWs!: PcgWorkspace;
  private rollPre!: BandPreconditioner;
  private rollVals!: Float64Array;
  private rollFree!: Uint8Array;
  private rollF!: Float64Array;
  private rollU!: Float64Array;
  /** relaxed elastic displacement of the roll nodes, exposed for rendering */
  rollUrel!: Float64Array;
  private rollTmp!: Float64Array;

  /** deformed roll surface y at each strip column, updated by the coupling */
  private gapY!: Float64Array;
  /** fraction of each column's tributary that lies inside the contact arc */
  private contactW!: Float64Array;
  /** low-passed, unclamped barrel height at each strip column [m] */
  private barrelY!: Float64Array;
  /** exact x where the barrel first interferes with the incoming strip [m] */
  biteEntryX = 0;
  /**
   * The condition of the strip arriving at this stand.
   *
   * Owned by the chain, not by this solve: on a tandem line stand k receives
   * what stand k-1 delivered, work-hardened and warm, and on a reverse mill
   * each pass receives what the pass before it left. Only the first element of
   * the chain sees virgin material. Held here rather than in `params` because
   * `Mill.sync` assigns the shared parameter block wholesale and would clobber
   * anything the chain had written into it.
   *
   * Getting this wrong is not a rounding error: cold rolling to 25 % takes kf
   * from 371 to 869 MPa, so a downstream stand fed virgin material is being
   * asked for less than half the resistance it really meets.
   */
  entryStrain = 0;
  entryTemp = 20;
  /** equivalent plastic strain and flow stress at strip nodes */
  strain!: Float64Array;
  /** strip temperature at the same nodes [degC]; entry temperature everywhere
   *  when the heating model is off, so the field view stays meaningful */
  temp!: Float64Array;
  sigmaF!: Float64Array;
  private strainRateNode!: Float64Array;
  private accR!: Float64Array;
  private wR!: Float64Array;
  private accS!: Float64Array;
  private wS!: Float64Array;
  private rateW!: Float64Array;

  /** per node scalar for rendering: roll nodes then strip nodes */
  nodeField!: Float32Array;

  /** analysis window actually in use [m] (auto-fitted when autoFit is on) */
  winIn = 0;
  winOut = 0;
  /** circumferential grading actually in use */
  biteGradeEff = 0;
  /** refined barrel surface layer actually in use [m] */
  skinThicknessEff = 0;
  /** radial size of the outermost barrel element [m] */
  skinElementSize = 0;

  cy = 0;
  /** accumulated barrel rotation, for the surface markings */
  phase = 0;
  time = 0;
  private vIn = 0;
  /**
   * The barrel speed `vIn` was seeded or last rescaled for [rad/s].
   *
   * The kinematics of the bite are speed-invariant in a rate-independent
   * material: double the barrel speed and the balanced entry speed doubles.
   * So when ω moves - the speed cone re-pitching a downstream stand as the
   * one ahead converges, or the roll-speed dial - the feed speed is scaled
   * by the same ratio instead of being left for the feed loop to crawl to.
   *
   * Measured before this, on a three-stand line under 圧下率一定: the cone
   * put #2's barrel 32 % above its seed on the first frame, the feed loop
   * closed that at 0.5 % per update, and for 16 s the feed reaction sat at
   * 60 % of μP with the gap loop gated behind it. #3 waited on #2 the same
   * way. The line looked as if each stand refused to start until the one
   * ahead had finished; it was the feed loop chasing a barrel speed it could
   * have been handed.
   */
  private vInOmega = 0;
  private contactFrom = 0;
  private contactTo = 0;
  /**
   * The column the mesh keeps on the bite entry, the one it keeps on the exit
   * plane x = 0, and where the entry currently is [m] - see `fitColumns`.
   */
  private fitIE = 0;
  private fitIX = 0;
  private xEntryFit = 0;
  /** the layout was just laid: put the entry on the crossing at once */
  private entrySnap = true;
  /** frames until the mesh entry may be corrected again - see ENTRY_HOLDOFF */
  private entryHoldOff = 0;
  /**
   * Divergence recovery. A solve that has gone to NaN never comes back on
   * its own - every later frame is NaN of NaN - and used to sit there as a
   * blank readout until something rebuilt the stand. Now the stand restarts
   * itself from its initial state, says so, and gives up only after
   * DIVERGE_LIMIT restarts inside DIVERGE_WINDOW: a pass that diverges that
   * often is not going to be rescued by starting over, and needs its
   * conditions changed.
   */
  /** how many times this stand has restarted after a NaN solve */
  restarts = 0;
  /** when it last did, performance.now() [ms]; -Infinity if never */
  restartAt = -Infinity;
  /** restarts have been exhausted and the stand is left as it is */
  divergedGiveUp = false;
  private restartLog: number[] = [];
  /** debug: hold the mesh entry at this x [m] instead of following the barrel; 0 = follow */
  entryPin = 0;
  /** debug: entry node on the bisector (true) or radial like every other contact node */
  entryBisector = true;
  /** the entry the stations were last laid for [m], to know when they moved */
  private xEntryLaid = NaN;
  /** debug: where the relaxed barrel crosses h0/2 this frame [m], pinned or not */
  entryCross = 0;
  private rollTick = 0;
  /** exit half thickness of the previous frame, for the oscillation detector */
  private lastExitHalf = 0;
  private lastGapDelta = 0;
  /** adaptive multiplier on rollRelax, cut when the coupling starts hunting */
  private relaxScale = 1;
  /** the barrel carries a flattening displacement that has not been relaxed away */
  private rollDeformed = false;
  /** low-passed thickness strain recovered on leaving the roll */
  private springbackFilt = 0;
  /** low-passed feed reaction, and the multi-rate tick for the speed loop */
  private reactFilt = 0;
  private reactSeen = false;
  private feedTick = 0;
  /**
   * Best feed residual seen lately.
   *
   * The reaction never stops moving: the flattening loop and the gap keep
   * nudging it, and measurement lands on a floor of a few times 1e-3 whatever
   * the controller does. Waiting for a fixed deadband below that floor means
   * waiting forever, which is what left stands sitting in "inner loop wait".
   * The floor is allowed to creep back up so it tracks a changing condition
   * rather than pinning itself to one lucky sample.
   */
  private feedFloor = 0;
  /** inside its deadband, and holding there until the residual clears the gate - see `updateFeedSpeed` */
  private feedHeld = false;
  /**
   * Hold the screws where they are, set from outside.
   *
   * On a tandem line a stand's entry gauge is the stand in front of it, and
   * while that is still moving there is nothing steady to control against -
   * the same reason the gap loop waits for the stand and the feed loop. The
   * chain converges far faster held this way than with every stand chasing a
   * target that its neighbour keeps moving.
   */
  holdGap = false;
  /** commanded, unloaded roll gap [m]: where the screws are */
  private gap = 0;
  /** the loaded separation the loop has asked for; `gap` follows it through the actuator */
  private gapCmd = 0;
  /** frames since the last reset; the actuator only engages once the pass is threaded */
  private screwWarm = 0;
  /** low-passed housing stretch under load [m]; 0 with a rigid stand */
  private stretch = 0;

  /** loaded barrel separation the mesh is currently built around [m] */
  private placedSep = 0;
  /** gap loop: low-passed measurement, secant memory, multi-rate tick */
  private agcTick = 0;
  private agcFilt = 0;
  private agcSeen = false;
  private agcSens = 0;
  private agcPrevGap = 0;
  private agcPrevMeas = 0;
  /** load and exit gauge at the last revision, for `agcPlasticSlope` */
  private agcPrevP = 0;
  private agcPrevH1 = 0;
  private agcQ = 0;
  private agcHavePrev = false;
  /** settled, with the release band applied - see AGC_RELEASE */
  private agcHeld = false;
  /** screw revisions since this convergence began - see `agcIterations` */
  private agcIters = 0;
  /*
   * Bracket and per-method state for the gap search.
   *
   * Everything below works on `g(S)`, defined so that it *increases* with the
   * screw gap whatever is being held: g = (measured - target) under gauge
   * control, and its negative under load control, since closing the gap raises
   * the load. One sign flip at the top and every method downstream sees the
   * same monotone increasing function, with its root where g = 0.
   */
  /** lower end of the bracket: the largest gap known to give g < 0 */
  private agcLo = NaN;
  private agcGlo = NaN;
  /** upper end: the smallest gap known to give g > 0 */
  private agcHi = NaN;
  private agcGhi = NaN;
  /** step used while hunting for the missing end, as a fraction of h0 */
  private agcHunt = 0;
  /** entry gauge the bracket was formed at; it goes stale when that moves */
  private agcBrH0 = 0;
  /** Illinois: which end the last update retained, so a stall can be detected */
  private agcSide = 0;
  /** Ridders: the midpoint probe and which half of the evaluation pair we are in */
  private agcRidM = NaN;
  private agcRidPhase = 0;
  /** finite-difference Newton: the probe pair, and which half we are in */
  private agcNwPhase = 0;
  private agcNwGap = NaN;
  private agcNwErr = NaN;
  /** Brent: its own triple, which is not ordered the way the bracket is */
  private brA = NaN; private brFa = NaN;
  private brB = NaN; private brFb = NaN;
  private brC = NaN; private brFc = NaN;
  private brD = 0; private brE = 0;
  private brReady = false;


  diag: RollingDiagnostics = emptyDiag();

  lastStepMs = 0;
  lastFlowMs = 0;
  lastRollMs = 0;
  lastStrainMs = 0;

  constructor(p: RollingParams) {
    this.params = { ...p };
    this.rebuild();
  }

  /**
   * The unloaded roll gap currently set. With the screws fixed that is the
   * commanded h0*(1-r); under gap control it is wherever the loop has driven
   * them, which is *not* the gauge that leaves the mill - see `exitThickness`.
   */
  get h1(): number { return this.screwPosition; }
  /**
   * The gauge the *reduction command* implies [m].
   *
   * Not the same thing as the loop's setpoint - see `agcSetpoint`. This one is
   * where the screws sit with the loop off, and it is the nominal scale that
   * the analysis window, the seed feed speed and the strain-rate regulariser
   * are all written against, so it stays tied to the reduction even when the
   * loop is holding an absolute gauge instead.
   */
  get h1Command(): number { return this.params.h0 * (1 - this.params.reduction); }
  /**
   * The exit thickness the gauge loop is driving towards [m].
   *
   * Clamped into the range the stand can physically reach: a target above the
   * entry gauge is not rolling at all, and one at the floor asks the screws
   * for travel the rails will not give. A target outside that band is an
   * operator error, and the honest response is to hold the nearest gauge that
   * exists and let `agcSaturated` say so, rather than to chase a number the
   * mill cannot make.
   */
  get agcSetpoint(): number {
    const p = this.params;
    if (p.agcMode !== 'gauge') return this.h1Command;
    const want = Number.isFinite(p.agcTargetGauge) ? p.agcTargetGauge : this.h1Command;
    return Math.max(0.05 * p.h0, Math.min(0.995 * p.h0, want));
  }

  /**
   * The absolute gauge target asks for no rolling at all.
   *
   * A stand cannot make the strip thicker, so a target at or above the entry
   * gauge is not a pass. On a tandem line the entry gauge is the stand in
   * front's *current* exit, so this happens live: hold the last stand at
   * 1.5 mm, back the stands ahead of it off until they deliver 1.5 mm
   * themselves, and the last stand is being asked to roll a strip that has
   * already arrived at size. The loop's response would be to open the screws
   * until the bite empties and report the residue of a solve with nothing in
   * it; better to say the pass is idle and hold the stand - `Mill.advance`
   * parks it.
   *
   * That is the whole test: the raw target against the live entry gauge.
   * Two cleverer floors were tried and both were wrong. Entry minus the mill
   * spring last measured parked every skin pass on the line, because the
   * spring it subtracted was the heavy pass's, not the light one's. Entry
   * minus the lightest draft the mesh can resolve (three columns of arc, a
   * few microns) let targets through that the loop then could not reach -
   * the real numerical floor is nearer five columns, and it moves with the
   * mesh, the roll and the gauge. A target below the entry that is too light
   * to resolve is a *rail* problem, and the gap loop already reports those as
   * saturated; it is not a reason to park.
   *
   * Raw target, not the clamped setpoint: the setpoint is pulled down to
   * 0.995 h0, and a 1.6 mm target on a 1.5 mm entry would otherwise turn into
   * a 0.5 % pass and be rolled.
   */
  get gaugeIdle(): boolean {
    const p = this.params;
    if (p.agcMode !== 'gauge') return false;
    const want = Number.isFinite(p.agcTargetGauge) ? p.agcTargetGauge : this.h1Command;
    return want >= this.gaugeFloor;
  }

  /** The gauge a target must stay below to be a pass [m]: the live entry gauge. */
  get gaugeFloor(): number { return this.params.h0; }

  /** The deadband the gap loop is actually working to - see MESH_QUANTUM. */
  get agcBand(): number {
    const p = this.params;
    return p.agcMode === 'force' && p.loadModel !== 'slab'
      ? Math.max(p.agcDeadband, MESH_QUANTUM) : p.agcDeadband;
  }

  /**
   * The contact set as the flow solve sees it: which columns, how much of
   * each, where the entry sits. Debug only.
   */
  get contactSpan(): { from: number; to: number; xEntry: number; xs: number[]; w: number[]; top: number[] } {
    const m = this.flow.mesh;
    const from = this.contactFrom, to = this.contactTo;
    const xs: number[] = [], w: number[] = [], top: number[] = [];
    for (let i = Math.max(0, from - 1); i <= Math.min(m.nx, to + 1); i++) {
      xs.push(m.xs[i]); w.push(this.contactW[i]); top.push(m.X[2 * m.topNodes[i] + 1]);
    }
    return { from, to, xEntry: this.biteEntryX, xs, w, top };
  }
  /*
   * Note on `h1Command` below: several nominal-scale estimates - the contact
   * arc used to size the window, the seed feed speed, the strain-rate
   * regulariser - are written against the *commanded* gauge, and must stay
   * that way. They were, back when the screw position and the command were the
   * same number. They are not any more: under gap control the screws move, and
   * with a stretching stand they can legitimately sit at or below zero, where
   * `log(h0 / S)` takes the whole solve out with it.
   */
  get stripOff(): number { return this.roll.nn; }
  get dofCount(): number { return this.flow.pattern.n + this.rollPat.n; }
  get nominalArc(): number {
    return Math.sqrt(this.params.R * (this.params.h0 - this.h1Command));
  }

  memoryBytes(): number {
    const m = this.memorySplit();
    return m.flow + m.roll + m.field;
  }

  /**
   * Where this stand's memory actually goes.
   *
   * Split three ways because they scale on different dials: the flow block on
   * the strip mesh, the roll block on the barrel mesh (and much harder - the
   * elastic stiffness and its band preconditioner are the largest arrays in
   * the app), and the field block on the two together. Told apart, the mesh
   * panel's numbers stop being a single figure that only ever goes up.
   */
  memorySplit(): { flow: number; roll: number; field: number } {
    let roll = this.rollPre.byteLength()
      + patternBytes(this.rollPat) + workspaceBytes(this.rollWs);
    for (const a of [this.rollVals, this.rollF, this.rollU, this.rollUrel, this.rollTmp,
      this.rollFree, this.rollElem.dN, this.rollElem.area,
      this.roll.X, this.roll.quads, this.roll.tris, this.roll.edges,
      this.gapY, this.contactW, this.barrelY]) roll += a.byteLength;
    let field = 0;
    for (const a of [this.strain, this.temp, this.sigmaF, this.nodeField,
      this.strainRateNode, this.accR, this.wR, this.accS, this.wS,
      this.rateW]) field += a.byteLength;
    return { flow: this.flow.byteLength(), roll, field };
  }

  /**
   * Choose a window and a circumferential grading that resolve the bite.
   *
   * Upstream needs a rigid run-in of a couple of arc lengths (or a few
   * thicknesses, whichever is longer) for the entry boundary condition to stop
   * mattering; downstream only needs enough to let the exit velocity profile
   * even out. The grading is set so the barrel carries roughly 40 nodes across
   * the arc whatever the radius.
   */
  private fitToArc(): void {
    const p = this.params;
    if (!p.autoFit) {
      this.winIn = p.windowIn;
      this.winOut = p.windowOut;
      this.biteGradeEff = p.biteGrade;
      return;
    }
    const Lc = Math.max(this.nominalArc, 1e-9);
    this.winIn = -(Lc + Math.max(3 * p.h0, 2 * Lc));
    this.winOut = Math.max(2 * p.h0, 1.5 * Lc);
    const target = Lc / 40;
    const uniform = (2 * Math.PI * p.R) / p.rollNt;
    this.biteGradeEff = Math.max(0, Math.min(0.99, 1 - target / uniform));
  }

  /** Refined-layer thickness, sized from the contact arc when auto. */
  private fitSkin(): void {
    const p = this.params;
    const wall = p.R * (1 - p.hubRatio);
    // Keep at least three rings for the core: the barrel's flattening is
    // dominated by the wall compressing back to the hub, and starving that of
    // elements costs more accuracy than the refined skin buys.
    const rings = Math.max(0, Math.min(Math.max(1, p.rollNr - 3), Math.round(p.rollSkinRings)));
    // Element size the plain power law would put at the barrel surface. The
    // outermost element of r = Rhub + wall*(1-(1-j/nr)^g) is wall*(1/nr)^g.
    const hGraded = wall * Math.pow(1 / p.rollNr, p.rollRadialGrade);

    if (rings < 1) {
      this.skinThicknessEff = 0;
      this.skinElementSize = hGraded;
      return;
    }
    // Auto mode targets an element size, not a layer thickness: the sub-surface
    // stress decays over the contact length, so what matters is how many
    // elements sit inside that depth. Thickness then follows from the ring
    // count, capped so the layer cannot eat the whole wall.
    const raw = p.rollSkinAuto
      ? rings * (Math.max(this.nominalArc, 1e-9) / Math.max(p.rollSkinFactor, 1))
      : p.rollSkinThickness;
    this.skinThicknessEff = Math.max(0, Math.min(raw, wall * 0.5));
    this.skinElementSize = this.skinThicknessEff > 0
      ? this.skinThicknessEff / rings
      : hGraded;
  }

  rebuild(): void {
    const p = this.params;
    this.forgiveDivergence();
    this.gap = this.h1Command;
    this.stretch = 0;
    this.placedSep = this.gap;
    this.cy = this.gap / 2 + p.R;
    this.fitToArc();
    this.fitSkin();
    this.roll = buildRollMesh({
      R: p.R, Rhub: p.R * p.hubRatio, nt: p.rollNt, nr: p.rollNr,
      radialGrade: p.rollRadialGrade, biteGrade: this.biteGradeEff, cx: 0, cy: this.cy,
      skinThickness: this.skinThicknessEff,
      skinRings: p.rollSkinRings,
    });
    this.rollPat = buildCsrPattern(this.roll.nn, this.roll.quads);
    this.rollWs = makePcgWorkspace(this.rollPat.n);
    this.rollPre = new BandPreconditioner(this.rollPat.n, 2 * (this.roll.rows + 1) + 1);
    this.rollVals = new Float64Array(this.rollPat.nnz);
    this.rollElem = assembleStiffness(
      precomputeElements(this.roll.X, this.roll.quads,
        { E: p.Eroll, nu: p.nuRoll, rho: 7850 }),
      this.rollPat.scatter, this.rollVals);
    this.rollFree = new Uint8Array(this.rollPat.n).fill(1);
    for (const nd of this.roll.hubNodes) {
      this.rollFree[2 * nd] = 0;
      this.rollFree[2 * nd + 1] = 0;
    }
    this.rollPre.factor(this.rollPat, this.rollVals, this.rollFree);
    this.rollF = new Float64Array(this.rollPat.n);
    this.rollU = new Float64Array(this.rollPat.n);
    this.rollUrel = new Float64Array(this.rollPat.n);
    this.rollTmp = new Float64Array(this.rollPat.n);

    this.flow = new FlowSolver(p.stripNx, p.stripNy);
    this.gapY = new Float64Array(p.stripNx + 1);
    this.contactW = new Float64Array(p.stripNx + 1);
    this.barrelY = new Float64Array(p.stripNx + 1);
    this.strain = new Float64Array(this.flow.mesh.nn);
    this.temp = new Float64Array(this.flow.mesh.nn);
    this.sigmaF = new Float64Array(this.flow.mesh.nn);
    this.strainRateNode = new Float64Array(this.flow.mesh.nn);
    this.nodeField = new Float32Array(this.roll.nn + this.flow.mesh.nn);
    this.accR = new Float64Array(this.roll.nn);
    this.wR = new Float64Array(this.roll.nn);
    this.accS = new Float64Array(this.flow.mesh.nn);
    this.wS = new Float64Array(this.flow.mesh.nn);
    this.rateW = new Float64Array(this.flow.mesh.nn);

    this.resetState();
  }

  /** Rebuild only what a material change touches. */
  refreshMaterial(): void {
    const p = this.params;
    this.rollElem = assembleStiffness(
      precomputeElements(this.roll.X, this.roll.quads,
        { E: p.Eroll, nu: p.nuRoll, rho: 7850 }),
      this.rollPat.scatter, this.rollVals);
    this.rollPre.factor(this.rollPat, this.rollVals, this.rollFree);
  }

  resetState(): void {
    const p = this.params;
    this.time = 0;
    this.phase = 0;
    this.stretch = 0;
    this.screwWarm = 0;
    this.releaseGap();
    this.snapScrew();
    this.rollU.fill(0);
    this.rollUrel.fill(0);
    this.rollDeformed = false;
    this.gapY.fill(0);
    this.barrelY.fill(0);
    this.lastExitHalf = 0;
    this.lastGapDelta = 0;
    this.relaxScale = 1;
    this.springbackFilt = 0;
    this.fitColumns();
    this.reactFilt = 0;
    this.reactSeen = false;
    this.feedTick = 0;
    this.feedFloor = 0;
    this.feedHeld = false;
    this.strain.fill(this.entryStrain);
    this.temp.fill(this.entryTemp);
    this.flow.ifPressure.fill(0);
    this.flow.ifShear.fill(0);
    this.vIn = p.feedSpeed > 0 ? p.feedSpeed : (p.omega * p.R * this.h1Command) / p.h0;
    this.vInOmega = p.omega;
    this.updateGap();
    for (let i = 0; i < this.sigmaF.length; i++) {
      this.sigmaF[i] = uniaxial(p, this.entryStrain, this.entryTemp);
    }
    this.flow.seed(this.vIn, p.h0 / 2);
    this.diag = emptyDiag();
  }

  /**
   * Choose which columns sit on the bite entry and on the exit plane.
   *
   * The strip mesh is not uniform in x: it is laid out every frame with one
   * column exactly on the bite entry and one exactly on x = 0, and the
   * columns between them stretched to fit (see `updateGap`). This picks the
   * two indices from the nominal arc, so that the elements inside the bite
   * start out the same size as the ones either side of it, and it is called
   * again whenever the bite has grown or shrunk by ARC_REFIT relative to
   * that - a load-control target far from the reduction the mesh was built
   * for, say. Between re-fits the layout is a continuous function of the
   * entry position, and that is the whole point: the contact set is the
   * columns between the two, fixed, and no column ever enters or leaves it.
   *
   * Why it has to be this way. The contact condition is binary per column,
   * and on a uniform mesh the entry sits wherever the flattened barrel
   * crosses h0/2 - generally inside a column. Whenever that landed near a
   * column boundary the solve rang on its own with every control loop off:
   * the column enters, the load rises, the barrel flattens back above h0/2
   * there, the column leaves (853 <-> 944 tonf at 100x8, 19 <-> 20 columns,
   * forever). Refinement moved the boundaries without removing them (the
   * same 200x14 mesh was quiet at one gap and rang +-3.5 % at another), and
   * two attempts to make the assembly continuous in the entry position -
   * friction weighted by coverage, constraint normal blended toward the free
   * surface - each broke a validated number instead. Under load control the
   * target routinely sits inside one of those +-5 % steps, and there the loop
   * cannot converge at all: a three-stand line at 1040 tonf hunted +-3.5 %
   * with every stand reporting itself stalled behind its feed loop. Moving
   * the columns is the one fix that leaves the assembly alone.
   */
  private fitColumns(): void {
    const m = this.flow.mesh;
    const dx0 = (this.winOut - this.winIn) / m.nx;
    // The exit plane on a column, and at least a couple of columns of
    // run-out after it for the springback ramp to live on.
    this.fitIX = Math.max(4, Math.min(m.nx - 2, Math.round(-this.winIn / dx0)));
    const arc = this.xEntryFit < 0 && Number.isFinite(this.xEntryFit)
      ? -this.xEntryFit : Math.max(this.nominalArc, dx0);
    const nArc = Math.max(2, Math.min(this.fitIX - 2, Math.round(arc / dx0)));
    this.fitIE = this.fitIX - nArc;
    this.xEntryFit = -Math.min(arc, -0.8 * this.winIn);
    this.entrySnap = true;
    this.entryHoldOff = 0;
    this.xEntryLaid = NaN;
    // A fresh layout means fresh stations, and a low-passed barrel height
    // carried over from the old ones would put the bite where it used to be.
    this.barrelY.fill(0);
  }

  /** Column station i for a bite entry at xE: piecewise linear in i, linear in xE. */
  private stationAt(i: number, xE: number): number {
    const m = this.flow.mesh;
    const iE = this.fitIE, iX = this.fitIX;
    if (i <= iE) return this.winIn + (xE - this.winIn) * (i / Math.max(iE, 1));
    if (i <= iX) return xE * ((iX - i) / Math.max(iX - iE, 1));
    return this.winOut * ((i - iX) / Math.max(m.nx - iX, 1));
  }

  /**
   * Lay the strip mesh into the current roll gap. Upstream of the bite the
   * surface is flat at h0/2, through the bite it follows the (possibly
   * flattened) barrel, and downstream it holds the exit thickness - a
   * rigid-plastic body has no elastic recovery to spring back with.
   */
  private updateGap(): void {
    const p = this.params;
    const m = this.flow.mesh;
    const half0 = p.h0 / 2;

    // deformed barrel profile near the bite, as a function of x
    const surfX: number[] = [];
    const surfY: number[] = [];
    for (let k = 0; k < this.roll.nt; k++) {
      const nd = this.roll.surfNodes[k];
      const bx = this.roll.X[2 * nd] + this.rollUrel[2 * nd];
      const by = this.roll.X[2 * nd + 1] + this.rollUrel[2 * nd + 1];
      if (by > this.cy) continue;               // lower half of the barrel only
      surfX.push(bx); surfY.push(by);
    }
    const order = surfX.map((_, i) => i).sort((a2, b2) => surfX[a2] - surfX[b2]);
    const sx = order.map((i) => surfX[i]);
    const sy = order.map((i) => surfY[i]);
    const FAR = half0 * 1e3;
    const barrelAt = (x: number): number => {
      if (sx.length < 2 || x <= sx[0] || x >= sx[sx.length - 1]) return FAR;
      let lo = 0, hi = sx.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (sx[mid] <= x) lo = mid; else hi = mid;
      }
      const f = (x - sx[lo]) / Math.max(sx[hi] - sx[lo], 1e-15);
      return sy[lo] + f * (sy[hi] - sy[lo]);
    };

    const dx0 = (this.winOut - this.winIn) / m.nx;

    // Where the barrel crosses h0/2, on the relaxed roll displacement the
    // rest of this frame is meshed against - so the mesh laid below is
    // consistent with the barrel it is laid into, this frame, not the frame
    // before. (The barrel height used to be low-passed once more per column
    // here. On columns that move that is a filter with a memory of a
    // different place, and it was one lag too many: with it, an entry that
    // followed the crossing frame by frame rang; see ENTRY_CATCH_UP.)
    //
    // The bite is closed when the barrel bottom, at x = 0, is under the
    // incoming surface; the entry is then the crossing found by bisection
    // between the upstream edge of the window, where the barrel is far
    // above the strip, and the exit plane.
    const touching = barrelAt(0) < half0 - 1e-12;
    if (touching) {
      let lo = this.winIn, hi = 0;
      for (let k = 0; k < 48; k++) {
        const mid = 0.5 * (lo + hi);
        if (barrelAt(mid) > half0) lo = mid; else hi = mid;
      }
      const xNew = Math.max(0.8 * this.winIn, Math.min(-0.25 * dx0, 0.5 * (lo + hi)));
      this.entryCross = xNew;
      if (this.entrySnap) {
        this.xEntryFit = xNew;
        this.entrySnap = false;
      } else {
        const res = xNew - this.xEntryFit;
        if (this.entryHoldOff > 0) this.entryHoldOff--;
        if (Math.abs(res) > ENTRY_CATCH_BAND * dx0) {
          const cap = ENTRY_CATCH_UP * dx0;
          this.xEntryFit += Math.max(-cap, Math.min(cap, res));
          this.entryHoldOff = ENTRY_HOLDOFF;
        } else if (this.entryHoldOff === 0 && Math.abs(res) > ENTRY_MIN * dx0) {
          const p = this.params;
          const quiet = (p.feedSpeed > 0 || this.feedHeld)
            && (p.agcMode === 'off' || this.agcHeld || this.diag.agcIdle);
          if (quiet) {
            this.xEntryFit = xNew;
            this.entryHoldOff = ENTRY_HOLDOFF;
          }
        }
      }
      if (this.entryPin !== 0) this.xEntryFit = this.entryPin;
      this.diag.meshResidual = Math.abs(this.entryCross - this.xEntryFit) / dx0;
      // The bite has outgrown, or shrunk out of, the columns it was given.
      // Re-fit - a discrete change of layout, so it is made rarely and only
      // ever from far away from its own threshold.
      const stretch = -this.xEntryFit / ((this.fitIX - this.fitIE) * dx0);
      if (stretch > ARC_REFIT || stretch < 1 / ARC_REFIT) this.fitColumns();
    } else {
      this.diag.meshResidual = 0;
    }
    const iE = this.fitIE, iX = this.fitIX;

    // Pass 1: the column stations for this frame's bite entry, and the
    // low-passed barrel height at each.
    //
    // Low-passed, on top of the relaxation the roll displacement already
    // carries: this second filter is the damping of the flattening loop.
    // With it removed the strip surface followed the relaxed barrel one
    // frame behind the load, and with the elastic overlay off - where the
    // volumetric penalty is twenty times stiffer and the load that much
    // sharper in the gap - the loop load -> flattening -> gap -> load rang
    // between 450 and 4500 tonf without end (`couplingResidual` 0 <-> 1.2e-2,
    // the adaptive damping firing every reversal). The columns move only at
    // the events in `ENTRY_CATCH_UP`'s comment now, so a per-column memory
    // is sound again; when they do move, the memory is carried to the new
    // stations by interpolation rather than dropped.
    const relax = this.params.rollRelax * this.relaxScale;
    const xE = this.xEntryFit;
    if (xE !== this.xEntryLaid) {
      if (Number.isFinite(this.xEntryLaid)) {
        const oldX = Float64Array.from(m.xs), oldB = Float64Array.from(this.barrelY);
        for (let i = 0; i <= m.nx; i++) {
          const x = this.stationAt(i, xE);
          // the old station interval holding x, and the height there
          let lo = 0, hi = m.nx;
          if (x <= oldX[0] || x >= oldX[m.nx] || oldB[0] === 0) { this.barrelY[i] = 0; continue; }
          while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (oldX[mid] <= x) lo = mid; else hi = mid; }
          const f = (x - oldX[lo]) / Math.max(oldX[hi] - oldX[lo], 1e-30);
          this.barrelY[i] = oldB[lo] !== 0 && oldB[hi] !== 0 ? oldB[lo] + f * (oldB[hi] - oldB[lo]) : 0;
        }
      }
      this.xEntryLaid = xE;
    }
    for (let i = 0; i <= m.nx; i++) {
      const x = this.stationAt(i, xE);
      m.xs[i] = x;
      const raw = barrelAt(x);
      const prev = this.barrelY[i];
      this.barrelY[i] = prev !== 0 ? prev + relax * (raw - prev) : raw;
    }

    // Pass 2: the strip surface follows the barrel through the bite and then
    // holds the exit thickness - a rigid-plastic body has no elastic recovery
    // to spring back with. The channel has to close monotonically: a flattened
    // barrel can rise again before the exit plane, and a gap that reopens would
    // ask an incompressible material to expand.
    let running = half0;
    for (let i = 0; i <= iX; i++) {
      const b = this.barrelY[i];
      running = Math.min(running, Math.min(half0, b));
      this.gapY[i] = running;
    }
    const exitHalf = this.gapY[iX];
    // Downstream the strip springs back: the contact pressure is gone but the
    // elastic thickness strain it caused is not, so the gauge leaving the
    // mill is thicker than the roll gap. The recovery is spread over a
    // distance of order the thickness rather than applied as a step.
    const rec = Math.max(exitHalf * 2, this.winOut / Math.max(m.nx - iX, 1));
    for (let i = iX + 1; i <= m.nx; i++) {
      const t = Math.min(1, m.xs[i] / rec);
      this.gapY[i] = exitHalf * (1 + this.springbackFilt * t);
    }
    for (let i = 0; i <= m.nx; i++) {
      const x = m.xs[i], top = this.gapY[i];
      for (let j = 0; j < m.rows; j++) {
        const nd = i * m.rows + j;
        m.X[2 * nd] = x;
        m.X[2 * nd + 1] = (top * j) / m.ny;
      }
    }

    // The contact set is the columns between the two fitted ones. Nothing
    // interferes when the bite is open: the indices still have to point
    // somewhere, but the coverage below must not - clamping them to column 0
    // and then giving that column full weight puts a contact at the upstream
    // boundary against a barrel a thousand thicknesses away, and the penalty
    // force that implies is what turns the whole solve into NaN. The entry
    // column is in the set with half its tributary on the roll; how its
    // constraint is oriented is the flow solver's business (see
    // `applyInterface`). Leaving it out was measured too: quiet, but the
    // first half column of arc then carries no friction and the load reads
    // 5 % low per column of entry left free.
    if (touching) { this.contactFrom = iE; this.contactTo = iX; }
    else { this.contactFrom = 0; this.contactTo = 0; }
    this.biteEntryX = touching ? xE : m.xs[0];

    // Fraction of each column's tributary that sits inside [xEntry, 0]. With
    // the entry and exit columns on the arc ends this is 1 inside and one
    // half at either end - the load integral's trapezoid rule, in effect -
    // and it changes continuously as the ends move.
    this.contactW.fill(0);
    if (touching) {
      for (let i = this.contactFrom; i <= this.contactTo; i++) {
        const a2 = i > 0 ? 0.5 * (m.xs[i - 1] + m.xs[i]) : m.xs[i];
        const b2 = i < m.nx ? 0.5 * (m.xs[i] + m.xs[i + 1]) : m.xs[i];
        const lo = Math.max(a2, this.biteEntryX), hi = Math.min(b2, 0);
        this.contactW[i] = Math.max(0, Math.min(1, (hi - lo) / Math.max(b2 - a2, 1e-30)));
      }
    }

    const delta = exitHalf - this.lastExitHalf;
    if (this.lastExitHalf > 0) {
      if (delta * this.lastGapDelta < 0) {
        this.relaxScale = Math.max(0.08, this.relaxScale * 0.55);
      } else {
        this.relaxScale = Math.min(1, this.relaxScale * 1.03);
      }
      this.diag.couplingResidual = Math.abs(delta) / Math.max(exitHalf, 1e-15);
      this.diag.relaxScale = this.relaxScale;
    }
    this.lastGapDelta = delta;
    this.lastExitHalf = exitHalf;
  }

  /** Advance one frame: flow solve, strain transport, roll coupling. */
  /**
   * Hold a stand that has nothing to roll.
   *
   * Not the same as pausing: the strip is still moving, it simply leaves at
   * the gauge it arrived at. So the diagnostics are written as a pass-through
   * - no load, no torque, exit equal to entry - rather than left as whatever
   * the last real solve produced, which would report a load for a stand that
   * is not touching the strip.
   *
   * The velocity field, the strain and the flattening are all left untouched,
   * so re-entering the schedule costs nothing: lower the target back below the
   * entry gauge and the stand resumes from where it was, rather than
   * re-converging from a seed.
   */
  passThrough(): void {
    const d = this.diag;
    const p = this.params;
    d.agcIdle = true;
    d.agcSettled = true;
    d.agcStalled = false;
    d.agcSaturated = false;
    d.agcError = 0;
    d.exitThickness = p.h0;
    d.exitThicknessGap = p.h0;
    d.entryThickness = p.h0;
    d.rollForce = 0;
    d.torque = 0;
    d.power = 0;
    d.meanPressure = 0;
    d.peakPressure = 0;
    d.contactNodes = 0;
    d.arcLength = 0;
    d.reductionRatio = 1;
    d.millSpring = 0;
    d.exitSpeed = p.omega * p.R;
    d.entrySpeed = d.exitSpeed;
    d.agcMeasured = p.h0;
    this.lastStepMs = 0;
  }

  advance(frameDt: number): void {
    const t0 = performance.now();
    const p = this.params;
    this.time += frameDt;
    this.phase += p.omega * frameDt;

    const vRoll = p.omega * p.R;
    // Scale the viscosity regularisation off the *current* throughput, not the
    // roll speed. A rigid-plastic material is rate independent; tying the
    // regulariser to a speed the strip is not actually running at would make
    // the answer drift with the feed.
    const vThrough = (this.vIn * p.h0)
      / Math.max(this.diag.exitThickness || this.h1Command, 1e-9);
    const nominalRate = Math.max(
      (Math.max(vThrough, 1e-6) * Math.log(p.h0 / this.h1Command))
        / Math.max(this.nominalArc, 1e-6), 1e-4);
    void vRoll;

    // Transit time through the bite. Everything elastic is expressed as a
    // viscosity over this time: a point that spends t inside the roll can at
    // most respond with its elastic stiffness times t.
    const tRef = Math.max(this.nominalArc / Math.max(vThrough, 1e-6), 1e-6);
    const Gs = p.Estrip / (2 * (1 + p.nuStrip));
    const Ks = p.Estrip / (3 * (1 - 2 * p.nuStrip));
    const muRef = uniaxial(p, 0) / (3 * nominalRate);

    const inp: FlowInput = {
      sigmaF: this.sigmaF,
      vIn: this.vIn,
      vRoll: p.omega * p.R,
      rollCx: this.roll.cx,
      rollCy: this.cy,
      contactFrom: this.contactFrom,
      contactTo: this.contactTo,
      contactWeight: this.contactW,
      entryBisector: this.entryBisector,
      mu: p.mu,
      vSlip0: Math.max(p.slipFrac * Math.abs(vRoll), 1e-6),
      normalPenalty: p.normalPenalty,
      eps0: p.eps0Frac * nominalRate,
      muRef,
      muCap: p.elasticZones ? Gs * tRef : muRef * 150,
      kBulk: p.elasticZones ? Ks * tRef : p.incompPenalty * muRef,
      backTension: p.backTension,
      frontTension: p.frontTension,
      maxIter: p.cgIter,
      tol: p.cgTol,
    };

    const tf = performance.now();
    let res = { iterations: 0, residual: 0, picardDelta: 0 };
    for (let k = 0; k < Math.max(1, p.picardIters | 0); k++) {
      res = this.flow.solve(inp, p.relax);
    }
    this.lastFlowMs = performance.now() - tf;
    this.diag.cgIterations = res.iterations;
    this.diag.cgResidual = res.residual;
    this.diag.picardDelta = res.picardDelta;

    const ts = performance.now();
    this.transportStrain();
    this.lastStrainMs = performance.now() - ts;

    this.collectDiagnostics(inp);

    const tr = performance.now();
    if (p.rollCoupling && ++this.rollTick >= Math.max(1, p.rollEvery | 0)) {
      this.rollTick = 0;
      this.solveRoll();
    } else if (!p.rollCoupling && this.rollDeformed) {
      // The switch used to stop the roll solve and nothing else, which left
      // the barrel frozen in whatever flattened shape it last had: the load
      // read the same to the last digit with the coupling on or off, and the
      // rigid roll the switch promises never arrived. Let the displacement
      // relax back to zero at the coupling's own rate, so the barrel returns
      // to its ground circle as smoothly as it left it.
      const r = Math.max(0, Math.min(1, p.rollRelax));
      let peak = 0;
      for (let i = 0; i < this.rollUrel.length; i++) {
        this.rollUrel[i] *= 1 - r;
        peak = Math.max(peak, Math.abs(this.rollUrel[i]));
      }
      if (peak < 1e-12) {
        this.rollUrel.fill(0);
        this.rollU.fill(0);
        this.rollDeformed = false;
      }
    }
    // Which load the rest of the step believes, before anything reads it.
    this.applyLoadModel();
    // The stand gives first, then the screws move to answer it, and only then
    // is the strip re-laid into the gap the pair leaves behind.
    this.screwWarm++;
    this.updateMillStretch();
    this.updateAgc();
    this.moveScrew(frameDt);
    this.updateGap();
    this.lastRollMs = performance.now() - tr;

    if (p.feedSpeed > 0) {
      this.vIn = p.feedSpeed;
    } else {
      // Feed forward a barrel-speed change before the loop trims the rest.
      if (this.vInOmega > 0 && p.omega > 0 && p.omega !== this.vInOmega) {
        this.vIn *= p.omega / this.vInOmega;
      }
      this.updateFeedSpeed();
    }
    this.vInOmega = p.omega;

    this.lastStepMs = performance.now() - t0;
  }

  /**
   * Replace the FEM load by the slab estimate when that is the model selected.
   *
   * Runs after the diagnostics and before the stretch, gap and feed loops, so
   * every consumer of `rollForce` in this step sees the same number. The FEM
   * value is kept beside it as `loadFem` for the comparison rows.
   */
  private applyLoadModel(): void {
    const p = this.params;
    const d = this.diag;
    d.loadFem = d.rollForce;
    d.loadModel = 'fem';
    d.slabStatus = 'ok';
    d.forwardSlipSlab = NaN;
    d.neutralXSlab = NaN;
    d.arcLengthSlab = NaN;
    d.kfSlab = NaN;
    if (p.loadModel !== 'slab' || !slabHook) return;
    // The switch is the user's, and it is not undone here. This used to fall
    // back to the FEM load whenever the theory had no answer - no bite yet,
    // no draft, a pull past the yield, a flattening that ran away - and the
    // stand then showed a FEM load under a heading that said slab, with
    // nothing on screen to say so. Now the model stays the slab and the
    // status says why the number is what it is.
    d.loadModel = 'slab';
    const h1 = d.exitThickness;
    const c = {
      h0: p.h0, h1, R: p.R,
      backTension: p.backTension, frontTension: p.frontTension,
      entryStrain: this.entryStrain,
    };
    let pt: SlabPoint | null = null;
    if (!(h1 > 0) || !(h1 < p.h0)) d.slabStatus = 'geometry';
    else if (d.contactNodes === 0) d.slabStatus = 'nobite';
    else {
      pt = slabHook(p, c, p.mu);
      if (!(pt.kEff > 0)) { d.slabStatus = 'tension'; pt = null; }
      else if (!Number.isFinite(pt.load) || !(pt.load > 0)) {
        // Its own flattening has no fixed point: the theory at the radius
        // the FEM is actually rolling with, which always exists. Reported
        // as such - the number is the selected theory's, on a roll the
        // theory itself could not size.
        d.slabStatus = 'runaway';
        const at = slabHook(p, c, p.mu, d.hitchcockR > 0 ? d.hitchcockR : p.R);
        pt = Number.isFinite(at.load) && at.load > 0 ? at : null;
      }
    }
    if (!pt) {
      // No pass to speak of: no load, as the FEM would also report with the
      // strip out of the bite. The gap loop waits on a zero load.
      d.rollForce = 0;
      d.meanPressure = 0;
      d.torque = 0;
      d.power = 0;
      return;
    }
    d.rollForce = pt.load;
    d.meanPressure = pt.meanPressure;
    // Torque and power the way the slab method states them: the mean pressure
    // acting at the middle of the arc.
    // The theory's own friction torque where it has a distribution to take
    // it from; the Siebel form does not, and gets the mean pressure acting
    // at the middle of the arc.
    d.torque = Number.isFinite(pt.torque) ? -Math.abs(pt.torque)
      : -pt.meanPressure * pt.arc * pt.arc * 0.5;
    d.power = Math.abs(d.torque * p.omega);
    d.hitchcockR = pt.Rflat;
    d.forwardSlipSlab = pt.forwardSlip;
    d.neutralXSlab = pt.neutralX;
    d.arcLengthSlab = pt.arc;
    d.kfSlab = pt.kf;
    d.loadModel = 'slab';
  }

  /**
   * Has the solve gone to NaN, and if so, start over.
   *
   * Checked on the readouts everything else reads - the exit gauge, the
   * load, the mass balance - and on the velocity field itself, since the
   * gauge can survive a frame the flow has already lost. Returns true when
   * the stand was restarted this call.
   */
  recoverIfDiverged(now: number): boolean {
    const d = this.diag;
    const bad = !Number.isFinite(d.exitThickness) || !Number.isFinite(d.rollForce)
      || !Number.isFinite(d.massBalance) || !Number.isFinite(this.flow.v[0])
      || !Number.isFinite(this.flow.v[this.flow.v.length - 1]);
    if (!bad) return false;
    if (this.divergedGiveUp) return false;
    this.restartLog = this.restartLog.filter((t) => now - t < DIVERGE_WINDOW);
    this.restartLog.push(now);
    if (this.restartLog.length > DIVERGE_LIMIT) {
      this.divergedGiveUp = true;
      return false;
    }
    this.restarts++;
    this.restartAt = now;
    this.resetState();
    this.resetAgc();
    return true;
  }

  /** The conditions changed: whatever divergence was being counted is a different problem now. */
  forgiveDivergence(): void {
    this.restartLog = [];
    this.divergedGiveUp = false;
  }

  /** Forget what the gap loop has learned; its target or its mode has moved. */
  resetAgc(): void {
    this.agcTick = 0;
    this.agcHeld = false;
    this.agcIters = 0;
    this.diag.agcIterations = 0;
    this.agcFilt = 0;
    this.agcSeen = false;
    this.agcSens = 0;
    this.agcPrevGap = 0;
    this.agcPrevMeas = 0;
    this.agcPrevP = 0;
    this.agcPrevH1 = 0;
    this.agcQ = 0;
    this.diag.agcPlasticSlope = 0;
    this.agcHavePrev = false;
    this.forgetBracket();
  }

  /**
   * The gap sensitivity written straight from the mill, with no identification.
   *
   * Both modes fall out of the gaugemeter relation with nothing but quantities
   * already being measured here - no material constant, no fitted gain.
   *
   * The strip leaves at `h1 = S + spring`, and the plastic curve gives the
   * load its draft costs, so with `M = P/spring` the mill modulus and
   * `Q = P/draft` the secant plastic slope,
   *
   *     dh1/dS = M/(M+Q) = draft/(draft+spring)
   *     dP/dS  = -QM/(Q+M) = -P/(draft+spring)
   *
   * The two loads cancel in the first and survive in the second, which is why
   * gauge control gets a dimensionless number near one while load control
   * needs the scaling the loop applies to its error.
   */
  private analyticSens(force: boolean): number {
    const p = this.params;
    const d = this.diag;
    const draft = Math.max(p.h0 - d.exitThickness, 1e-9);
    const spring = Math.max(d.millSpring - d.millStretch, 1e-12);
    if (!force) return Math.max(0.15, Math.min(1, draft / (draft + spring)));
    const scale = Math.max(Math.abs(p.agcTargetForce), 1e3);
    const raw = (d.rollForce * p.h0) / ((draft + spring) * scale);
    return -Math.max(0.4, Math.min(60, raw));
  }

  /** Drop everything the search has learned about where the root is. */
  private forgetBracket(): void {
    this.agcLo = NaN; this.agcGlo = NaN;
    this.agcHi = NaN; this.agcGhi = NaN;
    this.agcHunt = 0;
    this.agcBrH0 = 0;
    this.agcSide = 0;
    this.agcRidM = NaN; this.agcRidPhase = 0;
    this.agcNwPhase = 0; this.agcNwGap = NaN; this.agcNwErr = NaN;
    this.brReady = false;
  }

  /**
   * Where to move the screws next, by whichever bracketed method is selected.
   *
   * `g` is the monotone-increasing error described on the bracket fields, and
   * the return value is an absolute gap. Called once per screw revision, so
   * each branch below is *one* step of its algorithm rather than a loop - the
   * plant supplies the function evaluations in between, at a cost of seconds
   * each. That is the whole reason the choice matters.
   */
  private nextGap(g: number): number {
    const p = this.params;
    const S = this.gap;

    // A bracket describes one operating point. On a tandem line the entry
    // gauge walks while the chain settles, which moves the root out from under
    // the stored ends - so they are dropped rather than trusted.
    if (this.agcBrH0 > 0 && Math.abs(p.h0 - this.agcBrH0) > 5e-3 * this.agcBrH0) {
      this.forgetBracket();
    }
    this.agcBrH0 = p.h0;

    // Record which side of the root this position turned out to be on.
    if (g < 0) {
      this.agcLo = S; this.agcGlo = g;
      // Illinois: a second consecutive hit on the same side means the far end
      // is stale and holding the chord flat. Bend it.
      if (p.agcMethod === 'illinois' && this.agcSide === -1
        && Number.isFinite(this.agcGhi)) this.agcGhi *= 0.5;
      this.agcSide = -1;
    } else {
      this.agcHi = S; this.agcGhi = g;
      if (p.agcMethod === 'illinois' && this.agcSide === 1
        && Number.isFinite(this.agcGlo)) this.agcGlo *= 0.5;
      this.agcSide = 1;
    }

    const bracketed = Number.isFinite(this.agcLo) && Number.isFinite(this.agcHi)
      && this.agcHi > this.agcLo;
    if (!bracketed) {
      // Hunt outwards for the missing end, doubling the reach each time. The
      // first step is the same clamp the secant uses, so choosing a method
      // does not also change how boldly the loop starts.
      const base = Math.max(this.agcHunt, p.agcMaxStep);
      this.agcHunt = Math.min(base * 2, 0.5);
      return g < 0 ? S + base * p.h0 : S - base * p.h0;
    }
    this.agcHunt = 0;

    const lo = this.agcLo, hi = this.agcHi;
    const glo = this.agcGlo, ghi = this.agcGhi;
    const mid = 0.5 * (lo + hi);
    /** Keep a proposal off the ends, so a flat chord cannot stall the search. */
    const inside = (x: number) => {
      const pad = 0.02 * (hi - lo);
      return Number.isFinite(x) && x > lo + pad && x < hi - pad ? x : mid;
    };

    switch (p.agcMethod) {
      case 'bisect':
        return mid;

      case 'falsi':
      case 'illinois':
        // One step; the two differ only in the halving applied above, which is
        // what stops false position creeping in from one side forever.
        return inside(ghi > glo ? lo - glo * ((hi - lo) / (ghi - glo)) : mid);

      case 'ridders': {
        // Two evaluations per iteration: the midpoint, then the point the
        // exponential fit picks. `agcRidPhase` says which half we are in.
        if (this.agcRidPhase === 0) {
          this.agcRidM = mid;
          this.agcRidPhase = 1;
          return mid;
        }
        this.agcRidPhase = 0;
        // The midpoint's value is the one measured on the previous revision,
        // which is this call's own `g`.
        const gm = g;
        const disc = gm * gm - glo * ghi;
        if (!(disc > 0)) return mid;
        // sign(glo - ghi) is negative for an increasing g, which is the
        // direction that walks from the midpoint towards the root.
        return inside(this.agcRidM
          + (this.agcRidM - lo) * ((glo - ghi < 0 ? -1 : 1) * gm) / Math.sqrt(disc));
      }

      case 'brent':
        return inside(this.brentStep(S, g, lo, hi, glo, ghi));

      default:
        return mid;
    }
  }

  /**
   * One step of Brent's method.
   *
   * Inverse quadratic interpolation when three usable points are in hand, the
   * secant when only two are, and a bisection whenever either would step
   * outside the bracket or fail to make progress. That last clause is the
   * whole trick: as fast as interpolation where interpolation works, and
   * exactly as safe as bisection where it does not.
   */
  private brentStep(
    S: number, g: number, lo: number, hi: number, glo: number, ghi: number,
  ): number {
    if (!this.brReady) {
      // Seed from the bracket, with `b` - Brent's running best - at whichever
      // end is closer to the root.
      const bAtLo = Math.abs(glo) <= Math.abs(ghi);
      this.brB = bAtLo ? lo : hi; this.brFb = bAtLo ? glo : ghi;
      this.brC = bAtLo ? hi : lo; this.brFc = bAtLo ? ghi : glo;
      this.brA = this.brC; this.brFa = this.brFc;
      this.brD = this.brE = hi - lo;
      this.brReady = true;
    } else {
      this.brA = this.brB; this.brFa = this.brFb;
      this.brB = S; this.brFb = g;
    }
    let a = this.brA, fa = this.brFa;
    let b = this.brB, fb = this.brFb;
    let c = this.brC, fc = this.brFc;
    let d = this.brD, e = this.brE;

    if (fb * fc > 0) { c = a; fc = fa; d = b - a; e = d; }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a; fa = fb; fb = fc; fc = fa;
    }
    const tol1 = 1e-12 * Math.abs(b) + 1e-9;
    const xm = 0.5 * (c - b);
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const sc = fb / fa;
      let num: number, den: number;
      if (a === c) { num = 2 * xm * sc; den = 1 - sc; }
      else {
        const q = fa / fc, r = fb / fc;
        num = sc * (2 * xm * q * (q - r) - (b - a) * (r - 1));
        den = (q - 1) * (r - 1) * (sc - 1);
      }
      if (num > 0) den = -den;
      num = Math.abs(num);
      const min1 = 3 * xm * den - Math.abs(tol1 * den);
      const min2 = Math.abs(e * den);
      if (2 * num < Math.min(min1, min2)) { e = d; d = num / den; }
      else { d = xm; e = d; }
    } else { d = xm; e = d; }
    const step = Math.abs(d) > tol1 ? d : (xm >= 0 ? tol1 : -tol1);

    this.brA = a; this.brFa = fa; this.brB = b; this.brFb = fb;
    this.brC = c; this.brFc = fc; this.brD = d; this.brE = e;
    return b + step;
  }

  /** Put the screws back on the commanded reduction and drop the loop state. */
  releaseGap(): void {
    this.setGap(this.h1Command);
    this.resetAgc();
  }

  /**
   * Point the gauge loop at a new setpoint without throwing away what it has
   * already worked out about the stand.
   *
   * `releaseGap` puts the screws *on* the commanded gauge, which is where they
   * belong when nothing is driving them - with the loop off, the command is
   * the screw position. Under gauge control it is not: the strip leaves a
   * whole mill spring thicker than the screws are set, and the loop's entire
   * job is to find that offset. Re-commanding through `releaseGap` discarded
   * it and made the loop rediscover the same 100 um from scratch.
   *
   * So the screws are placed by the gaugemeter relation instead,
   *
   *     S = h1* - (h1 - S)_measured
   *
   * which is the industrial AGC feed-forward: the spring measured at the old
   * operating point is very nearly the spring at the new one, so this lands
   * within a trim of the answer in a single move - and one move is worth
   * several seconds here, because the loop waits for the mill-spring and feed
   * loops to settle between them. On the default cold pass it puts the screws
   * within 0.8 % of h0 of the converged position, against 5.8 % for the raw
   * command.
   *
   * The identified gain and its trust are kept: the plant has not changed,
   * only the number being asked of it. The secant *pair* goes, because it
   * would straddle a jump the plant never made.
   */
  retarget(): void {
    // The spring the *loop* has to pay is the flattening and springback; the
    // housing stretch is under the command already (see `updateMillStretch`).
    const spring = this.params.agcSpringComp && Number.isFinite(this.diag.millSpring)
      ? Math.max(this.diag.millSpring - this.diag.millStretch, 0) : 0;
    this.setGap(this.agcSetpoint - spring);
    this.agcTick = 0;
    this.agcHavePrev = false;
    this.agcHeld = false;
    this.agcIters = 0;
    this.diag.agcIterations = 0;
    // The bracket describes where the *old* root was. The setpoint has moved,
    // so its ends are statements about a question nobody is asking any more.
    this.forgetBracket();
  }

  /**
   * Bounds on the *loaded* barrel separation - what the strip mesh actually
   * has to live inside.
   *
   * The open end stops short of h0 on purpose: with the barrel exactly on the
   * incoming surface the bite degenerates to a point, the contact set empties
   * and the flow solve has nothing to stand on. The closed end is where a
   * rigid-plastic strip stops meaning anything.
   */
  private sepLo(): number {
    // Defended against a non-finite value. This bound feeds every screw clamp,
    // so one bad number here does not throw an error - it quietly makes the
    // gap NaN, `setGap` then refuses every move, and the mill runs on looking
    // healthy with its screws welded shut.
    const f = Number.isFinite(this.params.sepFloorFrac) ? this.params.sepFloorFrac : 0.30;
    return Math.max(0.02, Math.min(0.9, f)) * this.params.h0;
  }
  private sepHi(): number { return 0.98 * this.params.h0; }

  /**
   * Screw travel, which is the separation bounds shifted down by the stretch.
   *
   * This is why a real stand is set to a *negative* unloaded gap when rolling
   * thin: what has to stay positive is the loaded separation, and the mill
   * spring is what opens it back up. With a rigid stand the stretch is zero
   * and the screw bounds collapse onto the separation bounds, as before.
   */
  /**
   * `gap` is the *loaded* separation the loop commands, net of roll
   * flattening and springback; the physical screw position is `gap` minus
   * the housing stretch (see `updateMillStretch`), so the rails on what the
   * loop may ask for are simply the separation bounds.
   */
  private gapLo(): number { return this.sepLo(); }
  private gapHi(): number { return this.sepHi(); }
  /** The screw position a stand would read: the command less the housing stretch [m]. */
  get screwPosition(): number { return this.gap - this.stretch; }


  /**
   * Move the screws to a new unloaded gap.
   *
   * The roll is a linear elastic body on a rigid hub, so a rigid vertical
   * translation leaves its stiffness alone - only the coordinates move, and
   * the factorised operator stays valid. Everything else that carries an
   * absolute y (the low-passed barrel profile, the oscillation detector's
   * memory of the last exit height) is carried along with it, so the coupling
   * loop does not read the screw move as a physical change and clamp itself.
   */
  private setGap(h: number): void {
    // A non-finite gap would translate the roll mesh into nothing and there is
    // no way back from that, so refuse it here rather than anywhere upstream.
    if (!Number.isFinite(h)) return;
    this.gapCmd = Math.max(this.gapLo(), Math.min(this.gapHi(), h));
    // Without actuator dynamics the screws are there this frame, as they
    // always were; with them, `moveScrew` walks the screw over the frames.
    if (!this.screwDynActive()) this.snapScrew();
  }

  /** Put the screws on their command at once - a reset, not a move. */
  private snapScrew(): void {
    if (this.gap === this.gapCmd) return;
    this.gap = this.gapCmd;
    this.placeRoll();
  }

  /** How far the screws still have to travel to their command [m]. */
  get screwTravel(): number { return this.gapCmd - this.gap; }

  /**
   * One frame of the screwdown actuator: the gap approaches its command with
   * a first-order lag, never faster than the speed limit, and snaps the last
   * fraction of a micron so the loop's arrival test has an end.
   *
   * Before this the loop wrote the screw position outright every `agcEvery`
   * frames, and the trace of it was a staircase - moves of tens of microns
   * landing in one frame, which no screwdown does.
   */
  private moveScrew(dt: number): void {
    const p = this.params;
    if (!this.screwDynActive()) { this.snapScrew(); return; }
    if (!(dt > 0)) return;
    const d = this.gapCmd - this.gap;
    if (d === 0) return;
    if (Math.abs(d) <= SCREW_ARRIVED) { this.snapScrew(); return; }
    const rate = Math.max(p.screwRate, 1e-9);
    const v = Math.max(-rate, Math.min(rate, d / Math.max(p.screwTau, 1e-3)));
    let step = v * dt;
    if (Math.abs(step) > Math.abs(d)) step = d;
    this.gap += step;
    this.placeRoll();
  }

  /**
   * Put the barrel where the screw position plus the housing stretch says it
   * belongs, translating the roll rigidly to get there.
   *
   * Both the gap loop and the mill-spring loop move the barrel, and they must
   * not each keep their own idea of where it is - so the placement is derived
   * from the pair every time and applied as a delta against what is actually
   * on screen.
   */
  private placeRoll(): void {
    const sep = Math.max(this.sepLo(), Math.min(this.sepHi(), this.gap));
    const dy = (sep - this.placedSep) / 2;
    if (dy === 0 || !Number.isFinite(dy)) return;
    this.placedSep = sep;
    this.cy += dy;
    this.roll.cy = this.cy;
    const X = this.roll.X;
    for (let i = 0; i < this.roll.nn; i++) X[2 * i + 1] += dy;
    for (let i = 0; i < this.barrelY.length; i++) {
      if (this.barrelY[i] !== 0) this.barrelY[i] += dy;
    }
    if (this.lastExitHalf > 0) this.lastExitHalf += dy;
  }

  /**
   * Housing stretch under load.
   *
   * The screws hold a position; the stand around them does not hold still. The
   * housing, the screw column and the bearings all give, and the barrels
   * separate by P/M on top of whatever the roll surface itself flattens. That
   * is the mill modulus - and on a real stand it dominates: a few MN/mm of
   * stiffness against a few kN/mm of load is millimetres of stretch, where the
   * flattening modelled here is tens of microns.
   *
   * It is relaxed rather than applied outright because it is the other half of
   * the same fixed point as the flattening: more load opens the gap, which
   * takes load back off. That loop is stabilising, but it still has to settle.
   */
  private updateMillStretch(): void {
    const p = this.params;
    const d = this.diag;
    if (!p.millSpringOn || !(p.millModulus > 0)) {
      this.stretch = 0;
      d.millStretch = 0;
      d.millResidual = 0;
      return;
    }
    /*
     * The housing stretch is P/M, and it is taken off the screw position
     * rather than added to the separation.
     *
     * This used to be the other way round: `gap` was the physical screw, the
     * stretch was relaxed onto P/M by a Newton step and *added* to the
     * separation, and the gauge loop was left to find the screw position that
     * paid for it. Measured, the loop never got there. On a 2 mm strip through
     * a 5 MN/mm stand at 1000 tonf the stretch is 1.93 mm, the stretch loop
     * opened the barrel at 75 um a frame against the gauge loop's 10, the
     * pass collapsed to 2.5 % reduction inside half a second, the feed loop
     * could not settle in that bite and the gauge loop stalled behind it for
     * good - 22 % off target, from boot or from the switch alike. Feeding the
     * stretch forward into the physical screw while the loop still commanded
     * that screw was tried next, and hunted (+-500 tonf): the loop identified
     * its gain against a screw the feed-forward was moving underneath it.
     *
     * So the loop commands the loaded separation, and the screw a real stand
     * would read is that command less P/M - negative on thin gauge, as it is
     * on a real mill. Nothing about the flattening or springback changes: the
     * loop pays for those exactly as before. What the switch adds is the
     * screw readout, the physical rails, the うち ハウジング伸び row, and the
     * fact that a load change now moves the screw the operator sees. This is
     * gaugemeter compensation, and it is the only form in which a stand this
     * soft converges at all.
     */
    const P = d.rollForce;
    if (!Number.isFinite(P)) return;
    this.stretch = Math.max(P, 0) / p.millModulus;
    d.millStretch = this.stretch;
    d.millResidual = 0;
  }

  /**
   * The actuator is on and the pass is threaded.
   *
   * The actuator moves the *commanded separation*, not the physical screw.
   * Making the screw the state and letting the housing stretch open the
   * barrel until the screw paid for it was tried (2026-09-12) on top of the
   * two attempts described in `updateMillStretch`, with the stretch relaxed
   * onto P/M and the gap loop gated on arrival: the barrel-load iteration
   * still went unstable within thirty seconds and the solve reached NaN. So
   * the gaugemeter compensation stays instantaneous - the screw reading
   * still follows the load at once - and what the actuator smooths is every
   * move the loop asks for.
   */
  private screwDynActive(): boolean {
    return this.params.screwDyn && this.screwWarm >= SCREW_WARM;
  }

  /**
   * Automatic gap control.
   *
   * The screws set the *unloaded* gap. What leaves the mill is that gap plus
   * the mill spring - the barrel flattens under load, the strip springs back
   * on release - so a stand with its screws parked always under-reduces. A
   * real stand closes the loop around the measurement instead: it drives the
   * screws until the gauge (or the load) sits on target, and the spring is
   * simply paid for in advance. Same thing here, on either measurement.
   *
   * The loop is a damped secant. Its plant gain is the mill's own
   *
   *     dh1/dS = M / (M + Q)
   *
   * with M the mill modulus and Q the slope of the plastic curve - well below
   * one, and a function of gauge, radius, friction and hardening, so rather
   * than assume a value the loop identifies it from the last move it made and
   * inverts it. Three things keep that stable: the measurement is low-passed,
   * the screws are only revised every few frames so the flattening loop has
   * time to relax in between, and a deadband stops the controller before it
   * starts chasing its own noise. The step is clamped as well, because the
   * first move is made on a guessed gain.
   */
  private updateAgc(): void {
    const p = this.params;
    const d = this.diag;
    if (p.agcMode === 'off') {
      d.agcMeasured = 0;
      d.agcStalled = false;
      d.agcError = 0;
      d.agcSettled = false;
      this.agcHeld = false;
      this.agcIters = 0;
      d.agcIterations = 0;
      d.agcSaturated = false;
      d.agcIdle = false;
      d.agcSensitivity = 0;
      return;
    }

    // Nothing to roll: the target is at or above what arrives. Park the
    // screws on it and stop, rather than opening them until the bite empties.
    d.agcIdle = this.gaugeIdle;
    if (d.agcIdle) {
      d.agcStalled = false;
      d.agcSettled = true;
      d.agcSaturated = false;
      d.agcError = 0;
      d.agcMeasured = d.exitThickness;
      return;
    }

    const force = p.agcMode === 'force';
    // Measurement, target and a scale to divide both by, so one set of gains
    // and clamps covers gauge control and load control alike.
    const meas = force ? d.rollForce : d.exitThickness;
    const target = force ? p.agcTargetForce : this.agcSetpoint;
    const scale = force ? Math.max(Math.abs(target), 1e3) : p.h0;

    // Spring compensation off: the target is a screw position, not a gauge.
    // Park the screws on it and report, without a loop. The deviation shown
    // is the mill spring itself - the number this switch exists to expose -
    // so `agcSettled` is the stand having nothing left to do, not the error
    // being small. The rails still apply: a target under the separation
    // floor is still reported as ギャップ端に張り付き.
    if (!force && !p.agcSpringComp) {
      if (Math.abs(this.gap - target) > 1e-12) this.setGap(target);
      d.gapCommand = this.screwPosition;
      d.agcMeasured = meas > 0 ? meas : target;
      d.agcError = (d.agcMeasured - target) / scale;
      d.agcSettled = true;
      d.agcStalled = false;
      d.agcSaturated = target < this.gapLo() - 1e-15 || target > this.gapHi() + 1e-15;
      d.agcSensitivity = 0;
      return;
    }
    // Nothing is rolling yet. Until the bite carries load the exit thickness
    // is just the gap it was meshed into, so the error reads as zero and the
    // loop would declare victory before the mill has sprung at all.
    if (!(meas > 0) || d.rollForce <= 0 || d.contactNodes === 0) return;

    this.agcFilt = this.agcSeen ? this.agcFilt + 0.25 * (meas - this.agcFilt) : meas;
    this.agcSeen = true;
    d.agcMeasured = this.agcFilt;
    const err = (this.agcFilt - target) / scale;
    d.agcError = err;
    // Inside the deadband: settled. Outside it: still settled while inside
    // the release band, if it was - the jitter the plant makes at a fixed
    // screw is not something to chase (see AGC_RELEASE). Leaving the band is
    // where a new convergence starts, and where its count starts from.
    const band = this.agcBand;
    const inBand = Math.abs(err) < band;
    // The release band is for jitter. Under FEM load control the band is
    // the mesh's own quantum, and a mesh correction that moves the load by
    // that much is not jitter but a step the loop should answer - so there
    // the release sits just above the band, not three times it.
    const held = inBand
      || (this.agcHeld && Math.abs(err) < Math.max(AGC_RELEASE, 3 * p.agcDeadband, 1.2 * band));
    if (this.agcHeld && !held) this.agcIters = 0;
    this.agcHeld = held;
    d.agcSettled = held;
    d.agcIterations = this.agcIters;
    // `agcStalled` is the last full pass's verdict and stands until the next
    // one, `agcEvery` frames later. On the frames between, it still says the
    // measurement is not this screw position's - so an error inside the band
    // is not a settled stand, and the two flags never read as one. Without
    // this the line printed 全スタンド収束 for the frames after a mesh re-fit
    // while every stand was visibly still walking (mill.ts reads only
    // `agcSettled` to decide the line is settled).
    if (d.agcStalled) d.agcSettled = false;
    // A measurement inside the band means no rail is binding, whatever the
    // last move asked for. Cleared here, ahead of the gates below, because a
    // stand held by the line or stalled behind the feed loop returns before
    // the settled branch further down - and its `agcSaturated` from an
    // earlier rail-limited move then outlived the condition it described.
    // On screen that read as 収束 and ギャップ端に張り付き at once.
    if (held) d.agcSaturated = false;

    if (this.holdGap) {
      d.agcSettled = false;
      d.agcStalled = true;
      return;
    }
    // The screws are still on their way to the last command: nothing the
    // plant says yet belongs to that command, and a revision identified off
    // it would pair a move the screws have not made with a response they
    // have not given. Wait for them - the same rule as the mesh and feed
    // gates below.
    if (this.screwDynActive() && Math.abs(this.gapCmd - this.gap) > SCREW_ARRIVED) {
      d.agcSettled = false;
      d.agcStalled = true;
      return;
    }
    if (++this.agcTick < Math.max(1, p.agcEvery | 0)) return;
    this.agcTick = 0;

    // Wait for the stand. The screws and the housing both move the barrel, and
    // if they revise on the same cadence with the same step they simply cancel
    // - the loop walks the screw position and the stretch apart forever while
    // the separation, and therefore the measurement, never moves at all. The
    // stand is the inner loop: let it reach its own equilibrium first.
    if (d.millResidual > MILL_SETTLED) return;

    // Same for the mesh: while its entry column is still walking onto the
    // barrel crossing, the arc - and so the load - is not yet this screw
    // position's - nor, then, is the verdict above.
    if (d.meshResidual > MESH_SETTLED) {
      d.agcSettled = false;
      d.agcStalled = true;
      return;
    }

    // Same for the free-running speed - but against what that loop can
    // actually reach. Its residual bottoms out on plant jitter a few times its
    // own deadband, so holding out for the deadband alone is holding out for
    // something that will not arrive.
    if (p.feedSpeed <= 0
      && d.feedResidual > Math.max(FEED_SETTLED * p.feedDeadband, 2 * d.feedFloor)) {
      d.agcSettled = false;
      d.agcStalled = true;
      return;
    }
    d.agcStalled = false;
    d.agcSettled = held;

    // Identify the gain from the previous move. The screw travel is in units
    // of h0 and the measurement in units of `scale`, so the slope comes out
    // non-dimensional and the sane range for it is known a priori: closing the
    // gap thins the strip (positive) and raises the load (negative).
    //
    // The bounds matter more than they look. The step taken below is err/sens,
    // so a slope identified near zero asks for an unbounded move - and the
    // load is *not* a smooth function of the gap at this discretisation,
    // because the contact set gains and loses whole columns as the barrel
    // moves. Bounding the slope away from zero is what keeps a staircase in
    // the plant from throwing the screws across the strip. A move too small to
    // clear that staircase carries no information either, so it is not used.
    const gapN = this.gap / p.h0;
    if (this.agcHavePrev) {
      const dS = gapN - this.agcPrevGap;
      const dM = (this.agcFilt - this.agcPrevMeas) / scale;
      // Not for the fixed-gain method: its whole definition is that it never
      // learns the plant, which is what makes it the baseline the others are
      // read against.
      if (Math.abs(dS) > 1e-3 && p.agcMethod !== 'fixed') {
        const slope = dM / dS;
        const sane = force ? slope < -0.4 && slope > -60 : slope > 0.1 && slope < 2;
        if (sane) {
          this.agcSens = this.agcSens !== 0
            ? this.agcSens + 0.4 * (slope - this.agcSens) : slope;
        }
      }
    }
    /*
     * The first move, seeded from the stand rather than from a constant.
     *
     * The gaugemeter relation dh1/dS = M/(M+Q) wants the mill modulus M and
     * the slope Q of the plastic curve. Both are already measured here, and
     * without any material constant: M is the load divided by the spring it
     * produced, and the secant plastic slope across the pass is the load
     * divided by the draft it took. The two loads cancel,
     *
     *     dh1/dS  ~  (1/spring) / (1/spring + 1/draft)
     *             =  draft / (draft + spring)
     *
     * which on the default cold pass is 0.84 against an identified 0.75. The
     * constant it replaces was 0.5 - a third low, and a gain guessed low makes
     * the step err/sens correspondingly too large, which is exactly where the
     * overshoot on a setpoint change was coming from.
     *
     * Load control keeps its constant: dP/dS has no such cancellation, and the
     * clamps below are what carry it until the secant takes over.
     */
    if (this.agcSens === 0) {
      if (force) {
        this.agcSens = -2;
      } else {
        const draft = Math.max(p.h0 - d.exitThickness, 1e-9);
        const spring = Math.max(d.millSpring - d.millStretch, 1e-12);
        this.agcSens = Math.max(0.15, Math.min(1, draft / (draft + spring)));
      }
    }
    d.agcSensitivity = p.agcMethod === 'gaugemeter' ? this.analyticSens(force) : this.agcSens;

    if (d.agcSettled) {
      d.agcSaturated = false;
      return;
    }

    /*
     * The step clamp stays fixed, and deliberately so.
     *
     * Opening it once the gain has been identified was tried - the reasoning
     * being that the clamp exists only to survive a guessed first move, and
     * that a large setpoint change needs several clamped moves to cover the
     * travel. Measured, it was worse: 6.3 s to settle against 4.0 s, because
     * a step sized by the full error overshoots and every overshoot costs a
     * trim cycle, and a trim cycle here means waiting for the mill-spring and
     * feed loops all over again.
     *
     * The travel is not what a setpoint change should be spending moves on
     * anyway. `retarget` puts the screws within a trim of the answer in one
     * jump, which leaves this clamp doing the only job it is good at: keeping
     * the trimming small.
     */
    /*
     * The move itself, by the selected method.
     *
     * The open methods - the identified secant and the fixed-gain fallback -
     * step from the current position and keep the clamp, because nothing else
     * stops them. The bracketed family proposes an absolute gap instead: once
     * the root is trapped, clamping the step would only slow the bracket down
     * without making anything safer.
     */
    let raw: number;
    if (p.agcMethod === 'newton') {
      /*
       * Finite-difference Newton: measure the slope on purpose, then step.
       *
       * The secant reuses whatever move happened last, which near convergence
       * is a move so small that the slope it implies is mostly noise - the
       * guard `|dS| > 1e-3` exists precisely because of that. Probing on
       * purpose keeps the difference well conditioned all the way in.
       *
       * The probe is a full-size move, not a small one, and aimed at the root
       * rather than away from it. Both of those are forced by the plant: the
       * load is a staircase in the gap, because the contact set gains and
       * loses whole element columns as the barrel moves, and a probe shorter
       * than one tread measures a slope of zero and asks for an infinite step.
       * Aiming it at the root means the probe is also progress rather than a
       * wasted evaluation.
       */
      const lim = Math.max(1e-6, p.agcMaxStep);
      if (this.agcNwPhase === 0) {
        this.agcNwGap = this.gap;
        this.agcNwErr = err;
        this.agcNwPhase = 1;
        const probe = Math.max(-lim, Math.min(lim, -Math.sign(err / this.agcSens) * lim));
        raw = this.gap + probe * p.h0;
      } else {
        this.agcNwPhase = 0;
        const dS = (this.gap - this.agcNwGap) / p.h0;
        const dE = err - this.agcNwErr;
        // Fall back to the identified sensitivity if the probe landed inside
        // one tread of the staircase and produced no usable difference.
        const slope = Math.abs(dS) > 1e-4 && Math.abs(dE) > 1e-9
          ? dE / (dS * scale) : this.agcSens;
        const use = Math.abs(slope) > 1e-6 ? slope : this.agcSens;
        const step = Math.max(-lim, Math.min(lim, -(err / use) * p.agcGain));
        raw = this.gap + step * p.h0;
      }
    } else if (p.agcMethod === 'secant' || p.agcMethod === 'fixed'
      || p.agcMethod === 'gaugemeter') {
      const sens = p.agcMethod === 'gaugemeter' ? this.analyticSens(force) : this.agcSens;
      const lim = Math.max(1e-6, p.agcMaxStep);
      const step = Math.max(-lim, Math.min(lim, -(err / sens) * p.agcGain));
      raw = this.gap + step * p.h0;
    } else {
      // g increases with the gap whichever quantity is held: opening the
      // screws lets the strip out thicker, and takes load off.
      raw = this.nextGap(force ? -err : err);
    }

    // The plastic curve's slope from this revision and the last: a pair of
    // (gauge, load) readings a move apart. Guarded the same way as the loop
    // gain, and by the same amount (1e-3 h0, two microns on the default
    // strip): the final trims are smaller than that and inside the plant's
    // own jitter, and read as any slope at all - one read -10.8 where the
    // approach had said -4.
    if (this.agcHavePrev && Math.abs(d.exitThickness - this.agcPrevH1) > 1e-3 * p.h0) {
      const q = (d.rollForce - this.agcPrevP) / (d.exitThickness - this.agcPrevH1);
      if (Number.isFinite(q) && q < 0) this.agcQ = this.agcQ !== 0 ? this.agcQ + 0.4 * (q - this.agcQ) : q;
    }
    this.agcPrevP = d.rollForce;
    this.agcPrevH1 = d.exitThickness;
    d.agcPlasticSlope = this.agcQ;
    this.agcPrevGap = gapN;
    this.agcPrevMeas = this.agcFilt;
    this.agcHavePrev = true;

    // The rails in `setGap` are on the *unloaded* gap, but what has to stay
    // inside h0 is the loaded thickness: gap plus mill spring. Under load
    // control with a target below what the stand can make, the loop keeps
    // opening, and a screw position still short of its rail can already put
    // the strip through untouched - the bite collapses, the contact set
    // empties, and there is no measurement left to close the loop on. The
    // measured spring is the only thing that knows where that point is.
    const openCap = 0.995 * p.h0 - Math.max(d.millSpring - d.millStretch, 0);
    const want = Math.min(raw, openCap);
    this.setGap(want);
    d.agcIterations = ++this.agcIters;
    d.gapCommand = this.screwPosition;
    d.agcSaturated = want < this.gapLo() - 1e-15
      || want > this.gapHi() + 1e-15
      || raw > want + 1e-15;
  }

  /**
   * Free-running speed control.
   *
   * With the entry face prescribed, whatever longitudinal force the mill cannot
   * supply through friction shows up as a reaction there; a real stand has
   * nothing to push against, so the feed speed is driven until that reaction
   * vanishes.
   *
   * Near the roll flattening limit this loop is coupled to the flattening loop
   * and the load is stiff in the feed speed - a tenth of a percent on v moves
   * the load several percent - so the two hunt against each other. Three things
   * keep it settled: the reaction is low-passed, the speed is only revised every
   * few frames so the gap has time to relax in between, and a deadband stops the
   * controller once the residual is inside its own noise.
   */
  private updateFeedSpeed(): void {
    const R = this.diag.feedReaction;
    this.reactFilt = this.reactSeen ? this.reactFilt + 0.2 * (R - this.reactFilt) : R;
    this.reactSeen = true;
    const ref = Math.max(Math.abs(this.diag.rollForce) * this.params.mu, 1e3);
    this.diag.feedResidual = Math.abs(this.reactFilt) / ref;
    this.feedFloor = this.feedFloor > 0
      ? Math.min(this.diag.feedResidual, this.feedFloor * 1.0005)
      : this.diag.feedResidual;
    this.diag.feedFloor = this.feedFloor;

    if (++this.feedTick < Math.max(1, this.params.feedEvery | 0)) return;
    this.feedTick = 0;
    // The same release band the gap loop has (see AGC_RELEASE): once inside
    // the deadband, hold until the residual clears the gate the gap loop
    // waits behind. Without it the loop stepped on every residual a hair
    // over its deadband, and each step moved the exit gauge by about
    // 0.1 um - on the third stand of a line, enough to keep the gap loop's
    // measurement wandering across its own release band for as long as the
    // run lasted, the two loops each disturbing what the other was settling.
    const gate = Math.max(FEED_SETTLED * this.params.feedDeadband, 2 * this.feedFloor);
    if (this.diag.feedResidual < this.params.feedDeadband) this.feedHeld = true;
    else if (this.diag.feedResidual > gate) this.feedHeld = false;
    if (this.feedHeld) return;

    // Fixed proportional, deliberately. An identified-secant version of this
    // loop was tried and lost: it reached the deadband faster on the easy case
    // (7 frames against 51) and was slower on every hard one (188 against 89,
    // 212 against 151, 207 against 98), with a worse steady residual. The
    // reason is `feedFloor` below - the residual here is dominated by jitter
    // the controller cannot remove, so a sharper controller only chases noise.
    const v = this.vIn;
    const rel = Math.max(-1, Math.min(1, this.reactFilt / ref));
    /*
     * The clamp is fixed, and that was re-measured. Halving it on every
     * reaction reversal - the flattening coupling's own rule - was tried
     * against the limit cycle load control falls into when the bite entry
     * sits on a column boundary. It cut the reversals from 204 to 123 per
     * 2000 frames and did not settle the loop, because that cycle is not this
     * loop's (see `contactToggling`); and in ordinary use it cost 2.5x on a
     * reduction step (10.0 s to 24.8 s), the clamp having shrunk on the
     * damped reversals of a normal transient and then lagging every screw
     * move that followed.
     */
    const step = Math.max(-0.005, Math.min(0.005, -this.params.feedGain * rel));
    this.vIn = Math.max(1e-5,
      Math.min(5 * this.params.omega * this.params.R + 1e-3, v * (1 + step)));
  }

  /**
   * Transport the equivalent strain and the temperature along the streamlines.
   *
   * The flow is steady and strongly downstream dominated, so a column-by-column
   * upwind sweep with a back-trace to the previous column is both exact enough
   * and unconditionally stable - no SUPG needed.
   *
   * Temperature rides the same trace because it obeys the same equation: both
   * are carried by the material and both have a source proportional to the
   * strain rate. Strain integrates `eps_dot`; temperature integrates the
   * plastic power `beta * sigma_f * eps_dot / (rho c)`. No conduction term -
   * see `heatOn` for why the bite is adiabatic - so the two sweep together at
   * the cost of one.
   */
  private transportStrain(): void {
    const p = this.params;
    const m = this.flow.mesh;
    const rows = m.rows;
    // Heat capacity per unit volume. Guarded: a zero here is a division by
    // zero straight into the temperature field, and from there into the flow
    // stress the whole solve stands on.
    const rc = Math.max(p.rhoStrip * p.cpStrip, 1);
    const beta = Math.max(0, Math.min(1, p.taylorQuinney));

    // nodal strain rate, area averaged from the Gauss points
    this.strainRateNode.fill(0);
    const wsum = this.rateW;
    wsum.fill(0);
    for (let e = 0; e < m.ne; e++) {
      let r = 0;
      for (let g = 0; g < 4; g++) r += this.flow.epsRate[4 * e + g];
      r *= 0.25;
      for (let k = 0; k < 4; k++) {
        const nd = m.quads[4 * e + k];
        this.strainRateNode[nd] += r;
        wsum[nd] += 1;
      }
    }
    for (let i = 0; i < m.nn; i++) if (wsum[i] > 0) this.strainRateNode[i] /= wsum[i];

    // The strip arrives in whatever condition the chain hands over - unworked
    // and at the line's entry temperature only for the first element.
    const e0 = Math.max(0, this.entryStrain);
    const t0 = Number.isFinite(this.entryTemp) ? this.entryTemp : p.tempEntry;
    for (let j = 0; j < rows; j++) { this.strain[j] = e0; this.temp[j] = t0; }
    for (let i = 1; i <= m.nx; i++) {
      const dx = m.xs[i] - m.xs[i - 1];
      const prevBase = (i - 1) * rows;
      const prevTop = m.X[2 * (prevBase + m.ny) + 1];
      for (let j = 0; j < rows; j++) {
        const nd = i * rows + j;
        const vx = Math.max(this.flow.v[2 * nd], 1e-6);
        const dt = dx / vx;
        const yBack = m.X[2 * nd + 1] - this.flow.v[2 * nd + 1] * dt;
        // interpolate the upstream column at yBack
        const f = Math.max(0, Math.min(1, prevTop > 0 ? yBack / prevTop : 0)) * m.ny;
        const j0 = Math.min(m.ny - 1, Math.floor(f));
        const fr = f - j0;
        const e0 = this.strain[prevBase + j0];
        const e1 = this.strain[prevBase + j0 + 1];
        const rate = this.strainRateNode[nd];
        const eps = e0 + fr * (e1 - e0) + rate * dt;
        this.strain[nd] = eps;

        // Same back-trace, same interpolation: whatever material arrived here
        // brought its heat with it.
        const t0 = this.temp[prevBase + j0];
        const t1 = this.temp[prevBase + j0 + 1];
        const tUp = t0 + fr * (t1 - t0);
        // The flow stress doing the work is the one at this particle's own
        // strain and the temperature it came in with - not the previous
        // iterate's `sigmaF`, which is a whole Picard step stale.
        this.temp[nd] = p.heatOn
          ? tUp + (beta * uniaxial(p, eps, tUp) * rate * dt) / rc
          : tUp;
      }
    }

    for (let i = 0; i < m.nn; i++) {
      this.sigmaF[i] = uniaxial(p, this.strain[i], this.temp[i]);
    }
  }

  /** Static elastic solve of the barrel under the interface tractions. */
  private solveRoll(): void {
    const p = this.params;
    const m = this.flow.mesh;
    this.rollF.fill(0);

    // interface pressure as a function of x, for interpolation onto the barrel
    const px: number[] = [], pp: number[] = [], pt: number[] = [];
    // anchor the traction distribution at the exact bite entry so the roll sees
    // the same smoothly-moving load the strip does
    px.push(this.biteEntryX); pp.push(0); pt.push(0);
    for (let i = this.contactFrom; i <= this.contactTo; i++) {
      if (m.xs[i] <= this.biteEntryX) continue;
      px.push(m.xs[i]);
      pp.push(this.flow.ifPressure[i]);
      pt.push(this.flow.ifShear[i]);
    }
    if (px.length < 2) return;
    const lerp = (arr: number[], x: number) => {
      if (x <= px[0] || x >= px[px.length - 1]) return 0;
      let lo = 0, hi = px.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (px[mid] <= x) lo = mid; else hi = mid;
      }
      const f = (x - px[lo]) / Math.max(px[hi] - px[lo], 1e-15);
      return arr[lo] + f * (arr[hi] - arr[lo]);
    };

    for (let k = 0; k < this.roll.nt; k++) {
      const nd = this.roll.surfNodes[k];
      const bx = this.roll.X[2 * nd], by = this.roll.X[2 * nd + 1];
      if (by > this.cy - p.R * 0.5) continue;
      const pr = lerp(pp, bx);
      if (pr <= 0) continue;
      const tr = lerp(pt, bx);
      const kp = (k - 1 + this.roll.nt) % this.roll.nt;
      const kn = (k + 1) % this.roll.nt;
      const a = this.roll.surfNodes[kp], b = this.roll.surfNodes[kn];
      const seg = 0.5 * Math.hypot(
        this.roll.X[2 * b] - this.roll.X[2 * a],
        this.roll.X[2 * b + 1] - this.roll.X[2 * a + 1]);
      let nx = bx - this.roll.cx, ny = by - this.cy;
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      const tx = -ny, ty = nx;
      // pressure pushes the barrel inward; the shear the strip feels is
      // reacted on the barrel with the opposite sign
      this.rollF[2 * nd] += (-pr * nx - tr * tx) * seg;
      this.rollF[2 * nd + 1] += (-pr * ny - tr * ty) * seg;
    }

    pcgFiltered(this.rollPat, this.rollVals, this.rollF, this.rollFree,
      this.rollU, this.rollWs, 200, 1e-6, true, this.rollPre);

    // The adaptive damping (`relaxScale`) acts here, on the one relaxation
    // the coupling has: the barrel the strip is meshed against is read off
    // this displacement directly each frame, with no further filtering.
    const r = Math.max(0, Math.min(1, p.rollRelax * this.relaxScale));
    for (let i = 0; i < this.rollUrel.length; i++) {
      this.rollUrel[i] += r * (this.rollU[i] - this.rollUrel[i]);
    }
    this.rollDeformed = true;
  }

  private collectDiagnostics(inp: FlowInput): void {
    const p = this.params;
    const m = this.flow.mesh;
    const d = this.diag;

    let P = 0, T = 0, peak = 0, arcIn = Infinity, arcOut = -Infinity, count = 0;
    let neutralX = 0, found = false;
    let prevSlip = 0, prevX = 0, have = false;
    for (let i = this.contactFrom; i <= this.contactTo; i++) {
      if (!this.flow.ifActive[i]) continue;
      const nd = m.topNodes[i];
      const x = m.X[2 * nd], y = m.X[2 * nd + 1];
      let nx = x - this.roll.cx, ny = y - this.cy;
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      const iPrev = Math.max(this.contactFrom, i - 1);
      const iNext = Math.min(this.contactTo, i + 1);
      const seg = this.contactW[i] * Math.max(
        (m.X[2 * m.topNodes[iNext]] - m.X[2 * m.topNodes[iPrev]]) / (iNext - iPrev), 1e-9);
      if (seg <= 0) continue;
      const pr = this.flow.ifPressure[i];
      P += pr * seg * -ny;                   // upward force on the barrel
      T += -this.flow.ifShear[i] * seg * p.R;
      if (pr > peak) peak = pr;
      if (x < arcIn) arcIn = x;
      if (x > arcOut) arcOut = x;
      count++;
      const s = this.flow.ifSlip[i];
      if (have && prevSlip * s < 0) {
        neutralX = prevX + ((0 - prevSlip) / (s - prevSlip)) * (x - prevX);
        found = true;
      }
      prevSlip = s; prevX = x; have = true;
    }
    d.rollForce = P;
    d.torque = T;
    d.power = Math.abs(T * p.omega);
    d.peakPressure = peak;
    d.contactNodes = count;
    d.arcIn = count ? arcIn : 0;
    d.arcOut = count ? arcOut : 0;
    d.arcLength = count ? arcOut - arcIn : 0;
    d.meanPressure = d.arcLength > 0 ? P / d.arcLength : 0;
    d.neutralX = neutralX;
    d.neutralFound = found;

    // Trapezoidal, like every other through-thickness average in this file:
    // the two surface nodes each own half a cell. The rectangle rule this used
    // to be over-weights them by half a cell apiece - a first-order error in
    // ny, large enough at ny = 8 to stop the mass balance converging under mesh
    // refinement, and it lands on the forward slip and the neutral point too.
    const colMean = (i: number) => {
      let s = 0;
      for (let j = 0; j < m.rows; j++) {
        const w = j === 0 || j === m.ny ? 0.5 : 1;
        s += w * this.flow.v[2 * (i * m.rows + j)];
      }
      return s / m.ny;
    };
    d.entrySpeed = colMean(0);
    d.exitSpeed = colMean(m.nx);
    const vr = p.omega * p.R;
    d.forwardSlip = vr > 0 ? (d.exitSpeed - vr) / vr : 0;
    d.backwardSlip = vr > 0 ? (vr - d.entrySpeed) / vr : 0;
    // Thicknesses first: the balance is v1*h1 / (v0*h0) for *this* frame, and
    // reading them after the division quietly used the previous frame's mesh.
    d.entryThickness = 2 * m.X[2 * m.topNodes[0] + 1];
    d.exitThickness = 2 * m.X[2 * m.topNodes[m.nx] + 1];
    const fluxIn = d.entrySpeed * d.entryThickness;
    d.massBalance = fluxIn !== 0 ? (d.exitSpeed * d.exitThickness) / fluxIn : 1;
    d.exitThicknessGap = 2 * this.gapY[Math.max(0, this.contactTo)];

    // Elastic entry zone.
    //
    // The criterion is the material one: a column is still elastic while the
    // equivalent strain it has accumulated is below the elastic limit
    // kf / E'. The crossing is interpolated inside the column, because the
    // zone is often shorter than one - it is only a percent or two of the arc
    // when the bite is long.
    {
      const Ep = p.Estrip / (1 - p.nuStrip * p.nuStrip);
      const kf = planeStrain(p, d.exitStrain);
      const epsY = p.elasticZones ? kf / Ep : 0;
      // Strain accumulated *in this bite*, so a strip that arrives already
      // work-hardened still gets its elastic run-in: what matters is how far
      // this stand has worked it, not what the stand upstream did.
      const colStrain = (i: number) => {
        let acc = 0;
        for (let j = 0; j < m.rows; j++) {
          const w = j === 0 || j === m.ny ? 0.5 : 1;
          acc += w * this.strain[i * m.rows + j];
        }
        return acc / m.ny - this.entryStrain;
      };
      let xCross = this.biteEntryX;
      let prevE = 0, prevX = this.biteEntryX, have = false;
      for (let i = this.contactFrom; i <= this.contactTo; i++) {
        if (this.contactW[i] <= 1e-6) continue;
        const e = colStrain(i);
        const x = m.xs[i];
        if (e >= epsY) {
          xCross = have && e > prevE
            ? prevX + ((epsY - prevE) / (e - prevE)) * (x - prevX)
            : x;
          break;
        }
        prevE = e; prevX = x; have = true;
        xCross = x;
      }
      d.elasticEntryLen = Math.max(0, xCross - this.biteEntryX);
      d.plasticArcLen = Math.max(0, m.xs[this.contactTo] - xCross);
      // the recovery is applied over this distance downstream of the exit plane
      d.elasticExitLen = p.elasticZones
        ? Math.max(d.exitThicknessGap, (this.winOut - this.winIn) / m.nx) : 0;
      // Geometric estimate: upstream of the bite the strip is flat and the
      // barrel closes on it at a slope |x_entry| / R, so the elastic
      // compression h0 * kf / E' is taken up over that much arc. (The textbook
      // sqrt(R * dh_e) applies to an isolated elastic contact and overstates
      // the zone whenever the plastic bite is long.)
      const dhE = p.h0 * kf / Ep;
      const slope = Math.abs(this.biteEntryX) / Math.max(this.hitchcockRadius(), 1e-9);
      d.elasticEntryCompression = dhE;
      d.elasticEntryTheory = slope > 1e-9 ? dhE / slope : 0;
      d.elasticEntryHertz = Math.sqrt(this.hitchcockRadius() * dhE);
    }

    // Springback from the stress state the exit-most contact element carries.
    if (p.elasticZones && this.contactTo > this.contactFrom) {
      const ee = Math.min(m.nx - 1, Math.max(0, this.contactTo - 1)) * m.ny + (m.ny - 1);
      const sxx = this.flow.elemStress[4 * ee];
      const pex = Math.max(this.flow.ifPressure[this.contactTo], 0);
      const nu = p.nuStrip;
      // plane strain: eps_yy = (1-nu^2)/E * [sig_yy - nu/(1-nu) sig_xx]
      const c = (1 - nu * nu) / p.Estrip;
      const raw = c * (pex - (nu / (1 - nu)) * (p.frontTension - sxx));
      const target = Math.max(0, Math.min(0.02, raw));
      this.springbackFilt += 0.1 * (target - this.springbackFilt);
    } else {
      this.springbackFilt *= 0.9;
    }
    d.springback = this.springbackFilt;

    let se = 0, te = 0, pk = 0, prate = 0, tpk = -Infinity;
    for (let j = 0; j < m.rows; j++) {
      const w = j === 0 || j === m.ny ? 0.5 : 1;
      se += w * this.strain[m.nx * m.rows + j];
      te += w * this.temp[m.nx * m.rows + j];
    }
    d.exitStrain = se / m.ny;
    d.exitTemp = te / m.ny;
    d.entryStrain = this.entryStrain;
    d.entryTemp = this.entryTemp;
    // What *this* stand added, not what the strip has been through: on a
    // tandem line the line's entry temperature is several stands back.
    d.tempRise = d.exitTemp - this.entryTemp;
    for (let i = 0; i < m.nn; i++) {
      if (this.strain[i] > pk) pk = this.strain[i];
      if (this.strainRateNode[i] > prate) prate = this.strainRateNode[i];
      if (this.temp[i] > tpk) tpk = this.temp[i];
    }
    d.peakStrain = pk;
    d.peakStrainRate = prate;
    d.peakTemp = Number.isFinite(tpk) ? tpk : p.tempEntry;
    d.thermalSoftening = 1 - thermalFactor(p, d.exitTemp);
    // The flow stress the strip actually leaves with, softening included -
    // this is the line the friction hill draws as `kf`, and it has to be the
    // one the solve used or the plot disagrees with itself.
    d.exitFlowStress = uniaxial(p, d.exitStrain, d.exitTemp);

    // Volume weighted mean of the flow stress across the bite: each column
    // contributes in proportion to the material it carries.
    {
      let acc = 0, wsum = 0;
      for (let i = this.contactFrom; i <= this.contactTo; i++) {
        if (this.contactW[i] <= 1e-6) continue;
        const h = m.X[2 * m.topNodes[i] + 1];
        if (h <= 0) continue;
        let col = 0;
        for (let j = 0; j < m.rows; j++) {
          const w = j === 0 || j === m.ny ? 0.5 : 1;
          col += w * this.sigmaF[i * m.rows + j];
        }
        col /= m.ny;
        acc += col * h;
        wsum += h;
      }
      d.meanFlowStress = wsum > 0 ? acc / wsum : uniaxial(p, 0);
      d.meanPlaneStrainStress = (2 / Math.sqrt(3)) * d.meanFlowStress;
      // Strain-averaged LMN: (1/eps1) INT_0^eps1 kf deps, converted back to
      // uniaxial. The integral of L(eps+M)^N is closed form, so no quadrature.
      const e1 = Math.max(d.exitStrain, 0);
      d.meanFlowStressTheory = (Math.sqrt(3) / 2) * meanPlaneStrainLmn(p, e1);
      const C = (16 * (1 - p.nuRoll * p.nuRoll)) / (Math.PI * p.Eroll);
      const sigMean = (p.backTension + p.frontTension) / 2;
      d.stoneHMin = C * p.mu * p.R * Math.max(d.meanPlaneStrainStress - sigMean, 0);
      const Rb = this.hitchcockRadius();
      const aBite = Math.atan(p.mu);
      d.biteLimitH1 = p.h0 - 2 * Rb * (1 - Math.cos(aBite));
      d.biteLimitH1Cont = p.h0 - 2 * Rb * (1 - Math.cos(2 * aBite));
    }

    d.feedReaction = this.flow.feedReaction();
    d.feedFace = this.flow.feedFaceHeight();

    // roll flattening at the bite
    let flat = 0;
    {
      let best = Infinity, bnd = 0;
      for (let k = 0; k < this.roll.nt; k++) {
        const nd = this.roll.surfNodes[k];
        const dx = Math.abs(this.roll.X[2 * nd]);
        if (this.roll.X[2 * nd + 1] < this.cy && dx < best) { best = dx; bnd = nd; }
      }
      const rr = Math.hypot(
        this.roll.X[2 * bnd] + this.rollUrel[2 * bnd] - this.roll.cx,
        this.roll.X[2 * bnd + 1] + this.rollUrel[2 * bnd + 1] - this.cy);
      flat = p.R - rr;
    }
    d.rollFlattening = flat;
    {
      const Rp = this.hitchcockRadius();
      const hg = d.exitThicknessGap > 0 ? d.exitThicknessGap : this.h1Command;
      d.neutralAngle = d.neutralFound ? Math.atan2(Math.abs(d.neutralX), Rp) : 0;
      d.forwardSlipTheory = d.neutralFound && hg > 0
        ? (d.neutralX * d.neutralX) / (Rp * hg) : 0;
      d.neutralTheory = d.forwardSlip > 0 ? -Math.sqrt(d.forwardSlip * Rp * hg) : 0;
    }
    // Against the *command*, so the number keeps its meaning while the screws
    // move: 1 means the mill delivered the reduction that was asked for.
    const want = p.h0 - this.h1Command;
    d.reductionRatio = want > 0 ? (p.h0 - d.exitThickness) / want : 1;
    // Physical readouts: the screw a stand would show, and the spring
    // measured against it - flattening, springback and housing stretch.
    d.gapCommand = this.screwPosition;
    d.screwCommand = this.gapCmd - this.stretch;
    d.millSpring = d.exitThickness - this.screwPosition;
    d.gapLimitLo = this.gapLo() - this.stretch;
    d.gapLimitHi = this.gapHi() - this.stretch;
    // R' as Hitchcock would have it from this load - with the coupling on.
    // A rigid roll *is* radius R, and showing the estimate the load would
    // imply on a roll that is not flattening reads as a flattening that is
    // not there.
    const dh = Math.max(p.h0 - d.exitThickness, 1e-9);
    const C = (16 * (1 - p.nuRoll * p.nuRoll)) / (Math.PI * p.Eroll);
    d.hitchcockR = p.rollCoupling ? p.R * (1 + (C * Math.max(P, 0)) / dh) : p.R;
    void inp;
  }

  /**
   * Siebel / von Karman slab estimate: the friction hill lifts the mean
   * pressure above the plane-strain flow stress by a factor set by mu*L/h.
   */
  /**
   * Radius the bite geometry actually presents. With the elastic roll coupled
   * in, that is the flattened radius, not the ground one - which is the whole
   * reason a cold mill quotes R'.
   */
  private hitchcockRadius(): number {
    return this.params.rollCoupling
      ? Math.max(this.diag.hitchcockR, this.params.R)
      : this.params.R;
  }

  /**
   * The slab estimate for the theory panel: the selected theory (see
   * `slab.ts`), with tension, evaluated at the radius the FEM is actually
   * rolling with - so the comparison isolates the friction-hill model from
   * the flattening. Without the hook (no app around the solver) the Siebel
   * form is written out here.
   */
  slabMethod(): { load: number; meanPressure: number; arc: number; torque: number; kf: number } {
    const p = this.params;
    const h1 = this.diag.exitThickness > 0 ? this.diag.exitThickness : this.h1Command;
    const dh = p.h0 - h1;
    if (dh <= 0) return { load: 0, meanPressure: 0, arc: 0, torque: 0, kf: 0 };
    const R = this.params.rollCoupling ? this.diag.hitchcockR : p.R;
    if (slabHook) {
      const pt = slabHook(p, {
        h0: p.h0, h1, R: p.R, backTension: p.backTension, frontTension: p.frontTension,
        entryStrain: this.entryStrain,
      }, p.mu, R);
      return {
        load: pt.load, meanPressure: pt.meanPressure, arc: pt.arc,
        torque: Number.isFinite(pt.torque) ? Math.abs(pt.torque) : pt.meanPressure * pt.arc * pt.arc * 0.5,
        kf: pt.kf,
      };
    }
    const Lc = Math.sqrt(R * dh);
    const hm = (p.h0 + h1) / 2;
    // Strain-averaged kf over the strain *this* stand spans, starting from
    // what the strip arrived with - see `meanPlaneStrainLmnRange`.
    const e0 = Math.max(this.entryStrain, 0);
    const eps = e0 + (2 / Math.sqrt(3)) * Math.log(p.h0 / h1);
    const kf = meanPlaneStrainLmnRange(p, e0, eps);
    const a = (p.mu * Lc) / hm;
    const Qp = a > 1e-6 ? (Math.exp(a) - 1) / a : 1;
    const pm = kf * Qp;
    return { load: pm * Lc, meanPressure: pm, arc: Lc, torque: pm * Lc * Lc * 0.5, kf };
  }

  /* ─────────────────────────────────────────────────────────── fields ──── */

  computeField(kind: FieldKind): { min: number; max: number } {
    const p = this.params;
    const out = this.nodeField;
    const m = this.flow.mesh;
    const off = this.roll.nn;

    // roll block: elastic von Mises from the (relaxed) displacement field
    const nu = p.nuRoll;
    const mu = p.Eroll / (2 * (1 + nu));
    const lam = (p.Eroll * nu) / ((1 + nu) * (1 - 2 * nu));
    const acc = this.accR, wsum = this.wR;
    acc.fill(0); wsum.fill(0);
    let rollPeak = 0;
    const dN = this.rollElem.dN;
    for (let e = 0; e < this.roll.ne; e++) {
      let sxx = 0, syy = 0, sxy = 0;
      for (let g = 0; g < 4; g++) {
        const gb = 32 * e + 8 * g;
        let exx = 0, eyy = 0, gxy = 0;
        for (let k = 0; k < 4; k++) {
          const nd = this.roll.quads[4 * e + k];
          const ux = this.rollUrel[2 * nd], uy = this.rollUrel[2 * nd + 1];
          const gx = dN[gb + 2 * k], gy = dN[gb + 2 * k + 1];
          exx += gx * ux; eyy += gy * uy; gxy += gy * ux + gx * uy;
        }
        sxx += lam * (exx + eyy) + 2 * mu * exx;
        syy += lam * (exx + eyy) + 2 * mu * eyy;
        sxy += mu * gxy;
      }
      sxx *= 0.25; syy *= 0.25; sxy *= 0.25;
      const szz = nu * (sxx + syy);
      const vm = Math.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * sxy * sxy);
      if (vm > rollPeak) rollPeak = vm;
      let val: number;
      switch (kind) {
        case 'pressure': val = -(sxx + syy + szz) / 3; break;
        case 'shear': val = Math.hypot((sxx - syy) / 2, sxy); break;
        case 'vonMises': val = vm; break;
        default: val = 0;   // strip quantities, and the displacement fields
      }                     // which are read straight off the nodes below
      const w = this.rollElem.area[e];
      for (let k = 0; k < 4; k++) {
        const nd = this.roll.quads[4 * e + k];
        acc[nd] += val * w; wsum[nd] += w;
      }
    }
    this.diag.rollPeakVm = rollPeak;
    for (let i = 0; i < this.roll.nn; i++) {
      const dx = this.roll.X[2 * i] - this.roll.cx;
      const dy = this.roll.X[2 * i + 1] - this.cy;
      const ux = this.rollUrel[2 * i], uy = this.rollUrel[2 * i + 1];
      switch (kind) {
        case 'speed':
          out[i] = Math.abs(p.omega) * Math.hypot(dx, dy);
          break;
        case 'rollDisp':
          out[i] = Math.hypot(ux, uy);
          break;
        case 'rollRadial': {
          // outward positive, so barrel flattening reads as a negative lobe
          const r = Math.hypot(dx, dy) || 1;
          out[i] = (ux * dx + uy * dy) / r;
          break;
        }
        default:
          out[i] = wsum[i] > 0 ? acc[i] / wsum[i] : 0;
      }
    }

    // strip block
    const sacc = this.accS, swsum = this.wS;
    sacc.fill(0); swsum.fill(0);
    if (kind === 'pressure' || kind === 'shear' || kind === 'vonMises') {
      for (let e = 0; e < m.ne; e++) {
        const o = 4 * e;
        const sxx = this.flow.elemStress[o], syy = this.flow.elemStress[o + 1];
        const sxy = this.flow.elemStress[o + 2], hyd = this.flow.elemStress[o + 3];
        let val: number;
        if (kind === 'pressure') val = -hyd;
        else if (kind === 'shear') val = Math.hypot((sxx - syy) / 2, sxy);
        else {
          const szz = hyd;
          val = Math.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * sxy * sxy);
        }
        for (let k = 0; k < 4; k++) {
          const nd = m.quads[4 * e + k];
          sacc[nd] += val; swsum[nd] += 1;
        }
      }
    }
    for (let i = 0; i < m.nn; i++) {
      let val: number;
      switch (kind) {
        case 'strain': val = this.strain[i]; break;
        case 'strainRate': val = this.strainRateNode[i]; break;
        case 'flowStress': val = this.sigmaF[i]; break;
        case 'temperature': val = this.temp[i]; break;
        case 'speed': val = Math.hypot(this.flow.v[2 * i], this.flow.v[2 * i + 1]); break;
        // the strip is rigid-plastic: it carries no elastic displacement
        case 'rollDisp': case 'rollRadial': val = 0; break;
        default: val = swsum[i] > 0 ? sacc[i] / swsum[i] : 0;
      }
      out[off + i] = val;
    }

    // Range over the body the field actually lives on; the other one is drawn
    // in plain steel and its zeros would otherwise drag the scale.
    const rollOnly = kind === 'rollDisp' || kind === 'rollRadial';
    const stripOnly = kind === 'strain' || kind === 'strainRate'
      || kind === 'flowStress' || kind === 'speed' || kind === 'temperature';
    const lo = rollOnly ? 0 : stripOnly ? off : 0;
    const hi = rollOnly ? this.roll.nn : out.length;
    let mn = Infinity, mx = -Infinity;
    for (let i = lo; i < hi; i++) {
      if (out[i] < mn) mn = out[i];
      if (out[i] > mx) mx = out[i];
    }
    return { min: mn, max: mx };
  }
}

/**
 * Johnson-Cook thermal softening, as a factor on the isothermal flow stress.
 *
 *     1 - T*^m,   T* = (T - T_entry) / (T_melt - T_entry)
 *
 * The datum is the *entry* temperature rather than room temperature, so the
 * factor is exactly 1 on the incoming strip whatever it comes in at, and the
 * mode isolates the softening the pass generates for itself. That makes it an
 * honest A/B against the isothermal solve, and it means a hot-rolling entry of
 * 1000 degC does not arrive pre-softened by a number nobody typed.
 *
 * Floored well above zero: a rigid-viscoplastic solve with a vanishing flow
 * stress has no stiffness left and the velocity field stops being defined.
 */
export function thermalFactor(p: RollingParams, T: number): number {
  if (!p.heatOn) return 1;
  const span = Math.max(p.tempMelt - p.tempEntry, 1);
  const th = Math.max(0, Math.min(1, (T - p.tempEntry) / span));
  return Math.max(0.05, 1 - Math.pow(th, Math.max(p.softenExp, 1e-3)));
}

/**
 * Plane-strain deformation resistance, kf = L (eps + M)^N [Pa], softened by
 * the temperature the particle has reached.
 *
 * `T` defaults to the entry temperature, i.e. to no softening, so a caller
 * that has a strain but no temperature to go with it gets the isothermal curve
 * rather than a wrong one.
 */
export function planeStrain(p: RollingParams, eps: number, T = p.tempEntry): number {
  return p.lmnL * Math.pow(Math.max(eps, 0) + Math.max(p.lmnM, 0), p.lmnN)
    * thermalFactor(p, T);
}

/** The same as the uniaxial flow stress the solve carries, sigma_f = kf sqrt(3)/2. */
export function uniaxial(p: RollingParams, eps: number, T = p.tempEntry): number {
  return (Math.sqrt(3) / 2) * planeStrain(p, eps, T);
}

/**
 * Strain-averaged kf over 0..eps1 - the mean deformation resistance a rolling
 * load formula wants, since the material enters unworked and only reaches the
 * exit value at the very end.
 *
 *     (1/e1) INT_0^e1 L (e+M)^N de = L [ (e1+M)^(N+1) - M^(N+1) ] / ((N+1) e1)
 */
export function meanPlaneStrainLmn(p: RollingParams, eps1: number): number {
  return meanPlaneStrainLmnRange(p, 0, eps1);
}

/**
 * The same average, but over the strain this pass actually spans.
 *
 *     (1/(e1-e0)) INT_e0^e1 L (e+M)^N de
 *       = L [ (e1+M)^(N+1) - (e0+M)^(N+1) ] / ((N+1)(e1-e0))
 *
 * The lower limit is the point of it. Averaging from zero says the strip
 * arrives unworked, which is true only of the first stand: on a tandem line
 * every stand after it is handed metal that has already been hardened, and
 * the mean resistance across its bite starts from that value rather than from
 * the annealed one.
 *
 * The error this fixes is not small. Three stands each taking 25 % all span
 * the same strain increment, so averaging from zero gave all three the same
 * 740 MPa - while the material they are actually working sits at 813, 1052
 * and 1188 MPa. Every load formula in the app was reading the second stand's
 * resistance as if it were the first's.
 */
export function meanPlaneStrainLmnRange(
  p: RollingParams, eps0: number, eps1: number,
): number {
  const M = Math.max(p.lmnM, 0);
  const e0 = Math.max(eps0, 0);
  const e1 = Math.max(eps1, e0);
  const n1 = p.lmnN + 1;
  // Degenerate span: no strain is added here, so the mean is the value at the
  // point itself rather than a ratio of two vanishing quantities.
  if (e1 - e0 <= 1e-12) return planeStrain(p, e0);
  return (p.lmnL * (Math.pow(e1 + M, n1) - Math.pow(e0 + M, n1))) / (n1 * (e1 - e0));
}

function emptyDiag(): RollingDiagnostics {
  return {
    rollForce: 0, loadFem: 0, loadModel: 'fem', slabStatus: 'ok', forwardSlipSlab: NaN, neutralXSlab: NaN,
    arcLengthSlab: NaN, kfSlab: NaN, torque: 0, power: 0, peakPressure: 0, meanPressure: 0,
    arcLength: 0, arcIn: 0, arcOut: 0, contactNodes: 0, neutralX: 0,
    neutralFound: false, entrySpeed: 0, exitSpeed: 0, forwardSlip: 0,
    backwardSlip: 0, neutralAngle: 0, forwardSlipTheory: 0, neutralTheory: 0,
    massBalance: 1,
    entryThickness: 0, exitThickness: 0, exitStrain: 0, peakStrain: 0,
    exitFlowStress: 0, meanFlowStress: 0, meanPlaneStrainStress: 0,
    meanFlowStressTheory: 0, peakStrainRate: 0, rollFlattening: 0, hitchcockR: 0,
    stoneHMin: 0, biteLimitH1: 0, biteLimitH1Cont: 0,
    rollPeakVm: 0, feedReaction: 0, feedFace: 0, picardDelta: 0, cgIterations: 0, cgResidual: 0,
    couplingResidual: 0, relaxScale: 1, reductionRatio: 1,
    feedResidual: 0, feedFloor: 0, meshResidual: 0,
    elasticEntryLen: 0, elasticExitLen: 0, plasticArcLen: 0,
    elasticEntryTheory: 0, elasticEntryHertz: 0,
    springback: 0, exitThicknessGap: 0, elasticEntryCompression: 0,
    gapCommand: 0, screwCommand: 0, millSpring: 0, millStretch: 0, millResidual: 0,
    gapLimitLo: 0, gapLimitHi: 0,
    agcMeasured: 0, agcError: 0, agcSettled: false,
    agcSaturated: false, agcStalled: false, agcIdle: false, agcSensitivity: 0,
    agcIterations: 0, agcPlasticSlope: 0,
    entryStrain: 0, entryTemp: 0,
    exitTemp: 0, tempRise: 0, peakTemp: 0, thermalSoftening: 0,
  };
}
