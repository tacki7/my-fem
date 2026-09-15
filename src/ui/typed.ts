/**
 * Turning a number someone typed into a dial's readout back into the value
 * behind it.
 *
 * No DOM in here, so the node check in tools/ui can run it against every
 * formatter the panels use.
 */

export type Formatter = (v: number) => string;

/** How many decades apart a readout and its value may be (mm on a range in m is three). */
const MAX_DECADES = 15;

/**
 * The number in a readout's text, with the unit and anything else that is not
 * part of a number stripped - so the text the box itself printed is valid
 * input. Null when there is no number at all: an emptied box is not a zero.
 */
export function parseTyped(text: string): number | null {
  const s = text.replace(/[^0-9eE+\-.]/g, '');
  if (!/[0-9]/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * The value in [min, max] whose readout is `shown`, or null when the formatter
 * does not print a number.
 *
 * The readout and the value are not the same number - a range in metres
 * printed in millimetres - and rather than have every dial carry an inverse
 * to keep in step with its formatter, the inverse is found on the formatter
 * itself. In order:
 *
 * 1. Past either rail, the rail.
 * 2. The typed number itself, scaled by a power of ten, if the formatter
 *    prints it back as typed. That is every formatter in the app - each is a
 *    decimal scale and a rounding - and it gives 1.5 mm as exactly 0.0015 m.
 *    This used to be a bisection alone, which settles on the lower edge of the
 *    rounding step that prints the number: 1.5 became 1.49499 mm and showed
 *    as 1.49, 1200 MPa became 1199.5.
 * 3. Otherwise - more digits than the readout has, or a formatter that is
 *    not a decimal scale - the printable number nearest to what was typed,
 *    by 2 if it can, else the middle of the rounding step that prints it.
 *
 * Only monotonicity is assumed, which holds for a unit scale, a log axis and
 * any rounding a formatter applies.
 */
export function valueFromShown(fmt: Formatter, min: number, max: number, shown: number): number | null {
  const read = (v: number) => Number(fmt(v));
  const fLo = read(min), fHi = read(max);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo === fHi || !Number.isFinite(shown)) return null;
  const up = fHi > fLo;
  if (up ? shown <= fLo : shown >= fLo) return min;
  if (up ? shown >= fHi : shown <= fHi) return max;

  const exact = printedAs(read, min, max, shown);
  if (exact !== null) return exact;

  // The step boundary the typed number falls on, and the readouts either side.
  const before = (target: number, strict: boolean) => (f: number) =>
    up ? (strict ? f < target : f <= target) : (strict ? f > target : f >= target);
  const cross = boundary(read, before(shown, true), min, max);
  if (cross === null) return null;
  const below = read(cross.lo), above = read(cross.hi);
  const near = Math.abs(shown - below) <= Math.abs(above - shown) ? below : above;

  const again = printedAs(read, min, max, near);
  if (again !== null) return again;
  const from = boundary(read, before(near, true), min, max);
  const to = boundary(read, before(near, false), min, max);
  if (from === null || to === null) return null;
  return (from.mid + to.mid) / 2;
}

/**
 * Snap a value to a dial's step grid, keeping a value already on it exactly
 * as it is. `round(v / step) * step` alone changes the last bit of numbers
 * that were on the grid to begin with - 9 × 0.0005 is 0.0045000000000000005 -
 * so a typed value would not come back as typed.
 */
export function snapToStep(v: number, step?: number): number {
  if (!(step !== undefined && step > 0)) return v;
  const on = Math.round(v / step) * step;
  if (Math.abs(v - on) <= Math.abs(on) * 1e-12) return v;
  return Number(on.toPrecision(12));
}

export interface TypedDial {
  min: number;
  max: number;
  step?: number;
  format: Formatter;
}

/** What a dial takes for a typed readout: inverted, snapped to its step, held on its rails. */
export function typedValue(d: TypedDial, shown: number): number | null {
  const v = valueFromShown(d.format, d.min, d.max, shown);
  if (v === null) return null;
  return Math.max(d.min, Math.min(d.max, snapToStep(v, d.step)));
}

/** A power-of-ten scaling of `shown` inside the range that the readout prints as `shown`. */
function printedAs(read: (v: number) => number, min: number, max: number, shown: number): number | null {
  for (let k = 0; k <= MAX_DECADES; k++) {
    for (const s of k === 0 ? [0] : [k, -k]) {
      // Scaling by a power of ten leaves last-bit noise either way round
      // (0.03 / 1000 is 2.9999999999999997e-5), so the result is taken to 15
      // significant digits: the double nearest the decimal that was typed.
      const raw = s >= 0 ? shown / 10 ** s : shown * 10 ** -s;
      for (const v of [Number(raw.toPrecision(15)), raw]) {
        if (v >= min && v <= max && read(v) === shown) return v;
      }
    }
  }
  return null;
}

/**
 * Where a monotone test on the readout turns from true to false over
 * [min, max]. Null if the formatter prints something that is not a number on
 * the way.
 */
function boundary(
  read: (v: number) => number, test: (f: number) => boolean, min: number, max: number,
): { lo: number; hi: number; mid: number } | null {
  if (!test(read(min))) return { lo: min, hi: min, mid: min };
  if (test(read(max))) return { lo: max, hi: max, mid: max };
  let lo = min, hi = max;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const f = read(mid);
    if (!Number.isFinite(f)) return null;
    if (test(f)) lo = mid; else hi = mid;
  }
  return { lo, hi, mid: (lo + hi) / 2 };
}

/**
 * The rounding step a readout's text names: its last printed digit, with the exponent
 * of an exponential form taken in ("4.50e-3" is printed to 1e-5, not to 0.01). NaN
 * when the text is not a number.
 */
export function printedStep(text: string): number {
  const m = text.trim().match(/^-?\d+(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!m) return NaN;
  const dec = m[1]?.length ?? 0;
  return 10 ** ((m[2] ? Number(m[2]) : 0) - dec);
}

/**
 * How much one press of an arrow should move a readout, in the readout's own units.
 *
 * Two rules, and the larger wins. A 1-2-5 step near a percent of the number keeps a
 * logarithmic dial usable across its decades: 1200 MPa steps by 10, 2.00 mm by 0.02. The
 * readout's last printed digit is the floor, so a press changes what is printed.
 */
export function nudgeStep(text: string): number {
  const shown = Number(text);
  const floor = printedStep(text);
  const mag = Math.abs(shown);
  if (!(mag > 0)) return floor;
  const raw = mag * 0.01;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  const nice = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
  return Math.max(nice, floor);
}

/**
 * The value a dial takes when its arrow is pressed: the readout stepped by `nudgeStep`,
 * snapped to that step's grid so repeated presses land on round numbers, and taken back
 * through `typedValue` - which holds it to the dial's own step grid and its rails.
 *
 * When the readout's step is finer than the dial's grid the snap can land the press back
 * on the value it left (a μ of 0.060 stepped by 0.001 rounds back to the 0.005 grid), so
 * the press is repeated, twice as far each time, until the value moves - to the next grid
 * point, never past it; an arrow that looks dead is worse than one that steps coarsely. Null only when the dial cannot move
 * that way at all (at a rail).
 */
export function nudged(d: TypedDial, value: number, dir: 1 | -1): number | null {
  const text = d.format(value);
  const shown = Number(text);
  if (!Number.isFinite(shown)) return null;
  const st = nudgeStep(text);
  if (!(st > 0)) return null;
  const base = Math.round(shown / st) * st;
  // the value it left, to a float's noise: a sample on the step grid and the same point snapped
  // to it can differ in the last bit
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  // the multiple doubles: from under half a grid step it reaches the next grid point without
  // skipping one, and a readout of 0.000 on a 0.5 grid gets there in nine tries, not 250
  for (let k = 1; k <= 2 ** 40; k *= 2) {
    const v = typedValue(d, Number((base + dir * k * st).toPrecision(12)));
    if (v === null) return null;
    if (!same(v, value) && Math.sign(v - value) === dir) return v;
    if (dir > 0 ? v >= d.max : v <= d.min) return null;
  }
  return null;
}
