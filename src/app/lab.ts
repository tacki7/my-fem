import type { Mill, StandSetup } from '../sim/mill';
import type { AgcMode, FlatteningModel, LoadModel, RollingParams, SlabTheory } from '../sim/solver';
import type { TensionModel } from '../sim/tension';
import { slabLoad } from '../sim/muinv';
import type { NumFieldHandle } from '../ui/controls';
import { TONF, MPM, type defaultView } from './defaults';

/** The stand table's cells `__lab` writes through - the table rebuilds them, so they are read through a getter. */
export interface LabStandCells {
  mode: HTMLSelectElement;
  red: NumFieldHandle;
  gauge: NumFieldHandle;
  load: NumFieldHandle;
  backT: NumFieldHandle;
  ten: NumFieldHandle;
  mu: NumFieldHandle;
}

/** What `__lab` reads and drives. Getters for what `main.ts` reassigns; the rest by reference. */
export interface LabContext {
  /** the line (rebuilt when the stand count or the mesh changes) */
  mill: () => Mill;
  params: RollingParams;
  view: Pick<ReturnType<typeof defaultView>, 'running' | 'stripWidth'>;
  standSetups: readonly StandSetup[];
  /** the stand table's rows (rebuilt with the table) */
  standCells: () => readonly LabStandCells[];
  /** times the line has been solved since the page loaded */
  solves: () => number;
  /** the smoothed frame time [ms] */
  frameMs: () => number;
  setRunning: (on: boolean) => void;
  setLoadModel: (m: LoadModel) => void;
  setSlabTheory: (t: SlabTheory) => void;
  setFlattening: (m: FlatteningModel) => void;
  /** the tension panel's controls, so a model or controller set here shows there too */
  tension: {
    select: { set(m: TensionModel): void };
    chart: { reset(): void };
    control: { set(on: boolean): void };
    scale: { set(s: number): void };
    sync: () => void;
  };
}

/**
 * `window.__lab`: a handle on the 2D line's internals for headless measurement,
 * installed by `main.ts` under `?debug` only.
 *
 * Moved out of `main.ts` as it was, key for key and in the same order - README,
 * docs/validation.md and the tools under tools/browser call these by name. It
 * reads the app through `LabContext` and imports nothing from `main.ts`: what
 * `main.ts` reassigns (the line, the stand table's cells, the solve count, the
 * frame time) is passed as a getter and read on every call, never copied.
 *
 * Every number `stands()` returns is one a panel already shows, plus the three the gap loop
 * decides with and nothing displays: the setpoint after clamping, the spring
 * the idle test is measured against, and the live value of that test. Chasing
 * a control-state bug without them means guessing which of the three moved -
 * and the last time that was guessed at, it was guessed wrong twice.
 */
export function installLab(ctx: LabContext): void {
  (window as unknown as Record<string, unknown>).__lab = {
    get running() { return ctx.view.running; },
    /** times the line has been solved; a frame that skipped the solve does not count */
    get solves() { return ctx.solves(); },
    stands: () => ctx.mill().stands.map((st, k) => {
      const p = st.params, d = st.diag;
      return {
        k,
        mode: p.agcMode,
        // mm throughout, so the numbers read the way the table does
        h0: p.h0 * 1000,
        h1: d.exitThickness * 1000,
        setupTargetGauge: ctx.standSetups[k].targetGauge * 1000,
        paramTargetGauge: p.agcTargetGauge * 1000,
        agcSetpoint: st.agcSetpoint * 1000,
        h1Command: st.h1Command * 1000,
        gap: st.h1 * 1000,
        screwCommand: d.screwCommand * 1000,
        screwTravel: st.screwTravel * 1e6,
        millSpring: d.millSpring * 1000,
        gaugeFloor: st.gaugeFloor * 1000,
        gaugeIdleLive: st.gaugeIdle,
        agcIdleDiag: d.agcIdle,
        agcSettled: d.agcSettled,
        agcStalled: d.agcStalled,
        agcSaturated: d.agcSaturated,
        windowShortfall: d.windowShortfall * 1000,
        agcError: d.agcError,
        holdGap: st.holdGap,
        contactNodes: d.contactNodes,
        stepMs: st.lastStepMs,
        loadTonf: (d.rollForce * ctx.view.stripWidth) / TONF,
        loadFemTonf: (d.loadFem * ctx.view.stripWidth) / TONF,
        loadModel: d.loadModel,
        slabStatus: d.slabStatus,
        slabTheory: p.slabTheory,
        flattening: p.flattening,
        forwardSlip: d.forwardSlip,
        massBalance: d.massBalance,
        neutralX: d.neutralX * 1000,
        arc: d.arcLength * 1000,
        omega: p.omega,
        rollMpm: p.omega * p.R * MPM,
        entryMpm: d.entrySpeed * MPM,
        exitMpm: d.exitSpeed * MPM,
        peakP: d.peakPressure / 1e6,
        targetTonf: (ctx.standSetups[k].targetForce * ctx.view.stripWidth) / TONF,
        reduction: ctx.standSetups[k].reduction,
        // Which inner loop is holding the screws, and by how much. Without
        // these a stalled stand is indistinguishable from a slow one.
        feedResidual: d.feedResidual,
        feedNotEstablished: d.feedNotEstablished,
        feedFloor: d.feedFloor,
        feedDeadband: p.feedDeadband,
        millResidual: d.millResidual,
        agcDeadband: p.agcDeadband,
        agcSensitivity: d.agcSensitivity,
        method: p.agcMethod,
        // the two linear solves: strip (every frame) and roll (every rollEvery)
        cgIterations: d.cgIterations,
        cgResidual: d.cgResidual,
        rollCgIterations: d.rollCgIterations,
        rollCgResidual: d.rollCgResidual,
      };
    }),
    setLoad: (k: number, tonf: number) => {
      const f = ctx.standCells()[k]?.load.root as HTMLInputElement | undefined;
      if (!f) return false;
      f.value = String(tonf);
      f.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setTension: (k: number, sb: number, sf: number) => {
      const b = ctx.standCells()[k]?.backT.root as HTMLInputElement | undefined;
      const f = ctx.standCells()[k]?.ten.root as HTMLInputElement | undefined;
      if (!b || !f) return false;
      b.value = String(sb); b.dispatchEvent(new Event('change', { bubbles: true }));
      f.value = String(sf); f.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    /** debug: poison a stand's velocity field, to watch it recover */
    poison: (k: number) => { const st = ctx.mill().stands[k]; if (!st) return false; st.flow.v.fill(NaN); return true; },
    restarts: () => ctx.mill().stands.map((st) => ({ restarts: st.restarts, giveUp: st.divergedGiveUp, ago: performance.now() - st.restartAt })),
    /**
     * Volume flux through every column of a stand's strip mesh [mm²/s],
     * trapezoid over the actual node spacing, with the column's x [mm] and
     * thickness [mm]. Where the flux drops along x is where the solve
     * loses volume - the one way to tell a bite leak from an exit artefact.
     */
    fluxProfile: (k: number) => {
      const st = ctx.mill().stands[k]; if (!st) return null;
      const m = st.flow.mesh, v = st.flow.v;
      const out: { x: number; h: number; q: number }[] = [];
      for (let i = 0; i <= m.nx; i++) {
        let q = 0;
        for (let j = 0; j < m.ny; j++) {
          const a = i * m.rows + j, b = a + 1;
          const dy = m.X[2 * b + 1] - m.X[2 * a + 1];
          q += 0.5 * (v[2 * a] + v[2 * b]) * dy;
        }
        out.push({ x: m.X[2 * (i * m.rows)] * 1000, h: 2 * m.X[2 * (i * m.rows + m.ny) + 1] * 1000, q: 2 * q * 1e6 });
      }
      return { arc: st.diag.arcLength * 1000, neutralX: st.diag.neutralX * 1000, elasticEntry: st.diag.elasticEntryLen * 1000, elasticExit: st.diag.elasticExitLen * 1000, cols: out };
    },
    /**
     * Streamline test on the strip's top surface, per column: the surface
     * velocity against the slope of the mesh surface it sits on and against
     * the slope of the undeformed roll circle the contact constraint uses.
     * `rMesh` = v_y − v_x·s'_mesh is the rate at which volume crosses the
     * mesh surface; its running integral is what the flux profile shows.
     */
    streamline: (k: number) => {
      const st = ctx.mill().stands[k]; if (!st) return null;
      const m = st.flow.mesh, v = st.flow.v;
      const s = st as unknown as { cy: number; roll: { cx: number } };
      const out: { x: number; on: number; vx: number; vy: number; sMesh: number; sCirc: number; rMesh: number; rCirc: number; hyd: number }[] = [];
      for (let i = 0; i <= m.nx; i++) {
        const nd = m.topNodes[i];
        const ip = Math.min(m.nx, i + 1), im = Math.max(0, i - 1);
        const dx = m.X[2 * m.topNodes[ip]] - m.X[2 * m.topNodes[im]];
        const dy = m.X[2 * m.topNodes[ip] + 1] - m.X[2 * m.topNodes[im] + 1];
        const sMesh = Math.abs(dx) > 1e-12 ? dy / dx : 0;
        const px = m.X[2 * nd], py = m.X[2 * nd + 1];
        const nx = px - s.roll.cx, ny = py - s.cy;
        const sCirc = Math.abs(ny) > 1e-12 ? -nx / ny : 0;
        const vx = v[2 * nd], vy = v[2 * nd + 1];
        // hydrostatic stress of the top element to the left of the column [MPa]
        const ei = Math.min(m.nx - 1, Math.max(0, i - 1)) * m.ny + (m.ny - 1);
        const hyd = st.flow.elemStress[4 * ei + 3] / 1e6;
        out.push({ x: px * 1000, on: st.flow.ifActive[i], vx, vy, sMesh, sCirc, rMesh: vy - vx * sMesh, rCirc: vy - vx * sCirc, hyd });
      }
      return out;
    },
    /** the interstand gaps as the line carries them; MPa, %, ms, m */
    tension: () => {
      const md = ctx.mill().diag;
      return {
        model: md.tensionModel,
        control: ctx.params.tensionControl,
        timeScale: ctx.params.tensionTimeScale,
        settled: md.tensionSettled,
        flowError: md.flowError,
        tensionMs: ctx.mill().lastTensionMs,
        frameMs: ctx.frameMs(),
        exitCorr: ctx.mill().exitCorrection,
        omega: [...md.omega],
        gaps: ctx.mill().gapStates.map((g, k) => ({
          k,
          actual: md.tensionActual[k] / 1e6,
          target: md.tensionTarget[k] / 1e6,
          rigid: md.tensionRigid[k] / 1e6,
          err: md.tensionError[k],
          trimPct: 100 * md.tensionTrim[k],
          tauMs: 1000 * md.tensionTau[k],
          sens: g.sens,
          queueLen: g.queue.length,
          slices: g.queue.count,
          clamped: g.clamped,
          feedSpeed: ctx.mill().stands[k + 1]?.params.feedSpeed,
          exitSpeed: ctx.mill().stands[k]?.diag.exitSpeed,
          reaction: ctx.mill().stands[k + 1]?.diag.feedReaction,
          appliedBack: (ctx.mill().stands[k + 1]?.params.backTension ?? NaN) / 1e6,
          appliedFront: (ctx.mill().stands[k]?.params.frontTension ?? NaN) / 1e6,
        })),
      };
    },
    setTensionModel: (m: TensionModel) => {
      ctx.params.tensionModel = m; ctx.tension.select.set(m); ctx.tension.chart.reset(); ctx.tension.sync(); return true;
    },
    setTensionControl: (on: boolean) => { ctx.params.tensionControl = on; ctx.tension.control.set(on); ctx.tension.sync(); return true; },
    setTensionScale: (s: number) => { ctx.params.tensionTimeScale = s; ctx.tension.scale.set(s); return true; },
    setMu: (k: number, mu: number) => {
      const f = ctx.standCells()[k]?.mu.root as HTMLInputElement | undefined;
      if (!f) return false;
      f.value = String(mu);
      f.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setReduction: (k: number, pct: number) => {
      const f = ctx.standCells()[k]?.red.root as HTMLInputElement | undefined;
      if (!f) return false;
      f.value = String(pct);
      f.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setParam: (key: string, v: number | string) => {
      (ctx.params as unknown as Record<string, unknown>)[key] = v;
      return true;
    },
    getParam: (key: string) => (ctx.params as unknown as Record<string, unknown>)[key],
    setTargetGauge: (k: number, mm: number) => {
      ctx.standCells()[k]?.gauge.set(mm);
      const f = ctx.standCells()[k]?.gauge.root as HTMLInputElement | undefined;
      if (!f) return false;
      f.value = String(mm);
      f.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setMode: (k: number, m: AgcMode) => {
      const sel = ctx.standCells()[k]?.mode;
      if (!sel) return false;
      sel.value = m;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setRunning: ctx.setRunning,
    setLoadModel: ctx.setLoadModel,
    setSlabTheory: ctx.setSlabTheory,
    setFlattening: ctx.setFlattening,
    /** One theory at one radius [mm] for stand k, tensions [Pa] optional - for probing the fixed point. */
    slabAt: (k: number, t: SlabTheory, RpMm: number, sb?: number, sf?: number) => {
      const st = ctx.mill().stands[k]; if (!st) return null;
      const p = st.params, d = st.diag;
      const pt = slabLoad({ ...p, slabTheory: t }, { h0: p.h0, h1: d.exitThickness, R: p.R,
        backTension: sb ?? p.backTension, frontTension: sf ?? p.frontTension, entryStrain: st.entryStrain },
      p.mu, RpMm > 0 ? RpMm / 1000 : undefined);
      return { tonf: (pt.load * ctx.view.stripWidth) / TONF, Rp: pt.Rflat * 1000, nx: pt.neutralX * 1000,
        torque: pt.torque, Qp: pt.Qp };
    },
    /** Every theory's load for stand k at its current gauge, in tonf, beside the FEM's. */
    slabTable: (k: number, sb?: number, sf?: number) => {
      const st = ctx.mill().stands[k]; if (!st) return null;
      const p = st.params, d = st.diag;
      const c = { h0: p.h0, h1: d.exitThickness, R: p.R, backTension: sb ?? p.backTension,
        frontTension: sf ?? p.frontTension, entryStrain: st.entryStrain };
      const out: Record<string, number> = { fem: (d.loadFem * ctx.view.stripWidth) / TONF, h1: d.exitThickness * 1000,
        Rfem: d.hitchcockR * 1000, neutralFem: d.neutralX * 1000, torqueFem: Math.abs(d.torque) };
      for (const t of ['karman', 'orowan', 'blandford'] as SlabTheory[]) {
        const pt = slabLoad({ ...p, slabTheory: t }, c, p.mu);
        out[t] = (pt.load * ctx.view.stripWidth) / TONF;
        out[`${t}_R`] = pt.Rflat * 1000;
        out[`${t}_nx`] = pt.neutralX * 1000;
        out[`${t}_T`] = pt.torque;
        out[`${t}_atFemR`] = (slabLoad({ ...p, slabTheory: t }, c, p.mu, d.hitchcockR).load * ctx.view.stripWidth) / TONF;
      }
      return out;
    },
    setAutoSpeed: (v: boolean) => { ctx.mill().autoSpeed = v; return ctx.mill().autoSpeed; },
    /** The slab estimate for stand k on its current gauge, in tonf - what 'slab' mode reports. */
    slabOf: (k: number) => {
      const st = ctx.mill().stands[k]; if (!st) return null;
      const p = st.params, d = st.diag;
      const pt = slabLoad(p, { h0: p.h0, h1: d.exitThickness, R: p.R, backTension: p.backTension,
        frontTension: p.frontTension, entryStrain: st.entryStrain }, p.mu);
      return (pt.load * ctx.view.stripWidth) / TONF;
    },
    contact: (k: number) => ctx.mill().stands[k]?.contactSpan,
    /** The stand itself, for one-off probes of its private state. */
    raw: (k: number) => ctx.mill().stands[k],
    /*
     * Record one sample per animation frame.
     *
     * Polling this over the debug protocol is too slow to see what is being
     * measured here: the spring transient lives for the handful of frames it
     * takes the exit gauge to follow the screws, and a 100 ms poll lands after
     * it is over - which reads as "no transient" and is how this was nearly
     * written off as not reproducing.
     */
    watch: (k: number) => {
      const trace: Record<string, number | boolean>[] = [];
      let on = true;
      const t0 = performance.now();
      const tick = () => {
        if (!on) return;
        const st = ctx.mill().stands[k];
        if (st) {
          const d = st.diag;
          trace.push({
            t: performance.now() - t0,
            h0: st.params.h0 * 1000,
            h1: d.exitThickness * 1000,
            gap: st.h1 * 1000,
            floor: st.gaugeFloor * 1000,
            setpoint: st.agcSetpoint * 1000,
            idle: st.gaugeIdle,
            diagIdle: d.agcIdle,
            load: (d.rollForce * ctx.view.stripWidth) / TONF,
            // The gates. A loop that is not moving is either settled, held by
            // the line, stalled behind the feed loop, or waiting on the mill
            // spring - and which one is invisible from the error alone.
            err: d.agcError,
            settled: d.agcSettled,
            stalled: d.agcStalled,
            hold: st.holdGap,
            feedRes: d.feedResidual,
            feedFloor: d.feedFloor,
            millRes: d.millResidual,
            sens: d.agcSensitivity,
            // The feed loop's own state: what it is driving and what it sees.
            vIn: d.entrySpeed,
            vOut: d.exitSpeed,
            omega: st.params.omega,
            react: d.feedReaction,
            contact: d.contactNodes,
            // The flattening coupling and the flow solve: the other two loops
            // that can ring at a fixed screw position.
            cres: d.couplingResidual,
            relax: d.relaxScale,
            flat: d.rollFlattening * 1e6,
            picard: d.picardDelta,
            mass: d.massBalance,
            neutral: d.neutralX * 1000,
            stretch: d.millStretch * 1e6,
            springLive: d.millSpring * 1e6,
            gapLo: d.gapLimitLo * 1000,
            gapHi: d.gapLimitHi * 1000,
            fatal: !(document.getElementById('fatal') as HTMLElement).hidden,
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as Record<string, unknown>).__trace = {
        stop: () => { on = false; return trace; },
        peek: () => trace,
      };
      return true;
    },
  };
}
