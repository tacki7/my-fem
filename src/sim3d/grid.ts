/**
 * The stations along the width. Every roll and the strip are solved on one
 * grid of them (see `solver.ts`); this is where it is laid out.
 *
 * Even by default: `stations` of them across the grid, as it always was. With
 * `stripStations` set, the strip gets a spacing of its own - N stations whose
 * cells tile the strip exactly, one of them at the centre (N is odd) - and off
 * the strip the spacing the even grid would have had there, so the rolls'
 * resolution beside the strip is still the station count's. A station's cell,
 * the width its contact and strip loads are gathered over, runs between the
 * midpoints to its neighbours. On the strip that puts a cell boundary on each
 * edge, so no edge slice is a sliver of a cell at any width.
 *
 * The refined grid is built as its right half and mirrored, so it is symmetric
 * to the bit (x[ns−1−s] = −x[s], and the same for the cells): the lower half of
 * a shifted stack is read against the upper one by turning the index around.
 */

/** the fewest stations an even grid has */
export const MIN_STATIONS = 11;
/**
 * The most stations the strip may be given. The strip's tension coupling is
 * dense in them (m² memory, m³ work per factorisation), and the Woodbury
 * flexibility is m columns of the whole system.
 */
export const MAX_STRIP_STATIONS = 1001;

export interface StationGrid {
  /** station positions [m], ascending */
  x: Float64Array;
  /** each station's cell [m] */
  cellL: Float64Array;
  cellR: Float64Array;
  /** cell widths [m] */
  cellW: Float64Array;
  /** element lengths, station s to s + 1 [m] (one fewer than the stations) */
  elemL: Float64Array;
  /** an even grid: every spacing is `dx` */
  uniform: boolean;
  /** the spacing off the strip - everywhere, on an even grid [m] */
  dx: number;
  /** the spacing on the strip [m] */
  dxStrip: number;
  /** stations whose cells tile the strip, or 0 on an even grid */
  onStrip: number;
}

/** the station count of an even grid, from the `stations` input: odd, at least MIN_STATIONS */
export function evenCount(stations: number): number {
  return Math.max(MIN_STATIONS, Math.round(stations) | 1);
}

/** the strip's station count, from the `stripStations` input: 0 (an even grid), or odd in [3, MAX_STRIP_STATIONS] */
export function stripCount(stripStations: number): number {
  const n = Math.round(stripStations);
  return n > 0 ? Math.min(MAX_STRIP_STATIONS, Math.max(3, n | 1)) : 0;
}

/**
 * The grid over [−half, half] for a strip `width` wide on the centre line.
 * An even grid of `evenCount(stations)` stations, or with `stripStations` the
 * strip refined: its N cells, then from w/2 + ds/2 (the midpoint to the last
 * strip station is the strip edge) out to `half` at about the even spacing. A
 * strip reaching past `half - ds/2` ends the grid at that first station.
 */
export function stationGrid(half: number, stations: number, width: number, stripStations: number): StationGrid {
  const nEven = evenCount(stations);
  const dx = (2 * half) / (nEven - 1);
  const N = stripCount(stripStations);
  if (N === 0) {
    const x = new Float64Array(nEven), cellL = new Float64Array(nEven), cellR = new Float64Array(nEven);
    for (let s = 0; s < nEven; s++) {
      x[s] = -half + s * dx;
      cellL[s] = x[s] - dx / 2;
      cellR[s] = x[s] + dx / 2;
    }
    return {
      x, cellL, cellR, cellW: new Float64Array(nEven).fill(dx), elemL: new Float64Array(nEven - 1).fill(dx),
      uniform: true, dx, dxStrip: dx, onStrip: 0,
    };
  }
  const w2 = width / 2, ds = width / N, hs = (N - 1) / 2;
  // the right half from the centre out: the strip's stations, then the rest
  const r: number[] = [0];
  for (let j = 1; j <= hs; j++) r.push(j * ds);
  const first = w2 + ds / 2;
  const span = half - first;
  const gaps = span > 0 ? Math.round(span / dx) : 0;
  r.push(first);
  for (let k = 1; k < gaps; k++) r.push(first + (k * span) / gaps);
  if (gaps >= 1) r.push(half);
  const nR = r.length - 1;
  const cL = new Float64Array(nR + 1), cR = new Float64Array(nR + 1);
  for (let i = 0; i <= nR; i++) cR[i] = i < nR ? 0.5 * (r[i] + r[i + 1]) : r[i] + 0.5 * (r[i] - r[i - 1]);
  for (let i = 1; i <= nR; i++) cL[i] = cR[i - 1];
  cL[0] = -cR[0];
  // the strip edge, exactly: the midpoint of w/2 − ds/2 and w/2 + ds/2 can miss it by a rounding step
  cR[hs] = w2;
  cL[hs + 1] = w2;
  const ns = 2 * nR + 1, c = nR;
  const x = new Float64Array(ns), cellL = new Float64Array(ns), cellR = new Float64Array(ns), cellW = new Float64Array(ns);
  for (let i = 0; i <= nR; i++) {
    x[c + i] = r[i]; x[c - i] = -r[i];
    cellL[c + i] = cL[i]; cellR[c + i] = cR[i];
    cellL[c - i] = -cR[i]; cellR[c - i] = -cL[i];
  }
  for (let s = 0; s < ns; s++) cellW[s] = cellR[s] - cellL[s];
  const elemL = new Float64Array(ns - 1);
  for (let s = 0; s < ns - 1; s++) elemL[s] = x[s + 1] - x[s];
  return { x, cellL, cellR, cellW, elemL, uniform: false, dx: gaps >= 1 ? span / gaps : ds, dxStrip: ds, onStrip: N };
}

/** the station nearest to v; a tie goes to the one farther from the centre, so mirrored positions get mirrored stations */
export function nearestStation(x: ArrayLike<number>, v: number): number {
  const n = x.length;
  if (!(v > x[0])) return 0;
  if (!(v < x[n - 1])) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= v) lo = mid; else hi = mid;
  }
  const dl = v - x[lo], dh = x[hi] - v;
  if (dl !== dh) return dl < dh ? lo : hi;
  return Math.abs(x[lo]) > Math.abs(x[hi]) ? lo : hi;
}

/** the last station at or before v (0 before the grid) */
export function stationBelow(x: ArrayLike<number>, v: number): number {
  let lo = 0, hi = x.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= v) lo = mid; else hi = mid;
  }
  return lo;
}

/** the first station at or after v (the last one past the grid) */
export function stationAbove(x: ArrayLike<number>, v: number): number {
  let lo = -1, hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] >= v) hi = mid; else lo = mid;
  }
  return hi;
}
