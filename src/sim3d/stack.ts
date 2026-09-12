/**
 * The upper half of a rolling mill, as a set of rolls, how each is held, and
 * which touches which.
 *
 * Everything is the upper half: the mill is symmetric about the pass line,
 * so the lower rolls are the mirror of the upper ones and the strip's
 * mid-plane is a plane of symmetry. A one-sided actuator (an intermediate
 * roll shifted one way on top and the other way below) is therefore seen
 * only through its upper half; that is the price of the symmetry and it is
 * stated in the docs.
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
  /** index of the work roll */
  wr: number;
  /** rolls whose supports the screw moves */
  screwRolls: number[];
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
  /** control */
  mode: 'gauge' | 'force' | 'screw';
  targetForce: number;
  screw: number;
  leveling: number;
  /** housing stiffness per support point - a bearing chock or a saddle [N/m] */
  housingK: number;
  /** roll geometry, by type [m] */
  wrD: number; wrLb: number; wrLs: number; wrDn: number;
  irD: number; irLb: number; irLs: number; irDn: number;
  ir2D: number; ir2Lb: number;
  burD: number; burLb: number; burLs: number; burDn: number;
  /** cluster: backing bearing diameter and shaft diameter */
  bbD: number; bbShaft: number; bbLb: number;
  /** profiles [m], diameter crown */
  wrCrown: number; wrThermal: number; irCrown: number; burCrown: number;
  /** actuators */
  wrBender: number;
  irBender: number;
  /** 6Hi intermediate roll shift: barrel end past the strip edge [m], + outside */
  irShift: number;
  /** 20Hi first intermediate taper: start relative to the strip edge [m] (+ outside), length and depth */
  taperShift: number; taperLen: number; taperDepth: number;
  asu: number[];
  /** cluster layout angles [rad] */
  angle1: number;
  /** roll material */
  Eroll: number;
  nuRoll: number;
  /** stations across the widest roll */
  stations: number;
  /** how a roll flattens at a contact: the Hertz/Johnson closed form, or the cross-section ring FEM */
  flatModel: 'hertz' | 'ring';
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
    lateralLen: 0.02, sigmaCr: 2e6,
    mode: 'gauge', targetForce: 1000 * 9.80665e3, screw: 0.5e-3, leveling: 0,
    housingK: 6e9,
    wrD: 0.5, wrLb: 1.6, wrLs: 2.1, wrDn: 0.3,
    irD: 0.5, irLb: 1.7, irLs: 2.2, irDn: 0.3,
    ir2D: 0.175, ir2Lb: 1.5,
    burD: 1.3, burLb: 1.6, burLs: 2.35, burDn: 0.8,
    bbD: 0.3, bbShaft: 0.16, bbLb: 1.6,
    wrCrown: 0, wrThermal: 20e-6, irCrown: 0, burCrown: 0,
    wrBender: 0, irBender: 0, irShift: 0,
    taperShift: 0, taperLen: 0.3, taperDepth: 0.4e-3,
    asu: new Array(ASU_RACKS).fill(0),
    angle1: (24 * Math.PI) / 180,
    Eroll: 206e9, nuRoll: 0.3,
    stations: 81,
    flatModel: 'hertz', ringNt: 400, ringNr: 8, ringGrade: 2.5, ringHub: 0.3,
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
        h0: 0.001, reduction: 0.2, backTension: 100e6, frontTension: 120e6, angle1: (30 * Math.PI) / 180,
      };
    case '20hi':
      return {
        ...base, wrD: 0.065, wrLb: 1.4, wrLs: 1.5, wrDn: 0.055,
        irD: 0.11, irLb: 1.45, irLs: 1.55, irDn: 0.09,
        ir2D: 0.175, ir2Lb: 1.45,
        bbD: 0.3, bbShaft: 0.16, bbLb: 1.5,
        h0: 0.0005, reduction: 0.2, backTension: 100e6, frontTension: 120e6, angle1: (22 * Math.PI) / 180,
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
  const roll = (o: Partial<RollDef> & { id: string; label: string; D: number; Lb: number; Ls: number }): RollDef => ({
    Dn: o.D * 0.6, cy: 0, cz: 0, shift: 0, crown: 0, thermal: 0, support: 'free',
    benderForce: 0, saddles: ASU_RACKS, shaftBeam: false, E, nu, ...o,
  });
  const Rw = p.wrD / 2;
  const rolls: RollDef[] = [];
  const contacts: ContactDef[] = [];
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
        id: 'IR', label: '中間ロール', D: p.irD, Dn: p.irDn, Ls: p.irLs,
        cy: Rw + Ri, crown: p.irCrown, support: 'chock', benderForce: p.irBender,
        // Shift. The upper roll is shifted one way and the lower the other,
        // so between them the work rolls lose support past the strip edge
        // on both sides; in a half model that is a barrel ending at
        // W/2 + irShift on each side, i.e. a symmetric barrel of that length.
        Lb: Math.min(p.irLb, p.width + 2 * p.irShift),
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
      const c1L = tangentAt([0, 0], Rw, R1, -p.angle1);
      const c1R = tangentAt([0, 0], Rw, R1, p.angle1);
      const irL = roll({ id: 'IR-L', label: '中間ロール (L)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1L[0], cz: c1L[1], crown: p.irCrown });
      const irR = roll({ id: 'IR-R', label: '中間ロール (R)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1R[0], cz: c1R[1], crown: p.irCrown });
      rolls.push(irL, irR);
      const cB = tangentTwo(c1L, R1, c1R, R1, Rb, 1);
      // A on the outer side of the line from the left intermediate up to B
      const cA = tangentTwo(c1L, R1, cB, Rb, Rb, 1);
      const cC: Pt = [cA[0], -cA[1]];
      const bb = (id: string, label: string, c: Pt, asu?: number[]) => roll({
        id, label, D: p.bbD, Dn: p.bbShaft, Lb: p.bbLb, Ls: p.bbLb, cy: c[0], cz: c[1],
        support: 'saddle', shaftBeam: true, asu,
      });
      rolls.push(bb('BB-A', 'バッキング A', cA), bb('BB-B', 'バッキング B (AS-U)', cB, p.asu), bb('BB-C', 'バッキング C', cC));
      screwRolls.push(3, 4, 5);
      touch(0, 1); touch(0, 2);
      touch(1, 3); touch(1, 4); touch(2, 4); touch(2, 5);
      break;
    }
    case '20hi': {
      const R1 = p.irD / 2, R2 = p.ir2D / 2, Rb = p.bbD / 2;
      const c1L = tangentAt([0, 0], Rw, R1, -p.angle1);
      const c1R = tangentAt([0, 0], Rw, R1, p.angle1);
      // The tapered end of each first intermediate faces one edge of the
      // strip; the taper starts `taperShift` outside that edge.
      const taperFor = (side: 1 | -1) => ({
        start: p.width / 2 + p.taperShift, len: p.taperLen, depth: p.taperDepth, side,
      });
      const irL = roll({ id: 'IR1-L', label: '第1中間 (L)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1L[0], cz: c1L[1], crown: p.irCrown, taper: taperFor(1) });
      const irR = roll({ id: 'IR1-R', label: '第1中間 (R)', D: p.irD, Dn: p.irDn, Lb: p.irLb, Ls: p.irLs, cy: c1R[0], cz: c1R[1], crown: p.irCrown, taper: taperFor(-1) });
      rolls.push(irL, irR);
      const c2B = tangentTwo(c1L, R1, c1R, R1, R2, 1);
      // outer second intermediates: touching a first intermediate, packed against the centre one
      const c2A = tangentTwo(c1L, R1, c2B, R2, R2 * 1.02, 1);
      const c2C: Pt = [c2A[0], -c2A[1]];
      const ir2 = (id: string, label: string, c: Pt) => roll({
        id, label, D: p.ir2D, Dn: p.ir2D * 0.8, Lb: p.ir2Lb, Ls: p.ir2Lb + 0.1, cy: c[0], cz: c[1],
      });
      rolls.push(ir2('IR2-A', '第2中間 A', c2A), ir2('IR2-B', '第2中間 B', c2B), ir2('IR2-C', '第2中間 C', c2C));
      const cB = tangentTwo(c2A, R2, c2B, R2, Rb, 1);
      const cA = tangentTwo(c2A, R2, cB, Rb, Rb, 1);
      const cC: Pt = [cB[0], -cB[1]];
      const cD: Pt = [cA[0], -cA[1]];
      const bb = (id: string, label: string, c: Pt, asu?: number[]) => roll({
        id, label, D: p.bbD, Dn: p.bbShaft, Lb: p.bbLb, Ls: p.bbLb, cy: c[0], cz: c[1],
        support: 'saddle', shaftBeam: true, asu,
      });
      rolls.push(
        bb('BB-A', 'バッキング A', cA), bb('BB-B', 'バッキング B (AS-U)', cB, p.asu),
        bb('BB-C', 'バッキング C (AS-U)', cC, p.asu), bb('BB-D', 'バッキング D', cD),
      );
      screwRolls.push(6, 7, 8, 9);
      touch(0, 1); touch(0, 2);
      touch(1, 3); touch(1, 4); touch(2, 4); touch(2, 5);
      touch(3, 6); touch(3, 7); touch(4, 7); touch(4, 8); touch(5, 8); touch(5, 9);
      break;
    }
  }
  return { type: p.mill, rolls, contacts, wr: 0, screwRolls };
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
