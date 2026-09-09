import './style.css';
import {
  RollingSim, fieldUnit, planeStrain, AGC_METHODS,
  type RollingParams, type FieldKind, type AgcMode, type AgcMethod,
} from './sim/solver';
import { Mill, MAX_STANDS, type StandSetup, type LineMode } from './sim/mill';
import {
  muFromLoad, exitStrain, MU_MIN, MU_MAX,
  type SlabCase, type MuInverseResult,
} from './sim/muinv';
import { MillLineView, type StandView } from './ui/millview';
import { Renderer, type Camera, type RenderOptions } from './gfx/renderer';
import { COLORMAP_NAMES, rampGradient } from './gfx/colormap';
import {
  BudgetChart, FrictionHillChart, AgcScatterChart,
  type HillSample, type AgcSample, type AgcTargets, type AgcTrail,
} from './ui/charts';
import {
  el, section, slider, select, toggle, buttonRow, StatGrid, numField, resetFolds,
  type NumFieldHandle,
} from './ui/controls';
import { probe, heap, bytes, type SysInfo } from './ui/sysinfo';
import { installLayout } from './ui/layout';
import * as settings from './ui/settings';

/* ── presets ─────────────────────────────────────────────────────────────── */

interface Preset { name: string; note: string; patch: Partial<RollingParams> }

/** N in one tonf (1000 kgf). Mill loads are quoted in these. */
const TONF = 9.80665e3;

/** stand count asked for on the query string, applied once the line exists */
let pendingStands = 1;

/** The dial's total load [tonf] as the load per unit width the solver wants [N/m]. */
function agcTargetPerWidth(): number {
  return (view.agcTargetTonf * TONF) / Math.max(view.stripWidth, 1e-6);
}

/** N/m per MN/mm. Stand stiffnesses are quoted in MN/mm. */
const MN_PER_MM = 1e9;

/** The dial's total mill modulus [MN/mm] as the per-unit-width value [Pa]. */
function millModulusPerWidth(): number {
  return (view.millModulusMNmm * MN_PER_MM) / Math.max(view.stripWidth, 1e-6);
}

/** s in one minute. Line speeds are quoted in m/min. */
const MPM = 60;

/** The dial's line speed [mpm] as the barrel angular speed the solver wants [rad/s]. */
function omegaFromMpm(): number {
  return view.rollSpeedMpm / MPM / Math.max(params.R, 1e-6);
}

const PRESETS: Preset[] = [
  {
    name: '冷間圧延 (薄板)',
    note: 'h0 2 mm → 25%, 低摩擦, ロール扁平が効く',
    patch: {
      R: 0.19, h0: 0.002, reduction: 0.25, omega: 6, mu: 0.06,
      lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255, rollCoupling: true,
    },
  },
  {
    name: '箔圧延 (極薄)',
    note: 'h0 0.05 mm → 25%, R 20 mm — ロール扁平が圧下の半分を食う',
    patch: {
      R: 0.03, h0: 0.00005, reduction: 0.25, omega: 3, mu: 0.08,
      lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255, rollCoupling: true,
    },
  },
  {
    name: '熱間圧延 (厚板)',
    note: 'h0 20 mm → 30%, 高摩擦, 低変形抵抗, 入側 1000 °C',
    patch: {
      R: 0.18, h0: 0.020, reduction: 0.30, omega: 3, mu: 0.30,
      lmnL: 265e6, lmnM: 0.010, lmnN: 0.204,
      // Not switched on - just the right datum if the heating model is. A hot
      // pass is much closer to melting, so the same degree of self-heating
      // costs far more strength than it does cold.
      tempEntry: 1000,
      rollCoupling: true,
    },
  },
  {
    name: '標準 (中板)',
    note: 'h0 8 mm → 25%, μ 0.10',
    patch: {
      R: 0.18, h0: 0.008, reduction: 0.25, omega: 3, mu: 0.10,
      lmnL: 954e6, lmnM: 0.010, lmnN: 0.259,
  Estrip: 2.1e11, nuStrip: 0.30, elasticZones: true,
      rollCoupling: true,
    },
  },
  {
    name: '大圧下 + 高摩擦',
    note: '45% 圧下, μ 0.35 — 摩擦丘が立つ',
    patch: {
      R: 0.18, h0: 0.012, reduction: 0.45, omega: 3, mu: 0.35,
      lmnL: 785e6, lmnM: 0.010, lmnN: 0.266,
      rollCoupling: true,
    },
  },
];

const MESH_LEVELS = {
  fast:     { nx: 70,  ny: 6,  nt: 140, nr: 4,  label: '軽量    板 70×6 / ロール 140×4' },
  balanced: { nx: 100, ny: 8,  nt: 200, nr: 5,  label: '標準    板 100×8 / ロール 200×5' },
  fine:     { nx: 140, ny: 10, nt: 260, nr: 6,  label: '高精度  板 140×10 / ロール 260×6' },
  ultra:    { nx: 200, ny: 14, nt: 340, nr: 8,  label: '最高    板 200×14 / ロール 340×8' },
  extreme:  { nx: 300, ny: 20, nt: 480, nr: 10, label: '超高精度 板 300×20 / ロール 480×10' },
  insane:   { nx: 440, ny: 28, nt: 660, nr: 14, label: '極限    板 440×28 / ロール 660×14' },
} as const;
type MeshLevel = keyof typeof MESH_LEVELS;

const FIELDS: { value: FieldKind; text: string }[] = [
  { value: 'strain',     text: '相当塑性ひずみ ε̄' },
  { value: 'strainRate', text: 'ひずみ速度 ε̄̇' },
  { value: 'flowStress', text: '変形抵抗 σf' },
  { value: 'temperature', text: '温度 T (加工発熱)' },
  { value: 'pressure',   text: '静水圧 (圧縮正)' },
  { value: 'vonMises',   text: 'ミーゼス応力' },
  { value: 'shear',      text: '最大せん断応力' },
  { value: 'speed',      text: '速度' },
  { value: 'rollDisp',   text: 'ロール弾性変位 |u|' },
  { value: 'rollRadial', text: 'ロール半径方向変位 u_r (扁平)' },
];
const FIELD_LABEL = new Map(FIELDS.map((f) => [f.value, f.text]));
/** fields that live on only one body; the other is drawn as plain steel */
const STRIP_ONLY = new Set<FieldKind>(
  ['strain', 'strainRate', 'flowStress', 'speed', 'temperature']);
const ROLL_ONLY = new Set<FieldKind>(['rollDisp', 'rollRadial']);
/** fields that take both signs, so they want a diverging ramp centred on zero */
const SIGNED_FIELDS = new Set<FieldKind>(['rollRadial']);
/**
 * Fields whose zero is an arbitrary point on the scale, so the ramp is fitted
 * to the data rather than anchored at zero.
 *
 * Strain and stress start at zero and a ramp from zero reads correctly. A
 * temperature does not: cold rolling puts the whole strip in 20-66 °C and a
 * 0-66 ramp throws away the bottom third, and a hot pass sits at 1000-1019 °C
 * where anchoring at zero leaves the strip one flat colour.
 */
const OFFSET_FIELDS = new Set<FieldKind>(['temperature']);
/**
 * The ramp a field asks for when it is selected.
 *
 * `rollRadial` takes both signs and wants a diverging ramp centred on zero.
 * Temperature wants one too, for a different reason: blue-cold to red-hot is
 * how everyone reads a thermal picture, and unlike the dark sequential ramps
 * its low end is a visible blue rather than black - on this background a
 * black-floored ramp makes the unheated strip vanish into the page.
 */
const FIELD_RAMP: Partial<Record<FieldKind, string>> = {
  rollRadial: 'coolwarm',
  temperature: 'coolwarm',
};

/* ── state ───────────────────────────────────────────────────────────────── */

const params: RollingParams = {
  R: 0.19, hubRatio: 0.45, rollNt: 200, rollNr: 5,
  rollRadialGrade: 1.4, biteGrade: 0.90,
  rollSkinRings: 4, rollSkinThickness: 0.002, rollSkinAuto: true, rollSkinFactor: 8,
  Eroll: 2.1e11, nuRoll: 0.30, omega: 6.0,
  h0: 0.002, reduction: 0.25, stripNx: 100, stripNy: 8,
  windowIn: -0.040, windowOut: 0.025, autoFit: true,
  lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255,
  // Off by default: every figure in docs/validation.md was measured isothermal,
  // and the switch is only worth anything as a clean A/B against them.
  heatOn: false, tempEntry: 20, taylorQuinney: 0.9,
  rhoStrip: 7850, cpStrip: 470, tempMelt: 1500, softenExp: 1.0,
  Estrip: 2.1e11, nuStrip: 0.30, elasticZones: true,
  mu: 0.06, slipFrac: 0.02,
  backTension: 0, frontTension: 0, feedSpeed: 0,
  incompPenalty: 1e4, normalPenalty: 1e5, eps0Frac: 0.02,
  picardIters: 1, relax: 0.6, cgIter: 200, cgTol: 1e-8,
  rollCoupling: true, rollRelax: 0.12, rollEvery: 2,
  // 3e-3 left an 11 um bias in the settled screw position and made the gap
  // loop's answer depend on how it got there; at 3e-4 two different routes
  // to the same target agree to 0.02 um.
  feedEvery: 6, feedGain: 0.15, feedDeadband: 3e-4,
  agcMode: 'off', agcTargetForce: (800 * TONF) / 1.0,
  // Absolute-gauge setpoint. Seeded to the default pass's own exit so it is
  // never zero; the real value is adopted when a stand enters the mode.
  agcTargetGauge: 0.002 * (1 - 0.25),
  agcGain: 0.6, agcEvery: 4, agcDeadband: 1e-4, agcMaxStep: 0.02,
  agcMethod: 'secant',
  // off by default: with a rigid stand the only spring is the roll flattening,
  // which is what every number in docs/validation.md was measured against
  millSpringOn: false, millModulus: (5 * MN_PER_MM) / 1.0,
  sepFloorFrac: 0.30,
};

const view = {
  field: 'strain' as FieldKind,
  colormap: 'plasma',
  autoRange: true,
  manualMax: 1,
  rangeMin: 0,
  rangeMax: 1,
  meshLevel: 'balanced' as MeshLevel,
  running: true,
  solveEvery: 1,
  showWire: true,
  showMarks: true,
  showGrid: true,
  showPressure: true,
  showContact: true,
  showNeutral: true,
  /** 'full' mirrors the modelled half; 'half' shows only what is solved */
  extent: 'full' as 'full' | 'half',
  // Off by default: the markers are only a motion cue, and on a steady
  // Eulerian solution they are the one thing on screen that moves.
  showTracers: false,
  rollMagnify: 1,
  markAmount: 0.18,
  markCount: 8,
  /**
   * Strip width [m]. Purely a post-processing figure: the model is plane
   * strain, so the width is not discretised at all and every result is per
   * unit width. This just converts them to the whole-mill numbers.
   */
  stripWidth: 1.3,
  /**
   * Load target as the dial carries it: total force in tonf, which is what a
   * mill's load cell reads. The solver is plane strain and wants force per
   * unit width, so `syncAgcTarget` divides this by the strip width.
   */
  agcTargetTonf: 800,
  /**
   * Roll speed as the dial carries it: barrel surface speed in m/min, which is
   * how a line is actually run. The solver wants an angular speed, so
   * `syncRollSpeed` divides this by the roll radius - and redoes it whenever R
   * moves, because it is the line speed that is held, not omega.
   */
  rollSpeedMpm: 68.4,
  /** which stand the detailed view and the per-stand dials are showing */
  stand: 0,
  /**
   * Tandem line or reverse mill. Held here as well as on `mill` because the
   * panels word themselves differently for the two - a reverse mill has passes,
   * not stands - and the wording is a view concern.
   */
  lineMode: 'tandem' as LineMode,
  /**
   * Mill modulus as the dial carries it: total stand stiffness in MN/mm, the
   * way a stand is specified. `syncMillModulus` divides it by the strip width
   * for the plane-strain solver.
   */
  millModulusMNmm: 5,
};

/* ── query string overrides ──────────────────────────────────────────────── */
// Parsed before anything is built, so the widgets come up already matching.
const QS = new URLSearchParams(location.search);
const DEBUG_TITLE = QS.has('debug');
if (QS.has('nowire')) view.showWire = false;
if (QS.has('notrace')) view.showTracers = false;
if (QS.has('nomirror')) view.extent = 'half';
if (QS.has('nosolve')) view.running = false;
if (QS.has('nogrid')) view.showGrid = false;
{
  const qf = QS.get('field') as FieldKind | null;
  if (qf && FIELD_LABEL.has(qf)) {
    view.field = qf;
    const want = FIELD_RAMP[qf];
    if (want) view.colormap = want;
  }
  const qc = QS.get('cmap');
  if (qc && COLORMAP_NAMES.includes(qc)) view.colormap = qc;
  // Gap control, so a measurement run can start with the loop already closed.
  const qa = QS.get('agc');
  if (qa === 'off' || qa === 'ratio' || qa === 'gauge' || qa === 'force') params.agcMode = qa;
  // Absolute exit gauge in mm, so a measurement run can start on a setpoint.
  const qg = Number(QS.get('h1'));
  if (Number.isFinite(qg) && qg > 0) params.agcTargetGauge = qg / 1000;
  const qm = QS.get('mode');
  if (qm === 'tandem' || qm === 'reverse') view.lineMode = qm;
  const qs = Number(QS.get('stands'));
  if (Number.isFinite(qs) && qs >= 1) pendingStands = Math.min(MAX_STANDS, Math.round(qs));
  const ql = Number(QS.get('load'));   // target total load in tonf
  if (Number.isFinite(ql) && ql > 0) {
    view.agcTargetTonf = ql;
    params.agcTargetForce = agcTargetPerWidth();
  }
}

/**
 * Per-stand setup. `params` carries everything the whole line shares - the
 * material, the mesh, the numerics, the control gains - and this carries the
 * handful of things each stand owns. The dials in the left panel edit whichever
 * stand is selected, so there is one set of controls rather than five.
 */
const standSetups: StandSetup[] = Array.from({ length: MAX_STANDS }, (_, k) => ({
  R: params.R,
  mu: params.mu,
  reduction: params.reduction,
  targetForce: params.agcTargetForce,
  /*
   * Seeded down the schedule, not flat.
   *
   * Every stand taking the commanded reduction from the one before it is what
   * the default line actually does, so stand k's exit is h0*(1-r)^(k+1). A
   * flat seed put every stand's target at the *first* stand's exit, which is
   * at or above the entry gauge of every stand after it - so the second stand
   * onwards defaulted to a target it could not roll to, and anything reading
   * this field (絶対板厚制御, and the mu back-calculation) failed out of the box
   * on a multi-stand line for a reason that was pure bookkeeping.
   */
  targetGauge: params.h0 * Math.pow(1 - params.reduction, k + 1),
  backTension: params.backTension,
  frontTension: 0,
  agcMode: params.agcMode,
}));

/**
 * A settings file being restored, applied before anything reads these objects.
 *
 * Restoring works by reloading into the stashed state rather than by pushing
 * values into forty widgets, so this has to land while `params`, `view` and
 * `standSetups` are still just data - every dial is built from them further
 * down and comes up already showing the right number.
 *
 * After the query string, deliberately: a URL is something the operator typed
 * just now, and it should win over a file loaded a moment ago.
 */
const restored = settings.applyPending(
  params as unknown as Record<string, unknown>,
  view as unknown as Record<string, unknown>,
  standSetups as unknown as Record<string, unknown>[]);
if (restored.applied) {
  // Derived from the width and the per-stand targets, both of which may have
  // just moved underneath them.
  params.agcTargetForce = agcTargetPerWidth();
  params.millModulus = millModulusPerWidth();
  params.omega = omegaFromMpm();
}

/** What one element of the chain is called, in words and as a caption. */
const unitWord = () => (view.lineMode === 'reverse' ? 'パス' : 'スタンド');
const standTag = (k: number) => (view.lineMode === 'reverse' ? `P${k + 1}` : `#${k + 1}`);
let standCount = restored.standCount !== undefined
  ? Math.min(MAX_STANDS, restored.standCount)
  : pendingStands;
/** the setups actually in the line */
const activeSetups = () => standSetups.slice(0, standCount);

/**
 * Entry gauge of the stand currently on screen.
 *
 * Not `params.h0`: that is the gauge entering the *line*, and from the second
 * stand on it is a different number entirely - the stand's own entry is
 * whatever the one before it delivered. Every per-stand figure derived from an
 * entry gauge (the achieved reduction, the commanded exit gauge, the equivalent
 * strain, the camera framing) has to read it from the stand, not the line.
 */
const standH0 = () => sim.params.h0;

/* ── boot ────────────────────────────────────────────────────────────────── */

const canvas = document.getElementById('gl') as HTMLCanvasElement;
let mill: Mill;
/** the stand currently on screen; every single-stand readout reads through this */
let sim: RollingSim;
let renderer: Renderer;
let info: SysInfo;

try {
  mill = new Mill(params, activeSetups());
  // `?mode=reverse` is parsed before anything is built, so the chain comes up
  // already obeying the right couplings rather than switching on the first frame.
  mill.mode = view.lineMode;
  if (restored.autoSpeed !== undefined) mill.autoSpeed = restored.autoSpeed;
  sim = mill.stands[0];
  renderer = new Renderer(canvas);
  renderer.setMesh(sim);
  renderer.setColormap(view.colormap);
  info = probe(renderer.gl);
} catch (e) {
  const f = document.getElementById('fatal')!;
  f.hidden = false;
  f.textContent = `起動に失敗しました。\n\n${(e as Error).message}\n\nWebGL2 対応ブラウザで開いてください。`;
  throw e;
}

const cam: Camera = { cx: 0, cy: 0, zoom: 4000 };
function fitView(): void {
  const h = canvas.clientHeight || 600;
  const w = canvas.clientWidth || 900;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const spanX = (sim.winOut - sim.winIn) * 1.15;
  const half = view.extent === 'half';
  const spanY = half ? standH0() * 2.6 : standH0() * 5.5;
  cam.zoom = Math.min((w * dpr) / spanX, (h * dpr) / spanY);
  cam.cx = (sim.winIn + sim.winOut) / 2;
  // The window is usually wider than it is tall, so the vertical span comes out
  // of the horizontal fit. Rather than centring on nothing, sit the symmetry
  // plane just above the bottom edge and let the solved half fill the frame.
  const visibleY = (h * dpr) / cam.zoom;
  cam.cy = half ? visibleY / 2 - standH0() * 0.4 : 0;
}

/* ── material tracers ────────────────────────────────────────────────────── */

/**
 * Marker lines released at the entry and carried by the velocity field. In an
 * Eulerian model the mesh does not move, so these are what make the flow
 * visible - and their distortion through the bite is the classic scribed-grid
 * picture from any rolling text.
 */
class Tracers {
  lines: Float32Array[] = [];
  private carry = 0;

  reset(): void { this.lines.length = 0; this.carry = 0; }

  /**
   * Advance the markers.
   *
   * A single forward-Euler step per frame is nowhere near enough: at rolling
   * speed a marker covers about 10 mm per frame while the bite is only a few
   * millimetres long, so the deformation zone gets sampled once or twice and
   * the recorded distortion is aliasing noise that changes every frame - the
   * lines visibly shimmer. Substepping on the bite length fixes that.
   *
   * The step is a midpoint (RK2) one, and deliberately not RK4. Measured
   * against a 4000-substep reference, at equal cost per frame:
   *
   *     Euler  1 sub  (  1 sample)   30 %      relative error
   *     RK2   12 subs ( 24 samples)   8.7e-4
   *     RK4    6 subs ( 24 samples)   1.3e-3
   *     RK2   24 subs ( 48 samples)   5.0e-5
   *     RK4   12 subs ( 48 samples)   2.2e-4
   *
   * RK4 is no better and slightly worse, because the velocity field it
   * integrates is only C0 - bilinear interpolation on the structured mesh.
   * A high-order time integrator cannot beat the spatial interpolation error,
   * so the budget is better spent on more substeps.
   */
  update(dt: number): void {
    const m = sim.flow.mesh;
    const span = sim.winOut - sim.winIn;
    const vRef = Math.max(sim.diag.entrySpeed, 1e-6);
    const travel = vRef * dt;

    // release markers at a fixed spacing, independent of the frame rate
    const seedGap = span / 14;
    this.carry += travel;
    while (this.carry >= seedGap && this.lines.length < 24) {
      this.carry -= seedGap;
      const n = m.ny + 1;
      const line = new Float32Array(2 * n);
      // the marker is born part way through the frame, so it has already moved
      const x0 = sim.winIn + Math.min(this.carry, span * 0.5);
      const top = surfaceAt(x0);
      for (let j = 0; j < n; j++) {
        line[2 * j] = x0;
        line[2 * j + 1] = (top * j) / m.ny;
      }
      this.lines.push(line);
    }

    // substep so that no marker crosses more than a fraction of the bite
    const arc = Math.max(sim.diag.arcLength, sim.nominalArc, 1e-9);
    const nSub = Math.max(1, Math.min(96, Math.ceil(travel / (arc / 24))));
    const h = dt / nSub;
    for (let sIdx = 0; sIdx < nSub; sIdx++) {
      for (const line of this.lines) {
        for (let k = 0; k < line.length; k += 2) {
          const x = line[k], y = line[k + 1];
          // midpoint (RK2): sample once at the start, once at the half step
          const [ax, ay] = sampleVelocity(x, y);
          const [bx, by] = sampleVelocity(x + 0.5 * h * ax, y + 0.5 * h * ay);
          let nx = x + h * bx;
          let ny2 = y + h * by;
          // keep the marker inside the strip; the surface point rides the
          // surface exactly instead of drifting off it
          const top = surfaceAt(nx);
          if (k === line.length - 2) ny2 = top;
          else if (ny2 > top) ny2 = top;
          if (ny2 < 0) ny2 = 0;
          line[k] = nx;
          line[k + 1] = ny2;
        }
      }
    }
    this.lines = this.lines.filter((l) => l[0] < sim.winOut);
  }
}

/** Strip surface height at x, interpolated between mesh columns. */
function surfaceAt(x: number): number {
  const m = sim.flow.mesh;
  const t = ((x - sim.winIn) / (sim.winOut - sim.winIn)) * m.nx;
  const i = Math.max(0, Math.min(m.nx - 1, Math.floor(t)));
  const f = Math.max(0, Math.min(1, t - i));
  const a = m.X[2 * m.topNodes[i] + 1];
  const b = m.X[2 * m.topNodes[i + 1] + 1];
  return a + (b - a) * f;
}

const tracers = new Tracers();

/** Bilinear velocity lookup on the structured, gap-conforming mesh. */
function sampleVelocity(x: number, y: number): [number, number] {
  const m = sim.flow.mesh;
  const t = ((x - sim.winIn) / (sim.winOut - sim.winIn)) * m.nx;
  const i = Math.max(0, Math.min(m.nx - 1, Math.floor(t)));
  const fx = Math.max(0, Math.min(1, t - i));
  const topA = m.X[2 * m.topNodes[i] + 1];
  const topB = m.X[2 * m.topNodes[i + 1] + 1];
  const top = topA + (topB - topA) * fx;
  const s = Math.max(0, Math.min(1, top > 0 ? y / top : 0)) * m.ny;
  const j = Math.max(0, Math.min(m.ny - 1, Math.floor(s)));
  const fy = s - j;
  const g = (ii: number, jj: number, c: number) => sim.flow.v[2 * (ii * m.rows + jj) + c];
  const out: [number, number] = [0, 0];
  for (let c = 0; c < 2; c++) {
    const v00 = g(i, j, c), v10 = g(i + 1, j, c);
    const v01 = g(i, j + 1, c), v11 = g(i + 1, j + 1, c);
    out[c] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  }
  return out;
}

/* ── UI: left panel ──────────────────────────────────────────────────────── */

const left = document.getElementById('left')!;
let rebuildTimer = 0;
let standRebuildTimer = 0;
/** stands queued for a local rebuild while the debounce runs */
const standRebuildQueue = new Set<number>();

/**
 * Rebuild one stand, not the line.
 *
 * A stand's roll geometry is local: nothing upstream depends on it, and
 * everything downstream reads its exit gauge through the live chain. Rebuilding
 * the whole line to change one roll radius would discard every other stand's
 * converged state - thousands of frames of work - for nothing.
 */
function scheduleStandRebuild(k: number): void {
  standRebuildQueue.add(k);
  clearTimeout(standRebuildTimer);
  standRebuildTimer = window.setTimeout(() => {
    const setups = activeSetups();
    for (const i of standRebuildQueue) {
      mill.rebuildStand(i, params, setups);
      // that stand's meshes are new objects, so the trail collected against
      // the old ones is stale - whether or not it is the stand on screen
      clearAgcTrail(i);
    }
    const touchedSelected = standRebuildQueue.has(view.stand);
    standRebuildQueue.clear();
    if (touchedSelected) {
      // the selected stand's meshes are new objects too, so the renderer's
      // uploads have to be redone
      sim = mill.stands[view.stand];
      renderer.setMesh(sim);
      tracers.reset();
      fieldDirty = true;
      refreshMeshHint();
    }
    refreshGeom();
  }, 160);
}

/** Change what a stand's screws are asked for. No mesh depends on it. */
function recommandStand(k: number, reduction: number): void {
  // Under load control the command does not move the screws, so the trail is
  // still a record of the operating point the stand is on. Only throw it away
  // when the stand actually moved.
  if (mill.recommand(k, reduction)) clearAgcTrail(k);
  if (k === view.stand) refreshGeom();
}

function scheduleRebuild(): void {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    mill.build(params, activeSetups());
    buildStandGrid();
    selectStand(view.stand);
    clearAgcTrail();
    tracers.reset();
    fieldDirty = true;
    // The camera stays where the user put it. Rebuilding is not a reason to
    // throw away their framing - they are usually watching one detail while
    // sweeping a parameter, which is exactly when a refit is most annoying.
    // F, or the ⤢ button, refits on demand.
    refreshGeom();
    refreshMeshHint();
    if (params.autoFit) {
      params.windowIn = sim.winIn;
      params.windowOut = sim.winOut;
      params.biteGrade = sim.biteGradeEff;
      sWinIn.set(sim.winIn); sWinOut.set(sim.winOut); sBite.set(sim.biteGradeEff);
    }
  }, 160);
}

const millLine = new MillLineView(
  document.getElementById('millcanvas') as HTMLCanvasElement,
  (i) => selectStand(i));
const millSub = document.getElementById('millline-sub') as HTMLElement;

/** One frame's worth of the whole line, in the units the line view draws in. */
function millViews(): StandView[] {
  const out: StandView[] = [];
  const b = view.stripWidth;
  for (let k = 0; k < mill.count; k++) {
    const st = mill.stands[k], d = st.diag;
    const p = st.params;
    const hIn = p.h0;
    const c = standSetups[k];
    out.push({
      hIn: hIn * 1000,
      hOut: (d.exitThickness > 0 ? d.exitThickness : hIn) * 1000,
      hOutTarget: hIn * (1 - c.reduction) * 1000,
      reduction: hIn > 0 ? Math.max(0, 1 - d.exitThickness / hIn) : 0,
      reductionTarget: c.reduction,
      load: (d.rollForce * b) / TONF,
      target: p.agcMode === 'force' ? (p.agcTargetForce * b) / TONF : 0,
      // Both ends of the pull as the stand sees them. The back tension is read
      // through `getBackTension` because on a tandem line it is the stand in
      // front's exit pull, not a value this row owns.
      backTension: getBackTension(k) / 1e6,
      frontTension: c.frontTension / 1e6,
      // Plane-strain kf, which is what a rolling load formula uses. The solve
      // carries the uniaxial flow stress, so those convert by 2/sqrt(3).
      //
      // Entry is the law at the condition the strip arrives in, which on a
      // tandem line is the stand upstream's exit - so this stand's `kf 入`
      // reads as the previous stand's `kf 出`, which is what the metal is
      // actually doing.
      kfEntry: planeStrain(p, d.entryStrain, d.entryTemp) / 1e6,
      kfMean: d.meanPlaneStrainStress / 1e6,
      kfExit: ((2 / Math.sqrt(3)) * d.exitFlowStress) / 1e6,
      hitchR: d.hitchcockR * 1000,
      hitchRatio: p.R > 0 ? d.hitchcockR / p.R : 1,
      forwardSlip: d.forwardSlip * 100,
      // Width scaled and doubled: the solve is per unit width and turns one
      // barrel, a drive turns two across the whole strip.
      torque: (Math.abs(d.torque) * b * 2) / 1000,
      power: (d.power * b * 2) / 1000,
      arc: d.arcLength * 1000,
      biteLimit: d.biteLimitH1 * 1000,
      stoneLimit: d.stoneHMin * 1000,
      tempIn: d.entryTemp > 0 ? d.entryTemp : p.tempEntry,
      tempOut: d.exitTemp > 0 ? d.exitTemp : d.entryTemp,
      heatOn: p.heatOn,
      R: p.R * 1000,
      tag: standTag(k),
      // The diagram highlights whichever row the loop is holding; both gauge
      // loops hold the reduction row, since that is where the gauge shows.
      mode: p.agcMode === 'ratio' ? 'gauge' : p.agcMode,
      agcError: Number.isFinite(d.agcError) ? d.agcError : 0,
      deadband: p.agcDeadband,
      state: p.agcMode === 'off' ? 'off'
        : d.agcIdle ? 'idle'
          : d.agcSaturated ? 'sat'
            : d.agcStalled ? 'stall'
              : d.agcSettled ? 'lock' : 'work',
    });
  }
  return out;
}

/* ── per-stand table, under the line ─────────────────────────────────────── */

const standGrid = document.getElementById('standgrid') as HTMLElement;

interface StandRowCells {
  head: HTMLElement;
  redNow: HTMLElement;
  gaugeNow: HTMLElement;
  loadNow: HTMLElement;
  mode: HTMLSelectElement;
  red: NumFieldHandle;
  gauge: NumFieldHandle;
  load: NumFieldHandle;
  backT: NumFieldHandle;
  ten: NumFieldHandle;
  mu: NumFieldHandle;
  rad: NumFieldHandle;
}

/**
 * Where a row's back tension is written.
 *
 * On a tandem line the pull between two stands is one quantity with two names:
 * the exit side of one is the entry side of the next. Both rows are shown
 * because that is how a schedule is discussed, and editing either writes the
 * same number. A reverse mill re-threads between passes, so there is no shared
 * quantity - every pass owns both of its ends.
 */
function setBackTension(k: number, pa: number): void {
  if (view.lineMode === 'reverse' || k === 0) standSetups[k].backTension = pa;
  else standSetups[k - 1].frontTension = pa;
}
function getBackTension(k: number): number {
  return view.lineMode === 'reverse' || k === 0
    ? standSetups[k].backTension
    : standSetups[k - 1].frontTension;
}
/** True where the row is a mirror of the stand in front, not an input of its own. */
const backIsMirrored = (k: number) => view.lineMode === 'tandem' && k > 0;
let standCells: StandRowCells[] = [];
/** The tint behind the selected stand's column; laid out from its heading cell. */
let colSel: HTMLElement | null = null;

/**
 * One column per stand, target above measurement.
 *
 * A tandem schedule is read across the line, not down one stand, so the numbers
 * that get compared - what each stand is being asked for and what it is
 * actually doing - are put side by side. Editing here beats selecting a stand
 * and reaching for the left panel five times.
 */
function buildStandGrid(): void {
  standGrid.textContent = '';
  standCells = [];
  colSel = el('div', 'sg-colsel');
  standGrid.append(colSel);
  const n = standCount;
  standGrid.style.gridTemplateColumns = `104px repeat(${n}, minmax(0, 1fr)) 34px`;

  const row = (label: string, cells: HTMLElement[], unit: string) => {
    standGrid.append(el('div', 'sg-label', label), ...cells, el('div', 'sg-unit', unit));
  };

  standGrid.append(el('div', 'sg-label', ''));
  const heads: HTMLElement[] = [];
  for (let k = 0; k < n; k++) {
    const h = el('div', 'sg-head', standTag(k));
    h.style.cursor = 'pointer';
    h.addEventListener('click', () => selectStand(k));
    heads.push(h);
    standGrid.append(h);
  }
  standGrid.append(el('div', 'sg-unit', ''));

  const mk = <T>(f: (k: number) => T) => Array.from({ length: n }, (_, k) => f(k));
  const reds = mk((k) => numField({
    value: standSetups[k].reduction * 100, min: 2, max: 55, step: 0.5, digits: 1,
    onChange: (v) => {
      standSetups[k].reduction = v / 100;
      syncStandDials();
      recommandStand(k, v / 100);
    },
  }));
  const loads = mk((k) => numField({
    value: (standSetups[k].targetForce * view.stripWidth) / TONF,
    min: 1, max: 20000, step: 10, digits: 0,
    onChange: (v) => {
      standSetups[k].targetForce = (v * TONF) / Math.max(view.stripWidth, 1e-6);
      syncStandDials();
      mill.stands[k]?.resetAgc();
    },
  }));
  const gauges = mk((k) => numField({
    value: standSetups[k].targetGauge * 1000,
    min: 0.01, max: 60, step: 0.01, digits: 4,
    onChange: (v) => {
      standSetups[k].targetGauge = v / 1000;
      const st = mill.stands[k];
      if (st) {
        st.params.agcTargetGauge = standSetups[k].targetGauge;
        // Same feed-forward as a reduction change: the spring the loop has
        // already measured is still very nearly right at the new setpoint.
        if (st.params.agcMode === 'gauge') { st.retarget(); clearAgcTrail(k); }
      }
      syncStandDials();
    },
  }));
  const tens = mk((k) => numField({
    value: standSetups[k].frontTension / 1e6, min: 0, max: 250, step: 5, digits: 0,
    onChange: (v) => { standSetups[k].frontTension = v * 1e6; syncStandDials(); },
  }));
  const rads = mk((k) => numField({
    value: standSetups[k].R * 1000, min: 20, max: 400, step: 5, digits: 0,
    onChange: (v) => {
      standSetups[k].R = v / 1000;
      syncStandDials();
      scheduleStandRebuild(k);
    },
  }));
  const backs = mk((k) => {
    const f = numField({
      value: getBackTension(k) / 1e6, min: 0, max: 250, step: 5, digits: 0,
      onChange: (v) => { setBackTension(k, v * 1e6); syncStandDials(); refreshStandGrid(); },
    });
    // Editable either way, but on a tandem line it is the stand in front being
    // edited, so say so rather than letting the two rows look independent.
    (f.root as HTMLInputElement).title = backIsMirrored(k)
      ? `${standTag(k - 1)} の前方張力と同じ量。どちらを編集しても同じ数字が動く`
      : view.lineMode === 'reverse'
        ? `${standTag(k)} の入側コイラ張力。パスごとに独立`
        : 'ライン入側の張力';
    return f;
  });
  // Five decimals, and a range that reaches both ends of the back-calculation's
  // bracket. Three was enough while this was only ever typed in; it is not
  // enough for a number that comes out of `μ逆算`, because the load the answer
  // reproduces is only worth as much as the digits it is quoted to - at
  // d ln P / d ln mu ~ 0.15 a mu rounded to 0.001 is a load moved by 0.2 %,
  // which is more than the whole residual of the solve.
  const mus = mk((k) => numField({
    value: standSetups[k].mu, min: MU_MIN, max: MU_MAX, step: 0.005, digits: 5,
    onChange: (v) => {
      standSetups[k].mu = v;
      // Typing over a back-calculated mu takes that stand out of the mode. The
      // red is a claim about where the number came from, and it no longer came
      // from there.
      muInv.delete(k);
      syncStandDials();
      paintMuInverse();
    },
  }));
  const modes = mk((k) => {
    const sel = el('select', 'sg-select') as HTMLSelectElement;
    for (const [val, txt] of [
      ['off', 'なし'], ['ratio', '圧下率一定'], ['gauge', '出側板厚一定'], ['force', '荷重一定'],
    ]) {
      const o = el('option');
      o.value = val; o.textContent = txt;
      sel.append(o);
    }
    sel.value = standSetups[k].agcMode;
    sel.addEventListener('change', () => {
      const v = sel.value as AgcMode;
      standSetups[k].agcMode = v;
      const st = mill.stands[k];
      // Switching off parks the screws back on the commanded reduction, so the
      // change is a clean A/B: the gauge deficit reappears immediately.
      if (st) {
        // Entering absolute-gauge control adopts the gauge the stand is
        // actually making. Anything else is a step change nobody asked for -
        // the operator picked a mode, not a setpoint.
        if (v === 'gauge') {
          const now = st.diag.exitThickness;
          standSetups[k].targetGauge = now > 0 ? now : st.h1Command;
          st.params.agcTargetGauge = standSetups[k].targetGauge;
        }
        st.params.agcMode = v;
        if (v === 'off') st.releaseGap(); else st.resetAgc();
      }
      clearAgcTrail(k);
      refreshAgcChart();
      syncStandDials();
    });
    return sel;
  });
  const redNow = mk(() => el('div', 'sg-now', '—'));
  const gaugeNow = mk(() => el('div', 'sg-now', '—'));
  const loadNow = mk(() => el('div', 'sg-now', '—'));
  const resets = mk((k) => {
    const b = el('button', 'sg-btn', RECALC_LABEL);
    b.type = 'button';
    b.title = `${standTag(k)} をメッシュから作り直して解き直す（他の${unitWord()}はそのまま）`;
    b.addEventListener('click', () => {
      // Rebuild, not just reset the state. Throwing away the velocity field
      // alone lands on the answer the stand already had whenever it was
      // converged, so the press leaves no trace and reads as a dead button.
      // A rebuild also re-lays the meshes and re-fits the analysis window to
      // the parameters as they stand now, which is what the label promises.
      scheduleStandRebuild(k);
      mill.resetStand(k);
      markRecomputing(b);
      clearAgcTrail(k);
      if (k === view.stand) { tracers.reset(); fieldDirty = true; }
    });
    return b;
  });

  row('制御モード', modes, '');
  row('圧下率 目標', reds.map((x) => x.root), '%');
  row('　　　現在', redNow, '%');
  row('出側板厚 目標', gauges.map((x) => x.root), 'mm');
  row('　　　現在', gaugeNow, 'mm');
  row('圧延荷重 目標', loads.map((x) => x.root), 'tonf');
  row('　　　現在', loadNow, 'tonf');
  row('後方張力 σb', backs.map((x) => x.root), 'MPa');
  row('前方張力 σf', tens.map((x) => x.root), 'MPa');
  row('摩擦係数 μ', mus.map((x) => x.root), '');
  row('ロール半径 R', rads.map((x) => x.root), 'mm');
  row('', resets, '');

  for (let k = 0; k < n; k++) {
    standCells.push({
      head: heads[k], redNow: redNow[k], gaugeNow: gaugeNow[k], loadNow: loadNow[k],
      mode: modes[k],
      red: reds[k], gauge: gauges[k], load: loads[k], backT: backs[k], ten: tens[k],
      mu: mus[k], rad: rads[k],
    });
  }
  // The table has just been rebuilt from scratch, so every red cell went with
  // it - and any stand the rebuild dropped has no cell to come back to.
  for (const k of [...muInv.keys()]) if (k >= n) muInv.delete(k);
  paintMuInverse();
  paintStandGridSelection();
}

function paintStandGridSelection(): void {
  standCells.forEach((c, k) => {
    c.head.className = k === view.stand ? 'sg-head sel' : 'sg-head';
  });
  const head = standCells[view.stand]?.head;
  if (!colSel || !head) return;
  // Read off the heading cell rather than recomputing the track: the columns
  // are `minmax(0, 1fr)` and the table is what actually knows how wide they
  // came out. Padded by the grid's own column gap so the band reads as one
  // column rather than as a box drawn round the numbers.
  colSel.style.left = `${head.offsetLeft - 4}px`;
  colSel.style.width = `${head.offsetWidth + 8}px`;
  colSel.style.height = `${standGrid.scrollHeight - 6}px`;
}

const RECALC_LABEL = '\u21bb 再計算';

/**
 * Say that the press landed.
 *
 * A converged stand re-converges to the number it already had, so the only
 * evidence of a rebuild is a dip lasting a second or two - easy to miss, and
 * indistinguishable from a button that does nothing. The caption holds for as
 * long as the rebuild's own debounce plus the settling that follows it.
 */
const recalcTimers = new WeakMap<HTMLElement, number>();
function markRecomputing(b: HTMLElement): void {
  b.classList.add('busy');
  b.textContent = '再計算中…';
  clearTimeout(recalcTimers.get(b));
  recalcTimers.set(b, window.setTimeout(() => {
    b.classList.remove('busy');
    b.textContent = RECALC_LABEL;
  }, 1600));
}

/** Live cells, and any dial the left panel changed for this stand. */
function refreshStandGrid(): void {
  const b = view.stripWidth;
  for (let k = 0; k < standCells.length; k++) {
    const c = standCells[k];
    const st = mill.stands[k];
    if (!st) continue;
    const d = st.diag;
    const hIn = st.params.h0;
    const r = hIn > 0 ? 100 * (1 - d.exitThickness / hIn) : 0;
    const load = (d.rollForce * b) / TONF;
    const want = standSetups[k].reduction * 100;
    c.redNow.textContent = Number.isFinite(r) ? r.toFixed(2) : '—';
    // Under absolute-gauge or load control the reduction is an outcome, not a
    // target, so it is reported without a verdict.
    const rHeld = st.params.agcMode === 'off' || st.params.agcMode === 'ratio';
    c.redNow.className = 'sg-now ' + (!rHeld ? ''
      : Math.abs(r - want) < 0.05 ? 'ok'
        : Math.abs(r - want) < 0.5 ? 'warn' : 'bad');
    c.loadNow.textContent = Number.isFinite(load) ? load.toFixed(1) : '—';
    const tgt = (standSetups[k].targetForce * b) / TONF;
    c.loadNow.className = 'sg-now ' + (st.params.agcMode !== 'force' ? ''
      : Math.abs(load - tgt) / Math.max(tgt, 1e-9) < 1e-3 ? 'ok'
        : Math.abs(load - tgt) / Math.max(tgt, 1e-9) < 1e-2 ? 'warn' : 'bad');
    // Only the mode actually holding this quantity gets a verdict on it. On a
    // stand under load control the gauge lands where it lands, and colouring
    // it as an error says the loop is failing at a job it was never given.
    const h1 = d.exitThickness * 1000;
    const hTgt = standSetups[k].targetGauge * 1000;
    c.gaugeNow.textContent = h1 > 0 ? h1.toFixed(4) : '—';
    c.gaugeNow.className = 'sg-now ' + (st.params.agcMode !== 'gauge' ? ''
      : Math.abs(h1 - hTgt) / Math.max(hTgt, 1e-9) < 1e-3 ? 'ok'
        : Math.abs(h1 - hTgt) / Math.max(hTgt, 1e-9) < 1e-2 ? 'warn' : 'bad');
    c.red.set(standSetups[k].reduction * 100);
    c.gauge.set(standSetups[k].targetGauge * 1000);
    c.load.set((standSetups[k].targetForce * b) / TONF);
    c.backT.set(getBackTension(k) / 1e6);
    c.ten.set(standSetups[k].frontTension / 1e6);
    c.mu.set(standSetups[k].mu);
    c.rad.set(standSetups[k].R * 1000);
    if (document.activeElement !== c.mode) c.mode.value = standSetups[k].agcMode;
  }
  paintMuInverse();
}

const sLine = section('ライン構成');
const sMode = select<LineMode>('ライン形式', [
  { value: 'tandem', text: 'タンデム — 同時に噛む複数スタンド' },
  { value: 'reverse', text: 'リバース — 1 スタンドを往復、1 行 = 1 パス' },
], view.lineMode, (v) => setLineMode(v));
const sCount = select<string>('スタンド数', Array.from({ length: MAX_STANDS },
  (_, i) => ({ value: String(i + 1), text: `${i + 1} スタンド` })), String(standCount), (v) => {
  standCount = Number(v);
  if (view.stand >= standCount) view.stand = standCount - 1;
  scheduleRebuild();
});
const lineHint = el('div', 'ctrl-hint');
const modeHint = el('div', 'ctrl-hint');
// One place per quantity. Everything a stand owns is a cell in the table at
// the top, next to what that stand is actually doing; the left panel is only
// what the whole line shares. A second copy of a dial down here would be a
// second thing to keep in step, and the pair would disagree the moment one of
// them was edited while another stand was selected.
// The line's entry tension is the back tension of the first row, and that is a
// cell in the table at the top. One number, one place to set it.
const tAutoSpeed = toggle('速度コーン自動 (質量流量一定)', mill.autoSpeed, (v) => {
  mill.autoSpeed = v;
});
const speedHint = el('div', 'ctrl-hint');

/**
 * Re-word the panels for the machine now selected.
 *
 * A reverse mill has passes where a tandem line has stands, and two of the
 * three couplings are gone. Both facts are things the operator reads off the
 * labels, so the labels are part of the mode rather than decoration on it.
 */
function applyModeWording(): void {
  const rev = view.lineMode === 'reverse';
  const w = unitWord();
  const countLabel = sCount.root.querySelector('.ctrl-label');
  if (countLabel) countLabel.textContent = `${w}数`;
  sCount.root.querySelectorAll('option').forEach((o, i) => {
    o.textContent = `${i + 1} ${w}`;
  });
  const geoTitle = sGeo.root.querySelector('.panel-head-title');
  if (geoTitle) geoTitle.textContent = `選択中${w}の幾何`;

  modeHint.textContent = rev
    ? '1 スタンドの間を板が往復する可逆圧延機。表の 1 行が 1 パスで、パス k の入側板厚は'
      + ' パス k−1 の出側 — 引き継ぐのは板厚だけ。パスは時間的に別々に起きるので'
      + '質量流量（速度コーン）は結びつかず、張力も両端のコイラで毎パス張り直すため、'
      + '後方張力・前方張力ともパスごとに独立した入力になる。'
    : '複数スタンドが同時に同じ板を噛むタンデム圧延機。板厚・質量流量・張力の 3 つが'
      + 'スタンド間で結合する。あるスタンドの前方張力は次のスタンドの後方張力そのもので、'
      + '表のどちらを編集しても同じ数字が動く。';
  lineHint.textContent =
    `${w}ごとの設定（制御モード・圧下率・目標圧延荷重・張力・摩擦係数・ロール半径）は`
    + `画面上部の${w}表で編集する。左上パネルはライン共通の板寸法と材料 —`
    + ' 入側板厚・板幅・変形抵抗。左パネルはそれ以外のライン共通設定 —'
    + ' 圧延条件・メッシュ・数値解法・制御ゲイン。'
    + `詳細表示する${w}は、ミルライン図か表の見出しをクリックして選ぶ。`;
  speedHint.textContent = rev
    ? 'リバースでは無効。パスは同時に走らないので保つべき速度コーンがなく、'
      + '各パスは「圧延条件」のロール周速でそのまま回る。'
    : 'ON のとき、下流スタンドのロール速度を質量流量 Q = v·h が一定になるように自動設定する。'
      + '各スタンドは自分の送り速度を自走で決めるので、残った不整合は「流量ずれ」として表示する'
      + '（実機ではスタンド間張力が吸収する分）。';
  procHint.textContent =
    `摩擦係数 μ・後方張力 σb・前方張力 σf は${w}ごとの量なので、上部の${w}表で編集する。`
    + '噛み込み条件 μ ≥ tan α を下回ると圧延できない。'
    + (rev
      ? '各パスは入出側のコイラで独立に張られるので、σb と σf は 1 行ずつ別々の入力。'
      : '張力は 1 本の量に 2 つの名前が付いたもので、#1 の後方張力がライン入側の張力、'
        + '各スタンドの前方張力が次のスタンドの後方張力になる。')
    + ' μ が分からないときは、実測荷重を「圧延荷重 目標」に入れて画面上部の「μ逆算」を押す —'
    + 'スラブ法をその荷重から逆に解いた μ が赤で入る。';
  tAutoSpeed.setEnabled(!rev);
}

/**
 * Switch machine.
 *
 * No rebuild: the couplings are applied in `Mill.sync`/`advance` every frame,
 * so the chain simply starts obeying a different set of them. The one thing
 * that has to move is the entry pull of every element past the first - it stops
 * being the stand in front pulling and becomes a dial of its own, so it is
 * seeded with the value the chain was already implying and the solve does not
 * step.
 */
function setLineMode(v: LineMode): void {
  view.lineMode = v;
  mill.mode = v;
  if (v === 'reverse') {
    for (let k = 1; k < standSetups.length; k++) {
      standSetups[k].backTension = standSetups[k - 1].frontTension;
    }
  }
  applyModeWording();
  buildStandGrid();
  refreshStandGrid();
  millLine.draw(millViews());
}
// Roll radius and reduction are cells in the table at the top, per stand.
// This section is what those two imply for the stand on screen.
const sGeo = section('選択中スタンドの幾何');
const sH0 = slider({
  label: 'ライン入側板厚 h₀', unit: 'mm', min: 0.00005, max: 0.05, log: true, value: params.h0,
  format: (v) => (v * 1000).toFixed(v < 0.001 ? 3 : 2),
  hint: '2 行目以降の入側板厚は前段の出側そのもの — 入力ではなく結果（ミルライン図に出る）',
  onInput: (v) => { params.h0 = v; mill.h0 = v; scheduleRebuild(); },
});
const geoHint = el('div', 'ctrl-hint');
const sWidth = slider({
  label: '板幅 b (ライン共通)', unit: 'mm', min: 0.05, max: 3.0, step: 0.01,
  value: view.stripWidth,
  format: (v) => (v * 1000).toFixed(0),
  hint: '平面ひずみなので幅方向 z は離散化していない (ε_zz = 0)。単位幅の結果を実寸に'
    + '換算するだけで解には効かず、効くのは総荷重 (tonf) 指令の換算だけ。'
    + '板厚方向も対称面 y = 0 で半分だけ解いてミラー表示',
  onInput: (v) => {
    // The targets are dialled as a total load, so holding the tonf figure means
    // the per-unit-width value each stand actually controls has to move with
    // the width - and for every stand, not just the one on screen.
    const k = view.stripWidth / Math.max(v, 1e-6);
    view.stripWidth = v;
    for (const st of standSetups) st.targetForce *= k;
    syncStandDials();
    syncMillModulus();
    refreshStandGrid();
  },
});
sGeo.body.append(geoHint);

// The strip itself: one gauge, one width, one material for the whole line, no
// matter how many stands it runs through. They live in the top-left panel,
// away from the per-stand dials, because there is nothing to select for them.
const sStrip = section('ライン共通 — 板寸法', {
  hint: '板そのものを決める量。ラインに 1 枚しか通っていないので、スタンドを選ぶ余地がない — '
    + 'だからスタンド追随の左パネルではなく、ミルライン図の隣に置いてある。',
});
sStrip.body.append(sH0.root, sWidth.root);

sLine.body.append(sMode.root, modeHint, sCount.root, lineHint,
  tAutoSpeed.root, speedHint);

const sMat = section('被圧延材 (LMN 式)', {
  hint: '変形抵抗 kf = L·(ε̄ + M)^N。L は係数 [MPa]、M は予ひずみ（ε̄ = 0 で kf を有限にする）、'
    + 'N は硬化指数。冷延材の実測 kf 曲線がこの 3 つで与えられることが多い。'
    + 'LMN が返すのは平面ひずみ変形抵抗で、解析が持つ単軸相当応力は σf = (√3/2)·kf。',
});
const sY0 = slider({
  label: '係数 L', unit: 'MPa', min: 50e6, max: 4000e6, log: true, value: params.lmnL,
  format: (v) => (v / 1e6).toFixed(0),
  onInput: (v) => { params.lmnL = v; },
});
const sK = slider({
  label: '予ひずみ M', min: 0.0002, max: 0.5, log: true, value: params.lmnM,
  format: (v) => v.toFixed(4),
  hint: 'ε = 0 でも kf を有限にするオフセット。kf(0) = L·M^N',
  onInput: (v) => { params.lmnM = v; },
});
const sN = slider({
  label: '硬化指数 N', min: 0.01, max: 0.6, step: 0.005, value: params.lmnN,
  format: (v) => v.toFixed(2),
  hint: '平面ひずみ変形抵抗 kf = L·(ε̄ + M)^N ／ 解析が持つ単軸変形抵抗は σf = kf·√3/2',
  onInput: (v) => { params.lmnN = v; },
});
const tElastic = toggle('入出側の弾性変形を考慮', params.elasticZones, (v) => {
  params.elasticZones = v; sEstrip.setEnabled(v); sNuStrip.setEnabled(v);
},
  '剛塑性のままだと入出側は完全剛体になる。ONにすると粘度の上限を弾性応答 G·t（t = ビット通過時間）'
  + '、体積項を真の体積弾性率 K·t に置き換え、入側の弾性圧縮域と出側スプリングバックが現れる。');
const sEstrip = slider({
  label: '板 縦弾性係数 E', unit: 'GPa', min: 30e9, max: 400e9, step: 5e9, value: params.Estrip,
  format: (v) => (v / 1e9).toFixed(0),
  onInput: (v) => { params.Estrip = v; },
});
const sNuStrip = slider({
  label: '板 ポアソン比 ν', min: 0.20, max: 0.45, step: 0.005, value: params.nuStrip,
  format: (v) => v.toFixed(3),
  hint: "平面ひずみ縦弾性 E' = E/(1−ν²)。スプリングバックひずみ ≈ kf/E'",
  onInput: (v) => { params.nuStrip = v; },
});
const lmnHint = el('div', 'ctrl-hint');
sMat.body.append(sY0.root, sK.root, sN.root, lmnHint, tElastic.root,
  sEstrip.root, sNuStrip.root);

/* ── deformation heating ─────────────────────────────────────────────────── */

const HEAT_ABOUT =
  'ビット通過は 1 ms 程度で、その間に熱が拡散する距離は 0.1 mm ほど。'
  + 'だから板は自分で出した熱をそのまま持ったまま出ていく（断熱）とみなし、'
  + '塑性仕事 β·σf·ε̄̇ を熱源として、ひずみと同じ流線に沿って温度を運ぶ。'
  + 'ロールへの抜熱は入れていないので、これは温度上昇の上限側の見積り。';
const sHeat = section('加工発熱 (断熱)', { hint: HEAT_ABOUT });
const heatDials: { setEnabled(on: boolean): void }[] = [];
const tHeat = toggle('加工発熱で変形抵抗を変える', params.heatOn, (v) => {
  params.heatOn = v;
  for (const dial of heatDials) dial.setEnabled(v);
  // No reset. The temperature field is swept from the entry column every
  // frame, so with the model off it is already the entry temperature
  // everywhere and there is nothing stale to throw away - and throwing away a
  // converged velocity field to change a material law would cost seconds to
  // rediscover the answer the solve is a few frames from anyway. The gap
  // loop's trail does go: the operating point it was drawn against moves.
  clearAgcTrail();
  fieldDirty = true;
});
const sTempIn = slider({
  label: '入側温度 T₀', unit: '°C', min: 0, max: 1300, step: 5, value: params.tempEntry,
  format: (v) => v.toFixed(0),
  hint: '軟化の基準点でもある。ここでの軟化率は定義上 0 で、'
    + 'このパスが自分で出した熱の分だけが変形抵抗に効く',
  onInput: (v) => { params.tempEntry = v; fieldDirty = true; },
});
const sBeta = slider({
  label: 'テイラー・クイニー係数 β', min: 0, max: 1.0, step: 0.01,
  value: params.taylorQuinney,
  format: (v) => v.toFixed(2),
  hint: '塑性仕事のうち熱になる割合。残りは転位として組織に貯まる。金属の実測は 0.85〜0.95 だが、'
    + '0 まで下げれば発熱なし（等温）、1 で全量が熱という極端側も試せる',
  onInput: (v) => { params.taylorQuinney = v; },
});
const sRho = slider({
  label: '密度 ρ', unit: 'kg/m³', min: 2000, max: 12000, step: 50, value: params.rhoStrip,
  format: (v) => v.toFixed(0),
  onInput: (v) => { params.rhoStrip = v; },
});
const sCp = slider({
  label: '比熱 c', unit: 'J/(kg·K)', min: 100, max: 1200, step: 5, value: params.cpStrip,
  format: (v) => v.toFixed(0),
  hint: '温度上昇は ΔT = β·σf·ε̄ / (ρc)。ρc が熱容量そのもの',
  onInput: (v) => { params.cpStrip = v; },
});
const sTmelt = slider({
  label: '融点 T_m', unit: '°C', min: 300, max: 2000, step: 10, value: params.tempMelt,
  format: (v) => v.toFixed(0),
  onInput: (v) => { params.tempMelt = v; },
});
const sSoften = slider({
  label: '軟化指数 m', min: 0.2, max: 3.0, step: 0.05, value: params.softenExp,
  format: (v) => v.toFixed(2),
  hint: 'Johnson-Cook 熱項 kf ∝ 1 − T*^m ／ T* = (T − T₀)/(T_m − T₀)。'
    + 'm が小さいほど低い温度上昇でも軟化が立ち上がる',
  onInput: (v) => { params.softenExp = v; },
});
heatDials.push(sTempIn, sBeta, sRho, sCp, sTmelt, sSoften);
sHeat.body.append(tHeat.root, sTempIn.root, sBeta.root, sRho.root,
  sCp.root, sTmelt.root, sSoften.root);
const heatOutHint = el('div', 'ctrl-hint');
sHeat.body.append(heatOutHint);
for (const dial of heatDials) dial.setEnabled(params.heatOn);

const sProc = section('圧延条件');
const sOmega = slider({
  label: 'ロール周速 v_R', unit: 'mpm', min: 1, max: 1500, log: true,
  value: view.rollSpeedMpm,
  format: (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1)),
  onInput: (v) => { view.rollSpeedMpm = v; syncRollSpeed(); },
});
const omegaHint = el('div', 'ctrl-hint');

/**
 * The dial is a line speed in m/min, the way a mill is actually run; the solver
 * turns the barrel at an angular speed. Roll radius is the only thing between
 * them, so changing R holds the line speed and moves omega, not the reverse.
 */
function syncRollSpeed(): void {
  params.omega = omegaFromMpm();
  omegaHint.textContent =
    `ロール半径 R = ${(params.R * 1000).toFixed(params.R < 0.05 ? 1 : 0)} mm で`
    + ` 角速度 ω = ${params.omega.toFixed(3)} rad/s`
    + `（周速 ${(params.omega * params.R).toFixed(4)} m/s）。`
    + 'R を変えても周速が保たれるように ω が追随する。';
}
syncRollSpeed();
// Friction and the two tensions are per stand and sit in the table at the top,
// where a schedule is read across the line. What is left here is the one speed
// the line is run at.
const procHint = el('div', 'ctrl-hint');
const tFeedAuto = toggle('送り速度を自動 (自走)', true, (v) => {
  params.feedSpeed = v ? 0 : sFeed.get();
  sFeed.setEnabled(!v);
});
const sFeed = slider({
  label: '送り速度 v_in', unit: 'm/s', min: 0.001, max: 3, log: true,
  value: params.omega * params.R * (1 - params.reduction),
  format: (v) => v.toFixed(4),
  onInput: (v) => { params.feedSpeed = v; },
});
sFeed.setEnabled(false);
sProc.body.append(sOmega.root, omegaHint, procHint, tFeedAuto.root, sFeed.root);
// Every hint it writes has to exist first, and `procHint` is the last of them.
applyModeWording();

const AGC_HINT: Record<AgcMode, string> = {
  off:
    'ロールギャップは指令圧下率 h₀(1−r) に固定。荷重でロールが扁平し板が弾性回復する分だけ '
    + '出側は必ず厚くなるので、実圧下率は指令値を下回る（ミルスプリング）。',
  ratio:
    '出側板厚の実測値が h₀(1−r) になるまでスクリューを反復で締め込む。ミルスプリングは'
    + '消せないので、あらかじめ余分に締めて相殺する — 実機 AGC と同じ理屈。'
    + '収束すると「圧下達成率」が 1.000 になる。'
    + '保持するのは比であって板厚ではない: 目標が自分の入側板厚に紐づいているので、'
    + 'タンデムでは上流の変動がそのまま下流へ伝わる。',
  gauge:
    '出側板厚の実測値が指定した絶対値になるまでスクリューを調整する。目標が入側板厚に'
    + '依存しないので、上流から来た板厚変動をこのスタンドが吸収して切る — '
    + 'コイルは圧下率ではなく板厚で売るので、実機では最終スタンドがこれをやる。'
    + 'モードに入った時点の実測板厚を目標として引き継ぐ。',
  force:
    '圧延荷重が目標値になるまでスクリューを反復調整する（定圧延荷重制御）。'
    + '圧下率は結果として決まるので、圧下率の指令はメッシュ生成時の解析窓サイズにだけ効く。'
    + 'このモードで圧下率 目標を書き換えてもスクリューは動かない — 収束済みの荷重解を'
    + '捨てずに済むよう、次のメッシュ再構築まで反映を持ち越す。',
};

const sAgc = section('自動制御 (AGC / 定圧延荷重)');
const agcHint = el('div', 'ctrl-hint');
agcHint.textContent = AGC_HINT[params.agcMode];
// The mode itself is chosen per stand, in the table at the top of the app.
// Repeating the control here would be a second place to set one thing.
// The target itself is a cell in the table at the top, per stand. This section
// is the loop that chases it, which is shared by the line.
const agcTargetHint = el('div', 'ctrl-hint');

/**
 * The dial is a total load in tonf, the way a stand is actually operated; the
 * solver is plane strain and controls force per unit width. Strip width is the
 * only thing between the two, so the conversion is redone whenever either moves.
 */
function syncAgcTarget(): void {
  params.agcTargetForce = agcTargetPerWidth();
  agcTargetHint.textContent =
    `選択中 ${standTag(view.stand)} の目標 ${view.agcTargetTonf.toFixed(
      view.agcTargetTonf < 100 ? 1 : 0)} tonf は、`
    + `板幅 ${(view.stripWidth * 1000).toFixed(0)} mm で`
    + ` ${(params.agcTargetForce / 1e6).toFixed(3)} kN/mm（単位幅あたり）。`
    + '目標値は上部のスタンド表で編集する。板幅を変えても総荷重 tonf は保たれ、'
    + '単位幅あたりの目標のほうが動く。';
}
syncAgcTarget();
const sAgcGain = slider({
  label: 'ループゲイン', min: 0.05, max: 1.5, step: 0.05, value: params.agcGain,
  format: (v) => v.toFixed(2),
  hint: '同定した感度 d(測定値)/d(ギャップ) の逆数を掛けたニュートンステップの減衰。'
    + '1 で全ステップ。上げると速いが振動しやすい。'
    + '割線法・固定ゲインにのみ効く（区間法は区間の幅が歩幅を決めるので使わない）',
  onInput: (v) => { params.agcGain = v; },
});
const sAgcDb = slider({
  label: '不感帯', unit: '%', min: 1e-5, max: 1e-2, log: true, value: params.agcDeadband,
  format: (v) => (v * 100).toFixed(3),
  hint: '偏差がこれを下回ったら停止。板厚制御では h₀ 比、荷重制御では P* 比',
  onInput: (v) => { params.agcDeadband = v; },
});
const sAgcEvery = slider({
  label: 'スクリュー更新間隔', unit: 'frame', min: 1, max: 30, step: 1, value: params.agcEvery,
  format: (v) => v.toFixed(0),
  hint: 'ロール扁平ループが緩和する時間を与えるため、毎フレームは動かさない',
  onInput: (v) => { params.agcEvery = Math.round(v); },
});
const sFloor = slider({
  label: 'スクリュー下限 バレル間隔', unit: '% of h₀', min: 5, max: 50, step: 1,
  value: params.sepFloorFrac * 100,
  format: (v) => v.toFixed(0),
  onInput: (v) => { params.sepFloorFrac = v / 100; syncFloorHint(); },
});
const floorHint = el('div', 'ctrl-hint');

/**
 * The floor is a validity limit, not a numerical one, so the hint has to carry
 * the number that actually degrades - otherwise lowering it looks free.
 */
function syncFloorHint(): void {
  const f = params.sepFloorFrac;
  floorHint.textContent = f > 0.295
    ? `既定 30%（＝圧下率 70%）。ここが「圧下達成率が伸びない」ときに張り付く下端。`
      + 'これ以上締めても質量収支が崩れて数字が信用できなくなるので止めてある。'
    : `⚠ 既定の 30% を下回っている（圧下率 ${((1 - f) * 100).toFixed(0)}% 相当）。`
      + 'この領域は数値的には解けるが体積が保存しない — 実測で圧下率 70% なら質量収支 0.988、'
      + '80% で 0.925、90% で 0.683。荷重も圧下率も出るが答えではない。';
}
syncFloorHint();

/**
 * Which root-finder the gap loop uses.
 *
 * Line-wide, like the other loop settings: the point of the control is to
 * compare methods on the same schedule, and a per-stand choice would mean
 * every comparison also had a second variable in it.
 */
const methodHint = el('div', 'ctrl-hint');
function syncMethodHint(): void {
  const m = AGC_METHODS.find((x) => x.value === params.agcMethod);
  methodHint.textContent = m ? m.note : '';
}
const sAgcMethod = select<AgcMethod>('探索方式',
  AGC_METHODS.map((m) => ({ value: m.value, text: m.label })),
  params.agcMethod, (v) => {
    params.agcMethod = v;
    syncMethodHint();
    // Each method carries its own bracket and history. Switching without
    // clearing them would have the new one reading the old one's notes.
    for (const st of mill.stands) st.resetAgc();
    clearAgcTrail();
  },
  '3 つの制御モードすべてに効く。ギャップに対して測定値が単調なので、'
  + '古典的な求根法がそのまま使える。評価 1 回がスクリュー 1 手＋内側ループの'
  + '整定（数秒）なので、優劣は「反復回数」ではなく「評価回数」で決まる。');

const sAgcStep = slider({
  label: '1 回の最大移動量', unit: '% of h₀', min: 0.001, max: 0.10, log: true,
  value: params.agcMaxStep,
  format: (v) => (v * 100).toFixed(2),
  hint: '割線法・固定ゲインでは 1 手の上限。区間法では「区間を挟むまでの初手の幅」'
    + 'として使われ、挟んだあとは効かない',
  onInput: (v) => { params.agcMaxStep = v; },
});
const agcResetHint = el('div', 'ctrl-hint');
agcResetHint.textContent =
  'スクリューを h₀(1−r) に戻し、同定したゲインを忘れる。OFF ではそこで止まり、'
  + '制御中なら今の条件で最初から締め直す。';
sAgc.body.append(agcHint, agcTargetHint,
  buttonRow([{
    text: '↺ スクリュー位置をリセット',
    title: 'ギャップを指令値に戻してループを再スタート',
    onClick: () => sim.releaseGap(),
  }]),
  agcResetHint, sAgcMethod.root, methodHint,
  sAgcGain.root, sAgcDb.root, sAgcEvery.root, sAgcStep.root,
  sFloor.root, floorHint);
syncMethodHint();

const sRoll = section('ミル弾性 (ロール扁平・ミルスプリング)');
const sMillK = slider({
  label: 'ミル剛性 M', unit: 'MN/mm', min: 0.2, max: 30, log: true,
  value: view.millModulusMNmm,
  format: (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1)),
  onInput: (v) => { view.millModulusMNmm = v; syncMillModulus(); },
});
const millHint = el('div', 'ctrl-hint');

/**
 * The dial is a total stand stiffness in MN/mm, the way a mill is specified;
 * the solver is plane strain and wants it per unit width. Strip width is the
 * only thing between them, so the conversion is redone whenever either moves.
 */
function syncMillModulus(): void {
  params.millModulus = millModulusPerWidth();
  millHint.textContent = params.millSpringOn
    ? `バレルは荷重で P/M だけ離れる。板幅 ${(view.stripWidth * 1000).toFixed(0)} mm 換算で`
      + ` ${(params.millModulus / 1e9).toFixed(3)} GPa（単位幅あたり）。`
      + '実測の伸びは右パネル「うち ハウジング伸び」。'
    : 'OFF ではスタンドは剛体。バネはロール扁平と出側弾性回復だけで、'
      + '実機なら mm オーダーのミルスプリングが数十 µm しか出ない。';
}

sRoll.body.append(
  toggle('ロール弾性連成 (扁平)', params.rollCoupling, (v) => { params.rollCoupling = v; }).root,
  slider({
    label: 'ロール縦弾性係数 E', unit: 'GPa', min: 50e9, max: 600e9, step: 5e9, value: params.Eroll,
    format: (v) => (v / 1e9).toFixed(0),
    onInput: (v) => { params.Eroll = v; sim.refreshMaterial(); },
  }).root,
  slider({
    label: '芯金半径比', min: 0.2, max: 0.8, step: 0.01, value: params.hubRatio,
    format: (v) => v.toFixed(2),
    onInput: (v) => { params.hubRatio = v; scheduleRebuild(); },
  }).root,
  slider({
    label: '連成の緩和係数', min: 0.02, max: 0.6, step: 0.01, value: params.rollRelax,
    format: (v) => v.toFixed(2),
    hint: '扁平ループは「荷重↑→ギャップ開く→圧下↓→荷重↓」の正帰還を持つ。大きすぎるとハンチングする',
    onInput: (v) => { params.rollRelax = v; },
  }).root,
  slider({
    label: 'ロール変形 表示倍率', unit: '×', min: 1, max: 2000, log: true, value: view.rollMagnify,
    format: (v) => v.toFixed(0),
    hint: '弾性変形は µm オーダー。誇張しないと見えない',
    onInput: (v) => { view.rollMagnify = v; },
  }).root,
  toggle('ミルスプリング (ハウジング・圧下ねじの伸び)', params.millSpringOn, (v) => {
    params.millSpringOn = v;
    sMillK.setEnabled(v);
    syncMillModulus();
    clearAgcTrail();
  }).root,
  sMillK.root,
  millHint,
);
sMillK.setEnabled(params.millSpringOn);
syncMillModulus();

const sNum = section('数値解析', { open: false });
const meshSel = select<MeshLevel>('メッシュ品質 (プリセット)',
  (Object.keys(MESH_LEVELS) as MeshLevel[]).map((k) => ({ value: k, text: MESH_LEVELS[k].label })),
  view.meshLevel, (v) => {
    view.meshLevel = v;
    const L = MESH_LEVELS[v];
    params.stripNx = L.nx; params.stripNy = L.ny;
    params.rollNt = L.nt; params.rollNr = L.nr;
    sNx.set(L.nx); sNy.set(L.ny); sNt.set(L.nt); sNr.set(L.nr);
    scheduleRebuild();
  });
const meshHint = el('div', 'ctrl-hint');
const sNx = slider({
  label: '板 圧延方向 分割 nx', min: 40, max: 800, step: 10, value: params.stripNx,
  format: (v) => v.toFixed(0),
  onInput: (v) => { params.stripNx = Math.round(v); scheduleRebuild(); },
});
const sNy = slider({
  label: '板 板厚方向 分割 ny', min: 3, max: 48, step: 1, value: params.stripNy,
  format: (v) => v.toFixed(0),
  hint: '帯行列の半帯幅は 2(ny+2)+1。分解コストは ny² で効くのでここが一番重い',
  onInput: (v) => { params.stripNy = Math.round(v); scheduleRebuild(); },
});
const sNt = slider({
  label: 'ロール 周方向 分割 nt', min: 80, max: 1400, step: 20, value: params.rollNt,
  format: (v) => v.toFixed(0),
  onInput: (v) => { params.rollNt = Math.round(v); scheduleRebuild(); },
});
const sNr = slider({
  label: 'ロール 半径方向 分割 nr', min: 3, max: 20, step: 1, value: params.rollNr,
  format: (v) => v.toFixed(0),
  hint: 'ロール剛性行列は定数なので分解は起動時 1 回だけ。細かくしても毎フレーム費用は増えない',
  onInput: (v) => { params.rollNr = Math.round(v); scheduleRebuild(); },
});
const sSkinRings = slider({
  label: 'ロール表層 分割数', min: 0, max: 12, step: 1, value: params.rollSkinRings,
  format: (v) => v.toFixed(0),
  hint: '0 で表層分離を無効化し、単一のべき乗グレーディングに戻る。'
    + '内層に最低 3 層残すよう自動で制限される（肉厚が痩せると扁平量が狂うため）',
  onInput: (v) => { params.rollSkinRings = Math.round(v); scheduleRebuild(); },
});
const tSkinAuto = toggle('表層メッシュを接触弧から自動', params.rollSkinAuto, (v) => {
  params.rollSkinAuto = v;
  sSkinFactor.setEnabled(v); sSkinThick.setEnabled(!v);
  scheduleRebuild();
});
const sSkinFactor = slider({
  label: '　表層要素 = 接触弧 ÷', min: 2, max: 40, step: 1, value: params.rollSkinFactor,
  format: (v) => v.toFixed(0),
  hint: '接触応力は接触弧長オーダーの深さで減衰する。弧を 8 分割程度の要素を並べれば解ける。'
    + '表層厚さは 分割数 × この要素サイズ',
  onInput: (v) => { params.rollSkinFactor = Math.round(v); scheduleRebuild(); },
});
const sSkinThick = slider({
  label: '　表層厚さ (手動)', unit: 'mm', min: 0.002, max: 60, log: true,
  value: params.rollSkinThickness,
  format: (v) => (v * 1000).toFixed(v < 0.001 ? 3 : 2),
  onInput: (v) => { params.rollSkinThickness = v; scheduleRebuild(); },
});
const skinHint = el('div', 'ctrl-hint');
sSkinFactor.setEnabled(params.rollSkinAuto);
sSkinThick.setEnabled(!params.rollSkinAuto);

const tAutoFit = toggle('解析窓とニップ集中度を自動', params.autoFit, (v) => {
  params.autoFit = v;
  sWinIn.setEnabled(!v); sWinOut.setEnabled(!v); sBite.setEnabled(!v);
  scheduleRebuild();
});
const autoFitHint = el('div', 'ctrl-hint');
autoFitHint.textContent =
  '接触弧長は √(RΔh) で縮むのに窓長は縮まないので、薄板・小径ロールでは弧に要素が'
  + '1 列も乗らず要素アスペクト比が数百になる。自動では弧長から窓と周方向集中度を決める。';
const sWinIn = slider({
  label: '解析窓 入側端', unit: 'mm', min: -0.20, max: -0.0005, log: false, step: 0.0005,
  value: params.windowIn,
  format: (v) => (v * 1000).toFixed(2),
  onInput: (v) => { params.windowIn = v; scheduleRebuild(); },
});
const sWinOut = slider({
  label: '解析窓 出側端', unit: 'mm', min: 0.0005, max: 0.12, step: 0.0005, value: params.windowOut,
  format: (v) => (v * 1000).toFixed(2),
  onInput: (v) => { params.windowOut = v; scheduleRebuild(); },
});
const sBite = slider({
  label: 'ニップ集中度', min: 0, max: 0.99, step: 0.005, value: params.biteGrade,
  format: (v) => v.toFixed(3),
  hint: '0 = 周方向等分割。上げるほど接触弧に節点が集まる',
  onInput: (v) => { params.biteGrade = v; scheduleRebuild(); },
});
sWinIn.setEnabled(!params.autoFit);
sWinOut.setEnabled(!params.autoFit);
sBite.setEnabled(!params.autoFit);
sNum.body.append(
  meshSel.root, sNx.root, sNy.root, sNt.root, sNr.root,
  sSkinRings.root, tSkinAuto.root, sSkinFactor.root, sSkinThick.root, skinHint,
  tAutoFit.root, autoFitHint, sWinIn.root, sWinOut.root, sBite.root, meshHint,
  slider({
    label: 'Picard 反復 / フレーム', min: 1, max: 8, step: 1, value: params.picardIters,
    format: (v) => v.toFixed(0),
    hint: '剛塑性の非線形（粘度更新）反復。状態はフレーム間で持ち越すので 1 でも収束する',
    onInput: (v) => { params.picardIters = v; },
  }).root,
  slider({
    label: 'ロール弾性 更新間隔', unit: 'frame', min: 1, max: 10, step: 1, value: params.rollEvery,
    format: (v) => v.toFixed(0),
    hint: '扁平は緩やかにしか変わらないので毎フレーム解く必要はない',
    onInput: (v) => { params.rollEvery = v; },
  }).root,
  slider({
    label: '緩和係数', min: 0.1, max: 1, step: 0.05, value: params.relax,
    format: (v) => v.toFixed(2), onInput: (v) => { params.relax = v; },
  }).root,
  slider({
    label: '非圧縮ペナルティ', min: 1e3, max: 1e6, log: true, value: params.incompPenalty,
    format: (v) => v.toExponential(0), onInput: (v) => { params.incompPenalty = v; },
  }).root,
  slider({
    label: '法線ペナルティ', min: 1e3, max: 1e7, log: true, value: params.normalPenalty,
    format: (v) => v.toExponential(0), onInput: (v) => { params.normalPenalty = v; },
  }).root,
  slider({
    label: 'ひずみ速度 正則化 ε̇₀', min: 0.002, max: 0.2, log: true, value: params.eps0Frac,
    format: (v) => v.toFixed(3),
    hint: '剛体域の粘度上限を決める。小さいほど厳密だが条件数が悪化',
    onInput: (v) => { params.eps0Frac = v; },
  }).root,
  slider({
    label: '摩擦 正則化速度', min: 0.002, max: 0.3, log: true, value: params.slipFrac,
    format: (v) => v.toFixed(3), onInput: (v) => { params.slipFrac = v; },
  }).root,
  slider({
    label: '自走制御 更新間隔', unit: 'frame', min: 1, max: 20, step: 1, value: params.feedEvery,
    format: (v) => v.toFixed(0),
    hint: '送り速度ループとロール扁平ループを時間分離する。1 にすると両者が競合しやすい',
    onInput: (v) => { params.feedEvery = Math.round(v); },
  }).root,
  slider({
    label: '自走制御 ゲイン', min: 0.02, max: 0.6, step: 0.01, value: params.feedGain,
    format: (v) => v.toFixed(2), onInput: (v) => { params.feedGain = v; },
  }).root,
  slider({
    label: '自走制御 不感帯', min: 5e-4, max: 3e-2, log: true, value: params.feedDeadband,
    format: (v) => v.toExponential(1),
    hint: '|送り反力| / (μ·P) がこれを下回ったら speed を動かさない',
    onInput: (v) => { params.feedDeadband = v; },
  }).root,
  slider({
    label: 'ソルバ更新間隔', unit: 'frame', min: 1, max: 10, step: 1, value: view.solveEvery,
    format: (v) => v.toFixed(0),
    hint: '重いメッシュでも描画を 60 fps に保つ',
    onInput: (v) => { view.solveEvery = v; },
  }).root,
);

const sDisp = section('表示');
const fieldSel = select<FieldKind>('スカラー場', FIELDS, view.field, (v) => {
  view.field = v;
  view.rangeMin = 0;
  view.rangeMax = 1e-9;
  rangeFresh = true;
  fieldDirty = true;
  const want = FIELD_RAMP[v];
  if (want && view.colormap !== want) {
    view.colormap = want;
    cmapSel.set(want);
    renderer.setColormap(want);
  }
  updateLegendStatic();
});
const cmapSel = select('カラーマップ', COLORMAP_NAMES.map((c) => ({ value: c, text: c })),
  view.colormap, (v) => { view.colormap = v; renderer.setColormap(v); updateLegendStatic(); });
const extentSel = select<'full' | 'half'>('表示範囲', [
  { value: 'full', text: '全厚 — 対称ミラーで補完' },
  { value: 'half', text: '解析領域のみ — 上半分' },
], view.extent, (v) => {
  view.extent = v;
  updateExtentChip();
  fitView();
});
const tracerHint = el('div', 'ctrl-hint');
tracerHint.textContent =
  '入側で放出して速度場で流す目印線。刻線格子ひずみ図にあたる。板は空間固定 (Euler) で'
  + '解いているのでメッシュ自体は動かず、既定では板は静止して見える。';
const extentHint = el('div', 'ctrl-hint');
extentHint.textContent =
  '計算しているのは板厚の上半分と上ロールだけ。「全厚」は対称面 y = 0 で鏡像を描いて'
  + '2 段圧延機に見せているだけで、解析量は変わらない。';
const tAuto = toggle('レンジ自動', view.autoRange, (v) => { view.autoRange = v; sMax.setEnabled(!v); });
const sMax = slider({
  label: 'レンジ上限', min: 0.001, max: 2000, log: true, value: view.manualMax,
  format: (v) => v.toFixed(3), onInput: (v) => { view.manualMax = v; },
});
sMax.setEnabled(false);
sDisp.body.append(
  fieldSel.root, cmapSel.root, tAuto.root, sMax.root,
  toggle('要素メッシュ', view.showWire, (v) => { view.showWire = v; }).root,
  toggle('材料トレーサ格子', view.showTracers, (v) => { view.showTracers = v; fieldDirty = true; }).root,
  tracerHint,
  toggle('ロール表面マーキング', view.showMarks, (v) => { view.showMarks = v; }).root,
  slider({
    label: '  マーキング濃さ', min: 0, max: 0.5, step: 0.01, value: view.markAmount,
    format: (v) => v.toFixed(2),
    hint: '回転が分かる程度に。強くすると圧延速度では点滅して見える',
    onInput: (v) => { view.markAmount = v; },
  }).root,
  slider({
    label: '  マーキング本数 / 回転', min: 4, max: 48, step: 1, value: view.markCount,
    format: (v) => v.toFixed(0),
    onInput: (v) => { view.markCount = v; },
  }).root,
  extentSel.root, extentHint,
  toggle('接触弧ハイライト', view.showContact, (v) => { view.showContact = v; }).root,
  toggle('中立面 (板を貫く線)', view.showNeutral, (v) => { view.showNeutral = v; }).root,
  toggle('面圧プロファイル', view.showPressure, (v) => { view.showPressure = v; }).root,
  toggle('背景グリッド (自動間隔)', view.showGrid, (v) => { view.showGrid = v; }).root,
);

left.append(sLine.root, sGeo.root, sProc.root, sAgc.root, sRoll.root,
  sNum.root, sDisp.root);

/* ── UI: top-left panel (line-common inputs) ─────────────────────────────── */

document.getElementById('common')!.append(sStrip.root, sMat.root, sHeat.root);

/* ── mu back-calculation ─────────────────────────────────────────────────── */

const MU_INV_LABEL = 'μ逆算';
const MU_INV_LABEL_ON = 'μ逆算 解除';
const MU_INV_LABEL_STALE = 'μ逆算 再計算';
const MU_INV_TITLE =
  '各スタンドの「圧延荷重 目標」を実測荷重とみなして、その荷重になる摩擦係数を'
  + 'スラブ法から逆に解き、μ 欄に赤で書き込む。\n'
  + '入力は 荷重・入出側板厚・前後張力・ロール半径・変形抵抗のみ。FEM の現在値は'
  + '一切使わないので、線が落ち着くのを待つ必要はなく、押した瞬間に答えが出る。\n'
  + 'もう一度押すと押す前の μ に戻る。逆算のあとで入力を変えると、赤いセルが'
  + '取り消し線になり、ボタンが「再計算」に変わる。';

/** What one stand's back-calculation replaced, and what it was computed from. */
interface MuInvEntry {
  /** the mu that was in the field before, so 解除 can put it back */
  was: number;
  /** the answer, at full precision - the field shows it rounded */
  mu: number;
  /** the inputs it came from, so a later edit can be spotted as stale */
  sig: string;
  /** one line for the tooltip: what the number means */
  note: string;
}

/** Stands currently showing a back-calculated mu. Empty means the mode is off. */
const muInv = new Map<number, MuInvEntry>();
let muInvBtn: HTMLButtonElement;
/**
 * Whether anything the answers were derived from has been edited since.
 *
 * Kept as state rather than recomputed at the click, because it is what the
 * button's own label promises: with a stale cell on screen, the press people
 * mean is "do it again", not "throw it away and then do it again".
 */
let muInvStale = false;

/**
 * The pass each stand's back-calculation is run on, read straight off the table.
 *
 * Entry gauge chains down the line exactly the way `Mill` chains it - stand k
 * receives what stand k-1 delivers - and so does the work hardening, because a
 * stand's own resistance is averaged over the strain *it* adds, starting from
 * what the strip arrived with. Getting that second chain wrong is not a detail:
 * averaged from zero instead, three stands each taking 25 % all come out at the
 * same 740 MPa when the metal they are working is at 740, 1006 and 1147.
 *
 * The exit gauge is the 出側板厚 目標 cell. When that cell is not a usable exit
 * for this stand - it is above the entry gauge, which happens when the schedule
 * has been driven by 圧下率 and the gauge column left behind - the commanded
 * reduction is used instead and the row says so. Nothing here reads the solver,
 * which is the point: the answer is a function of the table alone.
 */
function muInvCases(): { c: SlabCase; fromReduction: boolean }[] {
  const out: { c: SlabCase; fromReduction: boolean }[] = [];
  let h0 = params.h0;
  let e0 = 0;
  for (let k = 0; k < standCount; k++) {
    const s = standSetups[k];
    let h1 = s.targetGauge;
    let fromReduction = false;
    if (!(h1 > 0) || h1 >= h0) { h1 = h0 * (1 - s.reduction); fromReduction = true; }
    const c: SlabCase = {
      h0,
      h1,
      R: s.R,
      backTension: getBackTension(k),
      frontTension: s.frontTension,
      entryStrain: e0,
    };
    out.push({ c, fromReduction });
    h0 = h1;
    e0 = exitStrain(c);
  }
  return out;
}

/** Every input the answer depends on, as one string. Only ever compared. */
function muInvSig(k: number, c: SlabCase): string {
  return [
    c.h0, c.h1, c.R, c.backTension, c.frontTension, c.entryStrain,
    standSetups[k].targetForce,
    params.lmnL, params.lmnM, params.lmnN,
    params.Eroll, params.nuRoll, params.rollCoupling ? 1 : 0,
  ].join(',');
}

/** A load per unit width as the mill quotes it: total force in tonf. */
const asTonf = (perWidth: number) => (perWidth * view.stripWidth) / TONF;

/**
 * Why a stand has no answer, in the words of the cell that has to be fixed.
 *
 * The two range messages quote the wall that was hit, not the whole bracket.
 * The other end of it is often infinite - past a certain friction the roll
 * flattens faster than the load it is carrying grows, and there is no steady
 * pass at all - and "1143〜Infinity tonf" is not a sentence anybody can act on.
 */
function muInvWhy(r: MuInverseResult, c: SlabCase, target: number): string {
  const asked = `入力荷重 ${asTonf(target).toFixed(0)} tonf`;
  switch (r.status) {
    case 'geometry':
      return `出側板厚 ${(c.h1 * 1000).toFixed(4)} mm が入側 ${(c.h0 * 1000).toFixed(4)} mm`
        + ' 以上 — 圧下がないので荷重の式が立たない。「出側板厚 目標」か「圧下率 目標」を直す';
    case 'tension':
      return `張力平均 ${(((c.backTension + c.frontTension) / 2) / 1e6).toFixed(0)} MPa が`
        + ' 変形抵抗 kf 以上 — この張力では板は圧延ではなく引き抜かれる。張力を下げる';
    case 'runaway':
      return `μ ${MU_MIN.toFixed(3)} でもロール扁平が発散する`
        + '（Stone の最小圧延可能板厚を割っている）— 出側板厚を上げるか、'
        + 'ロール径を小さくするか、張力を上げる';
    case 'low':
      return `${asked} は下限 ${asTonf(r.loadAtMin).toFixed(0)} tonf を下回る`
        + `（μ を ${MU_MIN.toFixed(3)} まで下げても摩擦丘が消えるだけで kf·L は残るので、`
        + '荷重はそこまでしか下がらない）— 圧下量を減らすか、張力を上げる';
    case 'high':
      return `${asked} は上限 ${asTonf(r.loadAtMax).toFixed(0)} tonf を上回る`
        + `（μ ${MU_MAX.toFixed(3)} でも届かない）— 圧下量を増やすか、張力を下げる`;
    default:
      return '';
  }
}

/**
 * Solve every stand's friction from its load, once.
 *
 * Once, on the press - not per frame. There is nothing in here that would give
 * a different answer next frame: it never reads the solver, only the table.
 */
function runMuInverse(): void {
  const cases = muInvCases();
  const body = el('div', 'toast-body');
  const head = el('div', 'toast-head');
  body.append(head);
  // What each stand held before the mode was *entered*, not before this press.
  // Solving again after retyping a load is the ordinary thing to do here, and
  // if every re-run reset the undo point, 解除 would walk back one press at a
  // time through a series of numbers nobody typed.
  const prevWas = new Map<number, number>();
  for (const [k, e] of muInv) prevWas.set(k, e.was);
  muInv.clear();

  let solved = 0, failed = 0, worst = 0;
  for (let k = 0; k < standCount; k++) {
    const { c, fromReduction } = cases[k];
    const target = standSetups[k].targetForce;
    const r = muFromLoad(params, c, target);
    const row = el('div', 'toast-row');
    row.append(el('span', 'toast-tag', standTag(k)));
    const text = el('span', 'toast-text');
    if (r.status === 'ok' && r.point) {
      solved++;
      worst = Math.max(worst, Math.abs(r.residual));
      const gauge = `h ${(c.h0 * 1000).toFixed(4)}→${(c.h1 * 1000).toFixed(4)} mm`
        + (fromReduction ? '（圧下率から）' : '');
      // The forward check, in the message and not only in an assertion: this
      // is the one number that says the answer is the answer.
      text.textContent =
        `μ ${r.mu.toFixed(5)} ／ ${gauge} ／ σb ${(c.backTension / 1e6).toFixed(0)}`
        + ` σf ${(c.frontTension / 1e6).toFixed(0)} MPa ／ R′ ${(r.point.Rflat * 1000).toFixed(1)} mm`
        + ` ／ kf ${(r.point.kf / 1e6).toFixed(0)} MPa`
        + ` ／ 順方向照合 ${asTonf(r.point.load).toFixed(1)} tonf`
        + `（入力 ${asTonf(target).toFixed(1)} tonf, 誤差 ${(r.residual * 100).toExponential(1)} %,`
        + ` 二分 ${r.iterations} 回）`;
      muInv.set(k, {
        was: prevWas.get(k) ?? standSetups[k].mu,
        mu: r.mu,
        sig: muInvSig(k, c),
        note: `圧延荷重 ${asTonf(target).toFixed(1)} tonf から逆算した μ`
          + `（${gauge}, R′ ${(r.point.Rflat * 1000).toFixed(1)} mm, kf ${(r.point.kf / 1e6).toFixed(0)} MPa,`
          + ` 順方向照合の誤差 ${(r.residual * 100).toExponential(1)} %）`,
      });
      standSetups[k].mu = r.mu;
      // The plant has moved, so what the gap loop had identified about it is
      // no longer about this stand. Same reasoning as retyping a load target.
      mill.stands[k]?.resetAgc();
    } else {
      failed++;
      text.textContent = muInvWhy(r, c, target);
      // A stand that had an answer and no longer has one must not be left
      // showing the old one in black: nothing on screen would then say that
      // the red number people were reading has stopped being derived from
      // anything. Put back what it had before the mode was entered.
      if (prevWas.has(k)) {
        standSetups[k].mu = prevWas.get(k)!;
        mill.stands[k]?.resetAgc();
      }
    }
    row.append(text);
    body.append(row);
  }

  const w = unitWord();
  head.textContent = failed === 0
    ? `μ逆算 — ${solved} ${w}を荷重から解いた（順方向照合の最大誤差`
      + ` ${(worst * 100).toExponential(1)} %）`
    : solved === 0
      ? `μ逆算 — 解けなかった（${failed} ${w}）`
      : `μ逆算 — ${solved} ${w}を解き、${failed} ${w}は解けなかった`;
  showToast(body, solved === 0, solved === 0 ? 12000 : 14000);

  // `refreshStandGrid` repaints the cells and, at its end, the red.
  syncStandDials();
  refreshStandGrid();
}

/**
 * Leave the mode.
 *
 * `restore` puts back the mu each stand had before, which is what the button
 * does: the back-calculation is meant to be a question one can ask and unask,
 * and a mode that cannot be undone is a mode nobody presses twice. A preset
 * overwriting mu calls this with `false` - the preset's own friction is the
 * right answer then, and reinstating a stale one over it would be a bug.
 */
function clearMuInverse(restore: boolean): void {
  if (restore) for (const [k, e] of muInv) standSetups[k].mu = e.was;
  const had = muInv.size > 0;
  muInv.clear();
  if (had) {
    syncStandDials();
    refreshStandGrid();
    if (restore) toast('μ を逆算前の値に戻した');
  } else {
    paintMuInverse();
  }
}

/**
 * Paint the red, and take it away again when it stops being true.
 *
 * The stale check is why this runs on every table edit (`syncStandDials`) and
 * again on the stats tick, rather than only on the press. A back-calculated mu
 * is a statement about a particular load and a particular pass; retype the load
 * and the red number is still sitting there claiming to explain it. Nothing
 * recomputes on its own - that would put a solve back in the frame loop, which
 * is exactly what this feature is not - but the cell stops claiming to be
 * current, and the button says what to press to make it so.
 */
function paintMuInverse(): void {
  const on = muInv.size > 0;
  const cases = on ? muInvCases() : null;
  muInvStale = false;
  for (let k = 0; k < standCells.length; k++) {
    const f = standCells[k].mu.root;
    const e = muInv.get(k);
    const stale = !!e && !!cases && k < cases.length && muInvSig(k, cases[k].c) !== e.sig;
    if (stale) muInvStale = true;
    f.classList.toggle('mu-inv', !!e);
    f.classList.toggle('mu-inv-stale', stale);
    const want = !e ? ''
      : stale ? '逆算したあとで入力が変わっている。「μ逆算 再計算」を押すと解き直す' : e.note;
    if (f.title !== want) f.title = want;
  }
  if (!muInvBtn) return;
  const label = !on ? MU_INV_LABEL : muInvStale ? MU_INV_LABEL_STALE : MU_INV_LABEL_ON;
  if (muInvBtn.textContent !== label) muInvBtn.textContent = label;
  muInvBtn.classList.toggle('active', on);
  const title = !on ? MU_INV_TITLE
    : muInvStale ? `${MU_INV_TITLE}\n（逆算後に入力が変わっている — 押すと解き直す）`
      : `${MU_INV_TITLE}\n（いま逆算値を表示中 — 押すと元の μ に戻る）`;
  if (muInvBtn.title !== title) muInvBtn.title = title;
}

/* ── topbar ──────────────────────────────────────────────────────────────── */

document.getElementById('topbar-presets')!.append(buttonRow(PRESETS.map((p) => ({
  text: p.name, title: p.note, onClick: () => applyPreset(p),
}))));

let playBtn: HTMLButtonElement;
{
  const row = buttonRow([
    { text: '⏸ 一時停止', primary: true, onClick: () => setRunning(!view.running) },
    { text: '↺ リセット', onClick: () => { mill.resetAll(); tracers.reset(); } },
    { text: '⤢ 表示', title: 'カメラを板全体が入る位置に戻す (F)', onClick: fitView },
    // Panel sizes persist across reloads, so there has to be a way back that
    // does not involve finding four boundaries and double-clicking each.
    {
      text: '⊞ 配置',
      title: 'パネルの境界位置と、折りたたんだセクションを既定に戻す',
      onClick: () => { layout.reset(); resetFolds(); },
    },
  ]);
  document.getElementById('topbar-actions')!.append(row);
  playBtn = row.querySelector('button')!;

  // Not next to 一時停止 and リセット, which are view controls: this one changes
  // the setup. It is one press and it answers immediately - there is nothing
  // to wait for, because it never asks the FEM anything.
  const muRow = buttonRow([{
    text: MU_INV_LABEL,
    title: MU_INV_TITLE,
    onClick: () => {
      if (muInv.size > 0 && !muInvStale) clearMuInverse(true);
      else runMuInverse();
    },
  }]);
  document.getElementById('topbar-actions')!.append(muRow);
  muInvBtn = muRow.querySelector('button')!;

  // Whole set-up in, whole set-up out. Everything a run is: the material, the
  // schedule, the mesh, the gains, the view. Not the solution - that is
  // re-derived in a second or two from the same inputs.
  document.getElementById('topbar-actions')!.append(buttonRow([
    {
      text: '↓ 保存',
      title: 'いまの設定をすべて JSON にしてダウンロードフォルダに保存する',
      onClick: () => {
        const name = settings.save(settings.collect(
          params, view, activeSetups(), standCount, mill.autoSpeed));
        toast(`${name} を保存した`);
      },
    },
    {
      text: '↑ 読込',
      title: '保存した JSON を選んで読み込む（読み込むと再起動する）',
      onClick: () => settings.load((msg) => toast(msg, true)),
    },
  ]));
}

/**
 * Say what just happened, briefly.
 *
 * A save writes a file somewhere the app cannot see and a load fails for
 * reasons only the file knows, and neither leaves any mark on the screen -
 * so both need to be able to answer "did that work?" without a dialog to
 * dismiss.
 */
function toast(text: string, bad = false): void {
  showToast(el('div', 'toast-line', text), bad);
}

/**
 * `ms` for a message that has to be *read* rather than glanced at.
 *
 * A save confirmation is one word and three seconds is plenty. A table of
 * back-calculated frictions with the inputs each came from is not, and it is
 * gone before it has been finished otherwise.
 */
function showToast(body: HTMLElement, bad: boolean, ms = bad ? 9000 : 3200): void {
  const t = el('div', bad ? 'toast bad' : 'toast');
  t.append(body);
  document.body.append(t);
  // Two frames, so the transition has a starting value to run from.
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('in')));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 400);
  }, ms);
}

const badges = document.getElementById('topbar-badges')!;
const mkBadge = (unit: string) => {
  const b = el('div', 'badge');
  b.innerHTML = `<b>—</b><span>${unit}</span>`;
  return b;
};
const bFps = mkBadge('FPS'); bFps.className = 'badge ok';
const bMs = mkBadge('ms/frame');
const bSolve = mkBadge('ms solver');
const bDof = mkBadge('DOF');
// No load badge: the rolling load is read from the right panel and from the
// mill line, both of which give it against its target. A third copy in the
// title bar was the same number with less context.
badges.append(bFps, bMs, bSolve, bDof);

/* ── right panel ─────────────────────────────────────────────────────────── */

const right = document.getElementById('right')!;

const gMill = new StatGrid();
gMill.add('P', '圧延荷重 P', 'kN/mm').add('pm', '平均面圧 p̄', 'MPa')
  .add('pk', '最大面圧 p_max', 'MPa')
  // The strict bite limit and Stone's floor are under the stand in the mill
  // line, next to the gauge they bound. This is the looser criterion that
  // applies once rolling is under way, and it is usually not a number at all.
  .add('hbitec', '継続噛み込み限界 (μ ≥ tan α/2)', 'mm')
  .add('hrat', 'h₁ / h_min（余裕）', '');
const gTotal = new StatGrid();
gTotal.add('Pt', '圧延荷重 (実機)', 'MN');
const rMill = section('圧延諸元');
rMill.body.append(gMill.root);
rMill.body.append(el('div', 'ctrl-hint', '↑ ここまで単位幅あたり（平面ひずみ）'));
rMill.body.append(gTotal.root);
const totalHint = el('div', 'ctrl-hint');
rMill.body.append(totalHint);

const gAgc = new StatGrid();
gAgc.add('S', 'ロールギャップ指令 S', 'mm')
  .add('tgt', '目標値', '').add('meas', '測定値 (平滑後)', '')
  .add('err', '偏差', '%').add('st', '状態', '')
  .add('spr', 'ミルスプリング h₁ − S', 'µm')
  .add('sprh', '　うち ハウジング伸び P/M', 'µm')
  .add('sprr', '　うち ロール扁平＋弾性回復', 'µm')
  .add('sens', '同定感度 d(測定)/d(S)', '');
const rAgc = section('自動制御 (AGC / 定圧延荷重)');
rAgc.body.append(gAgc.root);
const agcReadHint = el('div', 'ctrl-hint');
rAgc.body.append(agcReadHint);

const gKin = new StatGrid();
gKin.add('vr', 'ロール周速 v_R', 'm/s')
  .add('vin', '入側速度 v₀', 'm/s')
  .add('vout', '出側速度 v₁', 'm/s')
  .add('bs', '後進率 b = (v_R−v₀)/v_R', '%')
  .add('fsth', '　理論 f = x_n²/(R′h₁)', '%')
  .add('neut', '中立点位置 x_n', 'mm').add('nang', '中立角 φ_n', '°')
  .add('neutth', '　理論 x_n = −√(f R′h₁)', 'mm')
  .add('mb', '質量収支 v₁h₁/(v₀h₀)', '')
  .add('rx', '送り反力', 'kN/m').add('fres', '　同 残差 |R|/(μP)', '');
const gElas = new StatGrid();
gElas.add('eint', '入側弾性域 (幾何 Δh_e·R/|x_e|)', 'mm')
  .add('ein', '　FEM 実測 (解像度依存)', 'mm')
  .add('einh', '　教科書 √(R′Δh_e)', 'mm')
  .add('epl', '塑性域', 'mm').add('efrac', 'FEM 弾性域 / 接触弧', '%')
  .add('dhe', '入側 弾性圧縮 Δh_e', 'µm').add('dhp', '塑性圧下 Δh_p', 'µm')
  .add('sbmm', '出側 弾性回復 Δh_r', 'µm')
  .add('sb', '　同 ひずみ', '%').add('sbth', '　理論 kf/E′', '%')
  .add('hgap', 'ロールギャップ出口 h', 'mm');
const rElas = section('入出側 弾性域');
rElas.body.append(gElas.root);
rElas.body.append(el('div', 'ctrl-hint',
  '板厚変化の内訳: h₀ →(弾性圧縮 Δh_e)→ 降伏 →(塑性圧下 Δh_p)→ ギャップ →(弾性回復 Δh_r)→ h₁。'
  + ' FEM 実測の入側弾性域は蓄積相当ひずみが弾性限 kf/E′ を超えるまでの区間（列内補間）だが、'
  + 'この区間は多くの条件で 1 要素列より短く解像できない。'
  + '上流の板は平坦なのでバレルは勾配 |x_e|/R で閉じてくる。よって弾性圧縮 Δh_e = h₀kf/E′ は '
  + 'Δh_e·R/|x_e| の弧で消費される。教科書の √(R′Δh_e) は孤立弾性接触の式で、'
  + '塑性ビットが長いときは過大評価になる。'));

const rKin = section('速度・すべり');
rKin.body.append(gKin.root);
rKin.body.append(el('div', 'ctrl-hint',
  '自走モードでは送り反力が 0 に収束するよう入側速度を制御している。'
  + ' 先進率の理論式は板厚方向に速度一様（平面保持）を仮定して板の平均速度をロール周速に'
  + '等しく置いたもの。FEM の中立点は板 *表面* の速度で判定しており、表面は摩擦に引かれて'
  + '平均より遅れるため両者は一致しない（摩擦が強いほど差は縮む）。'
  + ' 質量収支が 1 からずれるのは出側の弾性回復ぶん（体積は弾性的に増える）。'));

const gMat = new StatGrid();
gMat.add('eps', '出側 相当ひずみ ε̄', '').add('epsIn', '　入側 ε̄ (前段から)', '')
  .add('epsT', '理論 ε̄_in + (2/√3)ln(h₀/h₁)', '')
  .add('epk', '最大 ひずみ', '').add('erate', '最大 ひずみ速度', '1/s')
  .add('sfm', '平均変形抵抗 σ̄f (ビット体積平均)', 'MPa')
  .add('sfmT', '　理論 σ_Y0+K·ε₁ⁿ/(n+1)', 'MPa')
  .add('sf', '出側 変形抵抗 σf', 'MPa').add('kf', 'スラブ法で使う kf', 'MPa');
const rMat = section('材料状態');
rMat.body.append(gMat.root);
rMat.body.append(el('div', 'ctrl-hint',
  '圧延荷重を決めるのは出側値ではなく平均変形抵抗。材料はビット入口では未加工のままで、'
  + '出側の値に達するのは最後だけなので、出側値を使うと荷重を過大評価する。'));

const gHeat = new StatGrid();
gHeat.add('dt', '温度上昇 ΔT', 'K')
  .add('tpk', '最高温度 (表層)', '°C')
  .add('soft', '出側 軟化率 1−kf(T)/kf(T₀)', '%')
  .add('kfiso', '等温 kf (出側 ε̄)', 'MPa').add('kfhot', '発熱後 kf', 'MPa')
  .add('work', '塑性仕事 σ̄f·ε̄', 'MJ/m³');
const rHeat = section('加工発熱');
rHeat.body.append(gHeat.root);
const heatStatHint = el('div', 'ctrl-hint');
rHeat.body.append(heatStatHint);

const gVal = new StatGrid();
gVal.add('rr', '圧下達成率 (指令比)', '').add('cres', '連成残差 |Δh₁|/h₁', '')
  .add('rs', '連成 減衰係数', '')
  .add('slabP', 'スラブ法 荷重', 'kN/mm')
  .add('ratio', 'FEM / スラブ法', '').add('slabPm', 'スラブ法 平均面圧', 'MPa')
  .add('Qp', '摩擦丘係数 Qp', '')
  .add('flat', 'ロール扁平量', 'µm').add('rollvm', 'ロール最大応力', 'MPa');
const rVal = section('理論照合・ロール');
rVal.body.append(gVal.root);
rVal.body.append(el('div', 'ctrl-hint',
  'スラブ法は Siebel/von Kármán の摩擦丘近似 p̄ = kf·(e^a−1)/a, a = μL/h̄。'
  + '圧下達成率が大きく 1 を下回るのはロール扁平が圧下量を食っている状態'
  + '（Stone の最小圧延可能板厚）で、数値的な破綻ではない。'));

const rRes = section('リソース');
const sparkCanvas = el('canvas', 'spark');
const sparkLegend = el('div', 'spark-legend');
const budget = new BudgetChart(sparkCanvas, [
  ['流れ解析', 'rgba(88,213,255,0.80)'],
  ['ロール弾性', 'rgba(255,196,107,0.80)'],
  ['ひずみ輸送', 'rgba(169,155,255,0.80)'],
  ['描画', 'rgba(110,231,165,0.80)'],
  ['その他', 'rgba(160,180,205,0.35)'],
]);
for (const l of budget.legend()) {
  const s = el('span');
  const i = el('i'); i.style.background = l.color;
  s.append(i, document.createTextNode(l.label));
  sparkLegend.append(s);
}
const gRes = new StatGrid();
gRes.add('solve', 'ソルバ計', 'ms').add('flow', '  ├ 流れ解析', 'ms')
  .add('rollms', '  ├ ロール弾性', 'ms').add('strain', '  └ ひずみ輸送', 'ms')
  .add('draw', '描画', 'ms').add('cg', 'CG 反復', '')
  .add('res', 'CG 残差', '').add('pd', 'Picard 変化率', '');
const gMem = new StatGrid();
gMem.add('selem', '板 要素数', '')
  .add('relem', 'ロール 要素数', '').add('nnzs', '板 非零', '')
  .add('band', '帯幅 (半)', '')
  // Split, because the three scale on different dials and one total figure only
  // ever goes up. The roll block is the big one: its elastic stiffness and the
  // band preconditioner are the largest arrays in the app.
  .add('memflow', 'ソルバ配列  流れ', '').add('memroll', '　　　　　　ロール', '')
  .add('memfield', '　　　　　　場・出力', '')
  .add('solmem', '　　　　　　選択スタンド計', '')
  .add('linemem', 'ライン合計 (全スタンド)', '')
  .add('heap', 'JS ヒープ 使用', '').add('heaptot', '　　　　　確保済み', '')
  .add('heapmax', '　　　　　上限', '');
const heapMeter = el('div', 'meter');
const heapFill = el('div');
heapFill.style.background = 'linear-gradient(90deg,#58d5ff,#a99bff)';
heapMeter.append(heapFill);
const memHint = el('div', 'ctrl-hint');
/**
 * Where the meter's two bands come from.
 *
 * The solver arrays are a slice of the heap, not a separate pool, so showing
 * them as a fraction of the same bar says how much of what the tab is holding
 * is the model itself - which is the number that decides whether a finer mesh
 * will fit.
 */
const memMeter = el('div', 'meter');
const memFill = el('div');
memFill.style.background = 'linear-gradient(90deg,#6ee7a5,#ffc46b)';
memMeter.append(memFill);
const gHost = new StatGrid();
gHost.add('gpu', 'GPU', '').add('cores', '論理コア', '')
  .add('dmem', 'デバイスメモリ', 'GB').add('dpr', 'DPR', '')
  .add('gl', 'WebGL', '').add('draws', '描画コール', '/frame');
rRes.body.append(sparkCanvas, sparkLegend, gRes.root,
  el('div', 'ctrl-hint', 'メモリ'), gMem.root,
  memMeter, heapMeter, memHint,
  el('div', 'ctrl-hint', 'ホスト'), gHost.root);

right.append(rMill.root, rAgc.root, rElas.root, rKin.root, rMat.root, rHeat.root,
  rVal.root, rRes.root);

const hill = new FrictionHillChart(document.getElementById('nip') as HTMLCanvasElement);

/* ── gap-control trail ───────────────────────────────────────────────────── */

const agcScatter = new AgcScatterChart(
  document.getElementById('agcscatter') as HTMLCanvasElement);
const agcChartCell = document.getElementById('chart-agc') as HTMLElement;
/** how many screw revisions a trail remembers */
const AGC_TRAIL = 50;
/**
 * One trail per stand, not one for the stand on screen.
 *
 * Every stand runs its own loop whether or not it is the one being inspected,
 * and the schedule is the interesting picture: the trails land at different
 * exit gauges, so drawing them together lays the whole line out along the x
 * axis. Keeping them apart also means selecting a stand costs nothing - its
 * history is already there rather than starting from an empty chart.
 */
const agcTrails: AgcSample[][] = Array.from({ length: MAX_STANDS }, () => []);
let agcSampleTick = 0;

/** The scatter is meaningless with every screw parked, so it only shows under control. */
function refreshAgcChart(): void {
  agcChartCell.hidden = !activeSetups().some((c) => c.agcMode !== 'off');
}

/**
 * Forget a trail: the operating point it was drawn against no longer exists.
 * With no argument, forget all of them - the change was a line-wide one.
 */
function clearAgcTrail(k?: number): void {
  if (k === undefined) for (const t of agcTrails) t.length = 0;
  else agcTrails[k].length = 0;
  agcSampleTick = 0;
}

/** The stands the line is actually running, in order. */
function activeStands(): RollingSim[] {
  return mill.stands.slice(0, standCount);
}

/**
 * One point per screw revision per stand, not per frame.
 *
 * The loops only move their gaps every `agcEvery` frames, so sampling faster
 * would just stack duplicate points on top of each other and make a converged
 * loop look like a dense blob rather than a trail that has stopped moving.
 */
function pushAgcSample(): void {
  if (++agcSampleTick < Math.max(1, params.agcEvery | 0)) return;
  agcSampleTick = 0;
  activeStands().forEach((st, k) => {
    if (standSetups[k].agcMode === 'off') return;
    const d = st.diag;
    if (!(d.exitThickness > 0) || d.contactNodes === 0) return;
    const trail = agcTrails[k];
    trail.push({
      h1: d.exitThickness * 1000,
      reduction: 100 * (1 - d.exitThickness / st.params.h0),
      load: (d.rollForce * view.stripWidth) / TONF,
    });
    if (trail.length > AGC_TRAIL) trail.splice(0, trail.length - AGC_TRAIL);
  });
}

/** What one stand's loop is aiming at, in the scatter's units; null when off. */
function agcTargets(k: number): AgcTargets | null {
  const c = standSetups[k];
  const st = mill.stands[k];
  if (c.agcMode === 'off' || !st) return null;
  // The chart draws the gauge a loop is aiming at, so it has to read the same
  // setpoint the loop does - which for absolute-gauge control is not the one
  // the reduction implies.
  const h1 = c.agcMode === 'gauge' ? st.agcSetpoint : st.params.h0 * (1 - c.reduction);
  return {
    h1: h1 * 1000,
    reduction: (1 - h1 / Math.max(st.params.h0, 1e-9)) * 100,
    load: (c.targetForce * view.stripWidth) / TONF,
    mode: c.agcMode === 'force' ? 'force' : 'gauge',
  };
}

/** Every running stand's trail, in line order, for the scatter to draw at once. */
function agcTrailSet(): AgcTrail[] {
  return activeStands().map((_, k) => ({
    tag: standTag(k), samples: agcTrails[k], target: agcTargets(k),
  }));
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const hudHost = document.getElementById('hud')!;
const neutralLabel = document.getElementById('neutral-label') as HTMLElement;
/**
 * Cached half width of the caption, and the string length it was measured at.
 *
 * Reading offsetWidth flushes layout, and the caption is repositioned every
 * frame. The font is tabular, so the width only moves when the number of
 * characters does - measure on that, not on every frame.
 */
let neutralHalfW = 0;
let neutralTextLen = -1;

/**
 * Point the detailed view at a stand.
 *
 * Every single-stand readout in this file reads through `sim`, so switching
 * stands is one assignment plus telling the renderer which meshes to upload -
 * there is no second copy of the panel to keep in step.
 */
function selectStand(i: number): void {
  view.stand = Math.max(0, Math.min(standCount - 1, i));
  sim = mill.stands[view.stand];
  renderer.setMesh(sim);
  millLine.setSelected(view.stand);
  paintStandGridSelection();
  fieldDirty = true;
  syncStandDials();
  refreshGeom();
  refreshMeshHint();
}

/** Pull the selected stand's own settings back into the shared dials. */
function syncStandDials(): void {
  const c = standSetups[view.stand];
  params.R = c.R;
  params.mu = c.mu;
  params.reduction = c.reduction;
  params.agcTargetForce = c.targetForce;
  params.agcTargetGauge = c.targetGauge;
  params.frontTension = c.frontTension;
  params.agcMode = c.agcMode;
  agcHint.textContent = AGC_HINT[c.agcMode];
  refreshAgcChart();
  view.agcTargetTonf = (c.targetForce * view.stripWidth) / TONF;
  syncAgcTarget();
  syncRollSpeed();
  // Every edit in the stand table lands here, and several of them are inputs
  // to the back-calculation. Repainting on the stats tick alone would leave a
  // red cell claiming for a sixth of a second to explain a load that has
  // already been retyped.
  paintMuInverse();
}

/** Park the neutral-plane caption over its world position. */
function placeNeutralLabel(): void {
  const d = sim.diag;
  if (!view.showNeutral || !d.neutralFound) { neutralLabel.hidden = true; return; }
  // The forward slip belongs in this caption: it is the same fact as the
  // crossing the caption marks, read at the exit instead. Where the neutral
  // plane sits sets how much of the arc the strip spends running ahead of the
  // barrel, and f is exactly how far ahead it comes out.
  const txt = `中立点 ${(d.neutralX * 1000).toFixed(2)} mm`
    + ` ／ 先進率 f ${(d.forwardSlip * 100).toFixed(2)} %`;
  if (neutralLabel.textContent !== txt) neutralLabel.textContent = txt;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const sx = w / 2 + ((d.neutralX - cam.cx) * cam.zoom) / dpr;
  const top = surfaceAt(d.neutralX) + standH0() * 0.3;
  const sy = h / 2 - ((top - cam.cy) * cam.zoom) / dpr;
  // Unhide before measuring: the caption is centred on the plane, so it needs
  // its own half width of room at either edge, and a hidden element has none.
  neutralLabel.hidden = false;
  if (txt.length !== neutralTextLen) {
    neutralTextLen = txt.length;
    neutralHalfW = neutralLabel.offsetWidth / 2 + 8;
  }
  if (sx < neutralHalfW || sx > w - neutralHalfW) { neutralLabel.hidden = true; return; }
  neutralLabel.style.left = `${sx}px`;
  neutralLabel.style.top = `${Math.max(14, sy)}px`;
}
const gridChip = el('div', 'hud-chip');
const extentChip = el('div', 'hud-chip accent');
extentChip.innerHTML = '<b>解析領域のみ</b> ／ 下端が対称面 y = 0（板厚中心）';
function updateExtentChip(): void {
  if (view.extent === 'half') hudHost.append(extentChip);
  else extentChip.remove();
}

function updateGridChip(): void {
  if (!view.showGrid) { gridChip.remove(); return; }
  const p = renderer.gridPitch;
  const txt = p >= 1e-3 ? `${(p * 1e3).toFixed(p * 1e3 < 1 ? 2 : 0)} mm` : `${(p * 1e6).toFixed(0)} µm`;
  gridChip.innerHTML = `格子 <b>${txt}</b> ／ 太線 ${p * 5 >= 1e-3 ? `${(p * 5e3).toFixed(p * 5e3 < 1 ? 2 : 0)} mm` : `${(p * 5e6).toFixed(0)} µm`}`;
  if (!gridChip.isConnected) hudHost.prepend(gridChip);
}

function refreshMeshHint(): void {
  const arc = Math.sqrt(params.R * (standH0() - standH0() * (1 - params.reduction)));
  const dx = (sim.winOut - sim.winIn) / params.stripNx;
  const pitch = (2 * Math.PI * params.R) / params.rollNt;
  // the graded circumferential mapping is phi = pi((1-w)s + w s^3); at the bite
  // the spacing is (1-w) times the uniform one
  const nipPitch = pitch * (1 - sim.biteGradeEff);
  meshHint.textContent =
    `板 ${params.stripNx}×${params.stripNy} = ${(params.stripNx * params.stripNy).toLocaleString()} 要素`
    + ` ／ ロール ${params.rollNt}×${params.rollNr} = ${(params.rollNt * params.rollNr).toLocaleString()} 要素`
    + ` ／ 全自由度 ${(2 * ((params.stripNx + 1) * (params.stripNy + 1) + params.rollNt * (params.rollNr + 1))).toLocaleString()}`
    + ` ／ 解析窓 ${(sim.winIn * 1000).toFixed(2)} 〜 ${(sim.winOut * 1000).toFixed(2)} mm`
    + ` ／ 接触弧に 板 ${Math.round(arc / dx)} 列・ロール ${Math.round(arc / nipPitch)} 節点`;
  const skinT = sim.skinThicknessEff;
  skinHint.textContent = skinT > 0 && params.rollSkinRings > 0
    ? `ロール表層 ${(skinT * 1000).toFixed(3)} mm を ${params.rollSkinRings} 分割`
      + ` → 表層要素 ${(sim.skinElementSize * 1e6).toFixed(1)} µm 厚`
      + `（接触弧の ${(100 * sim.skinElementSize / Math.max(arc, 1e-12)).toFixed(1)}%）`
      + ` ／ 内層 成長率 q = ${sim.roll.coreGrowth.toFixed(2)}`
      + (sim.roll.coreGrowth > 2.5
        ? ' ⚠ 内層が急に粗くなりすぎ。ロール半径方向分割 nr を増やすこと'
        : '')
    : `表層分離なし（最表層 ${(sim.skinElementSize * 1e6).toFixed(1)} µm 厚）`;
}

function refreshGeom(): void {
  const h1 = standH0() * (1 - params.reduction);
  const Lc = Math.sqrt(params.R * (standH0() - h1));
  const alpha = Math.acos(Math.max(-1, 1 - (standH0() - h1) / (2 * params.R)));
  geoHint.textContent =
    `h₁ = ${(h1 * 1000).toFixed(3)} mm ／ 公称接触弧長 L = √(RΔh) = ${(Lc * 1000).toFixed(2)} mm`
    + ` ／ 噛み込み角 α = ${((alpha * 180) / Math.PI).toFixed(2)}° (tan α = ${Math.tan(alpha).toFixed(3)})`;
}

function updateLegendStatic(): void {
  (document.getElementById('legend-grad') as HTMLElement).style.background =
    rampGradient(view.colormap, 24);
  (document.getElementById('legend-name') as HTMLElement).textContent =
    FIELD_LABEL.get(view.field) ?? '';
  (document.getElementById('legend-unit') as HTMLElement).textContent =
    fieldUnit(view.field).unit;
}

function setRunning(on: boolean): void {
  view.running = on;
  playBtn.textContent = on ? '⏸ 一時停止' : '▶ 再生';
  playBtn.classList.toggle('btn-primary', on);
}

function applyPreset(p: Preset): void {
  Object.assign(params, p.patch);
  // The roll radius, the friction and the reduction belong to the stands, and
  // `mill.sync` reads them from there every frame - writing them to `params`
  // alone would be overwritten before the next draw.
  for (const st of standSetups) {
    if (p.patch.R !== undefined) st.R = p.patch.R;
    if (p.patch.mu !== undefined) st.mu = p.patch.mu;
    if (p.patch.reduction !== undefined) st.reduction = p.patch.reduction;
  }
  // After the loop above, not before: leaving the mode re-reads the selected
  // stand's settings into the shared dials, and doing that while the stands
  // still held the back-calculated friction would put that number back into
  // `params.mu` - where the theory panel reads it - over the preset's own.
  // Dropped rather than restored, because the value to keep now is the
  // preset's, not whatever the table held before the back-calculation.
  clearMuInverse(false);
  sH0.set(params.h0);
  sY0.set(params.lmnL); sK.set(params.lmnM); sN.set(params.lmnN);
  view.rollSpeedMpm = params.omega * params.R * MPM;
  sOmega.set(view.rollSpeedMpm); syncRollSpeed();
  view.rangeMax = 1e-9;
  rangeFresh = true;
  scheduleRebuild();
}

/* ── interaction ─────────────────────────────────────────────────────────── */

let drag: { x: number; y: number; cx: number; cy: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, cx: cam.cx, cy: cam.cy };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cam.cx = drag.cx - ((e.clientX - drag.x) * dpr) / cam.zoom;
  cam.cy = drag.cy + ((e.clientY - drag.y) * dpr) / cam.zoom;
});
const endDrag = () => { drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left - r.width / 2) * dpr;
  const my = -(e.clientY - r.top - r.height / 2) * dpr;
  const wx = cam.cx + mx / cam.zoom;
  const wy = cam.cy + my / cam.zoom;
  cam.zoom = Math.max(200, Math.min(400000, cam.zoom * Math.exp(-e.deltaY * 0.0016)));
  cam.cx = wx - mx / cam.zoom;
  cam.cy = wy - my / cam.zoom;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setRunning(!view.running); }
  else if (e.key === 'r' || e.key === 'R') { mill.resetAll(); tracers.reset(); }
  else if (e.key === 'f' || e.key === 'F') fitView();
  // Stands by number, and by arrow along the line. Clicking a stand means
  // moving the pointer to the top of the screen and back, and switching stands
  // is something you do while watching one number change.
  else if (e.key >= '1' && e.key <= '8') {
    const k = Number(e.key) - 1;
    if (k < standCount) selectStand(k);
  } else if (e.key === 'ArrowLeft' && view.stand > 0) selectStand(view.stand - 1);
  else if (e.key === 'ArrowRight' && view.stand < standCount - 1) selectStand(view.stand + 1);
});
/**
 * Everything that has to be redone when a panel boundary moves.
 *
 * The canvases carry an intrinsic size from their width/height attributes and
 * do not notice a grid track changing on their own, and the selected-stand
 * band is positioned from the table's measured columns.
 */
function relayout(): void {
  fitView();
  paintStandGridSelection();
  millLine.draw(millViews());
  fieldDirty = true;
}
const layout = installLayout(document.getElementById('app')!, relayout);
window.addEventListener('resize', () => { layout.refresh(); relayout(); });

/* ── loop ────────────────────────────────────────────────────────────────── */

let last = performance.now();
let fpsEma = 60, frameEma = 16;
let statTick = 0, frameCount = 0;
let fieldDirty = true;
/** the scalar field just changed: take the next range outright, do not ease into it */
let rangeFresh = true;
let statMs = 0;
let lastRange = { min: 0, max: 1 };

refreshGeom();
refreshMeshHint();
updateExtentChip();
updateLegendStatic();
buildStandGrid();
refreshAgcChart();
// view.running, not a literal: ?nosolve has already set it false.
setRunning(view.running);
fitView();

function frame(now: number): void {
  const wall = Math.min(now - last, 100);
  last = now;
  frameEma += (wall - frameEma) * 0.1;
  fpsEma += (1000 / Math.max(wall, 1e-3) - fpsEma) * 0.08;
  renderer.resize(Math.min(window.devicePixelRatio || 1, 2));

  let solved = false;
  if (view.running && ++frameCount % Math.max(1, view.solveEvery) === 0) {
    mill.sync(params, activeSetups());
    mill.advance(wall / 1000);
    pushAgcSample();
    solved = true;
  }
  if (view.running && view.showTracers) tracers.update(wall / 1000);

  if (solved || fieldDirty) {
    lastRange = sim.computeField(view.field);
    fieldDirty = false;
  }
  const r = lastRange;
  const sc = fieldUnit(view.field).scale;
  const signed = SIGNED_FIELDS.has(view.field);
  if (view.autoRange) {
    // a signed field gets a symmetric range so zero sits at the middle of a
    // diverging ramp
    const lo = signed ? -Math.max(Math.abs(r.min), Math.abs(r.max), 1e-12)
      : OFFSET_FIELDS.has(view.field) ? r.min : Math.min(0, r.min);
    const hi = signed ? -lo : Math.max(r.max, lo + 1e-9);
    // The ramp snaps outwards and eases inwards, so a transient spike is seen
    // at once and does not leave the scale stretched afterwards. A field that
    // has just been switched to snaps both ends: its predecessor's range says
    // nothing about it, and on an offset field the floor would otherwise have
    // to crawl up from zero for a second before the picture meant anything.
    view.rangeMin += (lo - view.rangeMin) * (rangeFresh || lo < view.rangeMin ? 1 : 0.05);
    view.rangeMax += (hi - view.rangeMax) * (rangeFresh || hi > view.rangeMax ? 1 : 0.05);
    rangeFresh = false;
    sMax.set(Math.max(0.001, view.rangeMax * sc));
  } else {
    view.rangeMax = view.manualMax / sc;
    view.rangeMin = signed ? -view.rangeMax
      : OFFSET_FIELDS.has(view.field) ? Math.min(r.min, view.rangeMax) : 0;
  }

  const ropts: RenderOptions = {
    range: { min: view.rangeMin, max: view.rangeMax },
    showWire: view.showWire, showMarks: view.showMarks, showGrid: view.showGrid,
    showPressure: view.showPressure, showContact: view.showContact,
    showMirror: view.extent === 'full', rollMagnify: view.rollMagnify,
    markAmount: view.markAmount, markCount: view.markCount,
    showNeutral: view.showNeutral,
    rollUseField: !STRIP_ONLY.has(view.field),
    stripUseField: !ROLL_ONLY.has(view.field),
  };
  renderer.draw(sim, cam, ropts);

  if (view.showTracers && tracers.lines.length) {
    for (const f of view.extent === 'full' ? [1, -1] : [1]) {
      for (const l of tracers.lines) {
        renderer.strokePolyline(l, l.length / 2, false, 3.6, cam, [0.03, 0.05, 0.09, 0.6], 0, f);
      }
      for (const l of tracers.lines) {
        renderer.strokePolyline(l, l.length / 2, false, 1.5, cam, [0.98, 0.99, 1.0, 0.92], 0, f);
      }
    }
  }

  budget.push([
    solved ? sim.lastFlowMs : 0, solved ? sim.lastRollMs : 0,
    solved ? sim.lastStrainMs : 0, renderer.lastDrawMs,
    Math.max(0, frameEma - (solved ? sim.lastStepMs : 0) - renderer.lastDrawMs),
  ]);

  updateGridChip();
  placeNeutralLabel();
  if (++statTick % 6 === 0) {
    const t = performance.now();
    updateStats();
    statMs += (performance.now() - t - statMs) * 0.3;
  }
  if (DEBUG_TITLE) {
    document.title = `f${frameEma.toFixed(1)} s${sim.lastStepMs.toFixed(1)} `
      + `d${renderer.lastDrawMs.toFixed(1)} u${statMs.toFixed(1)} c${renderer.drawCalls}`
      + ` t${tracers.lines.length}`;
  }
  requestAnimationFrame(frame);
}

function tone(v: number, warn: number, bad: number): 'ok' | 'warn' | 'bad' {
  return v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok';
}

function updateStats(): void {
  const d = sim.diag;
  const sc = fieldUnit(view.field).scale;
  const slab = sim.slabMethod();

  (document.getElementById('legend-min') as HTMLElement).textContent = (view.rangeMin * sc).toFixed(2);
  (document.getElementById('legend-mid') as HTMLElement).textContent =
    ((view.rangeMin + view.rangeMax) * 0.5 * sc).toFixed(2);
  (document.getElementById('legend-max') as HTMLElement).textContent = (view.rangeMax * sc).toFixed(2);

  bFps.querySelector('b')!.textContent = fpsEma.toFixed(0);
  bFps.className = `badge ${fpsEma > 50 ? 'ok' : fpsEma > 28 ? 'warn' : 'bad'}`;
  bMs.querySelector('b')!.textContent = frameEma.toFixed(1);
  bMs.className = `badge ${frameEma < 20 ? 'ok' : frameEma < 34 ? 'warn' : 'bad'}`;
  bSolve.querySelector('b')!.textContent = sim.lastStepMs.toFixed(1);
  bDof.querySelector('b')!.textContent = String(sim.dofCount);

  gMill.set('P', (d.rollForce / 1e6).toFixed(3));
  gMill.set('pm', (d.meanPressure / 1e6).toFixed(0));
  gMill.set('pk', (d.peakPressure / 1e6).toFixed(0));
  // The gauge and the two walls under it are a row in the mill line now. What
  // is left here is the looser criterion, which applies once rolling is under
  // way, and the headroom ratio - the reading, rather than the raw limits.
  //
  // Banded, not a verdict: above the strict limit the bite is comfortable,
  // below the continuation limit it is impossible, and in between the mill is
  // marginal - which is where this model itself stops giving a clean answer.
  // A limit at or below zero means the bite-angle-limited draft exceeds the
  // whole strip: nothing this mill can close to would fail to bite, so there
  // is no limiting thickness to quote.
  gMill.set('hbitec',
    d.biteLimitH1Cont > 0 ? (d.biteLimitH1Cont * 1000).toFixed(4) : '制約なし',
    d.exitThickness > d.biteLimitH1 ? 'ok'
      : d.exitThickness > d.biteLimitH1Cont ? 'warn' : 'bad');
  const stoneRatio = d.stoneHMin > 0 ? d.exitThickness / d.stoneHMin : Infinity;
  gMill.set('hrat', Number.isFinite(stoneRatio) ? stoneRatio.toFixed(2) : '—',
    stoneRatio > 4 ? 'ok' : stoneRatio > 2 ? 'warn' : 'bad');

  // per-unit-width results scaled to the actual strip width
  const b = view.stripWidth;
  gTotal.set('Pt', ((d.rollForce * b) / 1e6).toFixed(3));
  totalHint.textContent =
    `↑ ${standTag(view.stand)} を板幅 ${(b * 1000).toFixed(0)} mm に換算した実機値。`
    + 'トルク・動力は上下 2 本分。ライン合計はミルライン図の見出しに出る。';

  // The commanded-gauge hint is derived from this stand's entry gauge, which on
  // a tandem line keeps moving as the chain settles - so it has to be redrawn,
  // not just written once when the stand is selected.
  if (mill.count > 1) refreshGeom();

  const force = params.agcMode === 'force';
  const absGauge = params.agcMode === 'gauge';
  gAgc.set('S', (d.gapCommand * 1000).toFixed(4));
  gAgc.set('spr', (d.millSpring * 1e6).toFixed(2));
  gAgc.set('sprh', params.millSpringOn ? (d.millStretch * 1e6).toFixed(2) : '—');
  gAgc.set('sprr', ((d.millSpring - d.millStretch) * 1e6).toFixed(2));
  if (params.agcMode === 'off') {
    gAgc.set('tgt', '—'); gAgc.set('meas', '—'); gAgc.set('err', '—');
    gAgc.set('sens', '—');
    gAgc.set('st', 'OFF');
    agcReadHint.textContent =
      `指令 h₁ = ${(standH0() * (1 - params.reduction) * 1000).toFixed(4)} mm に対し`
      + ` 出側 ${(d.exitThickness * 1000).toFixed(4)} mm。`
      + '差はミルスプリング（ロール扁平＋出側弾性回復）。';
  } else {
    // The setpoint the loop is actually driving to. Under absolute-gauge
    // control that is not the one the reduction implies, and printing the
    // reduction's would put a target beside a deviation it does not explain.
    gAgc.set('tgt', force
      ? `${view.agcTargetTonf.toFixed(view.agcTargetTonf < 100 ? 1 : 0)} tonf`
      : `${(sim.agcSetpoint * 1000).toFixed(4)} mm`
        + (absGauge ? '（絶対）' : '（圧下率換算）'));
    // The loop acts on the filtered measurement, so show that one - the
    // instantaneous value sits next to a deviation it does not explain.
    gAgc.set('meas', force
      ? `${((d.agcMeasured * b) / TONF).toFixed(1)} tonf`
      : `${(d.agcMeasured * 1000).toFixed(4)} mm`);
    gAgc.set('err', (d.agcError * 100).toFixed(4),
      d.agcSettled ? 'ok' : Math.abs(d.agcError) < 0.01 ? 'warn' : 'bad');
    gAgc.set('sens', d.agcSensitivity !== 0 ? d.agcSensitivity.toFixed(3) : '—');
    gAgc.set('st', d.agcIdle ? '保留（目標 ≥ 入側板厚）'
      : d.agcSaturated ? 'ギャップ端に張り付き'
        : d.agcSettled ? '収束' : d.agcStalled ? '内側ループ待ち' : '調整中',
      d.agcIdle ? 'warn'
        : d.agcSaturated || d.agcStalled ? 'bad' : d.agcSettled ? 'ok' : 'warn');
    // Sourced from the solver, not retyped: these bounds have moved before,
    // and a hint quoting the old ones is worse than no hint.
    const closing = force ? d.agcError < 0 : d.agcError > 0;
    // The rail is on the *loaded* separation, so the stand's stiffness does not
    // move it - at 0.30*h0 the geometry, and therefore the load, is the same
    // whatever M is. What does move the achievable total load is the width the
    // per-unit-width result is multiplied by, and the material and geometry.
    // Pressed against the closing rail, the load being measured *is* the most
    // this range can make - so say so, and say whether driving the screws past
    // it would even help. Near Stone's limit it would not: the barrel flattens
    // instead of the strip thinning, and the load has a ceiling of its own.
    const ratio = d.stoneHMin > 0 ? d.exitThickness / d.stoneHMin : Infinity;
    const ceiling = force
      ? `この範囲で出せるのは今の ${((d.rollForce * b) / TONF).toFixed(0)} tonf が上限`
      : `この条件で届く実圧下率は ${(100 * (1 - d.exitThickness / standH0())).toFixed(1)}% が上限`;
    agcReadHint.textContent = d.agcStalled
      ? `送り速度ループが収束していない（残差 ${d.feedResidual.toExponential(1)} ＞ 不感帯`
        + ` ${params.feedDeadband.toExponential(0)}）ためスクリューを止めている。`
        + 'この状態の測定値は定常解ではなく、動かせば誤った位置に最適化してしまう。'
        + (d.exitThickness <= d.biteLimitH1
          ? '出側板厚が噛み込み限界を下回っており、自走できる送り速度がそもそも存在しない。'
            + 'μ か R を上げるか圧下率を下げること。'
          : '一度「スクリュー位置をリセット」してからやり直すか、送り速度を手動指定すること。')
      : d.agcSaturated
      ? (closing
        ? `スクリューが下端 ${(d.gapLimitLo * 1000).toFixed(4)} mm（バレル間隔 0.30·h₀）。`
          + `${ceiling}。`
          + (ratio < 2
            ? ` h₁/h_min = ${ratio.toFixed(2)} と Stone の最小圧延可能板厚に近く、`
              + 'これ以上締めてもロールが扁平するだけで荷重は増えない。'
              + 'ロール径 R を小さくするか、板幅 b・μ・σ_Y0 を上げること。'
            : ` h₁/h_min = ${Number.isFinite(ratio) ? ratio.toFixed(2) : '—'}`
              + 'とまだ余裕はあるが、下端より先は質量収支が崩れるため許していない。'
              + '板幅 b・μ・σ_Y0・K・R・h₀ を上げるか、目標を下げること。')
        : `これ以上開くと「ギャップ＋ミルスプリング」が h₀ に届いて板が素通りする`
          + `（上端 ${(d.gapLimitHi * 1000).toFixed(4)} mm）。目標が過小。`
          + (force ? '板幅 b を下げるか、目標を上げること。' : ''))
      : force
        ? '荷重を合わせにいくので圧下率は結果。実圧下率と圧下達成率を見ること。'
        : 'スクリューはミルスプリング分だけ余分に締まる。S < h₀(1−r) が正常。';
  }

  const Ep = params.Estrip / (1 - params.nuStrip * params.nuStrip);
  gElas.set('ein', (d.elasticEntryLen * 1000).toFixed(3));
  gElas.set('epl', (d.plasticArcLen * 1000).toFixed(3));
  gElas.set('eint', (d.elasticEntryTheory * 1000).toFixed(3));
  gElas.set('einh', (d.elasticEntryHertz * 1000).toFixed(3));
  gElas.set('efrac', d.arcLength > 0
    ? (100 * d.elasticEntryLen / d.arcLength).toFixed(2) : '—');
  gElas.set('dhe', (d.elasticEntryCompression * 1e6).toFixed(3));
  gElas.set('dhp', ((standH0() - d.elasticEntryCompression - d.exitThicknessGap) * 1e6).toFixed(2));
  gElas.set('sb', (d.springback * 100).toFixed(4));
  gElas.set('sbmm', ((d.exitThickness - d.exitThicknessGap) * 1e6).toFixed(3));
  gElas.set('hgap', (d.exitThicknessGap * 1000).toFixed(4));
  gElas.set('sbth', ((slab.kf / Ep) * 100).toFixed(4));

  gKin.set('vr', (params.omega * params.R).toFixed(4));
  gKin.set('vin', d.entrySpeed.toFixed(4));
  gKin.set('vout', d.exitSpeed.toFixed(4));
  gKin.set('bs', (d.backwardSlip * 100).toFixed(3));
  gKin.set('fsth', d.neutralFound ? (d.forwardSlipTheory * 100).toFixed(3) : '—');
  gKin.set('nang', d.neutralFound ? ((d.neutralAngle * 180) / Math.PI).toFixed(3) : '—');
  gKin.set('neutth', d.forwardSlip > 0 ? (d.neutralTheory * 1000).toFixed(3) : '—');
  gKin.set('neut', d.neutralFound ? (d.neutralX * 1000).toFixed(2) : '—',
    d.neutralFound ? 'ok' : 'warn');
  gKin.set('fres', d.feedResidual.toExponential(1),
    d.feedResidual < params.feedDeadband * 2 ? 'ok' : 'warn');
  gKin.set('mb', d.massBalance.toFixed(4),
    Math.abs(d.massBalance - 1) < 0.01 ? 'ok'
      : Math.abs(d.massBalance - 1) < 0.03 ? 'warn' : 'bad');
  gKin.set('rx', (d.feedReaction / 1000).toFixed(2),
    Math.abs(d.feedReaction) > 0.05 * Math.max(d.rollForce * params.mu, 1) ? 'warn' : 'ok');

  // Plus what the strip arrived with: on a tandem line the exit strain is
  // cumulative down the whole line, so the theory line it is checked against
  // has to start from the same place or the two disagree by a whole pass.
  const epsT = d.entryStrain
    + (2 / Math.sqrt(3)) * Math.log(standH0() / Math.max(d.exitThickness, 1e-9));
  gMat.set('eps', d.exitStrain.toFixed(3));
  gMat.set('epsIn', d.entryStrain.toFixed(3));
  gMat.set('epsT', epsT.toFixed(3));
  gMat.set('epk', d.peakStrain.toFixed(3));
  gMat.set('erate', d.peakStrainRate.toFixed(1));
  gMat.set('sfm', (d.meanFlowStress / 1e6).toFixed(1));
  gMat.set('sfmT', (d.meanFlowStressTheory / 1e6).toFixed(1));
  // Three exponents are far harder to read than a yield stress was, so show
  // what the law actually evaluates to at the points that matter.
  lmnHint.textContent =
    `kf(0) = ${(params.lmnL * Math.pow(params.lmnM, params.lmnN) / 1e6).toFixed(0)} MPa`
    + ` ／ kf(ε=0.2) = ${(params.lmnL
      * Math.pow(0.2 + params.lmnM, params.lmnN) / 1e6).toFixed(0)} MPa`
    + ` ／ 出側 ε̄ = ${d.exitStrain.toFixed(3)} で`
    + ` ${(params.lmnL * Math.pow(d.exitStrain + params.lmnM, params.lmnN) / 1e6).toFixed(0)} MPa`;
  gMat.set('sf', (d.exitFlowStress / 1e6).toFixed(0));
  gMat.set('kf', (slab.kf / 1e6).toFixed(0));

  {
    // What the pass would have cost with no heating, against what it did cost.
    // The isothermal figure is the same law evaluated at the entry temperature,
    // so the pair is a direct read of what the mode is doing.
    const kfIso = params.lmnL
      * Math.pow(Math.max(d.exitStrain, 0) + Math.max(params.lmnM, 0), params.lmnN);
    const kfHot = kfIso * (1 - d.thermalSoftening);
    gHeat.set('dt', d.tempRise.toFixed(1), params.heatOn ? 'warn' : undefined);
    gHeat.set('tpk', d.peakTemp.toFixed(1));
    gHeat.set('soft', (100 * d.thermalSoftening).toFixed(2));
    gHeat.set('kfiso', (kfIso / 1e6).toFixed(0));
    gHeat.set('kfhot', (kfHot / 1e6).toFixed(0));
    // Plastic work per unit volume, the quantity the temperature rise is: the
    // strain-averaged resistance times the strain the pass put in.
    const work = d.meanPlaneStrainStress * Math.max(d.exitStrain, 0);
    gHeat.set('work', (work / 1e6).toFixed(1));
    heatStatHint.textContent = params.heatOn
      ? `ΔT = β·σ̄f·ε̄/(ρc) を流線に沿って積分した値。ρc = `
        + `${((params.rhoStrip * params.cpStrip) / 1e6).toFixed(2)} MJ/(m³·K)。`
        + 'ロールへの抜熱を入れていないので上限側の見積り。'
      : '加工発熱 OFF（等温）。左上「加工発熱」パネルで ON にすると、'
        + '板が自分で出した熱の分だけ変形抵抗が下がる。';
    heatOutHint.textContent = params.heatOn
      ? `出側 ΔT = ${d.tempRise.toFixed(1)} K ／ 軟化 ${(100 * d.thermalSoftening).toFixed(2)} %`
        + ` ／ kf ${(kfIso / 1e6).toFixed(0)} → ${(kfHot / 1e6).toFixed(0)} MPa`
      : 'OFF のあいだ板は入側温度のまま。変形抵抗はひずみだけの関数。';
  }

  const hm = (standH0() + d.exitThickness) / 2;
  const a = (params.mu * slab.arc) / Math.max(hm, 1e-9);
  gVal.set('rr', d.reductionRatio.toFixed(3),
    d.reductionRatio > 0.85 ? 'ok' : d.reductionRatio > 0.5 ? 'warn' : 'bad');
  gVal.set('cres', d.couplingResidual.toExponential(1),
    d.couplingResidual < 1e-5 ? 'ok' : d.couplingResidual < 1e-3 ? 'warn' : 'bad');
  gVal.set('rs', d.relaxScale.toFixed(3), d.relaxScale > 0.5 ? 'ok' : 'warn');
  gVal.set('slabP', (slab.load / 1e6).toFixed(3));
  const ratio = slab.load > 0 ? d.rollForce / slab.load : 0;
  gVal.set('ratio', ratio.toFixed(2),
    ratio > 0.7 && ratio < 1.4 ? 'ok' : 'warn');
  gVal.set('slabPm', (slab.meanPressure / 1e6).toFixed(0));
  gVal.set('Qp', (a > 1e-6 ? (Math.exp(a) - 1) / a : 1).toFixed(3));
  gVal.set('flat', (d.rollFlattening * 1e6).toFixed(1));
  gVal.set('rollvm', (d.rollPeakVm / 1e6).toFixed(0));

  gRes.set('solve', sim.lastStepMs.toFixed(2));
  gRes.set('flow', sim.lastFlowMs.toFixed(2));
  gRes.set('rollms', sim.lastRollMs.toFixed(2));
  gRes.set('strain', sim.lastStrainMs.toFixed(2));
  gRes.set('draw', renderer.lastDrawMs.toFixed(2));
  gRes.set('cg', String(d.cgIterations), d.cgIterations >= params.cgIter ? 'bad' : 'ok');
  gRes.set('res', d.cgResidual.toExponential(1));
  gRes.set('pd', d.picardDelta.toExponential(1),
    d.picardDelta > 1e-2 ? 'warn' : 'ok');

  gMem.set('selem', sim.flow.mesh.ne.toLocaleString());
  gMem.set('relem', sim.roll.ne.toLocaleString());
  gMem.set('nnzs', sim.flow.pattern.nnz.toLocaleString());
  gMem.set('band', String(2 * (sim.flow.mesh.rows + 1) + 1));
  const split = sim.memorySplit();
  const standMem = split.flow + split.roll + split.field;
  gMem.set('memflow', bytes(split.flow));
  gMem.set('memroll', bytes(split.roll));
  gMem.set('memfield', bytes(split.field));
  gMem.set('solmem', bytes(standMem));
  // Every stand carries its own full set of arrays, so what the line costs is
  // the sum - and on eight stands that is what actually decides whether the
  // mesh you asked for fits.
  let lineMem = 0;
  for (let k = 0; k < mill.count; k++) lineMem += mill.stands[k].memoryBytes();
  gMem.set('linemem', bytes(lineMem),
    lineMem > 512 * 1048576 ? 'bad' : lineMem > 192 * 1048576 ? 'warn' : 'ok');
  const h = heap();
  if (h) {
    gMem.set('heap', bytes(h.used), tone(h.used / h.limit, 0.6, 0.85));
    gMem.set('heaptot', bytes(h.total));
    gMem.set('heapmax', bytes(h.limit));
    heapFill.style.width = `${Math.min(100, (h.used / h.limit) * 100).toFixed(1)}%`;
    memFill.style.width = `${Math.min(100, (lineMem / h.limit) * 100).toFixed(2)}%`;
    memHint.textContent =
      `上段 ライン合計 ${bytes(lineMem)} ／ 下段 JS ヒープ ${bytes(h.used)}`
      + ` — どちらも上限 ${bytes(h.limit)} に対する割合。`
      + `モデルはヒープの ${((lineMem / Math.max(h.used, 1)) * 100).toFixed(0)}%。`;
  } else {
    // Firefox and Safari do not expose the heap at all.
    gMem.set('heap', 'n/a'); gMem.set('heaptot', 'n/a'); gMem.set('heapmax', 'n/a');
    heapFill.style.width = '0%';
    memFill.style.width = '0%';
    memHint.textContent =
      `ライン合計 ${bytes(lineMem)}。JS ヒープはこのブラウザでは取得できない。`;
  }

  gHost.set('gpu', info.gpu);
  gHost.set('cores', String(info.cores || '—'));
  gHost.set('dmem', info.deviceMemoryGB === null ? 'n/a' : String(info.deviceMemoryGB));
  gHost.set('dpr', (window.devicePixelRatio || 1).toFixed(2));
  gHost.set('gl', info.glVersion.replace('WebGL ', 'v').slice(0, 18));
  gHost.set('draws', String(renderer.drawCalls));

  budget.draw();

  const samples: HillSample[] = [];
  const m = sim.flow.mesh;
  for (let i = 0; i <= m.nx; i++) {
    if (!sim.flow.ifActive[i]) continue;
    samples.push({
      x: m.X[2 * m.topNodes[i]] * 1000,
      p: sim.flow.ifPressure[i] / 1e6,
      tau: sim.flow.ifShear[i] / 1e6,
    });
  }
  samples.sort((p, q) => p.x - q.x);
  const md = mill.diag;
  millLine.draw(millViews());
  refreshStandGrid();
  const w = unitWord();
  // Line-level results belong on the line, not in a panel about one stand.
  // Power sums along the chain - it is what the whole mill draws - while a
  // load does not, so the heaviest stand is the load figure that means
  // something for the line. Both are the real-machine values, width scaled.
  //
  // In reverse the passes happen one after another, so there is no instant at
  // which the line draws their sum; the numbers are per pass and the peak is
  // still the one that sizes the mill.
  const bw = view.stripWidth;
  let wSum = 0, pPeak = 0;
  for (let k = 0; k < mill.count; k++) {
    const dk = mill.stands[k].diag;
    wSum += Math.abs(dk.power) * bw * 2;
    pPeak = Math.max(pPeak, (dk.rollForce * bw) / TONF);
  }
  const totals = view.lineMode === 'reverse'
    ? ` ／ 最大荷重 ${pPeak.toFixed(0)} tonf ／ 最大動力 ${(wSum / 1000).toFixed(0)} kW`
    : ` ／ 最大荷重 ${pPeak.toFixed(0)} tonf ／ 総動力 ${(wSum / 1000).toFixed(0)} kW`;
  millSub.textContent = mill.count > 1
    ? `${mill.count} ${w} ／ 合計圧下率 ${(md.totalReduction * 100).toFixed(2)}%`
      + ` ／ 出側 ${(md.h1[mill.count - 1] * 1000).toFixed(4)} mm`
      + totals
      // Consecutive passes do not share a flow, so there is nothing to be off by.
      + (Number.isFinite(md.flowError)
        ? ` ／ 流量ずれ ${(md.flowError * 100).toFixed(2)}%` : '')
      + ` ／ ${md.settled ? `全${w}収束` : '調整中'}`
    : `単スタンド${totals}`
      + ` ／ 「ライン構成」で${view.lineMode === 'reverse' ? 'パス' : 'スタンド'}数を増やせる`;

  agcScatter.draw(agcTrailSet());
  hill.draw(samples, {
    neutralX: d.neutralFound ? d.neutralX * 1000 : null,
    flowStress: slab.kf / 1e6,
    slabMean: slab.meanPressure / 1e6,
    arcIn: d.arcIn * 1000,
    arcOut: d.arcOut * 1000,
  });
}

requestAnimationFrame(frame);
