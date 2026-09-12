/**
 * Symmetric banded matrix with a Cholesky factorisation.
 *
 * The roll stack is numbered station by station (see `solver.ts`), so every
 * coupling - a beam element to the next station, a contact to another roll at
 * the same station - stays within a fixed distance of the diagonal. A banded
 * factorisation then costs n·hb²/2 multiplies: for a 20Hi upper half on 81
 * stations that is about three million, well inside one frame, and there is
 * no fill-in to worry about because the band is already the profile.
 *
 * Lower triangle stored row-major: entry (i, j), j in [i-hb, i], sits at
 * `i*(hb+1) + (j-i+hb)`.
 */
export class BandMatrix {
  readonly n: number;
  readonly hb: number;
  readonly w: number;
  readonly a: Float64Array;

  constructor(n: number, hb: number) {
    this.n = n;
    this.hb = hb;
    this.w = hb + 1;
    this.a = new Float64Array(n * this.w);
  }

  clear(): void { this.a.fill(0); }

  /** add v to (i, j); either order, the lower half is what is kept */
  add(i: number, j: number, v: number): void {
    if (j > i) { const t = i; i = j; j = t; }
    this.a[i * this.w + (j - i + this.hb)] += v;
  }

  get(i: number, j: number): number {
    if (j > i) { const t = i; i = j; j = t; }
    if (i - j > this.hb) return 0;
    return this.a[i * this.w + (j - i + this.hb)];
  }

  /**
   * In-place Cholesky, L·Lᵀ. Returns false on a non-positive pivot, which
   * with the regularising springs the assembler adds means a genuinely bad
   * matrix rather than an unloaded roll.
   */
  cholesky(): boolean {
    const { n, hb, w, a } = this;
    for (let i = 0; i < n; i++) {
      const j0 = Math.max(0, i - hb);
      // a[bi + k] is entry (i, k)
      const bi = i * w + hb - i;
      for (let j = j0; j <= i; j++) {
        const bj = j * w + hb - j;
        let s = a[bi + j];
        const k0 = Math.max(j0, j - hb);
        for (let k = k0; k < j; k++) s -= a[bi + k] * a[bj + k];
        if (i === j) {
          if (!(s > 0)) return false;
          a[bi + i] = Math.sqrt(s);
        } else {
          a[bi + j] = s / a[bj + j];
        }
      }
    }
    return true;
  }

  /** solve L·Lᵀ x = e_j (unit vector at row j) into x; the forward sweep starts at j */
  solveUnit(j: number, x: Float64Array): void {
    const { n, hb, w, a } = this;
    x.fill(0);
    x[j] = 1;
    for (let i = j; i < n; i++) {
      const bi = i * w + hb - i;
      let s = x[i];
      const k0 = Math.max(j, i - hb);
      for (let k = k0; k < i; k++) s -= a[bi + k] * x[k];
      x[i] = s / a[bi + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      const bi = i * w + hb - i;
      const xi = x[i] / a[bi + i];
      x[i] = xi;
      const k0 = Math.max(0, i - hb);
      for (let k = k0; k < i; k++) x[k] -= a[bi + k] * xi;
    }
  }

  /** solve L·Lᵀ x = b after `cholesky`; x may alias b */
  solve(b: Float64Array, x: Float64Array): void {
    const { n, hb, w, a } = this;
    if (x !== b) x.set(b);
    // forward: L y = b
    for (let i = 0; i < n; i++) {
      const bi = i * w + hb - i;
      let s = x[i];
      const k0 = Math.max(0, i - hb);
      for (let k = k0; k < i; k++) s -= a[bi + k] * x[k];
      x[i] = s / a[bi + i];
    }
    // back: Lᵀ x = y, column by column so the reads stay in one row
    for (let i = n - 1; i >= 0; i--) {
      const bi = i * w + hb - i;
      const xi = x[i] / a[bi + i];
      x[i] = xi;
      const k0 = Math.max(0, i - hb);
      for (let k = k0; k < i; k++) x[k] -= a[bi + k] * xi;
    }
  }
}

/**
 * Dense LU with partial pivoting, in place on a row-major m×m array; solves
 * A x = b for one right-hand side. Used for the small Schur system of the
 * strip's tension coupling (one row per slice).
 */
export function denseSolve(A: Float64Array, m: number, b: Float64Array): boolean {
  for (let k = 0; k < m; k++) {
    let piv = k, best = Math.abs(A[k * m + k]);
    for (let i = k + 1; i < m; i++) {
      const v = Math.abs(A[i * m + k]);
      if (v > best) { best = v; piv = i; }
    }
    if (!(best > 1e-300)) return false;
    if (piv !== k) {
      for (let j = 0; j < m; j++) { const t = A[k * m + j]; A[k * m + j] = A[piv * m + j]; A[piv * m + j] = t; }
      const t = b[k]; b[k] = b[piv]; b[piv] = t;
    }
    const d = A[k * m + k];
    for (let i = k + 1; i < m; i++) {
      const f = A[i * m + k] / d;
      if (f === 0) continue;
      A[i * m + k] = f;
      for (let j = k + 1; j < m; j++) A[i * m + j] -= f * A[k * m + j];
      b[i] -= f * b[k];
    }
  }
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < m; j++) s -= A[i * m + j] * b[j];
    b[i] = s / A[i * m + i];
  }
  return true;
}
