/**
 * Compressed sparse row storage plus a filtered preconditioned conjugate
 * gradient solver.
 *
 * The mesh topology never changes, so the sparsity pattern and the
 * element->value scatter map are built once. Every time step then only rewrites
 * the numeric values, which keeps assembly to a single flat loop.
 *
 * "Filtered" CG means Dirichlet constraints (the nodes bonded to the rigid core)
 * are enforced by projecting the constrained degrees of freedom out of every
 * search direction instead of by editing the matrix. This is the standard
 * Baraff-Witkin trick and costs one extra pass over the solution vector.
 */

export interface CsrPattern {
  /** number of rows (= 2 * node count) */
  n: number;
  rowPtr: Int32Array;
  colIdx: Int32Array;
  /** index of the diagonal entry of each row inside colIdx/values */
  diagIdx: Int32Array;
  /** For each element, the values-array slot of local entry (a,b): 64 per elem */
  scatter: Int32Array;
  nnz: number;
}

/** Bytes a pattern is holding. */
export function patternBytes(p: CsrPattern): number {
  return p.rowPtr.byteLength + p.colIdx.byteLength
    + p.diagIdx.byteLength + p.scatter.byteLength;
}

export function buildCsrPattern(nn: number, quads: Int32Array): CsrPattern {
  const ne = quads.length / 4;

  // node -> set of neighbour nodes (self included)
  const nbr: Set<number>[] = new Array(nn);
  for (let i = 0; i < nn; i++) nbr[i] = new Set<number>();
  for (let e = 0; e < ne; e++) {
    for (let a = 0; a < 4; a++) {
      const na = quads[4 * e + a];
      for (let b = 0; b < 4; b++) nbr[na].add(quads[4 * e + b]);
    }
  }

  const n = 2 * nn;
  const rowPtr = new Int32Array(n + 1);
  const sortedNbr: Int32Array[] = new Array(nn);
  for (let i = 0; i < nn; i++) {
    const arr = Int32Array.from(nbr[i]);
    arr.sort();
    sortedNbr[i] = arr;
    rowPtr[2 * i + 1] = arr.length * 2;
    rowPtr[2 * i + 2] = arr.length * 2;
  }
  for (let r = 0; r < n; r++) rowPtr[r + 1] += rowPtr[r];

  const nnz = rowPtr[n];
  const colIdx = new Int32Array(nnz);
  const diagIdx = new Int32Array(n);
  // node -> (neighbour node -> position within that node's neighbour list)
  const posOf: Map<number, number>[] = new Array(nn);
  for (let i = 0; i < nn; i++) {
    const arr = sortedNbr[i];
    const map = new Map<number, number>();
    for (let k = 0; k < arr.length; k++) map.set(arr[k], k);
    posOf[i] = map;
    for (let d = 0; d < 2; d++) {
      const row = 2 * i + d;
      let p = rowPtr[row];
      for (let k = 0; k < arr.length; k++) {
        colIdx[p++] = 2 * arr[k];
        colIdx[p++] = 2 * arr[k] + 1;
      }
      diagIdx[row] = rowPtr[row] + 2 * map.get(i)! + d;
    }
  }

  const scatter = new Int32Array(64 * ne);
  for (let e = 0; e < ne; e++) {
    for (let a = 0; a < 4; a++) {
      const na = quads[4 * e + a];
      for (let da = 0; da < 2; da++) {
        const row = 2 * na + da;
        const base = rowPtr[row];
        for (let b = 0; b < 4; b++) {
          const nb = quads[4 * e + b];
          const p = base + 2 * posOf[na].get(nb)!;
          scatter[64 * e + (2 * a + da) * 8 + 2 * b] = p;
          scatter[64 * e + (2 * a + da) * 8 + 2 * b + 1] = p + 1;
        }
      }
    }
  }

  return { n, rowPtr, colIdx, diagIdx, scatter, nnz };
}

/** y = A * x */
export function spmv(
  p: CsrPattern,
  vals: Float64Array,
  x: Float64Array,
  y: Float64Array,
): void {
  const { n, rowPtr, colIdx } = p;
  for (let r = 0; r < n; r++) {
    let s = 0;
    const end = rowPtr[r + 1];
    for (let k = rowPtr[r]; k < end; k++) s += vals[k] * x[colIdx[k]];
    y[r] = s;
  }
}

export interface PcgWorkspace {
  r: Float64Array;
  d: Float64Array;
  q: Float64Array;
  s: Float64Array;
  /**
   * Jacobi diagonal, for the case where no preconditioner is supplied.
   *
   * Allocated on first use rather than up front: every call site in this app
   * passes a band preconditioner, so this would otherwise be a full-length
   * double array per solver that is never read - and there are two solvers per
   * stand and eight stands.
   */
  invDiag: Float64Array | null;
  /** row count, so the lazy allocation knows how big to be */
  n: number;
}

export interface Preconditioner {
  /** z = M^-1 r, with z zeroed on constrained rows */
  apply(r: Float64Array, z: Float64Array, free: Uint8Array): void;
}

export function makePcgWorkspace(n: number): PcgWorkspace {
  return {
    r: new Float64Array(n),
    d: new Float64Array(n),
    q: new Float64Array(n),
    s: new Float64Array(n),
    invDiag: null,
    n,
  };
}

/** Bytes a workspace is holding, including the diagonal only if it exists. */
export function workspaceBytes(ws: PcgWorkspace): number {
  return ws.r.byteLength + ws.d.byteLength + ws.q.byteLength + ws.s.byteLength
    + (ws.invDiag?.byteLength ?? 0);
}

export interface PcgResult {
  iterations: number;
  /** ||r|| / ||b|| after the last iteration */
  residual: number;
}

/**
 * Solve A z = b for the free degrees of freedom, with z forced to zero wherever
 * `free[i] === 0`. Caller adds back the prescribed increment.
 *
 * @param pre  preconditioner; falls back to Jacobi when null
 * @param tol  target for ||r|| / ||b|| over the free DOFs. r is the unpreconditioned
 *             residual, so the stopping rule does not shift when the preconditioner
 *             changes - but it is the recursively updated one, r <- r - alpha A d,
 *             not b - A z recomputed. The two agree in exact arithmetic and drift
 *             apart by rounding over many iterations; the returned `residual` is
 *             the recursive one too.
 */
export function pcgFiltered(
  p: CsrPattern,
  vals: Float64Array,
  b: Float64Array,
  free: Uint8Array,
  z: Float64Array,
  ws: PcgWorkspace,
  maxIter: number,
  tol: number,
  warmStart: boolean,
  pre: Preconditioner | null,
): PcgResult {
  const { n, diagIdx } = p;
  const { r, d, q, s } = ws;

  let invDiag: Float64Array | null = null;
  if (!pre) {
    invDiag = ws.invDiag ?? (ws.invDiag = new Float64Array(n));
    for (let i = 0; i < n; i++) {
      const dv = vals[diagIdx[i]];
      invDiag[i] = dv > 1e-30 ? 1 / dv : 0;
    }
  }
  const applyPre = (src: Float64Array, dst: Float64Array) => {
    if (pre) {
      pre.apply(src, dst, free);
    } else {
      const inv = invDiag!;
      for (let i = 0; i < n; i++) dst[i] = free[i] ? inv[i] * src[i] : 0;
    }
  };

  let bb = 0;
  for (let i = 0; i < n; i++) if (free[i]) bb += b[i] * b[i];
  if (!(bb > 0)) {
    z.fill(0);
    return { iterations: 0, residual: 0 };
  }

  if (warmStart) {
    // Rolling contact settles into a quasi steady state, so the previous
    // increment is a good starting point.
    for (let i = 0; i < n; i++) if (!free[i]) z[i] = 0;
    spmv(p, vals, z, q);
    for (let i = 0; i < n; i++) r[i] = free[i] ? b[i] - q[i] : 0;
  } else {
    z.fill(0);
    for (let i = 0; i < n; i++) r[i] = free[i] ? b[i] : 0;
  }

  applyPre(r, d);
  let delta = 0;
  for (let i = 0; i < n; i++) delta += r[i] * d[i];

  const target = tol * tol * bb;
  let rr = 0;
  for (let i = 0; i < n; i++) rr += r[i] * r[i];

  let it = 0;
  for (; it < maxIter && rr > target; it++) {
    spmv(p, vals, d, q);
    let dq = 0;
    for (let i = 0; i < n; i++) {
      if (!free[i]) q[i] = 0;
      dq += d[i] * q[i];
    }
    if (!(Math.abs(dq) > 1e-300)) break;
    const alpha = delta / dq;
    rr = 0;
    for (let i = 0; i < n; i++) {
      z[i] += alpha * d[i];
      const rv = r[i] - alpha * q[i];
      r[i] = rv;
      rr += rv * rv;
    }
    applyPre(r, s);
    let deltaNew = 0;
    for (let i = 0; i < n; i++) deltaNew += r[i] * s[i];
    const beta = deltaNew / delta;
    for (let i = 0; i < n; i++) d[i] = free[i] ? s[i] + beta * d[i] : 0;
    delta = deltaNew;
  }

  return { iterations: it, residual: Math.sqrt(rr / bb) };
}
