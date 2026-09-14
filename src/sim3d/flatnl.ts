/**
 * The work roll's flattening by the strip, spread along the roll - the
 * non-local flattening mode (`Params3D.flatNonlocal`).
 *
 * The contact law (`contact.ts`) gives each slice the flattening of an
 * infinitely long roll under that slice's own load per unit width, Johnson's
 * δ = q A [2 ln(4R/b) − 1] with A = (1 − ν²)/(πE). A real roll is also
 * pressed in by its neighbours' loads, and beyond the strip edge it carries
 * none: at the edge of a uniformly loaded length the surface goes down by
 * about half of what it does inside. Written per slice, the flattening can
 * only follow the load, so the edge thinning was confined to the last two
 * slices, however fine the grid.
 *
 * Here the roll surface is a half-space (Boussinesq, Johnson §3.2; the
 * same integral as the plate-profile theory of Tozawa and Ueda 1970): a
 * pressure p = q/(2b) over the arc half-width b in the rolling direction
 * pushes the surface down, at an axial distance s from the load, by
 *
 *     A q K(s),   K(s) = asinh(b/|s|) / b,   ∫₀ᵗ K = (t/b) asinh(b/t) + asinh(t/b).
 *
 * The half-space alone never settles for a load along an infinite line (the
 * integral of K grows like ln), so K is cut off at |s| = L, the length that
 * gives the 2D law back for a uniform load: 2∫₀ᴸ K = 2 ln(4R/b) − 1, which
 * for L ≫ b is L = 2R e^{−3/2} ≈ 0.446 R. Away from the strip edges the
 * mode then changes nothing; within about L of an edge the flattening falls.
 *
 * The solver keeps each slice's own flattening law (Hertz or the ring FEM)
 * and adds the difference between this sum and the half-space's own 2D
 * value for the slice's load as an offset (`nonlocalOffsets`).
 */

/** ∫₀ᵗ K(s) ds for t ≥ 0 */
function kernelUpTo(t: number, b: number): number {
  return t <= 0 ? 0 : (t / b) * Math.asinh(b / t) + Math.asinh(t / b);
}

/**
 * The cut-off L at which a uniform line load gives the 2D law back:
 * 2 ∫₀ᴸ K = 2 ln(4R/b) − 1. The integral grows monotonically in L (its
 * slope is K(L) > 0), so a Newton from the long-length value converges; it is
 * safeguarded with a bracket for the short rolls where b is not ≪ L.
 */
export function nlCutoff(R: number, b: number): number {
  const target = Math.log((4 * R) / b) - 0.5;
  if (!(target > 0)) return b * 1e-3;
  let lo = 0, hi = Infinity;
  let L = Math.max(2 * R * Math.exp(-1.5), 2 * b);
  for (let it = 0; it < 60; it++) {
    const f = kernelUpTo(L, b) - target;
    if (Math.abs(f) <= 1e-13 * target) break;
    if (f < 0) lo = L; else hi = L;
    let next = L - f / (Math.asinh(b / L) / b);
    if (!(next > lo && next < hi)) next = Number.isFinite(hi) ? 0.5 * (lo + hi) : 2 * L;
    L = next;
  }
  return L;
}

/** ∫ K(s) ds over [s1, s2] (s1 ≤ s2), the kernel cut off at |s| = L */
export function nlKernelIntegral(s1: number, s2: number, b: number, L: number): number {
  const a = Math.max(s1, -L), c = Math.min(s2, L);
  if (c <= a) return 0;
  if (a >= 0) return kernelUpTo(c, b) - kernelUpTo(a, b);
  if (c <= 0) return kernelUpTo(-a, b) - kernelUpTo(-c, b);
  return kernelUpTo(-a, b) + kernelUpTo(c, b);
}

/**
 * Each slice's non-local flattening less its local 2D value [m]: the offset
 * to add to the slice's own flattening.
 *
 * `x` the slice positions (ascending), `c0`/`c1` each slice's loaded extent
 * along the roll (its cell clipped to the strip), `q` the loads [N/m] (a
 * slice with q ≤ 0 loads nothing), `b` the contact half-widths in the rolling
 * direction [m], `A` = (1 − ν²)/(πE) of the roll, `R` its radius.
 */
export function nonlocalOffsets(
  x: ArrayLike<number>, c0: ArrayLike<number>, c1: ArrayLike<number>,
  q: ArrayLike<number>, b: ArrayLike<number>, A: number, R: number,
  out = new Float64Array(x.length),
): Float64Array {
  const n = x.length;
  const L = new Float64Array(n);
  let Lmax = 0;
  for (let j = 0; j < n; j++) {
    L[j] = q[j] > 0 ? nlCutoff(R, b[j]) : 0;
    Lmax = Math.max(Lmax, L[j]);
  }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    // the kernel is cut off at L: only the loads whose extent comes within Lmax count
    for (let j = i; j >= 0 && x[i] - c1[j] < Lmax; j--) {
      if (q[j] > 0) acc += q[j] * nlKernelIntegral(c0[j] - x[i], c1[j] - x[i], b[j], L[j]);
    }
    for (let j = i + 1; j < n && c0[j] - x[i] < Lmax; j++) {
      if (q[j] > 0) acc += q[j] * nlKernelIntegral(c0[j] - x[i], c1[j] - x[i], b[j], L[j]);
    }
    const local = q[i] > 0 ? q[i] * (2 * Math.log((4 * R) / b[i]) - 1) : 0;
    out[i] = A * (acc - local);
  }
  return out;
}
