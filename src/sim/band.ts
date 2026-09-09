/**
 * Banded LDL^T preconditioner.
 *
 * With the sector-major node numbering from mesh.ts every element couples node
 * ids that differ by at most nr+2, so the assembled matrix is banded apart from
 * one thing: the seam where sector nt-1 wraps back to sector 0. Those few
 * entries are simply dropped here - as a *preconditioner* the cut ring is an
 * excellent approximation of the closed ring, and conjugate gradients clears up
 * the handful of modes it gets wrong within a few iterations.
 *
 * Fill-in inside the band is kept in full, so for an already-banded matrix -
 * the strip, whose mesh has no seam - this is an exact direct solve and the
 * conjugate gradients that follow converge in a single step. For the roll it
 * degrades gracefully to a very strong preconditioner. Cost is O(n*b^2/2) to
 * factorise and O(2*n*b) to apply, both with unit stride.
 *
 * Dirichlet rows (the nodes bonded to the rigid core) are replaced by identity
 * so the preconditioner commutes with the constraint filter.
 */

import type { CsrPattern } from './sparse';

export class BandPreconditioner {
  readonly n: number;
  readonly b: number;
  /** lower triangle, row-major: L[r*(b+1) + (r-c)], slot 0 is the diagonal */
  private L: Float64Array;
  private D: Float64Array;
  private valid = false;

  constructor(n: number, halfBandwidth: number) {
    this.n = n;
    this.b = halfBandwidth;
    this.L = new Float64Array(n * (halfBandwidth + 1));
    this.D = new Float64Array(n);
  }

  get isValid(): boolean { return this.valid; }
  invalidate(): void { this.valid = false; }

  byteLength(): number { return this.L.byteLength + this.D.byteLength; }

  /** Rebuild the factorisation from the current matrix values. */
  factor(p: CsrPattern, vals: Float64Array, free: Uint8Array): void {
    const { n, b } = this;
    const L = this.L;
    const D = this.D;
    const w = b + 1;
    L.fill(0);

    // gather the lower band, skipping the wrap-around seam and constrained rows
    let scale = 0;
    for (let r = 0; r < n; r++) {
      if (!free[r]) { L[r * w] = 1; continue; }
      const end = p.rowPtr[r + 1];
      for (let k = p.rowPtr[r]; k < end; k++) {
        const c = p.colIdx[k];
        if (c > r || !free[c]) continue;
        const d = r - c;
        if (d > b) continue;              // seam entry, dropped on purpose
        L[r * w + d] = vals[k];
      }
      const dg = L[r * w];
      if (dg > scale) scale = dg;
    }
    const floor = Math.max(scale, 1) * 1e-12;

    // LDL^T, banded, in place
    for (let j = 0; j < n; j++) {
      const jw = j * w;
      let d = L[jw];
      const kLo = j - b > 0 ? j - b : 0;
      for (let k = kLo; k < j; k++) {
        const ljk = L[jw + (j - k)];
        d -= ljk * ljk * D[k];
      }
      if (!(d > floor)) d = floor;        // keep the factor usable if the drop
      D[j] = d;                            // ever spoils definiteness
      const inv = 1 / d;

      const iHi = j + b < n - 1 ? j + b : n - 1;
      for (let i = j + 1; i <= iHi; i++) {
        const iw = i * w;
        // NB: no early-out on a zero entry. A[i][j] being zero says nothing
        // about L[i][j]; skipping those is dropping fill-in, which both ruins
        // the factor and lets the recursion overflow into NaN.
        let s = L[iw + (i - j)];
        const lo = i - b > 0 ? i - b : 0;
        for (let k = lo; k < j; k++) {
          s -= L[iw + (i - k)] * L[jw + (j - k)] * D[k];
        }
        L[iw + (i - j)] = s * inv;
      }
    }
    this.valid = true;
  }

  /** z = M^-1 r, with z forced to zero on constrained rows. */
  apply(r: Float64Array, z: Float64Array, free: Uint8Array): void {
    const { n, b } = this;
    const L = this.L;
    const D = this.D;
    const w = b + 1;

    for (let i = 0; i < n; i++) {
      const lo = i - b > 0 ? i - b : 0;
      const iw = i * w;
      let s = free[i] ? r[i] : 0;
      for (let k = lo; k < i; k++) s -= L[iw + (i - k)] * z[k];
      z[i] = s;
    }
    for (let i = 0; i < n; i++) z[i] /= D[i];
    for (let i = n - 1; i >= 0; i--) {
      const hi = i + b < n - 1 ? i + b : n - 1;
      let s = z[i];
      for (let k = i + 1; k <= hi; k++) s -= L[k * w + (k - i)] * z[k];
      z[i] = free[i] ? s : 0;
    }
  }
}

/** Largest |row - col| that is not a wrap-around seam entry. */
export function bandwidthFor(nr: number): number {
  // node ids inside one element differ by at most nr+2; two dofs per node
  return 2 * (nr + 2) + 1;
}
