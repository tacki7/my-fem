/**
 * The app's constants, tables and default state: the parts of `main.ts` that are
 * plain data. No DOM and nothing but types imported, so the node checks can build
 * and load it (tools/sim2d/params.mjs) rather than slicing `main.ts`'s source.
 *
 * `defaultParams` and `defaultView` return a fresh object each call; `main.ts`
 * makes the one live copy of each at boot.
 */
import type { RollingParams, FieldKind } from '../sim/solver';
import type { LineMode } from '../sim/mill';

export interface Preset { name: string; note: string; patch: Partial<RollingParams> }

/**
 * Target draft under which a stalled gauge loop is reported as a bite too
 * shallow to solve, rather than as waiting on the feed loop.
 *
 * On the asked-for draft, not on the contact count: the same 1 % target
 * came to rest once at 6 columns and once at 7, and a threshold on columns
 * caught one of them. Measured on the default mesh: 3 % settles in 33 s,
 * 1 % and under never settle.
 */
export const SHALLOW_BITE_DRAFT = 0.02;

/**
 * Mass-balance deviation |v0 h0 / (v1 h1) - 1| at which a stand's solution is
 * flagged. An ordinary pass sits at 1.5-2.3 % on the default mesh (the
 * incompressibility is a penalty, not a constraint), so the bands start
 * above that: 3 % is worth a look, 6 % means the numbers are not an answer.
 */
export const MASS_WARN = 0.03;
export const MASS_BAD = 0.06;
export const massTone = (m: number): 'ok' | 'warn' | 'bad' =>
  Math.abs(m - 1) > MASS_BAD ? 'bad' : Math.abs(m - 1) > MASS_WARN ? 'warn' : 'ok';

/** N in one tonf (1000 kgf). Mill loads are quoted in these. */
export const TONF = 9.80665e3;

/** N/m per MN/mm. Stand stiffnesses are quoted in MN/mm. */
export const MN_PER_MM = 1e9;

/** s in one minute. Line speeds are quoted in m/min. */
export const MPM = 60;

export const PRESETS: Preset[] = [
  {
    name: '冷間圧延 (薄板)',
    note: 'h0 2 mm → 25%, 低摩擦, ロール扁平が効く',
    patch: {
      R: 0.19, h0: 0.002, reduction: 0.25, omega: 100 / 60 / 0.19, mu: 0.06,
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
];

export const MESH_LEVELS = {
  fast:     { nx: 70,  ny: 6,  nt: 140, nr: 4,  label: '軽量    板 70×6 / ロール 140×4' },
  balanced: { nx: 100, ny: 8,  nt: 200, nr: 5,  label: '標準    板 100×8 / ロール 200×5' },
  fine:     { nx: 140, ny: 10, nt: 260, nr: 6,  label: '高精度  板 140×10 / ロール 260×6' },
  ultra:    { nx: 200, ny: 14, nt: 340, nr: 8,  label: '最高    板 200×14 / ロール 340×8' },
  extreme:  { nx: 300, ny: 20, nt: 480, nr: 10, label: '超高精度 板 300×20 / ロール 480×10' },
  insane:   { nx: 440, ny: 28, nt: 660, nr: 14, label: '極限    板 440×28 / ロール 660×14' },
} as const;
export type MeshLevel = keyof typeof MESH_LEVELS;

export const FIELDS: { value: FieldKind; text: string }[] = [
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
export const FIELD_LABEL = new Map(FIELDS.map((f) => [f.value, f.text]));
/** fields that live on only one body; the other is drawn as plain steel */
export const STRIP_ONLY = new Set<FieldKind>(
  ['strain', 'strainRate', 'flowStress', 'speed', 'temperature']);
export const ROLL_ONLY = new Set<FieldKind>(['rollDisp', 'rollRadial']);
/** fields that take both signs, so they want a diverging ramp centred on zero */
export const SIGNED_FIELDS = new Set<FieldKind>(['rollRadial']);
/**
 * Fields whose zero is an arbitrary point on the scale, so the ramp is fitted
 * to the data rather than anchored at zero.
 *
 * Strain and stress start at zero and a ramp from zero reads correctly. A
 * temperature does not: cold rolling puts the whole strip in 20-66 °C and a
 * 0-66 ramp throws away the bottom third, and a hot pass sits at 1000-1019 °C
 * where anchoring at zero leaves the strip one flat colour.
 */
export const OFFSET_FIELDS = new Set<FieldKind>(['temperature']);
/**
 * The ramp a field asks for when it is selected.
 *
 * `rollRadial` takes both signs and wants a diverging ramp centred on zero.
 * Temperature wants one too, for a different reason: blue-cold to red-hot is
 * how everyone reads a thermal picture, and unlike the dark sequential ramps
 * its low end is a visible blue rather than black - on this background a
 * black-floored ramp makes the unheated strip vanish into the page.
 */
export const FIELD_RAMP: Partial<Record<FieldKind, string>> = {
  rollRadial: 'coolwarm',
  temperature: 'coolwarm',
};

/* ── default state ───────────────────────────────────────────────────────── */

/** The shared solver parameters the app boots with (before the dials' conversions are applied). */
export function defaultParams(): RollingParams {
  return {
    R: 0.19, hubRatio: 0.45, rollNt: 200, rollNr: 5,
    rollRadialGrade: 1.4, biteGrade: 0.90,
    rollSkinRings: 4, rollSkinThickness: 0.002, rollSkinAuto: true, rollSkinFactor: 8,
    Eroll: 2.1e11, nuRoll: 0.30, omega: 100 / 60 / 0.19,
    h0: 0.002, reduction: 0.25, stripNx: 100, stripNy: 8,
    windowIn: -0.040, windowOut: 0.025, autoFit: true,
    lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255,
    // On by default since 2026-09-12. The undated sections of docs/validation.md
    // were measured isothermal - switch this off to reproduce them as a clean A/B.
    heatOn: true, tempEntry: 20, taylorQuinney: 0.9,
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
    // Interstand tension dynamics (src/sim/tension.ts). Off keeps the tension
    // the table's input; a model makes the table's σf a target and the line's
    // own speed balance the actual. Time scale 1 is real time, where the
    // strip's elastic transient is under a frame and every model reads rigid.
    // 100 m/min, as an exit strip speed [m/s]: the dial is one number, read as
    // the line's exit speed in tandem with the cone on and as the roll speed
    // otherwise (8.77 rad/s on the default 190 mm roll).
    lineSpeed: 100 / 60,
    tensionModel: 'off',
    standDistance: 4.5,
    tensionTimeScale: 1,
    tensionFollow: 0.5,
    tensionControl: false,
    tensionKp: 0, tensionKi: 0.5, tensionVLimit: 0.1,
    agcMode: 'off',
    // Per unit width. Not set here: it is the dial's total load over the strip
    // width (`agcTargetPerWidth`), both of which live in `view` below.
    agcTargetForce: 0,
    // Absolute-gauge setpoint. Seeded to the default pass's own exit so it is
    // never zero; the real value is adopted when a stand enters the mode.
    agcTargetGauge: 0.002 * (1 - 0.25),
    // 1e-6, not the 1e-4 this used to be.
    //
    // The loop stops the moment the error first crosses this band, so whatever
    // it leaves behind is scattered anywhere inside it - measured across six
    // setpoint steps at 1e-4, the residual came out anywhere from 1.8e-3 % to
    // 9.8e-3 % with no pattern. Nothing physical was stopping it going further:
    // with the loop parked the plant is still to 1.9e-8 % on an exit gauge and
    // 4.0e-4 % on a load, five to six orders under the band it was being asked
    // to respect. The band was simply set far above the noise it exists to
    // ignore. Tightening it costs settle time and buys precision one for one -
    // see docs/validation.md for the measured trade at 1e-6 and 1e-7.
    agcGain: 0.6, agcEvery: 4, agcDeadband: 1e-6, agcMaxStep: 0.02,
    // Screwdown actuator: on, 0.3 mm/s, 0.1 s. Every settle time in
    // docs/validation.md before 2026-09-12 was measured with the screws
    // teleporting; switch this off to reproduce those.
    screwDyn: true, screwRate: 0.3e-3, screwTau: 0.2,
    agcSpringComp: true,
    // Off: measured on a three-stand line under 圧下率一定, holding each stand
    // until the one ahead was still cost #2 its first 17 s (against 3 s) and
    // settled it at 32 s instead of 23, with no hunting to show for the wait.
    // The serialisation it was meant to prevent came from the speed cone
    // re-pitching the barrel without re-pitching the feed (see `vInOmega`),
    // and once that is fed forward the hold has nothing left to do.
    lineHold: false,
    loadModel: 'fem',
    slabTheory: 'karman',
    flattening: 'hitchcock',
    agcMethod: 'secant',
    // on by default since 2026-09-12. With a rigid stand the only spring is the
    // roll flattening, which is what the undated sections of docs/validation.md
    // were measured against - switch this off to reproduce them.
    millSpringOn: true, millModulus: (5.8 * MN_PER_MM) / 1.0,
    // 2 %, not the 30 % this used to be. The 30 % was a validity guard - the
    // mass balance was said to break past 70 % reduction - and it stopped
    // every deep pass at a rail with a red 'saturated' and no way through.
    // Re-measured on the current solve (gauge targets down to 0.20 mm on a
    // 2 mm entry, floor at 2 %): finite all the way to 86 % reduction, mass
    // balance within +-2.6 % throughout, against +-1.5-2.3 % on an ordinary
    // pass. The guard was guarding against a breakdown that no longer happens
    // there. It is now a warning on the mass balance itself (see `MASS_WARN`),
    // which says something when it is true instead of stopping in case. 2 % is
    // the lowest the solver was run at (finite to 86 % reduction); it is also
    // the floor `sepLo()` clamps this setting to.
    sepFloorFrac: 0.02,
  };
}

/** The view and dial state the app boots with. */
export function defaultView() {
  return {
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
     *
     * Every stand is seeded from it, and from then on it shows the selected
     * stand's target. 1040 tonf is the default every measurement in README and
     * docs/validation.md was taken at: the stands used to be seeded from a
     * literal 800 tonf per metre of width, 1040 tonf on the 1.3 m strip, while
     * this still read 800.
     */
    agcTargetTonf: 1040,
    /**
     * Roll speed as the dial carries it: barrel surface speed in m/min, which is
     * how a line is actually run. The solver wants an angular speed, so
     * `syncRollSpeed` divides this by the roll radius - and redoes it whenever R
     * moves, because it is the line speed that is held, not omega.
     */
    rollSpeedMpm: 100,
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
    millModulusMNmm: 5.8,
  };
}

export type ViewState = ReturnType<typeof defaultView>;

/* ── dial conversions ────────────────────────────────────────────────────── */
// The dials hold operator units (tonf, MN/mm, m/min, a strip width) in `view`;
// the solver wants per-unit-width SI values in `params`. main.ts wraps these
// with its live `view` / `params`.

export type ViewDials = Pick<ViewState, 'agcTargetTonf' | 'stripWidth' | 'millModulusMNmm' | 'rollSpeedMpm'>;

/** The dial's total load [tonf] as the load per unit width the solver wants [N/m]. */
export function agcTargetPerWidth(view: ViewDials): number {
  return (view.agcTargetTonf * TONF) / Math.max(view.stripWidth, 1e-6);
}

/** The dial's total mill modulus [MN/mm] as the per-unit-width value [Pa]. */
export function millModulusPerWidth(view: ViewDials): number {
  return (view.millModulusMNmm * MN_PER_MM) / Math.max(view.stripWidth, 1e-6);
}

/** The dial's line speed [mpm] as the barrel angular speed the solver wants [rad/s]. */
export function omegaFromMpm(view: ViewDials, R: number): number {
  return view.rollSpeedMpm / MPM / Math.max(R, 1e-6);
}

/** The dial as the strip speed leaving the line [m/s]. */
export function lineSpeedFromMpm(view: ViewDials): number {
  return view.rollSpeedMpm / MPM;
}
