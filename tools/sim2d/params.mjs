// The app's default RollingParams, as a stand in the app actually receives them.
//
// The defaults live in src/app/defaults.ts (no DOM, built with the sim2d preset), so they
// are imported rather than sliced out of main.ts's source.
//
// They are not quite what the app runs, though. A few dials are held in `view` in the
// units an operator types (MN/mm, m/min, a strip width), and at boot they are converted
// into `params` (syncMillModulus, syncRollSpeed, syncAgcTarget in main.ts). The conversions
// that reach a stand are redone here with the same functions:
//
//   millModulus    = millModulusMNmm * MN_PER_MM / stripWidth     (per unit width)
//   agcTargetForce = agcTargetTonf * TONF / stripWidth            (per unit width; the
//                    per-stand setups are seeded from the same conversion)
//   omega          = rollSpeedMpm / 60 / R
//   lineSpeed      = rollSpeedMpm / 60
//
// The patch is applied after the conversions, as a dial changed by hand would be.
import {
  defaultParams as appParams, defaultView,
  millModulusPerWidth, agcTargetPerWidth, omegaFromMpm, lineSpeedFromMpm,
} from './build/app/defaults.js';

export function defaultParams(patch = {}) {
  const params = appParams();
  const view = defaultView();
  params.millModulus = millModulusPerWidth(view);
  params.agcTargetForce = agcTargetPerWidth(view);
  params.omega = omegaFromMpm(view, params.R);
  params.lineSpeed = lineSpeedFromMpm(view);
  return { ...params, ...patch };
}
