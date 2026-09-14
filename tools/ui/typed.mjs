// A typed readout comes back as the value it names, on every dial the panels
// have.
//
//   node tools/build-esm.mjs --out tools/ui/build src/ui/typed.ts && node tools/ui/typed.mjs   (exit 1 on FAIL)
//
// The dials are read out of the sources rather than listed here, so a dial
// added later is checked without anyone remembering to: every `slider({...})`
// in src/main.ts and src/ui3d/view3d.ts, and every `num(...)` dial of the 3D
// tab. For each, values across its range are printed, the text is taken back
// through `typedValue`, and it has to print the same text again, landing
// within half a rounding step of the number typed.
//
// @check
// @check-build --out tools/ui/build src/ui/typed.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseTyped, snapToStep, typedValue } from './build/ui/typed.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLES = 400;

let failed = 0;
function report(ok, name, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ── the dials, from the sources ─────────────────────────────────────────────
const evalExpr = (text) => {
  const js = ts.transpileModule(`export default (${text});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace('export default', 'return');
  return new Function(js)();
};
const defaultFormat = (step) => (v) => v.toFixed(step && step >= 1 ? 0 : 3);
/**
 * The same formatter with nine more digits, to see where a value sits inside
 * the rounding step its readout names. Only the digit counts change.
 */
const fineSource = (text) => {
  let out = '';
  let i = 0;
  const re = /\.(toFixed|toExponential|toPrecision)\(/g;
  for (let m; (m = re.exec(text));) {
    // the whole argument, parenthesised: `toFixed(v < 0.001 ? 3 : 2)` has to
    // become `toFixed(9 + (v < 0.001 ? 3 : 2))`, not `9 + v < 0.001 ? ...`
    let depth = 1, j = re.lastIndex;
    for (; j < text.length && depth > 0; j++) depth += text[j] === '(' ? 1 : text[j] === ')' ? -1 : 0;
    out += text.slice(i, m.index) + `.${m[1]}(9 + (${text.slice(re.lastIndex, j - 1)}))`;
    i = re.lastIndex = j;
  }
  return out + text.slice(i);
};

const dials = [];
const unreadable = [];
for (const file of ['src/main.ts', 'src/ui3d/view3d.ts']) {
  const src = ts.createSourceFile(file, readFileSync(ROOT + file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const where = (n) => `${file}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const arg = n.arguments[0];
      if (name === 'slider' && arg && ts.isObjectLiteralExpression(arg)) {
        const props = new Map();
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p)) props.set(p.name.getText(), p.initializer.getText());
          else if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.getText(), null);
        }
        // `num` below builds its slider from shorthand properties; it is checked through its callers.
        if (props.get('min') === null) { ts.forEachChild(n, visit); return; }
        try {
          const step = props.has('step') ? evalExpr(props.get('step')) : undefined;
          const fText = props.get('format') ?? `(v) => v.toFixed(${step && step >= 1 ? 0 : 3})`;
          dials.push({
            where: where(n), label: evalExpr(props.get('label')),
            min: evalExpr(props.get('min')), max: evalExpr(props.get('max')), step,
            log: props.has('log') ? evalExpr(props.get('log')) : false,
            format: props.has('format') ? evalExpr(fText) : defaultFormat(step),
            fine: evalExpr(fineSource(fText)),
          });
        } catch (e) { unreadable.push(`${where(n)} ${e.message}`); }
      } else if (name === 'num' && file.endsWith('view3d.ts') && n.arguments.length >= 7) {
        // num(key, label, unit, min, max, step, scale, hint?, log?) - slider value in display units
        try {
          const a = n.arguments.map((x) => x.getText());
          const step = evalExpr(a[5]);
          dials.push({
            where: where(n), label: a[1],
            min: evalExpr(a[3]), max: evalExpr(a[4]), step,
            log: a[8] !== undefined ? evalExpr(a[8]) : false,
            format: defaultFormat(step), fine: evalExpr(fineSource(`(v) => v.toFixed(${step >= 1 ? 0 : 3})`)),
          });
        } catch (e) { unreadable.push(`${where(n)} ${e.message}`); }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
const perFile = (f) => dials.filter((d) => d.where.startsWith(f)).length;
report(unreadable.length === 0 && perFile('src/main.ts') > 0 && perFile('src/ui3d/view3d.ts') > 0,
  '(harness) every dial definition read', `main.ts ${perFile('src/main.ts')}, view3d.ts ${perFile('src/ui3d/view3d.ts')}`
  + (unreadable.length ? `; unreadable: ${unreadable.join(' | ')}` : ''));

// ── half the rounding step a readout's text names ───────────────────────────
const halfStep = (text) => {
  const m = text.match(/^-?\d+(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!m) return NaN;
  const dec = m[1]?.length ?? 0;
  return 0.5 * 10 ** ((m[2] ? Number(m[2]) : 0) - dec);
};

/**
 * Values across a dial's range the way the slider itself produces them. Its
 * step grid starts at zero, not at the rail, so a rail off that grid is not a
 * value the dial can hold (the 3D tab's 21..241 station count, step 2, cannot
 * be 21) and is sampled at the grid point next to it instead.
 */
function samples(d) {
  const out = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    let v = d.log ? d.min * (d.max / d.min) ** t : d.min + (d.max - d.min) * t;
    if (i === 0) v = d.min;
    if (i === SAMPLES) v = d.max;
    if (d.step) v = Math.round(v / d.step) * d.step;
    if (v >= d.min && v <= d.max) out.push(v);
  }
  return out;
}
const offGrid = dials.filter((d) => d.step && (snapToStep(d.min, d.step) !== d.min || snapToStep(d.max, d.step) !== d.max));
console.log(`note  dials with a rail off their step grid (sampled on the grid): ${offGrid.map((d) => `${d.where} ${d.label} [${d.min}, ${d.max}] step ${d.step}`).join('; ') || 'none'}`);

/** Print → type back → print, for one inverse. Returns the failures. */
function roundTrip(d, inverse) {
  const bad = [];
  for (const v of samples(d)) {
    const text = d.format(v);
    const shown = Number(text);
    const got = inverse(d, shown);
    const again = got === null ? 'null' : d.format(got);
    const off = got === null ? Infinity : Math.abs(Number(d.fine(got)) - shown);
    const half = halfStep(text);
    if (again !== text || !(off <= half * (1 + 1e-9))) bad.push({ v, text, got, again, off, half });
  }
  return bad;
}

// ── the check itself ────────────────────────────────────────────────────────
let worst = { rel: 0 }, trips = 0;
const failing = [];
for (const d of dials) {
  const bad = roundTrip(d, typedValue);
  trips += samples(d).length;
  if (bad.length) failing.push(`${d.where} ${d.label}: ${bad.length} (first ${JSON.stringify(bad[0])})`);
  for (const v of samples(d)) {
    const text = d.format(v), got = typedValue(d, Number(text));
    if (got === null) continue;
    const rel = Math.abs(Number(d.fine(got)) - Number(text)) / halfStep(text);
    if (rel > worst.rel) worst = { rel, where: d.where, text };
  }
}
report(failing.length === 0, 'print -> type -> print is the same text, within half a step, on every dial',
  `${dials.length} dials, ${trips} values; worst |typed - value| ${worst.rel.toExponential(1)} of half a step`
  + (failing.length ? `\n      ${failing.slice(0, 5).join('\n      ')}` : ''));

// More digits than the readout has: the nearest printable number, still within half a step.
{
  let n = 0;
  const bad = [];
  for (const d of dials.filter((x) => !x.step)) {
    for (const v of samples(d)) {
      const text = d.format(v);
      const half = halfStep(text);
      for (const frac of [-0.3, 0.3]) {
        const typed = Number(text) + frac * 2 * half;
        const got = typedValue(d, typed);
        if (got === null || got === d.min || got === d.max) continue;
        n++;
        const off = Math.abs(Number(d.fine(got)) - typed);
        if (!(off <= half * (1 + 1e-9))) bad.push({ where: d.where, text, typed, got, off, half });
      }
    }
  }
  report(bad.length === 0, 'a number with more digits than the readout lands within half a step of it',
    `${n} typed values on the dials without a step` + (bad.length ? `; ${bad.length} off, first ${JSON.stringify(bad[0])}` : ''));
}

// The numbers the fault was reported with, taken as typed.
{
  const h0 = dials.find((d) => d.where.startsWith('src/main.ts') && d.label.startsWith('ライン入側板厚'));
  const L = dials.find((d) => d.where.startsWith('src/main.ts') && d.label === '係数 L');
  const cases = [
    [h0, '1.5', 0.0015], [h0, '2', 0.002], [h0, '1.50 mm', 0.0015], [L, '1200', 1200e6],
  ];
  const got = cases.map(([d, text, want]) => ({ text, want, got: d ? typedValue(d, parseTyped(text)) : undefined }));
  report(got.every((c) => c.got === c.want), 'h0 "1.5" is 0.0015 m, "2" is 0.002 m, L "1200" is 1200 MPa - exactly',
    got.map((c) => `"${c.text}" -> ${c.got}`).join(', '));
}

report(parseTyped('') === null && parseTyped('   ') === null && parseTyped('mm') === null
  && parseTyped('1.50 mm') === 1.5 && parseTyped('-0.5') === -0.5 && parseTyped('2.5e-4') === 2.5e-4,
  'an empty box is no number, a unit is stripped', `'' ${parseTyped('')}, 'mm' ${parseTyped('mm')}, '1.50 mm' ${parseTyped('1.50 mm')}`);

report(snapToStep(0.0045, 0.0005) === 0.0045 && snapToStep(0.00451, 0.0005) === 0.0045 && snapToStep(7, undefined) === 7,
  'a value already on the step grid keeps its exact digits',
  `0.0045 -> ${snapToStep(0.0045, 0.0005)} (9 × 0.0005 = ${9 * 0.0005})`);

// The harness has to be able to fail: the inverse this replaced settles on the
// lower edge of the rounding step, and the round trip must catch it.
{
  const lowerEdge = (d, shown) => {
    const read = (v) => Number(d.format(v));
    const fLo = read(d.min), fHi = read(d.max);
    const up = fHi > fLo;
    if (up ? shown <= fLo : shown >= fLo) return d.min;
    if (up ? shown >= fHi : shown <= fHi) return d.max;
    let lo = d.min, hi = d.max;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if ((read(mid) < shown) === up) lo = mid; else hi = mid;
    }
    const v = (lo + hi) / 2;
    return Math.max(d.min, Math.min(d.max, d.step ? Math.round(v / d.step) * d.step : v));
  };
  const caught = dials.filter((d) => roundTrip(d, lowerEdge).length > 0);
  report(caught.length > 0, '(harness) the old lower-edge bisection fails the round trip',
    `on ${caught.length} of ${dials.length} dials, e.g. ${caught[0]?.where} ${caught[0]?.label}`);
}

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nall PASS');
