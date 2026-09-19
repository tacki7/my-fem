/**
 * The 3D tab's pass with its rolls from FrontISTR, to the steady state, and its contours.
 *
 * The coupling itself is src/sim3d/coupling.ts (and tools/frontistr/couple.mjs runs the same
 * rounds from node): the app's solver converges the pass; its load goes to the bridge as a
 * `roll-coupled` job, fistr1 solves the work and backup rolls as solids under it, the solids'
 * work-roll surface against the model's becomes the correction δ(x) of the model's gap, the
 * solver converges again with it, … until δ and the load stop moving. This file drives those
 * rounds from the page - one job per round, its frames drawn as they come - and shows where
 * they are: a line in the status area, a section of numbers, the FrontISTR values over the
 * charts, and the contours of the strip (the material FEM's field, every correction round) and
 * of the rolls (the job's frames, every substep).
 *
 * view3d.ts only connects it: `begin`/`converged`/`stop`/`settingsChanged` from its own solve
 * loop, `busy`/`resumable` for the run button, `row`/`panel`/`contourBox`/`control()` to place,
 * `frame(R)` and `overlays(R)` once per drawn frame.
 *
 * On by default (the user's aim is the rolls from FrontISTR); `?coupling=off` or the left
 * panel's switch turn it off, and without the bridge or fistr1 the pass is solved with the
 * model alone and the status line says why and what to do.
 */
import { stallText, type StackSolver, type Result3D } from '../sim3d/solver';
import type { Params3D } from '../sim3d/stack';
import { RollCoupling, modelRollSurface, interpolateProfile, type CouplingRound } from '../sim3d/coupling';
import { FistrJob, type JobState } from './fistrjob';
import { pingFrontistr, FistrError } from './frontistr';
import { ContourView3D } from './contour3d';
import { decodeMesh, decodeFrame, partValues, type DecodedMesh, type FieldValues } from './fieldframe';
import { synthStrip } from './fieldsynth';
import { el, section, select, StatGrid } from '../ui/controls';
import type { XYSeries } from './charts3d';
import './coupled3d.css';

const TONF = 9.80665e3;
/** FrontISTR's load steps per round (the bridge's default for `roll-coupled`) */
const SUBSTEPS = 2;
/** the strip's material model, as the contour's status plate names where the strip's values come from */
const STRIP_SOURCE: Record<string, string> = { fem: '平面 FEM', fem3d: '3 次元 FEM', slab: 'スラブ法' };
/** the coupling's thresholds, as RollCoupling holds them (shown beside the moves) */
const TOL_SURFACE = 0.25e-6;
const TOL_FORCE = 1e-3;

export type CouplePhase =
  /** nothing asked yet, or the settings changed */
  | 'idle'
  /** the app's solver converging (the first time, or again with a new correction) */
  | 'app'
  /** a FrontISTR round running */
  | 'fistr'
  /** δ and the load stopped moving */
  | 'steady'
  /** stopped by the viewer between or in a round */
  | 'stopped'
  /** a round failed (the bridge's reason in `note`) */
  | 'failed'
  /** coupling asked for but not possible here (no bridge, no fistr1): the model alone */
  | 'model';

export interface CoupledHost {
  solver: StackSolver;
  params(): Params3D;
  /** set the app's solve going again (a new correction made it unconverged) */
  resume(): void;
  /** something shown changed */
  changed(): void;
  /** the coupling was switched on or off */
  enabledChanged?(on: boolean): void;
}

interface RoundRecord extends CouplingRound {
  /** wall time of the round: the FrontISTR job and the re-convergence after it [s] */
  seconds: number;
  /** the job alone [s] */
  fistrSeconds: number;
  nodes: number;
}

interface CoupledResult { x: number[]; v: number[]; force: number; nodes: number; loadRatio: number }

/** the pass before any correction: what the coupling is measured against */
interface Uncoupled { x: Float64Array; h1: Float64Array; force: number; crown: number; edgeL: number; edgeR: number; latent: number }

const finiteOrNull = (v: number) => (Number.isFinite(v) ? v : null);
const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return t < 60 ? `${t} 秒` : `${Math.floor(t / 60)} 分 ${String(t % 60).padStart(2, '0')} 秒`;
};
/** m:ss, for the status line's narrow cells */
const mmss = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export class CoupledRun {
  /** the status area's line */
  readonly row: HTMLElement;
  /** the right panel's section */
  readonly panel: HTMLElement;
  /** the stage's contour layer (the contour view lives in it once shown) */
  readonly contourBox: HTMLElement;
  enabled: boolean;
  phase: CouplePhase = 'idle';
  /** why the coupling is not running, or how a round failed, and what to do about it */
  note = '';
  private coupling: RollCoupling | null = null;
  private rounds: RoundRecord[] = [];
  private uncoupled: Uncoupled | null = null;
  /** the last round's surfaces per station [m]: the solids', the model's (NaN off the strip) */
  private surface: { fem: Float64Array; model: Float64Array } | null = null;
  private job: FistrJob | null = null;
  private jobT0 = 0;
  private roundT0 = 0;
  private runT0 = 0;
  /** when the rounds stopped (steady, stopped, failed); 0 while they run */
  private runEnd = 0;
  private substep = 0;
  private lastFistrSeconds = NaN;
  private ping: Promise<string> | null = null;
  private bridgeAnswer: Promise<string> | null = null;
  // contours
  private view: ContourView3D | null = null;
  private shown = false;
  private mesh: DecodedMesh | null = null;
  private meshKey = '';
  /** the settings whose rolls' mesh is placed on the view ('' for none) - see `placeRolls` */
  private placedKey = '';
  private stripField: unknown = null;
  /** the strip field there was when the settings last changed: not one of these settings' */
  private fieldAtChange: unknown = null;
  private stripKey = '';
  private dryRunTimer = 0;
  private dryRunBusy = false;
  private dryRunTries = 0;
  private readonly stats: StatGrid;
  private ticker = 0;

  constructor(private host: CoupledHost) {
    let off = false;
    try { off = new URLSearchParams(location.search).get('coupling') === 'off'; } catch { /* no location */ }
    this.enabled = !off;
    this.row = el('div', 'v3-couple');
    this.row.setAttribute('aria-live', 'polite');
    this.contourBox = el('div', 'v3-coupled-contour');
    const sec = section('FrontISTR 連成', {
      open: true,
      hint: 'ロールの変形を FrontISTR のソリッド（WR と BUR、ロール同士は接触）で解き、アプリの板の FEM と定常まで連成する。'
        + '1 回ごとに、収束した板の荷重をソリッドに載せて解き、その WR 表面とこのモデルの WR 表面（軸の撓み＋扁平）の差 δ(x) をモデルのロールギャップに足して解き直す。'
        + `δ の動きが ${TOL_SURFACE * 1e6} µm 以下、荷重の変化が ${TOL_FORCE * 100} % 以下になったら定常。1 回 数分（4Hi 既定で 1 回 5〜7 分、3 回ほど）。`
        + '「連成なし」は最初の収束（モデルだけ）の値。npm run dev の橋渡しと手元の fistr1 が要る。',
    });
    this.stats = new StatGrid();
    this.stats.add('state', '状態').add('rounds', '連成の回数 / 経過')
      .add('force', '荷重 連成なし / 連成', 'tonf').add('crown', 'C25 連成なし / 連成', 'µm')
      .add('edge', 'エッジドロップ L 連成なし / 連成', 'µm').add('latent', '潜在形状 連成なし / 連成', 'I-unit')
      .add('delta', '補正 δ 中央 / 最大', 'µm').add('move', '最後の回 δ の動き / 荷重')
      .add('fistr', 'FrontISTR 1 回 / 網の節点');
    sec.body.append(this.stats.root);
    this.panel = sec.root;
    this.panel.hidden = !this.enabled;
    this.render();
  }

  // ── from the view's solve loop ─────────────────────────────────────────

  /** a coupled calculation is in a FrontISTR round (the app's own solve shows as its `running`) */
  get busy(): boolean { return this.phase === 'fistr'; }

  /** stopped or failed between rounds with the app converged: 計算開始 goes on with the next round */
  get resumable(): boolean {
    return this.enabled && !!this.coupling && (this.phase === 'stopped' || this.phase === 'failed') && this.host.solver.isConverged;
  }

  /** 計算開始 on settings that are not solved yet (or a stopped solve): the app solves first, the rounds follow */
  begin(): void {
    this.note = '';
    if (!this.enabled) { this.phase = 'idle'; this.render(); return; }
    if (!this.coupling) {
      this.coupling = new RollCoupling(this.host.solver.ns, { tolSurface: TOL_SURFACE, tolForce: TOL_FORCE });
      this.rounds = [];
      this.uncoupled = null;
      this.surface = null;
      this.runT0 = performance.now();
    }
    this.runEnd = 0;
    this.phase = 'app';
    // is there anything to couple with? (asked while the app solves)
    this.ping = this.bridge();
    this.startTicker();
    this.render();
  }

  /** the app's solver converged */
  converged(): void {
    if (!this.enabled || this.phase !== 'app' || !this.coupling) { this.render(); return; }
    const R = this.host.solver.result;
    if (!this.uncoupled) {
      this.uncoupled = {
        x: Float64Array.from(R.x), h1: Float64Array.from(R.h1), force: R.force, crown: R.crown,
        edgeL: R.edgeDropL, edgeR: R.edgeDropR, latent: R.latentIU,
      };
    }
    const last = this.rounds[this.rounds.length - 1];
    if (last && this.roundT0) last.seconds = (performance.now() - this.roundT0) / 1000;
    void (this.ping ?? Promise.resolve('')).then((why) => {
      if (this.phase !== 'app') return;
      if (why) { this.phase = 'model'; this.note = why; this.halt(); this.render(); this.host.changed(); return; }
      void this.startRound();
    });
  }

  /**
   * Why the coupling cannot run here ('' when it can): asked once a page - a missing bridge is
   * a built app, and every failed request is a line in the browser's console. A dev server
   * started later needs a reload.
   */
  private bridge(): Promise<string> {
    return (this.bridgeAnswer ??= pingFrontistr().then((p) => (!p ? 'npm run dev の橋渡しが無い（連成は dev サーバーでだけ回る）— モデルだけで解いた'
      : !p.fistr1 ? 'fistr1 が無い（tools/frontistr/README.md のビルド手順）— モデルだけで解いた' : '')));
  }

  /** 計算開始 with the app converged and the rounds not finished (after a stop or a failure) */
  resume(): void {
    if (!this.resumable) return;
    this.note = '';
    void this.startRound();
  }

  /** the viewer stopped: the job goes, what the rounds reached stays */
  stop(): void {
    if (this.phase === 'fistr' || this.phase === 'app') {
      this.dropJob();
      this.phase = this.coupling ? 'stopped' : 'idle';
      this.note = '';
      this.halt();
      this.labelRolls();
      this.render();
    }
  }

  /** the rounds stopped running (for the elapsed time and the once-a-second redraw) */
  private halt(): void {
    this.stopTicker();
    if (this.runT0 && !this.runEnd) this.runEnd = performance.now();
  }

  /** the settings changed: the correction and the rounds were for the old ones, so they go (the next 計算開始 starts at round 1) */
  settingsChanged(): void {
    this.dropJob();
    this.coupling = null;
    this.rounds = [];
    this.uncoupled = null;
    this.surface = null;
    this.note = '';
    this.phase = 'idle';
    this.stopTicker();
    this.runT0 = this.runEnd = 0;
    if (this.host.solver.rollCorrection) this.host.solver.setRollCorrection(null);
    // the field on show is the old settings' until the solver makes a new one
    this.fieldAtChange = this.host.solver.result.fem?.field3d ?? null;
    // the contours go back to the initial state: the strip's block, the rolls' mesh unloaded
    this.stripKey = '';
    this.stripField = null;
    this.unloadRolls();
    this.scheduleDryRun();
    this.render();
  }

  /** the coupling switched on or off (the left panel) */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.settingsChanged();
    this.enabled = on;
    this.panel.hidden = !on;
    this.render();
    this.host.enabledChanged?.(on);
    this.host.changed();
  }

  /** the left panel's switch */
  control(): HTMLElement {
    const s = select<'fistr' | 'model'>('ロールの変形', [
      { value: 'fistr', text: 'FrontISTR と連成（ソリッド）' },
      { value: 'model', text: 'モデルだけ（梁＋接触扁平）' },
    ], this.enabled ? 'fistr' : 'model', (v) => this.setEnabled(v === 'fistr'),
    '「FrontISTR と連成」: 計算開始で、このモデルが収束するたびに板の荷重を WR と BUR のソリッドに載せて FrontISTR で解き、そのロール表面に合わせてモデルを解き直す。δ と荷重が動かなくなるまで（定常）。'
      + '1 回 数分、4Hi 既定で 3 回ほど。npm run dev の橋渡しと fistr1 が要る（無ければモデルだけで解いて、状態の行に理由）。「モデルだけ」: 従来どおりこのモデルで収束まで。URL の ?coupling=off でも切れる。');
    s.root.dataset.key = 'coupling';
    return s.root;
  }

  // ── a round ────────────────────────────────────────────────────────────

  private async startRound(): Promise<void> {
    const sv = this.host.solver, R = sv.result;
    this.phase = 'fistr';
    this.substep = 0;
    this.jobT0 = this.roundT0 = performance.now();
    this.startTicker();
    this.render();
    const round = this.rounds.length + 1;
    // the load per station; NaN (off the strip) travels as null, and the bridge turns it back.
    // The model's own work-roll surface under it goes along for the record (the job's
    // request.json then holds both sides of the round's comparison); the case does not use it
    const load = { q: Array.from(R.q, finiteOrNull), arc: Array.from(R.arc, finiteOrNull), force: R.force };
    const record = { x: Array.from(sv.x), model: Array.from(modelRollSurface(sv), finiteOrNull) };
    const key = JSON.stringify(this.host.params());
    let job!: FistrJob;
    // the bridge runs one job at a time: the initial state's dry run (seconds) may still hold it
    for (let attempt = 0; ; attempt++) {
      try {
        job = await FistrJob.start('roll-coupled', { params: this.host.params(), load, substeps: SUBSTEPS, record }, {
          onMesh: () => { void this.loadMesh(job, key); },
          onFrame: (k) => { if (k > 0) void this.loadFrame(job, key, k, round); },
          onState: (st) => { void this.jobState(job, st.state, st.message, round); },
          onDisconnect: () => { if (this.job === job) this.fail('橋渡しに 5 分つながらないか、ジョブが無くなった（dev サーバーを再起動した？）— 計算開始で今の回からやり直す'); },
        });
        break;
      } catch (e) {
        const busy = e instanceof FistrError && /別の FrontISTR/.test(e.message);
        if (busy && attempt < 30 && this.phase === 'fistr') { await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (this.phase === 'fistr') this.fail(e instanceof FistrError ? `FrontISTR を始められない: ${e.message}` : String(e));
        return;
      }
    }
    if (this.phase !== 'fistr') { void job.cancel(); job.close(); return; }
    this.job = job;
  }

  private async jobState(job: FistrJob, state: JobState, message: string, round: number): Promise<void> {
    if (this.job !== job) return;
    if (state === 'failed') { this.fail(`FrontISTR が失敗: ${message || '理由不明'}（アプリだけの結果は残した）`); return; }
    if (state === 'cancelled') return;
    if (state !== 'done') { this.render(); return; }
    // the job is over: off the books before its answer is fetched, so a 'done' heard again (after a
    // cut the events resume from the start) is not taken twice
    this.job = null;
    const coupling = this.coupling;
    let res: CoupledResult;
    try {
      res = await job.result<CoupledResult>();
    } catch (e) {
      if (this.coupling === coupling && this.phase === 'fistr') this.fail(`FrontISTR の結果を読めない: ${(e as Error).message}`);
      return;
    }
    // stopped, or the settings changed, while the answer was on its way
    if (!coupling || this.coupling !== coupling || this.phase !== 'fistr') return;
    const sv = this.host.solver, R = sv.result;
    const fem = Float64Array.from(sv.x, (x, s) => (R.q[s] > 0 ? interpolateProfile(res.x, res.v, x) : NaN));
    const model = modelRollSurface(sv);
    const r = this.coupling.step(model, fem, R.force);
    this.lastFistrSeconds = (performance.now() - this.jobT0) / 1000;
    this.rounds.push({ ...r, seconds: this.lastFistrSeconds, fistrSeconds: this.lastFistrSeconds, nodes: res.nodes });
    this.surface = { fem, model };
    void round;
    if (r.converged) {
      this.phase = 'steady';
      this.halt();
      this.labelRolls();
    } else {
      sv.setRollCorrection(this.coupling.delta);
      this.phase = 'app';
      this.labelRolls();
      this.roundT0 = performance.now() - this.lastFistrSeconds * 1000;
      this.host.resume();
    }
    this.render();
    this.host.changed();
  }

  private fail(why: string): void {
    this.dropJob();
    this.phase = this.coupling ? 'failed' : 'idle';
    this.note = why;
    this.halt();
    this.labelRolls();
    this.render();
    this.host.changed();
  }

  private dropJob(): void {
    if (this.job) { void this.job.cancel(); this.job.close(); }
    this.job = null;
  }

  private startTicker(): void {
    if (!this.ticker) this.ticker = window.setInterval(() => { this.render(); this.host.changed(); }, 1000);
  }

  private stopTicker(): void {
    if (this.ticker) { clearInterval(this.ticker); this.ticker = 0; }
  }

  // ── contours ───────────────────────────────────────────────────────────

  /** the stage switched to the contours (or away) */
  setShown(on: boolean): void {
    this.shown = on;
    this.contourBox.hidden = !on;
    if (on && !this.view) {
      try {
        this.view = new ContourView3D(this.contourBox);
        // the bite first: in the whole mill the strip is a line between the rolls, and the contacts are hidden in it
        this.view.setView('bite');
      } catch (e) {
        this.contourBox.replaceChildren(el('div', 'v3-couple-nogl', `コンターを描けない: ${(e as Error).message}`));
        return;
      }
      this.stripKey = '';
      this.placedKey = '';
      if (this.mesh) { this.placeRolls(); this.labelRolls(); }
      this.scheduleDryRun(0);
    }
    this.host.changed();
  }

  /** the rolls' mesh of a job (the same settings keep the one they have) */
  private async loadMesh(job: FistrJob, key: string): Promise<void> {
    if (!this.mesh || this.meshKey !== key) {
      try {
        const m = decodeMesh(await job.mesh());
        this.mesh = m; this.meshKey = key;
      } catch (e) {
        console.warn('contour: rolls mesh', e);
        return;
      }
    }
    // the mesh at hand may not be the one on the view: a dry run of these settings that ended while
    // a round waited for the bridge keeps its mesh without placing it (the round's frames come next)
    if (this.placedKey !== this.meshKey) { this.placeRolls(); this.labelRolls(); }
  }

  /** the rolls' mesh at hand on the view (once for each settings' mesh) */
  private placeRolls(): void {
    const m = this.mesh, v = this.view;
    if (!m || !v) return;
    const placed = v.partNames();
    if (this.placedKey === this.meshKey && m.parts.every((p) => placed.includes(p.name))) return;
    for (const p of m.parts) v.setPart(p);
    this.placedKey = this.meshKey;
  }

  /** a substep's result on the rolls */
  private async loadFrame(job: FistrJob, key: string, k: number, round: number): Promise<void> {
    this.substep = Math.max(this.substep, k);
    this.render();
    await this.loadMesh(job, key);
    const m = this.mesh;
    if (!m || !this.view || this.meshKey !== key) return;
    try {
      const f = decodeFrame(await job.frame(k), m.header.nodeCount);
      // (the round may have ended while the frame was on its way: the label is the rounds' as they stand)
      const label = this.phase === 'fistr' && this.rounds.length < round ? { state: 'running' as const, text: `連成 ${round} 回目　荷重 ${k}/${SUBSTEPS}` } : this.rollsLabel();
      for (const h of m.header.parts) this.view.update(h.name, { ...partValues(m, f, h.name), label });
    } catch (e) {
      console.warn('contour: rolls frame', e);
    }
  }

  /** the rolls on show, unloaded and 計算前 (the mesh they have until a dry run brings the new settings') */
  private unloadRolls(): void {
    const m = this.mesh, v = this.view;
    if (!m || !v) return;
    this.placeRolls();
    for (const h of m.header.parts) {
      const n = h.nodeCount, zero = new Float32Array(n);
      v.update(h.name, { disp: new Float32Array(3 * n), fields: { mises: zero, cpress: zero }, label: { state: 'initial', text: '計算前' } });
    }
  }

  /** the rolls' label as the rounds stand */
  private rollsLabel(): { state: 'initial' | 'running' | 'steady' | 'stale'; text: string } {
    return this.phase === 'steady' ? { state: 'steady', text: `定常（${this.rounds.length} 回）` }
      : this.phase === 'stopped' || this.phase === 'failed'
        ? { state: 'stale', text: this.rounds.length ? `連成 ${this.rounds.length} 回目まで（${this.phase === 'failed' ? '失敗' : '停止'}）` : `連成 1 回目で${this.phase === 'failed' ? '失敗' : '停止'}` }
        : this.rounds.length ? { state: 'running', text: `連成 ${this.rounds.length} 回目まで` } : { state: 'initial', text: '計算前' };
  }

  /** the rolls' label when no frame is coming */
  private labelRolls(): void {
    const m = this.mesh, v = this.view;
    if (!m || !v) return;
    const label = this.rollsLabel();
    for (const h of m.header.parts) v.relabel(h.name, label);
  }

  /** the initial state's rolls: the mesh and frame 0 of a dry run (no fistr1), once the settings rest */
  private scheduleDryRun(ms = 900): void {
    clearTimeout(this.dryRunTimer);
    if (!this.enabled || !this.view) return;
    this.dryRunTimer = window.setTimeout(() => { void this.dryRun(); }, ms);
  }

  private async dryRun(): Promise<void> {
    if (this.dryRunBusy || this.phase === 'fistr' || !this.view) return;
    // no bridge (a built app): the rolls come with nothing, and asking again only fills the console
    if ((await this.bridge()) && !this.mesh) return;
    const key = JSON.stringify(this.host.params());
    // the same settings' mesh is at hand (a round's, or an earlier dry run's): frame 0 is the rolls unloaded
    if (this.mesh && this.meshKey === key && !this.rounds.length) { this.unloadRolls(); return; }
    const sv = this.host.solver;
    this.dryRunBusy = true;
    try {
      // no load: the mesh does not depend on it, and frame 0 is the unloaded rolls
      const zeros = new Array<number>(sv.ns).fill(0);
      const job = await FistrJob.start('roll-coupled', { params: this.host.params(), load: { q: zeros, arc: zeros, force: 0 }, dryRun: true }, {
        onState: (s) => {
          if (s.state !== 'done') return;
          void (async () => {
            try {
              if (key !== JSON.stringify(this.host.params()) || !this.view) return;
              const m = decodeMesh(await job.mesh());
              const f0 = decodeFrame(await job.frame(0), m.header.nodeCount);
              this.mesh = m; this.meshKey = key;
              // a round has the rolls now: it places this mesh with its first frame (`loadMesh`)
              if (this.phase === 'fistr' || this.rounds.length) return;
              this.placeRolls();
              for (const h of m.header.parts) this.view.update(h.name, { ...partValues(m, f0, h.name), label: { state: 'initial', text: '計算前' } });
            } catch (e) {
              console.warn('contour: dry run', e);
            }
          })();
        },
      });
      void job;
      this.dryRunTries = 0;
    } catch (e) {
      // busy (another page's dry run, or a job just ending): try again shortly; no bridge: the rolls come with the first round
      if (e instanceof FistrError && /別の FrontISTR/.test(e.message) && ++this.dryRunTries < 20) this.scheduleDryRun(3000);
    } finally {
      this.dryRunBusy = false;
    }
  }

  /** once per drawn frame: the strip's field when it changed, the status line */
  frame(R: Result3D, s: { running: boolean; stale: boolean; iterated: boolean }): void {
    this.render();
    if (!this.view || !this.shown) return;
    const p = this.host.params();
    this.view.setSource('strip', STRIP_SOURCE[p.stripModel] ?? '材料 FEM');
    // the rolls' stresses are FrontISTR's: without the coupling there are none to draw, and the plate says why
    this.view.setNote(!this.enabled ? 'ロールの応力は「ロールの変形」を FrontISTR と連成にすると描く'
      : this.phase === 'model' ? `ロールの応力は描けない: ${this.note}` : '');
    const F = R.fem?.field3d ?? null;
    // a solve has run on these settings (running now, stopped part way, or converged)
    const solved = s.running || s.iterated || !s.stale;
    // a field of these settings: made since they last changed
    const ours = !!F && F !== this.fieldAtChange && solved;
    if (!F && p.stripModel === 'slab' && solved) {
      // the slab model makes no field of the strip: the initial block, its values none (grey), and why
      if (this.stripKey !== 'absent') {
        if (this.stripKey !== 'initial') this.placeInitialStrip();
        this.view.update('strip', { disp: null, fields: {}, label: { state: 'absent', text: 'スラブ法には板の場が無い。「材料の変形計算」を FEM にすると描く' } });
        this.stripField = null; this.stripKey = 'absent';
      }
    } else if (F && ours) {
      const n = this.rounds.length;
      // A solve given up, or stopped part way, is not steady: said so before the rounds' phase, which a
      // give-up leaves at 'stopped' and a stop without the coupling never moves from 'idle'. Given up, the
      // plate carries the reason, as the stage's note does in the other views (hidden under the contours).
      const stall = this.host.solver.stall;
      const [state, text]: ['running' | 'steady' | 'stale', string] = s.running
        ? ['running', n ? `補正を入れて解き直し中（連成 ${n + 1} 回目の前）` : '反復中']
        : this.phase === 'fistr' ? ['running', `ロールの計算待ち（連成 ${n + 1} 回目）`]
          : this.phase === 'steady' ? ['steady', `定常（連成 ${n} 回）`]
            : stall ? ['stale', `計算停止（解けない）: ${stallText(stall, p).why}`]
              : this.phase === 'stopped' || this.phase === 'failed' ? ['stale', `連成は ${n} 回目まで（${this.phase === 'failed' ? '失敗' : '停止'}）`]
                : this.phase === 'app' ? ['running', '反復中']
                  : s.stale ? ['stale', '途中で停止（計算再開で続き）']
                    : ['steady', this.enabled ? '収束' : '収束（ロールはモデルだけ）'];
      const key = `${state}|${text}`;
      if (F !== this.stripField || key !== this.stripKey) {
        if (F !== this.stripField) this.view.setPart({ name: 'strip', kind: 'strip', coords: F.coords, tris: F.tris, symmetry: { x: false, y: true, z: false } });
        this.view.update('strip', { disp: null, fields: F.fields as unknown as Record<string, Float32Array>, label: { state, text } });
        this.stripField = F; this.stripKey = key;
      }
    } else if (this.stripKey !== 'initial') {
      // before a solve on these settings: the rigid-roll gap, nothing strained or stressed
      const values = this.placeInitialStrip();
      this.view.update('strip', { ...values, label: { state: 'initial', text: '計算前' } });
      this.stripField = null; this.stripKey = 'initial';
    }
  }

  /** the strip before a solve - the rigid-roll gap's block - placed on the view; its values all zero */
  private placeInitialStrip(): Omit<FieldValues, 'label'> {
    const p = this.host.params();
    const st = synthStrip(-1, {
      wrR: p.wrD / 2, wrLb: p.wrLb, wrLs: p.wrLs, wrRn: p.wrDn / 2, burR: p.burD / 2, burLb: p.burLb, burLs: p.burLs, burRn: p.burDn / 2,
      width: p.width, h0: p.h0, h1: p.h0 * (1 - p.reduction), backTension: p.backTension, frontTension: p.frontTension, v1: 1,
    }, { arc: 8, barrel: 4, neck: 2, cut: 4, ring: 2, nx: 41, rows: 13, lay: 3 });
    this.view!.setPart(st.part);
    return st.values;
  }

  // ── what is shown ──────────────────────────────────────────────────────

  /** the FrontISTR values and the uncoupled pass over the charts (the cross-check's white dashes) */
  overlays(R: Result3D): { defl: XYSeries[]; flat: XYSeries[]; gauge: XYSeries[] } {
    const out = { defl: [] as XYSeries[], flat: [] as XYSeries[], gauge: [] as XYSeries[] };
    if (!this.enabled) return out;
    const sv = this.host.solver, x = sv.x;
    if (this.surface && x.length === this.surface.fem.length) {
      // the work roll's surface (axis + indentation), on the model's screw-roll bearings like the deflections drawn
      const screw = sv.rolls[sv.stack.screwRolls[0]];
      let vb = 0;
      for (const s of screw.supports) vb += screw.v[s];
      vb /= Math.max(screw.supports.length, 1);
      const um = (a: Float64Array) => Float64Array.from(a, (v) => (Number.isFinite(v) ? (v + vb) * 1e6 : NaN));
      out.defl.push({ label: 'WR 表面 FrontISTR', color: '#ffffff', dash: true, width: 2, x, y: um(this.surface.fem) });
      out.defl.push({ label: 'WR 表面 モデル', color: '#8ea0bd', dash: true, width: 1.5, x, y: um(this.surface.model) });
    }
    if (this.coupling && this.rounds.length) {
      const d = this.coupling.delta;
      out.flat.push({ label: '連成の補正 δ（FrontISTR − モデル）', color: '#ffffff', dash: true, width: 2, x, y: Float64Array.from(d, (v, s) => (R.q[s] > 0 ? v * 1e6 : NaN)) });
    }
    if (this.uncoupled && this.rounds.length && this.uncoupled.x.length === R.x.length) {
      const u = this.uncoupled;
      const centre = (a: ArrayLike<number>) => {
        for (let i = 1; i < a.length; i++) {
          const x0 = u.x[i - 1], x1 = u.x[i];
          if (x0 <= 0 && x1 >= 0 && Number.isFinite(a[i - 1]) && Number.isFinite(a[i])) return a[i - 1] + (a[i] - a[i - 1]) * (-x0 / (x1 - x0));
        }
        return NaN;
      };
      const c = centre(u.h1);
      out.gauge.push({ label: '出側 h₁ 連成なし（モデルだけ）', color: '#8ea0bd', dash: true, width: 2, x: u.x, y: Float64Array.from(u.h1, (v) => (v - c) * 1e6) });
    }
    return out;
  }

  /** the status line and the panel's numbers */
  private render(): void {
    const now = performance.now();
    const R = this.host.solver.result;
    const last = this.rounds[this.rounds.length - 1];
    const round = this.phase === 'steady' ? this.rounds.length : this.rounds.length + 1;
    type Cell = [string, string, string?];
    const cells: Cell[] = [];
    let tone = 'idle', head = '連成';
    if (!this.enabled) {
      tone = 'off'; head = '連成なし';
      cells.push(['', 'ロールはモデルだけ（解析・表示 ▸ ロールの変形）']);
    } else if (this.phase === 'idle') {
      cells.push(['', '計算開始で、モデルの収束のあと FrontISTR と定常まで']);
    } else if (this.phase === 'model') {
      tone = 'warn'; head = '連成できない';
      cells.push(['', this.note]);
    } else {
      if (this.phase === 'steady') { tone = 'ok'; head = '定常'; }
      else if (this.phase === 'failed') { tone = 'bad'; head = '連成 失敗'; }
      else if (this.phase === 'stopped') { tone = 'warn'; head = '連成 停止'; }
      else tone = 'run';
      cells.push(['', this.phase === 'steady' ? `${this.rounds.length} 回` : `${round} 回目`]);
      if (this.phase === 'app') cells.push(['', this.rounds.length ? '補正を入れてアプリで解き直し中' : 'アプリで収束させている']);
      if (this.phase === 'fistr') cells.push(['FrontISTR', `計算中 ${mmss((now - this.jobT0) / 1000)}（荷重 ${this.substep}/${SUBSTEPS}）`]);
      if (this.phase === 'failed' || this.phase === 'stopped') cells.push(['', this.note || '計算開始で次の回から続ける']);
      if (last) {
        cells.push(['δ の動き', `${(last.change * 1e6).toFixed(2)} µm`, `≤ ${TOL_SURFACE * 1e6}`]);
        cells.push(['荷重の変化', Number.isFinite(last.forceChange) ? `${(last.forceChange * 100).toFixed(3)} %` : '—', `≤ ${TOL_FORCE * 100}`]);
        cells.push(['1 回', mmss(last.fistrSeconds)]);
      }
      const total = this.runT0 ? ((this.runEnd || now) - this.runT0) / 1000 : 0;
      if (this.phase === 'steady') cells[0] = ['', `${this.rounds.length} 回、${clock(total)}`];
      else if (total) cells.push(['経過', mmss(total)]);
    }
    const sig = `${tone}|${head}|${cells.map((c) => c.join('\u0002')).join('\u0001')}`;
    if (this.row.dataset.sig !== sig) {
      this.row.dataset.sig = sig;
      this.row.dataset.tone = tone;
      const h = el('span', 'v3-couple-head');
      h.append(el('i', 'v3-couple-dot'), el('b', '', head));
      this.row.replaceChildren(h, ...cells.map(([k, v, lim]) => {
        const c = el('span', 'v3-couple-cell');
        if (k) c.append(el('span', 'v3-couple-key', k));
        c.append(el('span', 'v3-couple-val', v));
        if (lim) c.append(el('span', 'v3-couple-lim', lim));
        return c;
      }));
    }
    // the panel
    const g = this.stats;
    const stateText = { idle: '未計算', app: 'アプリで収束中', fistr: 'FrontISTR 計算中', steady: '定常', stopped: '停止', failed: '失敗', model: '連成できない' }[this.phase];
    g.set('state', this.note && (this.phase === 'failed' || this.phase === 'model') ? `${stateText}: ${this.note}` : stateText,
      this.phase === 'steady' ? 'ok' : this.phase === 'failed' ? 'bad' : this.phase === 'model' || this.phase === 'stopped' ? 'warn' : undefined, false);
    const elapsed = this.runT0 ? clock(((this.runEnd || now) - this.runT0) / 1000) : '—';
    g.set('rounds', this.rounds.length ? `${this.rounds.length} / ${elapsed}` : this.phase === 'idle' ? '—' : `0 / ${elapsed}`, undefined, false);
    const u = this.uncoupled, have = !!u && this.rounds.length > 0;
    const pair = (a: number | undefined, b: number, f: (v: number) => string) => (u && a !== undefined ? `${f(a)} / ${have ? f(b) : '—'}` : '—');
    g.set('force', pair(u?.force, R.force, (v) => (v / TONF).toFixed(1)));
    g.set('crown', pair(u?.crown, R.crown, (v) => (v * 1e6).toFixed(1)));
    g.set('edge', pair(u?.edgeL, R.edgeDropL, (v) => (v * 1e6).toFixed(1)));
    g.set('latent', pair(u?.latent, R.latentIU, (v) => v.toFixed(0)));
    if (this.coupling && this.rounds.length) {
      const d = this.coupling.delta;
      let m = 0;
      for (const v of d) m = Math.max(m, Math.abs(v));
      g.set('delta', `${(d[(d.length - 1) >> 1] * 1e6).toFixed(2)} / ${(m * 1e6).toFixed(2)}`);
      g.set('move', `${(last.change * 1e6).toFixed(2)} µm / ${Number.isFinite(last.forceChange) ? (last.forceChange * 100).toFixed(3) : '—'} %`, last.converged ? 'ok' : undefined, false);
      g.set('fistr', `${clock(last.fistrSeconds)} / ${last.nodes.toLocaleString()}`, undefined, false);
    } else {
      for (const k of ['delta', 'move', 'fistr']) g.set(k, '—', undefined, false);
    }
  }

  /** the rounds so far, for checks */
  get record(): { phase: CouplePhase; rounds: RoundRecord[]; delta: number[] | null; note: string } {
    return { phase: this.phase, rounds: [...this.rounds], delta: this.coupling ? Array.from(this.coupling.delta) : null, note: this.note };
  }

  /** the contour view (for checks and the stage's own use) */
  get contour(): ContourView3D | null { return this.view; }
}
