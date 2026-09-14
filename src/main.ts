import './style.css';
import { TENSION_MODEL_LABEL, type TensionModel } from './sim/tension';
import {
  RollingSim, fieldUnit, planeStrain, AGC_METHODS, setSlabHook,
  type RollingParams, type FieldKind, type AgcMode, type AgcMethod, type LoadModel, type SlabTheory,
  type FlatteningModel,
} from './sim/solver';
import { Mill, MAX_STANDS, type StandSetup, type LineMode } from './sim/mill';
import { stoneMinThickness } from './sim/stone';
import {
  muFromLoad, slabLoad, exitStrain, slabKfProfile, slabPressureProfile, MU_MIN, MU_MAX, SLAB_THEORY_LABEL, FLATTENING_LABEL,
  type SlabCase, type MuInverseResult,
} from './sim/muinv';

// The solver reports the slab load when asked to, but does not import the
// slab model (that file imports the solver); it is wired here instead.
setSlabHook(slabLoad);
import { MillLineView, type StandView } from './ui/millview';
import { Renderer, type Camera, type RenderOptions } from './gfx/renderer';
import { COLORMAP_NAMES, rampGradient } from './gfx/colormap';
import {
  FrictionHillChart, TrackChart, AgcScatterChart,
  type HillSample, type AgcSample, type AgcTargets, type AgcTrail,
} from './ui/charts';
import {
  el, section, slider, select, toggle, buttonRow, numField,
  type NumFieldHandle,
} from './ui/controls';
import { probe, heap, bytes, type SysInfo } from './ui/sysinfo';
import { installLayout, type LayoutHandle, type Theme, currentTheme } from './ui/layout';
import * as settings from './ui/settings';
import { installView3D, type View3DHandle } from './ui3d/view3d';
import type { MillType } from './sim3d/stack';
import { parseQuery, startIn3d, gaugeSchedule } from './app/query';
import { Tracers, surfaceAt as surfaceAtOf } from './app/tracers';
import { installLab } from './app/lab';
import { buildRightPanel } from './app/right-panel';
import {
  SHALLOW_BITE_DRAFT, massTone, TONF, MPM, PRESETS, MESH_LEVELS, FIELDS, FIELD_LABEL,
  STRIP_ONLY, ROLL_ONLY, SIGNED_FIELDS, OFFSET_FIELDS, FIELD_RAMP, defaultParams, defaultView,
  agcTargetPerWidth as agcTargetPerWidthOf, millModulusPerWidth as millModulusPerWidthOf,
  omegaFromMpm as omegaFromMpmOf, lineSpeedFromMpm as lineSpeedFromMpmOf,
  type Preset, type MeshLevel,
} from './app/defaults';

/* ── state ───────────────────────────────────────────────────────────────── */
// The constants, tables (presets, mesh levels, fields) and the default state
// live in app/defaults; these are the one live copy of each.

const params: RollingParams = defaultParams();
const view = defaultView();

// Dial conversions on the live state (the formulas are in app/defaults).
function agcTargetPerWidth(): number { return agcTargetPerWidthOf(view); }
function millModulusPerWidth(): number { return millModulusPerWidthOf(view); }
function omegaFromMpm(): number { return omegaFromMpmOf(view, params.R); }
function lineSpeedFromMpm(): number { return lineSpeedFromMpmOf(view); }

params.agcTargetForce = agcTargetPerWidth();

/* ── query string overrides ──────────────────────────────────────────────── */
// Read here, written into the state further down by `applyQuery` - after a
// settings file has been restored, so the URL wins over the file.
const MILL_TYPES = ['2hi', '4hi', '6hi', '12hi', '20hi'] as const;
const Q = parseQuery(location.search, {
  fields: FIELDS.map((f) => f.value),
  colormaps: COLORMAP_NAMES,
  meshes: Object.keys(MESH_LEVELS),
  mills: MILL_TYPES,
}, MAX_STANDS);
const DEBUG_TITLE = Q.debug;

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
  targetForce: agcTargetPerWidth(),
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
 * Before the query string is applied (`applyQuery`, just below), so that a URL
 * - something the operator typed just now - wins over a file loaded a moment
 * ago.
 */
const restored = settings.applyPending(
  params as unknown as Record<string, unknown>,
  view as unknown as Record<string, unknown>,
  standSetups as unknown as Record<string, unknown>[]);
if (restored.applied) {
  // Derived from the width and the dials, which may have just moved underneath
  // them. The load target is re-derived at boot, from the stand on screen.
  params.millModulus = millModulusPerWidth();
  params.omega = omegaFromMpm();
  params.lineSpeed = lineSpeedFromMpm();
}

/**
 * Write the query string into the state. Only what the URL names is touched;
 * the rest of a restored file (or the defaults) stands.
 *
 * The per-stand parts go into `standSetups` as well as `params`: the setups
 * were seeded from `params` above, and it is the setups the mill is built
 * from. Writing `params` alone is how `?h1=` came to be read by nothing.
 */
function applyQuery(): void {
  if (Q.nowire) view.showWire = false;
  if (Q.notrace) view.showTracers = false;
  if (Q.nomirror) view.extent = 'half';
  if (Q.nosolve) view.running = false;
  if (Q.nogrid) view.showGrid = false;
  if (Q.field) {
    view.field = Q.field as FieldKind;
    const want = FIELD_RAMP[view.field];
    if (want) view.colormap = want;
  }
  if (Q.cmap) view.colormap = Q.cmap;
  // Mesh preset by name. Documented as a measurement parameter and read by
  // nobody for a while - every "mesh sweep" run through it had silently used
  // the default.
  if (Q.mesh) {
    const level = Q.mesh as MeshLevel;
    view.meshLevel = level;
    const L = MESH_LEVELS[level];
    params.stripNx = L.nx; params.stripNy = L.ny; params.rollNt = L.nt; params.rollNr = L.nr;
  }
  // Gap control, so a measurement run can start with the loop already closed.
  const agc = Q.agc;
  if (agc) {
    params.agcMode = agc;
    for (const c of standSetups) c.agcMode = agc;
  }
  // Interstand tension model and its controller, so a measurement run can
  // start with the line already carrying its own tension.
  if (Q.tension) params.tensionModel = Q.tension;
  if (Q.tctl !== undefined) params.tensionControl = Q.tctl;
  if (Q.tscale !== undefined) params.tensionTimeScale = Q.tscale;
  // The first stand's exit gauge, so a measurement run can start on a
  // setpoint; the stands after it keep taking their reduction from it.
  if (Q.h1 !== undefined) {
    params.agcTargetGauge = Q.h1;
    const g = gaugeSchedule(Q.h1, standSetups.map((c) => c.reduction));
    standSetups.forEach((c, k) => { c.targetGauge = g[k]; });
  }
  if (Q.mode) view.lineMode = Q.mode;
  // Load model, so a measurement run can start on the slab estimate.
  if (Q.loadmodel) params.loadModel = Q.loadmodel;
  if (Q.slab) params.slabTheory = Q.slab;
  if (Q.flat) params.flattening = Q.flat;
  if (Q.load !== undefined) {
    view.agcTargetTonf = Q.load;
    params.agcTargetForce = agcTargetPerWidth();
    for (const c of standSetups) c.targetForce = params.agcTargetForce;
  }
}
applyQuery();

/** What one element of the chain is called, in words and as a caption. */
const unitWord = () => (view.lineMode === 'reverse' ? 'パス' : 'スタンド');
const standTag = (k: number) => (view.lineMode === 'reverse' ? `P${k + 1}` : `#${k + 1}`);
let standCount = Q.stands
  ?? (restored.standCount !== undefined ? Math.min(MAX_STANDS, restored.standCount) : 1);
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
  // A restored file brings the stand it was saved on. Clamped, because the
  // URL may have asked for fewer stands than the file had.
  view.stand = Math.max(0, Math.min(standCount - 1, Math.round(view.stand) || 0));
  sim = mill.stands[view.stand];
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
if (restored.applied) {
  // The load dial shows the stand on screen, as `syncStandDials` leaves it on
  // every selection. A file does not have to agree - one an earlier version
  // saved straight after boot carries a dial of 800 tonf over stands at 1040 -
  // and the mill was just built from the stands.
  view.agcTargetTonf = (standSetups[view.stand].targetForce * view.stripWidth) / TONF;
  params.agcTargetForce = agcTargetPerWidth();
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
// The class and the mesh lookups live in app/tracers.

/** Strip surface height at x on the stand on screen. */
function surfaceAt(x: number): number { return surfaceAtOf(sim, x); }

const tracers = new Tracers(() => sim);

/* ── UI: left panel ──────────────────────────────────────────────────────── */

const left = document.getElementById('left')!;
let rebuildTimer = 0;
/** a line rebuild is waiting out its debounce; the line is not solved meanwhile (see `frameBody`) */
let rebuildPending = false;
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
    // Sized to the mill as it is now, not to `standCount`. The stand count can
    // have been lowered inside this debounce with the line's own rebuild still
    // pending (both wait 160 ms, and this one was started first), and then the
    // mill still has stands the active setups no longer cover - reading
    // `setups[k]` for one of them threw. A stand that is leaving the line is
    // not rebuilt: the pending line rebuild drops it anyway.
    const setups = standSetups.slice(0, mill.count);
    for (const i of standRebuildQueue) {
      if (i >= standCount || i >= mill.count) continue;
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
  rebuildPending = true;
  rebuildTimer = window.setTimeout(() => {
    rebuildPending = false;
    mill.build(params, activeSetups());
    buildStandGrid();
    selectStand(view.stand);
    clearAgcTrail();
    // The traces were of a line that no longer exists.
    gaugeChart.reset();
    speedChart.reset();
    stripChart.reset();
    screwChart.reset();
    massChart.reset();
    tensionChart.reset();
    tracers.reset();
    fieldDirty = true;
    // The camera stays where the user put it. Rebuilding is not a reason to
    // throw away their framing - they are usually watching one detail while
    // sweeping a parameter, which is exactly when a refit is most annoying.
    // F, or the ⤢ button, refits on demand.
    refreshGeom();
    refreshMeshHint();
    syncWindowDials();
    // the stand count may just have changed, and with it whether there are gaps
    syncTensionUi();
  }, 160);
}

/**
 * Under 自動, show the window the solver actually fitted - and hold it in
 * `params`, so that turning 自動 off keeps this window rather than jumping to
 * whatever the dials were first built with. Done after every rebuild and once
 * at boot: before the first rebuild the dials used to read the literal
 * -40 / 25 mm and 0.900 while the stand ran on its fitted -29 / 15 mm.
 */
function syncWindowDials(): void {
  if (!params.autoFit) return;
  params.windowIn = sim.winIn;
  params.windowOut = sim.winOut;
  params.biteGrade = sim.biteGradeEff;
  sWinIn.set(sim.winIn); sWinOut.set(sim.winOut); sBite.set(sim.biteGradeEff);
  shownWindow = { sim, winIn: sim.winIn, winOut: sim.winOut, bite: sim.biteGradeEff };
}
/** the window `syncWindowDials` last showed, and whose */
let shownWindow: { sim: RollingSim | null; winIn: number; winOut: number; bite: number } =
  { sim: null, winIn: NaN, winOut: NaN, bite: NaN };
/**
 * Once a frame, and only writing when something moved: the solver widens a
 * window on its own when the bite outgrows it (`widenWindow`, no rebuild),
 * and the stand on screen can change to one with a different window. Left to
 * rebuilds alone the dials kept the pre-widening window, and turning 自動 off
 * then rebuilt the stand into the window its bite had already outgrown.
 */
function followWindowDials(): void {
  if (shownWindow.sim !== sim || shownWindow.winIn !== sim.winIn
    || shownWindow.winOut !== sim.winOut || shownWindow.bite !== sim.biteGradeEff) syncWindowDials();
}

const millLine = new MillLineView(
  document.getElementById('millcanvas') as HTMLCanvasElement,
  (i) => selectStand(i));
millLine.setSelected(view.stand);
const millSub = document.getElementById('millline-sub') as HTMLElement;

/** One frame's worth of the whole line, in the units the line view draws in. */
/** how long the mill line says 再計算中 after a restart, so it is seen at all */
const RECALC_BADGE_MS = 4000;
/** the restart count last announced per stand, so each restart is announced once */
const restartsSeen: number[] = [];
const giveUpSeen: boolean[] = [];
/**
 * Say so when a stand has just restarted after a NaN solve, or has stopped
 * trying. Once per event: the line is read every frame, the toast is not.
 */
function announceRestarts(): void {
  activeStands().forEach((st, k) => {
    if ((restartsSeen[k] ?? 0) !== st.restarts) {
      restartsSeen[k] = st.restarts;
      if (st.restarts > 0) {
        toast(`${standTag(k)}: 圧下率が NaN（解が発散）— スタンドを初期状態から再計算します（${st.restarts} 回目）`);
      }
    }
    if ((giveUpSeen[k] ?? false) !== st.divergedGiveUp) {
      giveUpSeen[k] = st.divergedGiveUp;
      if (st.divergedGiveUp) {
        toast(`${standTag(k)}: ${st.restarts} 回再計算しても発散 — 自動再計算を止めました。`
          + 'メッシュ品質・圧下量・摩擦係数・張力を見直す（条件を変えると再開）', true);
      }
    }
  });
}

function millViews(): StandView[] {
  const out: StandView[] = [];
  const b = view.stripWidth;
  const md = mill.diag;
  const tensionOn = md.tensionModel !== 'off';
  for (let k = 0; k < mill.count; k++) {
    const st = mill.stands[k], d = st.diag;
    const p = st.params;
    const hIn = p.h0;
    const c = standSetups[k];
    const slabTop = d.loadModel === 'slab' && Number.isFinite(d.kfSlab) && d.kfSlab > 0;
    // Stone's limit on the theory's own kf: C mu R (kf - sigma_mean)/0.64761
    const stoneSlab = slabTop
      ? stoneMinThickness(p.Eroll, p.nuRoll, p.mu, p.R,
        d.kfSlab - (getBackTension(k) + c.frontTension) / 2)
      : d.stoneHMin;
    out.push({
      hIn: hIn * 1000,
      hOut: (d.exitThickness > 0 ? d.exitThickness : hIn) * 1000,
      // The exit gauge this stand is being asked for, by whichever number the
      // mode reads: the absolute target under 出側板厚一定, the reduction
      // converted to a gauge under 圧下率一定 (and with the loop off, where the
      // reduction is where the screws are parked), and nothing under 荷重一定,
      // where the gauge is an outcome and drawing a target for it would be a
      // number the stand is not aiming at.
      hOutTarget: c.agcMode === 'gauge' ? c.targetGauge * 1000
        : c.agcMode === 'force' ? NaN
          : hIn * (1 - c.reduction) * 1000,
      reduction: hIn > 0 ? Math.max(0, 1 - d.exitThickness / hIn) : 0,
      reductionTarget: c.reduction,
      load: (d.rollForce * b) / TONF,
      target: p.agcMode === 'force' ? (p.agcTargetForce * b) / TONF : 0,
      // Both ends of the pull as the stand sees them. The back tension is read
      // through `getBackTension` because on a tandem line it is the stand in
      // front's exit pull, not a value this row owns.
      backTension: getBackTension(k) / 1e6,
      frontTension: c.frontTension / 1e6,
      // As carried, from the gap model: the front is gap k, the back is gap
      // k-1. The line's two ends are coilers and keep their inputs.
      backTensionActual: tensionOn
        ? (k === 0 ? c.backTension : (md.tensionActual[k - 1] * md.h1[k - 1]) / hIn) / 1e6 : NaN,
      frontTensionActual: tensionOn
        ? (k === mill.count - 1 ? c.frontTension : md.tensionActual[k]) / 1e6 : NaN,
      tensionHot: tensionOn && [k - 1, k].some((j) => j >= 0 && j < md.tensionActual.length
        && (Math.abs(md.tensionActual[j] - md.tensionRigid[j]) > 1e-3 * Math.max(md.tensionActual[j], 5e6)
          || Math.abs(md.tensionError[j]) > 1e-3)),
      // Plane-strain kf, which is what a rolling load formula uses. The solve
      // carries the uniaxial flow stress, so those convert by 2/sqrt(3).
      //
      // Entry is the law at the condition the strip arrives in, which on a
      // tandem line is the stand upstream's exit - so this stand's `kf 入`
      // reads as the previous stand's `kf 出`, which is what the metal is
      // actually doing.
      kfEntry: planeStrain(p, d.entryStrain, d.entryTemp) / 1e6,
      // Under the slab load the block reads what the theory computed: its
      // strain-averaged kf, its arc, its forward slip and its Stone limit,
      // with the load, torque, power and R' already the theory's. The exit
      // gauge and the screw stay the FEM's - the theory has no gauge of its
      // own, it is handed the FEM's.
      kfMean: (slabTop ? d.kfSlab : d.meanPlaneStrainStress) / 1e6,
      kfExit: ((2 / Math.sqrt(3)) * d.exitFlowStress) / 1e6,
      hitchR: d.hitchcockR * 1000,
      hitchRatio: p.R > 0 ? d.hitchcockR / p.R : 1,
      forwardSlip: (slabTop ? d.forwardSlipSlab : d.forwardSlip) * 100,
      forwardSlipFem: slabTop ? d.forwardSlip * 100 : NaN,
      agcIters: d.agcIterations,
      // Width scaled and doubled: the solve is per unit width and turns one
      // barrel, a drive turns two across the whole strip.
      torque: (Math.abs(d.torque) * b * 2) / 1000,
      power: (d.power * b * 2) / 1000,
      arc: (slabTop ? d.arcLengthSlab : d.arcLength) * 1000,
      biteLimit: d.biteLimitH1 * 1000,
      stoneLimit: (slabTop ? stoneSlab : d.stoneHMin) * 1000,
      screw: st.screwPosition * 1000,
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
      // `gaugeIdle` live, not `d.agcIdle`.
      //
      // The diagnostics are only written by a solve, and a solve only happens
      // while the line is running - but the target that decides this is
      // editable whether it is running or not. Paused, the stand table would
      // take a new target, move the screws for it, and go on showing the
      // verdict from before the edit. The idle test needs no solve: it is the
      // setpoint against the entry gauge and the spring, both of which are
      // current. The three below do need one, and stay as they are.
      state: st.divergedGiveUp ? 'diverged'
        : performance.now() - st.restartAt < RECALC_BADGE_MS ? 'recalc'
          : p.agcMode === 'off' ? 'off'
            : st.gaugeIdle ? 'idle'
              : d.agcSaturated ? 'sat'
                : d.agcStalled ? 'stall'
                  : d.agcSettled ? 'lock' : 'work',
      restarts: st.restarts,
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
  tenNow: HTMLElement;
  vrNow: HTMLElement;
  vinNow: HTMLElement;
  voutNow: HTMLElement;
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
    value: standSetups[k].reduction * 100, min: 2, max: 90, step: 0.5, digits: 1,
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
  const tenNow = mk(() => el('div', 'sg-now', '—'));
  const vrNow = mk(() => el('div', 'sg-now', '—'));
  const vinNow = mk(() => el('div', 'sg-now', '—'));
  const voutNow = mk(() => el('div', 'sg-now', '—'));
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
  row('　　　実績', tenNow, 'MPa');
  row('摩擦係数 μ', mus.map((x) => x.root), '');
  row('ロール半径 R', rads.map((x) => x.root), 'mm');
  // Outcomes, not inputs: the one speed the line is given is in the left
  // panel, and these are what the cone, the slip and the tension trims made
  // of it at each stand.
  row('ロール周速 ωR', vrNow, 'm/min');
  row('板速度 入側 v₀', vinNow, 'm/min');
  row('　　　出側 v₁', voutNow, 'm/min');
  row('', resets, '');

  for (let k = 0; k < n; k++) {
    standCells.push({
      head: heads[k], redNow: redNow[k], gaugeNow: gaugeNow[k], loadNow: loadNow[k],
      mode: modes[k],
      red: reds[k], gauge: gauges[k], load: loads[k], backT: backs[k], ten: tens[k],
      tenNow: tenNow[k], vrNow: vrNow[k], vinNow: vinNow[k], voutNow: voutNow[k],
      mu: mus[k], rad: rads[k],
    });
  }
  // The table has just been rebuilt from scratch, so every red cell went with
  // it - and any stand the rebuild dropped has no cell to come back to.
  for (const k of [...muInv.keys()]) if (k >= n) muInv.delete(k);
  paintMuInverse();
  // Locks from the first paint, not from the first stats tick a tenth of a
  // second later: a cell that is editable for six frames and then greys out
  // is a flicker, and one that takes a keystroke in those frames is a bug.
  standCells.forEach((c, k) => paintTargetLock(c, standSetups[k].agcMode));
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
    const mt = massTone(d.massBalance);
    c.redNow.title = mt === 'ok' ? ''
      : `質量収支 v₀h₀/v₁h₁ = ${d.massBalance.toFixed(4)}（${(100 * (d.massBalance - 1)).toFixed(1)}%）。`
        + (mt === 'bad' ? '体積が保存していない — この段の荷重・圧下率は答えではない。'
          : '通常の 1.5〜2.3% を超えている。')
        + '圧下を軽くするか、メッシュ品質を上げる';
    // Under absolute-gauge or load control the reduction is an outcome, not a
    // target, so it is reported without a verdict.
    const rHeld = st.params.agcMode === 'off' || st.params.agcMode === 'ratio';
    // A broken mass balance outranks the loop's own verdict on the cell: a
    // reduction the loop calls 'on target' is not on anything if the volume
    // that produced it is not conserved.
    c.redNow.className = 'sg-now ' + (mt !== 'ok' ? mt
      : !rHeld ? ''
        : Math.abs(r - want) < 0.05 ? 'ok'
          : Math.abs(r - want) < 0.5 ? 'warn' : 'bad');
    c.loadNow.textContent = Number.isFinite(load) ? load.toFixed(1) : '—';
    // The front tension the gap after this stand is actually carrying. The
    // last stand's front is the coiler, which the model does not move, and
    // with the model off the input is the whole story - both read '—'.
    const md = mill.diag;
    const vr = (md.omega[k] ?? st.params.omega) * st.params.R * MPM;
    c.vrNow.textContent = Number.isFinite(vr) ? vr.toFixed(1) : '—';
    c.vinNow.textContent = d.entrySpeed > 0 ? (d.entrySpeed * MPM).toFixed(1) : '—';
    c.voutNow.textContent = d.exitSpeed > 0 ? (d.exitSpeed * MPM).toFixed(1) : '—';
    const ta = md.tensionModel !== 'off' ? md.tensionActual[k] : NaN;
    const tt = md.tensionTarget[k];
    c.tenNow.textContent = Number.isFinite(ta) ? (ta / 1e6).toFixed(1) : '—';
    const tErr = Number.isFinite(ta) && tt > 0 ? (ta - tt) / tt : 0;
    c.tenNow.classList.toggle('off-target', Number.isFinite(ta) && Math.abs(tErr) > 0.02);
    c.tenNow.title = Number.isFinite(ta)
      ? `目標 ${(tt / 1e6).toFixed(1)} MPa に対し ${(100 * tErr).toFixed(2)}%`
        + (md.tensionClamped[k] === -1 ? '。張力抜け（0 で頭打ち）'
          : md.tensionClamped[k] === 1 ? '。降伏の 90% で頭打ち' : '')
      : '';
    const tgt = (standSetups[k].targetForce * b) / TONF;
    // A slab load the theory could not solve is flagged whatever the mode,
    // and the cell says why.
    const slabNote = d.loadModel === 'slab' ? slabWhy(st) : '';
    c.loadNow.title = slabNote ? `⚠ スラブ法が計算不能 — ${slabNote}` : '';
    c.loadNow.className = 'sg-now ' + (slabNote ? 'bad' : st.params.agcMode !== 'force' ? ''
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
    // Why the red, when it is red for a reason the stand cannot fix.
    //
    // A target under the screw rail leaves this cell permanently off target
    // with nothing on the row to say so - the explanation lives in the AGC
    // panel, which is one stand's worth and only if that stand is selected.
    // On a line being dialled in, that is the number people stare at while
    // concluding the target "is not being used".
    let why = '';
    if ((st.params.agcMode === 'gauge' || st.params.agcMode === 'ratio') && !d.agcSettled && d.agcStalled
      && (st.params.h0 - st.agcSetpoint) / st.params.h0 < SHALLOW_BITE_DRAFT && !st.gaugeIdle) {
      why = `圧下量が小さすぎて接触弧が板メッシュ ${d.contactNodes} 列にしか乗らず、解けない。`
        + 'メッシュ品質を上げるか圧下量を増やす（既定メッシュで 3% は整定、1% 以下は整定しない）';
    } else if (st.params.agcMode === 'gauge') {
      if (st.gaugeIdle) {
        why = `目標 ${hTgt.toFixed(4)} mm が入側板厚 ${(st.gaugeFloor * 1000).toFixed(4)} mm`
          + `（${k > 0 ? '前スタンドの出側の現在値' : 'ライン入側'}）以上。`
          + '圧下にならないのでスタンドを止めている';
      } else if (d.agcSaturated) {
        why = `目標 ${hTgt.toFixed(4)} mm に対しスクリューが端に張り付いている。`
          + `バレル間隔の下限が ${(params.sepFloorFrac * 100).toFixed(0)}% × 入側`
          + ` ${(st.params.h0 * 1000).toFixed(4)} mm ＝ ${(d.gapLimitLo * 1000).toFixed(4)} mm なので、`
          + `この段はこれ以上薄くできない（実測 ${h1.toFixed(4)} mm）`;
      }
    }
    if (c.gaugeNow.title !== why) c.gaugeNow.title = why;
    c.red.set(standSetups[k].reduction * 100);
    c.gauge.set(standSetups[k].targetGauge * 1000);
    c.load.set((standSetups[k].targetForce * b) / TONF);
    c.backT.set(getBackTension(k) / 1e6);
    c.ten.set(standSetups[k].frontTension / 1e6);
    c.mu.set(standSetups[k].mu);
    c.rad.set(standSetups[k].R * 1000);
    if (document.activeElement !== c.mode) c.mode.value = standSetups[k].agcMode;
    paintTargetLock(c, standSetups[k].agcMode);
  }
  paintMuInverse();
}

/**
 * Grey out the target the current mode is not driving to.
 *
 * Under 圧下率一定 the exit gauge is an outcome, and under 出側板厚一定 the
 * reduction is. Leaving both editable meant a number could be typed into a
 * cell that nothing reads, sit there looking like a setpoint, and then take
 * effect at some later mode switch nobody connected to it. The cell stays
 * visible - the value is still what the *other* mode would use, and it is
 * still shown live in the row below - it just cannot be typed into.
 *
 * Every loop locks the two targets it is not holding. With the loop off the
 * reduction and the load lock too, and only the gauge target - the number
 * 出側板厚一定 adopts on entry - stays open.
 */
function paintTargetLock(c: StandRowCells, mode: AgcMode): void {
  const red = c.red.root as HTMLInputElement;
  const gauge = c.gauge.root as HTMLInputElement;
  const load = c.load.root as HTMLInputElement;
  // Each loop owns one target; the other two are outcomes and locked. With
  // the loop off, the reduction and the load lock as well - nothing is
  // holding either - and only the gauge target stays open, as the number
  // 出側板厚一定 adopts on entry. Note what that costs: with the loop off the
  // screws park at h0(1-r), so the parked position can only be changed by
  // going through 圧下率一定.
  const lockRed = mode !== 'ratio';
  const lockGauge = mode === 'ratio' || mode === 'force';
  // The load cell is also what μ逆算 reads as the measured load, so on any
  // stand not under load control that back-calculation has to be fed by
  // switching the mode first - said in the tooltip rather than left to be
  // discovered.
  const lockLoad = mode !== 'force';
  if (red.disabled !== lockRed) red.disabled = lockRed;
  if (gauge.disabled !== lockGauge) gauge.disabled = lockGauge;
  if (load.disabled !== lockLoad) load.disabled = lockLoad;
  const held = mode === 'gauge' ? '出側板厚一定' : mode === 'ratio' ? '圧下率一定'
    : mode === 'force' ? '荷重一定' : '制御なし';
  const redWhy = lockRed
    ? `${held}の間は圧下率は${mode === 'off' ? '目標ではない（スクリューはこの値で停止）' : '結果'}。`
      + '目標にするなら制御モードを「圧下率一定」に' : '';
  const gaugeWhy = lockGauge
    ? `${held}の間は出側板厚は結果。目標にするなら制御モードを「出側板厚一定」に` : '';
  const loadWhy = lockLoad
    ? `${held}の間は圧延荷重は${mode === 'off' ? '目標ではない' : '結果'}。`
      + '目標にするなら制御モードを「荷重一定」に。'
      + 'μ逆算に実測荷重を入れる場合も「荷重一定」にする' : '';
  if (red.title !== redWhy) red.title = redWhy;
  if (gauge.title !== gaugeWhy) gauge.title = gaugeWhy;
  if (load.title !== loadWhy) load.title = loadWhy;
}

const sLine = section('ライン構成', { remember: false, open: false,
  hint: 'ラインの形と段数。タンデムは複数スタンドが同じ板を同時に噛むので、板厚・質量流量・張力がスタンド間で結合する。リバースは 1 スタンドを板が往復するので、'
      + 'パス間で引き継ぐのは板厚だけ。各スタンド（パス）の圧下率・目標・張力・μ・ロール半径は画面上部の表で入力する。',
});
const sMode = select<LineMode>('ライン形式', [
  { value: 'tandem', text: 'タンデム — 同時に噛む複数スタンド' },
  { value: 'reverse', text: 'リバース — 1 スタンドを往復、1 行 = 1 パス' },
], view.lineMode, (v) => setLineMode(v),
  'タンデム: 全スタンドが同時に圧延。前段の出側板厚が次段の入側になり、質量流量 v·h が全段で等しく、前段の前方張力＝次段の後方張力。'
      + 'リバース: 1 スタンドで往復する可逆圧延機。表の 1 行が 1 パスで、引き継ぐのは板厚だけ。速度コーンは無く、張力は両端のコイラで毎パス独立に張る。');
const sCount = select<string>('スタンド数', Array.from({ length: MAX_STANDS },
  (_, i) => ({ value: String(i + 1), text: `${i + 1} スタンド` })), String(standCount), (v) => {
  standCount = Number(v);
  if (view.stand >= standCount) view.stand = standCount - 1;
  scheduleRebuild();
},
  'タンデムのスタンド数、リバースのパス数（1〜8）。増やすと整定が延びる — 各スタンドは自分の入側板厚が止まるまでスクリューを動かさないので、'
      + '待ちが下流へ順に伝わる。8 段で 70 s 程度。');
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
  syncRollSpeed();
},
  'タンデムのみ。ON では「圧延条件」の速度がライン出側の板速度になり、全スタンドのロール周速を'
      + ' 質量流量 q = v_out·h₁(最終) と Bland–Ford 先進率から自動で決める（実機の速度コーン）。'
      + '各スタンドの送り速度は自走で決まるので、残った不整合は「流量ずれ」に出る（実機ではスタンド間張力が吸収する分。張力モデル ON ならそれが実績張力になる）。'
      + 'OFF なら全段が「圧延条件」のロール周速で回る。');
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
    + `画面上部の${w}表で編集する。この左パネルはライン共通の設定 — 板寸法・材料・`
    + '圧延条件・制御・ミル弾性・メッシュ・数値解法 — で、上から順に'
    + ' ライン → 板 → 材料 → スタンド の並び。'
    + `詳細表示する${w}は、ミルライン図か表の見出しをクリックして選ぶ。`;
  speedHint.textContent = rev
    ? 'リバースでは無効。パスは同時に走らないので保つべき速度コーンがなく、'
      + '各パスは「圧延条件」のロール周速でそのまま回る。'
    : 'ON のとき「圧延条件」の速度はライン出側の板速度で、全スタンドのロール周速を質量流量 q = v_out·h₁(最終) が'
      + '一定になるように自動設定する（先進率込み）。各スタンドは自分の送り速度を自走で決めるので、残った不整合は「流量ずれ」として表示する'
      + '（実機ではスタンド間張力が吸収する分）。';
  syncRollSpeed();
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
  syncTensionUi();
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
const sH0 = slider({
  label: 'ライン入側板厚 h₀', unit: 'mm', min: 0.00005, max: 0.05, log: true, value: params.h0,
  format: (v) => (v * 1000).toFixed(v < 0.001 ? 3 : 2),
  hint: 'ラインに入る板の厚さ [mm]。#1 の入側板厚で、2 行目以降の入側は前段の出側そのもの（入力ではなく結果、ミルライン図に出る）'
      + '。変えると板メッシュを作り直す。薄くするほど扁平の影響が相対的に大きくなり、0.3 mm 以下ではロール弾性連成と表層メッシュの設定が結果を左右する。',
  onInput: (v) => { params.h0 = v; mill.h0 = v; scheduleRebuild(); },
});
const geoHint = el('div', 'ctrl-hint');
const sWidth = slider({
  label: '板幅 b (ライン共通)', unit: 'mm', min: 0.05, max: 3.0, step: 0.01,
  value: view.stripWidth,
  format: (v) => (v * 1000).toFixed(0),
  hint: '板の幅 [mm]。解析は平面ひずみ（幅方向のひずみ ε_zz = 0）で幅方向を離散化していないので、解そのものには効かない。'
      + '効くのは換算だけ: 単位幅あたりの荷重・トルク・動力に b を掛けて実機値 [tonf, kN·m, kW] にし、逆に「圧延荷重 目標 [tonf]」を b で割って単位幅の指令にする。'
      + 'したがって荷重一定制御とミル剛性（P/M）では b が結果に効く。板厚方向は対称面 y = 0 で半分だけ解き、全厚はミラー表示。',
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

// The strip itself: one gauge, one width, one material for the whole line, no
// matter how many stands it runs through. They live in the top-left panel,
// away from the per-stand dials, because there is nothing to select for them.
const sStrip = section('ライン共通 — 板寸法', { remember: false, open: false,
  hint: '板そのものを決める量。ラインに 1 枚しか通っていないので、スタンドを選ぶ余地がない。'
    + 'この下の「被圧延材」「加工発熱」も同じくライン共通。',
});
sStrip.body.append(sH0.root, sWidth.root);

sLine.body.append(sMode.root, modeHint, sCount.root, lineHint,
  tAutoSpeed.root, speedHint);

const sMat = section('被圧延材 (LMN 式)', { remember: false, open: false,
  hint: '変形抵抗 kf = L·(ε̄ + M)^N。L は係数 [MPa]、M は予ひずみ（ε̄ = 0 で kf を有限にする）、'
    + 'N は硬化指数。冷延材の実測 kf 曲線がこの 3 つで与えられることが多い。'
    + 'LMN が返すのは平面ひずみ変形抵抗で、解析が持つ単軸相当応力は σf = (√3/2)·kf。',
});
const sY0 = slider({
  label: '係数 L', unit: 'MPa', min: 50e6, max: 4000e6, log: true, value: params.lmnL,
  format: (v) => (v / 1e6).toFixed(0),
  hint: '変形抵抗の係数 [MPa]。平面ひずみ変形抵抗 kf = L·(ε̄ + M)^N のスケールで、ε̄ + M = 1 のときの kf。'
      + '荷重にほぼ比例して効く（荷重 ∝ kf × 接触弧長 × 摩擦丘係数）。冷延鋼板で 900〜1400 MPa、アルミで 200〜400 MPa 程度。'
      + '材料試験の kf–ε̄ 曲線に L, M, N の 3 つで当てる。',
  onInput: (v) => { params.lmnL = v; },
});
const sK = slider({
  label: '予ひずみ M', min: 0.0002, max: 0.5, log: true, value: params.lmnM,
  format: (v) => v.toFixed(4),
  hint: '硬化曲線のひずみオフセット（無次元）。kf = L·(ε̄ + M)^N なので、ε̄ = 0 でも kf(0) = L·M^N と有限になる（M = 0 だと未加工材の kf が 0 になり #1 の入口で解が壊れる）'
      + '。焼鈍材なら 0.005〜0.02。前工程で加工済みの材料は M を大きくするか、その分を入側ひずみとして見込む。',
  onInput: (v) => { params.lmnM = v; },
});
const sN = slider({
  label: '硬化指数 N', min: 0.01, max: 0.6, step: 0.005, value: params.lmnN,
  format: (v) => v.toFixed(2),
  hint: '加工硬化指数（無次元）。kf = L·(ε̄ + M)^N の指数で、ひずみとともに kf がどれだけ上がるか。鋼で 0.2〜0.3、'
      + 'アルミで 0.15〜0.25。大きいほど後段スタンドの kf が高くなり（前段の硬化を引き継ぐ）、荷重の段間配分が変わる。'
      + '解析が持つ単軸相当応力は σf = kf·√3/2。',
  onInput: (v) => { params.lmnN = v; },
});
const tElastic = toggle('入出側の弾性変形を考慮', params.elasticZones, (v) => {
  params.elasticZones = v; sEstrip.setEnabled(v); sNuStrip.setEnabled(v); sIncomp.setEnabled(!v);
},
  '接触弧の入口と出口に弾性域を置く。入口では板が塑性変形を始める前に弾性圧縮され、出口では除荷で弾性回復して板厚が数 µm 戻る（スプリングバック）'
      + '。ON で出側板厚がわずかに厚くなり、荷重は 1% 弱変わる。OFF は純粋な剛塑性で、教科書のスラブ法と比べるときはこちら。'
      + '右パネル「入出側 弾性域」に内訳が出る。');
const sEstrip = slider({
  label: '板 縦弾性係数 E', unit: 'GPa', min: 30e9, max: 400e9, step: 5e9, value: params.Estrip,
  format: (v) => (v / 1e9).toFixed(0),
  hint: '板のヤング率 [GPa]。「入出側の弾性変形」ON のときだけ使う。入口の弾性圧縮量 h₀·kf/E\' と出口の弾性回復量を決める（E\' = E/(1−ν²)'
      + ' は平面ひずみの有効弾性率）。鋼 210、アルミ 70、銅 120。',
  onInput: (v) => { params.Estrip = v; },
});
const sNuStrip = slider({
  label: '板 ポアソン比 ν', min: 0.20, max: 0.45, step: 0.005, value: params.nuStrip,
  format: (v) => v.toFixed(3),
  hint: '板のポアソン比（無次元）。「入出側の弾性変形」ON のときだけ使い、平面ひずみの有効弾性率 E\' = E/(1−ν²) と出口の弾性回復に入る。'
      + '金属はほぼ 0.3。',
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
const sHeat = section('加工発熱 (断熱)', { remember: false, open: false, hint: HEAT_ABOUT,
});
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
},
  'ON で塑性仕事による温度上昇 ΔT = β·σf·ε̄/(ρc) を各点で積算し、Johnson-Cook 型の熱軟化 kf ∝ 1 − T*^m で変形抵抗を下げる。'
      + 'OFF は等温（温度は入側温度で一様）。冷間圧延では ΔT が20〜60 °C 程度で荷重への影響は数%。温度場を見たいときや熱間で使う。');
const sTempIn = slider({
  label: '入側温度 T₀', unit: '°C', min: 0, max: 1300, step: 5, value: params.tempEntry,
  format: (v) => v.toFixed(0),
  hint: '板がラインに入る温度 [°C]。熱軟化の基準点でもあり、ここでの軟化率は定義上 0 — このパスが自分で出した熱のぶんだけが変形抵抗に効く。'
      + 'タンデムでは前段の出側温度が次段の入側になる（スタンド間の放熱は無視）。冷間 20、熱間 900〜1100。',
  onInput: (v) => { params.tempEntry = v; fieldDirty = true; },
});
const sBeta = slider({
  label: 'テイラー・クイニー係数 β', min: 0, max: 1.0, step: 0.01,
  value: params.taylorQuinney,
  format: (v) => v.toFixed(2),
  hint: '塑性仕事のうち熱になる割合（無次元）。残りは転位として組織に貯まる。金属の実測は 0.85〜0.95。0 にすると発熱なし（等温）'
      + '、1 で全量が熱という極端側も試せる。温度上昇に比例して効く。',
  onInput: (v) => { params.taylorQuinney = v; },
});
const sRho = slider({
  label: '密度 ρ', unit: 'kg/m³', min: 2000, max: 12000, step: 50, value: params.rhoStrip,
  format: (v) => v.toFixed(0),
  hint: '板の密度 [kg/m³]。比熱との積 ρc が熱容量で、同じ発熱量に対する温度上昇 ΔT = β·σf·ε̄/(ρc) を決める。'
      + '鋼 7850、アルミ 2700、銅 8960。',
  onInput: (v) => { params.rhoStrip = v; },
});
const sCp = slider({
  label: '比熱 c', unit: 'J/(kg·K)', min: 100, max: 1200, step: 5, value: params.cpStrip,
  format: (v) => v.toFixed(0),
  hint: '板の比熱 [J/(kg·K)]。温度上昇は ΔT = β·σf·ε̄/(ρc)。ρc が熱容量そのもので、小さいほど同じ仕事で温度が上がりやすい。'
      + '鋼 470、アルミ 900、銅 385。',
  onInput: (v) => { params.cpStrip = v; },
});
const sTmelt = slider({
  label: '融点 T_m', unit: '°C', min: 300, max: 2000, step: 10, value: params.tempMelt,
  format: (v) => v.toFixed(0),
  hint: '融点 [°C]。熱軟化の無次元温度 T* = (T − T₀)/(T_m − T₀) の分母で、融点で kf = 0 になるように軟化曲線を張る。'
      + '鋼 1500、アルミ 660、銅 1085。',
  onInput: (v) => { params.tempMelt = v; },
});
const sSoften = slider({
  label: '軟化指数 m', min: 0.2, max: 3.0, step: 0.05, value: params.softenExp,
  format: (v) => v.toFixed(2),
  hint: 'Johnson-Cook の熱項 kf ∝ 1 − T*^m の指数。T* = (T − T₀)/(T_m − T₀)。'
      + 'm = 1 で温度に比例して軟化、m < 1 だと低い温度上昇でも軟化が早く立ち上がる。鋼で 0.8〜1.1 程度。',
  onInput: (v) => { params.softenExp = v; },
});
heatDials.push(sTempIn, sBeta, sRho, sCp, sTmelt, sSoften);
sHeat.body.append(tHeat.root, sTempIn.root, sBeta.root, sRho.root,
  sCp.root, sTmelt.root, sSoften.root);
const heatOutHint = el('div', 'ctrl-hint');
sHeat.body.append(heatOutHint);
for (const dial of heatDials) dial.setEnabled(params.heatOn);

const sProc = section('圧延条件', { remember: false, open: false,
  hint: '選択中スタンドの運転条件。ロール周速と送り速度、およびそこから決まる幾何（h₁・接触弧長・噛み込み角）。摩擦係数 μ・張力・圧下率・ロール半径はスタンドごとの量なので上部の表で入力する。',
});
const sOmega = slider({
  label: 'ロール周速 v_R', unit: 'mpm', min: 1, max: 1500, log: true,
  value: view.rollSpeedMpm,
  format: (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1)),
  hint: 'ライン全体で指定する唯一の速度 [m/min]。タンデムで速度コーン自動 ON のときは**ライン出側の板速度**で、'
      + '各スタンドのロール周速は質量流量 q = v·h₁(最終) と Bland–Ford 先進率から計算される（表の「ロール周速」行、'
      + '「板速度」行が結果）。それ以外（リバース、コーン OFF）ではワークロール胴面の周速で、ω = v_R/R に換算する。'
      + '定常解では速度自体は荷重にほぼ効かず、効くのはひずみ速度（正則化の基準）と発熱の時間スケール、および動力 [kW] = トルク × ω。',
  onInput: (v) => { view.rollSpeedMpm = v; syncRollSpeed(); },
});
const omegaHint = el('div', 'ctrl-hint');

/** True while the dial is the line's exit strip speed rather than a roll speed. */
const speedDialIsExit = () => view.lineMode === 'tandem' && mill.autoSpeed;

/**
 * The dial is a line speed in m/min, the way a mill is actually run; the solver
 * turns the barrel at an angular speed. In tandem with the cone on it is the
 * strip speed leaving the line and every barrel speed is derived from it in
 * `Mill.advance`; otherwise roll radius is the only thing between the two, so
 * changing R holds the line speed and moves omega, not the reverse.
 */
function syncRollSpeed(): void {
  params.omega = omegaFromMpm();
  params.lineSpeed = lineSpeedFromMpm();
  const exit = speedDialIsExit();
  const lab = sOmega.root.querySelector('.ctrl-label');
  if (lab && lab.firstChild) lab.firstChild.nodeValue = exit ? 'ライン出側 板速度 v_out' : 'ロール周速 v_R';
  omegaHint.textContent = exit
    ? `最終${unitWord()}を出る板の速度 ${(params.lineSpeed).toFixed(4)} m/s。各${unitWord()}のロール周速は`
      + ' 質量流量 q = v_out·h₁(最終) を各段の目標板厚で割り、Bland–Ford 先進率 (1+f) で割った値'
      + '（上部の表「ロール周速」行）。板速度の入側・出側は FEM の実測（同「板速度」行）。'
    : `ロール半径 R = ${(params.R * 1000).toFixed(params.R < 0.05 ? 1 : 0)} mm で`
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
},
  'ON で入側の送り速度を「入側面の反力が 0 になる」ように自動で決める（実機の板は押されずにロールの摩擦だけで引き込まれる）'
      + '。OFF は下のスライダで送り速度を固定する — 反力が残り、先進率・中立点の位置が実機と合わなくなるので、通常は ON。'
      + 'ギャップ制御はこのループの静定を待つ（状態「内側ループ待ち」）。');
const sFeed = slider({
  label: '送り速度 v_in', unit: 'm/s', min: 0.001, max: 3, log: true,
  value: params.omega * params.R * (1 - params.reduction),
  format: (v) => v.toFixed(4),
  hint: '入側の板速度 [m/s]。「送り速度を自動」OFF のときだけ有効。質量流量 v_in·h₀ = v_out·h₁ とロール周速から、'
      + '後進率と中立点の位置が決まる。周速 × h₁/h₀ より速く入れると板がロールを追い越す（負の後進率）。',
  onInput: (v) => { params.feedSpeed = v; },
});
sFeed.setEnabled(false);
// The derived geometry of the selected stand (h1, contact arc, bite angle)
// used to be a section of its own with nothing in it but this one line.
sProc.body.append(geoHint, sOmega.root, omegaHint, procHint, tFeedAuto.root, sFeed.root);
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

const sAgc = section('自動制御 (AGC / 定圧延荷重)', { remember: false, open: false,
  hint: 'スクリュー（ロールギャップ）を測定値で閉ループ制御するときの設定。制御モードと目標はスタンドごとに上部の表で選ぶ。ここは全スタンド共通のループ設定 — 探索方式・ゲイン・不感帯・更新間隔・可動範囲。'
      + '「ミルスプリングを補正する」は制御が目標をどう解釈するか（実測板厚を合わせるか、指令として 1 回置くか）。',
});
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
  hint: '割線法・固定ゲインの歩幅係数（無次元）。同定した感度 d(測定値)/d(ギャップ) の逆数を掛けたニュートン歩幅に、この係数を掛けて動く。'
      + '1 で全歩幅、0.6 既定。上げると速いが行き過ぎて振動しやすく、下げると遅いが安定。区間法には効かない（区間の幅が歩幅を決める）'
      + '。',
  onInput: (v) => { params.agcGain = v; },
});
const tSpringComp = toggle('ミルスプリングを補正する', params.agcSpringComp, (v) => {
  params.agcSpringComp = v;
  // Every gauge-controlled stand re-aims: with the compensation just turned
  // off the screws go to the command itself, and with it turned back on the
  // loop resumes from the spring it has already measured.
  for (const st of mill.stands) {
    if (st.params.agcMode === 'ratio' || st.params.agcMode === 'gauge') {
      st.params.agcSpringComp = v;
      st.retarget();
    }
  }
  clearAgcTrail();
  syncSpringCompHint();
},
  '圧下率一定・出側板厚一定の目標の解釈。ON: 実測の出側板厚が目標になるまでスクリューを締め続ける（扁平＋弾性回復のぶん、'
      + 'S は指令より 100 µm ほど深くなる。整定 10〜20 s）。OFF: 目標をバレル間隔の指令として 1 回置くだけ。'
      + '出側は目標＋スプリングになり、その差が「偏差」に出る。荷重一定には無関係。ハウジング伸び（ミル剛性）は常にスクリュー位置側で差し引くので、'
      + 'OFF でも残るのは扁平＋弾性回復だけ。');
const springCompHint = el('div', 'ctrl-hint');
function syncSpringCompHint(): void {
  springCompHint.textContent = params.agcSpringComp
    ? 'ON: 圧下率一定・出側板厚一定は、実測の出側板厚が目標になるまでスクリューを締め続ける'
      + '（ロール扁平・ハウジング伸び・出側弾性回復のぶん、S は h₀(1−r) より下がる）。'
      + '内側ループの静定を待ちながら詰めるので、整定に 10〜20 s かかる。'
    : 'OFF: 目標をスクリュー位置そのものとして 1 回だけ置く（S = h₀(1−r) または目標板厚）。'
      + '出側板厚は S ＋ ミルスプリングになり、その差が「偏差」欄に出る。ループは回らない。'
      + '荷重一定には効かない。スプリング自体を無くしたいなら「ミル弾性」の'
      + 'ロール弾性連成・ミル剛性・「入出側の弾性変形」を切る。';
}
syncSpringCompHint();
const sAgcDb = slider({
  // Down to 1e-8: the old floor of 1e-5 was two orders above what the plant
  // can actually deliver, so the precision the loop is capable of could not be
  // asked for from the panel at all.
  label: '不感帯', unit: '%', min: 1e-8, max: 1e-2, log: true, value: params.agcDeadband,
  format: (v) => (v * 100).toExponential(1),
  hint: '偏差がこれ [%] を下回ったらスクリューを止める。板厚制御では h₀ 比、荷重制御では目標荷重比。ループは「初めてこの帯に入った瞬間」に止まるので、'
      + '残る誤差はこの帯の中のどこか — この値がそのまま結果の精度になる。既定 1e-6（1e-4 %）は 3 モードとも整定 1.5〜2 倍で到達する。'
      + '1e-7 も届くが1e-8 は壁（荷重制御が帯の 2 倍手前で止まる）。',
  onInput: (v) => { params.agcDeadband = v; },
});
const sAgcEvery = slider({
  label: 'スクリュー更新間隔', unit: 'frame', min: 1, max: 30, step: 1, value: params.agcEvery,
  format: (v) => v.toFixed(0),
  hint: 'スクリューを動かす間隔 [フレーム]。ロール扁平ループと自走速度ループが 1 手ごとに緩和する時間を与えるため、毎フレームは動かさない。'
      + '小さくすると速いが内側ループと競合してハンチングしやすい。既定 4。',
  onInput: (v) => { params.agcEvery = Math.round(v); },
});
const sFloor = slider({
  label: 'スクリュー下限 バレル間隔', unit: '% of h₀', min: 2, max: 50, step: 1,
  value: params.sepFloorFrac * 100,
  format: (v) => v.toFixed(0),
  hint: '負荷時のバレル間隔をこれ以上締めない下限 [h₀ 比 %]。既定 2%（＝圧下率 98% 相当）で、'
      + 'ソルバを生かすための安全側の壁。解の妥当性はこれで止めるのではなく「質量収支」の警告で見る。'
      + '実測: 2% まで下げても 86% 圧下で解は有限、質量収支 ±2.6% 以内。'
      + '目標がこれより薄いと「ギャップ端に張り付き」になる。',
  onInput: (v) => { params.sepFloorFrac = v / 100; syncFloorHint(); },
});
const floorHint = el('div', 'ctrl-hint');

/**
 * The floor is a validity limit, not a numerical one, so the hint has to carry
 * the number that actually degrades - otherwise lowering it looks free.
 */
function syncFloorHint(): void {
  const f = params.sepFloorFrac;
  floorHint.textContent =
    `バレル間隔をこれ以上締めない下限（既定 2% ＝ 圧下率 98% 相当）。ソルバを生かすための`
    + '安全側の壁で、解の妥当性は「質量収支」の警告で見る（右パネル「圧延諸元」・スタンド表・'
    + 'ミルライン図見出し）。実測では 86% 圧下まで質量収支 ±2.6% 以内に収まる。'
    + (f > 0.025 ? ` いまは ${(f * 100).toFixed(0)}%（圧下率 ${((1 - f) * 100).toFixed(0)}% で張り付く）。` : '');
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
  'ギャップの根を探す方法。既定の割線法は直前の 1 手から感度を同定して進むので手数が少ない。ニュートン法（差分）は毎回わざと揺さぶって傾きを測り直す。'
      + 'ゲージメータ解析式は傾きをミルの式から出す。区間法（二分・はさみうち・Illinois・Ridders・Brent）は解を区間で挟むので発散しないが手数が多い —応答が階段状（接触列の出入り）'
      + 'で割線法が暴れるときの保険。各方式の説明はセレクタ下の文。');

const sAgcStep = slider({
  label: '1 回の最大移動量', unit: '% of h₀', min: 0.001, max: 0.10, log: true,
  value: params.agcMaxStep,
  format: (v) => (v * 100).toFixed(2),
  hint: 'スクリューの 1 手の上限 [h₀ 比 %]。割線法・固定ゲインでは毎手の上限で、目標を大きく変えたときの行き過ぎを抑える（目標変更時は retarget が測定済みスプリングぶんを一発で引くので、'
      + 'ここはトリムの幅を決める）。区間法では「区間を挟むまでの初手の幅」として使い、挟んだあとは効かない。',
  onInput: (v) => { params.agcMaxStep = v; },
});
/* ── screwdown actuator ─────────────────────────────────────────────────── */
const screwDials: { setEnabled(on: boolean): void }[] = [];
const tScrewDyn = toggle('圧下装置の動特性（速度制限 ＋ 一次遅れ）', params.screwDyn, (v) => {
  params.screwDyn = v;
  for (const d of screwDials) d.setEnabled(v);
},
  'ON: 制御ループの 1 手は「指令」になり、実際のスクリューは速度上限と一次遅れで指令を追う（実機の圧下装置。tension-lab の図 5.15 の簡略版）。'
    + 'ハウジング伸び P/M はこれまでどおり読みから瞬時に引く（ゲージメータ補正。伸びをスクリューに払わせる版は発散した — solver.ts 参照）ので、'
    + '荷重が急変した瞬間の読みの跳びは残る。ループは到達（0.2 µm 以内）を待ってから次の手を打つので同定は乱れないが、手ごとの待ちが増えて収束は遅くなる。'
    + 'リセット直後 2 s（通板）は従来どおり瞬時に置く。OFF: 1 手が同じフレームで反映され、伸びは読みから瞬時に引く（階段状。docs/validation.md の収束時間はこちらで測った値）。');
const sScrewRate = slider({
  label: '圧下速度上限', unit: 'mm/s', min: 0.02, max: 5, log: true, value: params.screwRate * 1000,
  format: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)),
  hint: 'スクリューの最大移動速度。電動圧下は 0.1〜0.5 mm/s、油圧圧下は数 mm/s。既定 0.3 mm/s（1 手の上限 40 µm なら 0.13 s、目標変更の一発移動 数百 µm で 1〜2 s）。'
    + '読み S = 間隔 − P/M は間隔の移動に荷重変化分（1 + Q/M ≈ 3 倍）が乗るので、グラフ上は設定速度の数倍で動いて見える。',
  onInput: (v) => { params.screwRate = v / 1000; },
});
const sScrewTau = slider({
  label: '圧下の時定数', unit: 's', min: 0.02, max: 1, log: true, value: params.screwTau,
  format: (v) => v.toFixed(2),
  hint: '指令に対するスクリュー位置の一次遅れ。小さい移動は速度上限に当たらず、この時定数で滑らかに寄る。既定 0.2 s。',
  onInput: (v) => { params.screwTau = v; },
});
screwDials.push(sScrewRate, sScrewTau);
for (const d of screwDials) d.setEnabled(params.screwDyn);

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
  agcResetHint, tSpringComp.root, springCompHint, sAgcMethod.root, methodHint,
  sAgcGain.root, sAgcDb.root, sAgcEvery.root, sAgcStep.root,
  tScrewDyn.root, sScrewRate.root, sScrewTau.root,
  sFloor.root, floorHint);
syncMethodHint();

const sRoll = section('ミル弾性 (ロール扁平・ミルスプリング)', { remember: false, open: false,
  hint: '負荷でミルが変形する 3 つの効果: ロール表面の扁平（接触弧が伸び、荷重が上がる）、板の弾性回復（「被圧延材」の弾性変形）'
      + '、ハウジングと圧下ねじの伸び（ミル剛性）。この 3 つの合計が「出側板厚 − スクリュー位置」＝ミルスプリングで、板厚制御が払っている量。',
});
const sMillK = slider({
  label: 'ミル剛性 M', unit: 'MN/mm', min: 0.2, max: 30, log: true,
  value: view.millModulusMNmm,
  format: (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1)),
  hint: 'スタンド全体の剛性 [MN/mm]（荷重 1 tonf あたりの伸び ≈ 9.8/M µm）。4 段冷間圧延機で 4〜6 MN/mm。'
      + '1000 tonf なら 2 mm 伸びる — 圧下率一定制御はこれをスクリューで払うので、薄板ではスクリュー位置が負になる（実機のマイナス圧下）'
      + '。板幅で割って単位幅の剛性に換算して使うので、板幅を変えると伸びも変わる。',
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
    ? `ハウジングは荷重で P/M だけ伸びる。板幅 ${(view.stripWidth * 1000).toFixed(0)} mm 換算で`
      + ` ${(params.millModulus / 1e9).toFixed(3)} GPa（単位幅あたり）。`
      + '伸びはスクリュー位置から差し引く（ゲージメータ補正）: 指令や制御ループが決めるのは'
      + '負荷時のバレル間隔で、スクリュー読み S はそれから P/M を引いた値になり、'
      + '薄板では実機どおり負になる。以前は伸びをバレル間隔に足していたため、5 MN/mm・1000 tonf で'
      + '1.9 mm 開いて圧下が抜け、制御中は追いつけなかった。'
      + '実測の伸びは右パネル「うち ハウジング伸び」。'
    : 'OFF ではスタンドは剛体。バネはロール扁平と出側弾性回復だけで、'
      + '実機なら mm オーダーのミルスプリングが数十 µm しか出ない。';
}

sRoll.body.append(
  toggle('ロール弾性連成 (扁平)', params.rollCoupling, (v) => { params.rollCoupling = v; },
  'ワークロールを線形弾性体として解き、面圧で扁平した形を板の流れ解析に返す（連成）。冷間薄板では扁平が数十 µm あり、接触弧が伸びて荷重が 10〜40% 上がる — 荷重式に R ではなく Hitchcock の R\' を使う理由そのもの。'
      + 'OFF は剛体ロール（R\' = R）。docs/validation.md の基準値は OFF で測ったものが多い。').root,
  slider({
    label: 'ロール縦弾性係数 E', unit: 'GPa', min: 50e9, max: 600e9, step: 5e9, value: params.Eroll,
    format: (v) => (v / 1e9).toFixed(0),
    hint: 'ワークロールのヤング率 [GPa]。扁平量と Hitchcock 半径 R\' = R(1 + C·P/Δh) の C = 16(1−ν²)'
      + '/(πE) に入る。鋼ロール 210、超硬（WC）は 550〜600 で扁平が 1/3 になる。',
    onInput: (v) => { params.Eroll = v; sim.refreshMaterial(); },
  }).root,
  slider({
    label: '芯金半径比', min: 0.2, max: 0.8, step: 0.01, value: params.hubRatio,
    format: (v) => v.toFixed(2),
    hint: 'ロールメッシュの内側境界（固定芯）の半径を R に対する比で決める。表面の扁平は接触弧長オーダーの深さで減衰するので、0.45 既定で十分深い。'
      + '大きくすると肉厚が薄くなり扁平量が過大になる。変えるとロールメッシュを作り直す。',
    onInput: (v) => { params.hubRatio = v; scheduleRebuild(); },
  }).root,
  slider({
    label: '連成の緩和係数', min: 0.02, max: 0.6, step: 0.01, value: params.rollRelax,
    format: (v) => v.toFixed(2),
    hint: '扁平の更新を 1 フレームでどれだけ反映するか（0〜1）。扁平ループは「荷重↑→ギャップ開く→圧下↓→荷重↓」の正帰還を持つので、'
      + '大きすぎるとハンチングする。反転を検出すると自動でさらに減衰する（右パネル「連成 減衰係数」）。薄板・小径ロールほど小さめ。',
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
  },
  'ON でハウジング・圧下ねじの伸び P/M をモデルに入れる。伸びはスクリュー位置から差し引く（ゲージメータ補正: 指令や制御が決めるのは負荷時のバレル間隔で、'
      + 'スクリュー読み S = それ − P/M）。そのためスイッチを入れても板厚・荷重は変わらず、S と「うち ハウジング伸び」だけが変わる。'
      + 'OFF ではスタンドは剛体で、スプリングは扁平と弾性回復だけ。').root,
  sMillK.root,
  millHint,
);
sMillK.setEnabled(params.millSpringOn);
syncMillModulus();

const sNum = section('数値解析', { remember: false, open: false,
  hint: 'メッシュとソルバの設定。結果を変える「物理」ではなく、同じ物理をどの精度・速さで解くか。メッシュを細かくすると荷重の離散化誤差（接触列の出入りによる段差）'
      + 'が下がる。既定は 100×8 で、検証値はすべてこの設定。',
});
const meshSel = select<MeshLevel>('メッシュ品質 (プリセット)',
  (Object.keys(MESH_LEVELS) as MeshLevel[]).map((k) => ({ value: k, text: MESH_LEVELS[k].label })),
  view.meshLevel, (v) => {
    view.meshLevel = v;
    const L = MESH_LEVELS[v];
    params.stripNx = L.nx; params.stripNy = L.ny;
    params.rollNt = L.nt; params.rollNr = L.nr;
    sNx.set(L.nx); sNy.set(L.ny); sNt.set(L.nt); sNr.set(L.nr);
    scheduleRebuild();
  },
  '板・ロールの分割数をまとめて選ぶ。計算時間は概ね DOF に比例（100×8 で 3 ms/frame、200×14 で 14 ms）'
      + '。接触弧に板の列が 20 本以上乗る設定が目安。細かくすると「接触列が入口で出入り」する段差が低く・出にくくなるが、列境界自体はどのメッシュにもある。'
      + 'クエリ ?mesh=fast|balanced|fine|ultra|extreme|insane でも指定できる。');
const meshHint = el('div', 'ctrl-hint');
const sNx = slider({
  label: '板 圧延方向 分割 nx', min: 40, max: 800, step: 10, value: params.stripNx,
  format: (v) => v.toFixed(0),
  hint: '板を圧延方向に何列に切るか。解析窓（入側端〜出側端）を等分するので、接触弧に乗る列数は nx × 接触弧長 / 窓幅。20 列以上が目安（下の説明文に出る）'
      + '。荷重の段差（接触列の出入り）はこれが粗いほど大きい。',
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
  hint: 'ロール表面を周方向に何分割するか。ニップ集中度で接触弧付近に節点を寄せるので、接触弧に乗るロール節点数は nt より多い（説明文に出る）'
      + '。板の列数と同程度が扁平の解像に必要。',
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
  hint: '「表層メッシュを接触弧から自動」が OFF のときの表層の厚さ。これを「ロール表層 分割数」で等分した要素をバレル表面に並べる'
    + '（自動では 分割数 × 接触弧 ÷ 上の値）。ロール肉厚 R × (1 − 芯金半径比) の半分で頭打ちになり、分割数 0 では使わない。'
    + '実際の厚さと要素寸法は下の説明文に出る。既定 2 mm。',
  onInput: (v) => { params.rollSkinThickness = v; scheduleRebuild(); },
});
const skinHint = el('div', 'ctrl-hint');
sSkinFactor.setEnabled(params.rollSkinAuto);
sSkinThick.setEnabled(!params.rollSkinAuto);

// Built here rather than inline in its panel so the elastic-zones toggle can
// grey it out: with the elastic zones on the bulk term is the strip's own
// bulk modulus and this dial is never read.
const sIncomp = slider({
  label: '非圧縮ペナルティ', min: 1e3, max: 1e6, log: true, value: params.incompPenalty,
  format: (v) => v.toExponential(0),
  hint: '板の体積項 p = −K div v の K を基準粘度の何倍にするか。「入出側の弾性変形を考慮」が OFF のときだけ使う — '
    + 'ON（既定）では K は板の体積弾性率 × 噛み込み通過時間になり、この値は効かない（ON のあいだは無効表示）。'
    + 'OFF で既定の 10 倍・100 倍にすると発散した（docs/validation.md）。既定 1e4。',
  onInput: (v) => { params.incompPenalty = v; },
});
sIncomp.setEnabled(!params.elasticZones);

const tAutoFit = toggle('解析窓とニップ集中度を自動', params.autoFit, (v) => {
  params.autoFit = v;
  sWinIn.setEnabled(!v); sWinOut.setEnabled(!v); sBite.setEnabled(!v);
  if (v) { scheduleRebuild(); return; }
  // Off keeps the window the dials show - the stand on screen's, which
  // `syncWindowDials` holds in `params` - for every stand. A stand already
  // solving on exactly that window has nothing to rebuild, and rebuilding it
  // anyway threw its state away: the load fell from 940 to 377 tonf and had
  // to climb back. Only the stands on a window of their own are rebuilt, each
  // on its own, so the rest of the line keeps running.
  for (let k = 0; k < mill.count; k++) {
    const st = mill.stands[k];
    if (st.winIn !== params.windowIn || st.winOut !== params.windowOut
      || st.biteGradeEff !== params.biteGrade) scheduleStandRebuild(k);
  }
});
const autoFitHint = el('div', 'ctrl-hint');
autoFitHint.textContent =
  '接触弧長は √(RΔh) で縮むのに窓長は縮まないので、薄板・小径ロールでは弧に要素が'
  + '1 列も乗らず要素アスペクト比が数百になる。自動では弧長から窓と周方向集中度を決める。';
const sWinIn = slider({
  label: '解析窓 入側端', unit: 'mm', min: -0.20, max: -0.0005, log: false, step: 0.0005,
  value: params.windowIn,
  format: (v) => (v * 1000).toFixed(2),
  hint: '板メッシュの上流端（ロール中心の真下を 0、入側が負）。この面で板は速度一様・板厚方向の速度 0 で送り込まれ、後方張力もここに掛かる。'
    + '噛み込み入口はこの値の 0.8 倍より上流に置けず、はみ出すとミルライン図の見出しに「解析窓が噛み込み弧に足りない」と出る'
    + '（その段の荷重は過小）。nx はこの窓を分けるので、広げると列が粗くなる。自動では −(接触弧 + max(3h₀, 2 × 接触弧))で、'
    + 'はみ出しが 30 フレーム続くと実際の接触弧で窓を張り直す（縮めるのは次のリビルド）。',
  onInput: (v) => { params.windowIn = v; scheduleRebuild(); },
});
const sWinOut = slider({
  label: '解析窓 出側端', unit: 'mm', min: 0.0005, max: 0.12, step: 0.0005, value: params.windowOut,
  format: (v) => (v * 1000).toFixed(2),
  hint: '板メッシュの下流端（ロール中心の真下を 0、出側が正）。この面は拘束されず、前方張力がここに掛かる。'
    + '出口面の後ろには弾性回復の区間として最低 2 列を残す。出側の速度分布がそろうだけの長さが要る。自動では max(2h₀, 1.5 × 接触弧)。',
  onInput: (v) => { params.windowOut = v; scheduleRebuild(); },
});
const sBite = slider({
  label: 'ニップ集中度', min: 0, max: 0.99, step: 0.005, value: params.biteGrade,
  format: (v) => v.toFixed(3),
  hint: '0 = 周方向等分割。上げるほど接触弧に節点が集まる',
  onInput: (v) => { params.biteGrade = v; scheduleRebuild(); },
});
syncWindowDials();
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
    format: (v) => v.toFixed(2),
    hint: 'Picard 反復 1 回ごとの板の速度場の不足緩和: v ← v_前 + (この値) × (線形解 − v_前)。1 で線形解をそのまま採る。'
      + '小さいほど 1 回の歩みが小さく、剛体域の粘度が定まるまで反復を縮小的に保つ。'
      + 'ロール扁平の「連成の緩和係数」（ミル弾性）とは別。既定 0.6。',
    onInput: (v) => { params.relax = v; },
  }).root,
  sIncomp.root,
  slider({
    label: '法線ペナルティ', min: 1e3, max: 1e7, log: true, value: params.normalPenalty,
    format: (v) => v.toExponential(0),
    hint: 'ロール表面への食い込みを罰則で防ぐ強さ。基準粘度の何倍か。小さいと板がロールにめり込み、大きすぎると条件数が悪化する。既定 1e5。',
    onInput: (v) => { params.normalPenalty = v; },
  }).root,
  slider({
    label: 'ひずみ速度 正則化 ε̇₀', min: 0.002, max: 0.2, log: true, value: params.eps0Frac,
    format: (v) => v.toFixed(3),
    hint: '剛塑性の粘度 σf / (3√(ε̇² + ε̇₀²))（ε̇ は相当ひずみ速度）の正則化。噛み込みの公称ひずみ速度（通過速度 × ln(h₀ / 指令 h₁) ÷ 接触弧長）に対する比で、'
      + 'ひずみ速度がほぼ 0 の噛み込み前後の剛体域で粘度を有限に保つ。小さいほど剛体域が硬く剛塑性に近いが、線形系の条件数が悪くなる'
      + '（粘度は別の上限でも頭打ちになる — 弾性域 ON なら G × 通過時間、OFF なら基準粘度の 150 倍）。既定 0.02。',
    onInput: (v) => { params.eps0Frac = v; },
  }).root,
  slider({
    label: '摩擦 正則化速度', min: 0.002, max: 0.3, log: true, value: params.slipFrac,
    format: (v) => v.toFixed(3),
    hint: 'クーロン摩擦の正則化（無次元、ロール周速比）。すべり速度がこの値より小さい領域で摩擦力を滑らかに 0 に落とす（atan 型）'
      + '。小さいほど厳密な固着–すべり境界になるが収束が悪い。中立点付近の面圧・せん断分布の形に効く。既定 0.02。',
    onInput: (v) => { params.slipFrac = v; },
  }).root,
  slider({
    label: '自走制御 更新間隔', unit: 'frame', min: 1, max: 20, step: 1, value: params.feedEvery,
    format: (v) => v.toFixed(0),
    hint: '送り速度（入側速度）をこのフレーム数ごとにしか改訂しない（入側反力の低域通過は毎フレーム）。改訂の合間にロール扁平が落ち着くので、'
      + '送り速度ループと扁平ループが時間分離される — 扁平限界の近くでは荷重が送り速度に敏感で、1 にすると両者が競合しやすい。'
      + 'タンデムで張力モデル ON のときは #2 以降の送り速度が前段の出側速度で決まるので、効くのは #1 だけ。既定 6。',
    onInput: (v) => { params.feedEvery = Math.round(v); },
  }).root,
  slider({
    label: '自走制御 ゲイン', min: 0.02, max: 0.6, step: 0.01, value: params.feedGain,
    format: (v) => v.toFixed(2),
    hint: '送り速度（入側速度）ループの比例ゲイン。改訂のたびに 送り速度 × (1 − この値 × 入側反力 / (μ·P))'
      + '（反力は低域通過後、比は ±1 で打ち切り、1 回の変化は ±0.5% まで — 既定なら比 3.3% 超で上限に当たる）。'
      + '「送り速度を自動 (自走)」が OFF のときと、タンデムで張力モデル ON の #2 以降では使わない。既定 0.15。',
    onInput: (v) => { params.feedGain = v; },
  }).root,
  slider({
    // The floor was 5e-4 while the default is 3e-4, so the slider could not
    // represent the value it came up holding: touching it at all silently
    // loosened the feed deadband by 1.7x.
    label: '自走制御 不感帯', min: 1e-4, max: 3e-2, log: true, value: params.feedDeadband,
    format: (v) => v.toExponential(1),
    hint: '|入側反力| / (μ·P) がこれを下回ったら送り速度を動かさない。ギャップ制御はこのループがこの 3 倍以内に収まるまでスクリューを止める（状態「内側ループ待ち」）'
      + 'ので、整定時間の半分ほどはここで決まる。既定 3e-4。',
    onInput: (v) => { params.feedDeadband = v; },
  }).root,
  slider({
    label: 'ソルバ更新間隔', unit: 'frame', min: 1, max: 10, step: 1, value: view.solveEvery,
    format: (v) => v.toFixed(0),
    hint: '重いメッシュでも描画を 60 fps に保つ',
    onInput: (v) => { view.solveEvery = v; },
  }).root,
);

const sDisp = section('表示', { remember: false, open: false });
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

// One column, in the order a set-up is thought through: the line, the strip
// it carries, the material, then the selected stand and how it is run.
/* ── interstand tension ──────────────────────────────────────────────────── */

const TENSION_ABOUT =
  'スタンド間の張力を、表の入力値（目標）とラインが実際に持つ値（実績）に分ける。'
  + '参考書 5.4 節の 3 つのモデル（tension-lab と同じ）で実績を動かす: 剛体はスタンド間の板を伸びないものとして'
  + '速度が釣り合う張力を毎フレーム求める。単純弾性は長さ L の一様な弾性棒 dT/dt = (E h/L)(v_in − v_out)、'
  + '分布弾性は板厚分布を運ぶ直列ばね。FEM では下流スタンドの入側面を上流の出側速度で拘束し、'
  + 'その面が負担する反力を面高さで割った量が「不足している張力」— それを剛体はそのまま、弾性はその時定数 τ で追う。'
  + '実機の τ は 10 ms 程度でフレームより短いので、実時間ではどのモデルも剛体に見える。時間倍率で遅回しにすると差が見える。'
  + '張力制御 ON で、各スタンド間の実績を目標に合わせるよう上流スタンドのロール周速を PI で操作する。'
  + '出側板厚の受け渡しもスタンド間の搬送遅れ L/v を持つ。リバースでは無効。';
const sTension = section('スタンド間張力 (動特性・張力制御)', { remember: false, hint: TENSION_ABOUT, open: false });
const tensionHint = el('div', 'ctrl-hint');
const tensionReadout = el('div', 'ctrl-hint');
const tensionDials: { setEnabled(on: boolean): void }[] = [];
const selTension = select<TensionModel>('張力モデル',
  (['off', 'rigid', 'simple', 'dist'] as TensionModel[]).map((v) => ({ value: v, text: TENSION_MODEL_LABEL[v] })),
  params.tensionModel, (v) => { params.tensionModel = v; tensionChart.reset(); syncTensionUi(); },
  'なし: 張力は入力値のまま（従来どおり、各スタンドの送り速度が自走し不整合は「流量ずれ」に出る）。'
    + '剛体 / 単純弾性 / 分布弾性: 表の前方張力が目標になり、実績はラインの速度バランスが決める。'
    + '3 つの定常値は同じで、違うのは過渡の速さ（分布弾性はさらにスタンド間の板厚分布で剛性が変わる）。');
const sTScale = slider({
  label: '時間倍率', min: 0.001, max: 1, log: true, value: params.tensionTimeScale,
  format: (v) => (v >= 0.1 ? v.toFixed(2) : v.toPrecision(2)),
  hint: '張力の動特性と張力制御が進む速さ。1 で実時間（弾性の時定数 ~10 ms はフレーム以下なので剛体と区別がつかない）。'
    + '0.01 なら 100 倍の遅回しで、弾性の一次遅れと搬送遅れ L/v が目で追える。FEM 本体（AGC・送り）は倍率の影響を受けない。',
  onInput: (v) => { params.tensionTimeScale = v; },
});
const sTLen = slider({
  label: 'スタンド間距離 L', unit: 'm', min: 0.5, max: 20, log: true, value: params.standDistance,
  format: (v) => v.toFixed(2),
  hint: '弾性棒の長さ、および搬送遅れ L/v の L。既定 4.5 m は参考書 図 5.17 の到達時刻から逆算した値（tension-lab と同じ）。'
    + '短いほど剛性 E h/L が高く張力が速く動く。',
  onInput: (v) => { params.standDistance = v; },
});
const sTFollow = slider({
  label: '剛体の追従係数', min: 0.05, max: 1, step: 0.05, value: params.tensionFollow,
  format: (v) => v.toFixed(2),
  hint: '剛体モデルで、反力が示す不足分のうち 1 フレームに埋める割合。1 で一発、0.5 既定。'
    + '反力は収束途中の Picard 反復から読むので、1 に近いと過渡で行き過ぎることがある。弾性モデルは τ が決めるので効かない'
    + '（Bland–Ford に中立点がなく τ を作れない段だけ、この係数で代用する）。',
  onInput: (v) => { params.tensionFollow = v; },
});
const tTCtl = toggle('張力制御（上流スタンドの周速を PI で操作）', params.tensionControl, (v) => {
  params.tensionControl = v;
  syncTensionUi();
},
  '各スタンド間で 実績 − 目標 の相対誤差を PI にかけ、上流スタンドのロール周速に相対トリムとして重ねる。'
    + '張力が高ければ上流を増速して緩める。トリムはそのスタンド間より上流の全スタンドに同じ比で掛ける（逐次制御）ので、'
    + '他のスタンド間の速度比とライン出側速度は乱れない。tension-lab と同じ構成（Kp=0, Ki のみが既定）。');
const sTKp = slider({
  label: '比例ゲイン Kp', min: 0, max: 1, step: 0.05, value: params.tensionKp,
  format: (v) => v.toFixed(2),
  hint: '張力の不足分を「それを打ち消す周速トリム」に換算した量（プラントゲイン v/(h₁·|dΔv/dT|) で割る）のうち、'
    + 'ただちに掛ける割合。0 既定（積分のみ、tension-lab と同じ構成）。',
  onInput: (v) => { params.tensionKp = v; },
});
const sTKi = slider({
  label: '積分ゲイン Ki', unit: '1/s', min: 0.02, max: 5, log: true, value: params.tensionKi,
  format: (v) => v.toPrecision(2),
  hint: '閉ループの速さ。誤差をプラントゲインで割って積分するので、Ki はスケジュールによらず「モデル時間 1 s あたりに不足分の何割を埋めるか」。'
    + '0.5 既定（時定数 2 s）。FEM の反力は 0.1〜0.2 s 遅れて追いつくので、2 を超えると剛体モデルで振動しやすい。'
    + '相対誤差で積分する版は 50 MPa/% のプラントゲインの前で発散した。',
  onInput: (v) => { params.tensionKi = v; },
});
const sTLim = slider({
  label: '周速トリム上限', unit: '%', min: 1, max: 30, step: 1, value: params.tensionVLimit * 100,
  format: (v) => v.toFixed(0),
  hint: 'トリムの絶対値の上限（基準周速に対する割合）。上限に当たった分は積分しない（アンチワインドアップ）。',
  onInput: (v) => { params.tensionVLimit = v / 100; },
});
tensionDials.push(sTScale, sTLen, sTFollow, tTCtl, sTKp, sTKi, sTLim);
sTension.body.append(selTension.root, tensionHint, sTScale.root, sTLen.root, sTFollow.root,
  tTCtl.root, sTKp.root, sTKi.root, sTLim.root, tensionReadout);

/** Enable what the model uses, and say why the rest is grey. */
function syncTensionUi(): void {
  const reverse = view.lineMode === 'reverse';
  // A tandem line of one stand has no gap either: `Mill.syncTension` runs it
  // with no model (n > 1), so the select says so the same way as for reverse.
  const single = !reverse && mill.count < 2;
  const inactive = reverse || single;
  const on = !inactive && params.tensionModel !== 'off';
  // The select shows the model the line runs, not the one it holds. A reverse
  // mill has no gaps, so `Mill.syncTension` runs it with none whatever was
  // picked, and a greyed-out select still reading 剛体 read as 剛体 in effect.
  // The pick stays in `params` and is back on the select with the tandem line.
  const sel = selTension.root.querySelector('select') as HTMLSelectElement;
  sel.disabled = inactive;
  (sel.querySelector('option[value="off"]') as HTMLOptionElement).textContent =
    reverse ? 'なし（リバースでは無効）' : single ? 'なし（1 スタンドでは無効）' : TENSION_MODEL_LABEL.off;
  selTension.set(inactive ? 'off' : params.tensionModel);
  for (const d of tensionDials) d.setEnabled(on);
  if (on) {
    sTFollow.setEnabled(params.tensionModel === 'rigid');
    for (const d of [sTKp, sTKi, sTLim]) d.setEnabled(params.tensionControl);
  }
  const backTo = params.tensionModel !== 'off' ? `（選んであった「${TENSION_MODEL_LABEL[params.tensionModel]}」に戻る）。` : '。';
  tensionHint.textContent = reverse
    ? 'リバース（可逆圧延）にはスタンド間がなく、張力は両端のコイラが毎パス張り直す。タンデムに切り替えると有効' + backTo
    : single
    ? 'スタンドが 1 つのあいだはスタンド間がなく、張力は表の入力値がそのまま境界条件。スタンド数を 2 以上にすると有効' + backTo
    : params.tensionModel === 'off'
      ? '張力は表の入力値がそのまま境界条件。下流スタンドの送り速度は自走で決まり、'
        + '残る不整合は上部の「流量ずれ」に出る（実機ならスタンド間張力が吸収する分）。'
      : `${TENSION_MODEL_LABEL[params.tensionModel]}: 下流スタンドの入側速度を上流の出側速度に拘束し、`
        + '張力は反力から求める。表の前方張力は目標、実績は表の「実績」行・ミルライン図・下のグラフに出る。'
        + (params.tensionControl ? '制御 ON。' : '制御 OFF: 実績は目標から離れたところに落ち着く。目標に合わせるには制御を ON にする。');
  refreshTensionChart();
}

/** The per-gap numbers, refreshed every frame while a model is on. */
function paintTensionReadout(): void {
  const md = mill.diag;
  if (md.tensionModel === 'off' || md.tensionActual.length === 0) {
    if (tensionReadout.textContent) tensionReadout.textContent = '';
    return;
  }
  const lines: string[] = [];
  for (let k = 0; k < md.tensionActual.length; k++) {
    const a = md.tensionActual[k] / 1e6, t = md.tensionTarget[k] / 1e6, r = md.tensionRigid[k] / 1e6;
    const tau = md.tensionTau[k];
    const clamp = md.tensionClamped[k] === -1 ? ' 張力抜け' : md.tensionClamped[k] === 1 ? ' 降伏上限' : '';
    lines.push(`${standTag(k)}→${standTag(k + 1)}: 目標 ${t.toFixed(1)} / 実績 ${a.toFixed(1)} MPa`
      + `（反力の示す剛体値 ${r.toFixed(1)}${Number.isFinite(tau) ? `, τ ${(tau * 1000).toFixed(1)} ms` : ''}`
      + `${params.tensionControl ? `, トリム ${(100 * md.tensionTrim[k]).toFixed(2)}%` : ''}`
      + `, 搬送中 ${md.tensionQueueLen[k].toFixed(2)} m）${clamp}`);
  }
  lines.push(md.tensionSettled ? '全スタンド間 静定' : '推移中');
  const text = lines.join('\n');
  if (tensionReadout.textContent !== text) tensionReadout.textContent = text;
}
tensionReadout.style.whiteSpace = 'pre-line';

left.append(sLine.root, sStrip.root, sMat.root, sHeat.root,
  sProc.root, sAgc.root, sTension.root, sRoll.root, sNum.root, sDisp.root);

/* ── mu back-calculation ─────────────────────────────────────────────────── */

/* ── optional panels ─────────────────────────────────────────────────────── */
type PanelMode = 'both' | 'stage' | 'stats' | 'none';
const PANEL_MODE_LABEL: Record<PanelMode, string> = {
  both: '表示: コンター図 ＋ 圧延諸元',
  stage: '表示: コンター図のみ',
  stats: '表示: 圧延諸元のみ',
  none: '表示: グラフ優先（両方隠す）',
};
const PANELS_KEY = 'rollfem.panels.v1';
let panelMode: PanelMode = (() => {
  try {
    const v = localStorage.getItem(PANELS_KEY);
    return v && v in PANEL_MODE_LABEL ? (v as PanelMode) : 'both';
  } catch { return 'both'; }
})();
const stageEl = document.getElementById('stage') as HTMLElement;
const rightEl = document.getElementById('right') as HTMLElement;
/** the contour stage is off screen: nothing to draw into */
const stageHidden = () => stageEl.hidden;

/** Put the grid in the mode: classes and hidden flags only, safe at boot. */
function paintPanelMode(m: PanelMode): void {
  panelMode = m;
  const app = document.getElementById('app')!;
  const noStage = m === 'stats' || m === 'none';
  const noRight = m === 'stage' || m === 'none';
  app.classList.toggle('hide-stage', noStage);
  app.classList.toggle('hide-right', noRight);
  stageEl.hidden = noStage;
  rightEl.hidden = noRight;
}
/** The switch at run time: repaint, then re-place the handles and re-fit the views. */
function applyPanelMode(m: PanelMode): void {
  paintPanelMode(m);
  try { localStorage.setItem(PANELS_KEY, m); } catch { /* private mode */ }
  layoutRef?.refresh();
  relayout();
}
// The remembered mode goes on before anything measures the grid.
paintPanelMode(panelMode);

const HILL_KEY = 'rollfem.hill.v1';
let hillShown = (() => {
  try { return localStorage.getItem(HILL_KEY) !== 'off'; } catch { return true; }
})();
const hillCell = document.getElementById('chart-nip') as HTMLElement;
function paintHillShown(on: boolean): void {
  hillShown = on;
  hillCell.hidden = !on;
}
function applyHillShown(on: boolean): void {
  paintHillShown(on);
  try { localStorage.setItem(HILL_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  layoutRef?.refresh();
  relayout();
}
paintHillShown(hillShown);

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
 * The exit gauge is the 出側板厚 目標 cell, but only for a stand that is aiming
 * at it. Under 圧下率一定, 荷重一定 and off the cell is locked (`paintTargetLock`)
 * and still holds whatever was typed last, and solving against that gave a mu
 * for a pass the stand is not rolling. There, and when the cell is not a usable
 * exit at all - above the entry gauge, which happens when the schedule has been
 * driven by 圧下率 and the gauge column left behind - the commanded reduction is
 * used instead and the row says so. Nothing here reads the solver, which is the
 * point: the answer is a function of the table alone.
 */
function muInvCases(): { c: SlabCase; fromReduction: boolean }[] {
  const out: { c: SlabCase; fromReduction: boolean }[] = [];
  let h0 = params.h0;
  let e0 = 0;
  for (let k = 0; k < standCount; k++) {
    const s = standSetups[k];
    let h1 = s.agcMode === 'gauge' ? s.targetGauge : NaN;
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
    params.slabTheory, params.flattening,
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
      return `張力（後方 ${(c.backTension / 1e6).toFixed(0)} / 前方 ${(c.frontTension / 1e6).toFixed(0)} MPa）が`
        + ' 変形抵抗 kf 以上 — この張力では板は圧延ではなく引き抜かれる'
        + '（Bland & Ford は入側・出側それぞれの kf で判定するので、平均が kf 未満でも片側で超えれば解けない）。張力を下げる';
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
          + `（${SLAB_THEORY_LABEL[params.slabTheory]}${params.flattening === 'roberts' ? '・Roberts 偏平' : ''}, ${gauge}, R′ ${(r.point.Rflat * 1000).toFixed(1)} mm, kf ${(r.point.kf / 1e6).toFixed(0)} MPa,`
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
let loadModelBtns: HTMLButtonElement[] = [];
let theorySel: HTMLSelectElement | null = null;
let flatSel: HTMLSelectElement | null = null;
/**
 * Paint the pair: the selected model reads as pressed. The slab theory and
 * flattening selects go with it - greyed out under FEM, where the load and
 * the flattening are the FEM's own and no formula is in use.
 */
function paintLoadModel(): void {
  loadModelBtns.forEach((b, i) => b.classList.toggle('active', (i === 0) === (params.loadModel === 'fem')));
  if (theorySel) theorySel.disabled = params.loadModel !== 'slab';
  if (flatSel) flatSel.disabled = params.loadModel !== 'slab';
}
/** Which flattening model the slab theories - and the mu back-calculation - roll with. */
function setFlattening(m: FlatteningModel): void {
  if (params.flattening === m) return;
  params.flattening = m;
  if (params.loadModel === 'slab') {
    for (const st of mill.stands) if (st.params.agcMode === 'force') st.resetAgc();
    clearAgcTrail();
  }
  toast(`ロール偏平の式: ${FLATTENING_LABEL[m]}`
    + (m === 'roberts' ? '（L = b + √(b² + RΔh)、b は Hertz 接触半幅、R′ = L²/Δh）'
      : '（R′ = R(1 + 16(1−ν²)P/(πEΔh))）')
    + (params.loadModel === 'slab' ? '。スラブ法の荷重・μ逆算がこの偏平になる' : '。μ逆算がこの偏平になる（荷重は FEM のまま）'));
}
function setLoadModel(m: LoadModel): void {
  if (params.loadModel === m) return;
  params.loadModel = m;
  // The load every load loop is measuring has just changed definition, so
  // what those loops had identified about it is no longer about anything.
  for (const st of mill.stands) if (st.params.agcMode === 'force') st.resetAgc();
  clearAgcTrail();
  paintLoadModel();
  toast(m === 'slab'
    ? `荷重をスラブ法（${SLAB_THEORY_LABEL[params.slabTheory]} ＋ 張力 ＋ Hitchcock 扁平）で計算する。板厚・中立点・面圧分布は FEM のまま`
    : '荷重を FEM の界面面圧の積分で計算する');
}
/** Which slab theory the slab load and the mu back-calculation run on. */
function setSlabTheory(t: SlabTheory): void {
  if (params.slabTheory === t) return;
  params.slabTheory = t;
  if (params.loadModel === 'slab') {
    // Same as switching the load model: the load being held has just been
    // redefined, so what the loops had identified about it is void.
    for (const st of mill.stands) if (st.params.agcMode === 'force') st.resetAgc();
    clearAgcTrail();
  }
  toast(`スラブ法の式: ${SLAB_THEORY_LABEL[t]}`
    + (params.loadModel === 'slab' ? '。荷重・μ逆算・理論照合がこの式になる'
      : '。μ逆算と理論照合がこの式になる（荷重は FEM のまま）'));
}
{
  // The three looks. A theme is a `data-theme` on the root and a set of
  // tokens in the stylesheet; the choice is remembered and re-applied before
  // first paint by the inline script in index.html.
  const sw = document.getElementById('theme-switch') as HTMLElement;
  const paintTheme = () => {
    const cur = currentTheme();
    sw.querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.theme ?? 'classic') === cur));
  };
  sw.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const t = (b.dataset.theme ?? 'classic') as Theme;
    if (t === 'classic') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try { localStorage.setItem('rollfem.theme', t); } catch { /* private mode */ }
    paintTheme();
    applyPanelStructure(t);
    // The panels have moved: the handles go where they now are, and every
    // canvas takes the box it now has.
    layoutRef?.setTheme(t);
    relayout();
  });
  paintTheme();
}

/**
 * What a look does to the side panels beyond colour.
 *
 * The modern look tabs them: a strip of the section titles at the top of
 * the panel, one section shown at a time, the choice remembered. The other
 * looks put every section back in its column. Same nodes throughout - the
 * sections are never rebuilt, only shown or hidden.
 */
function applyPanelStructure(theme: Theme): void {
  for (const id of ['left', 'right']) {
    const panel = document.getElementById(id) as HTMLElement;
    panel.querySelector(':scope > .tabstrip')?.remove();
    const sections = [...panel.querySelectorAll(':scope > .panel-section')] as HTMLElement[];
    if (theme !== 'modern') {
      panel.classList.remove('tabbed');
      sections.forEach((s) => s.classList.remove('tab-active'));
      continue;
    }
    panel.classList.add('tabbed');
    const strip = el('div', 'tabstrip');
    const key = `rollfem.tab.${id}`;
    const select = (i: number) => {
      sections.forEach((s, j) => s.classList.toggle('tab-active', j === i));
      [...strip.children].forEach((b, j) => b.classList.toggle('active', j === i));
      try { localStorage.setItem(key, String(i)); } catch { /* private mode */ }
    };
    sections.forEach((s, i) => {
      const title = s.querySelector('.panel-head-title')?.textContent ?? `${i + 1}`;
      const b = el('button', 'btn', title) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => select(i));
      strip.append(b);
    });
    panel.prepend(strip);
    let remembered = 0;
    try { remembered = Number(localStorage.getItem(key) ?? 0) || 0; } catch { /* private mode */ }
    select(Math.max(0, Math.min(sections.length - 1, remembered)));
  }
}
{
  // Which model the reported load comes from. A pair rather than a toggle
  // because both names have to be visible to mean anything.
  const modelRow = buttonRow([
    {
      text: 'FEM',
      title: '圧延荷重を FEM の界面面圧の積分で求める（既定）',
      onClick: () => setLoadModel('fem'),
    },
    {
      text: 'スラブ法',
      title: '圧延荷重をスラブ法で求める。式は右の選択（Kármán / Orowan / Bland & Ford）、'
        + '張力と Hitchcock 扁平込み。μ逆算が逆に解いているのと同じ式。'
        + '板厚・中立点・面圧分布は FEM のまま。',
      onClick: () => setLoadModel('slab'),
    },
  ]);
  loadModelBtns = [...modelRow.querySelectorAll('button')] as HTMLButtonElement[];
  document.getElementById('topbar-actions')!.append(modelRow);
  paintLoadModel();

  // Which slab theory. A select rather than three more buttons: the names
  // are long, only one is ever in use, and the bar is out of room.
  const sel = el('select', 'ctrl-select topbar-select') as HTMLSelectElement;
  sel.title = 'スラブ法の式（スラブ法を選んだときだけ有効。FEM のときは荷重は FEM で計算）。'
    + 'Kármán: Siebel の閉形式 p̄ = kf*·(e^a−1)/a（教科書の式）。'
    + 'Bland & Ford: Coulomb 摩擦・小角近似で von Kármán 式を中立点の両側で閉形式に解く（冷間圧延の標準）。'
    + 'Orowan: 円弧そのまま・板厚方向の応力不均一（Prandtl の w(a)）・滑りと固着の摩擦を数値積分（最も厳密）。'
    + 'スラブ法モードの荷重、μ逆算、理論照合パネルがこの式を使う。';
  for (const [v, text] of Object.entries(SLAB_THEORY_LABEL)) {
    const o = el('option'); o.value = v; o.textContent = text; sel.append(o);
  }
  sel.value = params.slabTheory;
  sel.addEventListener('change', () => setSlabTheory(sel.value as SlabTheory));
  document.getElementById('topbar-actions')!.append(sel);
  theorySel = sel;

  // And how those theories flatten the roll. The FEM solves its own
  // flattening, so this too is greyed out under FEM.
  const fsel = el('select', 'ctrl-select topbar-select') as HTMLSelectElement;
  fsel.title = 'スラブ法のロール偏平式（スラブ法を選んだときだけ有効。FEM は弾性ロール FEM が偏平を解く）。'
    + 'Hitchcock: R′ = R(1 + 16(1−ν²)P/(πEΔh))、弧上の楕円圧力・変形後も円弧。'
    + 'Roberts: 接触弧長 L = b + √(b² + RΔh)、b = √(4(1−ν²)PR/(πE))（Hertz の接触半幅）、R′ = L²/Δh。'
    + '圧下ゼロで両式とも L = 2b、薄板では Roberts の方が偏平（弧）が大きい。'
    + 'スラブ法 3 式の荷重とμ逆算がこの式で扁平を解く。';
  for (const [v, text] of Object.entries(FLATTENING_LABEL)) {
    const o = el('option'); o.value = v; o.textContent = text; fsel.append(o);
  }
  fsel.value = params.flattening;
  fsel.addEventListener('change', () => setFlattening(fsel.value as FlatteningModel));
  document.getElementById('topbar-actions')!.append(fsel);
  flatSel = fsel;
  paintLoadModel();

  const row = buttonRow([
    { text: '⏸ 一時停止', primary: true, onClick: () => setRunning(!view.running) },
    // No reset and no layout button here any more: R resets from the
    // keyboard and a double-click on any panel boundary restores it, and the
    // bar was running out of room for the controls that have no other way in.
    { text: '⤢ 表示', title: 'カメラを板全体が入る位置に戻す (F)', onClick: fitView },
  ]);
  document.getElementById('topbar-actions')!.append(row);
  playBtn = row.querySelector('button')!;

  // Which of the two optional panels are on screen. The mill line, the
  // charts and the controls are always there; the contour stage and the
  // stats panel each go away on request and the grid closes over them.
  const psel = el('select', 'ctrl-select topbar-select') as HTMLSelectElement;
  psel.title = '中央のコンター図と右の圧延諸元パネルの表示。隠した分はミルライン・グラフ・残りのパネルが使う。'
    + '隠している間はコンター図の描画も止まるので、その分フレームが軽い。';
  for (const [v, text] of Object.entries(PANEL_MODE_LABEL)) {
    const o = el('option'); o.value = v; o.textContent = text; psel.append(o);
  }
  psel.value = panelMode;
  psel.addEventListener('change', () => applyPanelMode(psel.value as PanelMode));
  document.getElementById('topbar-actions')!.append(psel);

  // The friction hill on its own switch: it is the one chart about a single
  // stand's bite, and with it away the time-series column gets its width.
  const hsel = el('select', 'ctrl-select topbar-select') as HTMLSelectElement;
  hsel.title = '下段左の摩擦丘（界面面圧・せん断分布）の表示。隠すと制御軌跡と時系列グラフが帯の幅を使う。';
  for (const [v, text] of [['on', '摩擦丘: 表示'], ['off', '摩擦丘: 非表示']] as const) {
    const o = el('option'); o.value = v; o.textContent = text; hsel.append(o);
  }
  hsel.value = hillShown ? 'on' : 'off';
  hsel.addEventListener('change', () => applyHillShown(hsel.value === 'on'));
  document.getElementById('topbar-actions')!.append(hsel);

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

// Built in app/right-panel; `updateStats` fills it.
const {
  gMill, gTotal, loadModelHint, totalHint, gAgc, agcReadHint, gKin, gElas, gMat, gHeat,
  heatStatHint, gVal, budget, gRes, gMem, heapFill, memHint, memFill, gHost,
} = buildRightPanel(document.getElementById('right')!);

const hill = new FrictionHillChart(document.getElementById('nip') as HTMLCanvasElement);

/* ── gap-control trail ───────────────────────────────────────────────────── */

const agcScatter = new AgcScatterChart(
  document.getElementById('agcscatter') as HTMLCanvasElement);
const agcChartCell = document.getElementById('chart-agc') as HTMLElement;
const tensionChart = new TrackChart(document.getElementById('tensionchart') as HTMLCanvasElement);
const tensionChartCell = document.getElementById('chart-tension') as HTMLElement;
const gaugeChart = new TrackChart(document.getElementById('gaugechart') as HTMLCanvasElement, 600,
  { unit: 'mm', digits: 4, fromZero: false });
const speedChart = new TrackChart(document.getElementById('speedchart') as HTMLCanvasElement, 600,
  { unit: 'm/min', digits: 1, fromZero: false });
const stripChart = new TrackChart(document.getElementById('stripchart') as HTMLCanvasElement, 600,
  { unit: 'm/min', digits: 1, fromZero: false });
const screwChart = new TrackChart(document.getElementById('screwchart') as HTMLCanvasElement, 600,
  { unit: 'mm', digits: 4, fromZero: false });
const massChart = new TrackChart(document.getElementById('masschart') as HTMLCanvasElement, 600,
  { unit: 'mm²/s', digits: 0, fromZero: false });

/** The chart is only there while a model is on; with it off there is no history to draw. */
function refreshTensionChart(): void {
  const hidden = params.tensionModel === 'off' || view.lineMode === 'reverse' || mill.count < 2;
  if (tensionChartCell.hidden === hidden) return;
  tensionChartCell.hidden = hidden;
  layoutRef?.refresh();
}

/** One sample per solved frame, straight off the line's diagnostics. */
function pushTensionSample(): void {
  const md = mill.diag;
  if (md.tensionModel !== 'off') {
    tensionChart.push(md.tensionActual.map((v) => v / 1e6), md.tensionTarget.map((v) => v / 1e6));
  }
  // Every stand's exit gauge against what it is aiming at - the same rule the
  // mill diagram uses for its target, so the two never disagree.
  const stands = activeStands();
  gaugeChart.push(
    stands.map((st) => (st.diag.exitThickness > 0 ? st.diag.exitThickness : NaN) * 1000),
    stands.map((st, k) => {
      const c = standSetups[k];
      return c.agcMode === 'gauge' ? c.targetGauge * 1000
        : c.agcMode === 'force' ? NaN
          : st.params.h0 * (1 - c.reduction) * 1000;
    }));
  // Roll surface speed as the stand ran this frame, against the base speed
  // the cone (or the dial, for #1) asked for before the tension controller's
  // trim. With no trim the two lie on top of each other.
  const trimOn = md.tensionModel !== 'off' && params.tensionControl;
  // Trims are successive: stand k carries the product of the trims of every
  // gap at or after it (see Mill.applyTension), so that is what to divide out.
  const factor = stands.map((_, k) => {
    let f = 1;
    if (trimOn) for (let j = k; j < md.tensionTrim.length; j++) f *= 1 + (md.tensionTrim[j] || 0);
    return f;
  });
  speedChart.push(
    stands.map((st, k) => (md.omega[k] ?? st.params.omega) * st.params.R * 60),
    stands.map((st, k) => ((md.omega[k] ?? st.params.omega) * st.params.R * 60) / factor[k]));
  // Strip speed leaving (solid) and entering (dashed) each stand, both as the
  // FEM measures them: the gap between one stand's exit and the next stand's
  // entry is the mismatch a tension model carries.
  stripChart.push(
    stands.map((st) => (st.diag.exitSpeed > 0 ? st.diag.exitSpeed * MPM : NaN)),
    stands.map((st) => (st.diag.entrySpeed > 0 ? st.diag.entrySpeed * MPM : NaN)));
  // The screw position: what every gap loop actually moves. No rule to draw
  // against - the loops aim at a gauge or a load, and the screw is the means.
  screwChart.push(
    stands.map((st) => (Number.isFinite(st.screwPosition) ? st.screwPosition * 1000 : NaN)),
    stands.map((st) => (params.screwDyn && Number.isFinite(st.diag.screwCommand) ? st.diag.screwCommand * 1000 : NaN)));
  // Mass flow per unit width, v·h in mm²/s: exit solid, entry dashed. The
  // gap between the two on one stand is the volume-balance error of the
  // solve; the solid lines lying on one another across the line is what a
  // consistent speed cone looks like.
  const mm2s = (v: number, h: number) => (v > 0 && h > 0 ? v * 1000 * h * 1000 : NaN);
  massChart.push(
    stands.map((st) => mm2s(st.diag.exitSpeed, st.diag.exitThickness)),
    stands.map((st) => mm2s(st.diag.entrySpeed, st.params.h0)));
}
const hillPLabel = document.getElementById('hill-p-label') as HTMLElement;

/**
 * Why a stand's slab load is what it is, when the theory did not solve.
 * Empty when it did. The numbers named are the ones to go and change.
 */
function slabWhy(st: RollingSim): string {
  const d = st.diag, p = st.params;
  const theory = SLAB_THEORY_LABEL[p.slabTheory];
  switch (d.slabStatus) {
    case 'runaway':
      return `${theory}: ロール扁平の不動点なし — ${FLATTENING_LABEL[p.flattening]} 式で R′ が発散`
        + `（Stone の最小圧延可能板厚 h_min ${(d.stoneHMin * 1000).toFixed(3)} mm に対し h₁ ${(d.exitThickness * 1000).toFixed(4)} mm）。`
        + `FEM の R′ ${(d.hitchcockR * 1000).toFixed(1)} mm で評価した値を表示している`;
    case 'tension':
      return `${theory}: 張力（後方 ${(p.backTension / 1e6).toFixed(0)} / 前方 ${(p.frontTension / 1e6).toFixed(0)} MPa）が`
        + ` 変形抵抗 kf 以上 — 摩擦丘が立たず式が解けない（荷重 0）。`
        + (p.slabTheory === 'blandford' ? '入側・出側それぞれの kf で判定するので、平均が kf 未満でも片側で超えれば解けない。' : '')
        + '張力を下げる';
    case 'geometry':
      return `${theory}: 出側板厚 ${(d.exitThickness * 1000).toFixed(4)} mm が入側 ${(p.h0 * 1000).toFixed(4)} mm 以上`
        + ' — 圧下がなく式が立たない（荷重 0）';
    case 'nobite':
      return `${theory}: 噛み込みなし（接触列 0）— 式が立たない（荷重 0）`;
    default:
      return '';
  }
}
/** the panel-boundary handles, once installed (below); the AGC chart's visibility moves one */
let layoutRef: LayoutHandle | null = null;
/**
 * How many screw revisions a trail remembers.
 *
 * One sample per revision (every `agcEvery` frames), so 150 is about ten
 * seconds at 60 fps - enough to hold a setpoint change from the first move
 * to the last trim, which at 50 (three seconds) scrolled off before the loop
 * had finished. The age fade keeps the old end from competing with the new.
 */
const AGC_TRAIL = 150;
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
  const hidden = !activeSetups().some((c) => c.agcMode !== 'off');
  if (agcChartCell.hidden === hidden) return;
  agcChartCell.hidden = hidden;
  // The boundary between the two charts goes with the trail; the handle
  // has to be told, since a hidden cell moves nothing it can watch.
  layoutRef?.refresh();
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
  return activeStands().map((st, k) => {
    const q = st.diag.agcPlasticSlope;   // N/m per m of gauge
    return {
      tag: standTag(k), samples: agcTrails[k], target: agcTargets(k),
      slope: q !== 0 ? (q * view.stripWidth) / TONF / 1e6 : null,
    };
  });
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
  const was = sim;
  sim = mill.stands[view.stand];
  // The markers are positions in the strip they were released into. Another
  // stand's strip has its own gauge and window, so they would be drawn across
  // it where the last one was - left alone, over the thinner strip of #2 they
  // stuck out of it. Picking the stand already on screen keeps them.
  if (sim !== was) tracers.reset();
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
      + ` ／ 内層 隣接リング幅の比 最大 ${sim.roll.coreGrowth.toFixed(2)}`
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
    `${standTag(view.stand)} の幾何: h₁ = ${(h1 * 1000).toFixed(3)} mm ／ 公称接触弧長 L = √(RΔh) = ${(Lc * 1000).toFixed(2)} mm`
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

/**
 * Whether focus last got where it is by the pointer rather than the keyboard.
 *
 * Chrome leaves a clicked button focused, so after clicking スラブ法 or 保存
 * the next Space would press that button again instead of pausing. A button
 * reached with Tab is different: there Space is the way to press it. Neither
 * `:focus-visible` nor the focus event tells the two apart at keydown - Chrome
 * turns `:focus-visible` on as soon as a key arrives - so the origin is kept
 * here: a pointer press sets it, Tab clears it. Both listen in the capture
 * phase so that nothing stopping propagation can leave it stale.
 */
let focusByPointer = false;
window.addEventListener('pointerdown', () => { focusByPointer = true; }, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Tab') focusByPointer = false; }, true);

/**
 * Whether the focused element does something with a key press of its own: a
 * field takes the characters, a select takes Space (open), and a button
 * reached from the keyboard takes Space (press) - taking the key from them
 * here would pause the solve instead.
 */
function ownsKeys(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'BUTTON') return !focusByPointer;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

window.addEventListener('keydown', (e) => {
  // The listener is on the window, and so is the 3D tab's: while that tab is
  // showing, Space, R and the digits are its keys, and the hidden 2D line must
  // not pause, reset or switch stands underneath it.
  if (view3dRef?.active) return;
  // Cmd+R, Ctrl+1 and the like belong to the browser.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (ownsKeys(e.target)) return;
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
  view3dRef?.relayout();
}
/** the 3D tab, once it exists - `relayout` runs during layout install, before it does */
let view3dRef: View3DHandle | null = null;

const layout = installLayout(document.getElementById('app')!, relayout);
layoutRef = layout;
// The remembered look was applied to the root before first paint; its
// structure (tabs, handle positions) is applied here, once the panels exist.
applyPanelStructure(currentTheme());
layout.refresh();
window.addEventListener('resize', () => { layout.refresh(); relayout(); view3d?.relayout(); });

/* ── the 2D / 3D tabs ────────────────────────────────────────────────────── */

const view3d: View3DHandle = installView3D(document.getElementById('view3d') as HTMLElement, {
  initialMill: Q.mill as MillType | undefined,
});
view3dRef = view3d;
{
  const appEl = document.getElementById('app') as HTMLElement;
  const tabs = document.getElementById('mode-tabs') as HTMLElement;
  const setMode = (mode: '2d' | '3d') => {
    appEl.classList.toggle('mode-3d', mode === '3d');
    [...tabs.children].forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode));
    view3d.setActive(mode === '3d');
    if (mode === '2d') { layout.refresh(); relayout(); }
    // the handles measure the panels, which have just changed; after the
    // browser has laid the new ones out
    else requestAnimationFrame(() => { layout.refresh(); view3d.relayout(); });
    try { localStorage.setItem('rollfem.mode', mode); } catch { /* private mode */ }
  };
  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (b?.dataset.mode) setMode(b.dataset.mode as '2d' | '3d');
  });
  let remembered: string | null = null;
  try { remembered = localStorage.getItem('rollfem.mode'); } catch { /* private mode */ }
  if (startIn3d(Q.tab, remembered)) setMode('3d');
}

/* ── loop ────────────────────────────────────────────────────────────────── */

let last = performance.now();
let fpsEma = 60, frameEma = 16;
let statTick = 0, frameCount = 0;
let fieldDirty = true;
/** the scalar field just changed: take the next range outright, do not ease into it */
let rangeFresh = true;
let statMs = 0;
let lastRange = { min: 0, max: 1 };
/**
 * Model time per solve under `?fixeddt` [s], or null to follow the wall clock.
 * 1/60 s is the step tools/sim2d takes, so a URL and a node run step alike.
 */
const FIXED_DT = Q.fixeddt ? 1 / 60 : null;
/** times the line has been solved since the page loaded; `?stopafter` counts these */
let solveCount = 0;

refreshGeom();
refreshMeshHint();
updateExtentChip();
updateLegendStatic();
buildStandGrid();
refreshAgcChart();
syncTensionUi();
// view.running, not a literal: ?nosolve has already set it false.
setRunning(view.running);
fitView();

/**
 * A handle on the line's internals, for headless measurement. `?debug` only
 * (`app/lab.ts`). Installed here, after everything it reaches has been built:
 * the stand table, the tension panel and the loop's counters.
 */
if (DEBUG_TITLE) {
  installLab({
    mill: () => mill,
    params,
    view,
    standSetups,
    standCells: () => standCells,
    solves: () => solveCount,
    frameMs: () => frameEma,
    setRunning,
    setLoadModel,
    setSlabTheory,
    setFlattening,
    tension: { select: selTension, chart: tensionChart, control: tTCtl, scale: sTScale, sync: syncTensionUi },
  });
}

/** messages already reported by `frame`, so a throw that repeats every frame is shown once */
const frameErrors = new Set<string>();

/**
 * The loop itself. Whatever one frame throws, the next one is still asked for:
 * an exception used to skip the `requestAnimationFrame` at the end, and the
 * picture froze with nothing on screen to say why.
 */
function frame(now: number): void {
  try {
    frameBody(now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!frameErrors.has(msg)) {
      frameErrors.add(msg);
      console.error('frame:', err);
      toast(`描画ループで例外: ${msg}（詳細はコンソール）`, true);
    }
  } finally {
    requestAnimationFrame(frame);
  }
}

function frameBody(now: number): void {
  const wall = Math.min(now - last, 100);
  last = now;
  // The 3D tab has the screen: the 2D line holds still (its state is kept,
  // not advanced) and nothing here is drawn, so the two solves never share a
  // frame.
  if (view3d?.active) return;
  frameEma += (wall - frameEma) * 0.1;
  fpsEma += (1000 / Math.max(wall, 1e-3) - fpsEma) * 0.08;
  if (!stageHidden()) renderer.resize(Math.min(window.devicePixelRatio || 1, 2));
  // Model time: the frame's own by default, so the line runs in real time.
  // Under `?fixeddt` a fixed step, so the same URL solves the same sequence
  // however busy the machine is - the wall time still drives the readouts.
  const dt = FIXED_DT ?? wall / 1000;

  let solved = false;
  // Not while a line rebuild is waiting out its debounce. Whatever scheduled
  // it has already changed what the line reads - `params.h0`, a preset's
  // radius and reduction - but the meshes, the windows and the screws are
  // still the old line's, and the rebuild throws that state away anyway.
  // Solving the gap in between put the first stand's 2 mm gap on 1.5 mm strip
  // when h0 was dialled down: the exit came out thicker than the entry, the
  // flattening ran away, and in 160 ms the stand restarted five times and gave
  // up, with a toast for each, just before the rebuild reset the count.
  if (view.running && !rebuildPending && ++frameCount % Math.max(1, view.solveEvery) === 0) {
    // The setups of the line that exists, not of the one the stand-count
    // select asks for: that rebuild is still waiting on `scheduleRebuild`, and
    // until it runs a shorter slice leaves the last stands without a setup.
    mill.sync(params, standSetups.slice(0, mill.count));
    mill.advance(dt);
    announceRestarts();
    pushAgcSample();
    pushTensionSample();
    solved = true;
    solveCount++;
  }
  if (view.running && view.showTracers) tracers.update(dt);
  if (solved && solveCount === Q.stopafter) setRunning(false);
  followWindowDials();

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
  if (!stageHidden()) renderer.draw(sim, cam, ropts);

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

  gMill.set('mass', d.massBalance > 0 ? d.massBalance.toFixed(4) : '—', massTone(d.massBalance));
  gMill.set('P', (d.rollForce / 1e6).toFixed(3));
  const why = d.loadModel === 'slab' ? slabWhy(sim) : '';
  loadModelHint.textContent = d.loadModel === 'slab'
    ? (why ? `⚠ スラブ法が計算不能 — ${why}。` : '')
      + `荷重はスラブ法（${SLAB_THEORY_LABEL[params.slabTheory]}、上部のボタン）。FEM の値は ${Number.isFinite(d.loadFem) ? (d.loadFem / 1e6).toFixed(3) : '—'} kN/mm`
      + `（スラブ法比 ${d.rollForce > 0 && Number.isFinite(d.loadFem) ? (d.loadFem / d.rollForce).toFixed(3) : '—'}）。`
      + '荷重一定制御・ミル剛性の伸び・ミルライン図・スタンド表もこの値を読む。'
    : '荷重は FEM の界面面圧の積分（上部のボタンでスラブ法に切替可）。';
  loadModelHint.classList.toggle('hint-bad', why !== '');
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
    // Live, like the mill line's chip: the target is editable while paused and
    // the idle test needs no solve to answer. `agcSaturated` and the rest do,
    // so they are still read from the last one.
    const idle = sim.gaugeIdle;
    // The old label said 目標 ≥ 入側板厚, which is not the test and is why this
    // reads as firing at the wrong moment: a stand cannot roll to its own
    // entry gauge either, because the barrel flattens and the strip springs
    // back, so the floor is the entry *minus the spring it is already paying*.
    // At 1.20 mm entry with a 0.07 mm spring that floor is 1.13, and a 1.15 mm
    // target is idle while the label insists it is below the entry gauge.
    // A bite too shallow for the mesh outranks 'stalled': a stand caught in
    // it *is* stalled, but saying so points at the feed loop, which is not
    // where the problem is. Measured on the default mesh:
    // a 3 % pass (8 contact columns) settles, 1 % and under (5-6 columns)
    // sit in '内側ループ待ち' for as long as they are left - the feed loop
    // cannot settle on that few columns and the gauge loop never gets its
    // turn. Saying 'waiting' about that is true and useless.
    const shallow = !idle && !d.agcSettled && d.agcStalled && !force
      && (standH0() - sim.agcSetpoint) / standH0() < SHALLOW_BITE_DRAFT;
    const uncomp = !force && !params.agcSpringComp;
    // Under load control on a slab load the theory could not solve, the loop
    // is holding a number that is not the theory's: say that before anything
    // about convergence.
    const slabBroken = force && d.loadModel === 'slab' && d.slabStatus !== 'ok';
    gAgc.set('st', slabBroken
      ? `スラブ法が計算不能 — ${slabWhy(sim)}`
      : idle
      ? `保留（目標 ${(params.agcTargetGauge * 1000).toFixed(4)} ≥ 入側`
        + ` ${(sim.gaugeFloor * 1000).toFixed(4)} mm）`
      : shallow ? `噛み込みが浅すぎて解けない（圧下 ${(100 * (1 - sim.agcSetpoint / standH0())).toFixed(1)}%・接触 ${d.contactNodes} 列）`
        : d.agcSaturated ? 'ギャップ端に張り付き'
          : uncomp ? `S を目標に固定（スプリング補正なし: 出側 +${(d.agcError * standH0() * 1e6).toFixed(0)} µm）`
            : d.agcSettled
              ? (sim.agcBand > params.agcDeadband ? `収束（FEM 荷重のメッシュ分解能 ±${(100 * sim.agcBand).toFixed(2)}% 内）` : '収束')
              : d.agcStalled ? '内側ループ待ち' : '調整中',
      slabBroken ? 'bad' : idle ? 'warn'
        : shallow || d.agcSaturated || d.agcStalled ? 'bad'
          : uncomp ? 'warn' : d.agcSettled ? 'ok' : 'warn');
    // Sourced from the solver, not retyped: these bounds have moved before,
    // and a hint quoting the old ones is worse than no hint.
    const closing = force ? d.agcError < 0 : d.agcError > 0;
    // The rail is on the *loaded* separation, so the stand's stiffness does not
    // move it - at 0.30*h0 the geometry, and therefore the load, is the same
    // whatever M is. What does move the achievable total load is the width the
    // per-unit-width result is multiplied by, and the material and geometry.
    // Pressed against the closing rail, the load being measured *is* the most
    // this range can make - so say so, and say what driving the screws past it
    // would buy. Below Stone's limit, less and less of the closing reaches the
    // gauge: measured with the screws walked to the rail (docs/validation.md,
    // 締め込みと Stone の比), d ln h1 / d ln gap is about 0.5 at h1/h_min = 1
    // and 0.04 at 0.56 - while the load kept rising the whole way. It used to
    // say the load would not rise below a ratio of 2; nothing measured that.
    const ratio = d.stoneHMin > 0 ? d.exitThickness / d.stoneHMin : Infinity;
    const ceiling = force
      ? `この範囲で出せるのは今の ${((d.rollForce * b) / TONF).toFixed(0)} tonf が上限`
      : `この条件で届く実圧下率は ${(100 * (1 - d.exitThickness / standH0())).toFixed(1)}% が上限`;
    agcReadHint.textContent = shallow
      ? `目標 ${(sim.agcSetpoint * 1000).toFixed(4)} mm は入側より薄いが、圧下量が小さすぎて接触弧が`
        + `板メッシュ ${d.contactNodes} 列にしか乗らない（板 ${params.stripNx}×${params.stripNy}）。`
        + 'この軽さでは自走速度ループが収まらず、ギャップループは動けないまま止まる。'
        + '実測: 既定メッシュで 3% 圧下（8 列）は整定、1% 以下（5〜7 列）は整定しない。'
        + 'メッシュ品質を上げるか、圧下量を増やす。'
      : idle
      ? `目標 ${(params.agcTargetGauge * 1000).toFixed(4)} mm が入側板厚`
        + ` ${(standH0() * 1000).toFixed(4)} mm（${view.stand > 0 ? '前スタンドの出側の現在値' : 'ライン入側'}）以上。`
        + '板を厚くはできないので圧下にならない。スクリューを開いて噛み込みを空にする代わりに'
        + 'スタンドを止め、板は入側板厚のまま通している。目標を入側より薄くすれば再開する。'
        + '入側より薄いが解けないほど軽い目標（既定メッシュで 1% 前後未満）は保留ではなく'
        + '「ギャップ端に張り付き」になる。'
      : d.agcStalled
      ? `送り速度ループが収束していない（残差 ${d.feedResidual.toExponential(1)} ＞ 不感帯`
        + ` ${params.feedDeadband.toExponential(0)}）ためスクリューを止めている。`
        + 'この状態の測定値は定常解ではなく、動かせば誤った位置に最適化してしまう。'
        + (d.exitThickness <= d.biteLimitH1
          ? '出側板厚が噛み込み限界を下回っており、自走できる送り速度がそもそも存在しない。'
            + 'μ か R を上げるか圧下率を下げること。'
          : '一度「スクリュー位置をリセット」してからやり直すか、送り速度を手動指定すること。')
      : d.agcSaturated
      ? (closing
        ? `スクリューが下端 ${(d.gapLimitLo * 1000).toFixed(4)} mm`
          + `（バレル間隔 ${(params.sepFloorFrac * 100).toFixed(0)}·%h₀ ＝ 左パネル`
          + '「スクリュー下限 バレル間隔」）。'
          + `${ceiling}。`
          + (ratio < 1
            ? ` h₁/h_min = ${ratio.toFixed(2)} と Stone の最小圧延可能板厚を下回っている。`
              + '締めた量のうち出側板厚に効くのは半分程度以下で、残りはロールの扁平になる（荷重は増える）。'
              + '下端より先は質量収支が崩れるため許していない。'
              + 'ロール径 R を小さくするか、板幅 b・μ・σ_Y0 を上げること。'
            : ` h₁/h_min = ${Number.isFinite(ratio) ? ratio.toFixed(2) : '—'}`
              + 'とまだ余裕はあるが、下端より先は質量収支が崩れるため許していない。'
              + '板幅 b・μ・σ_Y0・K・R・h₀ を上げるか、目標を下げること。')
        : `これ以上開くと「ギャップ＋ミルスプリング」が h₀ に届いて板が素通りする`
          + `（上端 ${(d.gapLimitHi * 1000).toFixed(4)} mm）。目標が過小。`
          + (force ? '板幅 b を下げるか、目標を上げること。' : ''))
      : force
        ? '荷重を合わせにいくので圧下率は結果。実圧下率と圧下達成率を見ること。'
        : 'スクリューはミルスプリング分だけ余分に締まる。S < h₀(1−r) が正常。'
          + (params.millSpringOn ? ' ミル剛性 ON では S からハウジング伸び P/M も引かれるので、'
            + '薄板では負になる（実機の「マイナス圧下」と同じ）。' : '');
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
    d.feedNotEstablished ? 'bad' : d.feedResidual < params.feedDeadband * 2 ? 'ok' : 'warn');
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
  const ratio = slab.load > 0 ? d.loadFem / slab.load : 0;
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
  // Under the slab load the hill is the theory's: the pressure and friction
  // its load is the integral of, on its own arc, with its own neutral point.
  // The FEM's hill is still solved every frame - it is what the strip is
  // rolled with - but it is not what the load on screen came from.
  let hillNeutral: number | null = sim.diag.neutralFound ? sim.diag.neutralX * 1000 : null;
  {
    const d = sim.diag, p = sim.params;
    if (d.loadModel === 'slab') {
      const prof = slabPressureProfile(p, { h0: p.h0, h1: d.exitThickness, R: p.R,
        backTension: p.backTension, frontTension: p.frontTension, entryStrain: d.entryStrain },
      p.mu, d.hitchcockR > 0 ? d.hitchcockR : p.R);
      if (prof.samples.length > 1) {
        samples.length = 0;
        for (const q of prof.samples) samples.push({ x: q.x * 1000, p: q.p / 1e6, tau: q.tau / 1e6 });
        hillNeutral = Number.isFinite(prof.neutralX) ? prof.neutralX * 1000 : null;
      }
    }
    const label = `${standTag(view.stand)} ${d.loadModel === 'slab' ? `${SLAB_THEORY_LABEL[p.slabTheory]} 面圧 p` : 'FEM 面圧 p'}`;
    if (hillPLabel.textContent !== label) hillPLabel.textContent = label;
  }
  // Every other stand's hill as well, from the same model each is on, so
  // the chart reads across the line the way the control trail does.
  const others: { tag: string; samples: HillSample[] }[] = [];
  activeStands().forEach((st, k) => {
    if (st === sim) return;
    const d = st.diag, p = st.params;
    const ss: HillSample[] = [];
    if (d.loadModel === 'slab') {
      const prof = slabPressureProfile(p, { h0: p.h0, h1: d.exitThickness, R: p.R,
        backTension: p.backTension, frontTension: p.frontTension, entryStrain: d.entryStrain },
      p.mu, d.hitchcockR > 0 ? d.hitchcockR : p.R);
      for (const q of prof.samples) ss.push({ x: q.x * 1000, p: q.p / 1e6, tau: q.tau / 1e6 });
    } else {
      const mm = st.flow.mesh;
      for (let i = 0; i <= mm.nx; i++) {
        if (!st.flow.ifActive[i]) continue;
        ss.push({ x: mm.X[2 * mm.topNodes[i]] * 1000, p: st.flow.ifPressure[i] / 1e6, tau: st.flow.ifShear[i] / 1e6 });
      }
      ss.sort((a, b) => a.x - b.x);
    }
    if (ss.length > 1) others.push({ tag: standTag(k), samples: ss });
  });
  // The deformation resistance along the arc, from whichever model is
  // making the load. Under the FEM it is the flow stress the solve carries,
  // averaged over each contact column's nodes the way the strain is; under
  // the slab load it is what the selected theory reads at the local strain
  // on its own flattened arc.
  const kfCurve: { x: number; kf: number }[] = [];
  let kfLabel = 'FEM';
  {
    const d = sim.diag, p = sim.params;
    if (d.loadModel === 'slab') {
      kfLabel = SLAB_THEORY_LABEL[p.slabTheory];
      const prof = slabKfProfile(p, { h0: p.h0, h1: d.exitThickness, R: p.R,
        backTension: p.backTension, frontTension: p.frontTension, entryStrain: d.entryStrain },
      d.hitchcockR > 0 ? d.hitchcockR : p.R);
      for (const k of prof) kfCurve.push({ x: k.x * 1000, kf: k.kf / 1e6 });
    } else {
      const rows = m.rows, ny = m.ny;
      for (let i = 0; i <= m.nx; i++) {
        if (!sim.flow.ifActive[i]) continue;
        let acc = 0;
        for (let j = 0; j < rows; j++) acc += (j === 0 || j === ny ? 0.5 : 1) * sim.sigmaF[i * rows + j];
        kfCurve.push({ x: m.X[2 * m.topNodes[i]] * 1000, kf: ((2 / Math.sqrt(3)) * acc) / ny / 1e6 });
      }
      kfCurve.sort((a, b) => a.x - b.x);
    }
  }
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
  // A stand the theory could not solve is named here too: the heading says
  // slab, and the reader has to know which numbers under it are not the
  // theory's own.
  const unsolved = params.loadModel === 'slab'
    ? mill.stands.slice(0, standCount).map((st, k) => [k, st.diag.slabStatus] as const).filter(([, s]) => s !== 'ok')
    : [];
  const unsolvedTag = unsolved.length
    ? ` ⚠ 計算不能 ${unsolved.map(([k, s]) => `${standTag(k)} ${s === 'runaway' ? '扁平発散' : s === 'tension' ? '張力' : s === 'geometry' ? '圧下なし' : '噛み込みなし'}`).join('・')}`
    : '';
  paintTensionReadout();
  const tensionTag = md.tensionModel !== 'off'
    ? ` ／ 張力: ${md.tensionModel === 'rigid' ? '剛体' : md.tensionModel === 'simple' ? '単純弾性' : '分布弾性'}`
      + `${params.tensionControl ? '・制御中' : ''} ${md.tensionSettled ? '静定' : '推移中'}`
    : '';
  const modelTag = params.loadModel === 'slab'
    ? ` ／ 荷重: スラブ法 (${SLAB_THEORY_LABEL[params.slabTheory]}${params.flattening === 'roberts' ? '・Roberts 偏平' : ''})${unsolvedTag}` : '';
  // Any stand whose volume is not conserved is named here, because the
  // header is the one line everyone reads and the number it invalidates
  // (the load) is the one they read it for.
  const broken = mill.stands.slice(0, standCount)
    .map((st, k) => [k, massTone(st.diag.massBalance)] as const)
    .filter(([, t]) => t !== 'ok');
  const massTag = broken.length
    ? ` ／ ⚠ 質量収支 ${broken.map(([k, t]) => `${standTag(k)} ${t === 'bad' ? '崩れ' : '注意'}`).join('・')}`
    : '';
  // A bite that has outgrown the analysis window is named the same way: its
  // load is short by the pressure the window cannot hold, and nothing else on
  // screen says so - the mesh reads settled because its columns sit exactly
  // where the window's limit put them.
  const clipped = mill.stands.slice(0, standCount)
    .map((st, k) => [k, st.diag.windowShortfall] as const)
    .filter(([, s]) => s > 0);
  // A feed that cannot establish itself is named too: the load and the exit
  // gauge go still anyway, so the stand looks settled while the entry face is
  // pushing the strip through and no free-running solution exists at all.
  const unfed = mill.stands.slice(0, standCount)
    .map((st, k) => [k, st.diag] as const)
    .filter(([, sd]) => sd.feedNotEstablished);
  const feedTag = unfed.length
    ? ` ／ ⚠ 送り速度の自走が成り立っていない ${unfed.map(([k, sd]) => `${standTag(k)} 送り残差 ${sd.feedResidual.toExponential(1)}`).join('・')}`
      + '（入側面が板を押し込んでいる。荷重と h₁ は静止していても定常解ではない）'
    : '';
  const windowTag = clipped.length
    ? ` ／ ⚠ 解析窓が噛み込み弧に足りない ${clipped.map(([k, s]) => `${standTag(k)} ${(s * 1000).toFixed(2)} mm`).join('・')}`
      + '（窓の外の弧が面圧を持たないので、その段の荷重は過小）'
    : '';
  millSub.textContent = mill.count > 1
    ? `${mill.count} ${w}${modelTag}${massTag}${feedTag}${windowTag} ／ 合計圧下率 ${(md.totalReduction * 100).toFixed(2)}%`
      + ` ／ 出側 ${(md.h1[mill.count - 1] * 1000).toFixed(4)} mm`
      + totals
      // Consecutive passes do not share a flow, so there is nothing to be off by.
      + (Number.isFinite(md.flowError)
        ? ` ／ 流量ずれ ${(md.flowError * 100).toFixed(2)}%` : '')
      + ` ／ ${md.settled ? `全${w}収束` : '調整中'}${tensionTag}`
    : `単スタンド${modelTag}${massTag}${feedTag}${windowTag}${totals}`
      + ` ／ 「ライン構成」で${view.lineMode === 'reverse' ? 'パス' : 'スタンド'}数を増やせる`;

  // Gauge axis from the schedule as typed: the first stand's target exit
  // gauge at the top end, the last stand's at the bottom, each with a margin.
  // Not the line's entry gauge at the top - no loop ever aims there, and it
  // left the first stand's cluster a fifth of the plot in from the edge. A
  // stand's target is whatever its mode reads: the absolute gauge, the
  // reduction converted, or under load control the gauge it is actually
  // making, since it has no gauge target to draw against.
  {
    const targetOf = (k: number): number => {
      const c = standSetups[k];
      const st = mill.stands[k];
      const hIn = st ? st.params.h0 : params.h0 * Math.pow(1 - params.reduction, k);
      return c.agcMode === 'gauge' ? c.targetGauge
        : c.agcMode === 'force' && st && st.diag.exitThickness > 0 ? st.diag.exitThickness
          : hIn * (1 - c.reduction);
    };
    agcScatter.setGaugeRange(targetOf(standCount - 1) * 1000, targetOf(0) * 1000);
  }
  agcScatter.draw(agcTrailSet());
  if (!tensionChartCell.hidden) {
    tensionChart.draw(Array.from({ length: Math.max(0, mill.count - 1) },
      (_, k) => `${standTag(k)}→${standTag(k + 1)}`));
  }
  const tags = Array.from({ length: mill.count }, (_, k) => standTag(k));
  gaugeChart.draw(tags);
  // Roll speed and strip speed on one axis: the gap between them is the
  // slip, and it only reads as such when the scales agree.
  const rs = speedChart.dataRange(), ss = stripChart.dataRange();
  const shared = rs && ss ? { lo: Math.min(rs.lo, ss.lo), hi: Math.max(rs.hi, ss.hi) } : rs ?? ss;
  speedChart.draw(tags, undefined, shared);
  stripChart.draw(tags, undefined, shared);
  screwChart.draw(tags);
  massChart.draw(tags);
  if (hillShown) hill.draw(samples, {
    neutralX: hillNeutral,
    neutralFemX: sim.diag.loadModel === 'slab' && sim.diag.neutralFound ? sim.diag.neutralX * 1000 : null,
    flowStress: slab.kf / 1e6,
    // the dashed mean is the mean of the hill drawn: the theory's own under
    // the slab load, the FEM-radius reference otherwise
    slabMean: (d.loadModel === 'slab' ? d.meanPressure : slab.meanPressure) / 1e6,
    arcIn: d.arcIn * 1000,
    arcOut: d.arcOut * 1000,
    kfCurve, kfLabel, others,
  });
}

requestAnimationFrame(frame);
