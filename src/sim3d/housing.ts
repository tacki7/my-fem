/**
 * The mill housing as a frame, for the housing deformation mode.
 *
 * A 2Hi / 4Hi / 6Hi mill has two housings, one on the operator side and one
 * on the drive side, each a closed window: two posts along the rolling
 * direction, joined by a top and a bottom crosshead. The screw (or the
 * hydraulic cylinder) pushes the top backup-roll chock against the top
 * crosshead, the bottom chock sits on the bottom one, and the posts carry the
 * load between them. The two housings are not tied to each other here: their
 * crossheads span the window along the rolling direction, not across the
 * mill, so an operator-side load does not bend the drive-side frame.
 *
 * Per side, under the chock loads F_top and F_bottom [N]:
 *
 * - a crosshead is a beam simply supported on the two post centres, loaded
 *   at mid-span by its chock:  δ = F S³ / (48 E I) + F S / (4 G A_s)
 *   (bending and shear; S the span between post centres, A_s the shear area)
 * - the posts stretch by  δ_post = L N / (n E A),  N the load they carry.
 *   With the two chock loads equal that is either of them; when they are not
 *   (the lower half solved on its own, see `solver.ts`), the posts take their
 *   mean and the difference goes to the mill's foundation.
 *
 * So the window opens by  c_c F_top + c_c F_bottom + c_p (F_top + F_bottom) / 2,
 * split between the two chocks as the symmetric compliance
 *
 *     [ δ_top ]   [ c_c + c_p/4    c_p/4     ] [ F_top ]
 *     [ δ_bot ] = [   c_p/4      c_c + c_p/4 ] [ F_bot ]
 *
 * which on a mirror (F_top = F_bottom) gives each half c_c + c_p/2: half the
 * window's opening per chock load.
 */

import type { Params3D } from './stack';

export interface HousingCompliance {
  /** posts of one side, per unit of the load they carry [m/N] */
  post: number;
  /** one crosshead at mid-span [m/N] */
  crosshead: number;
}

/** Poisson's ratio of the housing steel, for the shear modulus */
const NU_HOUSING = 0.3;

export function housingCompliance(p: Params3D): HousingCompliance {
  const E = p.housingE;
  const G = E / (2 * (1 + NU_HOUSING));
  const post = p.housingPostLength / (Math.max(p.housingPostCount, 1) * E * p.housingPostArea);
  const S = p.housingCrossSpan;
  const crosshead = S ** 3 / (48 * E * p.housingCrossI) + S / (4 * G * p.housingCrossShearArea);
  return { post, crosshead };
}

/** the 2×2 compliance of one side, top and bottom chock [m/N]: [c11, c12, c22] */
export function sideCompliance(c: HousingCompliance): [number, number, number] {
  return [c.crosshead + c.post / 4, c.post / 4, c.crosshead + c.post / 4];
}

/** its inverse, the stiffness [N/m]: [k11, k12, k22] */
export function sideStiffness(c: HousingCompliance): [number, number, number] {
  const [a, b, d] = sideCompliance(c);
  const det = a * d - b * b;
  return [d / det, -b / det, a / det];
}

/** the stiffness a mirror's upper half sees at one chock: F / δ with F_top = F_bottom [N/m] */
export function halfStiffness(c: HousingCompliance): number {
  return 1 / (c.crosshead + c.post / 2);
}

/**
 * Where the two housings stand across the mill. Each side's posts are
 * centred on the screw roll's chock and `housingPostWidth` wide along the
 * roll axis, so the strip passes between their inner faces. The crosshead is
 * taken as wide as the posts (one frame), which with its second moment of
 * area gives its depth, I = b h³ / 12. For the side view and the clearance
 * check only: the stiffness above takes the areas and I as they are.
 */
export interface HousingPlan {
  /** post centres, operator side (−x) then drive side (+x) [m] */
  centres: [number, number];
  /** the posts' inner faces [m] */
  inner: [number, number];
  /** post width along the roll axis [m] */
  width: number;
  /** crosshead depth [m] */
  crossDepth: number;
  /** how far the strip reaches past an inner face, the worse side [m]; 0 when it passes clear */
  stripOverlap: number;
}

export function housingPlan(p: Params3D, screwRoll: { shift: number; Ls: number }): HousingPlan {
  const b = Math.max(p.housingPostWidth, 0);
  const centres: [number, number] = [screwRoll.shift - screwRoll.Ls / 2, screwRoll.shift + screwRoll.Ls / 2];
  const inner: [number, number] = [centres[0] + b / 2, centres[1] - b / 2];
  const crossDepth = b > 0 ? Math.cbrt((12 * p.housingCrossI) / b) : 0;
  const over = Math.max(inner[0] + p.width / 2, p.width / 2 - inner[1]);
  return { centres, inner, width: b, crossDepth, stripOverlap: over > 1e-9 ? over : 0 };
}
