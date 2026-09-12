/**
 * Elastic flattening at a line contact - the approach of two roll axes, or of
 * a roll axis and the strip, under a load per unit width.
 *
 * Each cylinder contributes the classical Hertz/Föppl compression of its own
 * body between the contact and its axis (Johnson, Contact Mechanics, §5.6):
 *
 *     δ_i = q (1-ν_i²)/(π E_i) · [ 2 ln(4 R_i / b) - 1 ]
 *
 * with b the contact half-width. Roll on roll, b is the Hertz half-width
 * b² = 4 q R_eq / (π E*), which grows with the root of the load. Roll on
 * strip, the load is spread over the plastic arc rather than an elastic
 * Hertz strip, so the half-width is whichever is longer of the Hertz value
 * and half the arc of contact, and the strip's own through-thickness
 * compression is left to the springback term of the strip model.
 *
 * δ(q) is monotone and concave, so the inverse q(δ) that the displacement
 * formulation wants is found by Newton from the left, which cannot
 * overshoot. The tangent dq/dδ is what the stack's Jacobian takes.
 */

export interface ContactLaw {
  /** per-body compliance (1-ν²)/(πE) for body 1, 2 - zero for a body left out */
  A1: number;
  A2: number;
  R1: number;
  R2: number;
  /** 4 R_eq / (π E*): b² = this · q */
  bCoef: number;
  /** a fixed contact half-width [m] that overrides the Hertz width when longer (strip arc) */
  bFloor: number;
}

export function makeContactLaw(
  E1: number, nu1: number, R1: number, E2: number, nu2: number, R2: number,
  opts: { bodyTwoRigid?: boolean; bFloor?: number } = {},
): ContactLaw {
  const c1 = (1 - nu1 * nu1) / E1;
  const c2 = (1 - nu2 * nu2) / E2;
  const invE = c1 + c2;
  const Req = Number.isFinite(R2) ? 1 / (1 / R1 + 1 / R2) : R1;
  return {
    A1: c1 / Math.PI,
    A2: opts.bodyTwoRigid || !Number.isFinite(R2) ? 0 : c2 / Math.PI,
    R1, R2,
    bCoef: (4 * Req * invE) / Math.PI,
    bFloor: opts.bFloor ?? 0,
  };
}

/** approach δ [m] at load q [N/m], and dδ/dq */
export function approach(c: ContactLaw, q: number): [number, number] {
  if (q <= 0) return [0, 0];
  const bh = Math.sqrt(c.bCoef * q);
  const hertz = bh >= c.bFloor;
  const b = hertz ? bh : c.bFloor;
  const t1 = 2 * Math.log((4 * c.R1) / b) - 1;
  const t2 = c.A2 > 0 ? 2 * Math.log((4 * c.R2) / b) - 1 : 0;
  const d = q * (c.A1 * t1 + c.A2 * t2);
  // b ∝ √q: d/dq [q (2 ln(4R/b) - 1)] = (2 ln(4R/b) - 1) - 1
  const dd = hertz ? c.A1 * (t1 - 1) + c.A2 * (t2 - 1) : c.A1 * t1 + c.A2 * t2;
  return [d, Math.max(dd, 1e-30)];
}

/**
 * Load q [N/m] at approach δ [m] and the tangent dq/dδ [N/m²].
 * Zero for an open gap. `qGuess` warm-starts the Newton.
 */
export function loadAt(c: ContactLaw, delta: number, qGuess = 0): [number, number] {
  if (delta <= 0) return [0, 0];
  // Start left of the root: the linear compliance with a generous log term.
  let q = qGuess > 0 ? qGuess * 0.5 : delta / ((c.A1 + c.A2) * 40 + 1e-30);
  for (let it = 0; it < 30; it++) {
    const [d, dd] = approach(c, q);
    const step = (delta - d) / dd;
    const next = q + step;
    if (next <= 0) { q *= 0.25; continue; }
    q = next;
    if (Math.abs(step) < 1e-9 * q) break;
  }
  const [, dd] = approach(c, q);
  return [q, 1 / dd];
}
