/**
 * The roll-stack solve: every roll a Timoshenko beam along the width, held
 * to its neighbours by Hertz line contacts and to the housing by its
 * supports, the strip a row of slab passes under the work roll.
 *
 * One Newton iteration per call, so the state advances a little every frame
 * and the picture is live; a change to any input just makes the next
 * iterations move. Unknowns are the nodal displacements of every roll,
 * (v, θ_v, w, θ_w) at each station - deflection and slope in the vertical
 * plane and across the pass line. All rolls share one grid of stations - even,
 * or finer on the strip (see `grid.ts`) - so a contact between two rolls
 * couples only the two nodes at the same station, and numbering station by
 * station keeps the whole system inside a band a few hundred wide (see
 * `band.ts`). A vertical stack (2Hi, 4Hi, 6Hi)
 * has no contact that couples the two planes, so its v and w unknowns are
 * numbered as two separate blocks, each station by station: the band is
 * then half as wide and the factorisation a quarter of the work.
 *
 * In gauge or force control the screw position joins the Newton as one
 * more unknown, with the control target as its equation, and the bordered
 * system is solved with the band factorisation (see `iterate`); the band
 * matrix itself stays symmetric positive definite.
 *
 * A symmetric mill is solved as its upper half, the strip's mid-plane
 * standing in for the lower one: the gap is twice the upper work roll's
 * surface. A stack with a shifted roll (see `Stack.lower`) has no such
 * plane, and its lower half is solved too - as more rolls on the same
 * stations, numbered after the upper ones, so the strip's coupling of the
 * two work rolls at one station stays inside the band. The gap is then the
 * sum of the two surfaces, and every place that reads the gap goes through
 * `gapAt`.
 */

import { BandMatrix, denseSolve, luFactor, luSolve } from './band';
import { stationGrid, nearestStation, type StationGrid } from './grid';
import { housingCompliance, halfStiffness, sideStiffness, housingPlan, housingInScope } from './housing';
import { nonlocalOffsets } from './flatnl';
import { makeContactLaw, loadAt, approach, approachParts, type ContactLaw } from './contact';
import { ringInfluence, type RingInfluence } from './ring';
import { StripFem, atNodes, type StripFemResult } from './stripfem';
import { StripFem3D } from './stripfem3d';
import {
  sliceLoad, sliceTension, springback, kfMean, kfExitOf, kfAt, TENSION_CAP, type StripLaw,
} from './strip';
import {
  buildStack, solvedRolls, radiusProfile, onBarrel, saddleXs, type Params3D, type Stack, type RollDef,
} from './stack';

const DOF = 4;
/** shear correction factor of a solid circular section */
const KAPPA = 0.886;
/** a spring on every node, to pin rigid modes of a roll whose contacts are all open [N/m] */
const K_REG = 2e4;
/** the chock guides across the pass line [N/m] */
const K_GUIDE = 2e9;
/** the chock's own vertical compliance (a bender-held roll is otherwise free in y) [N/m] */
const K_CHOCK_Y = 1e6;
/** the most any node may move in one Newton step [m] */
const STEP_CLIP = 0.25e-3;
/** the softest an active contact is allowed to look to the Jacobian [N/m²] */
const KT_FLOOR = 1e9;
/** the slice's load fixed point is solved to this fraction of the load (see `sliceCore`) */
const SLICE_TOL = 1e-9;
/** the thinnest exit a slice may report, as a fraction of its entry thickness */
const H_MIN_FRAC = 0.05;
/** the residual is measured against the largest force in play, but never against less than this [N] */
const F_SCALE_FLOOR = 1e4;
/** the screw's travel [m]: negative is opened past the touching position */
const SCREW_MIN = -10e-3;
const SCREW_MAX = 20e-3;
/** outer iterations after which a solve that has not settled is called stuck (the coupled strip FEM needs several times more) */
const STUCK_ITERS = 150;
const STUCK_ITERS_FEM = 800;
const NO_LOAD = { q: 0, arc: 0, runaway: false } as const;
/** the FEM correction's change (load ratio, or elongation × 50) under which the coupled solve is taken as settled */
const FEM_FIXED_TOL = 2e-3;
/** relaxation of that correction between outer solves */
const FEM_RELAX = 0.3;
/** rounds the correction has to stay within ten times the tolerance to count as settled */
const FEM_LOOSE_RUNS = 6;
/**
 * Bounds on the correction's load ratio (FEM load over slab load). They are
 * a guard against a broken FEM answer, not a limit on the physics: at
 * 0.5-2.5 they held 38 of the 202 stress cases (27 of them converged, the
 * 2Hi default among them - the centre of its strongly crowned strip carries
 * 0.45 of its slab load); at 0.1-5 the converged cases settle between 0.12
 * and 4.6, and no case is lost.
 */
const FEM_RATIO_MIN = 0.1;
const FEM_RATIO_MAX = 5;
/** outer iterations at one screw position after which a nearly settled Newton lets the screw move */
const STEP_ESCAPE_ITERS = 60;
/** the Newton is settled under this residual and this largest update [m]; it may escape to a correction round under `NEAR_SETTLED` */
const SETTLED_RESIDUAL = 2e-6;
const SETTLED_STEP = 5e-9;
const NEAR_SETTLED = 1e-2;

/**
 * The convergence rules `advance` applies, for anything that has to reason
 * about how far a solve still has to go (see `eta.ts`).
 */
export const CONVERGENCE = {
  residual: SETTLED_RESIDUAL,
  step: SETTLED_STEP,
  nearSettled: NEAR_SETTLED,
  escapeIters: STEP_ESCAPE_ITERS,
  stepClip: STEP_CLIP,
  femTol: FEM_FIXED_TOL,
  femLooseTol: 10 * FEM_FIXED_TOL,
  femLooseRuns: FEM_LOOSE_RUNS,
} as const;

/** where a solve stands, as `StackSolver.progress` reports it */
export interface SolveProgress {
  /** which solve this is: counts up every time the inputs change */
  solve: number;
  /** outer Newton iterations since the inputs last changed */
  iterations: number;
  /** the last iteration's relative force residual and largest update [m] */
  residual: number;
  stepMax: number;
  /** whether the strip model runs correction rounds (the FEMs) at all */
  usesFem: boolean;
  /** correction rounds run at the current screw position, and the last one's change */
  rounds: number;
  femChange: number;
  /** rounds in a row the change has been under the loose tolerance */
  looseRuns: number;
  /** iterations since the last round (or since the screw last moved) */
  sinceRound: number;
  /** the solve started from a kept correction (a dial change on the same mesh), not from scratch */
  warm: boolean;
  converged: boolean;
}
/**
 * Anderson acceleration of the FEM correction (see `andersonStep`): the
 * history depth, the residual growth that restarts it, the largest mixing
 * coefficient it may use, and the weight of the elongation offsets against
 * the load ratios in its residual.
 */
const AA_DEPTH = 4;
const AA_RESTART_GROWTH = 2;
const AA_MAX_GAMMA = 20;
const AA_EPS_SCALE = 50;
/** merit weights of the control target against the force residual, so their tolerances line up */
const MERIT_GAUGE = 1e-2;
const MERIT_FORCE = 1e-3;
/**
 * How the outer Newton carries the strip's tension coupling (see `stripSolve`):
 * 'full' is the exact Woodbury update (m banded solves an iteration, which on
 * a 20Hi is most of the cost), 'diag' folds only the diagonal of the coupling
 * into the band, 'none' leaves it lagged.
 */
const TENSION_COUPLING = 'full' as 'none' | 'diag' | 'full';
/** iterations the Woodbury flexibility Y = K⁻¹U is reused for; the update is a correction, and a slightly stale one still converges */
const Y_REUSE = 3;
const USE_WOODBURY = TENSION_COUPLING === 'full';

/**
 * The incoming strip's thickness at x, |x| ≤ width/2 [m]: the crown's parabola, h₀ − C·(2x/W)²,
 * less the edge drop D, which runs over a band b = `entryEdgeDropWidth` in from each edge (b at
 * most half the width) and at a distance d from the nearer edge is D·(1 − d/b)² - all of D at
 * the edge, falling off to nothing at the band's inner end with no kink there. A slice takes the
 * value at its station, as it always took the parabola's.
 */
export function entryThickness(p: Params3D, x: number): number {
  const t = (2 * x) / p.width;
  const h = p.h0 - p.entryCrown * t * t;
  const band = Math.min(p.entryEdgeDropWidth, p.width / 2);
  if (!(p.entryEdgeDrop !== 0 && band > 0)) return h;
  const u = Math.min(1, Math.max(0, 1 - (p.width / 2 - Math.abs(x)) / band));
  return h - p.entryEdgeDrop * u * u;
}

/**
 * The stress of a buckled strip slice at a free stress f below the buckling limit −σcr (see
 * `stripSolve`), and the law's slope: −σcr + k(f + σcr) on the linear law, −√(σcr² + k·σcr·(−σcr − f))
 * on the effective width's, never below −hi. k = 0 is the clamp at −σcr.
 */
function postBuckled(f: number, sigmaCr: number, hi: number, k: number, effectiveWidth: boolean): { stress: number; slope: number } {
  const lo = -sigmaCr;
  const v = effectiveWidth ? -Math.sqrt(lo * lo + k * sigmaCr * Math.max(0, lo - f)) : lo + k * (f - lo);
  if (v <= -hi) return { stress: -hi, slope: 0 };
  return { stress: v, slope: effectiveWidth ? (v < 0 ? (k * sigmaCr) / (2 * -v) : 0) : k };
}

export interface RollState {
  def: RollDef;
  /** first and last station the roll spans */
  ia: number;
  ib: number;
  /** bearing / saddle stations */
  supports: number[];
  /** radius deviation per station [m] */
  prof: Float64Array;
  /** barrel flag per station */
  barrel: Uint8Array;
  /** vertical deflection per station (NaN outside the roll) [m] */
  v: Float64Array;
  /** across-pass-line deflection [m] */
  w: Float64Array;
  /** reaction at each support [N], + up */
  reactions: number[];
  /** the axis bow: v at the barrel centre minus the mean of v at the barrel ends [m] (+ = centre higher) */
  bow: number;
  /** the largest vertical deflection along the roll, signed [m] */
  vMax: number;
  /** the roll's own largest compression at any of its contacts [m] */
  flatMax: number;
  /** curvature of the axis per station, vertical and across [1/m] (NaN outside the roll) */
  kv: Float64Array;
  kw: Float64Array;
  /** largest bending fibre stress on the barrel [Pa] */
  bendMax: number;
  /** largest Hertz peak pressure at any of its contacts [Pa] */
  hertzMax: number;
}

export interface ContactState {
  a: number;
  b: number;
  ny: number;
  nz: number;
  law: ContactLaw;
  /** per station: contact width weight [m], 0 outside */
  weight: Float64Array;
  /** Hertz peak pressure per station [Pa] */
  p0: Float64Array;
  /** load per width [N/m] */
  q: Float64Array;
  /** approach (both bodies) [m] */
  delta: Float64Array;
  /** each body's share of the approach [m] */
  dA: Float64Array;
  dB: Float64Array;
  /** total force [N] */
  total: number;
}

export type Warning3D = 'stone' | 'bite' | 'gapClosed' | 'tensionYield' | 'stuck' | 'target' | 'layout' | 'openContact' | 'fem' | 'wrTouch' | 'stripWide' | 'housingScope' | 'housingStrip';
export const WARNING_TEXT: Record<Warning3D, string> = {
  stone: 'Stone 限界: 扁平が先行し圧下できない（板厚に対してロール径が大きい）',
  bite: '噛み込み限界超過 (μ < tan α)',
  gapClosed: 'ロールギャップが閉じている（圧下位置が深すぎる）',
  tensionYield: '張力が降伏に近い（変形抵抗の 70% 超）',
  stuck: '未収束（残差が下がらない）',
  target: '制御目標に届かない',
  layout: 'ロール配置が成立していない（端面図の赤い線）',
  openContact: '上下のロールが離れている接触がある（端面図の破線）',
  fem: '材料 FEM が反復上限で打ち切り（結果は近似）',
  wrTouch: '板の外で上下のワークロール同士が接触している（対称モデルは考慮しない — 荷重配分が実機と変わる）',
  stripWide: '板幅が WR 胴長より長い（胴からはみ出した板は圧延されず、計算にも入らない）',
  housingScope: 'ハウジング変形考慮モードは 2Hi・4Hi・6Hi だけ（このミルは今の支持のまま解いている）',
  housingStrip: '板幅がハウジングのポスト内面の間隔（操作側–駆動側）より広い — 板がポストに当たる（側面図の赤いポスト）',
};

export interface Result3D {
  x: Float64Array;
  rolls: RollState[];
  contacts: ContactState[];
  /** strip, per station (NaN off the strip) */
  h0: Float64Array;
  h1: Float64Array;
  /** rolling load per width on the strip [N/m] */
  q: Float64Array;
  /** work-roll flattening at the strip [m] */
  flat: Float64Array;
  /** elongation relative to the mean, after lateral flow [-] */
  dEps: Float64Array;
  /** the part of dEps the strip could not carry as stress - a wave [-] */
  manifest: Float64Array;
  /** front tension [Pa] */
  sigmaF: Float64Array;
  /** total rolling force [N] */
  force: number;
  /** mean exit thickness [m] */
  h1Mean: number;
  /** thickness at centre, and crown / wedge / edge drop [m] */
  h1Centre: number;
  crown: number;
  wedge: number;
  edgeDropL: number;
  edgeDropR: number;
  /** the entry's crown and edge drop as the exit's are read (the entry is symmetric: both edges' mean) [m] */
  crown0: number;
  edgeDrop0: number;
  /** how much the tension lowers the yield pressure: σ̄t / k̄f over the loaded slices (0 with the feedback off; the equivalent tension with the tensions split) */
  yieldRelief: number;
  /**
   * The elongation profile as shown and summarised: at the stations on the strip and at the
   * strip's two edges, the latent elongation smoothed as the slices' `dEps` is, but over every
   * slice by its weight, and the wave from it (where it passes the elongation the strip buckles
   * at). Unlike `dEps` and `manifest`, read at the slices, it is continuous as the strip widens
   * (see `collect`). [m] / [-] / [-]
   */
  profile: { x: Float64Array; latent: Float64Array; wave: Float64Array };
  /** flatness, as the peak-to-peak of `profile`'s latent elongation and the largest wave [I-units = 1e-5] */
  latentIU: number;
  manifestIU: number;
  screw: number;
  /** the last Newton step's residual norm and largest displacement update */
  residual: number;
  stepMax: number;
  iterations: number;
  converged: boolean;
  /** what is wrong with this pass, if anything - keys, see `WARNING_TEXT` */
  warnings: Warning3D[];
  /** the layout's own complaints, spelled out (see `layoutIssues`) */
  notes: string[];
  /** the strip FEM's last solution, when that model is on */
  fem: StripFemResult | null;
  /** arc of contact per station [m] (NaN off the strip) */
  arc: Float64Array;
  /** the rigid gap between the upper and lower work-roll surfaces at stations off the strip [m]; ≤ 0 means the rolls touch (NaN on the strip and off the barrel) */
  wrGap: Float64Array;
  /** last solve time [ms] */
  solveMs: number;
  dof: number;
  bandwidth: number;
  /** the housing deformation mode's frame and seats (see `housing.ts`); null with the mode off or out of its scope */
  housing: HousingResult | null;
}

export interface HousingSide {
  /** the load on this side's housing: the mean of its top and bottom chock loads [N] */
  force: number;
  /** stretch of the posts [m] */
  post: number;
  /** mid-span deflection of the top and the bottom crosshead [m] */
  crossheadTop: number;
  crossheadBottom: number;
  /** how far the window opens between the two chock seats: posts plus both crossheads [m] */
  stretch: number;
}

export interface HousingResult {
  /** operator side (−x), drive side (+x) */
  sides: HousingSide[];
  /** the intermediate chock seats, compression [N]: upper −x, upper +x, lower −x, lower +x (on a mirror the lower two repeat the upper); empty when there are none */
  seatForces: number[];
  /** the upper screw roll's supports, +x minus −x vertical displacement [m] */
  burTilt: number;
  /** rolling force over the mean window opening [N/m] */
  millModulus: number;
}

interface SliceState {
  q: number;
  h1: number;
  flat: number;
  arc: number;
  runaway: boolean;
}

interface Slice {
  s: number;
  x: number;
  weight: number;
  h0: number;
  /** load per width, warm start */
  q: number;
  h1: number;
  flat: number;
  arc: number;
  /** is the tension pinned at the buckling or yield limit */
  clipped: boolean;
  /** tangents from the last slice solve */
  dh1dg: number;
  dh1ds: number;
  dqdg: number;
  dqds: number;
  /** the rigid gap the slice was last solved at */
  g: number;
  /** the pass at this slice has no steady solution (Stone's limit) */
  runaway: boolean;
  /** the non-local flattening mode's offset on this slice's own flattening [m], refreshed once per outer iteration */
  nlOff?: number;
}

export class StackSolver {
  p: Params3D;
  stack!: Stack;
  x!: Float64Array;
  /** the station spacing: off the strip, when the strip has its own (see `grid.ts`) */
  dx = 0;
  /** the stations' cells and element lengths (see `grid.ts`) */
  grid!: StationGrid;
  /** per unknown: the length a slope is scaled by in the step clip, its station's cell width (see `iterate`) */
  private slopeLen!: Float64Array;
  ns = 0;
  nr = 0;
  /** every roll solved: the upper half, then the lower half's when there is one (`upper` of them are the upper half's) */
  rolls: RollState[] = [];
  contacts: ContactState[] = [];
  /** how many of `rolls` are the upper half; the results show only those */
  upper = 0;
  /** housing mode: each side's top and bottom chock loads from the last assembly [N] */
  private housingLoads: [number, number][] = [];
  /** housing mode: the intermediate chock seats, from the last assembly (see `assembleHousing`) */
  private seats: { iv: number; ib: number; k: number; active: boolean; force: number }[] = [];
  /** the lower work roll in `rolls`, or -1 when the lower half is the upper one's mirror image */
  wrLower = -1;
  /** rolls whose supports the screw moves, both halves */
  private screwRolls: number[] = [];
  /**
   * The two planes numbered as separate blocks - every v-DOF, then every
   * w-DOF - which a stack whose contacts are all vertical allows (nothing
   * couples v to w): the band is 2·nr+1 wide instead of 4·nr+3. See `idx`.
   */
  private planes = false;
  /** where the w block starts (the number of v-DOFs), or the total when the planes are interleaved */
  private vEnd = 0;
  slices: Slice[] = [];
  u!: Float64Array;
  private K!: BandMatrix;
  private rhs!: Float64Array;
  private du!: Float64Array;
  private scratch!: Float64Array;
  private Ybuf: Float64Array | null = null;
  /** iterations since Y was last computed; negative forces a recompute */
  private yAge = -1;
  private uTrial!: Float64Array;
  /** per slice: dq/dσf from the last assembly [N/m per Pa] */
  private dqds!: Float64Array;
  /** per slice: dσf_i/dv_j, the strip's tension coupling in slice space [Pa/m], row-major */
  private T!: Float64Array;
  /** any slice carrying tension feedback at all */
  private tensionLive = false;
  /** the non-local flattening offsets are on the slices, and how far they moved at the last refresh [m] */
  private nlLive = false;
  private nlChange = 0;
  /** the stack's response to a unit screw move, −∂(residual)/∂S, built with the tangent */
  private bScrew!: Float64Array;
  private x2!: Float64Array;
  private duPlain!: Float64Array;
  /** the Anderson history of the FEM correction: scaled iterates and their residuals */
  private aaX: Float64Array[] = [];
  private aaF: Float64Array[] = [];
  /** the control target's residual, scaled - reported alongside the force residual */
  targetResidual = 0;
  /** profiling counters, when set */
  counters: { coreIts: number; coreCalls: number; coreCap: number; rounds: number; inner: number; stripCalls: number } | null = null;
  /** last iteration's line-search record */
  debug: { alpha: number; res0: number; res: number; mx: number; tries: number } | null = null;
  private law!: StripLaw;
  wsLaw!: ContactLaw;
  screw = 0;
  private sigmaF!: Float64Array;
  private dEps!: Float64Array;
  private manifest!: Float64Array;
  private sliceW!: Float64Array;
  private secant: { s: number; y: number } | null = null;
  result!: Result3D;
  private geomKey = '';
  /** ring influence functions by their inputs; a roll's is rebuilt only when one of them changes */
  private rings = new Map<string, RingInfluence>();
  /** the strip FEM and its last result (strip model 'fem') */
  private fem = new StripFem();
  private fem3d = new StripFem3D();
  femResult: StripFemResult | null = null;
  /** correction rounds since the screw last moved, and rounds in a row the correction has been loosely settled */
  private femRounds = 0;
  private femLooseRuns = 0;
  /** outer iterations since the screw last moved */
  private sinceStep = 0;
  /** the last correction round's change, for diagnostics */
  femLastChange = 0;
  /** this solve started from the last one's correction (see `setParams`) */
  private warmStart = false;
  /** solves started so far: one more for every change of inputs */
  private solveCount = 0;
  private iterations = 0;
  private residual = Infinity;
  private stepMax = Infinity;
  private converged = false;
  private forceTotal = 0;
  private h1Mean = 0;

  constructor(p: Params3D) {
    this.p = p;
    this.rebuild();
  }

  /** apply new inputs; the mesh is rebuilt only when the geometry changed */
  setParams(p: Params3D): void {
    this.p = p;
    const key = geometryKey(p);
    const newMesh = key !== this.geomKey;
    if (newMesh) this.rebuild();
    else this.refreshProfiles();
    this.converged = false;
    this.yAge = -1;
    this.iterations = 0;
    // The strip FEM's correction is kept across a change that keeps the
    // mesh: it depends smoothly on the inputs, and restarting it from one
    // threw away most of the last solve's work (re-convergence after a
    // dial change took up to twice as long). A new mesh starts it over.
    if (newMesh) { this.femRatio = null; this.femEps = null; }
    this.warmStart = this.femRatio !== null;
    this.solveCount++;
    this.aaX = []; this.aaF = [];
    this.sinceStep = 0; this.femRounds = 0; this.femLooseRuns = 0;
  }

  private rebuild(): void {
    const p = this.p;
    const previousType = this.stack?.type;
    this.geomKey = geometryKey(p);
    // A new mesh starts the strip FEM over (see `setParams`): its last solution is the old
    // mesh's - it used to be reported, and drawn on the new mesh's axes, until the first
    // correction round of the new solve replaced it.
    this.femResult = null;
    this.femLastChange = 0;
    this.stack = buildStack(p);
    const full = solvedRolls(this.stack);
    const rolls = full.rolls;
    this.upper = full.upper;
    this.wrLower = full.wrLower;
    this.screwRolls = full.screwRolls;
    // the grid spans the longest support span, plus whatever a shift pushes out
    let half = 0;
    for (const r of rolls) half = Math.max(half, r.Ls / 2 + Math.abs(r.shift), r.Lb / 2 + Math.abs(r.shift));
    half = Math.max(half, p.width / 2 * 1.05);
    this.grid = stationGrid(half, p.stations, p.width, p.stripStations);
    this.x = this.grid.x;
    this.ns = this.x.length;
    this.nr = rolls.length;
    this.dx = this.grid.dx;
    const n = this.ns * this.nr * DOF;
    this.planes = full.contacts.every((c) => Math.abs(c.nz) < 1e-12);
    this.vEnd = this.planes ? this.ns * this.nr * 2 : n;
    this.u = new Float64Array(n);
    this.K = new BandMatrix(n, this.planes ? 2 * this.nr + 1 : this.nr * DOF + DOF - 1);
    this.rhs = new Float64Array(n);
    this.du = new Float64Array(n);
    this.scratch = new Float64Array(n);
    this.uTrial = new Float64Array(n);
    this.bScrew = new Float64Array(n);
    this.x2 = new Float64Array(n);
    this.duPlain = new Float64Array(n);
    this.slopeLen = new Float64Array(n);
    for (let s = 0; s < this.ns; s++) {
      for (let r = 0; r < this.nr; r++) {
        this.slopeLen[this.idx(s, r, 1)] = this.grid.cellW[s];
        this.slopeLen[this.idx(s, r, 3)] = this.grid.cellW[s];
      }
    }
    // The screw carries over as a warm start for a changed dimension, but
    // not to another mill type: a 4Hi's 2.5 mm closure driven into a 20Hi
    // stack starts the search deep in a closed gap.
    this.screw = p.mode === 'screw' ? p.screw : previousType === p.mill ? this.screw : 0;
    this.secant = null;

    this.rolls = rolls.map((def) => {
      const prof = new Float64Array(this.ns);
      const barrel = new Uint8Array(this.ns);
      const st = this.stationOf;
      const ia = st(def.shift - def.Ls / 2), ib = st(def.shift + def.Ls / 2);
      const supports: number[] = [];
      if (def.support === 'saddle') {
        for (const xs of saddleXs(def)) supports.push(st(xs));
      } else {
        supports.push(ia, ib);
      }
      return {
        def, ia, ib, supports, prof, barrel,
        v: new Float64Array(this.ns).fill(NaN), w: new Float64Array(this.ns).fill(NaN),
        reactions: supports.map(() => 0),
        bow: 0, vMax: 0, flatMax: 0,
        kv: new Float64Array(this.ns).fill(NaN), kw: new Float64Array(this.ns).fill(NaN), bendMax: 0, hertzMax: 0,
      };
    });
    this.contacts = full.contacts.map((c) => {
      const A = rolls[c.a], B = rolls[c.b];
      return {
        a: c.a, b: c.b, ny: c.ny, nz: c.nz,
        law: makeContactLaw(A.E, A.nu, A.D / 2, B.E, B.nu, B.D / 2),
        weight: new Float64Array(this.ns), q: new Float64Array(this.ns), delta: new Float64Array(this.ns),
        dA: new Float64Array(this.ns), dB: new Float64Array(this.ns), p0: new Float64Array(this.ns),
        total: 0,
      };
    });
    this.sigmaF = new Float64Array(this.ns).fill(p.frontTension);
    this.dEps = new Float64Array(this.ns);
    this.manifest = new Float64Array(this.ns);
    this.sliceW = new Float64Array(this.ns);
    this.slices = [];
    this.refreshProfiles();
    this.result = this.emptyResult();
  }

  private stationOf = (x: number): number => (this.grid.uniform
    ? Math.max(0, Math.min(this.ns - 1, Math.round((x - this.x[0]) / this.dx)))
    : nearestStation(this.x, x));

  /** things that change without changing the mesh: profiles, strip width, laws */
  private refreshProfiles(): void {
    const p = this.p;
    this.stack = buildStack(p);
    const full = solvedRolls(this.stack);
    // a lower half appearing or going away is a new set of unknowns (the
    // inputs that do it are all in the geometry key; this is the backstop)
    if (full.rolls.length !== this.rolls.length) { this.rebuild(); return; }
    const rolls = full.rolls;
    this.screwRolls = full.screwRolls;
    this.rolls.forEach((r, i) => {
      r.def = rolls[i];
      r.def.benderForce = rolls[i].benderForce;
      for (let s = 0; s < this.ns; s++) {
        r.prof[s] = radiusProfile(r.def, this.x[s]);
        r.barrel[s] = onBarrel(r.def, this.x[s]) ? 1 : 0;
      }
    });
    const cell = (s: number): [number, number] => [this.grid.cellL[s], this.grid.cellR[s]];
    const overlap = (a: [number, number], b: [number, number]) =>
      Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
    for (const c of this.contacts) {
      const A = rolls[c.a], B = rolls[c.b];
      const ba: [number, number] = [A.shift - A.Lb / 2, A.shift + A.Lb / 2];
      const bb: [number, number] = [B.shift - B.Lb / 2, B.shift + B.Lb / 2];
      for (let s = 0; s < this.ns; s++) {
        const [c0, c1] = cell(s);
        let lo = Math.max(c0, ba[0], bb[0]), hi = Math.min(c1, ba[1], bb[1]);
        // a segmented backing shaft carries no contact in the gap at each
        // saddle: the cell's overlap with the gaps is taken out
        let w = Math.max(0, hi - lo);
        for (const r of [A, B]) {
          if (r.bearingGap <= 0 || w <= 0) continue;
          for (const xs of saddleXs(r)) {
            const g0 = xs - r.bearingGap / 2, g1 = xs + r.bearingGap / 2;
            w -= Math.max(0, Math.min(hi, g1) - Math.max(lo, g0));
          }
        }
        c.weight[s] = Math.max(0, w);
      }
    }
    for (const c of this.contacts) {
      c.law.ring1 = this.ringFor(rolls[c.a]);
      c.law.ring2 = this.ringFor(rolls[c.b]);
    }
    const wr = rolls[this.stack.wr];
    this.law = {
      lmnL: p.lmnL, lmnM: p.lmnM, lmnN: p.lmnN, E: p.Estrip, nu: p.nuStrip,
      entryStrain: p.entryStrain, mu: p.mu, tensionFeedback: p.tensionFeedback, R: wr.D / 2, Eroll: wr.E, nuRoll: wr.nu,
      slabTension: p.slabTension,
    };
    this.wsLaw = makeContactLaw(wr.E, wr.nu, wr.D / 2, p.Estrip, p.nuStrip, Infinity, { ring1: this.ringFor(wr) });
    // strip slices: stations whose cell overlaps the strip
    const strip: [number, number] = [-p.width / 2, p.width / 2];
    const old = new Map(this.slices.map((sl) => [sl.s, sl]));
    this.slices = [];
    this.sliceW.fill(0);
    for (let s = 0; s < this.ns; s++) {
      const w = overlap(cell(s), strip);
      if (w <= 0 || !wr || !onBarrel(wr, this.x[s])) continue;
      const xc = Math.max(strip[0], Math.min(strip[1], this.x[s]));
      const h0 = entryThickness(p, xc);
      const prev = old.get(s);
      this.slices.push({
        s, x: xc, weight: w, h0,
        q: prev?.q ?? 0, h1: prev?.h1 ?? h0 * (1 - p.reduction), flat: prev?.flat ?? 0,
        arc: prev?.arc ?? 0, clipped: prev?.clipped ?? false, dh1dg: prev?.dh1dg ?? 1, dh1ds: prev?.dh1ds ?? 0, dqdg: prev?.dqdg ?? 0, dqds: prev?.dqds ?? 0, g: prev?.g ?? h0, runaway: false,
      });
      this.sliceW[s] = w;
    }
    const m = this.slices.length;
    this.dqds = new Float64Array(m);
    this.T = new Float64Array(m * m);
    this.tensionLive = false;
  }

  /**
   * The unknown d (0 v, 1 θv, 2 w, 3 θw) of roll r at station s. Interleaved,
   * station by station and roll by roll; with `planes`, the same order within
   * each plane and the w plane after the v plane. Either way a displacement
   * sits at an even index and a slope at the odd one after it.
   */
  private idx(s: number, r: number, d: number): number {
    if (!this.planes) return (s * this.nr + r) * DOF + d;
    const k = (s * this.nr + r) * 2;
    return d < 2 ? k + d : this.vEnd + k + d - 2;
  }

  /**
   * The rigid gap between the work-roll surfaces at station s: twice the
   * upper roll's on a mirror, the upper and lower rolls' together when the
   * lower half is solved. Positive displacement is away from the strip on
   * both rolls.
   */
  private gapAt(s: number): number {
    const u = this.u, wr = this.stack.wr;
    const up = u[this.idx(s, wr, 0)] - this.rolls[wr].prof[s];
    if (this.wrLower < 0) return this.p.h0 + 2 * up;
    return this.p.h0 + up + u[this.idx(s, this.wrLower, 0)] - this.rolls[this.wrLower].prof[s];
  }

  /**
   * dg/dz, z the work-roll coordinate the strip terms are written in: the
   * upper roll's v on a mirror (the gap moves twice as far), the sum of the
   * two rolls' v when the lower half is solved.
   */
  private gapGain(): number { return this.wrLower < 0 ? 2 : 1; }

  /** the work-roll v-DOF of each slice, upper and (or -1) lower */
  private sliceDofs(sl: Slice): [number, number] {
    return [this.idx(sl.s, this.stack.wr, 0), this.wrLower < 0 ? -1 : this.idx(sl.s, this.wrLower, 0)];
  }

  /** k·(e_up + e_lo)(e_up + e_lo)ᵀ into the band, the strip's stiffness in the gap; on a mirror, k·gain on the one roll */
  private addGapStiffness(iv: number, ivL: number, k: number): void {
    if (ivL < 0) { this.K.add(iv, iv, 2 * k); return; }
    this.K.add(iv, iv, k); this.K.add(ivL, ivL, k); this.K.add(iv, ivL, k);
  }

  /** the cross-section ring of a roll under the current ring settings, or nothing on the Hertz model */
  ringFor(def: RollDef): RingInfluence | undefined {
    const p = this.p;
    if (p.flatModel !== 'ring') return undefined;
    // a backing bearing's hub is its shaft; a roll's is the set fraction
    const hub = def.shaftBeam ? Math.min(0.9, def.Dn / def.D) : p.ringHub;
    const o = { R: def.D / 2, Rhub: (hub * def.D) / 2, nt: p.ringNt, nr: p.ringNr, grade: p.ringGrade, E: def.E, nu: def.nu };
    const key = [o.R, o.Rhub, o.nt, o.nr, o.grade, o.E, o.nu].join('|');
    let inf = this.rings.get(key);
    if (!inf) {
      inf = ringInfluence(o);
      // the cache holds one function per distinct roll; an old setting's
      // functions are dropped once it has grown past that
      if (this.rings.size > 4 * this.nr + 4) this.rings.clear();
      this.rings.set(key, inf);
    }
    return inf;
  }

  /** diameter of the beam section of roll r at x */
  private beamDiameter(r: RollState, x: number): number {
    const d = r.def;
    if (d.shaftBeam) return d.Dn;
    return onBarrel(d, x) ? d.D : d.Dn;
  }

  /**
   * Residual and, if asked, tangent at the current `u`. Returns the residual
   * norm relative to the largest force in play. Also refreshes the contact
   * and slice states (loads, flattening) at this `u`.
   */
  private assemble(withK: boolean): number {
    const p = this.p;
    const { ns, nr, K, rhs, u } = this;
    if (withK) K.clear();
    rhs.fill(0);
    const rolls = this.rolls;
    let fScale = F_SCALE_FLOOR;
    const addK = withK ? (i: number, j: number, v: number) => K.add(i, j, v) : () => {};

    // ── beams: the internal force K_beam u goes straight into the residual ──
    for (let r = 0; r < nr; r++) {
      const R = rolls[r];
      const E = R.def.E, G = E / (2 * (1 + R.def.nu));
      for (let s = R.ia; s < R.ib; s++) {
        const L = this.grid.elemL[s];
        const D = this.beamDiameter(R, 0.5 * (this.x[s] + this.x[s + 1]));
        const I = (Math.PI * D ** 4) / 64, A = (Math.PI * D * D) / 4;
        const phi = (12 * E * I) / (KAPPA * G * A * L * L);
        const c = (E * I) / ((1 + phi) * L ** 3);
        const k11 = 12 * c, k12 = 6 * L * c, k22 = (4 + phi) * L * L * c, k24 = (2 - phi) * L * L * c;
        for (const plane of [0, 2]) {
          const i1 = this.idx(s, r, plane), i2 = this.idx(s, r, plane + 1);
          const j1 = this.idx(s + 1, r, plane), j2 = this.idx(s + 1, r, plane + 1);
          const a = u[i1], b = u[i2], cc = u[j1], d = u[j2];
          // element force = k_e · u_e
          rhs[i1] -= k11 * a + k12 * b - k11 * cc + k12 * d;
          rhs[i2] -= k12 * a + k22 * b - k12 * cc + k24 * d;
          rhs[j1] -= -k11 * a - k12 * b + k11 * cc - k12 * d;
          rhs[j2] -= k12 * a + k24 * b - k12 * cc + k22 * d;
          if (!withK) continue;
          K.add(i1, i1, k11); K.add(i1, i2, k12); K.add(i1, j1, -k11); K.add(i1, j2, k12);
          K.add(i2, i2, k22); K.add(i2, j1, -k12); K.add(i2, j2, k24);
          K.add(j1, j1, k11); K.add(j1, j2, -k12);
          K.add(j2, j2, k22);
        }
      }
    }

    // ── nodes that do not exist, and rigid-mode pins ──
    for (let s = 0; s < ns; s++) {
      for (let r = 0; r < nr; r++) {
        const R = rolls[r];
        const inside = s >= R.ia && s <= R.ib;
        for (let d = 0; d < DOF; d++) {
          const i = this.idx(s, r, d);
          if (!inside) { addK(i, i, 1); rhs[i] = -u[i]; continue; }
          const k = d === 0 || d === 2 ? K_REG : K_REG * this.grid.cellW[s] * this.grid.cellW[s];
          addK(i, i, k); rhs[i] -= k * u[i];
        }
      }
    }

    // ── supports ──
    const lev = p.leveling;
    const housing = this.housingActive();
    if (withK) this.bScrew.fill(0);
    for (let r = 0; r < nr; r++) {
      const R = rolls[r];
      const d = R.def;
      const moves = this.screwRolls.includes(r);
      R.supports.forEach((s, k) => {
        const iv = this.idx(s, r, 0), iw = this.idx(s, r, 2);
        const xs = this.x[s];
        let ty = 0, tz = 0;
        if (moves) ty = -this.screw - (lev * xs) / Math.max(d.Ls, 1e-9);
        if (d.support === 'saddle' && d.asu) {
          // crown adjustment: the saddle moved along the line towards the work roll
          const nA = -d.cy, nB = -d.cz;
          const nn = Math.hypot(nA, nB) || 1;
          const off = d.asu[k] ?? 0;
          ty += (off * nA) / nn; tz += (off * nB) / nn;
        }
        let ky = 0, kz = 0, fy = 0;
        switch (d.support) {
          // in the housing mode the frame below carries the screw roll's vertical load
          case 'screw': ky = housing ? 0 : p.housingK; kz = K_GUIDE; break;
          case 'saddle': ky = p.housingK; kz = p.housingK; break;
          case 'chock': ky = K_CHOCK_Y; kz = K_GUIDE; fy = d.benderForce; break;
          case 'free': return;
        }
        addK(iv, iv, ky); addK(iw, iw, kz);
        // ty = −S − …, so ∂(rhs)/∂S = −ky here: the column of the screw
        if (withK && moves) this.bScrew[iv] += ky;
        const ry = ky * (ty - u[iv]) + fy;
        rhs[iv] += ry;
        rhs[iw] += kz * (tz - u[iw]);
        R.reactions[k] = d.support === 'chock' ? fy : -ky * (ty - u[iv]);
        fScale = Math.max(fScale, Math.abs(ry));
      });
    }
    if (housing) fScale = Math.max(fScale, this.assembleHousing(withK));

    // ── roll-roll contacts ──
    for (const c of this.contacts) {
      const A = rolls[c.a], B = rolls[c.b];
      c.total = 0;
      for (let s = 0; s < ns; s++) {
        const w = c.weight[s];
        if (w <= 0) { c.q[s] = 0; c.delta[s] = 0; continue; }
        const ia = this.idx(s, c.a, 0), ib = this.idx(s, c.b, 0);
        const iaw = this.idx(s, c.a, 2), ibw = this.idx(s, c.b, 2);
        const gapChange = (u[ib] - u[ia]) * c.ny + (u[ibw] - u[iaw]) * c.nz;
        const delta = A.prof[s] + B.prof[s] - gapChange;
        const [q, kt0] = loadAt(c.law, delta, c.q[s]);
        c.q[s] = q; c.delta[s] = delta;
        c.total += q * w;
        const f = q * w;
        rhs[ia] -= f * c.ny; rhs[iaw] -= f * c.nz;
        rhs[ib] += f * c.ny; rhs[ibw] += f * c.nz;
        fScale = Math.max(fScale, f);
        if (!withK || delta <= 0) continue;
        const kt = Math.max(kt0, KT_FLOOR) * w;
        const nn = [c.ny, c.nz];
        const da = [ia, iaw], db = [ib, ibw];
        for (let i = 0; i < 2; i++) {
          for (let j = 0; j < 2; j++) {
            const k = kt * nn[i] * nn[j];
            if (k === 0) continue;
            // the band keeps the lower half: within a node the (v, w) cross
            // term is one entry, so it is added once; between the nodes the
            // (a, b) and (b, a) blocks are transposes and the band stores
            // only (b, a), so all four entries of the block are needed
            if (j <= i) { K.add(da[i], da[j], k); K.add(db[i], db[j], k); }
            K.add(da[i], db[j], -k);
          }
        }
      }
    }

    // ── the strip under the work roll ──
    // Already solved at this u and σ by `stripSolve`, which runs before
    // every assembly; only its results are read here.
    let force = 0, h1w = 0, wsum = 0;
    this.slices.forEach((sl, i) => {
      const [iv, ivL] = this.sliceDofs(sl);
      const f = sl.q * sl.weight;
      // the same load pushes both work rolls away from the strip
      rhs[iv] += f;
      if (ivL >= 0) rhs[ivL] += f;
      force += f;
      h1w += sl.h1 * sl.weight; wsum += sl.weight;
      fScale = Math.max(fScale, f);
      if (!withK) return;
      // The gap term of the tangent goes in the band. The tension term -
      // a slice rolled thinner is longer, goes slack, and is loaded harder,
      // through the whole strip's elongation balance - couples every slice
      // to every other and is applied in `iterate` as a Woodbury update.
      // On a mirror the gap moves 2 dv, so the term is 2 w (−dq/dg) on the
      // roll; with the lower roll solved it is w (−dq/dg) on each roll and
      // between them.
      this.addGapStiffness(iv, ivL, Math.max(0, -sl.dqdg) * sl.weight);
      this.dqds[i] = sl.q > 0 ? sl.dqds : 0;
      if (TENSION_COUPLING === 'diag' && this.tensionLive) {
        const m = this.slices.length;
        const k = Math.max(0, -sl.weight * this.dqds[i] * this.T[i * m + i]);
        if (ivL < 0) K.add(iv, iv, k); else this.addGapStiffness(iv, ivL, k);
      }
    });
    this.forceTotal = force;
    this.h1Mean = wsum > 0 ? h1w / wsum : p.h0;

    let res = 0;
    for (let i = 0; i < rhs.length; i++) res += rhs[i] * rhs[i];
    return Math.sqrt(res) / fScale;
  }

  /** the control target's residual: gauge [m] or force [N]; zero in screw mode */
  private targetValue(): number {
    const p = this.p;
    if (p.mode === 'gauge') return this.h1Mean - p.h0 * (1 - p.reduction);
    if (p.mode === 'force') return this.forceTotal - p.targetForce;
    return 0;
  }

  /** the target's residual as it enters the line search's merit, commensurate with the force residual */
  private targetMerit(c: number): number {
    const p = this.p;
    if (p.mode === 'gauge') return (MERIT_GAUGE * Math.abs(c)) / p.h0;
    if (p.mode === 'force') return (MERIT_FORCE * Math.abs(c)) / Math.max(p.targetForce, 1);
    return 0;
  }

  /**
   * One Newton iteration on the stack and the screw together, with a
   * backtracking line search.
   *
   * In gauge or force control the screw position S is an unknown beside the
   * roll displacements, and the control target is its equation - the
   * bordered system
   *
   *     [ K   b ] [Δu]   [ r ]        b = −∂r/∂S  (the screw-moving supports)
   *     [ aᵀ  0 ] [ΔS] = [−c ]        a = ∂c/∂u   (mean exit gauge, or total load)
   *
   * solved with the one factorisation: x₁ = K⁻¹r, x₂ = K⁻¹b (both through the
   * tension coupling's Woodbury update), ΔS = (c + aᵀx₁)/(aᵀx₂), Δu = x₁ − ΔS x₂.
   * The screw used to be stepped by a secant between fully settled Newtons,
   * five to nine rounds of settling before the target was even reached; here
   * it moves with every iteration. With no contact yet to steer by (aᵀx₂
   * of the wrong sign or nothing) the screw takes the old secant guess and
   * the rolls follow it through x₂.
   */
  iterate(): void {
    const t0 = performance.now();
    const p = this.p;
    const { K, rhs, u, du } = this;
    const bordered = p.mode !== 'screw';
    // the screw dial takes effect at once in screw mode (it used to wait for a rebuild)
    if (!bordered) this.screw = p.screw;
    this.updateNonlocalFlattening();
    this.stripSolve(TENSION_COUPLING !== 'none');
    const res0 = this.assemble(true);
    const c0 = this.targetValue();
    const merit0 = res0 + this.targetMerit(c0);
    if (!K.cholesky()) { this.residual = Infinity; this.converged = false; return; }
    K.solve(rhs, du);
    const wb = USE_WOODBURY && this.tensionLive && this.slices.length > 0 ? this.prepareWoodbury() : null;
    if (wb) this.applyWoodbury(wb, du);
    const sw = this.seats.length > 0 ? this.prepareSeats(wb) : null;
    if (sw) this.applySeats(sw, du);

    let dS = 0;
    // the plain step (screw held) is kept: it is the fallback when the
    // bordered one cannot bring the merit down
    const plain = this.duPlain;
    plain.set(du);
    if (bordered) {
      const x2 = this.x2;
      // the screw moves supports in y only: its column is all in the v block
      x2.set(this.bScrew);
      K.solveLeading(x2, 0, this.vEnd);
      if (wb) this.applyWoodbury(wb, x2);
      if (sw) this.applySeats(sw, x2);
      const m = this.slices.length;
      const a = this.targetGradient();
      let ax1 = 0, ax2 = 0;
      for (let j = 0; j < m; j++) {
        const [iv, ivL] = this.sliceDofs(this.slices[j]);
        ax1 += a[j] * du[iv]; ax2 += a[j] * x2[iv];
        if (ivL >= 0) { ax1 += a[j] * du[ivL]; ax2 += a[j] * x2[ivL]; }
      }
      // closing the screw thins the strip (aᵀx₂ > 0 in gauge) and loads it (aᵀx₂ < 0 in force)
      const usable = p.mode === 'gauge' ? ax2 > 0.02 : ax2 < -1e8;
      dS = usable ? (c0 + ax1) / ax2 : -c0 / (p.mode === 'gauge' ? -0.5 : 4e9);
      const cap = 0.15 * p.h0 + 20e-6;
      dS = Math.max(-cap, Math.min(cap, dS));
      dS = Math.max(SCREW_MIN, Math.min(SCREW_MAX, this.screw + dS)) - this.screw;
      for (let i = 0; i < du.length; i++) du[i] -= dS * x2[i];
    }

    const base = this.uTrial;
    base.set(u);
    const baseS = this.screw;
    /**
     * Backtracking along (step, dS): the merit has to come down, or the step
     * is shortened (a contact opening or the strip lifting off is not
     * something a tangent knows about). Returns whether it came down.
     */
    const search = (step: Float64Array, ds: number) => {
      let mx = Math.abs(ds);
      for (let i = 0; i < step.length; i++) {
        // slopes are scaled by their station's cell so the clip means the same thing for them
        const d = i % 2 === 0 ? step[i] : step[i] * this.slopeLen[i];
        mx = Math.max(mx, Math.abs(d));
      }
      const clip = mx > STEP_CLIP ? STEP_CLIP / mx : 1;
      let alpha = clip, res = Infinity, c = c0, ok = false;
      for (let tries = 0; tries < 5; tries++) {
        for (let i = 0; i < u.length; i++) u[i] = base[i] + alpha * step[i];
        this.screw = baseS + alpha * ds;
        this.stripSolve(false);
        res = this.assemble(false);
        c = this.targetValue();
        const merit = res + this.targetMerit(c);
        if (merit < merit0 * (1 - 1e-3 * alpha / clip) || merit < 1e-7) { ok = true; break; }
        alpha *= 0.4;
      }
      return { ok, alpha, res, c, mx };
    };
    let ls = search(du, dS);
    // Near the elastic end of a light pass the target's gradient is poor
    // (a slice's thickness barely follows its gap) and the screw it asks
    // for can spoil the force balance the plain step would have mended; a
    // bordered step that cannot bring the merit down is retried with the
    // screw held, which is the step the solver took before.
    if (!ls.ok && bordered && dS !== 0) {
      const tried = ls;
      ls = search(plain, 0);
      if (!ls.ok && tried.res + this.targetMerit(tried.c) < ls.res + this.targetMerit(ls.c)) {
        // neither came down: keep whichever is lower
        ls = search(du, dS);
      }
    }
    this.debug = { alpha: ls.alpha, res0, res: ls.res, mx: ls.mx, tries: 0 };
    this.residual = ls.res;
    this.targetResidual = this.targetMerit(ls.c);
    this.stepMax = ls.mx * ls.alpha;
    this.iterations++;
    this.result.solveMs = performance.now() - t0;
  }

  /**
   * ∂c/∂z at each slice's work-roll coordinate z (see `gapGain`), through
   * the slice's own gap and through the tension coupling: a slice's exit
   * thickness and load move with its own gap (dh₁/dg, dq/dg) and with every
   * slice's tension (dh₁/dσ, dq/dσ times T = dσ/dz).
   */
  private targetGradient(): Float64Array {
    const p = this.p;
    const m = this.slices.length;
    const a = new Float64Array(m);
    const T = this.T, live = this.tensionLive;
    let W = 0;
    for (const sl of this.slices) W += sl.weight;
    const gain = this.gapGain();
    for (let j = 0; j < m; j++) {
      const sj = this.slices[j];
      let v = p.mode === 'gauge' ? gain * sj.weight * sj.dh1dg : gain * sj.weight * sj.dqdg;
      if (live) {
        for (let i = 0; i < m; i++) {
          const si = this.slices[i];
          const t = T[i * m + j];
          if (t === 0) continue;
          v += si.weight * (p.mode === 'gauge' ? si.dh1ds : this.dqds[i]) * t;
        }
      }
      a[j] = p.mode === 'gauge' ? v / Math.max(W, 1e-12) : v;
    }
    return a;
  }

  /**
   * The pieces of the Woodbury update for the strip's tension coupling,
   * K_full = K + U M Uᵀ with U's column j the work-roll v-DOF of slice j (on
   * a mirror) or the sum of the upper and lower rolls' (the gap moves with
   * both) and M = −diag(w dq/dσ) T:  x_full = x − Y M (I + G M)⁻¹ Uᵀ x,
   * Y = K⁻¹U, G = UᵀY. M is not inverted (a clipped slice has a zero row),
   * so this is the form that only needs I + G M - m×m dense, factorised once
   * here and applied to as many right-hand sides as the iteration has.
   */
  private prepareWoodbury(): { Y: Float64Array; M: Float64Array; A: Float64Array; piv: Int32Array; cols: Int32Array; colsL: Int32Array | null; n: number; m: number } | null {
    const K = this.K;
    const n = this.u.length, m = this.slices.length;
    const Y = this.woodburyY(n, m);
    const cols = Int32Array.from(this.slices, (sl) => this.idx(sl.s, this.stack.wr, 0));
    const colsL = this.wrLower < 0 ? null : Int32Array.from(this.slices, (sl) => this.idx(sl.s, this.wrLower, 0));
    if (this.yAge >= Y_REUSE || this.yAge < 0) {
      // each column is a unit load on the work roll(s) at one station: zero
      // before that row, and all in the v block
      const e = this.scratch;
      for (let j = 0; j < m; j++) {
        e.fill(0);
        e[cols[j]] = 1;
        if (colsL) e[colsL[j]] = 1;
        K.solveLeading(e, colsL ? Math.min(cols[j], colsL[j]) : cols[j], this.vEnd);
        Y.set(e, j * n);
      }
      this.yAge = 0;
    }
    this.yAge++;
    const M = new Float64Array(m * m), A = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      const wi = -this.slices[i].weight * this.dqds[i];
      for (let j = 0; j < m; j++) M[i * m + j] = wi * this.T[i * m + j];
    }
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        // G_ik = (Uᵀ Y)_ik = Y[k][cols[i]] (+ Y[k][colsL[i]])
        let sum = 0;
        if (colsL) for (let k = 0; k < m; k++) sum += (Y[k * n + cols[i]] + Y[k * n + colsL[i]]) * M[k * m + j];
        else for (let k = 0; k < m; k++) sum += Y[k * n + cols[i]] * M[k * m + j];
        A[i * m + j] = (i === j ? 1 : 0) + sum;
      }
    }
    const piv = new Int32Array(m);
    if (!luFactor(A, m, piv)) return null;
    return { Y, M, A, piv, cols, colsL, n, m };
  }

  private applyWoodbury(wb: { Y: Float64Array; M: Float64Array; A: Float64Array; piv: Int32Array; cols: Int32Array; colsL: Int32Array | null; n: number; m: number }, v: Float64Array): void {
    const { Y, M, A, piv, cols, colsL, n, m } = wb;
    const z = new Float64Array(m);
    for (let i = 0; i < m; i++) z[i] = colsL ? v[cols[i]] + v[colsL[i]] : v[cols[i]];
    luSolve(A, m, piv, z);
    for (let k = 0; k < m; k++) {
      let mz = 0;
      for (let j = 0; j < m; j++) mz += M[k * m + j] * z[j];
      if (mz === 0) continue;
      const off = k * n;
      // Y is zero past the v block
      for (let i = 0, e = this.vEnd; i < e; i++) v[i] -= Y[off + i] * mz;
    }
  }

  private woodburyY(n: number, m: number): Float64Array {
    if (!this.Ybuf || this.Ybuf.length !== n * m) { this.Ybuf = new Float64Array(n * m); this.yAge = -1; }
    return this.Ybuf;
  }

  /**
   * The non-local flattening mode (`flatNonlocal`, see `flatnl.ts`): each
   * slice's flattening offset from the loads the slices carry now, refreshed
   * once per outer iteration and held through it, as the arc is. The slice's
   * own fixed point and tangents keep its local law; the neighbours' share
   * follows one iteration late, and `advance` does not call the solve settled
   * until the offsets have stopped moving. Off, nothing on the slices changes.
   */
  private updateNonlocalFlattening(): void {
    const sl = this.slices, n = sl.length;
    if (!this.p.flatNonlocal) {
      if (this.nlLive) { for (const s of sl) s.nlOff = 0; this.nlLive = false; this.nlChange = 0; }
      return;
    }
    if (n === 0) return;
    const ws = this.wsLaw;
    const half = this.p.width / 2;
    const { cellL, cellR } = this.grid;
    const x = new Float64Array(n), c0 = new Float64Array(n), c1 = new Float64Array(n);
    const q = new Float64Array(n), b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = sl[i];
      x[i] = s.x;
      c0[i] = Math.max(cellL[s.s], -half);
      c1[i] = Math.min(cellR[s.s], half);
      q[i] = s.q;
      // the half-width the contact law takes for this load (see `approach`)
      b[i] = Math.max(Math.sqrt(ws.bCoef * Math.max(s.q, 0)), s.arc / 2, 1e-9);
    }
    const off = nonlocalOffsets(x, c0, c1, q, b, ws.A1, this.stack.rolls[this.stack.wr].D / 2);
    let change = this.nlLive ? 0 : Infinity;
    for (let i = 0; i < n; i++) {
      change = Math.max(change, Math.abs(off[i] - (sl[i].nlOff ?? 0)));
      sl[i].nlOff = off[i];
    }
    this.nlChange = change;
    this.nlLive = true;
  }

  /**
   * The slice's load at a rigid gap g: q = k P(h1), h1 = g + 2 δ_ws(q) + springback.
   *
   * k is the strip FEM's load correction for this slice (1 with the slab
   * model, see `femCorrection`). It belongs inside the fixed point: the
   * flattening has to be that of the load the roll actually carries. It used
   * to be applied to the slab load after the fact, so the exit thickness came
   * from the flattening under P while the roll carried k P - on a 4Hi the
   * exit thickness was 73 µm too thin on average, a millimetre at a 2Hi edge,
   * and the crown and flatness were far off.
   *
   * φ(q) = q − P(h1(q)) is increasing in q: a heavier load flattens the
   * roll more, which opens the gap, which lowers the load the gap asks
   * for. So the root is bracketed and a Newton step that leaves the
   * bracket is replaced by a bisection - a plain Newton overshoots on a
   * steep pass (high friction, foil), lands where the gap has opened, sees
   * no contact, and oscillates between zero and a huge load.
   */
  private sliceCore(sl: Slice, g: number, sigmaF: number, qStart: number, k = 1): SliceState {
    const p = this.p;
    const law = this.law;
    // The width the flattening is spread over is frozen for this call at
    // the slice's last arc: φ(q) has to be one fixed function for the
    // bracket to mean anything (an arc taken from the current iterate made
    // a third of the calls run to the iteration cap). It catches up one
    // outer iteration later, which is where the tangent is taken anyway.
    const ws = this.wsLaw;
    ws.bFloor = Math.max(0, sl.arc / 2);
    const P = (h1: number, guess: number) => {
      const r0 = sliceLoad(law, sl.h0, h1, p.backTension, sigmaF, guess / k);
      return k === 1 ? r0 : { ...r0, q: k * r0.q };
    };
    let q = Math.max(qStart, 0);
    // a cold slice starts from the load the rigid gap would take, which is
    // near the root; doubling up from nothing took a dozen rounds
    if (q <= 0 && g < sl.h0) q = P(g, 0).q;
    let h1 = sl.h0, flat = 0, arc = sl.arc, runaway = false;
    // the non-local mode's offset, held for this call like the arc (see `updateNonlocalFlattening`)
    const off = sl.nlOff ?? 0;
    const hMin = H_MIN_FRAC * sl.h0;
    const dh = 1e-3 * sl.h0;
    let lo = 0, hi = Infinity;
    let itDone = 0;
    for (let it = 0; it < 25; it++) {
      itDone = it + 1;
      const [d, dd] = approach(ws, q);
      flat = off === 0 ? d : d + off;
      const hRigid = Math.max(g + 2 * flat, hMin);
      h1 = hRigid + springback(law, Math.min(hRigid, sl.h0), kfExitOf(law, sl.h0, hRigid), sigmaF);
      const open = h1 >= sl.h0;
      const r = open ? NO_LOAD : P(h1, q);
      arc = r.arc; runaway = r.runaway;
      const phi = q - r.q;
      // tight: the outer Newton settles on displacements of a few nm, and a
      // slice load resolved to 1e-6 left a noise floor above that (a 2Hi at
      // 1600 mm width then crept through 800 iterations on the stall escape)
      if (Math.abs(phi) <= SLICE_TOL * Math.max(q, 1)) { if (open) q = 0; break; }
      if (phi < 0) lo = q; else hi = q;
      if (phi > 0 && q === 0) break;
      // Newton on the load's own slope; a step outside the bracket is
      // replaced by a bisection (or a doubling while the top is unknown)
      let Ph = 0;
      if (!open && h1 + dh < sl.h0) Ph = (P(h1 + dh, r.q).q - r.q) / dh;
      let next = q - phi / (1 - 2 * Ph * dd);
      if (!(next > lo && next < hi)) next = Number.isFinite(hi) ? 0.5 * (lo + hi) : Math.max(2 * q, lo + 1e3);
      q = next;
    }
    if (h1 >= sl.h0) { q = 0; h1 = Math.min(h1, sl.h0); }
    if (this.counters) { this.counters.coreIts += itDone; this.counters.coreCalls++; if (itDone >= 25) this.counters.coreCap++; }
    return { q, h1, flat, arc, runaway };
  }

  /**
   * The slice at (g, σf) and its tangents dq/dg, dq/dσ, dh1/dg, dh1/dσ, by
   * finite differences of the whole slice solve. That is twice the work of
   * an analytic tangent, but it is consistent with everything the slice
   * does - the elastic ramp, the arc-dependent contact width, the load cap,
   * the springback - and an inconsistent tangent costs far more in
   * shortened outer steps than the extra solves cost here.
   */
  private solveSlice(sl: Slice, g: number, sigmaF: number, k = 1): SliceState & {
    dqdg: number; dqds: number; dh1dg: number; dh1ds: number;
  } {
    const base = this.sliceCore(sl, g, sigmaF, sl.q, k);
    if (base.q <= 0) return { ...base, dqdg: 0, dqds: 0, dh1dg: 1, dh1ds: 0 };
    const dg = 2e-3 * sl.h0;
    const ds = Math.max(1e6, 0.02 * Math.abs(sigmaF));
    const atG = this.sliceCore(sl, g - dg, sigmaF, base.q, k);
    const atS = this.sliceCore(sl, g, sigmaF + ds, base.q, k);
    return {
      ...base,
      dqdg: (base.q - atG.q) / dg,
      dqds: (atS.q - base.q) / ds,
      dh1dg: (base.h1 - atG.h1) / dg,
      dh1ds: (atS.h1 - base.h1) / ds,
    };
  }

  /** the slices' current front tension, in slice order */
  private sigmaSlices(): Float64Array {
    return Float64Array.from(this.slices, (sl) => this.sigmaF[sl.s]);
  }

  /** per slice: FEM load over slab load, and FEM elongation minus slab elongation */
  private femRatio: Float64Array | null = null;
  /**
   * What the shown elongation profile is evaluated from, as the last strip solve left it: each
   * slice's elongation less the weighted mean, the smoothing length, and the free stress's
   * offset λ, E′, the buckling limit and the post-buckling law, which place the wave (see `collect`)
   */
  private shown = { e: new Float64Array(0), sig: 0, lambda: 0, Eeff: 0, lo: 0, hi: Infinity, kPost: 0, effectiveWidth: false };
  private femEps: Float64Array | null = null;

  /**
   * The strip FEM at the current roll position and tension, and what it
   * says the slab slices get wrong. Every slice's exit thickness comes from
   * the roll gap with its last load (flattening and springback), the arc
   * from that, then one FEM solve for the whole width gives the loads and
   * the exit velocities. The elongation each slice hands to the tension
   * model is its exit velocity against the entry speed - which is where
   * lateral flow shows up: a slice that spreads sideways elongates less
   * than ln(h₀/h₁).
   */
  private femCorrection(sigma: Float64Array): number {
    const p = this.p;
    const law = this.law;
    const n = this.slices.length;
    if (n === 0) return 0;
    if (!this.femRatio || this.femRatio.length !== n) { this.femRatio = new Float64Array(n).fill(1); this.femEps = new Float64Array(n); }
    const h0 = new Float64Array(n), h1 = new Float64Array(n);
    const L = new Float64Array(n), sB = new Float64Array(n), sF = new Float64Array(n);
    const qSlab = new Float64Array(n), epsSlab = new Float64Array(n);
    // The FEM's columns are the slices, edge to edge: each slice's cell
    // clipped to the strip. Its node columns used to sit at the slices'
    // stations, so the mesh stopped at the edge stations and up to half a
    // cell of the strip at each edge was not in it until the strip had
    // widened far enough for the next station to take a slice; at that
    // width a 4Hi's crown jumped by 11 µm and its latent flatness by 30 %.
    // A sliver of an edge cell (the strip edge just past a cell boundary)
    // is kept to a thousandth of a cell, so no element is degenerate.
    const edges = new Float64Array(n + 1);
    {
      const half = p.width / 2;
      const { cellL, cellR, cellW } = this.grid;
      edges[0] = Math.max(cellL[this.slices[0].s], -half);
      for (let i = 0; i < n; i++) edges[i + 1] = Math.min(cellR[this.slices[i].s], half);
      if (n > 1) {
        edges[1] = Math.max(edges[1], edges[0] + 1e-3 * cellW[this.slices[0].s]);
        edges[n - 1] = Math.min(edges[n - 1], edges[n] - 1e-3 * cellW[this.slices[n - 1].s]);
      }
    }
    this.slices.forEach((sl, i) => {
      const g = this.gapAt(sl.s);
      // the slice as the coupled solve has it, flattened under the corrected
      // load; the FEM is asked about that exit thickness and arc, and the
      // new ratio is its load over the slab load at the same thickness
      const k = this.femRatio![i];
      const slab = this.sliceCore(sl, g, sigma[i], sl.q, k);
      h0[i] = sl.h0; h1[i] = slab.h1; L[i] = slab.arc;
      sB[i] = p.tensionFeedback ? p.backTension : 0; sF[i] = p.tensionFeedback ? sigma[i] : 0;
      qSlab[i] = slab.q / k; // a start for the slab load at the FEM column's state, below
    });
    let Lmax = 0, dhMax = 0;
    for (let i = 0; i < n; i++) { Lmax = Math.max(Lmax, L[i]); dhMax = Math.max(dhMax, h0[i] - h1[i]); }
    const e0 = Math.max(p.entryStrain, 0);
    if (Lmax <= 0 || dhMax < 0.005 * p.h0) {
      let change = 0;
      for (let i = 0; i < n; i++) { change = Math.max(change, Math.abs(1 - this.femRatio[i]), Math.abs(this.femEps![i]) * 50); }
      this.femRatio.fill(1); this.femEps!.fill(0); this.femResult = null;
      this.aaX = []; this.aaF = [];
      return change;
    }
    // the FEM needs an arc everywhere: a floor, so an unloaded slice has a
    // sliver and a slice coming into contact grows its arc continuously
    // from it (a sliver swapped for the real arc at first contact made two
    // FEM solutions alternate on a 0.06 µm difference in thickness)
    for (let i = 0; i < n; i++) L[i] = Math.max(L[i], 0.05 * Lmax);
    const femInput = { edges, h0, h1, L, kf: (_i: number, e: number) => kfAt(law, e0 + e), mu: p.mu, sigmaB: sB, sigmaF: sF, nz: p.stripNz, vRoll: 1 };
    const r = p.stripModel === 'fem3d' ? this.fem3d.solve({ ...femInput, ny: p.stripNy }) : this.fem.solve(femInput);
    this.femResult = r;
    // The FEM is compared with the slab at the state its columns have: the
    // slices' thicknesses read at the node columns and averaged over each
    // column (see `atNodes`). Compared at each slice's own thickness, a
    // slice thicker than its neighbours met a FEM column thinned by them,
    // took a higher ratio, flattened more and came out thicker still - the
    // ratio cancelled the slab's own stiffness against a zigzag, and next
    // to a 4Hi's edge the exit thickness zigzagged by 20-30 µm from slice
    // to slice.
    const h0N = atNodes(edges, h0), h1N = atNodes(edges, h1);
    const colDraft = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h0c = 0.5 * (h0N[i] + h0N[i + 1]), h1c = 0.5 * (h1N[i] + h1N[i + 1]);
      colDraft[i] = h0c - h1c;
      qSlab[i] = h1c < h0c ? sliceLoad(law, h0c, h1c, p.backTension, sigma[i], qSlab[i]).q : 0;
      epsSlab[i] = qSlab[i] > 0 ? Math.log(h0c / h1c) : 0;
    }
    // The load ratio is taken over a window a cell wide centred on the
    // slice: inside the strip that is the slice's own column, and an edge
    // slice narrower than a cell reaches into its neighbour. The FEM's load
    // falls off at the free edge, and a sliver of an edge column averages
    // only the fall: on a 4Hi its ratio was 0.58 at 0.9 mm wide against 1.08
    // at a whole cell, and the flattening, local to each slice, left its
    // exit thickness 170 µm under the whole cell's.
    const kWin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = 0.5 * (edges[i] + edges[i + 1]), hw = 0.5 * this.grid.cellW[this.slices[i].s];
      let a = 0, b = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
        const o = Math.min(c + hw, edges[j + 1]) - Math.max(c - hw, edges[j]);
        if (o > 0 && r.q[j] > 0 && qSlab[j] > 0) { a += o * r.q[j]; b += o * qSlab[j]; }
      }
      kWin[i] = b > 0 ? a / b : 1;
    }
    let change = 0;
    const target = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      // Only a slice with a real draft is corrected. Under the elastic draft
      // the slab load ramps to zero while the FEM (rigid-plastic, no elastic
      // regime) does not, and the ratio of the two is meaningless there;
      // applied, it made the corrected load jump between neighbouring
      // slices and the Newton could not settle.
      // The correction fades in over a draft band rather than switching
      // on at a threshold: a barely rolled edge column is dragged along by
      // its neighbours in the FEM (it elongates like them and is fed
      // sideways), so its FEM elongation is nothing like the slab's, and a
      // column sitting on a hard threshold flipped its whole correction
      // every round.
      const sl = this.slices[i];
      const dhEl = (sl.h0 * kfMean(law, e0, e0 + 0.1) * (1 - law.nu * law.nu)) / law.E;
      const thr = Math.max(4 * dhEl, 0.005 * sl.h0);
      const t = qSlab[i] > 0 ? Math.max(0, Math.min(1, (colDraft[i] - thr) / thr)) : 0;
      const kRaw = r.q[i] > 0 && qSlab[i] > 0 ? Math.max(FEM_RATIO_MIN, Math.min(FEM_RATIO_MAX, kWin[i])) : 1;
      const k = 1 + t * (kRaw - 1);
      const de = t * (r.eps[i] - epsSlab[i]);
      change = Math.max(change, Math.abs(k - this.femRatio[i]), Math.abs(de - this.femEps![i]) * AA_EPS_SCALE);
      target[i] = k; target[n + i] = de;
    }
    // Not taken as it stands. The correction feeds back through the
    // flattening (a heavier load opens the gap, which lightens the FEM's
    // load) with a gain past one, and an undamped update cycles between two
    // states; a damped one (0.3) converged, in seventy-odd rounds. The
    // update is Anderson-accelerated instead, from the same damping.
    const xv = new Float64Array(2 * n), fv = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      xv[i] = this.femRatio[i]; fv[i] = target[i] - this.femRatio[i];
      xv[n + i] = AA_EPS_SCALE * this.femEps![i]; fv[n + i] = AA_EPS_SCALE * (target[n + i] - this.femEps![i]);
    }
    const next = this.andersonStep(xv, fv);
    // The load ratio keeps its bounds. The elongation offset has none: a
    // barely rolled edge column is dragged along by its neighbours in the
    // FEM, and offsets of 0.2 there are part of legitimate answers (a bound
    // at 0.1 kept three such passes from ever converging).
    for (let i = 0; i < n; i++) {
      this.femRatio[i] = Math.max(FEM_RATIO_MIN, Math.min(FEM_RATIO_MAX, next[i]));
      this.femEps![i] = next[n + i] / AA_EPS_SCALE;
    }
    return change;
  }

  /**
   * One Anderson-accelerated step of the fixed point x = G(x), given the
   * iterate x and its residual f = G(x) − x (type II, Walker & Ni 2011):
   *
   *     x⁺ = x + β f − (ΔX + β ΔF) γ,   γ = argmin ‖f − ΔF γ‖,
   *
   * ΔX, ΔF the differences of the last few iterates and residuals, β the
   * damping the plain iteration needed. With no history it is that plain
   * damped step. The map is only piecewise smooth - a slice's tension
   * reaching a limit, a column coming into contact - so the history is
   * dropped when the residual jumps, and the plain step is taken whenever
   * the least squares asks for large coefficients.
   */
  private andersonStep(x: Float64Array, f: Float64Array): Float64Array {
    const beta = FEM_RELAX;
    const norm = (v: Float64Array) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); };
    const H = this.aaX.length;
    if (H > 0 && (this.aaX[H - 1].length !== x.length || norm(f) > AA_RESTART_GROWTH * norm(this.aaF[H - 1]))) {
      this.aaX = []; this.aaF = [];
    }
    this.aaX.push(Float64Array.from(x)); this.aaF.push(Float64Array.from(f));
    if (this.aaX.length > AA_DEPTH + 1) { this.aaX.shift(); this.aaF.shift(); }
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] + beta * f[i];
    const mh = this.aaX.length - 1;
    if (mh === 0) return out;
    const len = x.length;
    const dF: Float64Array[] = [], dX: Float64Array[] = [];
    for (let j = 0; j < mh; j++) {
      const a = new Float64Array(len), b = new Float64Array(len);
      for (let i = 0; i < len; i++) { a[i] = this.aaF[j + 1][i] - this.aaF[j][i]; b[i] = this.aaX[j + 1][i] - this.aaX[j][i]; }
      dF.push(a); dX.push(b);
    }
    // normal equations, lightly regularised
    const G = new Float64Array(mh * mh), rhs = new Float64Array(mh);
    let trace = 0;
    for (let a = 0; a < mh; a++) {
      for (let b = 0; b < mh; b++) {
        let s = 0;
        for (let i = 0; i < len; i++) s += dF[a][i] * dF[b][i];
        G[a * mh + b] = s;
      }
      let s = 0;
      for (let i = 0; i < len; i++) s += dF[a][i] * f[i];
      rhs[a] = s;
      trace += G[a * mh + a];
    }
    if (!(trace > 0)) return out;
    for (let a = 0; a < mh; a++) G[a * mh + a] += 1e-10 * trace;
    if (!denseSolve(G, mh, rhs)) return out;
    for (let a = 0; a < mh; a++) if (!(Math.abs(rhs[a]) <= AA_MAX_GAMMA)) return out;
    for (let a = 0; a < mh; a++) {
      const g = rhs[a];
      for (let i = 0; i < len; i++) out[i] -= g * (dX[a][i] + beta * dF[a][i]);
    }
    return out;
  }

  /**
   * The strip at the current roll position: tension and thickness solved
   * together, slice by slice, and the total derivative dσ/dv for the outer
   * Newton.
   *
   * At a fixed roll gap the strip has a loop of its own. A slice's tension
   * sets its load, the load sets the work roll's flattening there, the
   * flattening sets the thickness, the thickness sets the elongation, and
   * the elongation sets the tension. With E' at 2·10¹¹ Pa and a flattening
   * of ~10 µm per 10 % of load, that loop has a gain near -20: iterated
   * naively it oscillates, and a Newton on the roll positions alone that
   * treats σ as a plain function of thickness is wrong by that factor.
   *
   * On top of that the tension is clamped - a slice cannot carry compression
   * past its buckling stress, nor tension past its yield - and a Newton
   * through the clamp cycles: a slice at a limit looks insensitive, gets
   * stepped by its whole residual, and lands at the other limit. So this is
   * an active-set solve, as for a contact problem. The slices at a limit are
   * held there; the live ones satisfy σ_i = σ̄ + λ - E' D_i, with D the
   * smoothed differential elongation and λ the offset that keeps the mean
   * over every slice at σ̄ (closed form, given the held ones), by a Newton
   * that has no clamp in it and converges in a few steps. Then the set is
   * revised: a live slice past a limit is held there, a held slice whose
   * free stress has come back inside the band is released. A handful of
   * rounds settles it.
   *
   * A slice held at the buckling limit may keep a post-buckling stiffness
   * (`postBucklingStiffness`, 0 by default). It is then not pinned at −σcr:
   * its stress follows σ = b(free) below the limit, with b(lo) = lo and a
   * slope b′ of β on the linear law, σ = lo + β(free − lo) = −σcr − βE′(D − D_cr),
   * or k·σcr/(2|σ|) on the effective width's |σ| = √(σcr² + k·σcr·(lo − free)),
   * D_cr being the D at which the free stress reaches the limit. It stays in
   * the held set - the revision above is unchanged - but moves with the
   * Newton: its row is σ − b(free), and its stress, no longer a constant,
   * enters λ through the mean. What it cannot carry is the wave: the
   * manifest elongation (σ − free)/E′, which on the linear law is
   * (1 − β)(D − D_cr).
   *
   * The outer Newton then takes dσ/dv = J⁻¹ F_h h_v on the settled set.
   */
  private stripSolve(withJacobian: boolean): void {
    const p = this.p;
    const n = this.slices.length;
    if (n === 0) return;
    const w = new Float64Array(n);
    let ws = 0;
    this.slices.forEach((sl, i) => { w[i] = sl.weight; ws += w[i]; });
    // lateral flow: a slice cannot be much longer than its neighbours over a
    // distance of a few thicknesses - smooth the differential over lateralLen
    // The smoothing never falls under the strip's station spacing: slices coupled
    // only through the mean tension can settle into a checkerboard (thin
    // and tense, thick and slack, alternating) that the model has no
    // lateral stiffness to resist, and a kernel narrower than the spacing
    // couples no neighbours at all.
    const S = new Float64Array(n * n);
    const sig = Math.max(p.lateralLen, this.grid.dxStrip);
    const rad = sig > 0 ? Math.ceil((3 * sig) / this.grid.dxStrip) : 0;
    for (let i = 0; i < n; i++) {
      let norm = 0;
      for (let j = Math.max(0, i - rad); j <= Math.min(n - 1, i + rad); j++) {
        const dxij = sig > 0 ? (this.slices[j].x - this.slices[i].x) / sig : 0;
        const g = (sig > 0 ? Math.exp(-0.5 * dxij * dxij) : i === j ? 1 : 0) * w[j];
        S[i * n + j] = g; norm += g;
      }
      if (norm > 0) for (let j = 0; j < n; j++) S[i * n + j] /= norm;
    }
    // with the feedback off the strip carries its set tension everywhere:
    // no redistribution by the elongation differences (E' = 0 below)
    const Eeff = p.tensionFeedback ? p.Estrip / (1 - p.nuStrip * p.nuStrip) : 0;
    // the strip yields in tension near its resistance: cap there
    const e0 = Math.max(p.entryStrain, 0);
    const hi = TENSION_CAP * kfMean(this.law, e0, e0 + 1.1547 * Math.log(1 / (1 - p.reduction)));
    const lo = -p.sigmaCr;
    const dDde = (i: number, j: number) => S[i * n + j] - w[j] / ws;
    // the post-buckling law b(free) of a held-slack slice and its slope (see above);
    // with no stiffness every path below is the clamp's, bit for bit. Nor does a
    // buckled slice carry more compression than the tension it may carry (−hi):
    // on a 2Hi's 15 000 I-unit edge wave β = 0.05 asked for −504 MPa against a cap of 518
    const effectiveWidth = p.postBucklingModel === 'effectiveWidth';
    const kPost = p.postBucklingStiffness > 0 ? Math.min(p.postBucklingStiffness, effectiveWidth ? 2 : 1) : 0;
    const soft = kPost > 0;
    const buckled = (f: number) => postBuckled(f, p.sigmaCr, hi, kPost, effectiveWidth).stress;
    const buckledSlope = (f: number) => postBuckled(f, p.sigmaCr, hi, kPost, effectiveWidth).slope;

    const sigma = new Float64Array(n);
    /** 0 = live, -1 = held at lo, +1 = held at hi */
    const held = new Int8Array(n);
    /** whether a slice's tension is an unknown of the Newton: a live one, or a held-slack one with a post-buckling stiffness */
    const moves = (i: number) => held[i] === 0 || (soft && held[i] < 0);
    this.slices.forEach((sl, i) => {
      // a buckled slice may sit below the limit from the last solve
      sigma[i] = soft ? Math.min(hi, this.sigmaF[sl.s]) : Math.max(lo, Math.min(hi, this.sigmaF[sl.s]));
      held[i] = sigma[i] <= lo ? -1 : sigma[i] >= hi ? 1 : 0;
    });
    const eps = new Float64Array(n), D = new Float64Array(n), free = new Float64Array(n);
    const Fh = new Float64Array(n * n), J = new Float64Array(n * n), r = new Float64Array(n);
    const colTerm = new Float64Array(n);
    let lambda = 0;

    // With the strip FEM on, the slab slices still drive the Newton (their
    // tangents are smooth and cheap) but are corrected to the FEM: the load
    // by a ratio - inside the slice's own fixed point, so the flattening and
    // the exit thickness follow the corrected load - and the elongation by
    // an offset, both taken once per strip solve at the current state (see
    // `femCorrection`). Across the outer
    // iterations the corrections refresh, and the solution converges to the
    // FEM's - a defect correction. Calling the FEM inside the tension Newton
    // instead made that Newton chase a function whose tangent it did not
    // have, and it never settled.
    const evalSlices = (onlyLive: boolean) => {
      const ratio = this.femRatio, off = this.femEps;
      this.slices.forEach((sl, i) => {
        if (onlyLive && !moves(i)) return;
        const g = this.gapAt(sl.s);
        const out = this.solveSlice(sl, g, sigma[i], ratio ? ratio[i] : 1);
        sl.g = g; sl.q = out.q; sl.h1 = out.h1; sl.flat = out.flat; sl.arc = out.arc; sl.runaway = out.runaway;
        sl.dh1dg = out.dh1dg; sl.dh1ds = out.dh1ds; sl.dqdg = out.dqdg; sl.dqds = out.dqds;
        eps[i] = sl.q > 0 ? Math.log(sl.h0 / Math.max(sl.h1, 1e-9)) + (off ? off[i] : 0) : 0;
      });
    };
    /** D, λ and the free stress of every slice from the current ε */
    const evalFree = () => {
      let es = 0;
      for (let i = 0; i < n; i++) es += eps[i] * w[i];
      const mean = ws > 0 ? es / ws : 0;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let j = 0; j < n; j++) acc += S[i * n + j] * (eps[j] - mean);
        D[i] = acc;
      }
      // mean over every slice = σ̄: Σ_L w (σ̄ + λ - E' D) + Σ_C w σ = W σ̄
      let wL = 0, sumC = 0, sumL = 0;
      for (let i = 0; i < n; i++) {
        if (held[i] === 0) { wL += w[i]; sumL += w[i] * (p.frontTension - Eeff * D[i]); }
        else sumC += w[i] * sigma[i];
      }
      if (wL > 0) {
        lambda = (ws * p.frontTension - sumC - sumL) / wL;
      } else {
        // Every slice held: no live slice is left to carry the mean, and
        // λ = 0 said nothing about which slices should come off their
        // limits. λ is then the offset at which the clamped free stresses
        // keep the mean at σ̄ (the clamped mean only grows with it, so a
        // bisection finds it), and the release test below works from that.
        // With λ = 0 a 6Hi on 200 tonf benders held all 29 slices at a mean
        // of 85 MPa against 80, released four with the wrong stress, held
        // them again, and the outer Newton alternated between the two
        // states sixty iterations at a time.
        let fMin = Infinity, fMax = -Infinity;
        for (let i = 0; i < n; i++) { const f = p.frontTension - Eeff * D[i]; fMin = Math.min(fMin, f); fMax = Math.max(fMax, f); }
        let a0 = lo - fMax, a1 = hi - fMin;
        for (let k = 0; k < 80 && a1 - a0 > 1e-6 * Math.max(1, Math.abs(a0), Math.abs(a1)); k++) {
          const mid = 0.5 * (a0 + a1);
          let acc = 0;
          for (let i = 0; i < n; i++) {
            const f = p.frontTension - Eeff * D[i] + mid;
            acc += w[i] * (soft && f < lo ? buckled(f) : Math.max(lo, Math.min(hi, f)));
          }
          if (acc < ws * p.frontTension) a0 = mid; else a1 = mid;
        }
        lambda = 0.5 * (a0 + a1);
      }
      for (let i = 0; i < n; i++) free[i] = p.frontTension + lambda - Eeff * D[i];
    };
    /** F_h = dfree/dh1 on the live rows (m×m); held rows are zero */
    const buildFh = () => {
      let wL = 0;
      for (let k = 0; k < n; k++) if (held[k] === 0) wL += w[k];
      for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let k = 0; k < n; k++) if (held[k] === 0) acc += w[k] * dDde(k, j);
        colTerm[j] = wL > 0 ? acc / wL : 0;
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const sl = this.slices[j];
          const dedh = sl.q > 0 ? -1 / sl.h1 : 0;
          Fh[i * n + j] = held[i] === 0 ? Eeff * (colTerm[j] - dDde(i, j)) * dedh
            : soft && held[i] < 0 ? buckledSlope(free[i]) * (Eeff * (colTerm[j] - dDde(i, j)) * dedh) : 0;
        }
      }
      return wL;
    };
    const buildJ = () => {
      // a buckled slice that moves puts its stress into λ through the mean:
      // ∂λ/∂σ_j = −w_j / w_L, carried into every row by that row's slope (1 live, b′ buckled)
      let wL = 0;
      const rowSlope = soft ? new Float64Array(n) : null;
      if (rowSlope) {
        for (let k = 0; k < n; k++) if (held[k] === 0) wL += w[k];
        for (let i = 0; i < n; i++) rowSlope[i] = held[i] === 0 ? 1 : held[i] < 0 ? buckledSlope(free[i]) : 0;
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          // a held slice does not move: identity row and no column influence
          const jj = moves(j) ? this.slices[j].dh1ds : 0;
          let v = (i === j ? 1 : 0) - Fh[i * n + j] * jj;
          if (rowSlope && held[j] < 0 && wL > 0) v += rowSlope[i] * (w[j] / wL);
          J[i * n + j] = v;
        }
      }
    };

    if (p.stripModel === 'slab') { this.femRatio = null; this.femEps = null; this.femResult = null; }
    evalSlices(false);
    if (this.counters) this.counters.stripCalls++;
    for (let round = 0; round < 10; round++) {
      if (this.counters) this.counters.rounds++;
      // Newton on the live slices, the held ones fixed
      for (let it = 0; it < 8; it++) {
        if (this.counters) this.counters.inner++;
        evalFree();
        let rn = 0;
        for (let i = 0; i < n; i++) {
          r[i] = held[i] === 0 ? sigma[i] - free[i] : soft && held[i] < 0 ? sigma[i] - buckled(free[i]) : 0;
          rn = Math.max(rn, Math.abs(r[i]));
        }
        if (rn < 5e4) break;
        buildFh();
        buildJ();
        const step = new Float64Array(n);
        for (let i = 0; i < n; i++) step[i] = -r[i];
        if (!denseSolve(J, n, step)) break;
        for (let i = 0; i < n; i++) if (moves(i)) sigma[i] += Math.max(-4e8, Math.min(4e8, step[i]));
        evalSlices(true);
      }
      evalFree();
      // revise the set
      // A live slice past a limit is held there. A held slice is released
      // when its free stress has come off the limit's side - even if it
      // has gone clean past the other limit, which the next round will
      // catch; leaving it held would let λ run away to keep the mean.
      let changed = 0;
      for (let i = 0; i < n; i++) {
        if (held[i] === 0) {
          if (sigma[i] < lo) { held[i] = -1; sigma[i] = lo; changed++; }
          else if (sigma[i] > hi) { held[i] = 1; sigma[i] = hi; changed++; }
        } else if (held[i] < 0 ? free[i] > lo : free[i] < hi) {
          held[i] = 0;
          sigma[i] = Math.max(lo, Math.min(hi, free[i]));
          changed++;
        }
      }
      if (changed === 0) break;
      evalSlices(false);
    }
    evalSlices(false);
    evalFree();
    {
      // the shown profile's ingredients, with the mean exactly as `evalFree` takes it
      let es = 0;
      for (let i = 0; i < n; i++) es += eps[i] * w[i];
      const mean = ws > 0 ? es / ws : 0;
      const e = this.shown.e.length === n ? this.shown.e : new Float64Array(n);
      for (let i = 0; i < n; i++) e[i] = eps[i] - mean;
      this.shown = { e, sig, lambda, Eeff, lo, hi, kPost, effectiveWidth };
    }
    this.slices.forEach((sl, i) => {
      this.sigmaF[sl.s] = sigma[i];
      sl.clipped = held[i] !== 0;
      this.dEps[sl.s] = D[i];
      // a held-slack slice's excess elongation is a wave - less what a post-buckling
      // stiffness carries as compression; past the yield cap it is stretch, not a wave
      this.manifest[sl.s] = held[i] < 0 ? Math.max(0, (sigma[i] - free[i]) / Eeff) : 0;
    });
    if (!withJacobian) return;
    // T = dσ/dz = J⁻¹ F_h h_z, h_z = diag(gain · dh1/dg), z as in `gapGain`
    const wL = buildFh();
    // with the feedback off the strip carries its set tension everywhere
    // (E' = 0): F_h, and so T, is zero, and the Woodbury update would cost
    // m band solves an iteration to add nothing
    this.tensionLive = Eeff > 0 && wL > 1e-9 * ws;
    const T = this.T;
    T.fill(0);
    if (!this.tensionLive) return;
    buildJ();
    // one LU of J, then a back-substitution per column (J was being
    // refactorised for every column, n LUs where one does)
    const piv = new Int32Array(n);
    if (!luFactor(J, n, piv)) { T.fill(0); this.tensionLive = false; return; }
    const col = new Float64Array(n);
    const gain = this.gapGain();
    for (let j = 0; j < n; j++) {
      const hv = gain * this.slices[j].dh1dg;
      let any = false;
      for (let i = 0; i < n; i++) { col[i] = Fh[i * n + j] * hv; if (col[i] !== 0) any = true; }
      if (any) luSolve(J, n, piv, col);
      for (let i = 0; i < n; i++) T[i * n + j] = col[i];
    }
  }

  /** the screw, stepped towards the control target from the last solve */
  private stepScrew(): void {
    const p = this.p;
    if (p.mode === 'screw') { this.screw = p.screw; return; }
    const y = p.mode === 'gauge' ? this.h1Mean : this.forceTotal;
    const target = p.mode === 'gauge' ? p.h0 * (1 - p.reduction) : p.targetForce;
    const err = y - target;
    // dy/dS: gauge closes with the screw (negative), force grows (positive)
    let gain = p.mode === 'gauge' ? -0.5 : 4e9;
    if (this.secant && Math.abs(this.secant.s - this.screw) > 1e-9) {
      const g = (y - this.secant.y) / (this.screw - this.secant.s);
      if (p.mode === 'gauge' ? g < -0.02 && g > -1.5 : g > 1e8 && g < 1e11) gain = g;
    }
    this.secant = { s: this.screw, y };
    let step = -err / gain;
    const cap = p.mode === 'gauge' ? 0.15 * p.h0 + 20e-6 : 0.15 * p.h0 + 20e-6;
    step = Math.max(-cap, Math.min(cap, step));
    // negative = opened past the touching position; an AS-U or crown that
    // pre-loads the stack can need that to hit a light reduction
    this.screw = Math.max(SCREW_MIN, Math.min(SCREW_MAX, this.screw + step));
  }

  /** whether the screw sits on its target */
  private screwSettled(): boolean {
    const p = this.p;
    if (p.mode === 'screw') return true;
    if (p.mode === 'gauge') return Math.abs(this.h1Mean - p.h0 * (1 - p.reduction)) < 2e-4 * p.h0;
    return Math.abs(this.forceTotal - p.targetForce) < 2e-3 * Math.max(p.targetForce, 1);
  }

  /**
   * Advance the solution: Newton iterations until converged or the time
   * budget is spent, then a screw step. Returns whether anything moved.
   */
  advance(budgetMs: number, maxIter = 12): boolean {
    const t0 = performance.now();
    let n = 0;
    let moved = false;
    while (n < maxIter) {
      this.iterate();
      n++;
      moved = true;
      this.sinceStep++;
      // The screw moves inside the Newton, so a settled Newton is on target
      // unless the screw is at its travel limit or has had no contact to
      // steer by. A Newton that cannot settle for a long while (a barely
      // touching strip, where the tension's active set flips) still lets
      // the FEM correction be refreshed once it is nearly settled.
      const settled = this.residual < SETTLED_RESIDUAL && this.stepMax < SETTLED_STEP;
      const stalled = !settled && this.sinceStep > STEP_ESCAPE_ITERS && this.residual < NEAR_SETTLED;
      if (settled || stalled) {
        this.sinceStep = 0;
        let femSettled = true;
        if (this.p.stripModel !== 'slab') {
          const change = this.femCorrection(this.sigmaSlices());
          this.femRounds++;
          this.femLastChange = change;
          // Settled tightly, or loosely for several rounds running: the
          // correction can hold a small limit cycle (a slice's load flipping
          // on a one-sided contact) that never dies but changes nothing
          // anyone can see.
          this.femLooseRuns = change <= 10 * FEM_FIXED_TOL ? this.femLooseRuns + 1 : 0;
          femSettled = change <= FEM_FIXED_TOL || this.femLooseRuns >= FEM_LOOSE_RUNS;
        }
        const onTarget = this.screwSettled();
        // the non-local flattening follows the loads one iteration late: settled once it has stopped moving
        const nlSettled = !this.nlLive || this.nlChange <= SETTLED_STEP;
        if (settled && onTarget && femSettled && nlSettled) { this.converged = true; break; }
        // off target with the Newton settled: the screw at a limit, or no
        // contact yet - the secant step as a fallback
        if (settled && !onTarget && this.p.mode !== 'screw') {
          this.stepScrew();
          this.femRounds = 0;
          this.femLooseRuns = 0;
          this.aaX = []; this.aaF = [];
        }
        this.converged = false;
      }
      if (performance.now() - t0 > budgetMs) break;
    }
    this.collect(n, performance.now() - t0);
    return moved;
  }

  /** the housing deformation mode is on and this mill is inside its scope (2Hi / 4Hi / 6Hi) */
  private housingActive(): boolean {
    return housingInScope(this.p);
  }

  /**
   * The housing deformation mode's part of the assembly: the screw roll's
   * chocks on the housing frame, and a 6Hi intermediate roll's chocks seated
   * on the backup roll's (see `housing.ts`). Returns the largest force it put
   * into the residual, for the residual's scale.
   *
   * The frame. Each side's top and bottom chock loads R = K (u − t) through
   * the side's 2×2 stiffness, t the screw's (and the leveling's) target as
   * for the independent springs; on a mirror the lower chock is the upper
   * one's image and each half sees `halfStiffness`. The two chocks of a side
   * are the same station on the two halves' screw rolls, a few unknowns
   * apart, so the coupling stays in the band.
   *
   * The seat. Between an intermediate chock and the backup chock on the same
   * side: compression δ = v_IR − v_BUR > 0 (the chock pressed towards the
   * backup roll's; both are zero unloaded, so the seat touches with no load)
   * gives k δ, pushing the two apart; a seat that opens carries nothing. The
   * two chocks sit at different stations - the intermediate roll is shifted -
   * so the seat's stiffness is kept out of the band: `iterate` applies it as
   * a Woodbury update over the seats in contact (`prepareSeats`).
   */
  private assembleHousing(withK: boolean): number {
    const p = this.p;
    const { K, rhs, u, rolls } = this;
    const c = housingCompliance(p);
    const lev = p.leveling;
    const top = this.screwRolls[0];
    const bot = this.wrLower >= 0 ? this.screwRolls[1] : -1;
    const T = rolls[top];
    const target = (r: number, s: number) => -this.screw - (lev * this.x[s]) / Math.max(rolls[r].def.Ls, 1e-9);
    let scale = 0;
    const chockLoads: [number, number][] = [];
    for (let k = 0; k < 2; k++) {
      const sT = T.supports[k], iT = this.idx(sT, top, 0);
      const eT = u[iT] - target(top, sT);
      if (bot < 0) {
        const kh = halfStiffness(c);
        const f = kh * eT;
        rhs[iT] -= f;
        if (withK) { K.add(iT, iT, kh); this.bScrew[iT] += kh; }
        T.reactions[k] = f;
        chockLoads.push([f, f]);
        scale = Math.max(scale, Math.abs(f));
      } else {
        const B = rolls[bot];
        const sB = B.supports[k], iB = this.idx(sB, bot, 0);
        const eB = u[iB] - target(bot, sB);
        const [k11, k12, k22] = sideStiffness(c);
        const fT = k11 * eT + k12 * eB, fB = k12 * eT + k22 * eB;
        rhs[iT] -= fT; rhs[iB] -= fB;
        if (withK) {
          K.add(iT, iT, k11); K.add(iB, iB, k22); K.add(iT, iB, k12);
          this.bScrew[iT] += k11 + k12; this.bScrew[iB] += k12 + k22;
        }
        T.reactions[k] = fT; B.reactions[k] = fB;
        chockLoads.push([fT, fB]);
        scale = Math.max(scale, Math.abs(fT), Math.abs(fB));
      }
    }
    this.housingLoads = chockLoads;

    // the intermediate chocks' seats
    this.seats.length = 0;
    if (p.mill === '6hi' && p.irSeat) {
      const halves = bot < 0 ? [[0, top]] : [[0, top], [this.upper, bot]];
      for (const [base, bur] of halves) {
        const ir = base + 1, IR = rolls[ir], BUR = rolls[bur];
        if (IR.def.support !== 'chock') continue;
        for (let k = 0; k < 2; k++) {
          const iv = this.idx(IR.supports[k], ir, 0), ib = this.idx(BUR.supports[k], bur, 0);
          const delta = u[iv] - u[ib];
          const active = delta > 0;
          const f = active ? p.irSeatK * delta : 0;
          rhs[iv] -= f; rhs[ib] += f;
          this.seats.push({ iv, ib, k: p.irSeatK, active, force: f });
          scale = Math.max(scale, f);
        }
      }
    }
    return scale;
  }

  /**
   * The Woodbury pieces for the seats in contact: K_full = K' + A D Aᵀ with
   * K' the band and the tension coupling (`wb`), A's columns e_IR − e_BUR,
   * D their stiffnesses. Z = K'⁻¹A (one banded solve a seat), and
   * G = D⁻¹ + AᵀZ factored; `applySeats` then turns K'⁻¹v into K_full⁻¹v.
   */
  private prepareSeats(wb: ReturnType<StackSolver['prepareWoodbury']>): { Z: Float64Array[]; G: Float64Array; piv: Int32Array; on: { iv: number; ib: number }[] } | null {
    const on = this.seats.filter((q) => q.active);
    const m = on.length;
    if (m === 0) return null;
    const n = this.u.length;
    const Z: Float64Array[] = [];
    for (const q of on) {
      const z = new Float64Array(n);
      z[q.iv] = 1; z[q.ib] = -1;
      this.K.solveLeading(z, 0, this.vEnd);
      if (wb) this.applyWoodbury(wb, z);
      Z.push(z);
    }
    const G = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) G[i * m + j] = Z[j][on[i].iv] - Z[j][on[i].ib] + (i === j ? 1 / this.seats.find((q) => q === on[i])!.k : 0);
    }
    const piv = new Int32Array(m);
    if (!luFactor(G, m, piv)) return null;
    return { Z, G, piv, on };
  }

  private applySeats(sw: { Z: Float64Array[]; G: Float64Array; piv: Int32Array; on: { iv: number; ib: number }[] }, v: Float64Array): void {
    const m = sw.on.length;
    const y = new Float64Array(m);
    for (let i = 0; i < m; i++) y[i] = v[sw.on[i].iv] - v[sw.on[i].ib];
    luSolve(sw.G, m, sw.piv, y);
    for (let j = 0; j < m; j++) {
      const z = sw.Z[j], yj = y[j];
      if (yj === 0) continue;
      for (let i = 0; i < v.length; i++) v[i] -= z[i] * yj;
    }
  }

  private emptyResult(): Result3D {
    const ns = this.ns;
    const nan = () => new Float64Array(ns).fill(NaN);
    // the results show the upper half; a solved lower half stays inside
    const up = this.upper;
    return {
      x: this.x, rolls: this.rolls.slice(0, up), contacts: this.contacts.filter((c) => c.a < up && c.b < up),
      h0: nan(), h1: nan(), q: nan(), flat: nan(), dEps: nan(), manifest: nan(), sigmaF: nan(),
      force: 0, h1Mean: this.p.h0, h1Centre: this.p.h0, crown: 0, wedge: 0, edgeDropL: 0, edgeDropR: 0, crown0: 0, edgeDrop0: 0,
      profile: { x: new Float64Array(0), latent: new Float64Array(0), wave: new Float64Array(0) },
      latentIU: 0, manifestIU: 0, yieldRelief: 0, screw: this.screw, residual: Infinity, stepMax: Infinity,
      iterations: 0, converged: false, warnings: [], notes: [], fem: null, arc: nan(), wrGap: nan(), solveMs: 0, dof: this.u.length, bandwidth: this.K.hb,
      housing: null,
    };
  }

  /**
   * The elongation profile as shown and summarised.
   *
   * The slices' own `dEps` is the smoothed elongation at each slice's position, and on an even
   * grid the slice of an edge cell narrower than half a cell sits at the strip edge (its station
   * is off the strip). So as the strip widened past a cell boundary a slice came onto it at no
   * width and at once added a point at the edge, one-sided in the smoothing: on a 2Hi at 81
   * stations the latent flatness jumped by 430 I-units (17 802 → 18 231) between 1023.75 and
   * 1023.76 mm while the load and the crown moved in the fourth digit.
   *
   * Here the same smoothing - the Gaussian of the strip solve, its length `sig` - is evaluated at
   * fixed points instead: the stations on the strip, and the strip's two edges (clipped to the
   * slices' cells, for a strip past the barrel). It runs over every slice by its weight, so a new
   * slice enters at zero weight, and it is not cut off at the solve's index window but at 8 σ
   * (e^-32), so no slice enters it with a step either. The wave is the part of that elongation
   * past the one at which the free stress reaches the buckling limit, D_cr = (σ̄ + λ − lo)/E′ -
   * which at every slice is the solver's own `manifest` (held slack: D − D_cr; live and held
   * taut: below D_cr). With a post-buckling stiffness the buckled strip carries part of that as
   * compression, and the wave is what is left, (b(free) − free)/E′ as in `stripSolve`:
   * (1 − β)(D − D_cr) on the linear law.
   */
  private elongationProfile(): Result3D['profile'] {
    const sl = this.slices, n = sl.length;
    const { e, sig, lambda, Eeff, lo, hi, kPost, effectiveWidth } = this.shown;
    if (n === 0 || e.length !== n || !(sig > 0)) return { x: new Float64Array(0), latent: new Float64Array(0), wave: new Float64Array(0) };
    const { cellL, cellR } = this.grid;
    const half = this.p.width / 2;
    const xL = Math.max(-half, cellL[sl[0].s]), xR = Math.min(half, cellR[sl[n - 1].s]);
    const pts: number[] = [xL];
    for (const s of sl) { const x = this.x[s.s]; if (x > xL + 1e-12 && x < xR - 1e-12) pts.push(x); }
    pts.push(xR);
    const m = pts.length;
    const x = Float64Array.from(pts), latent = new Float64Array(m), wave = new Float64Array(m);
    const reach = 8 * sig;
    const Dcr = Eeff > 0 ? (this.p.frontTension + lambda - lo) / Eeff : Infinity;
    let j0 = 0;
    for (let k = 0; k < m; k++) {
      while (j0 < n - 1 && sl[j0].x < x[k] - reach) j0++;
      let a = 0, b = 0;
      for (let j = j0; j < n && sl[j].x <= x[k] + reach; j++) {
        const d = (sl[j].x - x[k]) / sig;
        const g = Math.exp(-0.5 * d * d) * sl[j].weight;
        a += g * e[j]; b += g;
      }
      latent[k] = b > 0 ? a / b : 0;
      if (kPost > 0 && latent[k] > Dcr) {
        const free = this.p.frontTension + lambda - Eeff * latent[k];
        wave[k] = Math.max(0, (postBuckled(free, -lo, hi, kPost, effectiveWidth).stress - free) / Eeff);
      } else wave[k] = Math.max(0, latent[k] - Dcr);
    }
    return { x, latent, wave };
  }

  private collect(iters: number, ms: number): void {
    const R = this.result;
    const p_ = this.p;
    const { ns, nr, u } = this;
    for (let r = 0; r < nr; r++) {
      const roll = this.rolls[r];
      for (let s = 0; s < ns; s++) {
        const inside = s >= roll.ia && s <= roll.ib;
        roll.v[s] = inside ? u[this.idx(s, r, 0)] : NaN;
        roll.w[s] = inside ? u[this.idx(s, r, 2)] : NaN;
      }
    }
    // per-roll summaries for the picture: bow, largest deflection, own flattening
    for (const c of this.contacts) {
      for (let s = 0; s < ns; s++) {
        const [a, b] = c.weight[s] > 0 ? approachParts(c.law, c.q[s]) : [0, 0];
        c.dA[s] = a; c.dB[s] = b;
      }
    }
    for (let r = 0; r < nr; r++) {
      const roll = this.rolls[r];
      const d = roll.def;
      const st = (x: number) => Math.max(roll.ia, Math.min(roll.ib, this.stationOf(x)));
      const sC = st(d.shift), sL = st(d.shift - d.Lb / 2), sR = st(d.shift + d.Lb / 2);
      const vv = (s: number) => (Number.isFinite(roll.v[s]) ? roll.v[s] : 0);
      roll.bow = vv(sC) - 0.5 * (vv(sL) + vv(sR));
      let vm = 0;
      for (let s = roll.ia; s <= roll.ib; s++) if (Math.abs(vv(s)) > Math.abs(vm)) vm = vv(s);
      roll.vMax = vm;
      let fm = 0;
      for (const c of this.contacts) {
        const arr = c.a === r ? c.dA : c.b === r ? c.dB : null;
        if (!arr) continue;
        for (let s = 0; s < ns; s++) fm = Math.max(fm, arr[s]);
      }
      if (r === this.stack.wr || r === this.wrLower) for (const sl of this.slices) fm = Math.max(fm, sl.flat);
      roll.flatMax = fm;
      // Bending curvature, for the fibre stress E r κ: the derivative of the
      // section rotation, which is the beam element's rotational unknown. It
      // used to be v'' by central differences, smoothed once - but v carries
      // the shear deflection too, whose slope jumps at every concentrated
      // force (a screw support, a saddle, a bender chock), and that jump read
      // as a curvature spike: 247 MPa at a 4Hi backup roll's neck, where the
      // moment from the support reaction gives about 54.
      roll.kv.fill(NaN); roll.kw.fill(NaN);
      let bm = 0;
      for (let s = roll.ia; s <= roll.ib; s++) {
        const a = Math.max(roll.ia, s - 1), b2 = Math.min(roll.ib, s + 1);
        const span = this.grid.uniform ? (b2 - a) * this.dx : this.x[b2] - this.x[a];
        roll.kv[s] = span > 0 ? (u[this.idx(b2, r, 1)] - u[this.idx(a, r, 1)]) / span : 0;
        roll.kw[s] = span > 0 ? (u[this.idx(b2, r, 3)] - u[this.idx(a, r, 3)]) / span : 0;
        // the fibre of the section that bends: a backing shaft bends as the
        // shaft under its bearing rings (the rings carry none of it), so its
        // stress is the shaft's - the ring radius overstated it by D/Dn
        const rad = d.shaftBeam || !onBarrel(d, this.x[s]) ? d.Dn / 2 : d.D / 2;
        bm = Math.max(bm, d.E * rad * Math.hypot(roll.kv[s], roll.kw[s]));
      }
      roll.bendMax = bm;
    }
    // Hertz peak pressure per contact and station: p0 = 2 q / (π b)
    for (const c of this.contacts) {
      for (let s = 0; s < ns; s++) {
        const q = c.q[s];
        c.p0[s] = q > 0 ? (2 * q) / (Math.PI * Math.max(Math.sqrt(c.law.bCoef * q), c.law.bFloor, 1e-9)) : 0;
      }
    }
    for (let r = 0; r < nr; r++) {
      let hm = 0;
      for (const c of this.contacts) if (c.a === r || c.b === r) for (let s = 0; s < ns; s++) hm = Math.max(hm, c.p0[s]);
      if (r === this.stack.wr || r === this.wrLower) {
        for (const sl of this.slices) {
          if (sl.q <= 0) continue;
          const b = Math.max(Math.sqrt(this.wsLaw.bCoef * sl.q), sl.arc / 2, 1e-9);
          hm = Math.max(hm, (2 * sl.q) / (Math.PI * b));
        }
      }
      this.rolls[r].hertzMax = hm;
    }
    R.fem = (p_.stripModel === 'fem' || p_.stripModel === 'fem3d') ? this.femResult : null;
    R.arc.fill(NaN);
    R.h0.fill(NaN); R.h1.fill(NaN); R.q.fill(NaN); R.flat.fill(NaN);
    R.dEps.fill(NaN); R.manifest.fill(NaN); R.sigmaF.fill(NaN);
    for (const sl of this.slices) {
      R.h0[sl.s] = sl.h0; R.h1[sl.s] = sl.h1; R.q[sl.s] = sl.q; R.flat[sl.s] = sl.flat; R.arc[sl.s] = sl.arc;
      R.dEps[sl.s] = this.dEps[sl.s]; R.manifest[sl.s] = this.manifest[sl.s];
      R.sigmaF[sl.s] = this.sigmaF[sl.s];
    }
    R.profile = this.elongationProfile();
    let lat0 = Infinity, lat1 = -Infinity, man = 0;
    for (let k = 0; k < R.profile.x.length; k++) {
      lat0 = Math.min(lat0, R.profile.latent[k]); lat1 = Math.max(lat1, R.profile.latent[k]);
      man = Math.max(man, R.profile.wave[k]);
    }
    R.force = this.forceTotal;
    R.h1Mean = this.h1Mean;
    const at = (x: number) => this.h1At(x);
    const W = this.p.width;
    R.h1Centre = at(0);
    R.crown = at(0) - 0.5 * (at(-W / 2 + 0.025) + at(W / 2 - 0.025));
    R.wedge = at(-W / 2 + 0.025) - at(W / 2 - 0.025);
    R.edgeDropL = at(-W / 2 + 0.1) - at(-W / 2 + 0.015);
    R.edgeDropR = at(W / 2 - 0.1) - at(W / 2 - 0.015);
    {
      const in0 = (x: number) => this.sliceAt(x, (sl) => sl.h0);
      R.crown0 = in0(0) - 0.5 * (in0(-W / 2 + 0.025) + in0(W / 2 - 0.025));
      R.edgeDrop0 = 0.5 * (in0(-W / 2 + 0.1) - in0(-W / 2 + 0.015) + in0(W / 2 - 0.1) - in0(W / 2 - 0.015));
    }
    R.latentIU = Number.isFinite(lat1 - lat0) ? (lat1 - lat0) * 1e5 : 0;
    {
      let rel = 0, n = 0;
      if (p_.tensionFeedback) {
        const e0 = Math.max(p_.entryStrain, 0);
        for (const sl of this.slices) {
          if (sl.q <= 0) continue;
          const kf = kfMean(this.law, e0, e0 + 1.1547 * Math.log(sl.h0 / Math.max(sl.h1, 1e-9)));
          rel += (p_.slabTension === 'split'
            ? sliceTension(this.law, sl.h0, sl.h1, p_.backTension, this.sigmaF[sl.s], sl.arc)
            : Math.min(0.5 * (p_.backTension + this.sigmaF[sl.s]), TENSION_CAP * kf)) / kf;
          n++;
        }
      }
      R.yieldRelief = n ? rel / n : 0;
    }
    R.manifestIU = man * 1e5;
    R.screw = this.screw;
    // upper and lower work rolls meeting beside the strip: the model has
    // nothing there to stop the rolls, so it is only reported
    {
      const wr = this.rolls[this.stack.wr];
      R.wrGap.fill(NaN);
      for (let s = wr.ia; s <= wr.ib; s++) {
        if (this.sliceW[s] > 0 || !onBarrel(wr.def, this.x[s]) || !Number.isFinite(wr.v[s])) continue;
        R.wrGap[s] = this.gapAt(s);
      }
    }
    R.housing = this.housingActive() ? this.housingResult() : null;
    R.warnings = this.diagnose();
    R.notes = [...this.stack.issues];
    {
      const over = this.stripOverhang();
      if (over > 0) {
        const wr = this.stack.rolls[this.stack.wr];
        R.notes.push(`板幅 ${(p_.width * 1e3).toFixed(0)} mm > WR 胴長 ${(wr.Lb * 1e3).toFixed(0)} mm: 胴からはみ出した板 ${(over * 1e3).toFixed(0)} mm（両側合計）は圧延されず、荷重・板厚・形状の計算に入らない`);
      }
    }
    {
      let xMin = Infinity, xMax = -Infinity, deepest = 0;
      for (let s = 0; s < ns; s++) {
        const g = R.wrGap[s];
        if (!(g <= 0)) continue;
        xMin = Math.min(xMin, this.x[s]); xMax = Math.max(xMax, this.x[s]); deepest = Math.max(deepest, -g / 2);
      }
      if (Number.isFinite(xMin)) {
        R.notes.push(`WR 同士の接触: x = ${(xMin * 1e3).toFixed(0)}〜${(xMax * 1e3).toFixed(0)} mm（板端 ±${(p_.width / 2 * 1e3).toFixed(0)} mm の外）、板厚中央面への食い込み 最大 ${(deepest * 1e6).toFixed(0)} µm`);
      }
    }
    R.residual = this.residual;
    R.stepMax = this.stepMax;
    R.iterations = iters;
    R.converged = this.converged;
    R.solveMs = ms;
    R.dof = u.length;
    R.bandwidth = this.K.hb;
  }

  /** the pass's problems, from the slices' own flags and the control state */
  /**
   * How much of the strip's width lies off the work roll's barrel [m], both
   * sides together. The slices are only cut where the barrel is (see
   * `refreshProfiles`), so that part of the strip is simply not rolled and
   * not counted - which is right for the rolls and wrong for the reader who
   * set a width the mill cannot take, hence the warning.
   */
  private stripOverhang(): number {
    const wr = this.stack.rolls[this.stack.wr];
    const b0 = wr.shift - wr.Lb / 2, b1 = wr.shift + wr.Lb / 2;
    const w = this.p.width;
    const over = Math.max(0, b0 - (-w / 2)) + Math.max(0, w / 2 - b1);
    return over > 1e-9 ? over : 0;
  }

  private diagnose(): Warning3D[] {
    const p = this.p;
    const w: Warning3D[] = [];
    let runaway = 0, closed = 0, bite = 0, loaded = 0;
    for (const sl of this.slices) {
      if (sl.q <= 0) continue;
      loaded++;
      if (sl.runaway) runaway++;
      if (sl.h1 <= H_MIN_FRAC * sl.h0 * 1.0001 + 1e-12) closed++;
      // bite: the entry angle on the flattened arc must be under the friction angle
      const dh = sl.h0 - sl.h1;
      if (dh > 0 && sl.arc > 0 && dh / sl.arc > p.mu) bite++;
    }
    // Stone's minimum rollable thickness, as the 2D tab computes it:
    // h_min = C μ R (k̄f − σ̄t), C = 16 (1 − ν²)/(π E_roll). A target under
    // it has no steady pass whether or not a slice has hit the load cap yet.
    {
      const wr = this.stack.rolls[this.stack.wr];
      const e0 = Math.max(p.entryStrain, 0);
      const kfM = kfMean(this.law, e0, e0 + 1.1547 * Math.log(1 / (1 - Math.min(p.reduction, 0.95))));
      const C = (16 * (1 - wr.nu * wr.nu)) / (Math.PI * wr.E);
      const hMinStone = C * p.mu * (wr.D / 2) * Math.max(kfM - 0.5 * (p.backTension + p.frontTension), 0);
      const target = p.mode === 'gauge' ? p.h0 * (1 - p.reduction) : this.h1Mean;
      if (runaway > 0 || target < hMinStone) w.push('stone');
    }
    if (closed > 0) w.push('gapClosed');
    if (loaded > 0 && bite > loaded / 2) w.push('bite');
    const e0 = Math.max(p.entryStrain, 0);
    const kf = kfMean(this.law, e0, e0 + 1.1547 * Math.log(1 / (1 - Math.min(p.reduction, 0.95))));
    if (Math.max(p.frontTension, p.backTension) > 0.9 * TENSION_CAP * kf) w.push('tensionYield');
    if (this.stack.issues.length) w.push('layout');
    if (this.stripOverhang() > 0) w.push('stripWide');
    if (p.housingMode && !this.housingActive()) w.push('housingScope');
    if (this.housingActive() && housingPlan(p, this.rolls[this.screwRolls[0]].def).stripOverlap > 0) w.push('housingStrip');
    for (let s = 0; s < this.ns; s++) if (this.result.wrGap[s] <= 0) { w.push('wrTouch'); break; }
    if ((p.stripModel === 'fem' || p.stripModel === 'fem3d') && this.femResult && !this.femResult.converged) w.push('fem');
    // a designated contact carrying nothing once the solve has settled: the
    // roll above has lifted off, which no cluster is built to do
    if (this.converged && this.contacts.some((c) => c.total <= 0)) w.push('openContact');
    const stuckAt = (p.stripModel === 'fem' || p.stripModel === 'fem3d') ? STUCK_ITERS_FEM : STUCK_ITERS;
    if (this.iterations > stuckAt && !this.converged) w.push('stuck');
    if (p.mode !== 'screw' && this.iterations > stuckAt && !this.screwSettled()
      && (this.screw <= SCREW_MIN + 1e-9 || this.screw >= SCREW_MAX - 1e-9)) w.push('target');
    return w;
  }

  private housingResult(): HousingResult {
    const c = housingCompliance(this.p);
    const sides = this.housingLoads.map(([ft, fb]) => {
      const post = (c.post * (ft + fb)) / 2, crossheadTop = c.crosshead * ft, crossheadBottom = c.crosshead * fb;
      return { force: (ft + fb) / 2, post, crossheadTop, crossheadBottom, stretch: post + crossheadTop + crossheadBottom };
    });
    const mirror = this.wrLower < 0;
    const seatForces = this.seats.map((q) => q.force);
    if (mirror && seatForces.length) seatForces.push(...seatForces);
    const T = this.rolls[this.screwRolls[0]];
    const burTilt = this.u[this.idx(T.supports[1], this.screwRolls[0], 0)] - this.u[this.idx(T.supports[0], this.screwRolls[0], 0)];
    const meanStretch = sides.length ? sides.reduce((a, b) => a + b.stretch, 0) / sides.length : 0;
    return { sides, seatForces, burTilt, millModulus: meanStretch > 0 ? this.forceTotal / meanStretch : 0 };
  }

  /** exit thickness at x by linear interpolation between slices */
  private h1At(x: number): number {
    return this.sliceAt(x, (sl) => sl.h1);
  }

  /** a slice quantity at x by linear interpolation between slices (held flat past the outermost) */
  private sliceAt(x: number, f: (sl: Slice) => number): number {
    const sl = this.slices;
    if (sl.length === 0) return this.p.h0;
    if (x <= sl[0].x) return f(sl[0]);
    for (let i = 1; i < sl.length; i++) {
      if (x <= sl[i].x) {
        const t = (x - sl[i - 1].x) / (sl[i].x - sl[i - 1].x || 1);
        return f(sl[i - 1]) + t * (f(sl[i]) - f(sl[i - 1]));
      }
    }
    return f(sl[sl.length - 1]);
  }

  get isConverged(): boolean { return this.converged; }

  /** where the solve stands (see `SolveProgress`) - cheap, for a status line every frame */
  progress(): SolveProgress {
    return {
      solve: this.solveCount,
      iterations: this.iterations,
      residual: this.residual,
      stepMax: this.stepMax,
      usesFem: this.p.stripModel !== 'slab',
      rounds: this.femRounds,
      femChange: this.femLastChange,
      looseRuns: this.femLooseRuns,
      sinceRound: this.sinceStep,
      warm: this.warmStart,
      converged: this.converged,
    };
  }
  wake(): void { this.converged = false; }
}

/** the inputs whose change means a new mesh */
function geometryKey(p: Params3D): string {
  return [
    p.mill, p.stations, p.stripStations, p.wrLb, p.wrLs, p.irLb, p.irLs, p.ir2Lb, p.burLb, p.burLs, p.bbLb,
    p.width, p.irShift, p.wrD, p.irD, p.ir2D, p.burD, p.bbD, p.angle1, p.mode,
  ].join('|');
}
