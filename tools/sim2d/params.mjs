// The app's default RollingParams, as a stand in the app actually receives them.
//
// They live as an object literal in main.ts, which imports the DOM and cannot be
// loaded in node. Rather than keep a second copy that drifts, the literal is sliced
// out of the source and evaluated: it only references TONF and MN_PER_MM.
//
// The literal is not quite what the app runs, though. A few dials are held in `view`
// in the units an operator types (MN/mm, m/min, a strip width), and at boot they are
// converted into `params` (syncMillModulus, syncRollSpeed, syncAgcTarget in main.ts).
// The conversions that reach a stand are redone here from the same `view` numbers:
//
//   millModulus = millModulusMNmm * MN_PER_MM / stripWidth     (per unit width)
//   omega       = rollSpeedMpm / 60 / R
//   lineSpeed   = rollSpeedMpm / 60
//
// agcTargetForce stays the literal: syncAgcTarget converts the shared value, but the
// per-stand setups the mill is built from are seeded from the literal before that runs,
// so the literal is what a stand solves with. If that seeding changes, change it here.
//
// The patch is applied after the conversions, as a dial changed by hand would be.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const TONF = 9.80665e3;
const MN_PER_MM = 1e9;
const MPM = 60;

function literal(src, head) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`src/main.ts: \`${head}\` not found`);
  const end = src.indexOf('\n};', start);
  return src.slice(src.indexOf('{', start), end + 2);
}

/** A numeric field of main.ts's `view` literal (it holds TS casts, so it is not evaluated whole). */
function viewNumber(view, key) {
  const m = view.match(new RegExp(`^\\s*${key}:\\s*([0-9.eE+-]+)\\s*,`, 'm'));
  if (!m) throw new Error(`src/main.ts: view.${key} not found`);
  return Number(m[1]);
}

export function defaultParams(patch = {}) {
  const src = readFileSync(MAIN, 'utf8');
  const params = new Function('TONF', 'MN_PER_MM', `return (${literal(src, 'const params: RollingParams = {')});`)(TONF, MN_PER_MM);
  const view = literal(src, 'const view = {');
  const stripWidth = viewNumber(view, 'stripWidth');
  const rollSpeedMpm = viewNumber(view, 'rollSpeedMpm');
  params.millModulus = (viewNumber(view, 'millModulusMNmm') * MN_PER_MM) / Math.max(stripWidth, 1e-6);
  params.omega = rollSpeedMpm / MPM / Math.max(params.R, 1e-6);
  params.lineSpeed = rollSpeedMpm / MPM;
  return { ...params, ...patch };
}
