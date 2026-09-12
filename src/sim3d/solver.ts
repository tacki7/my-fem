/**
 * The roll-stack solve: every roll a Timoshenko beam along the width, held
 * to its neighbours by Hertz line contacts and to the housing by its
 * supports, the strip a row of slab passes under the work roll.
 *
 * One Newton iteration per call, so the state advances a little every frame
 * and the picture is live; a change to any input just makes the next
 * iterations move. Unknowns are the nodal displacements of every roll,
 * (v, θ_v, w, θ_w) at each station - deflection and slope in the vertical
 * plane and across the pass line. All rolls share one grid of stations, so
 * a contact between two rolls couples only the two nodes at the same
 * station, and numbering station by station keeps the whole system inside a
 * band a few hundred wide (see `band.ts`).
 *
 * The screw is not an unknown of that system. In gauge or force control it
 * is stepped between Newton iterations by a secant on what the last solve
 * delivered, which converges in a handful of frames and keeps the matrix
 * symmetric positive definite.
 */

import { BandMatrix, denseSolve } from './band';
import { makeContactLaw, loadAt, approach, approachParts, type ContactLaw } from './contact';
import { ringInfluence, type RingInfluence } from './ring';
import {
  sliceLoad, springback, kfMean, kfExitOf, TENSION_CAP, type StripLaw,
} from './strip';
import {
  buildStack, radiusProfile, onBarrel, type Params3D, type Stack, type RollDef,
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
/** the thinnest exit a slice may report, as a fraction of its entry thickness */
const H_MIN_FRAC = 0.05;
/** the residual is measured against the largest force in play, but never against less than this [N] */
const F_SCALE_FLOOR = 1e4;
/** the screw's travel [m]: negative is opened past the touching position */
const SCREW_MIN = -10e-3;
const SCREW_MAX = 20e-3;
/** outer iterations after which a solve that has not settled is called stuck */
const STUCK_ITERS = 150;
const NO_LOAD = { q: 0, arc: 0, runaway: false } as const;
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
}

export interface ContactState {
  a: number;
  b: number;
  ny: number;
  nz: number;
  law: ContactLaw;
  /** per station: contact width weight [m], 0 outside */
  weight: Float64Array;
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

export type Warning3D = 'stone' | 'bite' | 'gapClosed' | 'tensionYield' | 'stuck' | 'target' | 'layout' | 'openContact';
export const WARNING_TEXT: Record<Warning3D, string> = {
  stone: 'Stone 限界: 扁平が先行し圧下できない（板厚に対してロール径が大きい）',
  bite: '噛み込み限界超過 (μ < tan α)',
  gapClosed: 'ロールギャップが閉じている（圧下位置が深すぎる）',
  tensionYield: '張力が降伏に近い（変形抵抗の 70% 超）',
  stuck: '未収束（残差が下がらない）',
  target: '制御目標に届かない',
  layout: 'ロール配置が成立していない（端面図の赤い線）',
  openContact: '上下のロールが離れている接触がある（端面図の破線）',
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
  /** flatness, as the peak-to-peak of the latent and manifest elongation [I-units = 1e-5] */
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
  /** last solve time [ms] */
  solveMs: number;
  dof: number;
  bandwidth: number;
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
}

export class StackSolver {
  p: Params3D;
  stack!: Stack;
  x!: Float64Array;
  dx = 0;
  ns = 0;
  nr = 0;
  rolls: RollState[] = [];
  contacts: ContactState[] = [];
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
    if (key !== this.geomKey) this.rebuild();
    else this.refreshProfiles();
    this.converged = false;
    this.yAge = -1;
    this.iterations = 0;
  }

  private rebuild(): void {
    const p = this.p;
    this.geomKey = geometryKey(p);
    this.stack = buildStack(p);
    const rolls = this.stack.rolls;
    // the grid spans the longest support span, plus whatever a shift pushes out
    let half = 0;
    for (const r of rolls) half = Math.max(half, r.Ls / 2 + Math.abs(r.shift), r.Lb / 2 + Math.abs(r.shift));
    half = Math.max(half, p.width / 2 * 1.05);
    this.ns = Math.max(11, Math.round(p.stations) | 1);
    this.nr = rolls.length;
    this.dx = (2 * half) / (this.ns - 1);
    this.x = new Float64Array(this.ns);
    for (let s = 0; s < this.ns; s++) this.x[s] = -half + s * this.dx;
    const n = this.ns * this.nr * DOF;
    this.u = new Float64Array(n);
    this.K = new BandMatrix(n, this.nr * DOF + DOF - 1);
    this.rhs = new Float64Array(n);
    this.du = new Float64Array(n);
    this.scratch = new Float64Array(n);
    this.uTrial = new Float64Array(n);
    this.screw = p.mode === 'screw' ? p.screw : this.screw;
    this.secant = null;

    this.rolls = rolls.map((def) => {
      const prof = new Float64Array(this.ns);
      const barrel = new Uint8Array(this.ns);
      const st = this.stationOf;
      const ia = st(def.shift - def.Ls / 2), ib = st(def.shift + def.Ls / 2);
      const supports: number[] = [];
      if (def.support === 'saddle') {
        for (let k = 0; k < def.saddles; k++) {
          const t = def.saddles === 1 ? 0 : -1 + (2 * k) / (def.saddles - 1);
          supports.push(st(def.shift + (t * def.Ls) / 2 * 0.92));
        }
      } else {
        supports.push(ia, ib);
      }
      return {
        def, ia, ib, supports, prof, barrel,
        v: new Float64Array(this.ns).fill(NaN), w: new Float64Array(this.ns).fill(NaN),
        reactions: supports.map(() => 0),
        bow: 0, vMax: 0, flatMax: 0,
      };
    });
    this.contacts = this.stack.contacts.map((c) => {
      const A = rolls[c.a], B = rolls[c.b];
      return {
        a: c.a, b: c.b, ny: c.ny, nz: c.nz,
        law: makeContactLaw(A.E, A.nu, A.D / 2, B.E, B.nu, B.D / 2),
        weight: new Float64Array(this.ns), q: new Float64Array(this.ns), delta: new Float64Array(this.ns),
        dA: new Float64Array(this.ns), dB: new Float64Array(this.ns),
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

  private stationOf = (x: number): number =>
    Math.max(0, Math.min(this.ns - 1, Math.round((x - this.x[0]) / this.dx)));

  /** things that change without changing the mesh: profiles, strip width, laws */
  private refreshProfiles(): void {
    const p = this.p;
    this.stack = buildStack(p);
    const rolls = this.stack.rolls;
    this.rolls.forEach((r, i) => {
      r.def = rolls[i];
      r.def.benderForce = rolls[i].benderForce;
      for (let s = 0; s < this.ns; s++) {
        r.prof[s] = radiusProfile(r.def, this.x[s]);
        r.barrel[s] = onBarrel(r.def, this.x[s]) ? 1 : 0;
      }
    });
    const cell = (s: number): [number, number] => [this.x[s] - this.dx / 2, this.x[s] + this.dx / 2];
    const overlap = (a: [number, number], b: [number, number]) =>
      Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
    for (const c of this.contacts) {
      const A = rolls[c.a], B = rolls[c.b];
      const ba: [number, number] = [A.shift - A.Lb / 2, A.shift + A.Lb / 2];
      const bb: [number, number] = [B.shift - B.Lb / 2, B.shift + B.Lb / 2];
      for (let s = 0; s < this.ns; s++) {
        const [c0, c1] = cell(s);
        const lo = Math.max(c0, ba[0], bb[0]), hi = Math.min(c1, ba[1], bb[1]);
        c.weight[s] = Math.max(0, hi - lo);
      }
    }
    for (const c of this.contacts) {
      c.law.ring1 = this.ringFor(rolls[c.a]);
      c.law.ring2 = this.ringFor(rolls[c.b]);
    }
    const wr = rolls[this.stack.wr];
    this.law = {
      lmnL: p.lmnL, lmnM: p.lmnM, lmnN: p.lmnN, E: p.Estrip, nu: p.nuStrip,
      entryStrain: p.entryStrain, mu: p.mu, R: wr.D / 2, Eroll: wr.E, nuRoll: wr.nu,
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
      const t = (2 * xc) / p.width;
      const h0 = p.h0 - p.entryCrown * t * t;
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

  private idx(s: number, r: number, d: number): number { return (s * this.nr + r) * DOF + d; }

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
        const L = this.dx;
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
          const k = d === 0 || d === 2 ? K_REG : K_REG * this.dx * this.dx;
          addK(i, i, k); rhs[i] -= k * u[i];
        }
      }
    }

    // ── supports ──
    const lev = p.leveling;
    for (let r = 0; r < nr; r++) {
      const R = rolls[r];
      const d = R.def;
      const moves = this.stack.screwRolls.includes(r);
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
          case 'screw': ky = p.housingK; kz = K_GUIDE; break;
          case 'saddle': ky = p.housingK; kz = p.housingK; break;
          case 'chock': ky = K_CHOCK_Y; kz = K_GUIDE; fy = d.benderForce; break;
          case 'free': return;
        }
        addK(iv, iv, ky); addK(iw, iw, kz);
        const ry = ky * (ty - u[iv]) + fy;
        rhs[iv] += ry;
        rhs[iw] += kz * (tz - u[iw]);
        R.reactions[k] = d.support === 'chock' ? fy : -ky * (ty - u[iv]);
        fScale = Math.max(fScale, Math.abs(ry));
      });
    }

    // ── roll-roll contacts ──
    for (const c of this.contacts) {
      const A = rolls[c.a], B = rolls[c.b];
      c.total = 0;
      for (let s = 0; s < ns; s++) {
        const w = c.weight[s];
        if (w <= 0) { c.q[s] = 0; c.delta[s] = 0; continue; }
        const ia = this.idx(s, c.a, 0), ib = this.idx(s, c.b, 0);
        const gapChange = (u[ib] - u[ia]) * c.ny + (u[ib + 2] - u[ia + 2]) * c.nz;
        const delta = A.prof[s] + B.prof[s] - gapChange;
        const [q, kt0] = loadAt(c.law, delta, c.q[s]);
        c.q[s] = q; c.delta[s] = delta;
        c.total += q * w;
        const f = q * w;
        rhs[ia] -= f * c.ny; rhs[ia + 2] -= f * c.nz;
        rhs[ib] += f * c.ny; rhs[ib + 2] += f * c.nz;
        fScale = Math.max(fScale, f);
        if (!withK || delta <= 0) continue;
        const kt = Math.max(kt0, KT_FLOOR) * w;
        const nn = [c.ny, c.nz];
        for (let i = 0; i < 2; i++) {
          for (let j = 0; j < 2; j++) {
            const k = kt * nn[i] * nn[j];
            if (k === 0) continue;
            // the band keeps the lower half: within a node the (v, w) cross
            // term is one entry, so it is added once; between the nodes the
            // (a, b) and (b, a) blocks are transposes and the band stores
            // only (b, a), so all four entries of the block are needed
            if (j <= i) { K.add(ia + 2 * i, ia + 2 * j, k); K.add(ib + 2 * i, ib + 2 * j, k); }
            K.add(ia + 2 * i, ib + 2 * j, -k);
          }
        }
      }
    }

    // ── the strip under the work roll ──
    // Already solved at this u and σ by `stripSolve`, which runs before
    // every assembly; only its results are read here.
    let force = 0, h1w = 0, wsum = 0;
    this.slices.forEach((sl, i) => {
      const iv = this.idx(sl.s, this.stack.wr, 0);
      const f = sl.q * sl.weight;
      rhs[iv] += f;
      force += f;
      h1w += sl.h1 * sl.weight; wsum += sl.weight;
      fScale = Math.max(fScale, f);
      if (!withK) return;
      // The gap term of the tangent goes in the band. The tension term -
      // a slice rolled thinner is longer, goes slack, and is loaded harder,
      // through the whole strip's elongation balance - couples every slice
      // to every other and is applied in `iterate` as a Woodbury update.
      K.add(iv, iv, Math.max(0, -2 * sl.dqdg) * sl.weight);
      this.dqds[i] = sl.q > 0 ? sl.dqds : 0;
      if (TENSION_COUPLING === 'diag' && this.tensionLive) {
        const m = this.slices.length;
        K.add(iv, iv, Math.max(0, -sl.weight * this.dqds[i] * this.T[i * m + i]));
      }
    });
    this.forceTotal = force;
    this.h1Mean = wsum > 0 ? h1w / wsum : p.h0;

    let res = 0;
    for (let i = 0; i < rhs.length; i++) res += rhs[i] * rhs[i];
    return Math.sqrt(res) / fScale;
  }

  /** one Newton iteration on the stack, with a backtracking line search */
  iterate(): void {
    const t0 = performance.now();
    const { K, rhs, u, du } = this;
    this.stripSolve(TENSION_COUPLING !== 'none');
    const res0 = this.assemble(true);
    if (!K.cholesky()) { this.residual = Infinity; this.converged = false; return; }
    K.solve(rhs, du);
    // Woodbury for the strip's tension coupling, K_full = K + U M Uᵀ with
    // U the work-roll v-DOFs of the slices and M = -diag(w dq/dσ) T:
    //   x_full = x - Y M (I + G M)⁻¹ Uᵀ x,   Y = K⁻¹U,  G = UᵀY.
    // M is not inverted (a clipped slice has a zero row), so this is the
    // form that only needs I + G M, which is m×m dense with m the slices.
    const m = this.slices.length;
    if (USE_WOODBURY && this.tensionLive && m > 0) {
      const n = du.length;
      const Y = this.woodburyY(n, m);
      const e = this.scratch;
      const cols = this.slices.map((sl) => this.idx(sl.s, this.stack.wr, 0));
      if (this.yAge >= Y_REUSE || this.yAge < 0) {
        for (let j = 0; j < m; j++) {
          e.fill(0); e[cols[j]] = 1;
          K.solveUnit(cols[j], e);
          Y.set(e, j * n);
        }
        this.yAge = 0;
      }
      this.yAge++;
      // M = -diag(w dqds) T ; A = I + G M
      const M = new Float64Array(m * m), A = new Float64Array(m * m);
      for (let i = 0; i < m; i++) {
        const wi = -this.slices[i].weight * this.dqds[i];
        for (let j = 0; j < m; j++) M[i * m + j] = wi * this.T[i * m + j];
      }
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
          // G_ik = Y[k][cols[i]]
          let s = 0;
          for (let k = 0; k < m; k++) s += Y[k * n + cols[i]] * M[k * m + j];
          A[i * m + j] = (i === j ? 1 : 0) + s;
        }
      }
      const z = new Float64Array(m);
      for (let i = 0; i < m; i++) z[i] = du[cols[i]];
      if (denseSolve(A, m, z)) {
        // du -= Y (M z)
        for (let k = 0; k < m; k++) {
          let mz = 0;
          for (let j = 0; j < m; j++) mz += M[k * m + j] * z[j];
          if (mz === 0) continue;
          const off = k * n;
          for (let i = 0; i < n; i++) du[i] -= Y[off + i] * mz;
        }
      }
    }
    let mx = 0;
    for (let i = 0; i < du.length; i++) {
      // slopes are scaled by dx so the clip means the same thing for them
      const d = i % 2 === 0 ? du[i] : du[i] * this.dx;
      mx = Math.max(mx, Math.abs(d));
    }
    const clip = mx > STEP_CLIP ? STEP_CLIP / mx : 1;
    // backtracking: the residual has to come down, or the step is shortened
    // (a contact opening or the strip lifting off is not something a
    // tangent knows about)
    const base = this.uTrial;
    base.set(u);
    let alpha = clip;
    let res = Infinity;
    for (let tries = 0; tries < 5; tries++) {
      for (let i = 0; i < u.length; i++) u[i] = base[i] + alpha * du[i];
      this.stripSolve(false);
      res = this.assemble(false);
      if (res < res0 * (1 - 1e-3 * alpha / clip) || res < 1e-7) break;
      alpha *= 0.4;
    }
    this.debug = { alpha, res0, res, mx, tries: 0 };
    this.residual = res;
    this.stepMax = mx * alpha;
    this.iterations++;
    this.result.solveMs = performance.now() - t0;
  }

  private woodburyY(n: number, m: number): Float64Array {
    if (!this.Ybuf || this.Ybuf.length !== n * m) { this.Ybuf = new Float64Array(n * m); this.yAge = -1; }
    return this.Ybuf;
  }

  /**
   * The slice's load at a rigid gap g: q = P(h1), h1 = g + 2 δ_ws(q) + springback.
   *
   * φ(q) = q − P(h1(q)) is increasing in q: a heavier load flattens the
   * roll more, which opens the gap, which lowers the load the gap asks
   * for. So the root is bracketed and a Newton step that leaves the
   * bracket is replaced by a bisection - a plain Newton overshoots on a
   * steep pass (high friction, foil), lands where the gap has opened, sees
   * no contact, and oscillates between zero and a huge load.
   */
  private sliceCore(sl: Slice, g: number, sigmaF: number, qStart: number): SliceState {
    const p = this.p;
    const law = this.law;
    // The width the flattening is spread over is frozen for this call at
    // the slice's last arc: φ(q) has to be one fixed function for the
    // bracket to mean anything (an arc taken from the current iterate made
    // a third of the calls run to the iteration cap). It catches up one
    // outer iteration later, which is where the tangent is taken anyway.
    const ws = this.wsLaw;
    ws.bFloor = Math.max(0, sl.arc / 2);
    const P = (h1: number, guess: number) => sliceLoad(law, sl.h0, h1, p.backTension, sigmaF, guess);
    let q = Math.max(qStart, 0);
    // a cold slice starts from the load the rigid gap would take, which is
    // near the root; doubling up from nothing took a dozen rounds
    if (q <= 0 && g < sl.h0) q = P(g, 0).q;
    let h1 = sl.h0, flat = 0, arc = sl.arc, runaway = false;
    const hMin = H_MIN_FRAC * sl.h0;
    const dh = 1e-3 * sl.h0;
    let lo = 0, hi = Infinity;
    let itDone = 0;
    for (let it = 0; it < 25; it++) {
      itDone = it + 1;
      const [d, dd] = approach(ws, q);
      flat = d;
      const hRigid = Math.max(g + 2 * d, hMin);
      h1 = hRigid + springback(law, Math.min(hRigid, sl.h0), kfExitOf(law, sl.h0, hRigid), sigmaF);
      const open = h1 >= sl.h0;
      const r = open ? NO_LOAD : P(h1, q);
      arc = r.arc; runaway = r.runaway;
      const phi = q - r.q;
      if (Math.abs(phi) <= 1e-6 * Math.max(q, 1)) { if (open) q = 0; break; }
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
  private solveSlice(sl: Slice, g: number, sigmaF: number): SliceState & {
    dqdg: number; dqds: number; dh1dg: number; dh1ds: number;
  } {
    const base = this.sliceCore(sl, g, sigmaF, sl.q);
    if (base.q <= 0) return { ...base, dqdg: 0, dqds: 0, dh1dg: 1, dh1ds: 0 };
    const dg = 2e-3 * sl.h0;
    const ds = Math.max(1e6, 0.02 * Math.abs(sigmaF));
    const atG = this.sliceCore(sl, g - dg, sigmaF, base.q);
    const atS = this.sliceCore(sl, g, sigmaF + ds, base.q);
    return {
      ...base,
      dqdg: (base.q - atG.q) / dg,
      dqds: (atS.q - base.q) / ds,
      dh1dg: (base.h1 - atG.h1) / dg,
      dh1ds: (atS.h1 - base.h1) / ds,
    };
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
   * The outer Newton then takes dσ/dv = J⁻¹ F_h h_v on the settled set.
   */
  private stripSolve(withJacobian: boolean): void {
    const p = this.p;
    const n = this.slices.length;
    if (n === 0) return;
    const u = this.u;
    const wrR = this.rolls[this.stack.wr];
    const w = new Float64Array(n);
    let ws = 0;
    this.slices.forEach((sl, i) => { w[i] = sl.weight; ws += w[i]; });
    // lateral flow: a slice cannot be much longer than its neighbours over a
    // distance of a few thicknesses - smooth the differential over lateralLen
    const S = new Float64Array(n * n);
    const sig = p.lateralLen;
    const rad = sig > 0 ? Math.ceil((3 * sig) / this.dx) : 0;
    for (let i = 0; i < n; i++) {
      let norm = 0;
      for (let j = Math.max(0, i - rad); j <= Math.min(n - 1, i + rad); j++) {
        const dxij = sig > 0 ? (this.slices[j].x - this.slices[i].x) / sig : 0;
        const g = (sig > 0 ? Math.exp(-0.5 * dxij * dxij) : i === j ? 1 : 0) * w[j];
        S[i * n + j] = g; norm += g;
      }
      if (norm > 0) for (let j = 0; j < n; j++) S[i * n + j] /= norm;
    }
    const Eeff = p.Estrip / (1 - p.nuStrip * p.nuStrip);
    // the strip yields in tension near its resistance: cap there
    const e0 = Math.max(p.entryStrain, 0);
    const hi = TENSION_CAP * kfMean(this.law, e0, e0 + 1.1547 * Math.log(1 / (1 - p.reduction)));
    const lo = -p.sigmaCr;
    const dDde = (i: number, j: number) => S[i * n + j] - w[j] / ws;

    const sigma = new Float64Array(n);
    /** 0 = live, -1 = held at lo, +1 = held at hi */
    const held = new Int8Array(n);
    this.slices.forEach((sl, i) => {
      sigma[i] = Math.max(lo, Math.min(hi, this.sigmaF[sl.s]));
      held[i] = sigma[i] <= lo ? -1 : sigma[i] >= hi ? 1 : 0;
    });
    const eps = new Float64Array(n), D = new Float64Array(n), free = new Float64Array(n);
    const Fh = new Float64Array(n * n), J = new Float64Array(n * n), r = new Float64Array(n);
    const colTerm = new Float64Array(n);
    let lambda = 0;

    const evalSlices = (onlyLive: boolean) => {
      this.slices.forEach((sl, i) => {
        if (onlyLive && held[i] !== 0) return;
        const g = p.h0 + 2 * (u[this.idx(sl.s, this.stack.wr, 0)] - wrR.prof[sl.s]);
        const out = this.solveSlice(sl, g, sigma[i]);
        sl.g = g; sl.q = out.q; sl.h1 = out.h1; sl.flat = out.flat; sl.arc = out.arc; sl.runaway = out.runaway;
        sl.dh1dg = out.dh1dg; sl.dh1ds = out.dh1ds; sl.dqdg = out.dqdg; sl.dqds = out.dqds;
        eps[i] = sl.q > 0 ? Math.log(sl.h0 / Math.max(sl.h1, 1e-9)) : 0;
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
      lambda = wL > 0 ? (ws * p.frontTension - sumC - sumL) / wL : 0;
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
          Fh[i * n + j] = held[i] === 0 ? Eeff * (colTerm[j] - dDde(i, j)) * dedh : 0;
        }
      }
      return wL;
    };
    const buildJ = () => {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          // a held slice does not move: identity row and no column influence
          const jj = held[j] === 0 ? this.slices[j].dh1ds : 0;
          J[i * n + j] = (i === j ? 1 : 0) - Fh[i * n + j] * jj;
        }
      }
    };

    evalSlices(false);
    if (this.counters) this.counters.stripCalls++;
    for (let round = 0; round < 10; round++) {
      if (this.counters) this.counters.rounds++;
      // Newton on the live slices, the held ones fixed
      for (let it = 0; it < 8; it++) {
        if (this.counters) this.counters.inner++;
        evalFree();
        let rn = 0;
        for (let i = 0; i < n; i++) { r[i] = held[i] === 0 ? sigma[i] - free[i] : 0; rn = Math.max(rn, Math.abs(r[i])); }
        if (rn < 5e4) break;
        buildFh();
        buildJ();
        const step = new Float64Array(n);
        for (let i = 0; i < n; i++) step[i] = -r[i];
        if (!denseSolve(J, n, step)) break;
        for (let i = 0; i < n; i++) if (held[i] === 0) sigma[i] += Math.max(-4e8, Math.min(4e8, step[i]));
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
    this.slices.forEach((sl, i) => {
      this.sigmaF[sl.s] = sigma[i];
      sl.clipped = held[i] !== 0;
      this.dEps[sl.s] = D[i];
      // a held-slack slice's excess elongation is a wave; past the yield cap it is stretch, not a wave
      this.manifest[sl.s] = held[i] < 0 ? Math.max(0, (sigma[i] - free[i]) / Eeff) : 0;
    });
    if (!withJacobian) return;
    // T = dσ/dv = J⁻¹ F_h h_v, h_v = diag(2 dh1/dg)
    const wL = buildFh();
    this.tensionLive = wL > 1e-9 * ws;
    const T = this.T;
    T.fill(0);
    if (!this.tensionLive) return;
    buildJ();
    const col = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const hv = 2 * this.slices[j].dh1dg;
      for (let i = 0; i < n; i++) col[i] = Fh[i * n + j] * hv;
      const A = Float64Array.from(J);
      if (!denseSolve(A, n, col)) { T.fill(0); this.tensionLive = false; return; }
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
      const settled = this.residual < 2e-6 && this.stepMax < 5e-9;
      if (settled) {
        if (this.screwSettled()) { this.converged = true; break; }
        this.stepScrew();
        this.converged = false;
      }
      if (performance.now() - t0 > budgetMs) break;
    }
    this.collect(n, performance.now() - t0);
    return moved;
  }

  private emptyResult(): Result3D {
    const ns = this.ns;
    const nan = () => new Float64Array(ns).fill(NaN);
    return {
      x: this.x, rolls: this.rolls, contacts: this.contacts,
      h0: nan(), h1: nan(), q: nan(), flat: nan(), dEps: nan(), manifest: nan(), sigmaF: nan(),
      force: 0, h1Mean: this.p.h0, h1Centre: this.p.h0, crown: 0, wedge: 0, edgeDropL: 0, edgeDropR: 0,
      latentIU: 0, manifestIU: 0, screw: this.screw, residual: Infinity, stepMax: Infinity,
      iterations: 0, converged: false, warnings: [], notes: [], solveMs: 0, dof: this.u.length, bandwidth: this.K.hb,
    };
  }

  private collect(iters: number, ms: number): void {
    const R = this.result;
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
      if (r === this.stack.wr) for (const sl of this.slices) fm = Math.max(fm, sl.flat);
      roll.flatMax = fm;
    }
    R.h0.fill(NaN); R.h1.fill(NaN); R.q.fill(NaN); R.flat.fill(NaN);
    R.dEps.fill(NaN); R.manifest.fill(NaN); R.sigmaF.fill(NaN);
    let lat0 = Infinity, lat1 = -Infinity, man = 0;
    for (const sl of this.slices) {
      R.h0[sl.s] = sl.h0; R.h1[sl.s] = sl.h1; R.q[sl.s] = sl.q; R.flat[sl.s] = sl.flat;
      R.dEps[sl.s] = this.dEps[sl.s]; R.manifest[sl.s] = this.manifest[sl.s];
      R.sigmaF[sl.s] = this.sigmaF[sl.s];
      lat0 = Math.min(lat0, this.dEps[sl.s]); lat1 = Math.max(lat1, this.dEps[sl.s]);
      man = Math.max(man, this.manifest[sl.s]);
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
    R.latentIU = Number.isFinite(lat1 - lat0) ? (lat1 - lat0) * 1e5 : 0;
    R.manifestIU = man * 1e5;
    R.screw = this.screw;
    R.warnings = this.diagnose();
    R.notes = [...this.stack.issues];
    R.residual = this.residual;
    R.stepMax = this.stepMax;
    R.iterations = iters;
    R.converged = this.converged;
    R.solveMs = ms;
    R.dof = u.length;
    R.bandwidth = this.K.hb;
  }

  /** the pass's problems, from the slices' own flags and the control state */
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
    // a designated contact carrying nothing once the solve has settled: the
    // roll above has lifted off, which no cluster is built to do
    if (this.converged && this.contacts.some((c) => c.total <= 0)) w.push('openContact');
    if (this.iterations > STUCK_ITERS && !this.converged) w.push('stuck');
    if (p.mode !== 'screw' && this.iterations > STUCK_ITERS && !this.screwSettled()
      && (this.screw <= SCREW_MIN + 1e-9 || this.screw >= SCREW_MAX - 1e-9)) w.push('target');
    return w;
  }

  /** exit thickness at x by linear interpolation between slices */
  private h1At(x: number): number {
    const sl = this.slices;
    if (sl.length === 0) return this.p.h0;
    if (x <= sl[0].x) return sl[0].h1;
    for (let i = 1; i < sl.length; i++) {
      if (x <= sl[i].x) {
        const t = (x - sl[i - 1].x) / (sl[i].x - sl[i - 1].x || 1);
        return sl[i - 1].h1 + t * (sl[i].h1 - sl[i - 1].h1);
      }
    }
    return sl[sl.length - 1].h1;
  }

  get isConverged(): boolean { return this.converged; }
  wake(): void { this.converged = false; }
}

/** the inputs whose change means a new mesh */
function geometryKey(p: Params3D): string {
  return [
    p.mill, p.stations, p.wrLb, p.wrLs, p.irLb, p.irLs, p.ir2Lb, p.burLb, p.burLs, p.bbLb,
    p.width, p.irShift, p.wrD, p.irD, p.ir2D, p.burD, p.bbD, p.angle1, p.mode,
  ].join('|');
}
