/**
 * The upper half of a rolling mill, as a set of rolls, how each is held, and
 * which touches which.
 *
 * Everything is described as the upper half. When the mill is symmetric
 * about the pass line the lower rolls are the mirror of the upper ones and
 * the strip's mid-plane is a plane of symmetry, so the upper half is all
 * that is solved. A roll shifted along its axis breaks that: the 6Hi's
 * intermediate rolls shift one way on top and the other way below, so the
 * lower half is the upper one turned half a turn about the rolling
 * direction - the same rolls with x reversed - and not its mirror image.
 * Such a stack carries that lower half (`Stack.lower`) for the solver to
 * solve alongside the upper one.
 *
 * Coordinates: x along the roll axes (the strip width), y up, z across the
 * pass line in the end view. Roll centres are laid out in the (y, z) plane;
 * vertical stacks put every roll on z = 0, the cluster mills pack their
 * rolls by tangency from the work roll outwards.
 */

export type MillType = '2hi' | '4hi' | '6hi' | '12hi' | '20hi';

export const MILL_LABEL: Record<MillType, string> = {
  '2hi': '2Hi', '4hi': '4Hi', '6hi': '6Hi', '12hi': '12Hi', '20hi': '20Hi',
};

/** how a roll is held by the housing */
export type SupportKind =
  /** bearings pushed to a prescribed position by the screw (the top of a vertical stack) */
  | 'screw'
  /** chocks free in y (a bending force is applied there), guided in z */
  | 'chock'
  /** a backing shaft on saddles at several stations, each a stiff spring to a prescribed position */
  | 'saddle'
  /** held only by its contacts (cluster intermediates) */
  | 'free';

export interface RollDef {
  id: string;
  label: string;
  /** barrel diameter [m] */
  D: number;
  /** neck / shaft diameter [m], the section outside the barrel (and, for a backing shaft, everywhere) */
  Dn: number;
  /** barrel length [m] */
  Lb: number;
  /** support span [m]: bearing centres, or the saddle span */
  Ls: number;
  /** nominal centre in the end view [m] */
  cy: number;
  cz: number;
  /** axial shift of the whole roll [m] */
  shift: number;
  /** diameter crown, centre minus edge [m] */
  crown: number;
  /** thermal diameter crown, centre minus edge [m] */
  thermal: number;
  /** a radius taper at one end: starts `start` from the roll's own centre, on `side`, and drops `depth` over `len` */
  taper?: { start: number; len: number; depth: number; side: 1 | -1 };
  support: SupportKind;
  /** bending force per chock [N], + up; only for 'chock' */
  benderForce: number;
  /** number of saddles for 'saddle' */
  saddles: number;
  /** crown-adjustment offsets per saddle [m], + towards the work roll; only for 'saddle' with AS-U */
  asu?: number[];
  /** the beam section is the shaft, not the barrel (backing bearings on a shaft) */
  shaftBeam: boolean;
  /** a shaft's barrel is a row of separate bearing rings: the axial gaps (saddle width) between them [m], 0 = one continuous barrel */
  bearingGap: number;
  E: number;
  nu: number;
}

export interface ContactDef {
  a: number;
  b: number;
  /** unit normal from a to b in (y, z) */
  ny: number;
  nz: number;
}

export interface Stack {
  type: MillType;
  rolls: RollDef[];
  contacts: ContactDef[];
  /** the first-intermediate angle actually used [rad] (the asked-for one, or the least that clears the pair) */
  angle1: number;
  /** what is wrong with the layout, if anything: a designated contact that is not tangent, or two rolls that meet without a contact */
  issues: string[];
  /** index of the work roll */
  wr: number;
  /** rolls whose supports the screw moves */
  screwRolls: number[];
  /**
   * The lower half, when it is not the mirror image of the upper one (see
   * `lowerHalf`); null when it is. Its rolls are described in the upper
   * half's frame - y pointing away from the strip, x as on the mill - so the
   * same supports, contacts and strip load apply to them unchanged, and its
   * indices (`wr`, `screwRolls`, the contacts' `a` and `b`) count within it.
   */
  lower: { rolls: RollDef[]; contacts: ContactDef[]; wr: number; screwRolls: number[] } | null;
}

export interface Params3D {
  mill: MillType;
  /** strip */
  width: number;
  h0: number;
  reduction: number;
  /** entry thickness crown, centre minus edge [m] */
  entryCrown: number;
  backTension: number;
  frontTension: number;
  lmnL: number;
  lmnM: number;
  lmnN: number;
  entryStrain: number;
  mu: number;
  Estrip: number;
  nuStrip: number;
  /** lateral-flow smoothing length of the differential elongation [m] */
  lateralLen: number;
  /** buckling stress the strip can carry in compression before it waves [Pa] */
  sigmaCr: number;
  /**
   * Tension feedback: the longitudinal tension in the strip lowers the roll
   * pressure at which it yields (p = kf − σt), brings the onset of plastic
   * deformation forward, and is itself redistributed by the elongation
   * differences the rolls produce - which changes the loads on the work
   * roll and so its deflection. Off, the strip is rolled as if untensioned.
   */
  tensionFeedback: boolean;
  /**
   * How the back and front tension enter the slab load (with the feedback
   * on): 'mean' takes their mean off the resistance over the whole arc
   * (Kármán, Siebel); 'split' lets the front tension act from the exit to
   * the neutral point and the back tension from there to the entry, each
   * amplified by its side of the friction hill (Nádai's solution, see
   * `splitDecrement` in strip.ts). The front tension then moves the load
   * about 0.36 L per Pa instead of 0.56 L.
   */
  slabTension: 'mean' | 'split';
  /** control */
  mode: 'gauge' | 'force' | 'screw';
  targetForce: number;
  screw: number;
  leveling: number;
  /** housing stiffness per support point - a bearing chock or a saddle [N/m] */
  housingK: number;
  /**
   * Housing deformation mode (2Hi / 4Hi / 6Hi; see `housing.ts`): the screw
   * roll's chocks sit on a housing frame per side - posts and crossheads, its
   * compliance from the dimensions below, top and bottom halves tied through
   * the posts - instead of on the independent springs of `housingK`, and on a
   * 6Hi the intermediate roll's chocks can seat on the backup roll's.
   */
  housingMode: boolean;
  /** per side: cross-section of one post [m²], posts, post length between the crossheads [m] */
  housingPostArea: number;
  housingPostCount: number;
  housingPostLength: number;
  /**
   * the posts' width along the roll axis [m]: where the housings' inner faces
   * stand across the mill, for the side view and the strip clearance warning
   * (see `housingPlan`). Not part of the stiffness, which takes the area.
   */
  housingPostWidth: number;
  /** each crosshead: span between the post centres [m], second moment of area [m⁴], shear area [m²] */
  housingCrossSpan: number;
  housingCrossI: number;
  housingCrossShearArea: number;
  /** Young's modulus of the housing [Pa] */
  housingE: number;
  /** in the housing mode, a 6Hi intermediate roll's chocks seat on the backup roll's (compression only) */
  irSeat: boolean;
  /** stiffness of that seat: bearing, chock and liners in series [N/m] */
  irSeatK: number;
  /** roll geometry, by type [m] */
  wrD: number; wrLb: number; wrLs: number; wrDn: number;
  irD: number; irLb: number; irLs: number; irDn: number;
  ir2D: number; ir2Lb: number;
  burD: number; burLb: number; burLs: number; burDn: number;
  /** cluster: backing bearing diameter, shaft diameter, shaft support length */
  bbD: number; bbShaft: number; bbLb: number;
  /** the backing bearings as separate rings between the saddles (true) or one continuous barrel (false) */
  bbSegmented: boolean;
  /** saddle width, i.e. the axial gap between neighbouring bearing rings [m] */
  bbGap: number;
  /** profiles [m], diameter crown */
  wrCrown: number; wrThermal: number; irCrown: number; burCrown: number;
  /** actuators */
  wrBender: number;
  irBender: number;
  /**
   * 6Hi intermediate roll shift, as where the barrel end sits against the
   * strip edge [m], + outside: the upper roll's +x barrel end at W/2 + irShift,
   * the lower roll's −x end at −(W/2 + irShift)
   */
  irShift: number;
  /** 20Hi first intermediate taper: start relative to the strip edge [m] (+ outside), length and depth */
  taperShift: number; taperLen: number; taperDepth: number;
  /** 12Hi: the B shaft's saddles. 20Hi: `asu` is the A-B pair, `asu2` the C-D pair (double AS-U) */
  asu: number[];
  asu2: number[];
  /** cluster layout: first-intermediate angle from vertical [rad] - raised to the least that keeps the pair apart */
  angle1: number;
  /** the gap kept between rolls that sit side by side in a cluster [m] */
  clearance: number;
  /** roll material */
  Eroll: number;
  nuRoll: number;
  /** stations across the widest roll: the count of an even grid, and the spacing off the strip when the strip has its own (see `grid.ts`) */
  stations: number;
  /** stations on the strip: 0 spaces them with the rest, N > 0 tiles the strip with N cells of its own (odd, 3 or more; see `grid.ts`) */
  stripStations: number;
  /** how the strip is solved: slab passes per slice, the plan-view rigid-plastic FEM (stripfem.ts), or the three-dimensional one (stripfem3d.ts) */
  stripModel: 'slab' | 'fem' | 'fem3d';
  /** rows along the rolling direction of the strip FEMs */
  stripNz: number;
  /** element layers through the upper half of the thickness (3D FEM) */
  stripNy: number;
  /** how a roll flattens at a contact: the Hertz/Johnson closed form, or the cross-section ring FEM */
  flatModel: 'hertz' | 'ring';
  /**
   * the work roll's flattening by the strip spread along the roll (see
   * `flatnl.ts`): each slice is also pressed in by its neighbours' loads, and
   * the unloaded barrel beyond the strip edge holds the edge up less. Off,
   * each slice flattens under its own load alone.
   */
  flatNonlocal: boolean;
  /** ring FEM: circumferential divisions, rings through the wall, radial grading, hub radius as a fraction of R */
  ringNt: number;
  ringNr: number;
  ringGrade: number;
  ringHub: number;
  /** end-view overall span scaling of the cluster - none */
}

export const ASU_RACKS = 7;

export function defaultParams(mill: MillType): Params3D {
  const base: Params3D = {
    mill,
    width: 1.0, h0: 0.002, reduction: 0.25, entryCrown: 30e-6,
    backTension: 50e6, frontTension: 80e6,
    lmnL: 1200e6, lmnM: 0.010, lmnN: 0.255, entryStrain: 0,
    mu: 0.06, Estrip: 206e9, nuStrip: 0.3,
    lateralLen: 0.02, sigmaCr: 2e6, tensionFeedback: true, slabTension: 'mean',
    mode: 'gauge', targetForce: 1000 * 9.80665e3, screw: 0.5e-3, leveling: 0,
    housingK: 6e9,
    // Assumed dimensions, not a drawing: two 500 × 700 mm posts 4.5 m long
    // (700 mm along the roll axis), crossheads spanning 1.8 m with
    // I = 4.5e-3 m⁴ (a 700 × 420 mm section) and 0.3 m² of shear area -
    // chosen so that a mirror's chock sees 6.04e9 N/m, the `housingK` above
    // (see docs/validation.md「ハウジング変形考慮モード」).
    housingMode: false,
    housingPostArea: 0.35, housingPostCount: 2, housingPostLength: 4.5, housingPostWidth: 0.7,
    housingCrossSpan: 1.8, housingCrossI: 4.5e-3, housingCrossShearArea: 0.3,
    housingE: 206e9,
    irSeat: true, irSeatK: 3e9,
    wrD: 0.5, wrLb: 1.6, wrLs: 2.1, wrDn: 0.3,
    irD: 0.5, irLb: 1.7, irLs: 2.2, irDn: 0.3,
    ir2D: 0.175, ir2Lb: 1.5,
    burD: 1.3, burLb: 1.6, burLs: 2.35, burDn: 0.8,
    bbD: 0.3, bbShaft: 0.16, bbLb: 1.6,
    bbSegmented: true, bbGap: 0.04,
    wrCrown: 0, wrThermal: 20e-6, irCrown: 0, burCrown: 0,
    wrBender: 0, irBender: 0, irShift: 0,
    taperShift: 0, taperLen: 0.3, taperDepth: 0.4e-3,
    asu: new Array(ASU_RACKS).fill(0),
    asu2: new Array(ASU_RACKS).fill(0),
    angle1: (24 * Math.PI) / 180,
    clearance: 3e-3,
    Eroll: 206e9, nuRoll: 0.3,
    stations: 301, stripStations: 0,
    stripModel: 'fem', stripNz: 8, stripNy: 2,
    flatModel: 'hertz', flatNonlocal: false, ringNt: 400, ringNr: 8, ringGrade: 2.5, ringHub: 0.3,
  };
  switch (mill) {
    case '2hi':
      return { ...base, wrD: 0.6, wrLb: 1.6, wrLs: 2.1, wrDn: 0.36 };
    case '6hi':
      return { ...base, wrD: 0.42, wrDn: 0.26, irD: 0.5, irDn: 0.3 };
    case '12hi':
      return {
        ...base, wrD: 0.1, wrLb: 1.4, wrLs: 1.5, wrDn: 0.08,
        irD: 0.18, irLb: 1.45, irLs: 1.55, irDn: 0.14,
        bbD: 0.3, bbShaft: 0.17, bbLb: 1.5,
        h0: 0.001, reduction: 0.2, backTension: 100e6, frontTension: 120e6, angle1: (41 * Math.PI) / 180,
      };
    case '20hi':
      return {
        ...base, wrD: 0.065, wrLb: 1.4, wrLs: 1.5, wrDn: 0.055,
        irD: 0.11, irLb: 1.45, irLs: 1.55, irDn: 0.09,
        ir2D: 0.175, ir2Lb: 1.45,
        bbD: 0.3, bbShaft: 0.16, bbLb: 1.5,
        h0: 0.0005, reduction: 0.2, backTension: 100e6, frontTension: 120e6, angle1: (40 * Math.PI) / 180,
      };
    default:
      return base;
  }
}

/* ── geometry helpers ─────────────────────────────────────────────────────── */

type Pt = [number, number]; // (y, z)

/** the centre of a circle of radius r touching circle (c, rc), at angle th from straight up (+ towards +z) */
function tangentAt(c: Pt, rc: number, r: number, th: number): Pt {
  return [c[0] + (rc + r) * Math.cos(th), c[1] + (rc + r) * Math.sin(th)];
}

/**
 * The centre of a circle of radius r touching both (c1, r1) and (c2, r2):
 * the intersection of two circles, the one on `side` of the line c1→c2
 * (+1 = to the left when walking from c1 to c2 in (z, y) - i.e. above when
 * c1 is left of c2).
 */
function tangentTwo(c1: Pt, r1: number, c2: Pt, r2: number, r: number, side: 1 | -1): Pt {
  const R1 = r1 + r, R2 = r2 + r;
  const dy = c2[0] - c1[0], dz = c2[1] - c1[1];
  const d = Math.hypot(dy, dz);
  const a = (R1 * R1 - R2 * R2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, R1 * R1 - a * a));
  const my = c1[0] + (a * dy) / d, mz = c1[1] + (a * dz) / d;
  // perpendicular to (dy, dz): (dz, -dy) points "up" when c1 is left of c2
  const py = dz / d, pz = -dy / d;
  return [my + side * h * py, mz + side * h * pz];
}

/* ── the stacks ───────────────────────────────────────────────────────────── */

export function buildStack(p: Params3D): Stack {
  const E = p.Eroll, nu = p.nuRoll;
  // a neck is never wider than its barrel (it is what the barrel steps down to)
  const roll = (o: Partial<RollDef> & { id: string; label: string; D: number; Lb: number; Ls: number }): RollDef => {
    const r: RollDef = {
      Dn: o.D * 0.6, cy: 0, cz: 0, shift: 0, crown: 0, thermal: 0, support: 'free',
      benderForce: 0, saddles: ASU_RACKS, shaftBeam: false, bearingGap: 0, E, nu, ...o,
    };
    r.Dn = Math.min(r.Dn, r.D);
    return r;
  };
  const Rw = p.wrD / 2;
  const rolls: RollDef[] = [];
  const contacts: ContactDef[] = [];
  let angle1 = p.angle1;
  const touch = (a: number, b: number) => {
    const dy = rolls[b].cy - rolls[a].cy, dz = rolls[b].cz - rolls[a].cz;
    const d = Math.hypot(dy, dz) || 1;
    contacts.push({ a, b, ny: dy / d, nz: dz / d });
  };
  const wr = roll({
    id: 'WR', label: 'ワークロール', D: p.wrD, Dn: p.wrDn, Lb: p.wrLb, Ls: p.wrLs,
    crown: p.wrCrown, thermal: p.wrThermal,
  });
  rolls.push(wr);
  const screwRolls: number[] = [];

  switch (p.mill) {
    case '2hi': {
      wr.support = 'screw';
      screwRolls.push(0);
      break;
    }
    case '4hi': {
      wr.support = 'chock'; wr.benderForce = p.wrBender;
      const Rb = p.burD / 2;
      rolls.push(roll({
        id: 'BUR', label: 'バックアップロール', D: p.burD, Dn: p.burDn, Lb: p.burLb, Ls: p.burLs,
        cy: Rw + Rb, crown: p.burCrown, support: 'screw',
      }));
      screwRolls.push(1);
      touch(0, 1);
      break;
    }
    case '6hi': {
      wr.support = 'chock'; wr.benderForce = p.wrBender;
      const Ri = p.irD / 2, Rb = p.burD / 2;
      rolls.push(roll({
        id: 'IR', label: '中間ロール', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs,
        cy: Rw + Ri, crown: p.irCrown, support: 'chock', benderForce: p.irBender,
        // Shift. The whole roll - barrel, necks and chocks - moves along its
        // axis until its +x barrel end is `irShift` outside the strip edge;
        // the lower one moves the other way (see `lowerHalf`). Each work
        // roll then loses its intermediate's support past one strip edge,
        // the upper past +x and the lower past −x.
        shift: p.width / 2 + p.irShift - p.irLb / 2,
      }));
      rolls.push(roll({
        id: 'BUR', label: 'バックアップロール', D: p.burD, Dn: p.burDn, Lb: p.burLb, Ls: p.burLs,
        cy: Rw + Ri + Ri + Rb, crown: p.burCrown, support: 'screw',
      }));
      screwRolls.push(2);
      touch(0, 1); touch(1, 2);
      break;
    }
    case '12hi': {
      const R1 = p.irD / 2, Rb = p.bbD / 2;
      // the two intermediates must not meet: 2 (Rw + R1) sin α ≥ 2 R1 + clearance
      angle1 = Math.max(p.angle1, Math.asin(Math.min(1, (R1 + p.clearance / 2) / (Rw + R1))));
      const c1L = tangentAt([0, 0], Rw, R1, -angle1);
      const c1R = tangentAt([0, 0], Rw, R1, angle1);
      const irL = roll({ id: 'IR-L', label: '中間ロール (L)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1L[0], cz: c1L[1], crown: p.irCrown });
      const irR = roll({ id: 'IR-R', label: '中間ロール (R)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1R[0], cz: c1R[1], crown: p.irCrown });
      rolls.push(irL, irR);
      const cB = tangentTwo(c1L, R1, c1R, R1, Rb, 1);
      // A touches the left intermediate and clears B by the clearance (B's
      // radius grown by it for the construction), on the outer side
      const cA = tangentTwo(c1L, R1, cB, Rb + p.clearance, Rb, 1);
      const cC: Pt = [cA[0], -cA[1]];
      const bb = (id: string, label: string, c: Pt, asu?: number[]) => roll({
        id, label, D: p.bbD, Dn: p.bbShaft, Lb: p.bbLb, Ls: p.bbLb, cy: c[0], cz: c[1],
        support: 'saddle', shaftBeam: true, asu, bearingGap: p.bbSegmented ? p.bbGap : 0,
      });
      rolls.push(bb('BB-A', 'バッキング A', cA), bb('BB-B', 'バッキング B (AS-U)', cB, p.asu), bb('BB-C', 'バッキング C', cC));
      screwRolls.push(3, 4, 5);
      touch(0, 1); touch(0, 2);
      touch(1, 3); touch(1, 4); touch(2, 4); touch(2, 5);
      break;
    }
    case '20hi': {
      const R1 = p.irD / 2, R2 = p.ir2D / 2, Rb = p.bbD / 2;
      angle1 = Math.max(p.angle1, Math.asin(Math.min(1, (R1 + p.clearance / 2) / (Rw + R1))));
      const c1L = tangentAt([0, 0], Rw, R1, -angle1);
      const c1R = tangentAt([0, 0], Rw, R1, angle1);
      // The tapered end of each first intermediate faces one edge of the
      // strip; the taper starts `taperShift` outside that edge.
      const taperFor = (side: 1 | -1) => ({
        start: p.width / 2 + p.taperShift, len: p.taperLen, depth: p.taperDepth, side,
      });
      const irL = roll({ id: 'IR1-L', label: '第1中間 (L)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1L[0], cz: c1L[1], crown: p.irCrown, taper: taperFor(1) });
      const irR = roll({ id: 'IR1-R', label: '第1中間 (R)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1R[0], cz: c1R[1], crown: p.irCrown, taper: taperFor(-1) });
      rolls.push(irL, irR);
      const c2B = tangentTwo(c1L, R1, c1R, R1, R2, 1);
      // Outer second intermediates: touching their first intermediate, and
      // spread from the centre one by at least the clearance - but further
      // if that is what it takes for the two centre backing bearings (each
      // tangent to the centre second intermediate and one outer one) to
      // clear each other. Their spacing grows with the spread, so a
      // bisection on the spread finds the least that works.
      const placeA = (spread: number): Pt => tangentTwo(c1L, R1, c2B, R2 + spread, R2, 1);
      const bbGap = (spread: number): number => {
        const a = placeA(spread);
        const b = tangentTwo(a, R2, c2B, R2, Rb, 1);
        return 2 * Math.abs(b[1]) - 2 * Rb;
      };
      let spread = p.clearance;
      if (bbGap(spread) < p.clearance) {
        let lo = spread, hi = R2 * 4;
        for (let i = 0; i < 60; i++) {
          const mid = 0.5 * (lo + hi);
          if (bbGap(mid) < p.clearance) lo = mid; else hi = mid;
        }
        spread = hi;
      }
      const c2A = placeA(spread);
      const c2C: Pt = [c2A[0], -c2A[1]];
      const ir2 = (id: string, label: string, c: Pt) => roll({
        id, label, D: p.ir2D, Dn: p.ir2D * 0.8, Lb: p.ir2Lb, Ls: p.ir2Lb + 0.1, cy: c[0], cz: c[1],
      });
      rolls.push(ir2('IR2-A', '第2中間 A', c2A), ir2('IR2-B', '第2中間 B', c2B), ir2('IR2-C', '第2中間 C', c2C));
      const cB = tangentTwo(c2A, R2, c2B, R2, Rb, 1);
      // A touches the outer second intermediate and clears B
      const cA = tangentTwo(c2A, R2, cB, Rb + p.clearance, Rb, 1);
      const cC: Pt = [cB[0], -cB[1]];
      const cD: Pt = [cA[0], -cA[1]];
      const bb = (id: string, label: string, c: Pt, asu?: number[]) => roll({
        id, label, D: p.bbD, Dn: p.bbShaft, Lb: p.bbLb, Ls: p.bbLb, cy: c[0], cz: c[1],
        support: 'saddle', shaftBeam: true, asu, bearingGap: p.bbSegmented ? p.bbGap : 0,
      });
      rolls.push(
        // double AS-U: one rack setting on the A-B pair, another on C-D
        bb('BB-A', 'バッキング A (AS-U 1)', cA, p.asu), bb('BB-B', 'バッキング B (AS-U 1)', cB, p.asu),
        bb('BB-C', 'バッキング C (AS-U 2)', cC, p.asu2), bb('BB-D', 'バッキング D (AS-U 2)', cD, p.asu2),
      );
      screwRolls.push(6, 7, 8, 9);
      touch(0, 1); touch(0, 2);
      touch(1, 3); touch(1, 4); touch(2, 4); touch(2, 5);
      touch(3, 6); touch(3, 7); touch(4, 7); touch(4, 8); touch(5, 8); touch(5, 9);
      break;
    }
  }
  return {
    type: p.mill, rolls, contacts, wr: 0, screwRolls, angle1, issues: layoutIssues(rolls, contacts, p.clearance),
    lower: lowerHalf(rolls, contacts, 0, screwRolls),
  };
}

/**
 * The lower half of a stack whose rolls are not all centred, or null when
 * they are and the lower half is the upper one's mirror image.
 *
 * A mill whose lower half is its upper half turned half a turn about the
 * rolling direction - (x, y, z) → (−x, −y, z) - is what a shifted
 * intermediate roll makes: shifted to −x above, to +x below. Seen from the
 * strip, with y pointing away from it, the lower half is then the upper one
 * with every axial feature reversed: the shift, a taper's side, the order of
 * the saddles. Everything radial - diameters, crowns, the end-view layout,
 * the contacts, the supports - is the same, and so is the screw: the mirror
 * model closes the gap by the screw's travel on each side and tilts both
 * sides alike by the leveling, and the lower half does the same here.
 *
 * On a symmetric pass (no leveling) the solved lower half comes out as the
 * upper one reversed in x, and the strip gap is symmetric although neither
 * work roll is. With leveling it is not, which is why the lower half is
 * solved and not taken from the upper one: turning the upper half over
 * would turn the leveling's wedge over too and cancel it.
 */
function lowerHalf(rolls: RollDef[], contacts: ContactDef[], wr: number, screwRolls: number[]): Stack['lower'] {
  if (rolls.every((r) => Math.abs(r.shift) < 1e-12)) return null;
  return {
    rolls: rolls.map((r) => ({
      ...r,
      id: `${r.id}'`, label: `下${r.label}`,
      shift: -r.shift,
      taper: r.taper ? { ...r.taper, side: (-r.taper.side) as 1 | -1 } : undefined,
      asu: r.asu ? [...r.asu].reverse() : undefined,
    })),
    contacts: contacts.map((c) => ({ ...c })),
    wr,
    screwRolls: [...screwRolls],
  };
}

/**
 * The rolls the solver carries: the upper half, then the lower half's when
 * the stack has one, with its contacts and screw rolls renumbered to follow.
 */
export function solvedRolls(st: Stack): {
  rolls: RollDef[]; contacts: ContactDef[]; screwRolls: number[]; upper: number; wrLower: number;
} {
  const upper = st.rolls.length;
  const lo = st.lower;
  if (!lo) return { rolls: st.rolls, contacts: st.contacts, screwRolls: st.screwRolls, upper, wrLower: -1 };
  return {
    rolls: [...st.rolls, ...lo.rolls],
    contacts: [...st.contacts, ...lo.contacts.map((c) => ({ ...c, a: c.a + upper, b: c.b + upper }))],
    screwRolls: [...st.screwRolls, ...lo.screwRolls.map((r) => r + upper)],
    upper,
    wrLower: lo.wr + upper,
  };
}

/**
 * Every pair of rolls, checked against what the stack claims: a designated
 * contact has to be tangent (its two circles meet), and any other pair has
 * to keep the clearance - two rolls that meet without a contact between
 * them would be pushing on each other with nothing in the model to say so.
 */
export function layoutIssues(rolls: RollDef[], contacts: ContactDef[], clearance: number): string[] {
  const out: string[] = [];
  const key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const has = new Set(contacts.map((c) => key(c.a, c.b)));
  const mm = (v: number) => `${(v * 1e3).toFixed(1)} mm`;
  for (let a = 0; a < rolls.length; a++) {
    for (let b = a + 1; b < rolls.length; b++) {
      const A = rolls[a], B = rolls[b];
      const gap = Math.hypot(A.cy - B.cy, A.cz - B.cz) - (A.D + B.D) / 2;
      if (has.has(key(a, b))) {
        if (Math.abs(gap) > 1e-6) out.push(`${A.id}–${B.id}: 接触のはずが ${gap > 0 ? '離れている' : '食い込んでいる'} (${mm(Math.abs(gap))})`);
      } else if (gap < 0) {
        out.push(`${A.id}–${B.id}: 接触なしのはずが干渉 (${mm(-gap)})`);
      } else if (gap < clearance - 1e-6) {
        out.push(`${A.id}–${B.id}: 隙間 ${mm(gap)} < クリアランス ${mm(clearance)}`);
      }
    }
  }
  return out;
}

/**
 * Radius deviation of a roll from its nominal cylinder at axial position x
 * (mill coordinates) [m]: crown, thermal crown, taper. Positive = bigger.
 */
export function radiusProfile(r: RollDef, x: number): number {
  const xl = x - r.shift;
  const t = (2 * xl) / r.Lb;
  let c = 0.5 * (r.crown + r.thermal) * (1 - t * t);
  if (r.taper) {
    const s = r.taper.side * xl - r.taper.start;
    if (s > 0) c -= (r.taper.depth * Math.min(s, r.taper.len)) / r.taper.len;
  }
  return c;
}

/** whether x (mill coordinates) is on the barrel of r */
export function onBarrel(r: RollDef, x: number): boolean {
  return Math.abs(x - r.shift) <= r.Lb / 2;
}

/** the saddle positions of a shaft (mill coordinates), as the solver places them */
export function saddleXs(r: RollDef): number[] {
  const out: number[] = [];
  for (let k = 0; k < r.saddles; k++) {
    const t = r.saddles === 1 ? 0 : -1 + (2 * k) / (r.saddles - 1);
    out.push(r.shift + ((t * r.Ls) / 2) * 0.92);
  }
  return out;
}

/**
 * Whether x is on a bearing ring of r: on the barrel, and not inside the
 * gap around a saddle where the shaft is bare. A roll with no gap is one
 * continuous barrel.
 */
export function onBearing(r: RollDef, x: number): boolean {
  if (!onBarrel(r, x)) return false;
  if (r.bearingGap <= 0) return true;
  for (const xs of saddleXs(r)) if (Math.abs(x - xs) < r.bearingGap / 2) return false;
  return true;
}
