/**
 * The arithmetic behind the contour view (contour3d.ts), kept apart from WebGL so the node
 * checks can run it: which colour a value gets, the colour bar's range, the surface's
 * normals with its sharp edges kept sharp, the element edges for the mesh lines.
 *
 * Colour: the page maps each nodal value to t = (v − lo) / (hi − lo) here, on the CPU, and the
 * shader only cuts t into bands and looks the band up in the ramp. So the legend (drawn from
 * `bandOf`) and the picture agree by construction, and a range change is one pass over the
 * values, not a shader rebuild.
 */

export interface FieldInfo {
  /** what it is, for the legend's title */
  label: string;
  /** display unit, and the factor from SI to it */
  unit: string;
  scale: number;
  /** signed about 0 (a diverging ramp, the auto range symmetric) */
  signed: boolean;
}

const FIELDS: Record<string, FieldInfo> = {
  mises: { label: 'ミーゼス相当応力', unit: 'MPa', scale: 1e-6, signed: false },
  cpress: { label: '接触面圧', unit: 'MPa', scale: 1e-6, signed: false },
  s_zz: { label: '圧延方向応力 σzz', unit: 'MPa', scale: 1e-6, signed: true },
  p: { label: '静水圧 −σm', unit: 'MPa', scale: 1e-6, signed: false },
  flow: { label: '変形抵抗 σ̄', unit: 'MPa', scale: 1e-6, signed: false },
  eq: { label: '相当ひずみ（この圧延）', unit: '', scale: 1, signed: false },
  peeq: { label: '相当塑性ひずみ', unit: '', scale: 1, signed: false },
  eqRate: { label: '相当ひずみ速度', unit: '1/s', scale: 1, signed: false },
  vx: { label: '速度 vx（幅方向）', unit: 'm/s', scale: 1, signed: true },
  vy: { label: '速度 vy（板厚方向）', unit: 'm/s', scale: 1, signed: true },
  vz: { label: '速度 vz（圧延方向）', unit: 'm/s', scale: 1, signed: false },
};

/** the fields in the order the selectors list them */
export const FIELD_ORDER = ['mises', 'cpress', 's_zz', 'eq', 'peeq', 'eqRate', 'p', 'flow', 'vz', 'vx', 'vy'];

export function fieldInfo(name: string): FieldInfo {
  return FIELDS[name] ?? { label: name, unit: '', scale: 1, signed: false };
}

export interface Range {
  lo: number;
  hi: number;
  /** every finite value was the same (the initial state): the bar shows that value, not a spread */
  uniform: boolean;
  /** finite values the range was taken over */
  count: number;
}

/**
 * The colour bar's range over some parts' values: min … max of the finite ones, symmetric
 * about 0 for a signed field. With nothing finite, or all one value, a unit-wide range around
 * that value (so t is 0.5 for signed and 0 otherwise, not 0/0).
 */
export function autoRange(arrays: ArrayLike<number>[], signed: boolean): Range {
  let lo = Infinity, hi = -Infinity, count = 0;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      count++;
    }
  }
  if (!count) return { lo: signed ? -1 : 0, hi: 1, uniform: true, count };
  if (signed) { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
  const span = hi - lo, mag = Math.max(Math.abs(lo), Math.abs(hi));
  if (!(span > 1e-9 * mag) || span === 0) {
    const v = signed ? 0 : lo;
    const w = mag > 0 ? mag : 1;
    return signed ? { lo: -w, hi: w, uniform: true, count } : { lo: v, hi: v + w, uniform: true, count };
  }
  return { lo, hi, uniform: false, count };
}

/**
 * The q-quantile (0 … 1) of the finite values, to a 4096th of their spread: a histogram over
 * min … max, then the bin where the count crosses q. For the colour bar's top: FrontISTR's roll
 * puts the strip load on node rings, and one node's local concentration (2.96 GPa on the 4Hi
 * default, against a few hundred MPa under the contact) would otherwise take the whole bar,
 * leaving the rest of the roll in its bottom band.
 */
export function quantile(arrays: ArrayLike<number>[], q: number, abs = false): number {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++) {
    const v = abs ? Math.abs(a[i]) : a[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    n++;
  }
  if (!n) return NaN;
  if (!(hi > lo)) return lo;
  const B = 4096, bins = new Uint32Array(B), k = (B - 1) / (hi - lo);
  for (const a of arrays) for (let i = 0; i < a.length; i++) {
    const v = abs ? Math.abs(a[i]) : a[i];
    if (Number.isFinite(v)) bins[Math.floor((v - lo) * k)]++;
  }
  const want = Math.max(0, Math.min(1, q)) * n;
  let acc = 0;
  for (let b = 0; b < B; b++) {
    acc += bins[b];
    if (acc >= want) return Math.min(hi, lo + (b + 1) / k);
  }
  return hi;
}

export type RangeMode = 'auto' | 'full' | 'fixed';

/** the share of the finite values the automatic range's top leaves above it */
export const AUTO_TAIL = 0.005;

/**
 * The bar's range for a mode: 'full' min … max, 'auto' the same with the top at the 99.5 %
 * point (a signed field: ± the 99.5 % point of |v|), 'fixed' the given one.
 */
export function rangeFor(arrays: ArrayLike<number>[], signed: boolean, mode: RangeMode, fixed?: { lo: number; hi: number }): Range {
  const full = autoRange(arrays, signed);
  if (mode === 'fixed' && fixed && fixed.hi > fixed.lo) return { lo: fixed.lo, hi: fixed.hi, uniform: false, count: full.count };
  if (mode !== 'auto' || full.uniform) return full;
  const top = quantile(arrays, 1 - AUTO_TAIL, signed);
  if (signed) return top > 0 ? { lo: -top, hi: top, uniform: false, count: full.count } : full;
  return top > full.lo ? { lo: full.lo, hi: top, uniform: false, count: full.count } : full;
}

export interface NormalizeCounts {
  /** nodes with no value (NaN or ±∞) */
  missing: number;
  below: number;
  above: number;
  total: number;
}

/**
 * t = (v − lo) / (hi − lo) into `t`, and 1 / 0 into `valid` for a value / none. Values
 * outside the range keep their t (below 0, above 1): the shader draws them in the end colour
 * with a hatch, and the counts go to the legend. A missing value's t is 0.
 */
export function normalizeInto(t: Float32Array, valid: Float32Array, values: ArrayLike<number>, lo: number, hi: number): NormalizeCounts {
  const n = values.length;
  const inv = hi > lo ? 1 / (hi - lo) : 0;
  let missing = 0, below = 0, above = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { t[i] = 0; valid[i] = 0; missing++; continue; }
    const u = (v - lo) * inv;
    t[i] = u; valid[i] = 1;
    if (u < 0) below++; else if (u > 1) above++;
  }
  return { missing, below, above, total: n };
}

/**
 * The band of a normalised value, exactly as the fragment shader cuts it: 0 … bands−1 in the
 * range (the top end, t = 1, in the last band), −1 below, `bands` above. `bands` 0 is the
 * continuous ramp, which this reports as band 0 … 255 of the 256 texels.
 */
export function bandOf(t: number, bands: number): number {
  if (t < 0) return -1;
  if (t > 1) return bands > 0 ? bands : 256;
  const n = bands > 0 ? bands : 256;
  return Math.min(n - 1, Math.floor(t * n));
}

/** where band b's colour is read in the ramp (its middle), before the ramp's lifted floor */
export function bandCentre(b: number, bands: number): number {
  const n = bands > 0 ? bands : 256;
  return (Math.max(0, Math.min(n - 1, b)) + 0.5) / n;
}

/** the ramp coordinate for a band centre: the ramp's darkest end is left out so a shaded low value is not lost on the dark screen */
export const RAMP_FLOOR = 0.26;
export const rampCoord = (u: number, floor = RAMP_FLOOR): number => floor + (1 - floor) * u;

/** the index of the largest (or smallest) finite value, −1 if none */
export function argExtreme(values: ArrayLike<number>, largest = true): number {
  let best = -1, bv = largest ? -Infinity : Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (largest ? v > bv : v < bv) { bv = v; best = i; }
  }
  return best;
}

export interface SplitSurface {
  /** the drawn vertex → the part's node */
  src: Uint32Array;
  /** triangles over the drawn vertices */
  tris: Uint32Array;
}

/**
 * Sharp edges kept sharp: a node where faces meet at more than the crease angle (the rim of a
 * roll's end face, the edge of the strip) is drawn as one vertex per smooth group of its faces,
 * so the smooth normals do not average a cylinder and its end face into a dark 45° smear.
 * FrontISTR's surface shares its nodes across such edges; the strip's block does too.
 */
export function splitCreases(coords: ArrayLike<number>, tris: ArrayLike<number>, cosCrease = Math.cos((40 * Math.PI) / 180)): SplitSurface {
  const nn = coords.length / 3, nt = tris.length / 3;
  // face normals (unit)
  const fn = new Float32Array(3 * nt);
  for (let f = 0; f < nt; f++) {
    const a = 3 * tris[3 * f], b = 3 * tris[3 * f + 1], c = 3 * tris[3 * f + 2];
    const ux = coords[b] - coords[a], uy = coords[b + 1] - coords[a + 1], uz = coords[b + 2] - coords[a + 2];
    const vx = coords[c] - coords[a], vy = coords[c + 1] - coords[a + 1], vz = coords[c + 2] - coords[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    fn[3 * f] = x / l; fn[3 * f + 1] = y / l; fn[3 * f + 2] = z / l;
  }
  // faces around each node (CSR)
  const deg = new Uint32Array(nn + 1);
  for (let i = 0; i < 3 * nt; i++) deg[tris[i] + 1]++;
  for (let i = 0; i < nn; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, nn), around = new Uint32Array(3 * nt);
  for (let i = 0; i < 3 * nt; i++) around[fill[tris[i]]++] = i;
  // per node: group its face corners by normal; the first group keeps the node's own number
  const outTris = new Uint32Array(3 * nt);
  const src: number[] = [];
  for (let n = 0; n < nn; n++) src.push(n);
  const repX: number[] = [], repY: number[] = [], repZ: number[] = [], id: number[] = [];
  for (let n = 0; n < nn; n++) {
    repX.length = repY.length = repZ.length = id.length = 0;
    for (let q = deg[n]; q < deg[n + 1]; q++) {
      const corner = around[q], f = (corner / 3) | 0;
      const x = fn[3 * f], y = fn[3 * f + 1], z = fn[3 * f + 2];
      let g = -1;
      for (let k = 0; k < id.length; k++) if (x * repX[k] + y * repY[k] + z * repZ[k] >= cosCrease) { g = k; break; }
      if (g < 0) {
        g = id.length;
        repX.push(x); repY.push(y); repZ.push(z);
        if (g === 0) id.push(n); else { id.push(src.length); src.push(n); }
      }
      outTris[corner] = id[g];
    }
  }
  return { src: Uint32Array.from(src), tris: outTris };
}

/** smooth (area-weighted) vertex normals of a triangle list into `out` (3 per vertex); 200 000 vertices in a few ms */
export function vertexNormals(pos: ArrayLike<number>, tris: ArrayLike<number>, out: Float32Array): void {
  out.fill(0);
  const nt = tris.length;
  for (let f = 0; f < nt; f += 3) {
    const a = 3 * tris[f], b = 3 * tris[f + 1], c = 3 * tris[f + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    out[a] += x; out[a + 1] += y; out[a + 2] += z;
    out[b] += x; out[b + 1] += y; out[b + 2] += z;
    out[c] += x; out[c + 1] += y; out[c + 2] += z;
  }
  // (Math.hypot is several times slower than this in V8)
  for (let i = 0; i < out.length; i += 3) {
    const x = out[i], y = out[i + 1], z = out[i + 2];
    const l2 = x * x + y * y + z * z;
    if (l2 > 0) { const k = 1 / Math.sqrt(l2); out[i] = x * k; out[i + 1] = y * k; out[i + 2] = z * k; } else { out[i + 1] = 1; }
  }
}

/**
 * The element edges for the mesh lines, each once. A quadrilateral comes as two triangles in a
 * row, (a, b, c) then (a, c, d) - the way both the bridge and the strip's block split them - and
 * its diagonal a–c is not an element edge, so it is left out.
 */
export function meshEdges(tris: ArrayLike<number>): Uint32Array {
  const nt = tris.length / 3;
  const diag = new Uint8Array(nt); // bit k: skip edge k (k: 0 = v0v1, 1 = v1v2, 2 = v2v0)
  for (let f = 0; f + 1 < nt; f++) {
    const a = tris[3 * f], c = tris[3 * f + 2], a2 = tris[3 * f + 3], c2 = tris[3 * f + 4];
    if (a === a2 && c === c2) { diag[f] |= 4; diag[f + 1] |= 1; }
  }
  const seen = new Set<number>();
  const out: number[] = [];
  let big = 0;
  for (let i = 0; i < tris.length; i++) big = Math.max(big, tris[i] + 1);
  for (let f = 0; f < nt; f++) {
    for (let k = 0; k < 3; k++) {
      if (diag[f] & (1 << k)) continue;
      const p = tris[3 * f + k], q = tris[3 * f + ((k + 1) % 3)];
      const lo = Math.min(p, q), hi = Math.max(p, q);
      const key = lo * big + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(lo, hi);
    }
  }
  return Uint32Array.from(out);
}

/** a number for the legend: 3 significant figures, no exponent for the usual sizes */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return v.toFixed(d);
}
