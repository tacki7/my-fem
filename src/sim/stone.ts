/**
 * Stone's minimum rollable thickness.
 *
 * Take the Siebel / von Kármán load P = k* Qp L, Qp = (e^a - 1)/a with
 * a = mu L / h̄, on Hitchcock's flattened arc L^2 = R' dh = R dh + C R P,
 * C = 16 (1 - nu^2)/(pi E). The arc cancels out of the load,
 * P = k* h̄ (e^a - 1)/mu, and putting that back into the arc closes it on a:
 *
 *     a^2 = mu^2 R dh / h̄^2 + z (e^a - 1),     z = C mu R k* / h̄
 *
 * The flattening fixed point is a root of this. As the draft goes to zero the
 * first term goes with it, and a root exists only while
 *
 *     z <= max_a a^2/(e^a - 1) = 0.64761...,   at a = 2 (1 - e^-a) = 1.59362...
 *
 * Past that the barrel flattens faster than the gap closes and no load holds
 * the pass. Solved for the thickness:
 *
 *     h_min = C mu R k* / 0.64761
 *
 * which at nu = 0.3 is 7.157 mu R k* / E - Stone's published 3.58 D mu k* / E.
 * The finite-draft term only takes room away (max_a (a^2 - d)/(e^a - 1) falls
 * as d grows), so a real pass runs away at a gauge a little *above* this one;
 * `tools/slab/stone.mjs` checks both against `slabLoad`. Roberts' arc has the
 * same zero-draft limit, L^2 = 4b^2 = C R P, so the constant does not depend
 * on the flattening model.
 *
 * Reading C mu R k* alone as h_min - taking z = 1 as the limit - put the
 * floor 1.544 times too thin.
 */

/** max over a > 0 of a^2/(e^a - 1), the largest z the flattened arc survives. */
export const STONE_Z_MAX = 0.647610237891915;

/**
 * Stone's minimum rollable thickness [m] for a roll of Young's modulus `E`
 * [Pa], Poisson ratio `nu` and radius `R` [m] at friction `mu`, against a
 * resistance `kEff` = kf - (sigma_b + sigma_f)/2 [Pa] (held at zero or above).
 */
export function stoneMinThickness(E: number, nu: number, mu: number, R: number, kEff: number): number {
  const C = (16 * (1 - nu * nu)) / (Math.PI * E);
  return (C * mu * R * Math.max(kEff, 0)) / STONE_Z_MAX;
}
