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
